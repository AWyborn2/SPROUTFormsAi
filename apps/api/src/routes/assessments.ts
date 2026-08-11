import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  applyCalcs,
  ASSESSMENT_PATHWAYS,
  NS_DISPOSITIONS,
  caseProgress,
  competencyCurrency,
  countsAsHeld,
  fieldsInPart,
  fieldsInSection,
  isCaseCompetent,
  isTerminalCaseState,
  isSelfMarking,
  moreCoachingRequired,
  type AssessmentCaseState,
  logbookRows,
  markTheory,
  ACCESS_LEVELS,
  VALUE_SOURCES,
  WORKFLOW_ROLES,
  orderedParts,
  requiredParts,
  resolveAssessorRequirements,
  validateWorkflow,
  partFieldAccess,
  competencyStatus,
  type CompetencyStatus,
  PROFILE_PREFILL_KEYS,
  profilePrefillValues,
  validateProfilePrefill,
  validatePrerequisiteChecks,
  type ProfilePrefillSource,
  sectionForPart,
  workflowOf,
  writableFieldIds,
  type WorkflowRole,
  streamCheckWarning,
  totalLoggedHours,
  stripMarkingSecrets,
  theoryRenderingOf,
  validateAnswerKeys,
  validateManifest,
  type AssessmentPart,
  type AssessmentPathway,
  type AssessmentToolManifest,
  type AttemptFact,
  type FormField,
  type RepeatingRowValue,
  type SubmissionValue,
  THEORY_RENDERINGS,
} from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission, permissionScope } from '../lib/permissions.js';
import { heldCompetencyStates } from '../lib/assignment.js';
import { identifyMember, loadDisplayIdentities } from '../lib/display-identity.js';
import { recordAudit } from '../audit/record.js';
import { grantCompetency, revokeGrantsFromCase } from '../lib/competency-grant.js';
import { CaseExportError, exportCasePdf } from '../pdf/index.js';
import { getStorageClient } from '../storage/index.js';
import { db } from '../db.js';

/**
 * Multi-part assessment cases.
 *
 * Three ideas carry this router.
 *
 * 1. ATTEMPTS ARE ROWS. A retry allocates the next attempt number and leaves
 *    the failed row untouched. Nothing here ever mutates a resolved attempt, so
 *    the audit trail keeps every failure while the evidence document renders
 *    the passing one.
 *
 * 2. PROGRESS IS DERIVED. Part state comes from `caseProgress` over the attempt
 *    rows, never from a stored status column. A stored copy is a second source
 *    of truth that can disagree with the rows it summarises.
 *
 * 3. THE SYSTEM RECORDS DECISIONS, IT DOES NOT MAKE THEM. Every discretionary
 *    branch — a not-satisfactory disposition, starting a demonstration below an
 *    hours minimum, proceeding past an unmet prerequisite — demands a recorded
 *    reason and then does what the assessor asked. The one exception is a
 *    theory outcome, which is computed from the answer key and reviewed rather
 *    than entered.
 */
export const assessmentToolsRouter: Router = Router();
export const assessmentCasesRouter: Router = Router();

const GATE = [requireTenant, requirePlanFeature('assessments')] as const;

// ── shared helpers ──────────────────────────────────────────────────────────

type Database = NonNullable<typeof db>;

/*
  The Admin access level (R73). Declaring the parts rule reads the organisation's
  Location taxonomy and decides which sections a candidate must complete to be
  certified, so it sits on the same gate R12 puts on managing that taxonomy —
  not on the permission that authors a document's wording.
*/
function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

async function loadTool(database: Database, toolId: string, orgId: string) {
  return (
    (await database.query.assessmentTools.findFirst({
      where: and(eq(schema.assessmentTools.id, toolId), eq(schema.assessmentTools.orgId, orgId)),
    })) ?? null
  );
}

async function loadCase(database: Database, caseId: string, orgId: string) {
  return (
    (await database.query.assessmentCases.findFirst({
      where: and(eq(schema.assessmentCases.id, caseId), eq(schema.assessmentCases.orgId, orgId)),
    })) ?? null
  );
}

async function attemptsFor(database: Database, caseId: string) {
  return database.query.assessmentPartAttempts.findMany({
    where: eq(schema.assessmentPartAttempts.caseId, caseId),
    orderBy: (a, { asc }) => [asc(a.partKey), asc(a.attemptNumber)],
  });
}

/** The repeating table a logbook part totals its hours from, on one version. */
async function logbookTableId(
  database: Database,
  versionId: string,
  startFieldId: string,
): Promise<string | undefined> {
  const fields = await fieldsForVersion(database, versionId);
  return fieldsInSection(fields, startFieldId).find((f) => f.type === 'repeating_group')?.id;
}

/** The rows to carry into a retry, read by the one shared rule. */
async function logbookRowsOf(
  database: Database,
  attempt: { values: Record<string, SubmissionValue>; templateVersionId: string },
  part: AssessmentPart,
): Promise<RepeatingRowValue[]> {
  const fields = await fieldsForVersion(database, attempt.templateVersionId);
  return logbookRows(fields, part, attempt.values);
}

/**
 * The rows and threshold stamp a new logbook attempt inherits from the last one.
 *
 * Returns nothing at all — not an empty map — for any part that is not a
 * logbook, for a first attempt, and whenever the table cannot be resolved on
 * BOTH versions. Carrying nothing leaves a visibly empty logbook a candidate
 * can refill; carrying rows under a key the new version does not declare would
 * strand them where no surface reads them, which looks like the same empty
 * logbook while quietly making the data unreachable.
 *
 * The table id is resolved per VERSION because a retry pins to the case's
 * current version, which can differ from the one the previous attempt was taken
 * against. The rows move from the old id to the new one.
 *
 * `thresholdNotifiedAt` travels with them. The carried attempt is born above the
 * minimum, and without the stamp its first save would announce "logbook minimum
 * reached" a second time for a threshold crossed weeks earlier.
 */
async function carryForwardLogbook(
  database: Database,
  input: {
    part: AssessmentPart;
    previous: readonly { attemptNumber: number; values: Record<string, SubmissionValue>; templateVersionId: string; thresholdNotifiedAt: Date | null }[];
    toVersionId: string;
  },
): Promise<{ values: Record<string, SubmissionValue>; thresholdNotifiedAt: Date | null } | undefined> {
  if (input.part.kind !== 'logbook') return undefined;

  const last = [...input.previous].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  if (!last) return undefined;

  // Read by the SHARED rule so the rows carried forward are exactly the rows the
  // threshold counted and the dashboard reports. Written under the NEW version's
  // table id, which is why only the destination needs resolving here.
  const [rows, toId] = await Promise.all([
    logbookRowsOf(database, last, input.part),
    logbookTableId(database, input.toVersionId, input.part.startFieldId),
  ]);
  if (!toId || rows.length === 0) return undefined;

  return { values: { [toId]: rows }, thresholdNotifiedAt: last.thresholdNotifiedAt ?? null };
}

/** The fields of the version this attempt is pinned to. */
async function fieldsForVersion(database: Database, versionId: string): Promise<FormField[]> {
  const version = await database.query.formTemplateVersions.findFirst({
    where: eq(schema.formTemplateVersions.id, versionId),
  });
  return version?.fields ?? [];
}

/**
 * Never held it, or held it and let it lapse.
 *
 * Kept apart because they send the reader somewhere different: `missing` means
 * enrol this person, `expired` means book them a requalification. Collapsing
 * both into "missing" told an assessor to arrange training a candidate has
 * already done.
 */
export interface PrerequisiteGap {
  competencyId: string;
  reason: 'missing' | 'expired';
}

/** Prose for one gap, addressed to whoever has it. */
function describeGap(who: 'candidate' | 'assessor', gap: PrerequisiteGap): string {
  return gap.reason === 'expired'
    ? `${who} competency ${gap.competencyId} has expired`
    : `${who} missing competency ${gap.competencyId}`;
}

/**
 * Required competencies the user is not currently qualified in.
 *
 * Returned as warnings, never as a refusal — an out-of-date competency record
 * is far more common than an unqualified person, and blocking on it would stop
 * real assessments over stale data entry. The unmet list is recorded on the
 * case so the gap is visible afterwards.
 */
async function unmetPrerequisites(
  database: Database,
  orgId: string,
  userId: string | null,
  requiredIds: readonly string[],
): Promise<PrerequisiteGap[]> {
  if (!userId || requiredIds.length === 0) return [];
  const held = await database.query.competencyHolders.findMany({
    where: and(
      eq(schema.competencyHolders.userId, userId),
      eq(schema.competencyHolders.orgId, orgId),
      // A revoked grant is kept for the audit trail but confers nothing. Without
      // this, a competency stripped by an overturned appeal goes on satisfying
      // prerequisites — the row is still there, and eligibility is the one
      // question it must stop answering.
      isNull(schema.competencyHolders.revokedAt),
    ),
  });
  if (held.length === 0) {
    return requiredIds.map((competencyId) => ({ competencyId, reason: 'missing' as const }));
  }

  /*
    A LAPSED TICKET IS NOT A HELD ONE.

    Holding a row said nothing about whether the qualification was still valid,
    so a three-year ticket earned five years ago satisfied a prerequisite
    exactly as well as one earned this morning.

    Expiry is derived from the grant date and the qualification's own validity
    period, so this needs the competencies too. `expiring` and `grace` still
    COUNT — a ticket near its date, or inside the window the authority allows
    for requalifying, must not make somebody ineligible.

    Still warnings, never refusals: an expired RECORD is far more common than an
    expired person, and the whole doctrine here is that stale data must not stop
    a real assessment being written down.
  */
  const competencies = await database.query.competencies.findMany({
    where: and(
      eq(schema.competencies.orgId, orgId),
      inArray(schema.competencies.id, held.map((h) => h.competencyId)),
    ),
  });
  const validityById = new Map(competencies.map((c) => [c.id, c]));
  const heldById = new Map(held.map((h) => [h.competencyId, h]));

  const now = new Date();
  const gaps: PrerequisiteGap[] = [];
  for (const competencyId of requiredIds) {
    const grant = heldById.get(competencyId);
    const validity = grant ? validityById.get(competencyId) : undefined;
    // No grant, or a grant pointing at a competency this org does not have:
    // either way there is nothing here that proves the person is qualified.
    if (!grant || !validity) {
      gaps.push({ competencyId, reason: 'missing' });
      continue;
    }
    if (!countsAsHeld(competencyCurrency(grant, validity, now, 'assessor'))) {
      gaps.push({ competencyId, reason: 'expired' });
    }
  }
  return gaps;
}

function toAttemptFacts(rows: { partKey: string; attemptNumber: number; outcome: string | null }[]): AttemptFact[] {
  return rows.map((r) => ({
    partKey: r.partKey,
    attemptNumber: r.attemptNumber,
    outcome: (r.outcome as AttemptFact['outcome']) ?? null,
  }));
}

// ── assessment tools ────────────────────────────────────────────────────────

/*
  EVERY PROPERTY OF THE TYPE MUST APPEAR HERE.

  A plain z.object STRIPS unknown keys, and nothing in this router uses
  .strict() or .passthrough(). So a property present in AssessmentToolManifest
  but missing from this schema is silently discarded on the HTTP path while the
  authoring script keeps it — two writers producing two different manifests,
  with no error anywhere to say so.
*/
const declaredMarkSchema = z.object({
  fieldId: z.string().min(1),
  rowKey: z.string().optional(),
  columnKey: z.string().optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
});

const partSchema = z.object({
  key: z.string().min(1),
  ordinal: z.number().int().positive(),
  label: z.string().min(1),
  kind: z.enum(['theory', 'practical', 'logbook']),
  pathways: z.array(z.enum(ASSESSMENT_PATHWAYS)).min(1),
  startFieldId: z.string().min(1),
  minimumHours: z.number().positive().optional(),
  durationColumnKey: z.string().optional(),
  checklistMark: declaredMarkSchema.optional(),
  assessorNameFieldId: z.string().optional(),
  signedDateFieldId: z.string().optional(),
  mandatoryFieldIds: z.array(z.string()).optional(),
  outcomeSatisfactory: declaredMarkSchema.optional(),
  outcomeNotSatisfactory: declaredMarkSchema.optional(),
  furtherActionFieldId: z.string().optional(),
});

/**
 * The configured workflow, as it arrives over HTTP.
 *
 * Structure only. Whether it makes SENSE — a section covering a part the tool
 * does not have, a dependency loop, a field two sections both claim — is
 * `validateWorkflow`'s job, because those answers need the manifest and the
 * version's fields, which zod cannot see.
 */
const accessLevel = z.enum(ACCESS_LEVELS);
const fieldAccess = z.union([accessLevel, z.literal('inherit')]);

const workflowSchema = z.object({
  roles: z.array(z.enum(WORKFLOW_ROLES)).min(1),
  sections: z.array(
    z.object({
      key: z.string().min(1),
      ordinal: z.number().int().nonnegative(),
      label: z.string().min(1),
      partKey: z.string().min(1).optional(),
      fieldIds: z.array(z.string().min(1)).optional(),
      access: z.record(z.enum(WORKFLOW_ROLES), accessLevel),
      fieldAccess: z.record(z.string(), z.record(z.enum(WORKFLOW_ROLES), fieldAccess)).optional(),
      fieldSource: z.record(z.string(), z.enum(VALUE_SOURCES)).optional(),
      requires: z.array(z.string().min(1)).optional(),
    }),
  ),
});

