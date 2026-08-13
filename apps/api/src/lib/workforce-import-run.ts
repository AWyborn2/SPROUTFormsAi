import { and, eq, lt } from 'drizzle-orm';
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
import { isUniqueViolationOn } from './db-errors.js';
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
 *
 * THE RUN DOES NOT LIVE INSIDE THE REQUEST THAT ASKED FOR IT, and that is the
 * whole of this module's newer half. One transaction per row over 191 people and
 * 3,325 competency lines takes minutes; the browser gave up long before it
 * finished, and the screen — with nothing left to ask — offered the upload form
 * and a live confirm button while the run was still writing rows. The operator
 * nearly started a second one against production, and reconstructed the first
 * one's progress by counting `memberships` in psql.
 *
 * So `startImportRun` CLAIMS a run, hands back its id, and lets the work
 * continue on a detached promise. Nothing about the request matters to it
 * afterwards, and nothing about it matters to the request.
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
    The name column is still ONE cell, so the split stays first word /
    everything else. What changed is that the file may now carry `middle_name`
    separately, and when it does that column wins: the split cannot tell a
    middle name from a two-part surname, and guessing wrong puts somebody's
    surname in the wrong field of the record their licence is checked against.
    Absent, the old behaviour stands and the remainder lands in the surname.

    The two workforce numbers are still NOT passed here — the lander writes
    those from the row itself, and sending them twice would make one value have
    two sources.
  */
  const [firstName = '', ...rest] = row.name.trim().split(/\s+/);
  const landed = await landImportRow(db, tenant, resolved, {
    firstName,
    lastName: rest.join(' '),
    middleName: row.middleName || null,
    dateOfBirth: row.dateOfBirth || null,
    gender: row.gender || null,
    ethnicity: row.ethnicity || null,
    addressStreet: row.addressStreet || null,
    suburb: row.suburb || null,
    postcode: row.postcode || null,
    mobile: row.mobile || null,
    emergencyContactName: row.emergencyContactName || null,
    emergencyContactPhone: row.emergencyContactPhone || null,
    starterType: row.starterType || null,
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
 * How long a run may go without a sign of life before it is presumed dead.
 *
 * A CRASHED RUN MUST NOT LOOK LIKE A RUNNING ONE FOREVER, and nothing writes
 * `failed` when the process holding it disappears — a redeploy mid-import, an
 * OOM, a container recycled. The only evidence available afterwards is that the
 * heartbeat stopped, so that is what the reaper reads.
 *
 * Two minutes, against a heartbeat stamped on EVERY row. The slowest thing a
 * single row does is one transaction plus its competency grants, which is
 * comfortably under a second even on the file that caused this; two minutes is
 * far enough above that to never reap a live run, and near enough to a person's
 * patience that a dead one is reported before they start guessing.
 */
export const RUN_STALE_AFTER_MS = 120_000;

/** The three states a run can be in, as the report and the screen read them. */
export type RunStatus = 'running' | 'completed' | 'failed';

/**
 * Mark as failed any run of this organisation that stopped breathing.
 *
 * Called before a claim and before a read, which is what makes the recovery
 * automatic rather than something an operator has to know about: the next
 * person to open the screen or start an import both fixes the stuck record and
 * sees the truth. It is idempotent — a second call matches nothing — and it
 * cannot touch a live run, because a live run stamped its heartbeat within the
 * window by definition.
 *
 * The rows a dead run already landed are LEFT ALONE. They are real people, each
 * committed in its own transaction (KTD13); the run failed, its work did not
 * un-happen, and the report still counts every row that got in. Re-importing the
 * same file merges rather than duplicating, so the recovery is to run it again.
 */
export async function reapAbandonedRuns(
  db: Db,
  orgId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(schema.importRuns)
    .set({ status: 'failed', failureReason: 'abandoned', completedAt: now })
    .where(
      and(
        eq(schema.importRuns.orgId, orgId),
        eq(schema.importRuns.status, 'running'),
        lt(schema.importRuns.heartbeatAt, new Date(now.getTime() - RUN_STALE_AFTER_MS)),
      ),
    );
}

/** The run this organisation has in flight, or null. */
async function activeRunFor(db: Db, orgId: string): Promise<string | null> {
  const run = await db.query.importRuns.findFirst({
    where: and(eq(schema.importRuns.orgId, orgId), eq(schema.importRuns.status, 'running')),
  });
  // Re-read the state off the row rather than trusting the predicate alone: this
  // decides whether an Admin's import is refused, and a stale or completed row
  // returned by a mistaken filter must not be able to lock an organisation out.
  return run && run.status === 'running' ? run.id : null;
}

/** A claim either takes the organisation's one active slot or names who holds it. */
export type ClaimResult = { runId: string } | { refused: 'already_running'; runId: string };

/**
 * Take this organisation's one active run slot (R144's confirmation, made safe).
 *
 * TWO LAYERS, deliberately. The read gives a refusal a REASON and the id of the
 * run already in flight, which is what lets the screen show that run's progress
 * instead of an upload form — the single thing that would have saved the
 * operator in the incident. The partial unique index behind it is what makes the
 * guard true when two requests read "nothing running" before either inserts,
 * which is precisely the double-submit a timed-out browser invites.
 *
 * Row-level merging means a second pass would not corrupt anybody's record. The
 * guard is not about that. It is about not doing minutes of work against
 * production twice, and not leaving an operator with two reports of one file.
 */
export async function claimImportRun(
  db: Db,
  tenant: TenantContext,
  rowsTotal: number,
  now: Date = new Date(),
): Promise<ClaimResult> {
  // A run whose process died must not hold the slot against the recovery.
  await reapAbandonedRuns(db, tenant.orgId, now);

  const active = await activeRunFor(db, tenant.orgId);
  if (active) return { refused: 'already_running', runId: active };

  try {
    const [run] = await db
      .insert(schema.importRuns)
      .values({
        orgId: tenant.orgId,
        startedByUserId: tenant.userId,
        rowsTotal,
        status: 'running',
        heartbeatAt: now,
      })
      .returning();
    return { runId: run!.id };
  } catch (err) {
    if (!isUniqueViolationOn(err, 'import_runs_one_active_per_org')) throw err;
    /*
      The race the read above cannot close: the other request inserted between
      our read and our own insert. Its run is the live one, so report it the
      same way — the caller and the screen cannot tell the two paths apart, and
      should not have to.
    */
    const winner = await activeRunFor(db, tenant.orgId);
    return { refused: 'already_running', runId: winner ?? '' };
  }
}

/**
 * Walk the rows of a claimed run to its end.
 *
 * The rows the VALIDATOR rejected are recorded first so one report holds every
 * line of the file — an Admin correcting the source needs both kinds in one
 * place, and a report that showed only run-time refusals would send them looking
 * for the rest.
 *
 * NEVER THROWS. It is called on a detached promise, where a rejection would be
 * an unhandled one and, worse, would leave the run `running` with a heartbeat
 * that simply stops — indistinguishable from a crash until the reaper caught it
 * two minutes later. Recording the failure against the run is both faster and
 * more honest, because here we actually know why.
 */
export async function executeClaimedRun(
  db: Db,
  tenant: TenantContext,
  runId: string,
  input: RunInput,
  now: Date = new Date(),
): Promise<void> {
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

  /*
    Stamped after each row rather than on a timer, so the sign of life is
    PROGRESS rather than the process merely being up. A run wedged on one row
    goes stale and is reported failed, which is the right answer — it is not
    coming back.
  */
  const beat = () =>
    db
      .update(schema.importRuns)
      .set({ heartbeatAt: new Date() })
      .where(eq(schema.importRuns.id, runId));

  try {
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
      await beat();
    }

    const resolved = await resolveRows(db, tenant.orgId, input.validProfiles);
    const byEmail = competenciesByEmail(input.validCompetencies);
    for (const row of resolved) {
      const lines = byEmail.get(row.row.email.toLowerCase()) ?? [];
      await write(await runOneRow(db, tenant, row, lines, now));
      await beat();
    }

    await db
      .update(schema.importRuns)
      .set({ status: 'completed', completedAt: new Date(), heartbeatAt: new Date() })
      .where(eq(schema.importRuns.id, runId));

    await recordAudit(db, tenant, {
      action: 'Ran workforce import',
      target: `${input.validProfiles.length} row${input.validProfiles.length === 1 ? '' : 's'} attempted`,
      category: 'team',
      icon: 'upload',
    });
  } catch (err) {
    /*
      A row's own refusals never reach here — `runOneRow` returns them as
      outcomes (R170). This is the file-level failure: the taxonomy read threw,
      the connection dropped, the pool went away. The run stops, says so, and
      RELEASES THE SLOT, because an organisation must not be locked out of
      re-importing by a run that is never going to finish.
    */
    const reason = err instanceof Error ? err.message : 'unknown_error';
    await db
      .update(schema.importRuns)
      .set({ status: 'failed', failureReason: reason, completedAt: new Date() })
      .where(eq(schema.importRuns.id, runId))
      // Last resort: if even this write fails the run keeps its stale heartbeat
      // and the reaper reports it, which is the outcome this branch improves on
      // rather than the one it depends on.
      .catch(() => undefined);
  }
}

/**
 * Claim a run and start it, WITHOUT waiting for it.
 *
 * The detached promise is the whole mechanism, and it is deliberately not a job
 * queue: this project has none, adding one is infrastructure the incident does
 * not justify, and the thing that actually broke was the run being tied to a
 * socket — not the run being in this process. Express has already sent the
 * response and moved on; the promise chain is untouched by that, so the work
 * survives the request ending, which is precisely requirement one.
 *
 * What it does NOT survive is the process ending. That is not hidden: a run
 * killed mid-flight stops heartbeating and is reaped as `failed`, so the screen
 * says so and the file can be re-imported — merging, not duplicating. If this
 * product later needs an import to survive a redeploy, that is a queue, and it
 * should be introduced as one rather than approximated here.
 */
export async function startImportRun(
  db: Db,
  tenant: TenantContext,
  input: RunInput,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const claim = await claimImportRun(
    db,
    tenant,
    input.validProfiles.length + input.rejected.length,
    now,
  );
  if ('refused' in claim) return claim;

  // `void` and no await: the caller returns the id to a browser that may well
  // be gone by the time row two lands, and neither cares about the other.
  void executeClaimedRun(db, tenant, claim.runId, input, now);
  return claim;
}

/**
 * Claim a run and walk it to the end before returning.
 *
 * The awaited form, kept for callers that genuinely want the finished state —
 * tests, and any future script importing a file without a browser in front of
 * it. `startImportRun` is what the route uses.
 */
export async function executeImportRun(
  db: Db,
  tenant: TenantContext,
  input: RunInput,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const claim = await claimImportRun(
    db,
    tenant,
    input.validProfiles.length + input.rejected.length,
    now,
  );
  if ('refused' in claim) return claim;
  await executeClaimedRun(db, tenant, claim.runId, input, now);
  return claim;
}

/**
 * The organisation's run in flight, reported in full, or null.
 *
 * WHAT THE SCREEN ASKS ON LOAD, and the answer that stops the incident
 * repeating: an Admin who returns to the page — after a timeout, a reload, a
 * different machine — is shown the run that is happening rather than an upload
 * form and a live confirm button. It reaps first, so a dead run answers null
 * here and the form is correctly available again.
 */
export async function readActiveRunReport(
  db: Db,
  orgId: string,
  now: Date = new Date(),
): Promise<RunReport | null> {
  await reapAbandonedRuns(db, orgId, now);
  const runId = await activeRunFor(db, orgId);
  return runId ? readRunReport(db, orgId, runId, now) : null;
}

/** Every figure R171 names, DERIVED from the rows rather than counted alongside them. */
export interface RunReport {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  /**
   * Running, completed or failed — the answer the screen was missing.
   *
   * `completedAt` alone could only say "not finished", which a dead run and a
   * live one both satisfy, and which is exactly what let a lost run present
   * itself as nothing at all.
   */
  status: RunStatus;
  /** Set only on a failure: the thrown message, or `abandoned` for a reaped run. */
  failureReason: string | null;
  rowsTotal: number;
  /**
   * Rows actually recorded, COUNTED — never estimated, never interpolated from
   * elapsed time. It is the same number the operator was reduced to fetching
   * with `select count(*)` by hand, and a progress bar that guessed would be
   * worse than the psql session it replaces.
   */
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

export async function readRunReport(
  db: Db,
  orgId: string,
  runId: string,
  now: Date = new Date(),
): Promise<RunReport | null> {
  /*
    Reap first, so a run whose process died reports `failed` on the very poll
    that would otherwise have shown it running. The screen polls this route once
    a second while a run is in flight, which makes the read the earliest and most
    frequent place the truth can be restored — and the write is idempotent and
    matches nothing in the ordinary case.
  */
  await reapAbandonedRuns(db, orgId, now);

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
    // Defaulted for a row written before this column existed; every such run
    // finished inside its request, so `completed` is what it was.
    status: run.status ?? 'completed',
    failureReason: run.failureReason ?? null,
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
