/**
 * Loading and writing around the pure assignment engine (U11; membership-
 * scoped by the requirement inheritance round, U3/KTD4).
 *
 * `packages/shared/src/assignment.ts` decides WHAT to create; this reads the
 * membership, the requirements its FULL scope union confers (org, placed
 * Locations, placed Departments, held Roles — R2), the tools, the person's
 * current competencies and Locations, and the cases already open, then writes
 * the cases the engine returns. It is the one function four callers share —
 * placement change, requirement change, import and the sweep (KTD16) — so the
 * skip rule lives in exactly one place and every trigger is idempotent by
 * construction.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  competencyCurrency,
  decideAssignments,
  orderedParts,
  type AssessmentToolManifest,
  type AssignmentTool,
  type HeldCompetencyState,
} from '@formai/shared';
import { db } from '../db.js';
import { requiredToolIdsForMembership } from './requirement-links.js';
import type { Reader } from './standing.js';
import { DEACTIVATED_STATUS } from '../middleware/tenant.js';

type Database = NonNullable<typeof db>;
/*
  READ-ONLY HELPERS TAKE `Reader`, NOT `Database`. The award-link and
  requirement-change applies now compute INSIDE their own transaction (so the
  plan and the write share one snapshot), which means the planners below are
  handed a transaction handle rather than the root client. A transaction is not
  assignable to `Db` — it carries no `$client` — so the read-only half of this
  module is typed on the surface it actually uses. Everything that WRITES keeps
  `Database`.
*/

/**
 * Optional knobs for a PLANNING run.
 *
 * `awardsOverride` substitutes a tool's awards list for the duration of the
 * plan — the award-link preview's whole mechanism (U2, KTD10): the tool in the
 * database still awards nothing (vacuously satisfied, so the engine would plan
 * zero cases), and the preview must count the world AFTER the link lands. The
 * override injects the pending award without writing it, so preview and apply
 * count through the same engine.
 */
export interface PlanOptions {
  awardsOverride?: ReadonlyMap<string, readonly string[]>;
}

/** One case a plan would create, with the published version it would carry. */
export interface PlannedCase {
  toolId: string;
  locationId: string;
  currentVersionId: string;
}

/** A membership's planned cases — what a dry run projects for it (U12 preview). */
export interface MembershipPlan {
  membershipId: string;
  userId: string;
  cases: PlannedCase[];
}

/** Everything the engine reads for ONE membership, over a given set of tools. */
interface MembershipAssignmentContext {
  userId: string;
  tools: Record<string, AssignmentTool>;
  currentVersionByTool: Map<string, string | null>;
  held: HeldCompetencyState[];
  locationIds: string[];
  openCaseToolIds: string[];
}

/** Every competency a user holds now, each resolved to its current status. */
export async function heldCompetencyStates(
  database: Reader,
  orgId: string,
  userId: string,
  now: Date,
): Promise<HeldCompetencyState[]> {
  const byUser = await heldCompetencyStatesByUser(database, orgId, [userId], now);
  return byUser.get(userId) ?? [];
}

/**
 * The batched shape of `heldCompetencyStates` — TWO queries however many users
 * are asked about (U4's org-scale discipline): one over the holder rows, one
 * over the competencies that date them. An org-scope preview walks every
 * active membership, and a per-user pair of reads inside an open write
 * transaction would turn a few-hundred-member save into a thousand sequential
 * queries. Every requested userId maps to an array (possibly empty).
 */
