import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import type {
  TenantContext,
  ValidCompetencyRow,
  ValidProfileRow,
  RejectedRow,
} from '@formai/shared';
import { landImportRow, resolveRows, type ResolvedRow } from './member-create.js';
import { grantCompetency } from './competency-grant.js';
import { assignForMembership } from './assignment.js';
import { recordAudit } from '../audit/record.js';

/**
 * The workforce import RUN (U24, R142–R172).
 *
 * ONE TRANSACTION PER ROW, per KTD13, and `landImportRow` owns it. A rejected
 * row leaves nothing half-made and a good row lands whatever its neighbours do —
 * which is what lets a three-hundred-row file report 293 landed and 7 rejected
 * rather than failing whole.
 *
 * ORDERING WITHIN A ROW IS FIXED (R163): the person, then their competencies,
 * then assignment. Seeding the competencies first is the entire point — it is
 * what makes assignment skip what the person already holds, so a migrated
 * workforce is not handed three hundred assessments for tickets they have had
 * for years.
 *
 * NOTHING HERE VALIDATES. Every row it is given has already passed
 * `validateWorkforceImport`, and the two run-time refusals it can still hit — a
 * full seat pool, a placement the taxonomy retired between the preview and the
 * run — come back from the lander as outcomes rather than exceptions.
 *
 * NO ASSESSMENT CASE IS CREATED FOR A MIGRATED COMPETENCY (R160). A spreadsheet
 * cannot produce an assessor's signature, which is the same reason U15's
 * automatic mark names nobody.
 */

export interface RunInput {
  validProfiles: readonly ValidProfileRow[];
  validCompetencies: readonly ValidCompetencyRow[];
  /** Rejections the validator already found — recorded so one report holds every row. */
  rejected: readonly RejectedRow[];
}

/** What the run wrote for one row, before it is persisted. */
interface RowResult {
  rowNumber: number;
  subject: string;
  outcome: 'created' | 'added_membership' | 'reactivated' | 'merged' | 'duplicate' | 'rejected';
  reason?: string;
  detail?: string;
  userId?: string;
  membershipId?: string;
  flagged: string[];
  differences: Array<{ field: string; existing: string; fromFile: string }>;
  competenciesRecorded: number;
  /** Of those recorded, how many carry no grant date (R153, reversed). */
  competenciesUndated: number;
  assessmentsAssigned: number;
  seatPool?: 'staff' | 'candidate';
}

/** Maps the lander's own vocabulary onto the row outcome the report stores. */
const OUTCOME_FOR: Record<string, RowResult['outcome']> = {
  created: 'created',
  added: 'added_membership',
  reactivated: 'reactivated',
  merged: 'merged',
  duplicate: 'duplicate',
};

/**
 * Split the competency lines by the address they name, so each row's are landed
 * inside that row's own step (R163) rather than in a second pass afterwards.
 *
 * Keyed lowercased because the file's casing is whatever somebody typed, and the
 * profile row it must join to was matched the same way.
 */
function competenciesByEmail(
  lines: readonly ValidCompetencyRow[],
): Map<string, ValidCompetencyRow[]> {
  const byEmail = new Map<string, ValidCompetencyRow[]>();
  for (const line of lines) {
    const key = line.email.toLowerCase();
    const list = byEmail.get(key) ?? [];
    list.push(line);
    byEmail.set(key, list);
  }
  return byEmail;
}

/**
 * Record one person's migrated competencies (R156–R162).
 *
 * Each keeps the grant date the FILE supplies rather than the date of the run —
 * a four-year-old ticket whose expiry derived from today would read as current
 * when it is not, which is the failure this whole path exists to avoid. Expiry
 * derives from that real date and the competency's own validity exactly as an
 * earned one does, and a recorded expiry overrides it.
 *
 * A LINE WITH NO GRANT DATE IS STILL RECORDED (R153, reversed). The person
 * genuinely holds it; the source system just never dated it, or the record is
 * one — like a driver's licence — that a formula could never derive an expiry
 * for anyway. `grantedAt` is written NULL explicitly rather than left to the
 * column default, because defaulting it would manufacture a "granted today"
 * currency the person does not have, which is the one outcome worse than
 * recording no date. `competencyStatus` treats that null as its own `undated`
 * state, so it stays visibly flagged rather than reading as an ordinary grant.
 *
 * `importedAt` is what marks these as migrated, which is what waives the
 * certificate they have no scan of (R162) — and it reaches only the records this
 * run created, so a competency recorded on the same person afterwards owes its
 * own document like any other.
 */