/** What may be changed on an existing tool. Everything optional — it is a patch. */
/**
 * What the candidate's profile supplies for `manifest.profilePrefill`.
 *
 * Resolved from the same rows the display-identity resolver reads: profile
 * names win over the product-wide user name (an Admin corrects profiles, not
 * accounts), and the company is the ORGANISATION's name — this workforce is a
 * single subcontractor, and the org is who the candidate works for.
 *
 * Written once and shared by attempt open and case export, because two
 * resolvers is how the screen and the printed record come to name the same
 * person differently.
 */
async function resolveProfilePrefillSource(
  database: NonNullable<typeof db>,
  orgId: string,
  candidateUserId: string,
): Promise<ProfilePrefillSource> {
  const [org, user, membership] = await Promise.all([
    database.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) }),
    database.query.users.findFirst({ where: eq(schema.users.id, candidateUserId) }),
    database.query.memberships.findFirst({
      where: and(
        eq(schema.memberships.userId, candidateUserId),
        eq(schema.memberships.orgId, orgId),
      ),
    }),
  ]);
  const profile = membership
    ? await database.query.memberProfiles.findFirst({
        where: eq(schema.memberProfiles.membershipId, membership.id),
      })
    : undefined;

  const profileName = profile ? `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim() : '';
  return {
    candidateName: profileName || user?.name || null,
    companyName: org?.name ?? null,
    swipeCard: profile?.swipeCardNumber ?? null,
    employeeNumber: profile?.employeeNumber ?? null,
  };
}

/** One prerequisite, answered from the competency register at read time. */
interface PrerequisiteResult {
  fieldId: string;
  competencyId: string;
  competencyName: string;
  /**
   * Current — held, expiring, in grace, or undated. Expired, revoked and
   * missing are not.
   */
  satisfied: boolean;
  /**
   * Every DATED state, plus the two this surface adds for a grant that is not
   * there at all. Derived from `CompetencyStatus` rather than re-listed, so a
   * state added there (as `undated` was) cannot silently go unhandled here.
   */
  status: CompetencyStatus | 'revoked' | 'missing';
  expiresAt: string | null;
}

/**
 * Answer `manifest.prerequisiteChecks` from the register, at NOW.
 *
 * Evaluated on every read rather than stored, so a licence that expires
 * mid-programme shows expired the next time anyone looks — a stored verdict is
 * a verdict about the day it was written. Revocation is decisive over the date
 * (R106): a revoked grant is not a current one whatever its expiry says.
 */
async function evaluatePrerequisites(
  database: NonNullable<typeof db>,
  orgId: string,
  candidateUserId: string,
  manifest: AssessmentToolManifest,
): Promise<PrerequisiteResult[]> {
  const checks = manifest.prerequisiteChecks ?? [];
  if (checks.length === 0) return [];

  const ids = [...new Set(checks.map((c) => c.competencyId))];
  const [competencies, holders] = await Promise.all([
    database.query.competencies.findMany({
      where: and(eq(schema.competencies.orgId, orgId), inArray(schema.competencies.id, ids)),
    }),
    database.query.competencyHolders.findMany({
      where: and(
        eq(schema.competencyHolders.orgId, orgId),
        eq(schema.competencyHolders.userId, candidateUserId),
        inArray(schema.competencyHolders.competencyId, ids),
      ),
    }),
  ]);
  const byId = new Map(competencies.map((c) => [c.id, c]));
  const now = new Date();

  return checks.map((check) => {
    const competency = byId.get(check.competencyId);
    const held = holders.find((h) => h.competencyId === check.competencyId);
    const base = {
      fieldId: check.fieldId,
      competencyId: check.competencyId,
      competencyName: competency?.name ?? 'Unknown competency',
    };
    if (!held) return { ...base, satisfied: false, status: 'missing' as const, expiresAt: null };
    if (held.revokedAt) return { ...base, satisfied: false, status: 'revoked' as const, expiresAt: null };
    const status = competencyStatus(
      { grantedAt: held.grantedAt, ...(held.expiresAt ? { expiresAt: held.expiresAt } : {}) },
      { validForMonths: competency?.validForMonths, gracePeriodDays: competency?.gracePeriodDays },
      now,
    );
    return {
      ...base,
      satisfied: status !== 'expired',
      status,
      expiresAt: held.expiresAt ? held.expiresAt.toISOString() : null,
    };
  });
}

/** The tool's declared defaults for these fields — served under stored values. */
function defaultsFor(
  manifest: AssessmentToolManifest,
  fields: readonly FormField[],
): Record<string, SubmissionValue> {
  const out: Record<string, SubmissionValue> = {};
  for (const field of fields) {
    const value = manifest.fieldDefaults?.[field.id];
    if (value !== undefined) out[field.id] = value;
  }
  return out;
}

const updateToolBody = z.object({
  name: z.string().min(1).optional(),
  workflow: workflowSchema.optional(),
  /**
   * Which fields fill from the candidate's profile. `null` clears the map;
   * absent leaves it as stored — the same tri-state every nullable PATCH field
   * here uses, so saving a workflow does not silently erase the prefill.
   */
  profilePrefill: z.record(z.string(), z.enum(PROFILE_PREFILL_KEYS)).nullable().optional(),
  /** Same tri-state as profilePrefill: absent keeps, null clears, array replaces. */
  prerequisiteChecks: z
    .array(z.object({ fieldId: z.string().min(1), competencyId: z.string().min(1) }))
    .nullable()
    .optional(),
  /** Tool-declared default answers. Same tri-state; values stored opaque. */
  fieldDefaults: z.record(z.string(), z.unknown()).nullable().optional(),
});

const toolBody = z.object({
  templateId: z.string().uuid(),
  name: z.string().min(1),
  manifest: z.object({
    parts: z.array(partSchema).min(1),
    locationStreamFieldId: z.string().optional(),
    /*
      The rule above, broken in exactly the way it warns about. This was on the
      manifest type and absent here, so a tool created or edited over HTTP lost
      the pointer while the same tool authored by the script kept it — and the
      cover page belongs to no part, so this is the ONLY way a name reaches the
      certificate. The failure is a signed, competent evidence PDF certifying
      nobody, which the runbook calls the one omission an auditor cannot work
      around.
    */
    candidateNameFieldId: z.string().optional(),
    candidateSignatureFieldId: z.string().optional(),
    /*
      Who does what, and when. The same trap this file warns about above: a
      manifest property this schema does not name is silently STRIPPED, so a
      builder that appeared to save a workflow would discard it and the tool
      would quietly fall back to the derived default.
    */
    workflow: workflowSchema.optional(),
    /*
      Named here for the third time for the same reason: a manifest property
      this schema does not list is silently STRIPPED, so a builder that appeared
      to save a one-question-per-screen tool would publish a stacked one.
    */
    theoryRendering: z.enum(THEORY_RENDERINGS).optional(),
    signOff: z
      .object({
        assessorNameFieldId: z.string().optional(),
        assessorSignatureFieldId: z.string().optional(),
        signedDateFieldId: z.string().optional(),
        overallSatisfactory: declaredMarkSchema.optional(),
        moreCoachingRequiredYes: declaredMarkSchema.optional(),
        moreCoachingRequiredNo: declaredMarkSchema.optional(),
      })
      .optional(),
  }),
  candidatePrerequisiteIds: z.array(z.string().uuid()).optional(),
  assessorCompetencyIds: z.array(z.string().uuid()).optional(),
  /**
   * Extra assessor requirements per location stream, keyed by stream name.
   *
   * The half of the rule a flat AND list cannot state: Q50071833 authorises
   * mine assessments and Q50073293 authorises raw materials, so which one an
   * assessor needs depends on where the assessment happens.
   */
  assessorStreamCompetencyIds: z.record(z.string().min(1), z.array(z.string().uuid())).optional(),
  /** What passing this tool AWARDS. Granted on sign-off, linked to the case. */
  awardedCompetencyIds: z.array(z.string().uuid()).optional(),
});

/**
 * Create an assessment tool over a published template.
 *
 * The manifest is validated against the template's ACTUAL fields, not accepted
 * on trust: a part anchored to a field that version does not contain would
 * contribute no values and export as a silently blank part.
 */
assessmentToolsRouter.post(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'create'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = toolBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { templateId, name, manifest } = parsed.data;

    const template = await db.query.formTemplates.findFirst({
      where: and(
        eq(schema.formTemplates.id, templateId),
        eq(schema.formTemplates.orgId, tenant.orgId),
      ),
    });
    if (!template?.currentVersionId) {
      res.status(404).json({ error: 'template_not_found' });
      return;
    }

    const fields = await fieldsForVersion(db, template.currentVersionId);
    const problems = [
      ...validateManifest(manifest as AssessmentToolManifest, fields),
      ...validateAnswerKeys(fields),
    ];
    if (problems.length > 0) {
      res.status(400).json({ error: 'invalid_manifest', problems });
      return;
    }

    const [row] = await db
      .insert(schema.assessmentTools)
      .values({
        orgId: tenant.orgId,
        templateId,
        name,
        manifest: manifest as AssessmentToolManifest,
        candidatePrerequisiteIds: parsed.data.candidatePrerequisiteIds ?? [],
        assessorCompetencyIds: parsed.data.assessorCompetencyIds ?? [],
        assessorStreamCompetencyIds: parsed.data.assessorStreamCompetencyIds ?? {},
        awardedCompetencyIds: parsed.data.awardedCompetencyIds ?? [],
        // The parts rule and the Department classification are declared later,
        // both behind the Admin gate (U9/U10, R73/R9) — never at create, which
        // runs on the authoring permission.
        locationPartKeys: {},
        departmentId: null,
      })
      .returning();
    if (!row) throw new Error('tool_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Created assessment tool',
      target: name,
      category: 'forms',
      icon: 'clipboard-check',
    });

    res.status(201).json({ id: row.id, name: row.name, templateId: row.templateId });
  }),
);

assessmentToolsRouter.get(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const [rows, orgLocations] = await Promise.all([
      db.query.assessmentTools.findMany({ where: eq(schema.assessmentTools.orgId, tenant.orgId) }),
      db.query.locations.findMany({
        where: and(eq(schema.locations.orgId, tenant.orgId), eq(schema.locations.status, 'active')),
        orderBy: (l, { asc }) => [asc(l.name)],
      }),
    ]);

    /*
      Filter by Department (R9), if asked. An UNCLASSIFIED tool (department_id
      null) appears in EVERY Department filter (R10, R11) so it cannot be
      silently missed — that is `dept === asked || dept === null`, the null
      standing for "no Department yet", not "every Department". Applied here
      rather than in the query so the null-appears-everywhere rule reads in one
      place; the per-org tool list is small.
    */
    const filterDept = typeof req.query.departmentId === 'string' ? req.query.departmentId : null;
    const visible = filterDept
      ? rows.filter((t) => t.departmentId === filterDept || t.departmentId === null)
      : rows;

    res.json(
      visible.map((t) => ({
        id: t.id,
        name: t.name,
        templateId: t.templateId,
        departmentId: t.departmentId,
        parts: orderedParts(t.manifest).map((p) => ({ key: p.key, label: p.label, kind: p.kind })),
        /*
          The organisation's Locations, offered on the new-case form so a case is
          placed by choosing from the managed list rather than typing a stream
          name (R77). The assessor rule adds requirements only at the Locations
          it keys, but a case may be assessed at any of the organisation's sites,
          so the whole active list is offered.
        */
        locations: orgLocations.map((l) => ({ id: l.id, name: l.name })),
      })),
    );
  }),
);

/**
 * One tool, with everything the workflow builder needs to render.
 *
 * The manifest AND the current version's fields, in one response. The builder
 * shows the document on one side and the process on the other, so splitting
 * them across two round trips would let it draw half a screen against a version
 * the other half does not describe.
 *
 * `workflow` is always present — synthesised from the parts when nobody has
 * configured one — so the builder never has to invent a starting state, and
 * what it shows on first open is exactly what the server is already enforcing.
 */
assessmentToolsRouter.get(
  '/:id',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const tool = await loadTool(db, req.params.id!, tenant.orgId);
    if (!tool) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const [template, orgLocations] = await Promise.all([
      db.query.formTemplates.findFirst({
        where: and(
          eq(schema.formTemplates.id, tool.templateId),
          eq(schema.formTemplates.orgId, tenant.orgId),
        ),
      }),
      db.query.locations.findMany({
        where: and(eq(schema.locations.orgId, tenant.orgId), eq(schema.locations.status, 'active')),
      }),
    ]);
    const fields = template?.currentVersionId
      ? await fieldsForVersion(db, template.currentVersionId)
      : [];

    const workflow = workflowOf(tool.manifest, fields);
    const { problems, warnings } = validateWorkflow(workflow, tool.manifest, fields);

    res.json({
      id: tool.id,
      name: tool.name,
      templateId: tool.templateId,
      /** The Department that classifies this tool, or null for unclassified (R9, R10). */
      departmentId: tool.departmentId,
      manifest: tool.manifest,
      workflow,
      /*
        The active Locations the parts rule may distinguish (R76), and the rule
        as stored (U9). A rule may still name a Location since retired (R118), so
        the editor merges those keys with this list rather than assuming every
        key appears here.
      */
      locations: orgLocations.map((l) => ({ id: l.id, name: l.name })),
      locationPartKeys: tool.locationPartKeys ?? {},
      /*
        Whether the stored workflow is real or synthesised. The builder needs to
        say "this is the default, nobody has configured it" rather than implying
        somebody chose it — and an author who has genuinely never opened this
        screen should not be shown a configuration presented as theirs.
      */
      workflowIsDefault: tool.manifest.workflow === undefined,
      /*
        Answer-key-bearing fields are served to the builder because it is an
        AUTHORING surface — the same place keys are set. Fill surfaces get
        `stripMarkingSecrets`; this deliberately does not.
      */
      fields,
      problems,
      warnings,
    });
  }),
);

/**
 * Change a tool after creation.
 *
 * There has been no way to do this: a tool was write-once, so a manifest
 * corrected after the fact needed a direct SQL script. That is why the workflow
 * builder needs this route before it needs a screen.
 *
 * Refuses to store a structurally broken workflow. `warnings` come back with a
 * 200 — an unfinished configuration is a real state to save and return to, and
 * refusing it would make the builder unusable halfway through a first pass.
 */
assessmentToolsRouter.patch(
  '/:id',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = updateToolBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tool = await loadTool(db, req.params.id!, tenant.orgId);
    if (!tool) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const manifestChanged =
      parsed.data.workflow !== undefined ||
      parsed.data.profilePrefill !== undefined ||
      parsed.data.prerequisiteChecks !== undefined ||
      parsed.data.fieldDefaults !== undefined;
    let manifest: AssessmentToolManifest = tool.manifest;
    if (parsed.data.workflow) manifest = { ...manifest, workflow: parsed.data.workflow };
    if (parsed.data.profilePrefill !== undefined) {
      // `null` CLEARS the map; a record replaces it. Absent leaves it alone —
      // otherwise every workflow save would silently erase the prefill.
      const { profilePrefill: _dropped, ...rest } = manifest;
      manifest = parsed.data.profilePrefill
        ? { ...rest, profilePrefill: parsed.data.profilePrefill }
        : rest;
    }
    if (parsed.data.prerequisiteChecks !== undefined) {
      const { prerequisiteChecks: _dropped, ...rest } = manifest;
      manifest = parsed.data.prerequisiteChecks
        ? { ...rest, prerequisiteChecks: parsed.data.prerequisiteChecks }
        : rest;
    }
    if (parsed.data.fieldDefaults !== undefined) {
      const { fieldDefaults: _dropped, ...rest } = manifest;
      manifest = parsed.data.fieldDefaults
        ? { ...rest, fieldDefaults: parsed.data.fieldDefaults as Record<string, SubmissionValue> }
        : rest;
    }

    const template = await db.query.formTemplates.findFirst({
      where: and(
        eq(schema.formTemplates.id, tool.templateId),
        eq(schema.formTemplates.orgId, tenant.orgId),
      ),
    });
    const fields = template?.currentVersionId
      ? await fieldsForVersion(db, template.currentVersionId)
      : [];

    const { problems: workflowProblems, warnings } = validateWorkflow(
      workflowOf(manifest, fields),
      manifest,
      fields,
    );
    // The same check `validateManifest` runs at publish, so the map an editor
    // can save and the map a manifest can carry are one set.
    const problems = [
      ...workflowProblems,
      ...validateProfilePrefill(manifest.profilePrefill, fields),
      ...validatePrerequisiteChecks(manifest.prerequisiteChecks, fields),
    ];
    if (problems.length > 0) {
      // Nothing written. A half-applied workflow is worse than a rejected one:
      // it decides who may write a competency record.
      res.status(400).json({ error: 'invalid_workflow', problems });
      return;
    }

    await db
      .update(schema.assessmentTools)
      .set({
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(manifestChanged ? { manifest } : {}),
      })
      .where(eq(schema.assessmentTools.id, tool.id));

    await recordAudit(db, tenant, {
      action: 'Updated assessment tool',
      target: `${parsed.data.name ?? tool.name}${manifestChanged ? ' (workflow)' : ''}`,
      category: 'settings',
      icon: 'clipboard-check',
    });

    res.json({ id: tool.id, workflow: workflowOf(manifest, fields), warnings });
  }),
);

/** A parts rule: Location id → the manifest part keys required at that Location. */
const locationPartsBody = z.object({
  locationPartKeys: z.record(z.string().uuid(), z.array(z.string().min(1))),
});

/**
 * Declare which of a tool's parts apply at each Location (U9, R71–R75).
 *
 * ADMIN, not the authoring permission (R73): the rule decides which sections a
 * candidate must complete to be certified — a statement about the standard the
 * organisation holds people to — so it sits on the same gate R12 puts on the
 * Location taxonomy it reads, which is why this is its own route rather than a
 * field on the tool PATCH above.
 *
 * A Location ABSENT from the map requires every part (R75), so the map is only
 * the exceptions. A NEW entry must name an active Location (R118), but an entry
 * already stored for a Location since retired is preserved rather than rejected
 * — a rule stays with the Location it names.
 */
assessmentToolsRouter.patch(
  '/:id/location-parts',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = locationPartsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tool = await loadTool(db, req.params.id!, tenant.orgId);
    if (!tool) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const partKeys = new Set(orderedParts(tool.manifest).map((p) => p.key));
    const alreadyDeclared = new Set(Object.keys(tool.locationPartKeys ?? {}));
    const activeLocations = await db.query.locations.findMany({
      where: and(eq(schema.locations.orgId, tenant.orgId), eq(schema.locations.status, 'active')),
    });
    const activeIds = new Set(activeLocations.map((l) => l.id));

    for (const [locationId, keys] of Object.entries(parsed.data.locationPartKeys)) {
      // R118 / R16: a rule can only be ADDED for an active Location. One already
      // declared for a since-retired Location is allowed through so re-saving the
      // map does not strip it.
      if (!activeIds.has(locationId) && !alreadyDeclared.has(locationId)) {
        res.status(400).json({ error: 'location_not_found', locationId });
        return;
      }
      const unknown = keys.find((k) => !partKeys.has(k));
      if (unknown) {
        res.status(400).json({ error: 'unknown_part', partKey: unknown });
        return;
      }
    }

    await db
      .update(schema.assessmentTools)
      .set({ locationPartKeys: parsed.data.locationPartKeys })
      .where(eq(schema.assessmentTools.id, tool.id));

    await recordAudit(db, tenant, {
      action: 'Set assessment location parts rule',
      target: tool.name,
      category: 'settings',
      icon: 'clipboard-check',
    });

    res.json({ id: tool.id, locationPartKeys: parsed.data.locationPartKeys });
  }),
);

/** Classify a tool with a Department, or clear it (U10, R9, R10). Null unclassifies. */
const classificationBody = z.object({ departmentId: z.string().uuid().nullable() });

/**
 * Set (or clear) which Department classifies a tool (U10, R9).
 *
 * ADMIN, like the parts rule and for the same reason (R73's sibling): it reads
 * the Department taxonomy R12 gates. A tool carries at most one Department, so
 * this replaces rather than adds. Only an ACTIVE Department can be assigned
 * (R10/R16 admit only active values); null clears it to unclassified, which is
 * not "every Department" but "no Department yet" (R10) and shows in every filter
 * (R11). A Department already on the tool and since retired is left alone because
 * this endpoint is only reached to CHANGE the classification (R117's precondition).
 */
assessmentToolsRouter.patch(
  '/:id/classification',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = classificationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tool = await loadTool(db, req.params.id!, tenant.orgId);
    if (!tool) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    if (parsed.data.departmentId) {
      const dept = await db.query.departments.findFirst({
        where: and(
          eq(schema.departments.id, parsed.data.departmentId),
          eq(schema.departments.orgId, tenant.orgId),
          eq(schema.departments.status, 'active'),
        ),
      });
      if (!dept) {
        res.status(400).json({ error: 'department_not_found' });
        return;
      }
    }

    await db
      .update(schema.assessmentTools)
      .set({ departmentId: parsed.data.departmentId })
      .where(eq(schema.assessmentTools.id, tool.id));

    await recordAudit(db, tenant, {
      action: parsed.data.departmentId ? 'Classified assessment tool' : 'Unclassified assessment tool',
      target: tool.name,
      category: 'settings',
      icon: 'clipboard-check',
    });

    res.json({ id: tool.id, departmentId: parsed.data.departmentId });
  }),
);

// ── cases ───────────────────────────────────────────────────────────────────

/**
 * Resolve Location ids to their current names — for the assessor warning, for
 * display, and for the answer the assessment document reads for its own stream
 * question (R78). Read live so a rename reaches everywhere at once (R136).
 */
async function locationNamesByIdFor(
  database: NonNullable<typeof db>,
  orgId: string,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const rows = await database.query.locations.findMany({
    where: and(eq(schema.locations.orgId, orgId), inArray(schema.locations.id, unique)),
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

const createCaseBody = z.object({
  toolId: z.string().uuid(),
  candidateUserId: z.string().uuid(),
  assessorUserId: z.string().uuid().optional(),
  pathway: z.enum(ASSESSMENT_PATHWAYS),
  // A managed Location id chosen from the organisation's list, never typed (R77).
  locationId: z.string().uuid().optional(),
  rplJustification: z.string().min(1).optional(),
});

assessmentCasesRouter.post(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'create'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = createCaseBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { toolId, candidateUserId, pathway, locationId, rplJustification } = parsed.data;
    /*
      A manual create that NAMES an assessor keeps them; one that names none
      leaves the case UNOWNED, in the shared queue (U13, R61) — it no longer
      substitutes the creator. R61 is about not silently owning a case nobody
      chose to own; naming an assessor is still a real choice and is honoured.
      This matches the automatic path, which already creates unowned cases.
    */
    const assessorUserId = parsed.data.assessorUserId ?? null;

    // RPL waives the logged-hours parts, so the reason it was granted is the
    // only record of WHY they were skipped. Without it the case looks
    // indistinguishable from an experienced one.
    if (pathway === 'rpl' && !rplJustification) {
      res.status(400).json({ error: 'rpl_justification_required' });
      return;
    }

    const tool = await loadTool(db, toolId, tenant.orgId);
    if (!tool) {
      res.status(404).json({ error: 'tool_not_found' });
      return;
    }

    // A Location, if given, must be one of the organisation's active values
    // (R16, R77). A value chosen from a list cannot be a near-miss.
    if (locationId) {
      const loc = await db.query.locations.findFirst({
        where: and(
          eq(schema.locations.id, locationId),
          eq(schema.locations.orgId, tenant.orgId),
          eq(schema.locations.status, 'active'),
        ),
      });
      if (!loc) {
        res.status(400).json({ error: 'location_not_found' });
        return;
      }
    }

    const template = await db.query.formTemplates.findFirst({
      where: eq(schema.formTemplates.id, tool.templateId),
    });
    if (!template?.currentVersionId) {
      res.status(409).json({ error: 'template_not_published' });
      return;
    }

    /*
      The candidate must be a member of this org. `candidateUserId` was only
      validated as a UUID, so any org could open a case against any user id in
      the system and accumulate a competency record against a stranger — while
      consuming one of its own candidate seats doing it. Same check, and the
      same reason, as the competency grant in competencies.ts.
    */
    const candidateMembership = await db.query.memberships.findFirst({
      where: and(
        eq(schema.memberships.userId, candidateUserId),
        eq(schema.memberships.orgId, tenant.orgId),
      ),
    });
    if (!candidateMembership) {
      res.status(404).json({ error: 'candidate_not_in_org' });
      return;
    }

    /*
      WHO MAY ASSESS THIS DEPENDS ON WHERE IT HAPPENS. Q50071833 authorises mine
      assessments and Q50073293 authorises raw materials, so the requirement is
      resolved against this case's stream rather than read as a flat list.
    */
    const assessorNeeds = resolveAssessorRequirements(
      { always: tool.assessorCompetencyIds, byStream: tool.assessorStreamCompetencyIds },
      locationId,
    );

    const [candidateGaps, assessorGaps, ruleLocationNames] = await Promise.all([
      unmetPrerequisites(db, tenant.orgId, candidateUserId, tool.candidatePrerequisiteIds),
      unmetPrerequisites(db, tenant.orgId, assessorUserId, assessorNeeds.required),
      locationNamesByIdFor(db, tenant.orgId, assessorNeeds.knownLocationIds),
    ]);
    // A partial check reported as a complete one is worse than saying so. The
    // warning names the Locations the tool has a rule for, so an admin can set
    // one — the ids the rule is keyed by are not human-readable.
    const streamWarning = streamCheckWarning(
      assessorNeeds,
      assessorNeeds.knownLocationIds.map((id) => ruleLocationNames.get(id) ?? id),
    );
    const warnings = [
      ...candidateGaps.map((gap) => describeGap('candidate', gap)),
      ...assessorGaps.map((gap) => describeGap('assessor', gap)),
      ...(streamWarning ? [streamWarning] : []),
    ];

    const [row] = await db
      .insert(schema.assessmentCases)
      .values({
        orgId: tenant.orgId,
        toolId,
        candidateUserId,
        assessorUserId,
        pathway,
        locationId: locationId ?? null,
        currentVersionId: template.currentVersionId,
        rplJustification: rplJustification ?? null,
        prerequisiteWarnings: warnings,
      })
      .returning();
    if (!row) throw new Error('case_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Opened assessment case',
      target: `${tool.name} → ${candidateUserId}`,
      category: 'submissions',
      icon: 'clipboard-check',
    });

    res.status(201).json({
      id: row.id,
      pathway: row.pathway,
      state: row.state,
      prerequisiteWarnings: warnings,
      parts: requiredParts(tool.manifest, pathway).map((p) => p.key),
    });
  }),
);

/**
 * Cases the caller may see.
 *
 * An `own` scope filters SERVER-SIDE by candidate. Filtering in the client
 * would ship every case in the org to a candidate's browser and rely on the UI
 * to hide them, which is not access control.
 */
assessmentCasesRouter.get(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const scope = await permissionScope(tenant, 'assessments', 'view');
    if (scope === 'none') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const rows = await db.query.assessmentCases.findMany({
      where:
        scope === 'own'
          ? and(
              eq(schema.assessmentCases.orgId, tenant.orgId),
              eq(schema.assessmentCases.candidateUserId, tenant.userId),
            )
          : eq(schema.assessmentCases.orgId, tenant.orgId),
      orderBy: (c) => [desc(c.createdAt)],
    });

    const toolIds = [...new Set(rows.map((r) => r.toolId))];
    const tools = toolIds.length
      ? await db.query.assessmentTools.findMany({
          where: inArray(schema.assessmentTools.id, toolIds),
        })
      : [];
    const toolById = new Map(tools.map((t) => [t.id, t]));

    const candidateIds = [...new Set(rows.map((r) => r.candidateUserId))];
    const candidates = candidateIds.length
      ? await db.query.users.findMany({ where: inArray(schema.users.id, candidateIds) })
      : [];
    const nameById = new Map(candidates.map((u) => [u.id, u.name]));
    const caseIdentities = await loadDisplayIdentities(db, tenant.orgId, candidateIds);

    res.json(
      rows.map((c) => ({
        id: c.id,
        toolName: toolById.get(c.toolId)?.name ?? '',
        candidateUserId: c.candidateUserId,
        candidateName: identifyMember(caseIdentities, c.candidateUserId, nameById.get(c.candidateUserId) ?? '').name,
        pathway: c.pathway,
        state: c.state,
        /** Null on a pooled case — the table shows it as unassigned (U13). */
        assessorUserId: c.assessorUserId,
        createdAt: c.createdAt,
      })),
    );
  }),
);

/**
 * Hours logged against one logbook part, from its attempt rows.
 *
 * Read from the HIGHEST-NUMBERED attempt rather than summed across all of them.
 * A retried logbook re-enters its entries on the new attempt, so summing would
 * count the same weeks twice and report more experience than the candidate has
 * — the one error direction that matters when the figure is measured against a
 * safety threshold. It is also the attempt the threshold notification fired on
 * and the one the evidence document renders, so the dashboard agrees with both.
 *
 * Every array in the attempt's values is totalled rather than the one table the
 * manifest names, because naming it needs the pinned version's field list — a
 * read per attempt version that this endpoint otherwise never makes. A part's
 * values hold only that part's fields and only its logbook table carries the
 * duration column, so the wider sum reaches the same number.
 */
function loggedHoursFor(
  part: AssessmentPart,
  attempts: readonly {
    attemptNumber: number;
    values: Record<string, SubmissionValue>;
    templateVersionId: string;
  }[],
  fieldsByVersion: ReadonlyMap<string, FormField[]>,
): number | null {
  if (part.kind !== 'logbook' || !part.durationColumnKey) return null;
  // Picked by attempt number rather than by position, so the answer does not
  // depend on the order the caller happened to hand them over in. The latest
  // attempt is authoritative because a logbook retry CARRIES its rows forward,
  // so the newest row already holds every hour logged.
  const latest = attempts.reduce<(typeof attempts)[number] | undefined>(
    (best, a) => (!best || a.attemptNumber > best.attemptNumber ? a : best),
    undefined,
  );
  if (!latest) return 0;

  // The same rule the threshold notification and the retry carry-forward use.
  // Three copies of "which rows are the logbook" disagreed; this is the one.
  const rows = logbookRows(fieldsByVersion.get(latest.templateVersionId) ?? [], part, latest.values);
  return totalLoggedHours(rows, part.durationColumnKey);
}

/**
 * Where every candidate stands, without opening a single case (R21).
 *
 * DERIVED ON EVERY READ, like the rest of this router. Part state, the current
 * part and the logged hours all come from the attempt rows. A stored progress
 * summary would be a second source of truth that goes stale the moment an
 * attempt is marked by a path that forgot to update it — and this is the screen
 * a supervisor trusts to tell them who is waiting.
 *
 * REGISTERED BEFORE `/:id`. Express matches in declaration order, so with the
 * id route first the whole dashboard would resolve as "the case whose id is
 * progress" and answer 404.
 */
assessmentCasesRouter.get(
  '/progress',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const scope = await permissionScope(tenant, 'assessments', 'view');
    if (scope === 'none') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    // Same server-side scope filter as the case list. A candidate reaching the
    // dashboard sees their own rows; filtering after the fact would mean the
    // aggregate had been computed over everyone's attempts and then trimmed.
    const cases = await db.query.assessmentCases.findMany({
      where:
        scope === 'own'
          ? and(
              eq(schema.assessmentCases.orgId, tenant.orgId),
              eq(schema.assessmentCases.candidateUserId, tenant.userId),
            )
          : eq(schema.assessmentCases.orgId, tenant.orgId),
      orderBy: (c) => [desc(c.createdAt)],
    });
    if (cases.length === 0) {
      res.json([]);
      return;
    }

    const toolIds = [...new Set(cases.map((c) => c.toolId))];
    const tools = await db.query.assessmentTools.findMany({
      where: inArray(schema.assessmentTools.id, toolIds),
    });
    const toolById = new Map(tools.map((t) => [t.id, t]));

    // Candidates by name, because a dashboard listing user ids is unreadable to
    // the supervisor who has to act on it.
    const candidateIds = [...new Set(cases.map((c) => c.candidateUserId))];
    const candidates = await db.query.users.findMany({
      where: inArray(schema.users.id, candidateIds),
    });
    const nameById = new Map(candidates.map((u) => [u.id, u.name]));
    /*
      R61: the identifier beside the name is read LIVE from the profile on every
      render and is never captured onto the case. That is the deliberate
      difference from the printed name a signed attempt keeps (R60) — a wrongly
      typed employee number, once corrected, corrects itself on every case it
      appears on rather than needing them rewritten.
    */
    const caseIdentities = await loadDisplayIdentities(db, tenant.orgId, candidateIds);

    // Every attempt in the org in ONE query, grouped by case in code. A query
    // per case is the N+1 this endpoint exists to replace: a site with three
    // hundred candidates would issue three hundred round trips to draw one
    // table. Rows for a case outside `visible` are DROPPED rather than grouped,
    // so an `own` caller cannot be shown another candidate's attempts even
    // though the org-scoped read touched them.
    const visible = new Set(cases.map((c) => c.id));
    const attemptRows = await db.query.assessmentPartAttempts.findMany({
      where: eq(schema.assessmentPartAttempts.orgId, tenant.orgId),
      orderBy: (a, { asc }) => [asc(a.partKey), asc(a.attemptNumber)],
    });
    const byCase = new Map<string, typeof attemptRows>();
    for (const row of attemptRows) {
      if (!visible.has(row.caseId)) continue;
      const bucket = byCase.get(row.caseId);
      if (bucket) bucket.push(row);
      else byCase.set(row.caseId, [row]);
    }

    /*
      The fields of every version the visible attempts are pinned to, loaded ONCE
      for the whole page.

      Needed because hours come from the part's DECLARED table, and finding that
      table means reading the version an attempt was taken against. Counting
      every array on the attempt instead — which this endpoint used to do — made
      it disagree with the threshold notification about the same candidate, with
      no retry involved. See `logbookRows`.

      Deduplicated by version rather than fetched per attempt: a cohort shares a
      handful of versions, and a read per attempt is the N+1 this endpoint exists
      to replace.
    */
    const versionIds = [
      ...new Set([...byCase.values()].flat().map((a) => a.templateVersionId)),
    ];
    const versions = versionIds.length
      ? await db.query.formTemplateVersions.findMany({
          where: inArray(schema.formTemplateVersions.id, versionIds),
        })
      : [];
    const fieldsByVersion = new Map<string, FormField[]>(
      versions.map((v) => [v.id, (v.fields ?? []) as FormField[]]),
    );

    res.json(
      cases.map((c) => {
        const tool = toolById.get(c.toolId);
        const attempts = byCase.get(c.id) ?? [];
        // A tool row cannot actually vanish — the case's FK is `restrict` — but
        // if one ever did, the candidate stays on the dashboard with no parts
        // rather than disappearing from it or failing the whole request.
        const progress = tool
          ? caseProgress(tool.manifest, c.pathway as AssessmentPathway, toAttemptFacts(attempts))
          : [];

        // The first required part that has not passed, in document order. Null
        // once every part has, which is what makes a competent case legible at a
        // glance beside a closed one: closed still names the part it stopped at.
        const current = progress.find((p) => p.state !== 'satisfactory');

        return {
          id: c.id,
          toolName: tool?.name ?? '',
          candidateUserId: c.candidateUserId,
          candidateName: identifyMember(caseIdentities, c.candidateUserId, nameById.get(c.candidateUserId) ?? '').name,
          /** Read live from the profile, never captured onto the case (R61). */
          candidateIdentifier: identifyMember(caseIdentities, c.candidateUserId, '').identifier,
          pathway: c.pathway,
          state: c.state,
          currentPartKey: current?.part.key ?? null,
          currentPartLabel: current?.part.label ?? null,
          parts: progress.map((p) => ({
            key: p.part.key,
            label: p.part.label,
            kind: p.part.kind,
            ordinal: p.part.ordinal,
            state: p.state,
            latestOutcome: p.latestOutcome,
            attempts: p.attempts,
            minimumHours: p.part.minimumHours ?? null,
            /** Null for anything but a logbook — there is no threshold to meet. */
            loggedHours: loggedHoursFor(
              p.part,
              attempts.filter((a) => a.partKey === p.part.key),
              fieldsByVersion,
            ),
          })),
          createdAt: c.createdAt,
        };
      }),
    );
  }),
);

/**
 * The shared pool (U13, R62–R64): OPEN cases nobody owns, at Locations the
 * reading assessor is eligible to assess. Eligibility is the tool's assessor
 * requirement for the case's Location, read through the same resolver creation
 * and sign-off use — not a new rule. Working a case never claims it, so it stays
 * here for every eligible assessor until it is signed off.
 *
 * Declared before `/:id` so `queue` is not read as a case id — the same reason
 * `/progress` is declared above.
 */
assessmentCasesRouter.get(
  '/queue',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    // The pool is an assessor surface. A candidate's own-scope edit resolves
    // false, so their own cases never leak into it.
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const [pooled, org, held] = await Promise.all([
      db.query.assessmentCases.findMany({
        where: and(
          eq(schema.assessmentCases.orgId, tenant.orgId),
          eq(schema.assessmentCases.state, 'open'),
          isNull(schema.assessmentCases.assessorUserId),
        ),
        orderBy: (c) => [desc(c.createdAt)],
      }),
      db.query.organizations.findFirst({ where: eq(schema.organizations.id, tenant.orgId) }),
      heldCompetencyStates(db, tenant.orgId, tenant.userId, new Date()),
    ]);
    const heldNow = new Set(held.filter((h) => countsAsHeld(h)).map((h) => h.competencyId));
    const overdueDays = org?.pooledCaseOverdueDays ?? 14;

    const toolIds = [...new Set(pooled.map((c) => c.toolId))];
    const tools = toolIds.length
      ? await db.query.assessmentTools.findMany({ where: inArray(schema.assessmentTools.id, toolIds) })
      : [];
    const toolById = new Map(tools.map((t) => [t.id, t]));
    const locationIds = [
      ...new Set(pooled.map((c) => c.locationId).filter((id): id is string => Boolean(id))),
    ];
    const locationNames = await locationNamesByIdFor(db, tenant.orgId, locationIds);

    const candidateIds = [...new Set(pooled.map((c) => c.candidateUserId))];
    const candidates = candidateIds.length
      ? await db.query.users.findMany({ where: inArray(schema.users.id, candidateIds) })
      : [];
    const nameById = new Map(candidates.map((u) => [u.id, u.name]));
    const queueIdentities = await loadDisplayIdentities(db, tenant.orgId, candidateIds);

    const now = Date.now();
    const items = pooled.flatMap((c) => {
      const tool = toolById.get(c.toolId);
      if (!tool) return [];
      const needs = resolveAssessorRequirements(
        { always: tool.assessorCompetencyIds, byStream: tool.assessorStreamCompetencyIds },
        c.locationId,
      );
      // Eligible iff the reader holds every competency the tool needs at this
      // case's Location, current — the create/sign-off rule, read here (R64).
      if (!needs.required.every((id) => heldNow.has(id))) return [];

      // Overdue is DERIVED from age and the org threshold — nothing is stamped on
      // the case, so a change to the threshold re-dates every pooled case (R63).
      const ageDays = Math.floor((now - c.createdAt.getTime()) / 86_400_000);
      return [
        {
          id: c.id,
          toolName: tool.name,
          candidateUserId: c.candidateUserId,
          candidateName: identifyMember(queueIdentities, c.candidateUserId, nameById.get(c.candidateUserId) ?? '').name,
          pathway: c.pathway,
          locationId: c.locationId,
          locationName: c.locationId ? (locationNames.get(c.locationId) ?? null) : null,
          createdAt: c.createdAt,
          ageDays,
          overdue: ageDays >= overdueDays,
        },
      ];
    });
    res.json(items);
  }),
);

assessmentCasesRouter.get(
  '/:id',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const scope = await permissionScope(tenant, 'assessments', 'view');
    if (scope === 'none') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const row = await loadCase(db, req.params.id!, tenant.orgId);
    // A candidate asking for someone else's case gets 404, not 403: 403 would
    // confirm the case exists, which is itself a disclosure.
    if (!row || (scope === 'own' && row.candidateUserId !== tenant.userId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }

    const attempts = await attemptsFor(db, row.id);
    const progress = caseProgress(tool.manifest, row.pathway as AssessmentPathway, toAttemptFacts(attempts));

    // Appeals AGAINST this case — the superseding record must be visible from
    // the superseded one, or a reviewer reading the original would take a
    // disputed outcome at face value. The extra in-code filter is a no-op on a
    // real database and keeps the predicate exact.
    const appeals = (
      await db.query.assessmentCases.findMany({
        where: and(
          eq(schema.assessmentCases.orgId, tenant.orgId),
          eq(schema.assessmentCases.appealOfCaseId, row.id),
        ),
      })
    ).filter((c) => c.appealOfCaseId === row.id);

    // Resolved for display and for the exported document's filename. An
    // evidence PDF gets emailed and filed, so a UUID in its name makes it a
    // document nobody can identify later.
    const candidate = await db.query.users.findFirst({
      where: eq(schema.users.id, row.candidateUserId),
    });
    // R61: live, never captured. See the list route above for why.
    const detailIdentity = identifyMember(
      await loadDisplayIdentities(db, tenant.orgId, [row.candidateUserId]),
      row.candidateUserId,
      candidate?.name ?? '',
    );
    const locationName = row.locationId
      ? ((await locationNamesByIdFor(db, tenant.orgId, [row.locationId])).get(row.locationId) ?? null)
      : null;

    const caseFields = await fieldsForVersion(db, row.currentVersionId);

    res.json({
      id: row.id,
      toolId: tool.id,
      toolName: tool.name,
      appeals: appeals.map((c) => ({ id: c.id, state: c.state, createdAt: c.createdAt })),
      candidateUserId: row.candidateUserId,
      candidateName: detailIdentity.name,
      /** Read live from the profile, never captured onto the case (R61). */
      candidateIdentifier: detailIdentity.identifier,
      assessorUserId: row.assessorUserId,
      pathway: row.pathway,
      locationId: row.locationId,
      locationName,
      state: row.state,
      currentVersionId: row.currentVersionId,
      prerequisiteWarnings: row.prerequisiteWarnings,
      appealOfCaseId: row.appealOfCaseId,
      parts: progress.map((p) => ({
        key: p.part.key,
        label: p.part.label,
        kind: p.part.kind,
        ordinal: p.part.ordinal,
        minimumHours: p.part.minimumHours ?? null,
        state: p.state,
        attempts: p.attempts,
        latestOutcome: p.latestOutcome,
        selfMarking: isSelfMarking(caseFields, tool.manifest, p.part.key),
      })),
      attempts: attempts.map((a) => ({
        id: a.id,
        partKey: a.partKey,
        attemptNumber: a.attemptNumber,
        outcome: a.outcome,
        /** Null until the candidate hands it in — the "ready to mark" signal. */
        submittedAt: a.submittedAt,
        disposition: a.disposition,
        dispositionReason: a.dispositionReason,
        templateVersionId: a.templateVersionId,
        signedAt: a.signedAt,
        /** Who marked it (U15) — null until it is marked; 'automatic' names nobody. */
        markerKind: a.markerKind,
        /** Any assessor-eligibility shortfall recorded when a person marked it (U14). */
        markingEligibilityWarnings: a.markingEligibilityWarnings,
      })),
    });
  }),
);

const pathwayBody = z.object({
  pathway: z.enum(ASSESSMENT_PATHWAYS),
  reason: z.string().min(1),
  rplJustification: z.string().min(1).optional(),
});

/**
 * Change a case's pathway mid-flight.
 *
 * Completed attempts are left alone — moving an experienced candidate onto the
 * longer pathway must not discard the theory they already passed.
 */
assessmentCasesRouter.patch(
  '/:id/pathway',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = pathwayBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (parsed.data.pathway === 'rpl' && !parsed.data.rplJustification) {
      res.status(400).json({ error: 'rpl_justification_required' });
      return;
    }

    await db
      .update(schema.assessmentCases)
      .set({
        pathway: parsed.data.pathway,
        ...(parsed.data.rplJustification ? { rplJustification: parsed.data.rplJustification } : {}),
      })
      .where(eq(schema.assessmentCases.id, row.id));

    await recordAudit(db, tenant, {
      action: 'Changed assessment pathway',
      target: `${row.id}: ${row.pathway} → ${parsed.data.pathway} (${parsed.data.reason})`,
      category: 'submissions',
      icon: 'route',
    });

    const tool = await loadTool(db, row.toolId, tenant.orgId);
    res.json({
      id: row.id,
      pathway: parsed.data.pathway,
      parts: tool ? requiredParts(tool.manifest, parsed.data.pathway).map((p) => p.key) : [],
    });
  }),
);

// ── attempts ────────────────────────────────────────────────────────────────

/**
 * Open an attempt at a part.
 *
 * Refuses a locked part — the sequence exists so a final demonstration cannot
 * happen before the hours it depends on are logged. A part that already passed
 * is also refused: re-opening it would put a second satisfactory attempt on the
 * record with nothing to say which is authoritative.
 */
assessmentCasesRouter.post(
  '/:id/parts/:partKey/attempts',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }

    const partKey = req.params.partKey!;
    const attempts = await attemptsFor(db, row.id);
    const progress = caseProgress(tool.manifest, row.pathway as AssessmentPathway, toAttemptFacts(attempts));
    const target = progress.find((p) => p.part.key === partKey);

    if (!target) {
      res.status(400).json({ error: 'part_not_in_pathway' });
      return;
    }
    if (target.state === 'locked') {
      res.status(409).json({ error: 'part_locked' });
      return;
    }
    if (target.state === 'satisfactory') {
      res.status(409).json({ error: 'part_already_satisfied' });
      return;
    }

    const mine = attempts.filter((a) => a.partKey === partKey);
    const open = mine.find((a) => a.outcome === null);
    if (open) {
      res.status(200).json({ id: open.id, attemptNumber: open.attemptNumber, reused: true });
      return;
    }

    /*
      A LOGBOOK CARRIES ITS HOURS FORWARD. Every other kind of part starts a
      retry empty.

      A logbook is not really failed. The practice is that a candidate keeps
      logging and simply does not progress until an assessor judges them
      competent to — so `not_satisfactory` here means "not yet", and the hours
      already logged still count toward the minimum. Starting the new attempt
      empty told a candidate with 47 of 50 hours that they had none: a blank
      table asking for 50, zero on every surface, and nothing anywhere saying
      their recorded experience had just gone backwards.

      Copied at WRITE time rather than summed at read time. The exported evidence
      prints exactly ONE attempt per part (`authoritativeAttempt` in
      pdf/case-export.ts), so a summed figure would sit on the dashboard beside a
      printed logbook page totalling less, with nothing on the page to explain
      the difference. One authoritative attempt keeps the dashboard, the
      threshold and the PDF telling the same story.

      A practical retry is deliberately NOT carried: it is a fresh
      demonstration, and pre-filling it would show an assessor marks they never
      made.
    */
    const carried = await carryForwardLogbook(db, {
      part: target.part,
      previous: mine,
      toVersionId: row.currentVersionId,
    });

    const [created] = await db
      .insert(schema.assessmentPartAttempts)
      .values({
        orgId: tenant.orgId,
        caseId: row.id,
        partKey,
        attemptNumber: mine.length + 1,
        templateVersionId: row.currentVersionId,
        ...carried,
      })
      .returning();
    if (!created) throw new Error('attempt_create_failed: insert returned no row');

    res.status(201).json({ id: created.id, attemptNumber: created.attemptNumber, reused: false });
  }),
);

/**
 * The fillable surface for one attempt — what the candidate portal renders.
 *
 * MARKING SECRETS ARE STRIPPED AT THE DOOR. These fields carry the complete
 * answer key to the assessment the candidate is about to sit, and this route
 * serves them to that candidate. Nothing downstream is trusted to hide them:
 * they do not leave the process.
 *
 * Fields come from the version the ATTEMPT is pinned to, not the case's current
 * one. A candidate resuming an attempt started against an older version must
 * see the questions they were asked, not the ones the template has since grown.
 */
assessmentCasesRouter.get(
  '/:id/attempts/:attemptId',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const scope = await permissionScope(tenant, 'assessments', 'view');
    if (scope === 'none') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const row = await loadCase(db, req.params.id!, tenant.orgId);
    // Same rule as case detail: a candidate asking for someone else's work gets
    // 404, because 403 would confirm it exists.
    if (!row || (scope === 'own' && row.candidateUserId !== tenant.userId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const attempt = (await attemptsFor(db, row.id)).find((a) => a.id === req.params.attemptId);
    // An attempt id from another case is a miss, not a cross-case read.
    if (!attempt) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }

    const manifest = tool.manifest as AssessmentToolManifest;
    const part = orderedParts(manifest).find((p) => p.key === attempt.partKey);
    if (!part) {
      res.status(409).json({ error: 'part_missing_from_manifest' });
      return;
    }

    const allFields = await fieldsForVersion(db, attempt.templateVersionId);

    /*
      WHICH PARTY IS ASKING. The candidate on the case is the candidate;
      anybody else with access to it is acting as the assessor. Derived from the
      case rather than from the org role, because "assessor" here means "the
      person on the other side of this assessment", and an admin opening a case
      to fill in for an assessor is doing exactly that.

      A supervisor is not yet distinguishable — nothing on the case names one —
      so a workflow that assigns them work resolves to no writable fields rather
      than to somebody else's. That is the safe direction: a section nobody can
      currently fill is visible as stuck, where guessing would let the wrong
      person sign a logbook.
    */
    const party: WorkflowRole = row.candidateUserId === tenant.userId ? 'candidate' : 'assessor';
    // The FIELDS matter here: a question's ✓/✗ cell is declared on the question,
    // not in the manifest, so `workflowOf` cannot mark it `auto` without them —
    // and an unmarked cell is one the candidate can press.
    /*
      Resolved PER FIELD, not per slice. An authored cover-section
      ("Prerequisites", "More Coaching Required") lists its fields directly
      while printing INSIDE another part's contiguous slice — coverage-aware
      resolution is what makes that section govern its own fields instead of
      being display furniture.
    */
    const workflow = workflowOf(manifest, allFields);
    const partFields = fieldsInPart(allFields, manifest, attempt.partKey);
    const access = partFieldAccess(workflow, attempt.partKey, partFields, party);
    const hidden = new Set(access.hidden);
    const visibleFields = partFields.filter((f) => !hidden.has(f.id));

    // The document's own stream question is answered with the Location's NAME
    // (R78), resolved live from the case's pointer.
    const locationName = row.locationId
      ? ((await locationNamesByIdFor(db, tenant.orgId, [row.locationId])).get(row.locationId) ?? null)
      : null;

    /*
      IDENTITY FILLS ITSELF (manifest.profilePrefill). Computed on read rather
      than stored on the attempt, so a corrected profile shows corrected on the
      next open instead of freezing a typo into the record — and no migration
      backfills anything.

      Resolved only when a mapped field is actually in this part's slice; most
      attempts (every theory part) carry none and skip the three reads.
    */
    const prefillMap = manifest.profilePrefill ?? {};
    const mappedHere = visibleFields.some((f) => prefillMap[f.id]);
    const prefill = mappedHere
      ? profilePrefillValues(
          manifest,
          await resolveProfilePrefillSource(db, tenant.orgId, row.candidateUserId),
        )
      : {};

    /*
      PREREQUISITES ANSWER THEMSELVES (manifest.prerequisiteChecks). The box's
      ✓/✗ is the register's answer at now, served like any other value and
      locked below — non-blocking here by design: an unsatisfied prerequisite
      must not stop a candidate sitting theory. The sign-off route is the gate.
    */
    const prereqIds = new Set((manifest.prerequisiteChecks ?? []).map((c) => c.fieldId));
    const prereqHere = visibleFields.some((f) => prereqIds.has(f.id));
    const prereqValues: Record<string, boolean> = {};
    if (prereqHere) {
      for (const result of await evaluatePrerequisites(db, tenant.orgId, row.candidateUserId, manifest)) {
        if (visibleFields.some((f) => f.id === result.fieldId)) {
          prereqValues[result.fieldId] = result.satisfied;
        }
      }
    }

    res.json({
      id: attempt.id,
      partKey: attempt.partKey,
      partLabel: part.label,
      partKind: part.kind,
      /*
        How this part's theory questions should be presented (U21).

        Read off the tool's manifest rather than decided by the renderer,
        because the choice was made once by the author in the builder and has to
        survive to every candidate who opens the assessment. Absent means
        `stacked`, which is what every theory part rendered as before.
      */
      // Resolved, never raw: a manifest naming nothing means the default,
      // and `?? null` here spelled that as "stacked" on the fill surface.
      theoryRendering: theoryRenderingOf(manifest),
      attemptNumber: attempt.attemptNumber,
      outcome: attempt.outcome,
      submittedAt: attempt.submittedAt,
      templateVersionId: attempt.templateVersionId,
      /**
       * The case's stream and the field its answer belongs in, so the renderer
       * can seed visibility exactly the way the exporter does — by answering the
       * manifest's stream question, not by filtering fields itself.
       *
       * Either being null is fail-open: every location set renders rather than
       * none, because hiding content nobody chose to hide would silently shorten
       * the assessment.
       */
      locationStream: locationName,
      locationStreamFieldId: manifest.locationStreamFieldId ?? null,
      /**
       * The stream question itself, sent as a lookup source because it often
       * lives OUTSIDE this part — on the cover checklist, typically. Without it
       * the renderer sees a dangling condition, falls open, and every location
       * set shows: the gating would silently never apply.
       */
      streamField: manifest.locationStreamFieldId
        ? (allFields.find((f) => f.id === manifest.locationStreamFieldId) ?? null)
        : null,
      minimumHours: part.minimumHours ?? null,
      durationColumnKey: part.durationColumnKey ?? null,
      fields: stripMarkingSecrets(visibleFields).map((f) =>
        f.id === manifest.candidateSignatureFieldId && f.type === 'text'
          ? { ...f, type: 'signature' as const }
          : f,
      ),
      /*
        WHAT THIS CALLER MAY CHANGE, decided here rather than on the screen.

        The fill surface renders what it is given and disables what is not in
        this list; it does not work out scope itself, for the same reason the
        case screen does not work out part state. A second implementation of the
        rule deciding who may write a competency record is a rule that can
        disagree with itself.

        Hidden fields are REMOVED from `fields` above rather than listed here.
        Read-only and absent are different answers to different questions: a
        candidate sees the practical criteria they will be marked against — that
        is the standard being applied to them — and never sees the assessor's
        private comments.
      */
      /*
        Mapped ids are dropped even under an AUTHORED workflow that never marked
        them prefill — the mapping alone is the declaration, and a typed value
        over the candidate's identity must not depend on an author remembering
        to lock the box twice.
      */
      writableFieldIds: access.writable.filter(
        (id) => !hidden.has(id) && !prefillMap[id] && !prereqIds.has(id),
      ),
      /*
        Layering, least to most authoritative: tool DEFAULTS under everything —
        a default fills only where nothing exists, and the field stays
        writable — then the candidate's stored answers, then the derived
        prefill and prerequisite verdicts, which nothing may shadow.
      */
      values: {
        ...defaultsFor(manifest, visibleFields),
        ...(attempt.values ?? {}),
        ...prefill,
        ...prereqValues,
      },
    });
  }),
);

/**
 * Handing a part in, and taking it back.
 *
 * This is the signal that closes the tracking gap the paper process had: an
 * attempt with answers and no outcome cannot distinguish a candidate halfway
 * through from one who finished a week ago and is waiting. Submitting says
 * which.
 *
 * It is the CANDIDATE'S act — `edit` at `own` scope reaches it — and it is not
 * an outcome. Until an assessor marks the attempt nothing has been judged, so
 * the candidate can reopen it themselves rather than needing anyone's help to
 * undo a mis-tap. Marking is what makes an attempt permanent.
 */
async function setSubmitted(
  req: Parameters<Parameters<typeof withErrorHandling>[0]>[0],
  res: Parameters<Parameters<typeof withErrorHandling>[0]>[1],
  submitting: boolean,
) {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  const scope = await permissionScope(tenant, 'assessments', 'edit');
  if (scope === 'none') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const row = await loadCase(db, req.params.id!, tenant.orgId);
  // Same rule as everywhere else: someone else's work is 404, not 403.
  if (!row || (scope === 'own' && row.candidateUserId !== tenant.userId)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const attempt = await db.query.assessmentPartAttempts.findFirst({
    where: and(
      eq(schema.assessmentPartAttempts.id, req.params.attemptId!),
      eq(schema.assessmentPartAttempts.caseId, row.id),
    ),
  });
  if (!attempt) {
    res.status(404).json({ error: 'attempt_not_found' });
    return;
  }
  // Once marked, an attempt is evidence in both directions: handing it in again
  // is meaningless, and reopening it would let a candidate rewrite what an
  // assessor already judged.
  if (attempt.outcome !== null) {
    res.status(409).json({ error: 'attempt_resolved' });
    return;
  }

  // Idempotent. A double-tap must not restamp a later hand-in time than the
  // one the candidate actually made.
  if (submitting && attempt.submittedAt) {
    res.status(200).json({ id: attempt.id, submittedAt: attempt.submittedAt });
    return;
  }

  const submittedAt = submitting ? new Date() : null;
  await db
    .update(schema.assessmentPartAttempts)
    .set({ submittedAt })
    .where(eq(schema.assessmentPartAttempts.id, attempt.id));

  await recordAudit(db, tenant, {
    action: submitting ? 'Submitted assessment part' : 'Reopened assessment part',
    target: `${row.id} ${attempt.partKey} attempt ${attempt.attemptNumber}`,
    // 'submissions' to match the rest of this router — assessment activity is
    // filed there rather than under a category of its own.
    category: 'submissions',
    icon: submitting ? 'send' : 'undo-2',
  });

  res.status(200).json({ id: attempt.id, submittedAt });
}

assessmentCasesRouter.post(
  '/:id/attempts/:attemptId/submit',
  ...GATE,
  withErrorHandling((req, res) => setSubmitted(req, res, true)),
);

assessmentCasesRouter.post(
  '/:id/attempts/:attemptId/reopen',
  ...GATE,
  withErrorHandling((req, res) => setSubmitted(req, res, false)),
);

const saveValuesBody = z.object({ values: z.record(z.string(), z.unknown()) });

/**
 * Save answers onto an open attempt.
 *
 * For a logbook part this is also where hours accumulate: the total is
 * recomputed from the rows and, the first time it crosses the part's minimum,
 * the assessor is told. Notification is marked on the attempt so it fires once
 * — a candidate adding a sixth week of entries should not re-alert anyone.
 */
assessmentCasesRouter.patch(
  '/:id/attempts/:attemptId',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const scope = await permissionScope(tenant, 'assessments', 'edit');
    if (scope === 'none') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = saveValuesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row || (scope === 'own' && row.candidateUserId !== tenant.userId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const attempt = await db.query.assessmentPartAttempts.findFirst({
      where: and(
        eq(schema.assessmentPartAttempts.id, req.params.attemptId!),
        eq(schema.assessmentPartAttempts.caseId, row.id),
      ),
    });
    if (!attempt) {
      res.status(404).json({ error: 'attempt_not_found' });
      return;
    }
    // A resolved attempt is evidence. Editing it would rewrite what an assessor
    // signed; a correction is a new attempt.
    if (attempt.outcome !== null) {
      res.status(409).json({ error: 'attempt_resolved' });
      return;
    }
    // Handed in, not yet marked. Refusing here is what makes "submitted" mean
    // anything — otherwise the answers could keep moving while the assessor was
    // reading them. The candidate can reopen it themselves; nothing is lost.
    if (attempt.submittedAt) {
      res.status(409).json({ error: 'attempt_submitted' });
      return;
    }

    const tool = await loadTool(db, row.toolId, tenant.orgId);
    const part = tool ? orderedParts(tool.manifest).find((p) => p.key === attempt.partKey) : undefined;

    /*
      AN ATTEMPT MAY ONLY BE WRITTEN WITH ITS OWN PART'S FIELDS.

      This route asked who owned the CASE and never what part the attempt was
      for, so any field id in the body was accepted. A candidate could open
      their own theory attempt and post the practical's observation checklist —
      the criteria their assessor is meant to mark while watching them operate
      the machine — and it would be stored against the case and merged into the
      evidence PDF.

      Scoped to the attempt's PINNED version rather than the template's current
      one: the attempt records what was asked at the time, and a template edited
      mid-programme must not change what an open attempt is allowed to contain.

      Two shapes matter here. An unchanged echo of a foreign key is tolerated,
      because the fill screen seeds its state from the stored values and PATCHes
      the whole map back — rejecting outright would permanently 409 any attempt
      already holding a stray key, and real data does carry rows under keys the
      manifest never named. And the merge is onto the stored map rather than a
      replacement, so a key the client omits is no longer silently deleted —
      harmless while one party writes an attempt, silent data loss the moment
      workflow ownership lets two.
    */
    const stored = (attempt.values ?? {}) as Record<string, SubmissionValue>;
    /*
      AND ONLY WITH THE FIELDS THIS PARTY OWNS.

      Part scoping alone stopped a candidate writing ANOTHER part's checklist.
      It did not stop them writing THIS part's, which is the case the customer
      described: the candidate fills nothing in a practical, but the practical
      is one part and its fields are all in it.

      So the allowed set narrows from "this part's fields" to "the fields the
      workflow says this party may write". A tool with no workflow authored
      still resolves to the whole part, so nothing changes until somebody
      configures it — and `writableFieldIds` also drops `prefill` and `auto`
      fields, whose values come from the case record or from marking and must
      not be typed over.
    */
    const party: WorkflowRole = row.candidateUserId === tenant.userId ? 'candidate' : 'assessor';
    /*
      Read ONCE and passed to both, because `workflowOf` needs the fields too:
      a question's ✓/✗ cell is declared on the question rather than in the
      manifest, so without them the derived workflow cannot mark it `auto` and
      a candidate's typed outcome would be accepted here.
    */
    const versionFields = tool ? await fieldsForVersion(db, attempt.templateVersionId) : [];
    const allowed = tool
      ? new Set(
          partFieldAccess(
            workflowOf(tool.manifest, versionFields),
            attempt.partKey,
            fieldsInPart(versionFields, tool.manifest, attempt.partKey),
            party,
          ).writable,
        )
      : null;

    let values: Record<string, SubmissionValue> = { ...stored };
    if (allowed) {
      const foreign: string[] = [];
      for (const [key, value] of Object.entries(parsed.data.values)) {
        if (allowed.has(key)) {
          values[key] = value as SubmissionValue;
        } else if (JSON.stringify(value) !== JSON.stringify(stored[key])) {
          foreign.push(key);
        }
      }
      if (foreign.length > 0) {
        res.status(403).json({ error: 'field_not_in_part', fields: foreign });
        return;
      }
    } else {
      values = { ...stored, ...(parsed.data.values as Record<string, SubmissionValue>) };
    }

    let hours: number | null = null;
    let thresholdReached = false;
    if (part?.kind === 'logbook' && part.durationColumnKey) {
      // The duration column is recomputed SERVER-SIDE when it carries a calc.
      // Whatever the client sent for a derived cell is discarded: hours count
      // toward a safety threshold, so the meter arithmetic must not be
      // forgeable by editing a request body.
      const fields = await fieldsForVersion(db, attempt.templateVersionId);
      const table = fieldsInSection(fields, part.startFieldId).find(
        (f) => f.type === 'repeating_group',
      );

      const durationKey = part.durationColumnKey;
      values = Object.fromEntries(
        Object.entries(values).map(([k, v]) => {
          if (!Array.isArray(v) || (table && k !== table.id)) return [k, v];
          const rows = applyCalcs(table?.columns, v as RepeatingRowValue[]);
          return [k, rows];
        }),
      );

      // Shared with the progress dashboard and the retry carry-forward. The old
      // fallback here took the first array of ANY kind, which would have counted
      // a checkbox group's answers as logbook rows.
      const rows: RepeatingRowValue[] = logbookRows(fields, part, values);

      // A row whose duration is present but not a positive number is a
      // mis-entry (zero, negative, or meter readings that go backwards — a
      // calc writes '' for those). Refusing it keeps "hours that count" and
      // "rows on the record" the same set, so the exported logbook cannot
      // show entries the threshold quietly ignored.
      const bad = (rows ?? []).findIndex((r) => {
        const raw = r?.[durationKey];
        if (raw === undefined || raw === null) return false;
        const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
        return !(Number.isFinite(n) && n > 0);
      });
      if (bad >= 0) {
        res.status(400).json({
          error: 'invalid_logbook_row',
          row: bad,
          message: `Row ${bad + 1} has no positive ${durationKey} — check the start and finish readings.`,
        });
        return;
      }

      hours = totalLoggedHours(rows ?? [], durationKey);
      thresholdReached =
        part.minimumHours != null && hours >= part.minimumHours && attempt.thresholdNotifiedAt === null;
    }

    await db
      .update(schema.assessmentPartAttempts)
      .set({
        values,
        ...(thresholdReached ? { thresholdNotifiedAt: new Date() } : {}),
      })
      .where(eq(schema.assessmentPartAttempts.id, attempt.id));

    if (thresholdReached) {
      await recordAudit(db, tenant, {
        action: 'Logbook minimum reached',
        target: `${row.id} / ${attempt.partKey}: ${hours}h`,
        category: 'submissions',
        icon: 'clock',
      });
    }

    res.json({ id: attempt.id, hours, thresholdReached });
  }),
);

/**
 * Regenerate the case's evidence document.
 *
 * Takes a case id and NOTHING else, for the same reason the submission export
 * does: a filled assessment paper is read as proof of what was recorded, so
 * every input — which attempts count, which fields exist, which page they land
 * on — is resolved server-side from the stored case. There is deliberately no
 * "render these values" variant.
 *
 * Export is gated on `export`, not `view`: a candidate may read their own case
 * without being able to mint the document that certifies them.
 */
assessmentCasesRouter.post(
  '/:id/export',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'export'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }

    const version = await db.query.formTemplateVersions.findFirst({
      where: eq(schema.formTemplateVersions.id, row.currentVersionId),
    });
    if (!version?.sourcePdfAssetId) {
      res.status(422).json({ error: 'no_source_pdf' });
      return;
    }

    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const original = await client.download(tenant.orgId, version.sourcePdfAssetId);
    if (!original) {
      res.status(404).json({ error: 'asset_not_found' });
      return;
    }

    const attempts = await attemptsFor(db, row.id);
    /*
      Resolved here rather than read off a filled field, because the cover page
      belongs to NO part — `fieldsInPart` slices from part 1's anchor onward, so
      the identity boxes fall outside every part and the fill route never serves
      them. Nobody can type into them. Without this the exported document
      carries the assessor's name, the date and the verdict for nobody at all.

      Empty when the user row is gone; the box then prints blank rather than a
      placeholder, which is the same degradation every other pointer uses.
    */
    const candidate = await db.query.users.findFirst({
      where: eq(schema.users.id, row.candidateUserId),
    });
    // A settled case prints the Location NAME it was signed with (R138); an open
    // one resolves the current name live from its pointer (R78).
    const exportLocationName =
      row.signedOffLocationName ||
      (row.locationId
        ? ((await locationNamesByIdFor(db, tenant.orgId, [row.locationId])).get(row.locationId) ?? null)
        : null);

    try {
      const out = await exportCasePdf({
        originalPdf: original,
        fields: (version.fields ?? []) as FormField[],
        manifest: tool.manifest,
        pathway: row.pathway as AssessmentPathway,
        locationStream: exportLocationName,
        candidateName: candidate?.name ?? '',
        // The same resolver the fill surface uses, so the printed identity
        // block and the screen cannot name the same person differently.
        prefillValues: profilePrefillValues(
          tool.manifest,
          await resolveProfilePrefillSource(db, tenant.orgId, row.candidateUserId),
        ),
        // The register's answer at export time, drawn as the box's ✓/✗.
        prerequisiteValues: Object.fromEntries(
          (await evaluatePrerequisites(db, tenant.orgId, row.candidateUserId, tool.manifest)).map(
            (r) => [r.fieldId, r.satisfied],
          ),
        ),
        attempts: attempts.map((a) => ({
          partKey: a.partKey,
          attemptNumber: a.attemptNumber,
          outcome: a.outcome,
          values: a.values,
          // COLUMNS, not values. Dropping them here is why every printed
          // "assessor name" and date box exported blank.
          assessorName: a.assessorName,
          signedAt: a.signedAt,
        })),
        /*
          Null until the assessor signs, which gates the whole certification
          block. A mid-programme export prints the front page blank, exactly as
          it does today.
        */
        signOff: row.signedOffAt
          ? { at: row.signedOffAt, name: row.signedOffName, signature: row.signedOffSignature }
          : null,
        // Resolved = finished either way. The coaching pair is written on a
        // resolved case only; while it is open, neither box is ticked.
        resolved: isTerminalCaseState(row.state as AssessmentCaseState),
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.send(Buffer.from(out));
    } catch (err) {
      // A mismatched manifest is a 409 rather than a 500: the request is well
      // formed and the server is healthy — the tool's part structure no longer
      // matches the version it is being exported against, which is a data
      // problem an author can fix.
      if (err instanceof CaseExportError) {
        res.status(409).json({ error: err.message, problems: err.problems });
        return;
      }
      throw err;
    }
  }),
);

const appealBody = z.object({
  assessorUserId: z.string().uuid(),
  reason: z.string().min(1),
});

/**
 * Appeal a case's outcome: a NEW case, linked to the disputed one, run by a
 * different assessor. The later outcome supersedes for display while both
 * cases remain queryable — the appeal does not edit or hide the original,
 * because a disputed record that vanishes is exactly what an audit cannot
 * accept.
 *
 * Two constraints carry the integrity:
 *
 * - Only an administrator may initiate. The source document gives this
 *   authority to the Training Supervisor; at Business tier that is an admin,
 *   and the distinct role arrives with the Enterprise panel work.
 * - The initiator must not be the assessor whose decision is disputed
 *   (R30/AE8). Without this, an admin who is also an assessor could
 *   adjudicate a dispute about their own assessment.
 *
 * The panel-review arm is Enterprise-only and deliberately NOT modelled here —
 * no endpoint exists, so there is nothing to gate. It arrives with panel
 * membership and per-member verdicts as its own unit of work.
 */
assessmentCasesRouter.post(
  '/:id/appeal',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = appealBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const disputed = await loadCase(db, req.params.id!, tenant.orgId);
    if (!disputed) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    /*
      INDEPENDENCE ON A CASE NOBODY OWNS (U13). A pooled case names no assessor,
      so keying independence off `assessor_user_id` alone would let anyone
      initiate or hear the appeal on a case they actually marked. The independent
      set is whoever RECORDED A PART on the disputed case — every person marker on
      its attempts, plus the named owner if it has one, which keeps a
      conventionally-owned case behaving exactly as before. Automatic marks name
      nobody (U15), so they add no one, correctly.
    */
    const disputedAttempts = await attemptsFor(db, disputed.id);
    const recordedBy = new Set<string>(
      disputedAttempts.map((a) => a.assessorUserId).filter((x): x is string => Boolean(x)),
    );
    if (disputed.assessorUserId) recordedBy.add(disputed.assessorUserId);
    /*
      The person who SIGNED IT OFF is the assessor of record — the one whose
      decision the certificate carries — so they are not independent of it
      either. On a pooled case that self-marked every part no attempt names a
      person and the case never took an owner, so without this the signer could
      initiate and hear the appeal of their own certification; it also covers a
      case whose opener differs from its signer.
    */
    if (disputed.signedOffByUserId) recordedBy.add(disputed.signedOffByUserId);

    // Both sides of the conflict: the initiator must not be someone who marked
    // it, and the appeal must go to someone who did not — "an independent
    // Assessor" in the source document's words.
    if (recordedBy.has(tenant.userId)) {
      res.status(409).json({
        error: 'appeal_conflict',
        message: 'The assessor whose decision is disputed cannot initiate the appeal.',
      });
      return;
    }
    if (recordedBy.has(parsed.data.assessorUserId)) {
      res.status(409).json({
        error: 'appeal_assessor_not_independent',
        message: 'An appeal must be assessed by someone other than the disputed assessor.',
      });
      return;
    }

    const tool = await loadTool(db, disputed.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }
    const template = await db.query.formTemplates.findFirst({
      where: eq(schema.formTemplates.id, tool.templateId),
    });
    if (!template?.currentVersionId) {
      res.status(409).json({ error: 'template_not_published' });
      return;
    }

    const [appeal] = await db
      .insert(schema.assessmentCases)
      .values({
        orgId: tenant.orgId,
        toolId: disputed.toolId,
        candidateUserId: disputed.candidateUserId,
        assessorUserId: parsed.data.assessorUserId,
        pathway: disputed.pathway,
        locationId: disputed.locationId,
        currentVersionId: template.currentVersionId,
        appealOfCaseId: disputed.id,
        appealReason: parsed.data.reason,
        rplJustification: disputed.rplJustification,
      })
      .returning();
    if (!appeal) throw new Error('appeal_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Opened appeal',
      target: `${disputed.id} → ${appeal.id}: ${parsed.data.reason}`,
      category: 'submissions',
      icon: 'scale',
    });

    /*
      A DISPUTED RESULT STOPS CONFERRING ELIGIBILITY.

      The disputed case keeps `state = 'competent'` forever — an appeal creates a
      new case and never edits the original — so without this, a competency
      granted by a result now under appeal would go on satisfying prerequisites
      for as long as the appeal ran. Somebody could be gated INTO another
      assessment by a verdict that is being contested.

      Revoked, not deleted: the record that it was once held survives, and if
      the appeal is itself signed off satisfactory the grant helper's upsert
      clears the revocation and repoints the evidence at the appeal.
    */
    const revoked = await revokeGrantsFromCase(
      db,
      tenant,
      disputed.id,
      `superseded by appeal ${appeal.id}`,
    );

    res.status(201).json({
      id: appeal.id,
      appealOfCaseId: disputed.id,
      assessorUserId: parsed.data.assessorUserId,
      pathway: appeal.pathway,
      revokedGrants: revoked,
    });
  }),
);

const outcomeBody = z.object({
  outcome: z.enum(['satisfactory', 'not_satisfactory']).optional(),
  disposition: z.enum(NS_DISPOSITIONS).optional(),
  reason: z.string().min(1).optional(),
  assessorName: z.string().min(1).optional(),
  belowThresholdReason: z.string().min(1).optional(),
});

/**
 * Resolve an attempt.
 *
 * A theory attempt's outcome is COMPUTED from the answer key; every other
 * part's is JUDGED by the assessor. That split decides what a not-satisfactory
 * result has to supply: a judged one demands a disposition and a reason — the
 * "further action" the paper form asks for — while a computed one defaults to
 * "more coaching required" and records itself, because arithmetic on an answer
 * key is not a decision anyone has to justify.
 */
assessmentCasesRouter.post(
  '/:id/attempts/:attemptId/outcome',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = outcomeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const attempt = await db.query.assessmentPartAttempts.findFirst({
      where: and(
        eq(schema.assessmentPartAttempts.id, req.params.attemptId!),
        eq(schema.assessmentPartAttempts.caseId, row.id),
      ),
    });
    if (!attempt) {
      res.status(404).json({ error: 'attempt_not_found' });
      return;
    }
    if (attempt.outcome !== null) {
      res.status(409).json({ error: 'attempt_resolved' });
      return;
    }
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }
    const part = orderedParts(tool.manifest).find((p) => p.key === attempt.partKey);
    if (!part) {
      res.status(409).json({ error: 'part_missing_from_manifest' });
      return;
    }

    let outcome = parsed.data.outcome ?? null;
    let derivedValues = attempt.values;
    /**
     * Was this verdict COMPUTED from the answer key, or JUDGED by the assessor?
     * The distinction decides what the record has to demand below, and who is
     * recorded as having marked it.
     *
     * Decided by keyed-ness, not by `part.kind` (U15): a part marks itself only
     * when EVERY real question carries a key. A part with any unkeyed question —
     * a partly-keyed theory part, or a practical demonstration — is judged by a
     * person, which is what stops a part self-marking against the keys it happens
     * to hold and passing the rest unchecked.
     */
    const fields = await fieldsForVersion(db, attempt.templateVersionId);
    // `fieldsForVersion` is UNSTRIPPED — the gate must see answerKey/outcomeTarget.
    const computed = isSelfMarking(fields, tool.manifest, part.key);

    if (computed) {
      const marked = markTheory({ fields, values: attempt.values, part });
      outcome = marked.outcome;
      derivedValues = marked.derivedValues;
    } else if (!outcome) {
      res.status(400).json({ error: 'outcome_required' });
      return;
    }

    let disposition = parsed.data.disposition ?? null;
    const reason = parsed.data.reason ?? null;

    /*
      UNDER 100% IS "NOT YET", NOT A FAILURE.

      A theory verdict is arithmetic on the answer key — the assessor makes no
      judgement, so there is no judgement to justify, and demanding a written
      reason for one is demanding a reason for a sum. Practice is that the
      candidate is coached and sits it again; the hours and the attempt are
      retained either way.

      So a computed not-satisfactory defaults to "more coaching required" and
      records itself. It used to 400 for a missing disposition and reason the
      UI had no way to collect, which left `outcome` null — and an unresolved
      attempt is handed straight back by the open route as `reused: true`, so
      the part wedged permanently with no verb to clear it. A failed theory
      part was unrecordable.

      An assessor may still pass `not_yet_competent` explicitly, which closes
      the case. That is a deliberate act and stays available; it is only the
      DEFAULT that changed, from "refuse" to "coach and retry".

      A JUDGED outcome is unchanged: R18's disposition and reason still stand,
      because there the assessor really did decide something.
    */
    if (outcome === 'not_satisfactory') {
      if (computed) {
        disposition = disposition ?? 'coaching_then_retry';
      } else if (!(disposition && reason)) {
        res.status(400).json({ error: 'disposition_and_reason_required' });
        return;
      }
    }

    /*
      ELIGIBILITY WARNED AT MARKING (U14, R65). Only a PERSON's mark runs the
      check — an automatic mark has no marker whose eligibility is at stake. The
      subject is the person recording THIS attempt, not the case's named assessor:
      a pooled case names none, and two people may mark different parts. Warn,
      never block — the mark stands — mirroring the create and sign-off checks. A
      tool with no assessor requirement resolves to nothing and warns about
      nothing, with no extra branch.
    */
    let markingEligibilityWarnings: string[] = [];
    if (!computed) {
      const assessorNeeds = resolveAssessorRequirements(
        { always: tool.assessorCompetencyIds, byStream: tool.assessorStreamCompetencyIds },
        row.locationId,
      );
      const [assessorGaps, ruleLocationNames] = await Promise.all([
        unmetPrerequisites(db, tenant.orgId, tenant.userId, assessorNeeds.required),
        locationNamesByIdFor(db, tenant.orgId, assessorNeeds.knownLocationIds),
      ]);
      const streamWarning = streamCheckWarning(
        assessorNeeds,
        assessorNeeds.knownLocationIds.map((id) => ruleLocationNames.get(id) ?? id),
      );
      markingEligibilityWarnings = [
        ...assessorGaps.map((gap) => describeGap('assessor', gap)),
        ...(streamWarning ? [streamWarning] : []),
      ];
    }

    await db
      .update(schema.assessmentPartAttempts)
      .set({
        outcome,
        values: derivedValues,
        disposition: outcome === 'not_satisfactory' ? disposition : null,
        dispositionReason: outcome === 'not_satisfactory' ? reason : null,
        belowThresholdReason: parsed.data.belowThresholdReason ?? null,
        // Empty for an automatic mark (R65); the person's gaps otherwise (U14).
        markingEligibilityWarnings,
        /*
          Attribution (U15, R70). A COMPUTED mark was made by no person, so it
          names nobody — `markerKind: 'automatic'` with the user and printed-name
          columns left null/empty, even on a case that does name an assessor. A
          JUDGED mark carries the person and the name they marked under.
        */
        markerKind: computed ? 'automatic' : 'person',
        assessorUserId: computed ? null : tenant.userId,
        assessorName: computed ? '' : (parsed.data.assessorName ?? ''),
        signedAt: new Date(),
      })
      .where(eq(schema.assessmentPartAttempts.id, attempt.id));

    // Recompute case state from the rows rather than incrementing a counter.
    const attempts = await attemptsFor(db, row.id);
    const progress = caseProgress(tool.manifest, row.pathway as AssessmentPathway, toAttemptFacts(attempts));
    const allPartsPassed = isCaseCompetent(progress);
    // The RESOLVED disposition, not the requested one — a computed fail that
    // defaulted to coaching keeps the case open, which is the whole point.
    const closing = outcome === 'not_satisfactory' && disposition === 'not_yet_competent';

    /*
      MARKING THE LAST PART DOES NOT CERTIFY ANYONE.

      Passing every part moves the case to `awaiting_sign_off`. Only the
      assessor's manual approval reaches `competent`, because that is what the
      printed record's name, signature and date attest to — and none of them
      exist until a person supplies them.

      `row.signedOffAt` is the conjunct that keeps this recompute honest. It runs
      on every outcome POST and derives state purely from the attempt rows, so
      without it, resolving any later attempt — an out-of-pathway part, an
      appeal — would recompute a signed case back down and silently un-certify
      someone who has already been certified.
    */
    const nextState: AssessmentCaseState = row.signedOffAt
      ? 'competent'
      : allPartsPassed
        ? 'awaiting_sign_off'
        : closing
          ? 'closed'
          : 'open';

    if (nextState !== row.state) {
      await db
        .update(schema.assessmentCases)
        .set({
          state: nextState,
          /*
            Ask whether the state is TERMINAL, never whether it differs from
            'open'. The old test dated everything that was not open, which
            stamps a close time on a case merely waiting for a signature — a
            finished date on an unfinished assessment.
          */
          ...(isTerminalCaseState(nextState) ? { closedAt: new Date() } : {}),
        })
        .where(eq(schema.assessmentCases.id, row.id));
    }

    await recordAudit(db, tenant, {
      action: 'Recorded part outcome',
      target: `${row.id} / ${attempt.partKey} #${attempt.attemptNumber}: ${outcome}`,
      category: 'submissions',
      icon: outcome === 'satisfactory' ? 'circle-check' : 'circle-x',
    });

    res.json({
      id: attempt.id,
      outcome,
      caseState: nextState,
      parts: progress.map((p) => ({ key: p.part.key, state: p.state })),
    });
  }),
);