export async function heldCompetencyStatesByUser(
  database: Reader,
  orgId: string,
  userIds: readonly string[],
  now: Date,
): Promise<Map<string, HeldCompetencyState[]>> {
  const unique = [...new Set(userIds)];
  const byUser = new Map<string, HeldCompetencyState[]>();
  for (const userId of unique) byUser.set(userId, []);
  if (unique.length === 0) return byUser;

  const holders = await database.query.competencyHolders.findMany({
    where: and(
      inArray(schema.competencyHolders.userId, unique),
      eq(schema.competencyHolders.orgId, orgId),
    ),
  });
  if (holders.length === 0) return byUser;
  const comps = await database.query.competencies.findMany({
    where: and(
      eq(schema.competencies.orgId, orgId),
      inArray(schema.competencies.id, [...new Set(holders.map((h) => h.competencyId))]),
    ),
  });
  const validityById = new Map(comps.map((c) => [c.id, c]));
  for (const h of holders) {
    const validity = validityById.get(h.competencyId);
    const state = validity
      ? (() => {
          const { status, revoked } = competencyCurrency(h, validity, now, 'assessor');
          return { competencyId: h.competencyId, status, revoked };
        })()
      : // A holder pointing at a competency the org no longer defines cannot be
        // dated, so it proves nothing — mark it revoked so it never satisfies
        // (the same not-held outcome R107 gives a genuinely revoked grant).
        { competencyId: h.competencyId, status: 'expired' as const, revoked: true };
    byUser.get(h.userId)?.push(state);
  }
  return byUser;
}

export interface AssignmentResult {
  createdCaseIds: string[];
}

/**
 * Load everything the engine reads for one membership, over `toolIds`.
 *
 * `toolIds` scopes the tool context — the whole of a membership's requirements
 * for the real assignment, or just the ADDED tools for a U12 preview — while the
 * held competencies, Locations and open cases are membership-wide. Null when the
 * membership is not the organisation's, or is DEACTIVATED (R64).
 *
 * Deactivation is refused here rather than at each caller because assignment
 * reaches this function from four directions — a direct assign, a Role's
 * requirements changing, a placement edit, and an approved training request —
 * and only the first has a person on the other end to be told. A leaver whose
 * old Role gained a requirement would otherwise be handed an assessment they
 * cannot sign in to take, which then reads as outstanding on the compliance
 * report for as long as the record is retained.
 */
async function loadMembershipContext(
  database: Reader,
  orgId: string,
  membershipId: string,
  toolIds: readonly string[],
  now: Date,
  options: PlanOptions = {},
): Promise<MembershipAssignmentContext | null> {
  const membership = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.id, membershipId), eq(schema.memberships.orgId, orgId)),
  });
  if (!membership) return null;
  if (membership.status === DEACTIVATED_STATUS) return null;

  const tools: Record<string, AssignmentTool> = {};
  const currentVersionByTool = new Map<string, string | null>();
  const uniqueToolIds = [...new Set(toolIds)];
  if (uniqueToolIds.length > 0) {
    const toolRows = await database.query.assessmentTools.findMany({
      where: and(
        eq(schema.assessmentTools.orgId, orgId),
        inArray(schema.assessmentTools.id, uniqueToolIds),
      ),
    });
    const templateIds = [...new Set(toolRows.map((t) => t.templateId))];
    const templates = templateIds.length
      ? await database.query.formTemplates.findMany({
          where: and(
            eq(schema.formTemplates.orgId, orgId),
            inArray(schema.formTemplates.id, templateIds),
          ),
        })
      : [];
    const versionByTemplate = new Map(templates.map((t) => [t.id, t.currentVersionId]));
    for (const t of toolRows) {
      const manifest = t.manifest as AssessmentToolManifest;
      tools[t.id] = {
        toolId: t.id,
        // A pending award injected by the caller wins over the stored list —
        // that is how the award-link preview plans the post-link world (U2).
        awardedCompetencyIds: options.awardsOverride?.get(t.id) ?? t.awardedCompetencyIds ?? [],
        allPartKeys: orderedParts(manifest).map((p) => p.key),
        locationPartKeys: t.locationPartKeys ?? {},
        assessorStreamCompetencyIds: t.assessorStreamCompetencyIds ?? {},
      };
      currentVersionByTool.set(t.id, versionByTemplate.get(t.templateId) ?? null);
    }
  }

  const locRows = await database.query.membershipLocations.findMany({
    where: eq(schema.membershipLocations.membershipId, membershipId),
    orderBy: (m, { asc }) => [asc(m.position)],
  });
  const locationIds = locRows.map((l) => l.locationId);

  // In-flight cases for this candidate — the idempotence guard (KTD16). BOTH
  // non-terminal states count: a case `awaiting_sign_off` has passed every part
  // but not yet been signed, so its competency is not granted until sign-off —
  // filtering `open` alone would let the sweep (or a re-run of any trigger)
  // create a SECOND case for a requirement that is one signature from done.
  const openCases = await database.query.assessmentCases.findMany({
    where: and(
      eq(schema.assessmentCases.orgId, orgId),
      eq(schema.assessmentCases.candidateUserId, membership.userId),
      inArray(schema.assessmentCases.state, ['open', 'awaiting_sign_off']),
    ),
  });
  const openCaseToolIds = [...new Set(openCases.map((c) => c.toolId))];

  const held = await heldCompetencyStates(database, orgId, membership.userId, now);

  return {
    userId: membership.userId,
    tools,
    currentVersionByTool,
    held,
    locationIds,
    openCaseToolIds,
  };
}