async function recordCompetencies(
  db: Db,
  tenant: TenantContext,
  userId: string,
  lines: readonly ValidCompetencyRow[],
  now: Date,
): Promise<{ recorded: number; undated: number }> {
  let recorded = 0;
  let undated = 0;
  for (const line of lines) {
    const result = await grantCompetency(db, tenant, {
      competencyId: line.competencyId,
      userId,
      evidenceRef: line.evidence || null,
      // R160: no case. A spreadsheet cannot produce an assessor's signature.
      sourceCaseId: null,
      // The explicit override, where the file supplied one (a driver's
      // licence's own recorded expiry, not a derived one).
      expiresAt: line.expiresAt,
    });
    /*
      Cannot happen post-validation — the competency was resolved against THIS
      org's awarded set and the person just landed as a real membership in the
      same row — but `grantCompetency` stays the authority on both, so a
      refusal is honoured rather than assumed away.
    */
    if (!result.ok) continue;
    /*
      The real grant date (or its deliberate absence) and the migration
      provenance, written after the grant because `grantCompetency` is the
      product's own upsert and stamps today. R157 wants who authorised the
      migration and when; R158 wants the date the ticket was actually earned —
      or the explicit acknowledgement that nobody supplied one.
    */
    await db
      .update(schema.competencyHolders)
      .set({ grantedAt: line.grantedAt, importedAt: now })
      // Targeted on (competency, holder), which is the pair `grantCompetency`
      // upserts against — the grant carries no id back, and the natural key is
      // what makes this reach exactly the row it just wrote.
      .where(
        and(
          eq(schema.competencyHolders.competencyId, line.competencyId),
          eq(schema.competencyHolders.userId, userId),
          eq(schema.competencyHolders.orgId, tenant.orgId),
        ),
      );
    recorded++;
    if (!line.grantedAt) undated++;
  }
  return { recorded, undated };
}

/**
 * Land one validated row: the person, their competencies, then assignment.
 *
 * Returns what to record, never throws for a refusal — a full pool or a
 * newly-retired placement is an outcome the report carries beside the
 * validator's own rejections, not a failure of the run (R170).
 */
async function runOneRow(
  db: Db,
  tenant: TenantContext,
  resolved: ResolvedRow,
  lines: readonly ValidCompetencyRow[],
  now: Date,
): Promise<RowResult> {
  const { row } = resolved;
  const base: RowResult = {
    rowNumber: row.rowNumber,
    subject: row.name || row.email,
    outcome: 'rejected',
    flagged: [],
    differences: [],
    competenciesRecorded: 0,
    competenciesUndated: 0,
    assessmentsAssigned: 0,
  };

  /*
    The file carries ONE name column, so the split is first word / everything
    else — a middle name lands in the surname rather than being invented into a
    column the file never had. Only these two are seeded: the lander writes the
    two workforce numbers from the ROW itself, and passing them here as well
    would be a second source for one value.
  */
  const [firstName = '', ...rest] = row.name.trim().split(/\s+/);
  const landed = await landImportRow(db, tenant, resolved, {
    firstName,
    lastName: rest.join(' '),
  });

  if (landed.kind === 'refused') {
    return {
      ...base,
      reason: landed.reason,
      detail: landed.reason === 'seat_limit_reached' ? landed.pool : landed.code,
    };
  }
  if (landed.kind === 'duplicate') return { ...base, outcome: 'duplicate' };

  const result: RowResult = {
    ...base,
    outcome: OUTCOME_FOR[landed.kind] ?? 'created',
    userId: landed.userId,
    membershipId: landed.membershipId,
    // A merge costs no seat (R143); everything else draws on the pool its
    // access level names.
    seatPool: landed.kind === 'merged' ? undefined : (resolved.pool ?? undefined),
  };
  if (landed.kind === 'merged') result.differences = landed.differences;
  else result.flagged = landed.incomplete;

  // R163: competencies BEFORE assignment, so assignment skips what they hold.
  const counts = await recordCompetencies(db, tenant, landed.userId, lines, now);
  result.competenciesRecorded = counts.recorded;
  result.competenciesUndated = counts.undated;

  /*
    Then only what those competencies leave unmet (R163, R47). Fail-soft: an
    assignment that could not be computed must not undo a person who has already
    landed — the row is real, and the sweep will assign them on its next pass.
  */
  try {
    const assigned = await assignForMembership(db, tenant.orgId, landed.membershipId, now);
    result.assessmentsAssigned = assigned.createdCaseIds.length;
  } catch {
    result.assessmentsAssigned = 0;
  }
  return result;
}

/**
 * Execute a validated import.
 *
 * Creates the run, walks the rows, and completes it. The rows the VALIDATOR
 * rejected are recorded first so one report holds every line of the file — an
 * Admin correcting the source needs both kinds in one place, and a report that
 * showed only run-time refusals would send them looking for the rest.
 */
