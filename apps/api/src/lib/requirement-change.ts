/**
 * The blast radius of a retrospective change to a Role's required assessments
 * (U12, KTD10).
 *
 * ONE function computes the effects AND the write plan, reading only. The
 * preview endpoint runs it and discards the plan; the apply endpoint runs the
 * SAME function and then executes the plan. Because `created` is the length of
 * the plan the apply inserts, the previewed and applied counts agree on
 * unchanged data — the guarantee KTD10 exists to give.
 *
 * The removal effects (R55, R56) are computed PER HOLDER against each person's
 * post-change required tools — their other Roles' requirements plus this Role's
 * desired set — because R56 is "required by no Role THEIR HOLDER still carries",
 * and an org-wide count is a different, wrong number for that wording.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  CASE_STATES,
  countsAsHeld,
  isTerminalCaseState,
  type RequiredAssessmentsChangeEffects,
} from '@formai/shared';
import { heldCompetencyStates, planAssignmentsForRole, type PlannedCase } from './assignment.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;

/** A case the apply will insert — a planned case bound to its candidate and org. */
export interface CaseToInsert extends PlannedCase {
  orgId: string;
  candidateUserId: string;
}

export interface RequiredAssessmentsChangePlan {
  effects: RequiredAssessmentsChangeEffects;
  /** `length === effects.created`, by construction. */
  casesToInsert: CaseToInsert[];
}

/** In flight = every case state that is not terminal (open, awaiting_sign_off). */
const NON_TERMINAL_STATES = CASE_STATES.filter((s) => !isTerminalCaseState(s));

/**
 * The effects of changing a Role's required assessments to `desiredToolIds`, and
 * the cases an apply would create. Reads only — safe to run at the top of an
 * apply transaction, before any write.
 */