/**
 * The cases a context would produce for the given requirements — the engine's
 * decision, with the version filter applied HERE rather than at the write.
 *
 * A tool whose template has no published version cannot carry a case, and
 * filtering it out in the plan (not in the writer) is what keeps a U12 preview
 * count equal to the number of rows an apply inserts.
 */
function planFromContext(
  ctx: MembershipAssignmentContext,
  requirements: readonly (readonly string[])[],
): PlannedCase[] {
  const decisions = decideAssignments({
    // The engine's input keeps its historical name; since U3 the real
    // assignment passes ONE flattened array (the membership's whole scope
    // union, KTD4) — the engine has always flattened before deciding, so the
    // grouping never carried meaning.
    roleRequirements: requirements,
    tools: ctx.tools,
    held: ctx.held,
    locationIds: ctx.locationIds,
    openCaseToolIds: ctx.openCaseToolIds,
  });
  const planned: PlannedCase[] = [];
  for (const decision of decisions) {
    const currentVersionId = ctx.currentVersionByTool.get(decision.toolId);
    if (!currentVersionId) continue;
    planned.push({ toolId: decision.toolId, locationId: decision.locationId, currentVersionId });
  }
  return planned;
}

/**
 * The row a planned case inserts as — UNOWNED and on the full 'new' pathway
 * (R61). One definition, so the real assignment and the U12 apply (which writes
 * inside a transaction) create a case exactly one way. The return type is the
 * insert shape, so `pathway: 'new'` is checked against the enum here rather than
 * relying on each caller's contextual typing.
 */
export function assignmentCaseValues(
  orgId: string,
  candidateUserId: string,
  planned: PlannedCase,
): typeof schema.assessmentCases.$inferInsert {
  return {
    orgId,
    toolId: planned.toolId,
    candidateUserId,
    // No assessor is chosen — the shared queue is where an eligible one finds it
    // (U13). 'new' requires every part, the safe direction when nobody chose.
    assessorUserId: null,
    pathway: 'new',
    locationId: planned.locationId,
    currentVersionId: planned.currentVersionId,
    prerequisiteWarnings: [],
  };
}

/**
 * Write a set of planned cases for one candidate. Used on the non-transactional
 * assignment paths (placement change, sweep); the U12 apply writes the same rows
 * inside its own transaction via `assignmentCaseValues`.
 */
export async function insertPlannedCases(
  database: Database,
  orgId: string,
  candidateUserId: string,
  planned: readonly PlannedCase[],
): Promise<string[]> {
  const createdCaseIds: string[] = [];
  for (const p of planned) {
    const [row] = await database
      .insert(schema.assessmentCases)
      .values(assignmentCaseValues(orgId, candidateUserId, p))
      .returning();
    if (row) createdCaseIds.push(row.id);
  }
  return createdCaseIds;
}

/**
 * Assign one membership's requirements — the FULL scope union (KTD4, R2), not
 * just its Roles'. Creates a case only where a requirement is unmet and none
 * is already open, resolving the Location from the membership (R57–R60).
 * Idempotent (KTD16): the engine excludes any tool with an open case, so this
 * may be run on every placement change, requirement change, import row and
 * sweep without duplicating.
 *
 * `now` is threaded so currency and the run share one instant.
 */