export async function executeImportRun(
  db: Db,
  tenant: TenantContext,
  input: RunInput,
  now: Date = new Date(),
): Promise<{ runId: string }> {
  const [run] = await db
    .insert(schema.importRuns)
    .values({
      orgId: tenant.orgId,
      startedByUserId: tenant.userId,
      rowsTotal: input.validProfiles.length + input.rejected.length,
    })
    .returning();
  const runId = run!.id;

  const write = (result: RowResult) =>
    db.insert(schema.importRunRows).values({
      runId,
      orgId: tenant.orgId,
      rowNumber: result.rowNumber,
      subject: result.subject,
      outcome: result.outcome,
      reason: result.reason ?? null,
      detail: result.detail ?? null,
      userId: result.userId ?? null,
      membershipId: result.membershipId ?? null,
      flagged: result.flagged,
      differences: result.differences,
      competenciesRecorded: result.competenciesRecorded,
      competenciesUndated: result.competenciesUndated,
      assessmentsAssigned: result.assessmentsAssigned,
      seatPool: result.seatPool ?? null,
    });

  for (const rejection of input.rejected) {
    await write({
      rowNumber: rejection.rowNumber,
      subject: rejection.subject,
      outcome: 'rejected',
      reason: rejection.reason,
      detail: rejection.detail,
      flagged: [],
      differences: [],
      competenciesRecorded: 0,
      competenciesUndated: 0,
      assessmentsAssigned: 0,
    });
  }

  const resolved = await resolveRows(db, tenant.orgId, input.validProfiles);
  const byEmail = competenciesByEmail(input.validCompetencies);
  for (const row of resolved) {
    const lines = byEmail.get(row.row.email.toLowerCase()) ?? [];
    await write(await runOneRow(db, tenant, row, lines, now));
  }

  await db
    .update(schema.importRuns)
    .set({ completedAt: new Date() })
    .where(eq(schema.importRuns.id, runId));

  await recordAudit(db, tenant, {
    action: 'Ran workforce import',
    target: `${input.validProfiles.length} row${input.validProfiles.length === 1 ? '' : 's'} attempted`,
    category: 'team',
    icon: 'upload',
  });

  return { runId };
}

/** Every figure R171 names, DERIVED from the rows rather than counted alongside them. */
export interface RunReport {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  rowsTotal: number;
  rowsProcessed: number;
  profilesCreated: number;
  membershipsAdded: number;
  membershipsReactivated: number;
  peopleMerged: number;
  duplicateRows: number;
  candidateSeats: number;
  staffSeats: number;
  competenciesRecorded: number;
  linesFlaggedNoDate: number;
  assessmentsAssigned: number;
  profilesFlaggedIncomplete: number;
  differencesReported: number;
  rejected: Array<{ rowNumber: number; subject: string; reason: string; detail: string | null }>;
  flagged: Array<{ rowNumber: number; subject: string; missing: string[] }>;
  differences: Array<{
    rowNumber: number;
    subject: string;
    membershipId: string | null;
    items: Array<{ field: string; existing: string; fromFile: string }>;
  }>;
}

export async function readRunReport(db: Db, orgId: string, runId: string): Promise<RunReport | null> {
  const run = await db.query.importRuns.findFirst({
    where: eq(schema.importRuns.id, runId),
  });
  // Scoped to the caller's organisation: a run id from another tenant reads as
  // absent rather than as forbidden, so a probe learns nothing.
  if (!run || run.orgId !== orgId) return null;

  const rows = await db.query.importRunRows.findMany({
    where: eq(schema.importRunRows.runId, runId),
  });
  const count = (p: (r: (typeof rows)[number]) => boolean) => rows.filter(p).length;

  return {
    runId,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    rowsTotal: run.rowsTotal,
    rowsProcessed: rows.length,
    profilesCreated: count((r) => r.outcome === 'created'),
    membershipsAdded: count((r) => r.outcome === 'added_membership'),
    membershipsReactivated: count((r) => r.outcome === 'reactivated'),
    peopleMerged: count((r) => r.outcome === 'merged'),
    duplicateRows: count((r) => r.outcome === 'duplicate'),
    candidateSeats: count((r) => r.seatPool === 'candidate'),
    staffSeats: count((r) => r.seatPool === 'staff'),
    competenciesRecorded: rows.reduce((n, r) => n + r.competenciesRecorded, 0),
    // Recorded, not skipped (R153, reversed) — the count of grants awaiting a date.
    linesFlaggedNoDate: rows.reduce((n, r) => n + r.competenciesUndated, 0),
    assessmentsAssigned: rows.reduce((n, r) => n + r.assessmentsAssigned, 0),
    profilesFlaggedIncomplete: count((r) => (r.flagged ?? []).length > 0),
    differencesReported: count((r) => (r.differences ?? []).length > 0),
    rejected: rows
      .filter((r) => r.outcome === 'rejected')
      .map((r) => ({
        rowNumber: r.rowNumber,
        subject: r.subject,
        reason: r.reason ?? 'unknown',
        detail: r.detail,
      })),
    flagged: rows
      .filter((r) => (r.flagged ?? []).length > 0)
      .map((r) => ({ rowNumber: r.rowNumber, subject: r.subject, missing: r.flagged })),
    differences: rows
      .filter((r) => (r.differences ?? []).length > 0)
      .map((r) => ({
        rowNumber: r.rowNumber,
        subject: r.subject,
        membershipId: r.membershipId,
        items: r.differences,
      })),
  };
}
