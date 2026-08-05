/**
 * Loading and writing around the pure assignment engine (U11).
 *
 * `packages/shared/src/assignment.ts` decides WHAT to create; this reads the
 * membership, its Roles' requirements, the tools, the person's current
 * competencies and Locations, and the cases already open, then writes the cases
 * the engine returns. It is the one function four callers share — placement
 * change, requirement change, import and the sweep (KTD16) — so the skip rule
 * lives in exactly one place and every trigger is idempotent by construction.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  competencyStatus,
  decideAssignments,
  orderedParts,
  type AssessmentToolManifest,
  type AssignmentTool,
  type HeldCompetencyState,
} from '@formai/shared';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;

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
  database: Database,
  orgId: string,
  userId: string,
  now: Date,
): Promise<HeldCompetencyState[]> {
  const holders = await database.query.competencyHolders.findMany({
    where: and(
      eq(schema.competencyHolders.userId, userId),
      eq(schema.competencyHolders.orgId, orgId),
    ),
  });
  if (holders.length === 0) return [];
  const comps = await database.query.competencies.findMany({
    where: and(
      eq(schema.competencies.orgId, orgId),
      inArray(
        schema.competencies.id,
        holders.map((h) => h.competencyId),
      ),
    ),
  });
  const validityById = new Map(comps.map((c) => [c.id, c]));
  return holders.map((h) => {
    const validity = validityById.get(h.competencyId);
    // A holder pointing at a competency the org no longer defines cannot be
    // dated, so it proves nothing — treat it as revoked (it never satisfies).
    // A revoked grant resolves to 'revoked' the same way (R107).
    const status = validity ? competencyStatus(h, validity, now, 'assessor') : 'revoked';
    return { competencyId: h.competencyId, status };
  });
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
 * membership is not the organisation's.
 */
async function loadMembershipContext(
  database: Database,
  orgId: string,
  membershipId: string,
  toolIds: readonly string[],
  now: Date,
): Promise<MembershipAssignmentContext | null> {
  const membership = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.id, membershipId), eq(schema.memberships.orgId, orgId)),
  });
  if (!membership) return null;

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
        awardedCompetencyIds: t.awardedCompetencyIds ?? [],
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

  // Open cases for this candidate — the idempotence guard (KTD16).
  const openCases = await database.query.assessmentCases.findMany({
    where: and(
      eq(schema.assessmentCases.orgId, orgId),
      eq(schema.assessmentCases.candidateUserId, membership.userId),
      eq(schema.assessmentCases.state, 'open'),
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
  roleRequirements: readonly (readonly string[])[],
): PlannedCase[] {
  const decisions = decideAssignments({
    roleRequirements,
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
 * Assign one membership's Role requirements. Creates a case only where a
 * requirement is unmet and none is already open, resolving the Location from the
 * membership (R57–R60). Idempotent (KTD16): the engine excludes any tool with an
 * open case, so this may be run on every placement change, requirement change,
 * import row and sweep without duplicating.
 *
 * `now` is threaded so currency and the run share one instant.
 */
export async function assignForMembership(
  database: Database,
  orgId: string,
  membershipId: string,
  now: Date = new Date(),
): Promise<AssignmentResult> {
  // Held Roles only — a withdrawn Role confers no requirement (R52).
  const roleRows = await database.query.membershipRoles.findMany({
    where: and(
      eq(schema.membershipRoles.membershipId, membershipId),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  const roleIds = roleRows.map((r) => r.roleId);
  if (roleIds.length === 0) return { createdCaseIds: [] };

  const reqRows = await database.query.roleRequiredAssessments.findMany({
    where: and(
      eq(schema.roleRequiredAssessments.orgId, orgId),
      inArray(schema.roleRequiredAssessments.roleId, roleIds),
    ),
  });
  // One array per Role — the engine unions and deduplicates (R48, R49).
  const roleRequirements = roleIds.map((roleId) =>
    reqRows.filter((r) => r.roleId === roleId).map((r) => r.toolId),
  );
  const toolIds = [...new Set(reqRows.map((r) => r.toolId))];
  if (toolIds.length === 0) return { createdCaseIds: [] };

  const ctx = await loadMembershipContext(database, orgId, membershipId, toolIds, now);
  if (!ctx) return { createdCaseIds: [] };

  const planned = planFromContext(ctx, roleRequirements);
  return { createdCaseIds: await insertPlannedCases(database, orgId, ctx.userId, planned) };
}

/**
 * Assign a Role's requirements to everyone holding it today (R82's mechanism).
 * Runs the same per-membership decision for each current holder, so a
 * requirement added to a Role reaches the people already in it. Idempotent for
 * the same reason a single membership's run is.
 */
export async function assignForRole(
  database: Database,
  orgId: string,
  roleId: string,
  now: Date = new Date(),
): Promise<AssignmentResult> {
  const holders = await database.query.membershipRoles.findMany({
    where: and(
      eq(schema.membershipRoles.roleId, roleId),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  const membershipIds = [...new Set(holders.map((h) => h.membershipId))];
  const createdCaseIds: string[] = [];
  for (const membershipId of membershipIds) {
    const result = await assignForMembership(database, orgId, membershipId, now);
    createdCaseIds.push(...result.createdCaseIds);
  }
  return { createdCaseIds };
}

/**
 * The cases a specific set of tools WOULD create for each current holder of a
 * Role, without writing anything (the U12 addition preview). The requirement is
 * INJECTED rather than read from the database, so a preview projects the effect
 * of a proposed change that has not been saved.
 */
export async function planAssignmentsForRole(
  database: Database,
  orgId: string,
  roleId: string,
  scopeToolIds: readonly string[],
  now: Date = new Date(),
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
    const ctx = await loadMembershipContext(database, orgId, membershipId, scopeToolIds, now);
    if (!ctx) continue;
    plans.push({ membershipId, userId: ctx.userId, cases: planFromContext(ctx, [[...scopeToolIds]]) });
  }
  return plans;
}