export async function assignForMembership(
  database: Database,
  orgId: string,
  membershipId: string,
  now: Date = new Date(),
): Promise<AssignmentResult> {
  /*
    THE MEMBERSHIP-SHAPED RESOLVER (KTD4), and NO zero-roles early return: an
    org, Location or Department requirement reaches a member who holds no role
    at all (R2, R3) — the admin placed at a site owes its induction before
    they hold anything — so bailing on an empty role list would silently drop
    every non-role scope, and the sweep would never be a backstop for scope
    changes. The resolver expands the membership's placement to scope keys
    (retired locations/departments dropped, withdrawn roles excluded, legacy
    role rows still honoured — KTD2/KTD3 live inside it) and returns the flat
    deduplicated tool set the engine has always reduced to anyway.
  */
  const toolIds = await requiredToolIdsForMembership(database, orgId, membershipId);
  // Zero TOOLS stays an early return: nothing to plan, nothing to load. An
  // evidence-only obligation (R7) lands here — visible in standing, no case.
  if (toolIds.length === 0) return { createdCaseIds: [] };

  const ctx = await loadMembershipContext(database, orgId, membershipId, toolIds, now);
  if (!ctx) return { createdCaseIds: [] };

  const planned = planFromContext(ctx, [toolIds]);
  return { createdCaseIds: await insertPlannedCases(database, orgId, ctx.userId, planned) };
}

/**
 * Assign ONE tool to a membership — the path a voluntary training request takes
 * once an Admin approves it (U22, R94). The requested tool is treated exactly as
 * a Role requirement of one: a case is created only where the person does not
 * already hold every competency it awards, current, and has no open case for it
 * (R45, KTD16) — so approving something the person already holds creates nothing,
 * and a retried approval never duplicates.
 */
export async function assignToolToMembership(
  database: Database,
  orgId: string,
  membershipId: string,
  toolId: string,
  now: Date = new Date(),
): Promise<AssignmentResult> {
  const ctx = await loadMembershipContext(database, orgId, membershipId, [toolId], now);
  if (!ctx) return { createdCaseIds: [] };
  const planned = planFromContext(ctx, [[toolId]]);
  return { createdCaseIds: await insertPlannedCases(database, orgId, ctx.userId, planned) };
}

/**
 * The cases a specific set of tools WOULD create for each given membership,
 * without writing anything — the scope-keyed planning sibling of
 * `planAssignmentsForRole` (KTD5), serving all four requirement scopes through
 * `computeRequiredAssessmentsChange`. The requirement is INJECTED rather than
 * read, so a preview projects a change that has not been saved.
 *
 * ORG-SCALE DISCIPLINE (U4, review-verified): every read here is batched
 * SET-WISE across the memberships — one query per table for memberships,
 * tools, templates, placements, open cases and held competencies — never a
 * per-membership `loadMembershipContext` loop. An org-scope save at a few
 * hundred members must not mean thousands of sequential queries inside an
 * open write transaction; the query count stays FLAT as membership grows
 * (pinned by test against the fake, not wall clock).
 *
 * Semantics match the per-membership loader exactly: a membership that is not
 * the organisation's, or is DEACTIVATED (R64), plans nothing — a leaver must
 * not be handed an assessment they cannot sign in to take.
 */