export async function computeRequiredAssessmentsChange(
  database: Database,
  orgId: string,
  role: { id: string },
  desiredToolIds: readonly string[],
  now: Date,
): Promise<RequiredAssessmentsChangePlan> {
  const desired = new Set(desiredToolIds);

  // 1. Diff current vs desired.
  const currentRows = await database.query.roleRequiredAssessments.findMany({
    where: eq(schema.roleRequiredAssessments.roleId, role.id),
  });
  const current = new Set(currentRows.map((r) => r.toolId));
  const addedToolIds = [...desired].filter((id) => !current.has(id));
  const removedToolIds = [...current].filter((id) => !desired.has(id));

  // 2. Holders / affected — every current holder of the Role (a headcount).
  const holderRows = await database.query.membershipRoles.findMany({
    where: and(
      eq(schema.membershipRoles.roleId, role.id),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  const membershipIds = [...new Set(holderRows.map((h) => h.membershipId))];
  const affected = membershipIds.length;

  // 3. Addition plan — the cases the ADDED tools would create, scoped by
  //    injection so the count needs no write (KTD10). `created` is a case count.
  let casesToInsert: CaseToInsert[] = [];
  if (addedToolIds.length > 0 && affected > 0) {
    const plans = await planAssignmentsForRole(database, orgId, role.id, addedToolIds, now);
    casesToInsert = plans.flatMap((p) =>
      p.cases.map((c) => ({ ...c, orgId, candidateUserId: p.userId })),
    );
  }
  const created = casesToInsert.length;

  // 4. Removal effects — what the removal CHANGES, never a creation count (R85).
  let inFlightContinuing = 0;
  let competenciesDemoting = 0;
  if (removedToolIds.length > 0 && membershipIds.length > 0) {
    const removal = await computeRemovalEffects(
      database,
      orgId,
      role.id,
      desiredToolIds,
      removedToolIds,
      membershipIds,
      now,
    );
    inFlightContinuing = removal.inFlightContinuing;
    competenciesDemoting = removal.competenciesDemoting;
  }

  return {
    effects: { addedToolIds, removedToolIds, affected, created, inFlightContinuing, competenciesDemoting },
    casesToInsert,
  };
}

async function computeRemovalEffects(
  database: Database,
  orgId: string,
  roleId: string,
  desiredToolIds: readonly string[],
  removedToolIds: readonly string[],
  membershipIds: readonly string[],
  now: Date,
): Promise<{ inFlightContinuing: number; competenciesDemoting: number }> {
  const memberships = await database.query.memberships.findMany({
    where: and(eq(schema.memberships.orgId, orgId), inArray(schema.memberships.id, [...membershipIds])),
  });
  const userByMembership = new Map(memberships.map((m) => [m.id, m.userId]));
  const holderUserIds = [...new Set(memberships.map((m) => m.userId))];
  if (holderUserIds.length === 0) return { inFlightContinuing: 0, competenciesDemoting: 0 };

  // Post-change required tools PER MEMBERSHIP: the edited Role's desired set plus
  // every OTHER non-withdrawn Role's current requirements.
  const holderRoleRows = await database.query.membershipRoles.findMany({
    where: and(
      inArray(schema.membershipRoles.membershipId, [...membershipIds]),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  const otherRoleIds = [...new Set(holderRoleRows.map((r) => r.roleId).filter((id) => id !== roleId))];
  const otherReqRows = otherRoleIds.length
    ? await database.query.roleRequiredAssessments.findMany({
        where: and(
          eq(schema.roleRequiredAssessments.orgId, orgId),
          inArray(schema.roleRequiredAssessments.roleId, otherRoleIds),
        ),
      })
    : [];
  const toolsByOtherRole = new Map<string, string[]>();
  for (const r of otherReqRows) {
    const list = toolsByOtherRole.get(r.roleId) ?? [];
    list.push(r.toolId);
    toolsByOtherRole.set(r.roleId, list);
  }
  const rolesByMembership = new Map<string, string[]>();
  for (const r of holderRoleRows) {
    const list = rolesByMembership.get(r.membershipId) ?? [];
    list.push(r.roleId);
    rolesByMembership.set(r.membershipId, list);
  }
  // Collapse to per-USER (a user may in principle hold the Role via one membership).
  const postChangeToolsByUser = new Map<string, Set<string>>();
  for (const membershipId of membershipIds) {
    const userId = userByMembership.get(membershipId);
    if (!userId) continue;
    const set = postChangeToolsByUser.get(userId) ?? new Set<string>(desiredToolIds);
    for (const rid of rolesByMembership.get(membershipId) ?? []) {
      if (rid === roleId) continue;
      for (const t of toolsByOtherRole.get(rid) ?? []) set.add(t);
    }
    postChangeToolsByUser.set(userId, set);
  }

  // inFlightContinuing (R55): non-terminal cases for the removed tools, among the
  // holders, that the holder no longer requires after the change. Counts cases.
  const cases = await database.query.assessmentCases.findMany({
    where: and(
      eq(schema.assessmentCases.orgId, orgId),
      inArray(schema.assessmentCases.toolId, [...removedToolIds]),
      inArray(schema.assessmentCases.candidateUserId, holderUserIds),
      inArray(schema.assessmentCases.state, NON_TERMINAL_STATES),
    ),
  });
  let inFlightContinuing = 0;
  for (const c of cases) {
    const stillRequired = postChangeToolsByUser.get(c.candidateUserId);
    if (!stillRequired || !stillRequired.has(c.toolId)) inFlightContinuing++;
  }

  // competenciesDemoting (R56): (holder, competency) pairs the holder holds
  // current, a removed tool awards, and no tool the holder still requires awards.
  const allStillRequiredToolIds = new Set<string>();
  for (const set of postChangeToolsByUser.values()) for (const t of set) allStillRequiredToolIds.add(t);
  const relevantToolIds = [...new Set([...removedToolIds, ...allStillRequiredToolIds])];
  const toolRows = relevantToolIds.length
    ? await database.query.assessmentTools.findMany({
        where: and(
          eq(schema.assessmentTools.orgId, orgId),
          inArray(schema.assessmentTools.id, relevantToolIds),
        ),
      })
    : [];
  const awardsByTool = new Map(toolRows.map((t) => [t.id, new Set(t.awardedCompetencyIds ?? [])]));
  const removedCompetencies = new Set<string>();
  for (const t of removedToolIds) for (const c of awardsByTool.get(t) ?? []) removedCompetencies.add(c);

  let competenciesDemoting = 0;
  if (removedCompetencies.size > 0) {
    for (const userId of holderUserIds) {
      const held = await heldCompetencyStates(database, orgId, userId, now);
      const heldNow = new Set(held.filter((h) => countsAsHeld(h.status)).map((h) => h.competencyId));
      const stillRequiredComps = new Set<string>();
      for (const t of postChangeToolsByUser.get(userId) ?? []) {
        for (const c of awardsByTool.get(t) ?? []) stillRequiredComps.add(c);
      }
      for (const c of heldNow) {
        if (removedCompetencies.has(c) && !stillRequiredComps.has(c)) competenciesDemoting++;
      }
    }
  }

  return { inFlightContinuing, competenciesDemoting };
}