const signOffBody = z.object({
  assessorName: z.string().min(1),
  /*
    A PNG data URL, as SignaturePad emits. Shape-checked here because the
    exporter refuses to draw anything it cannot recognise, and a signature
    rejected silently at render time would leave a certified record with an
    empty signature box and nothing to explain it.
  */
  signature: z.string().regex(/^data:image\/png;base64,/),
});

/**
 * Sign off a case — the assessor's manual approval, and the last act of an
 * assessment.
 *
 * Marking the final part does not certify anybody; it moves the case to
 * `awaiting_sign_off`. Only this route reaches `competent`, because that is the
 * state the printed record's name, signature and date attest to, and a person
 * has to supply them.
 *
 * THE DATE IS SERVER-STAMPED. It is never accepted from the client: a
 * certification date is a claim about when a judgement was made, and the one
 * moment we can actually vouch for is the moment the request arrived.
 */
assessmentCasesRouter.post(
  '/:id/sign-off',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    /*
      `hasPermission` asks for an ORG-WIDE grant, so a candidate's own-scoped
      `edit` resolves to false and they cannot reach this route at all. That is
      the intent: a candidate must never be able to certify themselves.
    */
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = signOffBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    /*
      IDEMPOTENT. A double-tap returns the existing record rather than
      re-stamping: the second press would otherwise record a later approval time
      than the one actually made, and write a second audit entry for one
      decision.
    */
    if (row.signedOffAt) {
      res.json({
        state: row.state,
        signedOffAt: row.signedOffAt.toISOString(),
        signedOffName: row.signedOffName,
        alreadySignedOff: true,
      });
      return;
    }

    /*
      THE HARD GATE. Unsatisfied prerequisites never blocked the assessment —
      the candidate sat it, the marks stand — but `competent` is a certificate,
      and certifying somebody whose licence is expired or missing is exactly
      the record an auditor pulls. Evaluated NOW, not from anything stored, so
      a licence renewed five minutes ago passes.
    */
    if (db) {
      const gateTool = await loadTool(db, row.toolId, tenant.orgId);
      if (gateTool) {
        const unmet = (
          await evaluatePrerequisites(db, tenant.orgId, row.candidateUserId, gateTool.manifest)
        ).filter((r) => !r.satisfied);
        if (unmet.length > 0) {
          res.status(409).json({
            error: 'prerequisites_unsatisfied',
            detail: unmet.map((r) => `${r.competencyName}: ${r.status}`).join('; '),
            prerequisites: unmet,
          });
          return;
        }
      }
    }

    if (row.state === 'closed') {
      res.status(409).json({ error: 'case_closed' });
      return;
    }
    // Nobody certifies themselves, even holding an assessor role.
    if (tenant.userId === row.candidateUserId) {
      res.status(409).json({ error: 'candidate_cannot_sign_off' });
      return;
    }

    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }

    /*
      WHAT STOPS IT BEING APPROVED EARLY.

      Computed from the attempt rows on this request, by the same predicate the
      case screen renders from — so it cannot disagree with what the assessor is
      looking at. There is no override parameter and no force flag: nothing in
      the request can substitute for every required part having a passing
      attempt.
    */
    const attempts = await attemptsFor(db, row.id);
    const progress = caseProgress(tool.manifest, row.pathway as AssessmentPathway, toAttemptFacts(attempts));
    if (!isCaseCompetent(progress)) {
      res.status(409).json({
        error: 'parts_incomplete',
        outstanding: progress.filter((p) => p.state !== 'satisfactory').map((p) => p.part.key),
      });
      return;
    }

    /*
      Warned on, never blocking — the same doctrine as case creation. An
      out-of-date competency record is far more common than an unqualified
      assessor, and refusing here would stop a real assessment over data entry.

      Resolved against THIS CASE'S stream, and against the person signing off
      rather than the one the case was opened against: the case may have been
      opened by one assessor and certified by another, and it is the signature
      on the certificate whose authority matters.
    */
    const assessorNeeds = resolveAssessorRequirements(
      { always: tool.assessorCompetencyIds, byStream: tool.assessorStreamCompetencyIds },
      row.locationId,
    );
    const [assessorGaps, ruleLocationNames] = await Promise.all([
      unmetPrerequisites(db, tenant.orgId, tenant.userId, assessorNeeds.required),
      locationNamesByIdFor(db, tenant.orgId, [...assessorNeeds.knownLocationIds, row.locationId]),
    ]);
    const signOffStreamWarning = streamCheckWarning(
      assessorNeeds,
      assessorNeeds.knownLocationIds.map((id) => ruleLocationNames.get(id) ?? id),
    );

    const signedOffAt = new Date();
    await db
      .update(schema.assessmentCases)
      .set({
        signedOffAt,
        signedOffByUserId: tenant.userId,
        signedOffName: parsed.data.assessorName,
        // Capture the Location's name as signed (R138), so a later rename does
        // not change what this settled certificate reads.
        signedOffLocationName: row.locationId ? (ruleLocationNames.get(row.locationId) ?? '') : '',
        signedOffSignature: parsed.data.signature,
        state: 'competent',
        closedAt: signedOffAt,
      })
      .where(eq(schema.assessmentCases.id, row.id));

    /*
      THIS TARGET IS THE ONLY DURABLE RECORD OF THE SIGN-OFF-TIME CHECK.

      The case's `prerequisiteWarnings` column is written once, at creation,
      against the assessor the case was OPENED with — and the case screen labels
      it as such. Sign-off deliberately checks whoever is signing, who may be
      someone else, so if this line does not say what was found, nothing does.

      It used to interpolate `assessorGaps` directly. Those became objects when
      gaps gained a reason, so every such entry read "assessor missing
      [object Object]" — an audit trail recording that something was wrong and
      not what.
    */
    const signOffNotes = [
      ...assessorGaps.map((gap) => describeGap('assessor', gap)),
      ...(signOffStreamWarning ? [signOffStreamWarning] : []),
    ];
    await recordAudit(db, tenant, {
      action: 'Signed off assessment case',
      target: `${row.id} → ${parsed.data.assessorName}${signOffNotes.length ? ` (${signOffNotes.join('; ')})` : ''}`,
      category: 'submissions',
      icon: 'circle-check',
    });

    /*
      THE POINT OF THE WHOLE THING: passing the assessment puts the candidate on
      the register it exists to maintain.

      Fired here rather than where the last part is marked, so the grant follows
      the human approval rather than the arithmetic. `sourceCaseId` makes the
      evidence FOLLOWABLE — `evidenceRef` is documented as display-only, a
      string nothing resolves, and "linked to the case as evidence" has to be
      more than that.

      A grant that cannot be made does NOT fail the sign-off. Refusing to record
      a completed safety assessment because a register write did not land is the
      wrong failure; the sign-off is the assessor's decision and it stands. What
      could not be granted is reported and audited instead.
    */
    const granted: string[] = [];
    const grantProblems: string[] = [];
    for (const competencyId of tool.awardedCompetencyIds ?? []) {
      const result = await grantCompetency(db, tenant, {
        competencyId,
        userId: row.candidateUserId,
        evidenceRef: `assessment-case:${row.id}`,
        sourceCaseId: row.id,
      });
      if (result.ok) granted.push(result.outcome.code);
      else grantProblems.push(`competency ${competencyId} not granted (${result.reason})`);
    }

    res.json({
      state: 'competent',
      signedOffAt: signedOffAt.toISOString(),
      signedOffName: parsed.data.assessorName,
      granted,
      warnings: [
        ...assessorGaps.map((gap) => describeGap('assessor', gap)),
        ...(signOffStreamWarning ? [signOffStreamWarning] : []),
        ...grantProblems,
      ],
    });
  }),
);