export async function planAssignmentsForMemberships(
  database: Reader,
  orgId: string,
  membershipIds: readonly string[],
  scopeToolIds: readonly string[],
  now: Date,
  options: PlanOptions = {},
): Promise<MembershipPlan[]> {
  const uniqueMembershipIds = [...new Set(membershipIds)];
  if (uniqueMembershipIds.length === 0 || scopeToolIds.length === 0) return [];

  const memberships = (
    await database.query.memberships.findMany({
      where: and(
        eq(schema.memberships.orgId, orgId),
        inArray(schema.memberships.id, uniqueMembershipIds),
      ),
    })
  ).filter((m) => m.status !== DEACTIVATED_STATUS);
  if (memberships.length === 0) return [];
  const userIds = [...new Set(memberships.map((m) => m.userId))];

  // Tool context — identical derivation to `loadMembershipContext`, loaded once
  // for the whole batch (the tools are scope-wide, not per person).
  const uniqueToolIds = [...new Set(scopeToolIds)];
  const toolRows = await database.query.assessmentTools.findMany({
    where: and(
      eq(schema.assessmentTools.orgId, orgId),
      inArray(schema.assessmentTools.id, uniqueToolIds),
    ),
  });
  const templateIds = [...new Set(toolRows.map((t) => t.templateId))];
  const templates = templateIds.length
    ? await database.query.formTemplates.findMany({
        where: and(
          eq(schema.formTemplates.orgId, orgId),
          inArray(schema.formTemplates.id, templateIds),
        ),
      })
    : [];
  const versionByTemplate = new Map(templates.map((t) => [t.id, t.currentVersionId]));
  const tools: Record<string, AssignmentTool> = {};
  const currentVersionByTool = new Map<string, string | null>();
  for (const t of toolRows) {
    const manifest = t.manifest as AssessmentToolManifest;
    tools[t.id] = {
      toolId: t.id,
      // A pending award injected by the caller wins over the stored list —
      // the same override contract the per-membership loader honours (U2).
      awardedCompetencyIds: options.awardsOverride?.get(t.id) ?? t.awardedCompetencyIds ?? [],
      allPartKeys: orderedParts(manifest).map((p) => p.key),
      locationPartKeys: t.locationPartKeys ?? {},
      assessorStreamCompetencyIds: t.assessorStreamCompetencyIds ?? {},
    };
    currentVersionByTool.set(t.id, versionByTemplate.get(t.templateId) ?? null);
  }

  // Placements, open cases and held competencies — one query per table.
  const locRows = await database.query.membershipLocations.findMany({
    where: inArray(
      schema.membershipLocations.membershipId,
      memberships.map((m) => m.id),
    ),
  });
  const locationsByMembership = new Map<string, { locationId: string; position: number }[]>();
  for (const row of locRows) {
    const list = locationsByMembership.get(row.membershipId) ?? [];
    list.push({ locationId: row.locationId, position: row.position });
    locationsByMembership.set(row.membershipId, list);
  }

  // BOTH non-terminal states, the KTD16 idempotence guard — same filter as the
  // per-membership loader.
  const openCases = await database.query.assessmentCases.findMany({
    where: and(
      eq(schema.assessmentCases.orgId, orgId),
      inArray(schema.assessmentCases.candidateUserId, userIds),
      inArray(schema.assessmentCases.state, ['open', 'awaiting_sign_off']),
    ),
  });
  const openToolsByUser = new Map<string, Set<string>>();
  for (const c of openCases) {
    const set = openToolsByUser.get(c.candidateUserId) ?? new Set<string>();
    set.add(c.toolId);
    openToolsByUser.set(c.candidateUserId, set);
  }

  const heldByUser = await heldCompetencyStatesByUser(database, orgId, userIds, now);

  const plans: MembershipPlan[] = [];
  for (const membership of memberships) {
    const ctx: MembershipAssignmentContext = {
      userId: membership.userId,
      tools,
      currentVersionByTool,
      held: heldByUser.get(membership.userId) ?? [],
      locationIds: (locationsByMembership.get(membership.id) ?? [])
        .sort((a, b) => a.position - b.position)
        .map((l) => l.locationId),
      openCaseToolIds: [...(openToolsByUser.get(membership.userId) ?? [])],
    };
    plans.push({
      membershipId: membership.id,
      userId: membership.userId,
      cases: planFromContext(ctx, [[...uniqueToolIds]]),
    });
  }
  return plans;
}

/**
 * The cases a specific set of tools WOULD create for each current holder of a
 * Role, without writing anything (the U12 addition preview). The requirement is
 * INJECTED rather than read from the database, so a preview projects the effect
 * of a proposed change that has not been saved.
 */
export async function planAssignmentsForRole(
  database: Reader,
  orgId: string,
  roleId: string,
  scopeToolIds: readonly string[],
  now: Date = new Date(),
  options: PlanOptions = {},
): Promise<MembershipPlan[]> {
  const holders = await database.query.membershipRoles.findMany({
    where: and(
      eq(schema.membershipRoles.roleId, roleId),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  const membershipIds = [...new Set(holders.map((h) => h.membershipId))];
  const plans: MembershipPlan[] = [];
  for (const membershipId of membershipIds) {
    const ctx = await loadMembershipContext(database, orgId, membershipId, scopeToolIds, now, options);
    if (!ctx) continue;
    plans.push({ membershipId, userId: ctx.userId, cases: planFromContext(ctx, [[...scopeToolIds]]) });
  }
  return plans;
}
