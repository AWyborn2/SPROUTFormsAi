import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  applyCalcs,
  ASSESSMENT_PATHWAYS,
  PART_KINDS,
  NS_DISPOSITIONS,
  caseProgress,
  competencyCurrency,
  completionTickRows,
  countsAsHeld,
  fieldsInPart,
  fieldsInSection,
  isCaseCompetent,
  isTerminalCaseState,
  nextStepAfter,
  deriveChecklistOutcome,
  isSelfMarking,
  moreCoachingRequired,
  type AssessmentCaseState,
  assessorMarkBoxIds,
  autoVerdictWrite,
  casePartKeys,
  type LocationPartKeys,
  logbookRows,
  prerequisiteCompetencyIds,
  reducePrerequisiteClasses,
  logbookDurationRows,
  markKeyedQuestions,
  markTheory,
  markingCompositionWarnings,
  SELF_ANSWERING_TYPES,
  ACCESS_LEVELS,
  VALUE_SOURCES,
  WORKFLOW_ROLES,
  STAFF_WORKFLOW_ROLES,
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
  validatePartCompletionMarks,
  validatePartOutcomeMarks,
  validatePathwayMarks,
  validateSignOffMarks,
  type ProfilePrefillSource,
  sectionForPart,
  workflowOf,
  writableFieldIds,
  type WorkflowRole,
  missingDeclarationFields,
  streamCheckWarning,
  totalLoggedHours,
  stripMarkingSecrets,
  theoryRenderingOf,
  theoryRetryOf,
  unplacedMarkDestinations,
  validateAnswerKeys,
  validateManifest,
  REVISION_IDENTITY_LIMITS,
  type AssessmentPart,
  type AssessmentPathway,
  type AssessmentToolManifest,
  type AttemptFact,
  type FormField,
  type RepeatingRowValue,
  type SubmissionValue,
  THEORY_RENDERINGS,
  THEORY_RETRY_MODES,
} from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { mintCourseContentPath } from './courses.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission, permissionScope } from '../lib/permissions.js';
import { assignmentCaseValues, heldCompetencyStates } from '../lib/assignment.js';
import {
  computeAwardLinkChange,
  computeAwardRelinkChange,
  NON_TERMINAL_STATES,
} from '../lib/requirement-change.js';
import { identifyMember, loadDisplayIdentities } from '../lib/display-identity.js';
import { recordAudit } from '../audit/record.js';
import { grantCompetency, revokeGrantsFromCase } from '../lib/competency-grant.js';
import { CaseExportError, exportCasePdf, withDerivedMarks, type CaseAttemptRecord } from '../pdf/index.js';
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
/** The root client OR an open transaction — what a read-only helper accepts. */
type Reader = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/*
  The Admin access level (R73). Declaring the parts rule reads the organisation's
  Location taxonomy and decides which sections a candidate must complete to be
  certified, so it sits on the same gate R12 puts on managing that taxonomy —
  not on the permission that authors a document's wording.
*/
function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

// `Reader`, not `Database`: the award apply re-reads the tool INSIDE its own
// transaction, where the handle is a transaction rather than the root client.
async function loadTool(database: Reader, toolId: string, orgId: string) {
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

/** The org's self-assessment policy — one column, read where it gates. */
async function selfAssessmentAllowed(database: Database, orgId: string): Promise<boolean> {
  const org = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, orgId),
  });
  return org?.allowSelfAssessment ?? false;
}

/**
 * The org's labelled-sign-off policy: whether on-case staff may apply a
 * supervisor's or SME's signature on their behalf (defaults on). Off means
 * those parts wait for that person's own login — a capability not yet built,
 * so off currently just leaves supervisor/SME-assigned fields to nobody, as
 * before this feature.
 */
async function labelledSignoffAllowed(database: Database, orgId: string): Promise<boolean> {
  const org = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, orgId),
  });
  return org?.allowLabelledSignoff ?? true;
}

/**
 * The workflow parties whose fill access this caller holds on a part.
 *
 * The candidate is only ever the candidate. On-case STAFF hold the assessor's
 * access and — when the org allows labelled sign-off — the supervisor's and
 * SME's too, so one person can apply those signatures the way they sign the
 * paper on someone's behalf. A self-assessor is both the candidate and staff.
 * With labelled sign-off off, staff resolve to the assessor alone, so a
 * supervisor/SME field is left to nobody rather than signed by the wrong party.
 */
export function fillParties(opts: {
  party: WorkflowRole;
  selfAssessing: boolean;
  labelled: boolean;
}): WorkflowRole[] {
  const staff: WorkflowRole[] = opts.labelled ? [...STAFF_WORKFLOW_ROLES] : ['assessor'];
  if (opts.selfAssessing) return ['candidate', ...staff];
  if (opts.party === 'candidate') return ['candidate'];
  return staff;
}

/**
 * Whether this caller is SELF-ASSESSING on this case: they are the candidate,
 * they hold a staff role, and the organisation permits it. A candidate-role
 * login never qualifies — the policy is about qualified people running their
 * own assessment, not about candidates marking themselves.
 */
async function isSelfAssessing(
  database: Database,
  tenant: { userId: string; orgId: string; role: string },
  candidateUserId: string,
): Promise<boolean> {
  if (tenant.userId !== candidateUserId) return false;
  if (tenant.role === 'candidate') return false;
  return selfAssessmentAllowed(database, tenant.orgId);
}

/**
 * Field access for a self-assessor: the UNION of what the candidate and the
 * assessor may see and write. The workflow split one document between two
 * people; with the org's policy putting one person on both ends of it, a
 * field either side could touch is theirs — hidden only where hidden from
 * BOTH. `auto` and `prefill` sources stay locked exactly as they are for
 * either party alone, because `partFieldAccess` already excludes them from
 * `writable` per party and a union of two exclusions is still an exclusion.
 */
function unionPartFieldAccess(
  workflow: ReturnType<typeof workflowOf>,
  partKey: string,
  partFields: readonly FormField[],
  parties: readonly WorkflowRole[],
): { hidden: string[]; writable: string[] } {
  const per = parties.map((p) => partFieldAccess(workflow, partKey, partFields, p));
  const hidden = (per[0]?.hidden ?? []).filter((id) => per.every((a) => a.hidden.includes(id)));
  const writable = [...new Set(per.flatMap((a) => a.writable))];
  return { hidden, writable };
}

/**
 * The MARKING SURFACE of one part — what staff may still write on an attempt
 * that is handed in but not yet marked.
 *
 * A submitted attempt's ANSWERS are frozen ("submitted" means the answers stop
 * moving while the assessor reads them), but marking a mixed part IS writing:
 * the assessor ticks each written question's ✓/✗ against its model answer,
 * then signs the part. So the writable set narrows to exactly the marks:
 *
 * - the assessor-writable `entry` fields that are SELF-ANSWERING
 *   (`check_cross` / `boolean_yes_no`) — the unkeyed ✓/✗ cells
 *   `assessorMarkBoxIds` left `entry`, and any practical-style tick boxes.
 *   Self-answering by TYPE is the fence: a textarea the workflow happens to
 *   let the assessor fill is still the candidate's evidence once handed in.
 *   AND NOT CANDIDATE-WRITABLE: a self-answering box the workflow lets the
 *   CANDIDATE fill is one of their answers (an unkeyed yes/no question), not
 *   a mark — leaving it here let staff flip a candidate's own recorded answer
 *   on a frozen attempt. Assessor-only boxes stay, which is what the builder
 *   emits for every unkeyed question's cell (`candidate: 'view'`).
 * - the part's own declared furniture — assessor name, signed date, further
 *   action — which is how the assessor signs what they just marked. Declared
 *   ids only, same doctrine as `autoSourcesFor`; each still has to be
 *   workflow-writable, because callers INTERSECT this with the party's
 *   writable set rather than replacing it.
 *
 * Served by the fill route as `writableFieldIds` in that state and enforced by
 * the PATCH gate, so the surface and the write rule cannot disagree.
 */
function markingSurfaceIds(
  workflow: ReturnType<typeof workflowOf>,
  part: AssessmentPart,
  partFields: readonly FormField[],
): Set<string> {
  const assessorWritable = new Set(
    partFieldAccess(workflow, part.key, partFields, 'assessor').writable,
  );
  const candidateWritable = new Set(
    partFieldAccess(workflow, part.key, partFields, 'candidate').writable,
  );
  const out = new Set<string>();
  for (const f of partFields) {
    if (
      assessorWritable.has(f.id) &&
      !candidateWritable.has(f.id) &&
      SELF_ANSWERING_TYPES.includes(f.type)
    ) {
      out.add(f.id);
    }
  }
  for (const id of [part.assessorNameFieldId, part.signedDateFieldId, part.furtherActionFieldId]) {
    if (id) out.add(id);
  }
  return out;
}

/**
 * What THIS case requires — the pathway's parts narrowed by the tool's
 * per-Location rule for the case's Location. The ONE derivation every
 * progress read shares (dashboard, case screen, fill view, marking,
 * sign-off, export), so no two surfaces can disagree about whether a
 * Location-excluded part is owed. A case with no Location, or one the rule
 * does not list, requires everything — the safe direction (R75).
 */
function applicablePartsFor(
  tool: { manifest: AssessmentToolManifest; locationPartKeys: LocationPartKeys | null },
  row: { pathway: string; locationId: string | null },
): Set<string> {
  return casePartKeys(
    tool.manifest,
    row.pathway as AssessmentPathway,
    tool.locationPartKeys ?? {},
    row.locationId,
  );
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

/**
 * A THEORY RETRY KEEPS WHAT WAS RIGHT.
 *
 * "Sit it again" on a keyed paper means the questions that were missed, not the
 * whole paper — coaching goes back over the wrong answers, and re-typing thirty
 * correct ones proves nothing the record does not already hold. So the new
 * attempt opens with the previous attempt's CORRECT answers in place and every
 * wrong or unanswered question blank.
 *
 * Only the fully-keyed part carries: correctness is recomputed here from the
 * stored answers and the version's own keys, so what carries is exactly what
 * marking judged right — never the derived ✓/✗ cells, the verdict pair or the
 * further-action note, which the next marking pass rewrites from scratch. A
 * person-judged part (any unkeyed question) carries nothing: a fresh
 * demonstration is the point, and pre-filling it would show marks nobody made
 * on THIS attempt.
 */
async function carryForwardTheory(
  database: Database,
  input: {
    manifest: AssessmentToolManifest;
    part: AssessmentPart;
    previous: readonly { attemptNumber: number; outcome: string | null; values: Record<string, SubmissionValue>; templateVersionId: string }[];
    toVersionId: string;
  },
): Promise<{ values: Record<string, SubmissionValue> } | undefined> {
  const last = [...input.previous].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  if (!last || last.outcome !== 'not_satisfactory') return undefined;

  // The keys that judged the previous attempt are the ones that decide what was
  // right, so correctness is computed against ITS version — values are then
  // written under the same field ids, which are stable across versions here.
  const fields = await fieldsForVersion(database, last.templateVersionId);
  if (!isSelfMarking(fields, input.manifest, input.part.key)) return undefined;

  const { marks } = markTheory({ fields, values: last.values, part: input.part, manifest: input.manifest });
  const values: Record<string, SubmissionValue> = {};
  for (const mark of marks) {
    if (!mark.correct) continue;
    const answer = last.values?.[mark.fieldId];
    if (answer !== undefined) values[mark.fieldId] = answer;
  }
  return Object.keys(values).length > 0 ? { values } : undefined;
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

/**
 * Whether a case is waiting on an ASSESSOR to act — the one thing an assessor
 * opens the case list to find.
 *
 * Two ways it happens: every required part has passed and the case sits in
 * `awaiting_sign_off` for final approval, or a part has been handed in
 * (`submittedAt` set) but not yet marked (`outcome` still null) — the marking a
 * candidate cannot do for themselves. A part that auto-marked at hand-in already
 * carries an outcome, so it is not a person's pending work and is not counted.
 */
export function caseAwaitsAssessor(
  state: string,
  attempts: readonly { submittedAt: unknown; outcome: string | null }[],
): boolean {
  if (state === 'awaiting_sign_off') return true;
  return attempts.some((a) => a.submittedAt !== null && a.outcome === null);
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

/*
  Named once and used by BOTH the create body and the workflow PATCH, because
  the two accepting different shapes is how `overallNotSatisfactory` went
  missing: the manifest type had it, the exporter wrote it, and this schema
  silently STRIPPED it — so every tool published over HTTP lost the "not yet
  Competent" box while the same tool authored by script kept it.
*/
const signOffSchema = z.object({
  assessorNameFieldId: z.string().optional(),
  assessorSignatureFieldId: z.string().optional(),
  signedDateFieldId: z.string().optional(),
  overallSatisfactory: declaredMarkSchema.optional(),
  overallNotSatisfactory: declaredMarkSchema.optional(),
  moreCoachingRequiredYes: declaredMarkSchema.optional(),
  moreCoachingRequiredNo: declaredMarkSchema.optional(),
});

const partCompletionMarkSchema = z.object({
  partKey: z.string().min(1),
  fieldId: z.string().min(1),
  rowIndex: z.number().int().min(0),
  columnKey: z.string().min(1),
});

/** The case's pathway → the printed box that says so. Partial by design. */
const pathwayMarksSchema = z.record(z.enum(ASSESSMENT_PATHWAYS), declaredMarkSchema);

/**
 * The manifest's pointer at a hosted course package (the pre-assessment
 * reading). Whether the id names a real, active course is checked where the
 * link is SET — the PATCH below — not here: schema-level existence checks
 * cannot reach the database.
 */
const courseLinkSchema = z.object({
  courseId: z.string().uuid(),
  required: z.boolean(),
});

/*
  One printed box, answered by ANY of the listed classes. `competencyId` is the
  legacy single-class spelling and still accepted — a manifest saved before
  boxes took families must round-trip untouched. At-least-one is
  `validatePrerequisiteChecks`' job, which both save paths already run.
*/
const prerequisiteCheckSchema = z.object({
  fieldId: z.string().min(1),
  competencyId: z.string().min(1).optional(),
  competencyIds: z.array(z.string().min(1)).optional(),
});

const partSchema = z.object({
  key: z.string().min(1),
  ordinal: z.number().int().positive(),
  label: z.string().min(1),
  // From the shared constant, never a re-typed list — a kind this schema
  // omits is silently rejected over HTTP while the shared model accepts it,
  // which is exactly how `candidateNameFieldId` once went missing.
  kind: z.enum(PART_KINDS),
  pathways: z.array(z.enum(ASSESSMENT_PATHWAYS)).min(1),
  startFieldId: z.string().min(1),
  minimumHours: z.number().positive().optional(),
  // The unit the minimums and logged Duration are read in. Omitted = hours.
  durationUnit: z.enum(['hours', 'minutes']).optional(),
  durationColumnKey: z.string().optional(),
  taskMinimums: z
    .object({
      columnKey: z.string().min(1),
      targets: z.array(z.object({ value: z.string().min(1), minimumHours: z.number().positive() })),
    })
    .optional(),
  logbookRouting: z
    .object({
      sourceFieldId: z.string().min(1),
      columnKey: z.string().min(1),
      routes: z.array(z.object({ value: z.string().min(1), fieldId: z.string().min(1) })),
    })
    .optional(),
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
 *
 * A check may accept SEVERAL classes ("Driver's Licence C or higher" is a
 * family, and the register keeps each class as its own competency): the box
 * is satisfied by ANY current one, and the result names the class that
 * answered it. An unsatisfied multi-class check names every accepted class,
 * so the sign-off refusal reads "C / LR / HR: missing" rather than blaming
 * one class the candidate never needed to hold.
 */
async function evaluatePrerequisites(
  database: NonNullable<typeof db>,
  orgId: string,
  candidateUserId: string,
  manifest: AssessmentToolManifest,
): Promise<PrerequisiteResult[]> {
  const checks = manifest.prerequisiteChecks ?? [];
  if (checks.length === 0) return [];

  const ids = [...new Set(checks.flatMap((c) => prerequisiteCompetencyIds(c)))];
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

  const evaluateOne = (competencyId: string) => {
    const competency = byId.get(competencyId);
    const held = holders.find((h) => h.competencyId === competencyId);
    const base = { competencyId, competencyName: competency?.name ?? 'Unknown competency' };
    if (!held) return { ...base, satisfied: false, status: 'missing' as const, expiresAt: null };
    if (held.revokedAt) {
      return { ...base, satisfied: false, status: 'revoked' as const, expiresAt: null };
    }
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
  };

  return checks.map((check) => ({
    fieldId: check.fieldId,
    // The any-of decision is shared — see `reducePrerequisiteClasses` for
    // which class answers the box and which failure surfaces when none does.
    ...reducePrerequisiteClasses(prerequisiteCompetencyIds(check).map(evaluateOne)),
  }));
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
  prerequisiteChecks: z.array(prerequisiteCheckSchema).nullable().optional(),
  /** Tool-declared default answers. Same tri-state; values stored opaque. */
  fieldDefaults: z.record(z.string(), z.unknown()).nullable().optional(),
  /**
   * The methods-checklist mapping: which printed row ticks when which part
   * passes. Same tri-state — the array replaces, null clears, absent keeps —
   * so the editor can finally SEE and CORRECT what publish only guessed at.
   */
  partCompletionMarks: z.array(partCompletionMarkSchema).nullable().optional(),
  /**
   * The front page's certification block, replaced whole. The editor seeds its
   * draft from the stored block and sends it back with the result pair
   * repointed, so the name/signature/date pointers and the coaching pair ride
   * through a save untouched.
   */
  signOff: signOffSchema.nullable().optional(),
  /** The pathway → printed-box map. Same tri-state as everything above. */
  pathwayMarks: pathwayMarksSchema.nullable().optional(),
  /**
   * The parts' printed verdict pairs — "The Candidate's responses were:
   * Satisfactory / Not Satisfactory" — repointed per part. An entry replaces
   * BOTH of the named part's marks (an absent half clears it); parts not
   * named keep theirs; null clears every part's pair. The same pair mapped on
   * several parts is the multi-theory paper's spelling: each applicable part
   * writes it at its own marking, so whichever papers the case sits stamp
   * the one printed box.
   */
  partOutcomeMarks: z
    .array(
      z.object({
        partKey: z.string().min(1),
        outcomeSatisfactory: declaredMarkSchema.optional(),
        outcomeNotSatisfactory: declaredMarkSchema.optional(),
      }),
    )
    .nullable()
    .optional(),
  /**
   * The pre-assessment course link. Same tri-state as everything above —
   * absent keeps, null clears, an object replaces — and setting one is
   * validated against the org's actual courses below, because a link to a
   * course that does not exist would read as "configured" in the builder
   * while gating nothing at runtime.
   */
  course: courseLinkSchema.nullable().optional(),
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
    // Named for the same reason as every optional above: an unlisted manifest
    // property is silently STRIPPED, and a builder that appeared to save the
    // completion mapping would publish a checklist that never ticks.
    partCompletionMarks: z.array(partCompletionMarkSchema).optional(),
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
    // Named for the same reason as every optional above: an unlisted property is
    // silently STRIPPED, so a builder that saved a pass threshold or a retry mode
    // would publish a tool that quietly fell back to the default.
    theoryPassPercent: z.number().int().min(1).max(100).optional(),
    theoryAllowRetry: z.boolean().optional(),
    theoryRetry: z.enum(THEORY_RETRY_MODES).optional(),
    signOff: signOffSchema.optional(),
    // The printed pathway tick, written from the case at export. Named for the
    // same reason as every optional above: unlisted means silently STRIPPED.
    pathwayMarks: pathwayMarksSchema.optional(),
    // The pre-assessment course link. Named for the same reason as every
    // optional above: unlisted means silently STRIPPED, and a republished
    // revision would quietly stop requiring the manual be read.
    course: courseLinkSchema.optional(),
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
  /**
   * What passing this tool AWARDS. Granted on sign-off, linked to the case.
   *
   * REQUIRED, and exactly ONE (U2, R1, KTD4): strictly-one rides the plural
   * jsonb column, with the cardinality enforced here at the API boundary. A
   * tool that awards nothing is vacuously satisfied by everyone — the engine
   * plans no case for it and sign-off grants nothing — so an award-less
   * create would ship an inert tool; that state now exists only on tools
   * created before this round, and the backfill (GET /unlinked) drains it.
   */
  awardedCompetencyIds: z.array(z.string().uuid()).min(1).max(1),
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

    // The one award must be a competency THIS organisation defines (U2) — an
    // id from another tenant (or thin air) would silently create a tool whose
    // sign-off grants nothing resolvable.
    const awardedCompetencyId = parsed.data.awardedCompetencyIds[0]!;
    const awardedCompetency = await db.query.competencies.findFirst({
      where: and(
        eq(schema.competencies.id, awardedCompetencyId),
        eq(schema.competencies.orgId, tenant.orgId),
      ),
    });
    if (!awardedCompetency) {
      res.status(400).json({ error: 'invalid_award' });
      return;
    }

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
        awardedCompetencyIds: parsed.data.awardedCompetencyIds,
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

/*
  The manifest as a REVISION sends it back. `toolBody.manifest` names what the
  builder authors at create; a revised tool's manifest additionally carries the
  workflow-editor properties added after creation (`profilePrefill`,
  `prerequisiteChecks`, `fieldDefaults`). They must be NAMED here — an unlisted
  manifest property is silently STRIPPED, and a republish that appeared to keep
  the prefill would publish a tool that lost it.
*/
const republishManifestSchema = toolBody.shape.manifest.extend({
  profilePrefill: z.record(z.string(), z.enum(PROFILE_PREFILL_KEYS)).optional(),
  prerequisiteChecks: z.array(prerequisiteCheckSchema).optional(),
  fieldDefaults: z.record(z.string(), z.unknown()).optional(),
});

const republishBody = z.object({
  /** The revision's DRAFT version — published by this call. */
  versionId: z.string().uuid(),
  /**
   * The version the revision was seeded from. Refused (`stale_revision`) when
   * it no longer matches the template's current version — a revision of v1
   * must not silently discard a v2 somebody else published in between.
   */
  seededFromVersionId: z.string().uuid(),
  /** The resolved fields (keys + outcome links applied) to freeze into the version. */
  fields: z.array(z.custom<FormField>()),
  manifest: republishManifestSchema,
  name: z.string().min(1).optional(),
  /** The paper document's revision identity, recorded on the published version. */
  revisionIdentity: z
    .object({
      code: z.string().max(REVISION_IDENTITY_LIMITS.code).optional(),
      reviewedOn: z.string().max(REVISION_IDENTITY_LIMITS.reviewedOn).optional(),
      note: z.string().max(REVISION_IDENTITY_LIMITS.note).optional(),
    })
    .strict()
    .optional(),
  /**
   * The author's EXPLICIT choice to untick removed parts from every Location
   * rule that still requires them, in the same transaction as the publish.
   * Never defaulted on: silently changing which parts a Location requires is
   * a policy edit nobody made. The publish step offers it as a labelled
   * button once the refusal has named the rules.
   */
  dropDanglingLocationRules: z.boolean().optional(),
});

/**
 * Publish a REVISION of an existing tool: one transaction that freezes the
 * revised draft version and updates the tool's manifest together.
 *
 * This exists because the create route cannot run twice (one tool per
 * template, enforced by `assessment_tools_template_uq`) and the PATCH cannot
 * carry a new parts manifest — so before this, a published version with a
 * stale tool was one failed client call away. Everything the create path
 * would zero (`departmentId`, `locationPartKeys`, competency and prerequisite
 * columns) is deliberately untouched here: a revision changes the document,
 * not the tool's admin configuration.
 *
 * Guard order is the contract: staleness, then field validation, then
 * open-case compatibility (R16) — an open case finishes on its pinned version
 * and reads THIS tool's one manifest against those pinned fields, so a
 * manifest that would dangle against any open case is refused, never
 * published-then-broken.
 */
assessmentToolsRouter.post(
  '/:id/republish',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    // Both doors this call opens, gated alike: it publishes a version
    // (forms.edit, same as the per-version publish endpoint) and it rewrites
    // the tool (assessments.create, same as the create path).
    if (!(await hasPermission(tenant, 'forms', 'edit')) || !(await hasPermission(tenant, 'assessments', 'create'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = republishBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tool = await loadTool(db, req.params.id!, tenant.orgId);
    if (!tool) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const template = await db.query.formTemplates.findFirst({
      where: and(
        eq(schema.formTemplates.id, tool.templateId),
        eq(schema.formTemplates.orgId, tenant.orgId),
      ),
    });
    if (!template) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const version = await db.query.formTemplateVersions.findFirst({
      where: and(
        eq(schema.formTemplateVersions.id, parsed.data.versionId),
        eq(schema.formTemplateVersions.templateId, template.id),
      ),
    });
    if (!version) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (version.state === 'published') {
      res.status(409).json({ error: 'version_already_published' });
      return;
    }
    if (parsed.data.seededFromVersionId !== template.currentVersionId) {
      // Somebody published after this revision was seeded. Surface who and
      // when so the author can judge, and stop — retrying cannot succeed.
      const current = template.currentVersionId
        ? await db.query.formTemplateVersions.findFirst({
            where: eq(schema.formTemplateVersions.id, template.currentVersionId),
          })
        : undefined;
      const publisher = current?.publishedBy
        ? await db.query.users.findFirst({ where: eq(schema.users.id, current.publishedBy) })
        : undefined;
      res.status(409).json({
        error: 'stale_revision',
        currentVersionLabel: current?.versionLabel ?? null,
        publishedAt: current?.publishedAt ? current.publishedAt.toISOString() : null,
        publishedByName: publisher?.name ?? null,
      });
      return;
    }

    const manifest = parsed.data.manifest as AssessmentToolManifest;
    const { fields } = parsed.data;
    const { problems: workflowProblems } = validateWorkflow(workflowOf(manifest, fields), manifest, fields);
    const problems = [
      ...validateManifest(manifest, fields),
      ...validateAnswerKeys(fields),
      ...workflowProblems,
      ...validateProfilePrefill(manifest.profilePrefill, fields),
      ...validatePrerequisiteChecks(manifest.prerequisiteChecks, fields),
    ];
    /*
      A Location rule naming a part the revised manifest no longer declares
      would silently dangle — the rule's own PATCH validates against the
      manifest, so the manifest changing owes the rule the same check. Named
      in PEOPLE'S TERMS: the rule stores a Location id and the part key is an
      internal handle, and a refusal reading "rule 764679d8… requires
      secnew2" tells an author nothing they can act on.
    */
    const partKeys = new Set(orderedParts(manifest).map((p) => p.key));
    const oldPartLabels = new Map(orderedParts(tool.manifest).map((p) => [p.key, p.label]));
    const ruleLocationIds = Object.keys(tool.locationPartKeys ?? {});
    const ruleLocationNames =
      ruleLocationIds.length > 0
        ? await locationNamesByIdFor(db, tenant.orgId, ruleLocationIds)
        : new Map<string, string>();
    const danglingRules: Array<{
      locationId: string;
      locationName: string;
      partKey: string;
      partLabel: string;
    }> = [];
    for (const [locationId, keys] of Object.entries(tool.locationPartKeys ?? {})) {
      for (const key of keys) {
        if (!partKeys.has(key)) {
          danglingRules.push({
            locationId,
            locationName: ruleLocationNames.get(locationId) ?? locationId,
            partKey: key,
            partLabel: oldPartLabels.get(key) ?? key,
          });
        }
      }
    }
    // With the author's explicit say-so the danglings are the fix, not the
    // refusal: the rules are trimmed in the same transaction as the publish.
    const trimRules = parsed.data.dropDanglingLocationRules === true && danglingRules.length > 0;
    if (!trimRules) {
      for (const dangling of danglingRules) {
        problems.push(
          `${dangling.locationName} requires "${dangling.partLabel}", which this revision removes. Untick it under Where each part applies in the tool's workflow, or keep the part in this revision.`,
        );
      }
    }

    const cases = await db.query.assessmentCases.findMany({
      where: and(
        eq(schema.assessmentCases.toolId, tool.id),
        eq(schema.assessmentCases.orgId, tenant.orgId),
      ),
    });

    /*
      A PART WITH RECORDED ATTEMPTS CANNOT BE REMOVED. The export selects
      attempts by the manifest's part keys and FAILS LOUD on an attempt whose
      part the manifest no longer declares — so a revision that drops a part
      somebody has sat would leave every one of those cases unable to print
      its evidence. That is discovered months later by an auditor, which is
      why it is refused here, where the author can still keep the part.
    */
    const removedKeys = [...oldPartLabels.keys()].filter((k) => !partKeys.has(k));
    const attemptedParts: Array<{ key: string; label: string }> = [];
    const openCaseAttemptWarnings: string[] = [];
    if (removedKeys.length > 0 && cases.length > 0) {
      const priorAttempts = await db.query.assessmentPartAttempts.findMany({
        where: inArray(
          schema.assessmentPartAttempts.caseId,
          cases.map((c) => c.id),
        ),
      });
      /*
        SIGNED EVIDENCE KEEPS ITS PART; an open case's progress is the
        author's to spend. A CONSOLIDATION — the part's fields folded into a
        neighbouring section, still printed, still filled — is a legitimate
        revision, and blocking it because a live test case touched the old
        part would freeze every tool the moment anyone tried it. So only
        attempts on TERMINAL cases (certified or closed evidence) refuse;
        attempts on open cases are reported as a warning on the publish.
      */
      const terminalCaseIds = new Set(
        cases.filter((c) => isTerminalCaseState(c.state as AssessmentCaseState)).map((c) => c.id),
      );
      const touchedTerminal = new Set(
        priorAttempts
          .filter((a) => removedKeys.includes(a.partKey) && terminalCaseIds.has(a.caseId))
          .map((a) => a.partKey),
      );
      for (const key of touchedTerminal) {
        attemptedParts.push({ key, label: oldPartLabels.get(key) ?? key });
        problems.push(
          `Part "${oldPartLabels.get(key) ?? key}" has evidence on completed cases, so this revision cannot remove it — that evidence would no longer export. Keep the part (it can stop being required at any Location instead).`,
        );
      }
      for (const key of new Set(
        priorAttempts
          .filter(
            (a) =>
              removedKeys.includes(a.partKey) &&
              !terminalCaseIds.has(a.caseId) &&
              !touchedTerminal.has(a.partKey),
          )
          .map((a) => a.partKey),
      )) {
        openCaseAttemptWarnings.push(
          `Open cases have attempts on "${oldPartLabels.get(key) ?? key}", which this revision removes — that progress will not count against the revised parts.`,
        );
      }
    }

    if (problems.length > 0) {
      /*
        STRUCTURED alongside prose, so the publish step can OFFER the fix
        rather than narrate it: `danglingRules` is what the one-click untick
        resolves; `attemptedParts` is what no click can — evidence keeps its
        part.
      */
      res.status(400).json({
        error: 'invalid_manifest',
        problems,
        danglingRules: trimRules ? [] : danglingRules,
        attemptedParts,
      });
      return;
    }

    // R16: this tool has ONE manifest, and every open case reads it against
    // the case's PINNED version fields. Refuse a manifest that would dangle
    // against any of them — the open case finishes on its pinned version.
    const openCases = cases.filter((c) => !isTerminalCaseState(c.state as AssessmentCaseState));
    const fieldsByVersion = new Map<string, FormField[]>();
    const incompatible: Array<{ id: string; candidateUserId: string; versionId: string; problems: string[] }> = [];
    for (const openCase of openCases) {
      let pinnedFields = fieldsByVersion.get(openCase.currentVersionId);
      if (!pinnedFields) {
        pinnedFields = await fieldsForVersion(db, openCase.currentVersionId);
        fieldsByVersion.set(openCase.currentVersionId, pinnedFields);
      }
      const caseProblems = validateManifest(manifest, pinnedFields);
      if (caseProblems.length > 0) {
        incompatible.push({
          id: openCase.id,
          candidateUserId: openCase.candidateUserId,
          versionId: openCase.currentVersionId,
          problems: caseProblems,
        });
      }
    }
    if (incompatible.length > 0) {
      res.status(409).json({ error: 'open_cases_incompatible', cases: incompatible });
      return;
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(schema.formTemplateVersions)
        .set({
          fields,
          revisionIdentity: parsed.data.revisionIdentity ?? null,
          state: 'published',
          publishedAt: now,
          publishedBy: tenant.userId,
        })
        .where(eq(schema.formTemplateVersions.id, version.id));
      // Publishing on an archived template restores it — same deliberate
      // behaviour as the per-version publish endpoint; the web layer warns.
      await tx
        .update(schema.formTemplates)
        .set({ currentVersionId: version.id, status: 'published', updatedAt: now })
        .where(eq(schema.formTemplates.id, template.id));
      await tx
        .update(schema.assessmentTools)
        .set({
          manifest,
          ...(parsed.data.name ? { name: parsed.data.name } : {}),
          /*
            The author's chosen untick, applied with the publish it belongs
            to. Rules keep every part the revised manifest still declares;
            only the removed parts' entries go — and a Location whose list
            empties keeps an empty list, which "requires every part" does NOT
            mean here: an explicit rule row means the author has narrowed it.
          */
          ...(trimRules
            ? {
                locationPartKeys: Object.fromEntries(
                  Object.entries(tool.locationPartKeys ?? {}).map(([locationId, keys]) => [
                    locationId,
                    keys.filter((k) => partKeys.has(k)),
                  ]),
                ),
              }
            : {}),
        })
        .where(eq(schema.assessmentTools.id, tool.id));
      // The revision shipped — free the one-revision-per-tool slot so next
      // year's review seeds fresh instead of 409ing at a published draft.
      await tx
        .delete(schema.assessmentToolDrafts)
        .where(
          and(
            eq(schema.assessmentToolDrafts.orgId, tenant.orgId),
            eq(schema.assessmentToolDrafts.revisionOfToolId, tool.id),
          ),
        );
    });

    await recordAudit(db, tenant, {
      action: 'Republished assessment tool',
      target: `${parsed.data.name ?? tool.name} ${version.versionLabel}${
        parsed.data.revisionIdentity?.note ? ` — ${parsed.data.revisionIdentity.note}` : ''
      }`,
      category: 'forms',
      icon: 'rocket',
    });

    res.json({
      id: tool.id,
      templateId: tool.templateId,
      versionId: version.id,
      versionLabel: version.versionLabel,
      // The same unplaced-box audit create-time publishing surfaces — a
      // warning, never a gate (R8) — plus the open-case progress this
      // revision's removed parts strand.
      warnings: [...unplacedMarkDestinations(manifest, fields), ...openCaseAttemptWarnings],
    });
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
        // The competency this tool grants, so the new-case form can suggest a
        // pathway from whether the candidate already holds it.
        awardedCompetencyIds: t.awardedCompetencyIds ?? [],
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

// ── award links (U2 — R1, R2, R3, R15, KTD3, KTD5, KTD10) ───────────────────

/**
 * The tools still awarding NOTHING — the backfill worklist (KTD5, R3).
 *
 * Admin-gated: accepting a row converts Role requirements and creates cases,
 * so reading the worklist sits on the same gate as acting on it. Each row
 * carries at most one SUGGESTION — an exact case-insensitive match of the
 * tool's name against a competency's name or code — and never guesses beyond
 * that (R3): a fuzzy match accepted by reflex would link the wrong award,
 * which activates the wrong assignment.
 *
 * REGISTERED ABOVE `GET /:id`: express matches in registration order, so
 * declared after it, "unlinked" would be captured as an :id and cast against
 * a uuid column.
 */
assessmentToolsRouter.get(
  '/unlinked',
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
    const [tools, competencies] = await Promise.all([
      db.query.assessmentTools.findMany({ where: eq(schema.assessmentTools.orgId, tenant.orgId) }),
      db.query.competencies.findMany({ where: eq(schema.competencies.orgId, tenant.orgId) }),
    ]);
    const unlinked = tools.filter((t) => (t.awardedCompetencyIds ?? []).length === 0);
    res.json(
      unlinked.map((t) => {
        const wanted = t.name.trim().toLowerCase();
        const match = competencies.find(
          (c) =>
            c.name.trim().toLowerCase() === wanted ||
            (c.code ?? '').trim().toLowerCase() === wanted,
        );
        return {
          id: t.id,
          name: t.name,
          templateId: t.templateId,
          suggestion: match ? { competencyId: match.id, name: match.name } : null,
        };
      }),
    );
  }),
);

const awardBody = z.object({
  competencyId: z.string().uuid(),
  /** Re-link only: carry the outgoing competency's required Role links across. */
  carryRoleLinks: z.boolean().optional(),
  /** Re-link only: the reviewed-preview acknowledgement the PUT demands (KTD10). */
  confirm: z.boolean().optional(),
});

/**
 * The guard the award preview and apply share, so they cannot drift on who may
 * link an award or which competency is valid: Admin (linking converts Role
 * requirements and creates cases — R73's blast-radius standard, not the
 * authoring permission), the tool is the organisation's, and the competency
 * is too (`invalid_award` mirrors the create-path check). Sends the error
 * response and returns null on any failure.
 */
async function loadAwardChange(database: Database, req: Request, res: Response) {
  const tenant = req.tenant!;
  if (!isAdmin(tenant.role)) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  const parsed = awardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return null;
  }
  const tool = await loadTool(database, req.params.id!, tenant.orgId);
  if (!tool) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const competency = await database.query.competencies.findFirst({
    where: and(
      eq(schema.competencies.id, parsed.data.competencyId),
      eq(schema.competencies.orgId, tenant.orgId),
    ),
  });
  if (!competency) {
    res.status(400).json({ error: 'invalid_award' });
    return null;
  }
  return { tenant, tool, competency, body: parsed.data, current: tool.awardedCompetencyIds ?? [] };
}

/**
 * A RE-LINK may not run over live work (KTD10): a non-terminal case was opened
 * against the outgoing award and will grant it at sign-off; re-pointing
 * mid-flight would make the signed evidence attest one competency and the
 * grant another. Terminal states (competent, closed, invalidated) are history
 * and never block. Sends the 409 and returns true when blocked.
 */
async function relinkBlockedByOpenCases(
  database: Database,
  orgId: string,
  toolId: string,
  res: Response,
): Promise<boolean> {
  const openCases = await database.query.assessmentCases.findMany({
    where: and(
      eq(schema.assessmentCases.orgId, orgId),
      eq(schema.assessmentCases.toolId, toolId),
      inArray(schema.assessmentCases.state, NON_TERMINAL_STATES),
    ),
  });
  if (openCases.length > 0) {
    res.status(409).json({ error: 'open_cases', count: openCases.length });
    return true;
  }
  return false;
}

/**
 * Preview an award link or re-link (U2, KTD10) — the SAME computation the PUT
 * applies, writing nothing. First link answers {rolesLinked, affected,
 * created}; re-link answers {outgoingGrants, rolesRequiringOutgoing, created}.
 * A preview a PUT would 409 must 409 too, so the open-case guard runs here as
 * well.
 */
assessmentToolsRouter.post(
  '/:id/award/preview',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const change = await loadAwardChange(db, req, res);
    if (!change) return;
    const { tenant, tool, body, current } = change;
    const now = new Date();

    if (current.includes(body.competencyId)) {
      // Already linked to this competency — a repeat converts nothing (U2).
      res.json({ rolesLinked: 0, affected: 0, created: 0, alreadyLinked: true });
      return;
    }
    if (current.length === 0) {
      const { effects } = await computeAwardLinkChange(
        db,
        tenant.orgId,
        tool.id,
        body.competencyId,
        now,
      );
      res.json(effects);
      return;
    }
    if (await relinkBlockedByOpenCases(db, tenant.orgId, tool.id, res)) return;
    const { effects } = await computeAwardRelinkChange(
      db,
      tenant.orgId,
      tool.id,
      current[0]!,
      body.competencyId,
      body.carryRoleLinks ?? false,
      now,
    );
    res.json(effects);
  }),
);

/**
 * Link (or re-link) the ONE competency this tool awards (U2, R2).
 *
 * FIRST LINK is the backfill/conversion case (R15, KTD3): in ONE transaction
 * the award is written, every legacy `role_required_assessments` row for this
 * tool becomes a direct required link (upgrading an existing recommended row
 * rather than colliding with the unique index), the legacy rows are deleted,
 * and the activated cases are inserted — exactly the plan the preview counted.
 *
 * RE-LINK is guarded (KTD10): refused while the tool has non-terminal cases,
 * and requires `confirm: true` — the caller attesting they reviewed the
 * preview. With `carryRoleLinks` the outgoing competency's required links are
 * re-pointed in the same transaction; grants of the outgoing competency are
 * NEVER touched — history is state.
 *
 * A repeat PUT naming the already-linked competency is an idempotent no-op.
 */
assessmentToolsRouter.put(
  '/:id/award',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const change = await loadAwardChange(db, req, res);
    if (!change) return;
    const { tenant, tool, competency, body, current } = change;
    const now = new Date();

    if (current.includes(body.competencyId)) {
      // Idempotent: the award already stands; converting again would find no
      // legacy rows anyway, and a retried click must not 409 or double-write.
      res.json({ rolesLinked: 0, affected: 0, created: 0, alreadyLinked: true });
      return;
    }

    if (current.length === 0) {
      /*
        ── first link: convert and activate (compute-then-apply, KTD10) ──────

        THE TRANSACTION OPENS FIRST AND THE COMPUTE RUNS INSIDE IT. Computed on
        the root client beforehand, two concurrent first-links for the same
        tool both read an unlinked tool, both planned a full conversion, and
        both applied it — a second set of activated cases against legacy rows
        the first run had already drained. Re-reading the tool on `tx` puts the
        race detection on the same snapshot as the write, at REPEATABLE READ so
        that snapshot holds for the whole block rather than being re-taken per
        statement.
      */
      const outcome = await db.transaction(
        async (tx) => {
          const fresh = await loadTool(tx, tool.id, tenant.orgId);
          const freshAwards = fresh?.awardedCompetencyIds ?? [];
          if (freshAwards.length > 0) {
            /*
              Another writer linked this tool between the gate's read and this
              one. Whatever it chose, THIS call is no longer a first link:
              converting again would re-run a conversion the winner already
              performed. Answered with the existing idempotent already-linked
              branch — a retried click must not 409, and the tool does hold an
              award, which is what that branch reports. A caller that meant to
              CHANGE the award re-issues the request and reaches the guarded
              re-link door below, preview and confirm included.
            */
            return { kind: 'already' as const };
          }
          const plan = await computeAwardLinkChange(
            tx,
            tenant.orgId,
            tool.id,
            body.competencyId,
            now,
          );
          await applyFirstLink(tx, tenant.orgId, tool.id, body.competencyId, plan);
          return { kind: 'applied' as const, effects: plan.effects };
        },
        { isolationLevel: 'repeatable read' },
      );
      if (outcome.kind === 'already') {
        res.json({ rolesLinked: 0, affected: 0, created: 0, alreadyLinked: true });
        return;
      }
      await recordAudit(db, tenant, {
        action: 'Linked assessment award',
        target: `${tool.name} → ${competency.name}`,
        category: 'settings',
        icon: 'clipboard-check',
      });
      res.json(outcome.effects);
      return;
    }

    // ── re-link: guarded correction (KTD10) ──────────────────────────────────
    if (await relinkBlockedByOpenCases(db, tenant.orgId, tool.id, res)) return;
    if (body.confirm !== true) {
      // The preview names outgoing grants and orphaned requirements; the PUT
      // demands the caller has seen it. A bare re-link is refused, not warned.
      res.status(400).json({ error: 'confirm_required' });
      return;
    }
    const carry = body.carryRoleLinks ?? false;
    /*
      SAME POSTURE AS THE FIRST LINK: transaction first, compute inside, tool
      re-read on the same snapshot. The re-read also catches the case where the
      award moved out from under this caller since the gate read it — the
      preview they confirmed described the OLD outgoing competency, so applying
      would carry role links the admin never saw named.
    */
    const outcome = await db.transaction(
      async (tx) => {
        const fresh = await loadTool(tx, tool.id, tenant.orgId);
        const freshAwards = fresh?.awardedCompetencyIds ?? [];
        if (freshAwards.includes(body.competencyId)) return { kind: 'already' as const };
        const outgoingCompetencyId = freshAwards[0];
        // Drained to nothing since the gate read it: this is a first link now,
        // and a first link is not what was confirmed. The idempotent branch is
        // the honest no-op; the caller re-issues and takes the first-link door.
        if (!outgoingCompetencyId) return { kind: 'already' as const };

        const plan = await computeAwardRelinkChange(
          tx,
          tenant.orgId,
          tool.id,
          outgoingCompetencyId,
          body.competencyId,
          carry,
          now,
        );
        await tx
          .update(schema.assessmentTools)
          .set({ awardedCompetencyIds: [body.competencyId] })
          .where(eq(schema.assessmentTools.id, tool.id));
        if (carry) {
          for (const step of plan.carryPlan) {
            if (step.action === 'repoint') {
              await tx
                .update(schema.competencyRequirements)
                .set({ competencyId: body.competencyId })
                .where(eq(schema.competencyRequirements.id, step.linkId));
            } else if (step.action === 'merge-upgrade' && step.targetLinkId) {
              await tx
                .update(schema.competencyRequirements)
                .set({ tier: 'required' })
                .where(eq(schema.competencyRequirements.id, step.targetLinkId));
              await tx
                .delete(schema.competencyRequirements)
                .where(eq(schema.competencyRequirements.id, step.linkId));
            } else {
              // merge-delete: the role already requires the incoming competency.
              await tx
                .delete(schema.competencyRequirements)
                .where(eq(schema.competencyRequirements.id, step.linkId));
            }
          }
          for (const c of plan.casesToInsert) {
            await tx.insert(schema.assessmentCases).values(assignmentCaseValues(c.orgId, c.candidateUserId, c));
          }
        }
        // Grants of the outgoing competency are deliberately untouched (KTD10):
        // they attest what was assessed at the time, and re-pointing the award
        // must not rewrite anyone's history.
        return { kind: 'applied' as const, effects: plan.effects };
      },
      { isolationLevel: 'repeatable read' },
    );
    if (outcome.kind === 'already') {
      res.json({ rolesLinked: 0, affected: 0, created: 0, alreadyLinked: true });
      return;
    }
    await recordAudit(db, tenant, {
      action: 'Linked assessment award',
      target: `${tool.name} → ${competency.name}`,
      category: 'settings',
      icon: 'clipboard-check',
    });
    res.json(outcome.effects);
  }),
);

/**
 * The first link's writes, in the caller's transaction: the award, the
 * conversion of every legacy `role_required_assessments` row into a direct
 * required link, the drain of those rows, and the activated cases — exactly
 * the plan the preview counted (KTD3, KTD10).
 */
async function applyFirstLink(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  orgId: string,
  toolId: string,
  competencyId: string,
  plan: Awaited<ReturnType<typeof computeAwardLinkChange>>,
): Promise<void> {
  await tx
    .update(schema.assessmentTools)
    .set({ awardedCompetencyIds: [competencyId] })
    .where(eq(schema.assessmentTools.id, toolId));
  for (const step of plan.roleLinkPlan) {
    if (step.action === 'insert') {
      await tx.insert(schema.competencyRequirements).values({
        orgId,
        roleId: step.roleId,
        competencyId,
        tier: 'required',
      });
    } else if (step.action === 'upgrade' && step.existingLinkId) {
      // A recommended row already names this pair — promote its tier;
      // inserting would collide with competency_requirements_role_uq.
      await tx
        .update(schema.competencyRequirements)
        .set({ tier: 'required' })
        .where(eq(schema.competencyRequirements.id, step.existingLinkId));
    }
    // 'exists': already required — nothing to write.
  }
  // The legacy rows are DRAINED, not kept alongside the links: the dual read
  // would deduplicate them, but leaving them makes every later requirement
  // edit fingerprint-race against rows nobody owns (KTD9).
  await tx
    .delete(schema.roleRequiredAssessments)
    .where(
      and(
        eq(schema.roleRequiredAssessments.orgId, orgId),
        eq(schema.roleRequiredAssessments.toolId, toolId),
      ),
    );
  // The activation's cases — exactly the plan the preview counted.
  for (const c of plan.casesToInsert) {
    await tx.insert(schema.assessmentCases).values(assignmentCaseValues(c.orgId, c.candidateUserId, c));
  }
}

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
    /*
      EDIT-GATED, LIKE THE PATCH BESIDE IT, because the response below is the
      one tool read that serves UNSTRIPPED fields — answerKey and modelAnswer
      included. The plan gate alone let any org member, a candidate-role login
      included, fetch the complete key to an assessment they may later sit.
      Its only consumers are authoring surfaces (the workflow builder, the
      revision seed), and authoring is what `assessments.edit` means.
    */
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
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
    /*
      THE MARKS THAT PRINT NOWHERE. The exporter skips a field with no
      geometry silently — the safe failure on the page is an invisible one
      here, so the editor is where the silence gets named: every auto-mark
      destination with no drawable box, from the same resolver the exporter
      draws with.
    */
    warnings.push(...unplacedMarkDestinations(tool.manifest, fields));
    // And the marking compositions that misbehave at runtime (auto-fail on
    // hand-in, untickable table-cell marks) — same list the builder's publish
    // step shows, so the two authoring surfaces cannot disagree.
    warnings.push(...markingCompositionWarnings(tool.manifest, fields));

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
      parsed.data.fieldDefaults !== undefined ||
      parsed.data.partCompletionMarks !== undefined ||
      parsed.data.signOff !== undefined ||
      parsed.data.pathwayMarks !== undefined ||
      parsed.data.partOutcomeMarks !== undefined ||
      parsed.data.course !== undefined;
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
    if (parsed.data.partCompletionMarks !== undefined) {
      const { partCompletionMarks: _dropped, ...rest } = manifest;
      manifest = parsed.data.partCompletionMarks
        ? { ...rest, partCompletionMarks: parsed.data.partCompletionMarks }
        : rest;
    }
    if (parsed.data.signOff !== undefined) {
      const { signOff: _dropped, ...rest } = manifest;
      manifest = parsed.data.signOff ? { ...rest, signOff: parsed.data.signOff } : rest;
    }
    if (parsed.data.pathwayMarks !== undefined) {
      const { pathwayMarks: _dropped, ...rest } = manifest;
      manifest = parsed.data.pathwayMarks
        ? { ...rest, pathwayMarks: parsed.data.pathwayMarks }
        : rest;
    }
    if (parsed.data.course !== undefined) {
      // Setting a link is validated against the org's actual courses: a
      // dangling id would read as "configured" in the builder while the
      // runtime, which degrades a missing course to unenforced, gated nothing.
      if (parsed.data.course) {
        const courseRow = await db.query.courses.findFirst({
          where: and(
            eq(schema.courses.id, parsed.data.course.courseId),
            eq(schema.courses.orgId, tenant.orgId),
          ),
        });
        if (!courseRow || courseRow.status !== 'active') {
          res.status(400).json({
            error: 'invalid_workflow',
            problems: ['The selected course no longer exists — refresh and pick again.'],
          });
          return;
        }
      }
      const { course: _dropped, ...rest } = manifest;
      manifest = parsed.data.course ? { ...rest, course: parsed.data.course } : rest;
    }
    const partOutcomeEntries = parsed.data.partOutcomeMarks;
    if (partOutcomeEntries !== undefined) {
      // An entry naming a part the tool does not have is a picker bug, not a
      // mapping to silently drop.
      const known = new Set(manifest.parts.map((p) => p.key));
      const ghosts = (partOutcomeEntries ?? []).filter((e) => !known.has(e.partKey));
      if (ghosts.length > 0) {
        res.status(400).json({
          error: 'invalid_workflow',
          problems: ghosts.map((g) => `Verdict pair names part "${g.partKey}", which this tool has no part for.`),
        });
        return;
      }
      manifest = {
        ...manifest,
        parts: manifest.parts.map((p) => {
          if (partOutcomeEntries === null) {
            const { outcomeSatisfactory: _s, outcomeNotSatisfactory: _n, ...rest } = p;
            return rest;
          }
          const entry = partOutcomeEntries.find((e) => e.partKey === p.key);
          if (!entry) return p;
          const { outcomeSatisfactory: _s, outcomeNotSatisfactory: _n, ...rest } = p;
          return {
            ...rest,
            ...(entry.outcomeSatisfactory ? { outcomeSatisfactory: entry.outcomeSatisfactory } : {}),
            ...(entry.outcomeNotSatisfactory
              ? { outcomeNotSatisfactory: entry.outcomeNotSatisfactory }
              : {}),
          };
        }),
      };
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
      ...validatePartCompletionMarks(manifest.partCompletionMarks, manifest, fields),
      ...validatePathwayMarks(manifest.pathwayMarks, fields),
      ...validateSignOffMarks(manifest.signOff, fields),
      ...validatePartOutcomeMarks(manifest, fields),
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

    // The same unplaced-box audit the GET serves, so saving cannot hide it.
    warnings.push(...unplacedMarkDestinations(manifest, fields));
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
 * Set or change WHERE an open case is assessed (R77).
 *
 * Exists because the Location decides what the case requires — the per-part
 * rule, the assessor requirement, the printed stream — and cases opened
 * before the rule was enforced (or with the picker skipped) carry none: they
 * demand every part and keep printing attempts the Location would exclude.
 * The fix for such a case is its Location, not a new case.
 *
 * STAFF ONLY, and only while the case is OPEN. A candidate must not move
 * their own assessment to an easier rule, and a resolved or signed case is a
 * record — where it was assessed is part of what was signed.
 */
assessmentCasesRouter.patch(
  '/:id/location',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const scope = await permissionScope(tenant, 'assessments', 'edit');
    if (scope !== 'all') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = z
      .object({ locationId: z.string().uuid().nullable() })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (row.state !== 'open') {
      res.status(409).json({ error: 'case_not_open' });
      return;
    }
    // Chosen from the org's list, never typed (R77) — same rule as create.
    if (parsed.data.locationId) {
      const location = await db.query.locations.findFirst({
        where: and(
          eq(schema.locations.id, parsed.data.locationId),
          eq(schema.locations.orgId, tenant.orgId),
          eq(schema.locations.status, 'active'),
        ),
      });
      if (!location) {
        res.status(400).json({ error: 'location_not_found', locationId: parsed.data.locationId });
        return;
      }
    }

    await db
      .update(schema.assessmentCases)
      .set({ locationId: parsed.data.locationId })
      .where(eq(schema.assessmentCases.id, row.id));

    await recordAudit(db, tenant, {
      action: 'Moved assessment case',
      target: `${row.id} → location ${parsed.data.locationId ?? 'none'}`,
      category: 'submissions',
      icon: 'map-pin',
    });

    res.json({ id: row.id, locationId: parsed.data.locationId });
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

    /*
      Attempts for these cases, so each row can name the STAGE it is at and
      whether it is waiting on an assessor — the two things the case list is
      scanned for. Loaded once for the page and bucketed by case, the same shape
      the progress endpoint uses; the case-state computation stays server-side.
    */
    const caseIds = rows.map((r) => r.id);
    const attemptRows = caseIds.length
      ? await db.query.assessmentPartAttempts.findMany({
          where: inArray(schema.assessmentPartAttempts.caseId, caseIds),
          orderBy: (a, { asc }) => [asc(a.partKey), asc(a.attemptNumber)],
        })
      : [];
    const attemptsByCase = new Map<string, typeof attemptRows>();
    for (const a of attemptRows) {
      const bucket = attemptsByCase.get(a.caseId);
      if (bucket) bucket.push(a);
      else attemptsByCase.set(a.caseId, [a]);
    }

    res.json(
      rows.map((c) => {
        const tool = toolById.get(c.toolId);
        const attempts = attemptsByCase.get(c.id) ?? [];
        // The pathway's required parts with their derived states — the same
        // computation the progress screen uses, so the two agree. Narrowed to
        // the case's Location: an excluded part is not owed and not listed.
        const progress = tool
          ? caseProgress(
              tool.manifest,
              c.pathway as AssessmentPathway,
              toAttemptFacts(attempts),
              applicablePartsFor(tool, c),
            )
          : [];
        // The stage: first part not yet satisfactory, and where it sits.
        const current = progress.find((p) => p.state !== 'satisfactory');
        return {
          id: c.id,
          toolName: tool?.name ?? '',
          candidateUserId: c.candidateUserId,
          candidateName: identifyMember(caseIdentities, c.candidateUserId, nameById.get(c.candidateUserId) ?? '').name,
          pathway: c.pathway,
          state: c.state,
          /** Null on a pooled case — the table shows it as unassigned (U13). */
          assessorUserId: c.assessorUserId,
          createdAt: c.createdAt,
          /** The part the case is at now — null once every required part passed. */
          currentPartLabel: current?.part.label ?? null,
          /** 1-based position of that part among the pathway's required parts. */
          currentPartIndex: current ? progress.indexOf(current) + 1 : null,
          /** How many parts this pathway requires — the "of 6" in "Part 3 of 6". */
          requiredPartCount: progress.length,
          /** Waiting on a person: final sign-off, or a part handed in unmarked. */
          awaitingAssessor: caseAwaitsAssessor(c.state, attempts),
        };
      }),
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
 * Summed across EVERY table in the attempt's values that carries the duration
 * column, not the one table the manifest names first. A part's values hold only
 * that part's fields, so every such table is one of this part's logs — and a
 * part may keep several (Part 5's supervised and minimal-supervision logs both
 * accrue against the same minimum). Totalling only the first under-reports a
 * candidate's experience, the wrong direction against a safety threshold. Being
 * value-based, it needs no field list, so the dashboard agrees with the meter
 * the candidate watches and the threshold the save route fires — all three read
 * `logbookDurationRows`.
 */
function loggedHoursFor(
  part: AssessmentPart,
  attempts: readonly {
    attemptNumber: number;
    values: Record<string, SubmissionValue>;
  }[],
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

  // The same rule the threshold notification and the candidate's progress meter
  // use. Three copies of "which rows are the logbook" disagreed; this is the one.
  return totalLoggedHours(logbookDurationRows(part, latest.values), part.durationColumnKey);
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

    res.json(
      cases.map((c) => {
        const tool = toolById.get(c.toolId);
        const attempts = byCase.get(c.id) ?? [];
        // A tool row cannot actually vanish — the case's FK is `restrict` — but
        // if one ever did, the candidate stays on the dashboard with no parts
        // rather than disappearing from it or failing the whole request.
        const progress = tool
          ? caseProgress(
              tool.manifest,
              c.pathway as AssessmentPathway,
              toAttemptFacts(attempts),
              applicablePartsFor(tool, c),
            )
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
    const progress = caseProgress(
      tool.manifest,
      row.pathway as AssessmentPathway,
      toAttemptFacts(attempts),
      applicablePartsFor(tool, row),
    );

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

    // The case's reading state, when the tool links course material — enough
    // for the case screen to show the course card and explain a gated part.
    let courseBlock: {
      courseId: string;
      required: boolean;
      missing: boolean;
      title: string | null;
      kind: string | null;
      totalSlides: number | null;
      viewedCount: number;
      completedAt: string | null;
    } | null = null;
    const detailCourseLink = tool.manifest.course;
    if (detailCourseLink) {
      const courseRow = await db.query.courses.findFirst({
        where: and(
          eq(schema.courses.id, detailCourseLink.courseId),
          eq(schema.courses.orgId, tenant.orgId),
        ),
      });
      const active = courseRow && courseRow.status === 'active' ? courseRow : null;
      const reading = active
        ? await db.query.assessmentCaseCourseProgress.findFirst({
            where: and(
              eq(schema.assessmentCaseCourseProgress.caseId, row.id),
              eq(schema.assessmentCaseCourseProgress.courseId, active.id),
            ),
          })
        : null;
      courseBlock = {
        courseId: detailCourseLink.courseId,
        required: detailCourseLink.required,
        missing: !active,
        title: active?.title ?? null,
        kind: active?.kind ?? null,
        totalSlides: active?.slideCount ?? null,
        viewedCount: reading?.visitedSlides.length ?? 0,
        completedAt: reading?.completedAt ? reading.completedAt.toISOString() : null,
      };
    }

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
      course: courseBlock,
      parts: progress.map((p) => ({
        key: p.part.key,
        label: p.part.label,
        kind: p.part.kind,
        ordinal: p.part.ordinal,
        minimumHours: p.part.minimumHours ?? null,
        durationUnit: p.part.durationUnit ?? null,
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

/**
 * The case's course material, with a freshly minted content link.
 *
 * Split from the case detail because THIS is the route that mints a
 * capability: opening the player is when a time-boxed token should start
 * its clock, not every case screen render. `launchUrl` is a PATH the web
 * app prefixes with its API base, for the same proxy reason the induction
 * document links are paths.
 */
assessmentCasesRouter.get(
  '/:id/course',
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
    if (!row || (scope === 'own' && row.candidateUserId !== tenant.userId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }
    const courseLink = tool.manifest.course;
    if (!courseLink) {
      res.json({ course: null });
      return;
    }
    const courseRow = await db.query.courses.findFirst({
      where: and(
        eq(schema.courses.id, courseLink.courseId),
        eq(schema.courses.orgId, tenant.orgId),
      ),
    });
    if (!courseRow || courseRow.status !== 'active') {
      res.json({
        course: {
          courseId: courseLink.courseId,
          required: courseLink.required,
          missing: true,
          title: null,
          kind: null,
          totalSlides: null,
          viewedCount: 0,
          completedAt: null,
          launchUrl: null,
          expiresAt: null,
        },
      });
      return;
    }
    const reading = await db.query.assessmentCaseCourseProgress.findFirst({
      where: and(
        eq(schema.assessmentCaseCourseProgress.caseId, row.id),
        eq(schema.assessmentCaseCourseProgress.courseId, courseRow.id),
      ),
    });
    const { prefix, expiresAt } = mintCourseContentPath(tenant.orgId, courseRow.id);
    const encodedLaunch = courseRow.launchPath.split('/').map(encodeURIComponent).join('/');
    res.json({
      course: {
        courseId: courseRow.id,
        required: courseLink.required,
        missing: false,
        title: courseRow.title,
        kind: courseRow.kind,
        totalSlides: courseRow.slideCount,
        viewedCount: reading?.visitedSlides.length ?? 0,
        completedAt: reading?.completedAt ? reading.completedAt.toISOString() : null,
        launchUrl: `${prefix}/${encodedLaunch}`,
        expiresAt,
      },
    });
  }),
);

const courseProgressBody = z.object({
  /** Zero-based slide indexes the player saw since its last report. */
  visitedSlides: z.array(z.number().int().min(0).max(4999)).max(1000).optional(),
  /**
   * The read-through confirmation, for packages with no slide stream (SCORM
   * or plain HTML). Ignored for a deck — a deck completes by being paged
   * through, and accepting the shortcut would let one click skip the manual.
   */
  confirmRead: z.boolean().optional(),
});

/**
 * Records reading progress on the case's course.
 *
 * Monotonic by construction: reported slides UNION into what is stored, and
 * `completedAt`, once earned, is never recomputed away. Completion itself is
 * derived HERE from the course's own rule — never accepted from the client —
 * so the gate on opening attempts cannot be satisfied by a crafted request
 * claiming totals the reading never reached... beyond the honesty of the
 * indexes themselves, which is the same trust every filled answer gets.
 */
assessmentCasesRouter.patch(
  '/:id/course-progress',
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
    const parsed = courseProgressBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row || (scope === 'own' && row.candidateUserId !== tenant.userId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Reading is part of sitting the assessment, so it belongs to an OPEN
    // case only — a resolved case's record is history, not a workbook.
    if (row.state !== 'open') {
      res.status(409).json({ error: 'case_not_open' });
      return;
    }
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }
    const courseLink = tool.manifest.course;
    if (!courseLink) {
      res.status(404).json({ error: 'course_not_configured' });
      return;
    }
    const courseRow = await db.query.courses.findFirst({
      where: and(
        eq(schema.courses.id, courseLink.courseId),
        eq(schema.courses.orgId, tenant.orgId),
      ),
    });
    if (!courseRow || courseRow.status !== 'active') {
      res.status(404).json({ error: 'course_missing' });
      return;
    }

    const existing = await db.query.assessmentCaseCourseProgress.findFirst({
      where: and(
        eq(schema.assessmentCaseCourseProgress.caseId, row.id),
        eq(schema.assessmentCaseCourseProgress.courseId, courseRow.id),
      ),
    });

    // Union, bounded by what the course actually has: an index past the deck
    // is a player bug and must not be able to pad the count toward coverage.
    const slideCount = courseRow.slideCount;
    const visited = new Set<number>(existing?.visitedSlides ?? []);
    if (slideCount !== null) {
      for (const idx of parsed.data.visitedSlides ?? []) {
        if (idx < slideCount) visited.add(idx);
      }
    }
    const visitedList = [...visited].sort((a, b) => a - b);

    const wasComplete = existing?.completedAt != null;
    let complete = wasComplete;
    if (!complete) {
      if (courseRow.kind === 'deck' && slideCount !== null) {
        complete = visitedList.length >= slideCount;
      } else if (courseRow.kind !== 'deck') {
        complete = parsed.data.confirmRead === true;
      }
    }
    const completedAt = existing?.completedAt ?? (complete ? new Date() : null);

    if (existing) {
      await db
        .update(schema.assessmentCaseCourseProgress)
        .set({
          visitedSlides: visitedList,
          updatedAt: new Date(),
          ...(complete && !wasComplete
            ? { completedAt, completedByUserId: tenant.userId }
            : {}),
        })
        .where(eq(schema.assessmentCaseCourseProgress.id, existing.id));
    } else {
      await db.insert(schema.assessmentCaseCourseProgress).values({
        orgId: tenant.orgId,
        caseId: row.id,
        courseId: courseRow.id,
        visitedSlides: visitedList,
        ...(complete ? { completedAt, completedByUserId: tenant.userId } : {}),
      });
    }

    if (complete && !wasComplete) {
      await recordAudit(db, tenant, {
        action: 'Completed course material',
        target: courseRow.title,
        category: 'submissions',
        icon: 'book-open',
      });
    }

    res.json({
      viewedCount: visitedList.length,
      totalSlides: slideCount,
      completedAt: completedAt ? completedAt.toISOString() : null,
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
 *
 * THE CANDIDATE MAY OPEN THEIR OWN NEXT STEP. `own`-scoped edit reaches this
 * for the caller's own case, gated below on the workflow actually giving the
 * candidate something to fill in the part. Waiting for an assessor to open
 * every attempt made the assessor a turnstile: theory auto-marks at hand-in,
 * the declaration unlocks — and then nothing could happen until someone else
 * pressed a button the sequence had already authorised.
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
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }

    const partKey = req.params.partKey!;
    const attempts = await attemptsFor(db, row.id);
    // Narrowed to the case's Location — an excluded part is not in the list,
    // so opening it refuses exactly as opening a part outside the pathway does.
    const progress = caseProgress(
      tool.manifest,
      row.pathway as AssessmentPathway,
      toAttemptFacts(attempts),
      applicablePartsFor(tool, row),
    );
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
      THE COURSE MATERIAL COMES BEFORE THE ASSESSMENT. A tool whose manifest
      requires its course refuses to start ANY new attempt until this case's
      reading record is complete — that is the whole meaning of "required".

      Checked after the reuse return above, not before it: an attempt that was
      already open when the requirement appeared (a mid-case workflow edit)
      stays continuable, because refusing it would strand work in progress
      rather than order it.

      A link whose course has been archived or deleted degrades to UNENFORCED
      rather than locking the assessment shut — a dangling pointer must never
      be able to stop every case on the tool, and the case surface shows the
      link as missing so someone fixes it.
    */
    const courseLink = tool.manifest.course;
    if (courseLink?.required) {
      const courseRow = await db.query.courses.findFirst({
        where: and(
          eq(schema.courses.id, courseLink.courseId),
          eq(schema.courses.orgId, tenant.orgId),
        ),
      });
      if (courseRow && courseRow.status === 'active') {
        const reading = await db.query.assessmentCaseCourseProgress.findFirst({
          where: and(
            eq(schema.assessmentCaseCourseProgress.caseId, row.id),
            eq(schema.assessmentCaseCourseProgress.courseId, courseRow.id),
          ),
        });
        if (!reading?.completedAt) {
          res.status(409).json({ error: 'course_not_complete', courseTitle: courseRow.title });
          return;
        }
      }
    }

    /*
      A candidate opens only what the workflow hands THEM. The section covering
      the part must give the candidate role something to fill — at the section
      level or on any field — or the attempt would be an empty row on someone
      else's step. A tool with no authored workflow derives one that lets both
      roles fill every part, which is exactly the pre-workflow behaviour.
    */
    if (scope === 'own') {
      const fields = await fieldsForVersion(db, row.currentVersionId);
      const section = sectionForPart(workflowOf(tool.manifest, fields), partKey);
      const candidateMayFill = section
        ? section.access.candidate === 'fill' ||
          Object.values(section.fieldAccess ?? {}).some((per) => per.candidate === 'fill')
        : true;
      if (!candidateMayFill) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
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
    // A keyed theory retry keeps its correct answers — see carryForwardTheory.
    const carriedTheory = carried
      ? undefined
      : await carryForwardTheory(db, {
          manifest: tool.manifest,
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
        ...carriedTheory,
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

      Supervisor and SME sign-offs are applied by on-case staff as LABELLED
      signatures when the org allows it (`fillParties`) — the assessor signing
      on their behalf, as on paper. With that policy off, staff resolve to the
      assessor alone, so a supervisor/SME-assigned field is left to nobody
      rather than signed by the wrong party — the safe direction until
      login-based attribution ships.
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
    // The parties this caller may fill as: candidate, on-case staff (assessor
    // plus labelled supervisor/SME), or both when self-assessing — all by org
    // policy. `unionPartFieldAccess` over one party equals `partFieldAccess`.
    const access = unionPartFieldAccess(
      workflow,
      attempt.partKey,
      partFields,
      fillParties({
        party,
        selfAssessing: await isSelfAssessing(db, tenant, row.candidateUserId),
        labelled: await labelledSignoffAllowed(db, tenant.orgId),
      }),
    );
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
    /*
      THE COMPLETION CHECKLIST TICKS ITSELF (manifest.partCompletionMarks).
      Derived from the case's attempt rows on every read — the same source part
      state itself comes from — and served over the stored value, so this
      surface can never show a tick the progress does not back.
    */
    /*
      Case progress, once — the completion ticks and the "what's next" step below
      both read it, and it is the same derivation the part's own state comes from.
    */
    const caseAttempts = await attemptsFor(db, row.id);
    // THIS case's required set — pathway narrowed by the tool's per-Location
    // rule — read once for the progress, the "what's next" step and the
    // completion ticks below, so all three agree about an excluded part.
    const applicable = applicablePartsFor(tool, row);
    const progress = caseProgress(
      manifest,
      row.pathway as AssessmentPathway,
      toAttemptFacts(caseAttempts),
      applicable,
    );

    const completionIds = new Set((manifest.partCompletionMarks ?? []).map((m) => m.fieldId));
    const completionValues: Record<string, SubmissionValue> = {};
    if (visibleFields.some((f) => completionIds.has(f.id))) {
      for (const f of visibleFields) {
        if (!completionIds.has(f.id)) continue;
        completionValues[f.id] = completionTickRows(
          (manifest.partCompletionMarks ?? []).filter((m) => m.fieldId === f.id),
          progress,
          attempt.values?.[f.id],
          applicable,
        );
      }
    }

    /*
      WHAT COMES NEXT for whoever just finished this part — a "continue" they may
      start, or a note that the next part is someone else's. Decided from the same
      workflow access the open-attempt route enforces, so it never offers a step
      the server would then refuse.
    */
    const nextStep = nextStepAfter(
      progress.map((p) => {
        const pf = fieldsInPart(allFields, manifest, p.part.key);
        return {
          key: p.part.key,
          label: p.part.label,
          state: p.state,
          candidateFills: partFieldAccess(workflow, p.part.key, pf, 'candidate').writable.length > 0,
          staffFills: STAFF_WORKFLOW_ROLES.some(
            (r) => partFieldAccess(workflow, p.part.key, pf, r).writable.length > 0,
          ),
        };
      }),
      attempt.partKey,
      party === 'candidate',
    );
    const prereqValues: Record<string, boolean> = {};
    if (prereqHere) {
      for (const result of await evaluatePrerequisites(db, tenant.orgId, row.candidateUserId, manifest)) {
        if (visibleFields.some((f) => f.id === result.fieldId)) {
          prereqValues[result.fieldId] = result.satisfied;
        }
      }
    }

    /*
      THE MARKING PASS: the assessor opening an attempt that is handed in but
      not yet marked. Decided by PARTY, never by permission — a self-assessing
      candidate is `party === 'candidate'` by identity and gets none of this,
      because whatever else they may fill, the marks on their own paper are not
      theirs to see early or to tick.

      Two things change in that state, and only in that state:
      - `writableFieldIds` narrows to the marking surface (the same set the
        PATCH gate enforces, so the screen and the write rule agree), and
      - the keyed questions' ✓/✗ are PRE-MARKED into the served values —
        display only, merged UNDER the stored map so nothing a person recorded
        is shadowed; they persist when the outcome is recorded, not here.
    */
    /*
      A MARKER, NOT JUST A VIEWER. `party === 'assessor'` is identity — anybody
      on the staff side of the case, a view-only role included. The marking
      guide and the pre-marks are marking material, so they attach only for a
      caller who could actually record a mark: the same org-wide
      `assessments.edit` the marking-pass PATCH enforces (a candidate's
      own-scoped grant resolves false there too). A view-only role reading a
      case gets the stripped fields and nothing else.
    */
    const canMark = party === 'assessor' && (await hasPermission(tenant, 'assessments', 'edit'));
    // Truthiness, not `!== null` — an unsubmitted attempt reads as absence,
    // whichever of null/undefined the row happens to carry.
    const markingPass = canMark && !!attempt.submittedAt && attempt.outcome === null;
    const markingSurface = markingPass ? markingSurfaceIds(workflow, part, partFields) : null;
    // Over the UNSTRIPPED visible fields — marking must see answerKey — and the
    // STORED values, so a pre-mark reflects what the candidate actually handed in.
    const preMarks = markingPass ? markKeyedQuestions(visibleFields, attempt.values).derivedValues : null;

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
      theoryRetry: theoryRetryOf(manifest),
      theoryPassPercent: manifest.theoryPassPercent ?? null,
      attemptNumber: attempt.attemptNumber,
      outcome: attempt.outcome,
      submittedAt: attempt.submittedAt,
      templateVersionId: attempt.templateVersionId,
      /*
        Which side of the assessment this caller is on, so the screen can say
        "marking" instead of "sitting" without re-deriving the identity rule.
      */
      party,
      /*
        THE ASSESSOR'S MARKING GUIDE — each written question's model answer,
        served as a SEPARATE role-gated block rather than by un-stripping the
        fields. `stripMarkingSecrets` stays unconditional above: one strip rule
        with no branches is the property the leak tests pin, and the guide
        travelling beside the fields means no candidate-shaped payload ever has
        a shape that could carry a secret. Absent — not empty — for the
        candidate, including a self-assessing one (`party` is identity), AND
        for staff whose role cannot mark (`canMark` folds the permission in).
      */
      ...(canMark
        ? {
            markingGuide: visibleFields
              .filter((f) => typeof f.modelAnswer === 'string' && f.modelAnswer.trim() !== '')
              .map((f) => ({ fieldId: f.id, modelAnswer: f.modelAnswer as string })),
          }
        : {}),
      /** The step after this part — a "continue", or a wait on the other party. */
      nextStep,
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
      // The unit the minimum and logged Duration are read in, so the fill
      // surface labels "hrs"/"min" the same way the builder set it. Omitted =
      // hours.
      durationUnit: part.durationUnit ?? null,
      durationColumnKey: part.durationColumnKey ?? null,
      // Per-task-type hour targets, so the fill surface can show live per-task
      // progress. A soft target, like minimumHours — sent for display, never a
      // gate on what the candidate may submit.
      taskMinimums: part.taskMinimums ?? null,
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
        (id) =>
          !hidden.has(id) &&
          !prefillMap[id] &&
          !prereqIds.has(id) &&
          !completionIds.has(id) &&
          // On a marking pass only the marking surface stays writable — the
          // candidate's answers are frozen the moment they handed in.
          (!markingSurface || markingSurface.has(id)),
      ),
      /*
        Layering, least to most authoritative: tool DEFAULTS under everything —
        a default fills only where nothing exists, and the field stays
        writable — then the candidate's stored answers, then the derived
        prefill, prerequisite and completion values, which nothing may shadow.
      */
      values: {
        ...defaultsFor(manifest, visibleFields),
        // Display pre-marks, assessor-only, submitted-unmarked only — UNDER the
        // stored values, so a cell anybody actually recorded always wins.
        ...(preMarks ?? {}),
        ...(attempt.values ?? {}),
        ...prefill,
        ...prereqValues,
        ...completionValues,
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
  // Idempotent, and checked FIRST. A double-tap must not restamp a later
  // hand-in time — and now that a self-marking part resolves at hand-in, the
  // second tap of the same gesture must not turn into an error about the mark
  // the first tap earned. The outcome rides along so the repeat answers the
  // same way the original did.
  if (submitting && attempt.submittedAt) {
    res.status(200).json({
      id: attempt.id,
      submittedAt: attempt.submittedAt,
      ...(attempt.outcome !== null ? { outcome: attempt.outcome } : {}),
    });
    return;
  }

  // Once marked, an attempt is evidence in both directions: handing it in again
  // is meaningless, and reopening it would let a candidate rewrite what an
  // assessor already judged.
  if (attempt.outcome !== null) {
    res.status(409).json({ error: 'attempt_resolved' });
    return;
  }

  /*
    A DECLARATION IS CHECKED BEFORE IT IS STAMPED. It completes at hand-in with
    nobody judging it, so hand-in is the only gate there is — and the gate has
    to run before `submittedAt` is written, or an empty tap on Submit would
    leave a submitted, auto-satisfied attestation with a blank signature box.

    The tool is loaded on BOTH paths now: hand-in needs it for the gates and
    the self-marking below, reopen needs it to know which stored cells were
    the marking pass's to write (and must therefore be cleared).
  */
  const tool = await loadTool(db, row.toolId, tenant.orgId);
  const part = tool ? orderedParts(tool.manifest).find((p) => p.key === attempt.partKey) : undefined;
  if (submitting && tool && part?.kind === 'declaration') {
    const fields = await fieldsForVersion(db, attempt.templateVersionId);
    const missing = missingDeclarationFields(fields, tool.manifest, part.key, attempt.values);
    if (missing.length > 0) {
      res.status(400).json({
        error: 'declaration_incomplete',
        missing,
        detail: `Fill ${missing.map((m) => `"${m.label}"`).join(', ')} before handing this in.`,
      });
      return;
    }
  }

  const submittedAt = submitting ? new Date() : null;

  /*
    REOPENING TAKES THE MARKING PASS'S WRITES BACK OUT.

    A partial marking pass may already have ticked written questions' ✓/✗
    cells and signed the part; the candidate taking the attempt back is about
    to CHANGE the answers those judgments were made against, so leaving them
    would hand the next marking pass a paper pre-labelled with verdicts on
    prose nobody has read. Cleared, not kept: a re-mark re-ticks in minutes,
    where a stale ✓ beside a rewritten answer is a finding nobody made.

    Scoped to exactly what the marking pass owns:
    - `assessorMarkBoxIds` — the unkeyed questions' declared ✓/✗ cells —
      narrowed to SELF-ANSWERING fields, the same fence `markingSurfaceIds`
      draws. A repeating-group target is skipped on purpose: the marking pass
      cannot write tables, and deleting a shared table id would take the
      candidate's own rows with it.
    - the part's declared sign-off furniture (assessor name, signed date,
      further action), which only means anything about a marked paper.
    Practical criteria are untouched: they are plain Yes/No fields, never an
    unkeyed question's outcomeTarget (`deriveChecklistOutcome` excludes
    targets from its criteria for the same reason), so legitimate
    pre-hand-in assessor ticks survive a reopen.
  */
  let reopenedValues: Record<string, SubmissionValue> | undefined;
  if (!submitting && tool && part) {
    const fields = await fieldsForVersion(db, attempt.templateVersionId);
    const selfAnswering = new Set(
      fields.filter((f) => SELF_ANSWERING_TYPES.includes(f.type)).map((f) => f.id),
    );
    const strip = new Set<string>(
      assessorMarkBoxIds(tool.manifest, part, fields).filter((id) => selfAnswering.has(id)),
    );
    for (const id of [part.assessorNameFieldId, part.signedDateFieldId, part.furtherActionFieldId]) {
      if (id) strip.add(id);
    }
    const stored = (attempt.values ?? {}) as Record<string, SubmissionValue>;
    if ([...strip].some((id) => stored[id] !== undefined)) {
      reopenedValues = { ...stored };
      for (const id of strip) delete reopenedValues[id];
    }
  }

  await db
    .update(schema.assessmentPartAttempts)
    .set({ submittedAt, ...(reopenedValues ? { values: reopenedValues } : {}) })
    .where(eq(schema.assessmentPartAttempts.id, attempt.id));

  await recordAudit(db, tenant, {
    action: submitting ? 'Submitted assessment part' : 'Reopened assessment part',
    target: `${row.id} ${attempt.partKey} attempt ${attempt.attemptNumber}`,
    // 'submissions' to match the rest of this router — assessment activity is
    // filed there rather than under a category of its own.
    category: 'submissions',
    icon: submitting ? 'send' : 'undo-2',
  });

  /*
    A SELF-MARKING PART MARKS ITSELF AT HAND-IN.

    The arithmetic needs no judgement, so making it wait for an assessor to
    visit and press a button was pure queue time: the candidate could not sign
    the sections that depend on a passed theory, and nobody could say why the
    "automatic" mark had not happened. Marking here means the candidate learns
    the result in the same breath as handing in, and everything gated on the
    part unlocks the moment it is earned.

    A computed fail keeps the case open as coaching-then-retry — the same
    default the outcome route applies — and the assessor's outcome route still
    stands for attempts submitted before this existed. A person-judged part is
    untouched: hand-in still just parks it for marking.
  */
  let marked: Awaited<ReturnType<typeof resolveAttemptOutcome>> | null = null;
  let theoryScore: { correctCount: number; totalCount: number } | null = null;
  if (submitting && tool && part) {
    /*
      A DECLARATION COMPLETES AT HAND-IN. Signing it IS the act — there is no
      arithmetic to run and no judgement to wait for, and parking it "for
      marking" would queue an assessor visit whose only possible outcome is
      pressing a button the candidate's signature already answered. The
      completeness gate above is what makes this safe to do blind.
    */
    if (part.kind === 'declaration') {
      marked = await resolveAttemptOutcome(db, tenant, {
        row,
        attempt,
        manifest: tool.manifest,
        locationPartKeys: tool.locationPartKeys ?? null,
        outcome: 'satisfactory',
        derivedValues: attempt.values ?? {},
        disposition: null,
        reason: null,
        belowThresholdReason: null,
        markingEligibilityWarnings: [],
        marker: { kind: 'automatic' },
      });
    } else {
      // Unstripped on purpose — marking must see answerKey/outcomeTarget.
      const fields = await fieldsForVersion(db, attempt.templateVersionId);
      if (isSelfMarking(fields, tool.manifest, part.key)) {
        const computed = markTheory({
          fields,
          values: attempt.values,
          part,
          passPercent: tool.manifest.theoryPassPercent,
          manifest: tool.manifest,
        });
        theoryScore = { correctCount: computed.correctCount, totalCount: computed.totalCount };
        /*
          The part's printed verdict radio, when the author LOCKED it to
          `auto` — same signal, same field rule as the practical's checklist
          derivation. The quiz marking already knows the outcome; without this
          the radio was un-typable AND unfilled, the exact gap (B) closed for
          practicals.
        */
        const verdict = autoVerdictWrite(
          fields,
          tool.manifest,
          part,
          computed.outcome,
          sectionForPart(workflowOf(tool.manifest, fields), part.key)?.fieldSource,
        );
        marked = await resolveAttemptOutcome(db, tenant, {
          row,
          attempt,
          manifest: tool.manifest,
          locationPartKeys: tool.locationPartKeys ?? null,
          outcome: computed.outcome,
          derivedValues: verdict
            ? { ...computed.derivedValues, [verdict.fieldId]: verdict.value }
            : computed.derivedValues,
          disposition: computed.outcome === 'not_satisfactory' ? 'coaching_then_retry' : null,
          reason: null,
          belowThresholdReason: null,
          markingEligibilityWarnings: [],
          marker: { kind: 'automatic' },
        });
      } else {
        /*
          A PRACTICAL PART WHOSE VERDICT THE AUTHOR LOCKED TO `auto` marks itself
          from its Yes/No checklist at hand-in (B) — the assessor who ticked the
          criteria need not also visit a marking form for a verdict the checklist
          already states. Returns null for an ordinary judged part, which parks
          for marking exactly as before.
        */
        const checklist = deriveChecklistOutcome(
          fields,
          tool.manifest,
          part,
          attempt.values,
          sectionForPart(workflowOf(tool.manifest, fields), part.key)?.fieldSource,
        );
        if (checklist) {
          marked = await resolveAttemptOutcome(db, tenant, {
            row,
            attempt,
            manifest: tool.manifest,
            locationPartKeys: tool.locationPartKeys ?? null,
            outcome: checklist.outcome,
            derivedValues: checklist.derivedValues,
            disposition: checklist.outcome === 'not_satisfactory' ? 'coaching_then_retry' : null,
            reason: null,
            belowThresholdReason: null,
            markingEligibilityWarnings: [],
            // The assessor who filled the part IS the marker — a practical is
            // judged by the person ticking it, not by nobody like a keyed paper.
            marker: { kind: 'person', userId: tenant.userId, name: '' },
          });
        }
      }
    }
  }

  res.status(200).json({
    id: attempt.id,
    submittedAt,
    ...(marked ? { outcome: marked.outcome, caseState: marked.nextState } : {}),
    ...(theoryScore ?? {}),
  });
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

/*
  CHECK A SINGLE QUESTION — interactive theory feedback.

  Returns whether one answer is correct, plus the author's hint when the
  answer is wrong. Does NOT save the answer — that is still the save route's
  job. The answer key never reaches the client; correctness is computed here
  and only the boolean is returned.
*/
const checkQuestionBody = z.object({
  fieldId: z.string(),
  value: z.unknown(),
});

assessmentCasesRouter.post(
  '/:id/attempts/:attemptId/check-question',
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
    if (attempt.outcome !== null) {
      res.status(409).json({ error: 'attempt_resolved' });
      return;
    }

    const parsed = checkQuestionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const { fieldId, value } = parsed.data;

    // Load the UNSTRIPPED fields so answerKey is visible.
    const fields = await fieldsForVersion(db, attempt.templateVersionId);
    const field = fields.find((f) => f.id === fieldId);
    if (!field || !field.answerKey || field.answerKey.length === 0) {
      res.status(400).json({ error: 'not_a_keyed_question' });
      return;
    }

    // Same exact-set-match as markTheory — duplicated to stay a thin check.
    const selected = normalizeSelected(value);
    const correct =
      selected !== undefined && setEquals(selected, field.answerKey);

    res.status(200).json({
      correct,
      ...(correct ? {} : { hint: field.answerHint ?? null }),
    });
  }),
);

function normalizeSelected(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    const opts = (value as unknown[])
      .filter((v) => typeof v !== 'object' || v === null)
      .map(String)
      .filter((s) => s !== '');
    return opts.length > 0 ? opts : undefined;
  }
  if (typeof value === 'boolean') return [value ? 'true' : 'false'];
  if (typeof value === 'number') return [String(value)];
  if (typeof value === 'string') return [value];
  return undefined;
}

function setEquals(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

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
    /*
      Handed in, not yet marked. Refusing the CANDIDATE here is what makes
      "submitted" mean anything — otherwise the answers could keep moving while
      the assessor was reading them; they can reopen it themselves, nothing is
      lost. STAFF are the exception, because on a mixed part marking IS writing:
      the assessor ticks each written question's ✓/✗ and signs the part. Their
      writable set narrows below to exactly that MARKING SURFACE, so the
      candidate's frozen answers stay frozen either way. Party by identity, the
      same rule as everywhere on this router — a self-assessing candidate is
      the candidate, and still 409s.
    */
    const party: WorkflowRole = row.candidateUserId === tenant.userId ? 'candidate' : 'assessor';
    const markingPass = !!attempt.submittedAt;
    if (markingPass && party === 'candidate') {
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
    /*
      Read ONCE and passed to both, because `workflowOf` needs the fields too:
      a question's ✓/✗ cell is declared on the question rather than in the
      manifest, so without them the derived workflow cannot mark it `auto` and
      a candidate's typed outcome would be accepted here.
    */
    const versionFields = tool ? await fieldsForVersion(db, attempt.templateVersionId) : [];
    // Derived ONCE and passed to both consumers — the union below and the
    // marking-surface narrowing — the same pattern the attempt GET uses, so
    // the two cannot be computed from different inputs.
    const workflow = tool ? workflowOf(tool.manifest, versionFields) : null;
    const partFields = tool ? fieldsInPart(versionFields, tool.manifest, attempt.partKey) : [];
    // The same union the attempt GET serves — a self-assessor must be able to
    // SAVE every field the surface showed them as writable.
    const selfAssessing = tool ? await isSelfAssessing(db, tenant, row.candidateUserId) : false;
    const labelled = tool ? await labelledSignoffAllowed(db, tenant.orgId) : false;
    const allowed = workflow
      ? new Set(
          unionPartFieldAccess(
            workflow,
            attempt.partKey,
            partFields,
            fillParties({ party, selfAssessing, labelled }),
          ).writable,
        )
      : null;

    /*
      ON A MARKING PASS THE ALLOWED SET NARROWS TO THE MARKING SURFACE — the
      same set the fill route served as `writableFieldIds`, so the screen and
      this gate cannot disagree. Intersection, not replacement: a furniture id
      the workflow does not let this party write stays refused. A submitted
      attempt whose tool or part cannot be loaded has no computable surface, so
      it keeps the flat refusal it always had rather than falling open to the
      whole part.
    */
    if (markingPass) {
      if (!workflow || !part || !allowed) {
        res.status(409).json({ error: 'attempt_submitted' });
        return;
      }
      const surface = markingSurfaceIds(workflow, part, partFields);
      for (const id of [...allowed]) if (!surface.has(id)) allowed.delete(id);
    }

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
      //
      // Recomputed for EVERY repeating table in the values, each against its
      // OWN columns — a logbook part may hold several (Part 5's supervised and
      // minimal-supervision logs). The old code recomputed only the first table
      // and passed the rest through untouched, which left the second table's
      // hours exactly as forgeable as the recompute was there to prevent. The
      // values are already this part's own fields, so matching a value key to a
      // repeating-group field id recomputes this part's tables and nothing else.
      const fields = await fieldsForVersion(db, attempt.templateVersionId);
      const columnsByTableId = new Map(
        fields
          .filter((f) => f.type === 'repeating_group')
          .map((f) => [f.id, f.columns] as const),
      );
      const durationKey = part.durationColumnKey;
      values = Object.fromEntries(
        Object.entries(values).map(([k, v]) => {
          const columns = columnsByTableId.get(k);
          if (!columns || !Array.isArray(v)) return [k, v];
          return [k, applyCalcs(columns, v as RepeatingRowValue[])];
        }),
      );

      // Summed across ALL the part's tables — see `logbookDurationRows`. A
      // half-filled or blank row (its calc duration still '') simply does not
      // count: progressive saving is the whole point of a logbook filled a
      // shift at a time, so a row the candidate has not finished must never
      // reject the save. The old code refused any non-positive duration here,
      // which meant a single in-progress row — or an empty one left ready for
      // the next entry — made "save progress" impossible. Completeness is the
      // minimum-hours threshold's job, judged at submit, not this route's.
      hours = totalLoggedHours(logbookDurationRows(part, values), durationKey);
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

    const attemptRows = await attemptsFor(db, row.id);
    /*
      FILL THE MARKS OLDER ATTEMPTS NEVER STORED. `withDerivedMarks` re-runs
      the marking arithmetic over each passing self-marked attempt against ITS
      OWN version's keys, merging under the stored values — so the printed
      ✓/✗ column, verdict pair and further-action note appear on attempts
      marked before the marking wrote them, and nothing already recorded is
      touched. Version fields are fetched once per distinct version.
    */
    const versionFieldsById = new Map<string, FormField[]>();
    const attempts: CaseAttemptRecord[] = [];
    for (const a of attemptRows) {
      let versionFields = versionFieldsById.get(a.templateVersionId);
      if (!versionFields) {
        versionFields = await fieldsForVersion(db, a.templateVersionId);
        versionFieldsById.set(a.templateVersionId, versionFields);
      }
      attempts.push(
        withDerivedMarks(
          {
            partKey: a.partKey,
            attemptNumber: a.attemptNumber,
            outcome: a.outcome,
            values: a.values,
            // COLUMNS, not values. Dropping them here is why every printed
            // "assessor name" and date box exported blank.
            assessorName: a.assessorName,
            signedAt: a.signedAt,
          },
          versionFields,
          tool.manifest,
        ),
      );
    }
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
        // The PINNED version's paper identity — a case that finished on Rev 2
        // keeps printing Rev 2 after a Rev 3 republishes.
        revisionIdentity: version.revisionIdentity ?? null,
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
        attempts,
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
        // What THIS case requires, so a multi-part completion row is judged
        // against the parts this candidate actually sits — the other
        // location's paper never blocks the tick.
        applicablePartKeys: casePartKeys(
          tool.manifest,
          row.pathway as AssessmentPathway,
          tool.locationPartKeys ?? {},
          row.locationId,
        ),
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
 * Write an attempt's resolution and let the case catch up — the one place an
 * outcome lands on the rows.
 *
 * Two callers: the outcome route (a person's judgement, or an assessor
 * triggering the computed mark) and hand-in (a self-marking part marks itself
 * the moment the candidate submits). One copy, because the attempt update, the
 * case-state recompute and the audit line must never disagree about what
 * resolving an attempt means.
 */
async function resolveAttemptOutcome(
  database: Database,
  tenant: NonNullable<Parameters<typeof recordAudit>[1]>,
  input: {
    row: NonNullable<Awaited<ReturnType<typeof loadCase>>>;
    attempt: { id: string; partKey: string; attemptNumber: number };
    manifest: AssessmentToolManifest;
    /** The tool's per-Location parts rule, so case state reads what THIS case requires. */
    locationPartKeys: LocationPartKeys | null;
    outcome: 'satisfactory' | 'not_satisfactory';
    derivedValues: Record<string, SubmissionValue>;
    disposition: (typeof NS_DISPOSITIONS)[number] | null;
    reason: string | null;
    belowThresholdReason: string | null;
    markingEligibilityWarnings: string[];
    /** A COMPUTED mark names nobody; a JUDGED one carries the person (U15). */
    marker: { kind: 'automatic' } | { kind: 'person'; userId: string; name: string };
  },
) {
  const { row, attempt, outcome, disposition, reason } = input;

  await database
    .update(schema.assessmentPartAttempts)
    .set({
      outcome,
      values: input.derivedValues,
      disposition: outcome === 'not_satisfactory' ? disposition : null,
      dispositionReason: outcome === 'not_satisfactory' ? reason : null,
      belowThresholdReason: input.belowThresholdReason,
      // Empty for an automatic mark (R65); the person's gaps otherwise (U14).
      markingEligibilityWarnings: input.markingEligibilityWarnings,
      markerKind: input.marker.kind,
      assessorUserId: input.marker.kind === 'person' ? input.marker.userId : null,
      assessorName: input.marker.kind === 'person' ? input.marker.name : '',
      signedAt: new Date(),
    })
    .where(eq(schema.assessmentPartAttempts.id, attempt.id));

  // Recompute case state from the rows rather than incrementing a counter —
  // over what THIS case requires, so a Location-excluded part never holds a
  // finished case open.
  const attempts = await attemptsFor(database, row.id);
  const progress = caseProgress(
    input.manifest,
    row.pathway as AssessmentPathway,
    toAttemptFacts(attempts),
    applicablePartsFor({ manifest: input.manifest, locationPartKeys: input.locationPartKeys }, row),
  );
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
    on every resolution and derives state purely from the attempt rows, so
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
    await database
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

  await recordAudit(database, tenant, {
    action: 'Recorded part outcome',
    target: `${row.id} / ${attempt.partKey} #${attempt.attemptNumber}: ${outcome}`,
    category: 'submissions',
    icon: outcome === 'satisfactory' ? 'circle-check' : 'circle-x',
  });

  return { outcome, nextState, progress };
}

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

    /*
      A PRACTICAL PART WHOSE VERDICT THE AUTHOR LOCKED TO `auto` marks itself from
      its Yes/No checklist (B): every criterion ticked Yes is satisfactory, any No
      or untouched box is not. Like a keyed part, the SYSTEM decides it — so the
      assessor is not asked to re-pick a verdict the checklist already states, and
      a manual `outcome` in the request is ignored in favour of the derivation.
    */
    const checklist = computed
      ? null
      : deriveChecklistOutcome(
          fields,
          tool.manifest,
          part,
          attempt.values,
          sectionForPart(workflowOf(tool.manifest, fields), part.key)?.fieldSource,
        );

    if (computed) {
      const marked = markTheory({ fields, values: attempt.values, part, manifest: tool.manifest });
      outcome = marked.outcome;
      derivedValues = marked.derivedValues;
    } else if (checklist) {
      outcome = checklist.outcome;
      derivedValues = checklist.derivedValues;
    } else {
      if (!outcome) {
        res.status(400).json({ error: 'outcome_required' });
        return;
      }
      /*
        MIXED MARKING (D4): a JUDGED part still pre-marks its KEYED SUBSET.

        The verdict is the assessor's — nothing above changed — but the keyed
        choice questions' ✓/✗ are arithmetic the machine already did on the
        fill surface, and leaving them out of the stored values printed four
        permanently blank boxes on every mixed paper. Same discipline as the
        computed branch: `markKeyedQuestions` over the version's UNSTRIPPED
        fields, visibility deciding which questions count. Merged UNDER the
        stored values (the `withDerivedMarks` precedent): a cell any person
        recorded — every written question's assessor-ticked box, or a keyed
        cell someone overrode before these locked — is never rewritten.
        Deliberately NO part verdict and NO auto-locked radio write
        (`autoVerdictWrite` stays a self-marking-branch act, the #269 line):
        the machine holds only some of this part's evidence.

        SCOPED TO THE PART'S OWN SLICE, mirroring `withDerivedMarks` in
        case-export.ts. Marking the WHOLE version here read every OTHER part's
        keyed questions as unanswered and wrote their ✗ into THIS attempt's
        stored values — and the export's per-part merge then let a later
        judged attempt's foreign ✗ overwrite the keyed part's real ✓ on the
        certified PDF.
      */
      const preMarked = markKeyedQuestions(
        fieldsInPart(fields, tool.manifest, part.key),
        attempt.values,
      );
      derivedValues = { ...preMarked.derivedValues, ...(attempt.values ?? {}) };
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
      if (computed || checklist) {
        // A system-decided fail — keyed arithmetic or the checklist — needs no
        // written reason: the missed questions or the un-ticked criteria are the
        // reason, and it defaults to coach-and-retry like any computed fail.
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

    /*
      Attribution (U15, R70). A COMPUTED mark was made by no person, so it
      names nobody — `markerKind: 'automatic'` with the user and printed-name
      columns left null/empty, even on a case that does name an assessor. A
      JUDGED mark carries the person and the name they marked under.
    */
    const resolved = await resolveAttemptOutcome(db, tenant, {
      row,
      attempt,
      manifest: tool.manifest,
      locationPartKeys: tool.locationPartKeys ?? null,
      outcome,
      derivedValues,
      disposition,
      reason,
      belowThresholdReason: parsed.data.belowThresholdReason ?? null,
      markingEligibilityWarnings,
      marker: computed
        ? { kind: 'automatic' }
        : { kind: 'person', userId: tenant.userId, name: parsed.data.assessorName ?? '' },
    });

    res.json({
      id: attempt.id,
      outcome: resolved.outcome,
      caseState: resolved.nextState,
      parts: resolved.progress.map((p) => ({ key: p.part.key, state: p.state })),
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
    /*
      Nobody certifies themselves — unless the ORGANISATION says its assessors
      may. Self-assessment is a real policy that differs between registered
      training setups, so it is the org's switch (default off), never inferred
      from the caller holding an assessor role. The permission gate above still
      applies: a candidate-role user cannot reach this route at all, so "self"
      here always means a qualified person signing their own case.
    */
    if (tenant.userId === row.candidateUserId) {
      if (!(await selfAssessmentAllowed(db, tenant.orgId))) {
        res.status(409).json({ error: 'candidate_cannot_sign_off' });
        return;
      }
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
    const progress = caseProgress(
      tool.manifest,
      row.pathway as AssessmentPathway,
      toAttemptFacts(attempts),
      applicablePartsFor(tool, row),
    );
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
      REMEMBER THE SIGNATURE, so the next sign-off prefills it and the assessor
      draws it once rather than on every certification. A convenience write, not
      part of the certification: it is wrapped so a failure to remember can never
      sink a sign-off that has already been recorded — the same doctrine the
      competency grant below follows.
    */
    try {
      await db
        .update(schema.users)
        .set({ signature: parsed.data.signature })
        .where(eq(schema.users.id, tenant.userId));
    } catch {
      // The case is signed off regardless; the signature simply is not remembered.
    }

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
      // The code where there is one — it is what the assessor recognises — and
      // the name where there is not, rather than a null in a list of strings.
      if (result.ok) granted.push(result.outcome.code ?? result.outcome.name);
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
