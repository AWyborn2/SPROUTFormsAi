/**
 * The blast radius of a retrospective change to a Role's requirements (U12,
 * KTD10 — reworked into COMPETENCY terms by the role-competency links round),
 * plus the award-link computations that share its compute-then-apply shape (U2,
 * KTD3, KTD10).
 *
 * ONE function computes the effects AND the write plan, reading only. The
 * preview endpoint runs it and discards the plan; the apply endpoint runs the
 * SAME function and then executes the plan. Because `created` is the length of
 * the plan the apply inserts, the previewed and applied counts agree on
 * unchanged data — the guarantee KTD10 exists to give.
 *
 * The removal effects (R55, R56) are computed PER HOLDER against each person's
 * post-change required set — their other Roles' requirements (from BOTH
 * sources: direct links and remaining legacy tool rows) plus this Role's
 * desired set — because R56 is "required by no Role THEIR HOLDER still
 * carries", and an org-wide count is a different, wrong number for that
 * wording.
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
import { awardingToolByCompetency } from './requirement-links.js';
import type { Reader } from './standing.js';

/*
  EVERY COMPUTE BELOW IS READ-ONLY AND TYPED ON `Reader` — the root client OR an
  open transaction. Both applies (the requirement PUT and the award link) now
  open their transaction FIRST and compute inside it, so the plan and the write
  it drives share one snapshot; a transaction handle is not assignable to `Db`,
  so the parameter has to say so.
*/
type Database = Reader;

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

/**
 * In flight = every case state that is not terminal (open, awaiting_sign_off).
 *
 * Derived rather than listed, so a state added later cannot be swept by
 * omission — which is exactly what `invalidated` would have been: a case
 * abandoned when its candidate left, re-created here as live work.
 *
 * Exported for the award re-link guard (KTD10), which refuses to re-point a
 * tool's award while any of its cases is in one of these states.
 */
export const NON_TERMINAL_STATES = CASE_STATES.filter((s) => !isTerminalCaseState(s));

/** What a requirement change desires — the PUT/preview body, normalised. */
export interface RequiredCompetencyChange {
  /** The desired REQUIRED tier, as competency ids (deduplicated by the route). */
  requiredCompetencyIds: readonly string[];
  /**
   * Legacy `role_required_assessments` rows this change explicitly removes —
   * the awaitingLink exit (KTD9). The requirement PUT never touches legacy
   * rows; only the explicit remove action names ids here.
   */
  removeLegacyToolIds?: readonly string[];
}

/**
 * The effects of changing a Role's required competencies to the desired set
 * (and/or removing named legacy rows), and the cases an apply would create.
 * Reads only — safe to run at the top of an apply transaction, before any
 * write.
 *
 * The diff runs over the DIRECT required links only: the PUT owns nothing but
 * `role_required_competencies` (KTD9), so a competency a remaining legacy row
 * still derives keeps obliging through the dual read regardless of what this
 * change does to the links.
 */
export async function computeRequiredAssessmentsChange(
  database: Database,
  orgId: string,
  role: { id: string },
  desired: RequiredCompetencyChange,
  now: Date,
): Promise<RequiredAssessmentsChangePlan> {
  const desiredRequired = new Set(desired.requiredCompetencyIds);

  // 1. Diff current vs desired, in competency terms.
  const currentLinks = await database.query.roleRequiredCompetencies.findMany({
    where: eq(schema.roleRequiredCompetencies.roleId, role.id),
  });
  const currentRequired = new Set(
    currentLinks.filter((l) => l.tier === 'required').map((l) => l.competencyId),
  );
  const addedCompetencyIds = [...desiredRequired].filter((id) => !currentRequired.has(id));
  const removedLinkCompetencyIds = [...currentRequired].filter((id) => !desiredRequired.has(id));

  // The Role's legacy rows, and which of them this change removes. Filtered to
  // rows that actually exist so a stale id cannot inflate the effect counts.
  const legacyRows = await database.query.roleRequiredAssessments.findMany({
    where: eq(schema.roleRequiredAssessments.roleId, role.id),
  });
  const legacyToolIds = [...new Set(legacyRows.map((r) => r.toolId))];
  const removedLegacyToolIds = [
    ...new Set((desired.removeLegacyToolIds ?? []).filter((id) => legacyToolIds.includes(id))),
  ];
  const remainingLegacyToolIds = legacyToolIds.filter((id) => !removedLegacyToolIds.includes(id));

  /*
    A removed legacy tool's awards leave required standing too — unless the
    desired link set (re-)names them. They join the removal set so the effects
    a DELETE of an awaitingLink row reports speak the same competency language
    as a link removal. An UNLINKED legacy tool (empty awards — the usual
    awaitingLink case) contributes nothing here; its removal effect is the
    in-flight count below.
  */
  const removedLegacyAwardIds: string[] = [];
  if (removedLegacyToolIds.length > 0) {
    const removedTools = await database.query.assessmentTools.findMany({
      where: and(
        eq(schema.assessmentTools.orgId, orgId),
        inArray(schema.assessmentTools.id, removedLegacyToolIds),
      ),
    });
    for (const t of removedTools) removedLegacyAwardIds.push(...(t.awardedCompetencyIds ?? []));
  }
  const removedCompetencyIds = [
    ...new Set([...removedLinkCompetencyIds, ...removedLegacyAwardIds]),
  ].filter((id) => !desiredRequired.has(id));

  // 2. Holders / affected — every current holder of the Role (a headcount).
  const holderRows = await database.query.membershipRoles.findMany({
    where: and(
      eq(schema.membershipRoles.roleId, role.id),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  const membershipIds = [...new Set(holderRows.map((h) => h.membershipId))];
  const affected = membershipIds.length;

  // 3. Addition plan — each ADDED competency resolved to its awarding tool
  //    through the SHARED resolver (KTD2), so the preview and the apply cannot
  //    name different tools. A competency with no awarding tool plans nothing
  //    (R7, R9 — evidence-only); `created` is a case count.
  //
  //    ONE resolver scan serves the whole change: the resolver reads every org
  //    tool and template per call, and each competency resolves independently
  //    of what else rides in the wanted set, so the union map answers the
  //    addition plan here AND the removal scope below without a second
  //    identical scan.
  const changedCompetencyIds = [...new Set([...addedCompetencyIds, ...removedCompetencyIds])];
  const awarding =
    changedCompetencyIds.length > 0 && affected > 0
      ? await awardingToolByCompetency(database, orgId, changedCompetencyIds)
      : new Map<string, string>();
  let casesToInsert: CaseToInsert[] = [];
  if (addedCompetencyIds.length > 0 && affected > 0) {
    const addedToolIds = [
      ...new Set(addedCompetencyIds.flatMap((c) => (awarding.has(c) ? [awarding.get(c)!] : []))),
    ];
    if (addedToolIds.length > 0) {
      const plans = await planAssignmentsForRole(database, orgId, role.id, addedToolIds, now);
      casesToInsert = plans.flatMap((p) =>
        p.cases.map((c) => ({ ...c, orgId, candidateUserId: p.userId })),
      );
    }
  }
  const created = casesToInsert.length;

  // 4. Removal effects — what the removal CHANGES, never a creation count (R85).
  let inFlightContinuing = 0;
  let competenciesDemoting = 0;
  if ((removedCompetencyIds.length > 0 || removedLegacyToolIds.length > 0) && affected > 0) {
    const removal = await computeRemovalEffects(
      database,
      orgId,
      role.id,
      {
        desiredRequired,
        remainingLegacyToolIds,
        removedCompetencyIds,
        removedLegacyToolIds,
      },
      membershipIds,
      now,
      awarding,
    );
    inFlightContinuing = removal.inFlightContinuing;
    competenciesDemoting = removal.competenciesDemoting;
  }

  return {
    effects: {
      addedCompetencyIds,
      removedCompetencyIds,
      affected,
      created,
      inFlightContinuing,
      competenciesDemoting,
    },
    casesToInsert,
  };
}

async function computeRemovalEffects(
  database: Database,
  orgId: string,
  roleId: string,
  ctx: {
    /** This Role's post-change direct required competencies. */
    desiredRequired: ReadonlySet<string>;
    /** This Role's legacy rows surviving the change. */
    remainingLegacyToolIds: readonly string[];
    /** The competencies leaving required standing (links + removed-legacy awards). */
    removedCompetencyIds: readonly string[];
    /** Legacy tool rows this change explicitly removes. */
    removedLegacyToolIds: readonly string[];
  },
  membershipIds: readonly string[],
  now: Date,
  /**
   * A pre-resolved KTD2 map covering (at least) `ctx.removedCompetencyIds` —
   * passed by `computeRequiredAssessmentsChange`, which already scanned the
   * union of added and removed ids. Omitted, the scan runs here instead.
   */
  awardingByCompetency?: ReadonlyMap<string, string>,
): Promise<{ inFlightContinuing: number; competenciesDemoting: number }> {
  const memberships = await database.query.memberships.findMany({
    where: and(eq(schema.memberships.orgId, orgId), inArray(schema.memberships.id, [...membershipIds])),
  });
  const userByMembership = new Map(memberships.map((m) => [m.id, m.userId]));
  const holderUserIds = [...new Set(memberships.map((m) => m.userId))];
  if (holderUserIds.length === 0) return { inFlightContinuing: 0, competenciesDemoting: 0 };

  /*
    Post-change requirements PER HOLDER, from BOTH sources: the edited Role's
    desired links and surviving legacy rows, plus every OTHER non-withdrawn
    Role's current requirements — its direct required links AND its legacy
    derivation. `requiredCompetencyIdsByUser` reads the same dual sources but
    against the STORED state of every role including this one, so the desired
    substitution is assembled here instead.
  */
  const holderRoleRows = await database.query.membershipRoles.findMany({
    where: and(
      inArray(schema.membershipRoles.membershipId, [...membershipIds]),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  const otherRoleIds = [...new Set(holderRoleRows.map((r) => r.roleId).filter((id) => id !== roleId))];
  const [otherLegacyRows, otherLinkRows] = await Promise.all([
    otherRoleIds.length
      ? database.query.roleRequiredAssessments.findMany({
          where: and(
            eq(schema.roleRequiredAssessments.orgId, orgId),
            inArray(schema.roleRequiredAssessments.roleId, otherRoleIds),
          ),
        })
      : Promise.resolve([]),
    otherRoleIds.length
      ? database.query.roleRequiredCompetencies.findMany({
          where: and(
            eq(schema.roleRequiredCompetencies.orgId, orgId),
            inArray(schema.roleRequiredCompetencies.roleId, otherRoleIds),
            eq(schema.roleRequiredCompetencies.tier, 'required'),
          ),
        })
      : Promise.resolve([]),
  ]);
  const toolsByOtherRole = new Map<string, string[]>();
  for (const r of otherLegacyRows) {
    const list = toolsByOtherRole.get(r.roleId) ?? [];
    list.push(r.toolId);
    toolsByOtherRole.set(r.roleId, list);
  }
  const compsByOtherRole = new Map<string, string[]>();
  for (const l of otherLinkRows) {
    const list = compsByOtherRole.get(l.roleId) ?? [];
    list.push(l.competencyId);
    compsByOtherRole.set(l.roleId, list);
  }
  const rolesByMembership = new Map<string, string[]>();
  for (const r of holderRoleRows) {
    const list = rolesByMembership.get(r.membershipId) ?? [];
    list.push(r.roleId);
    rolesByMembership.set(r.membershipId, list);
  }

  /*
    The tools whose requirement this change drops: the explicitly removed
    legacy rows, plus the awarding tool of each removed link competency
    (resolved through the SHARED resolver so the in-flight count and the case
    the addition preview would plan name the same tool, KTD2). Their awards
    are needed to translate a case's tool back into competency terms.
  */
  const removedAwarding =
    awardingByCompetency ??
    (await awardingToolByCompetency(database, orgId, ctx.removedCompetencyIds));
  const removedScopeToolIds = [
    ...new Set([
      ...ctx.removedLegacyToolIds,
      // Read through the REMOVED ids, not `.values()` — the caller's map may
      // cover the added ids too, and their tools are not in the removal scope.
      ...ctx.removedCompetencyIds.flatMap((c) => {
        const toolId = removedAwarding.get(c);
        return toolId ? [toolId] : [];
      }),
    ]),
  ];

  // Every tool whose awards feed a post-change set or the removal scope.
  const legacyToolUniverse = [
    ...new Set([
      ...ctx.remainingLegacyToolIds,
      ...otherLegacyRows.map((r) => r.toolId),
      ...removedScopeToolIds,
    ]),
  ];
  const toolRows = legacyToolUniverse.length
    ? await database.query.assessmentTools.findMany({
        where: and(
          eq(schema.assessmentTools.orgId, orgId),
          inArray(schema.assessmentTools.id, legacyToolUniverse),
        ),
      })
    : [];
  const awardsByTool = new Map(toolRows.map((t) => [t.id, [...(t.awardedCompetencyIds ?? [])]]));

  // Collapse to per-USER post-change sets (a user may hold the Role via one
  // membership): the legacy TOOLS still required, and the COMPETENCIES still
  // required through either source.
  const postToolsByUser = new Map<string, Set<string>>();
  const postCompsByUser = new Map<string, Set<string>>();
  for (const membershipId of membershipIds) {
    const userId = userByMembership.get(membershipId);
    if (!userId) continue;
    const tools = postToolsByUser.get(userId) ?? new Set<string>(ctx.remainingLegacyToolIds);
    const comps = postCompsByUser.get(userId) ?? new Set<string>(ctx.desiredRequired);
    for (const rid of rolesByMembership.get(membershipId) ?? []) {
      if (rid === roleId) continue;
      for (const t of toolsByOtherRole.get(rid) ?? []) tools.add(t);
      for (const c of compsByOtherRole.get(rid) ?? []) comps.add(c);
    }
    // Legacy tools still required derive their awards into the competency set.
    for (const t of tools) for (const c of awardsByTool.get(t) ?? []) comps.add(c);
    postToolsByUser.set(userId, tools);
    postCompsByUser.set(userId, comps);
  }

  // inFlightContinuing (R55): non-terminal cases among the holders for a tool
  // in the removal scope, where the holder is no longer obliged after the
  // change — the case runs to completion rather than being cancelled. Counts
  // cases. A LINKED tool is still obliging while its award is required through
  // any surviving source; an UNLINKED one (empty awards) while any Role the
  // holder carries still legacy-requires the tool itself.
  let inFlightContinuing = 0;
  if (removedScopeToolIds.length > 0) {
    const cases = await database.query.assessmentCases.findMany({
      where: and(
        eq(schema.assessmentCases.orgId, orgId),
        inArray(schema.assessmentCases.toolId, removedScopeToolIds),
        inArray(schema.assessmentCases.candidateUserId, holderUserIds),
        inArray(schema.assessmentCases.state, NON_TERMINAL_STATES),
      ),
    });
    for (const c of cases) {
      const postTools = postToolsByUser.get(c.candidateUserId);
      const postComps = postCompsByUser.get(c.candidateUserId);
      if (!postTools || !postComps) {
        inFlightContinuing++;
        continue;
      }
      const awards = awardsByTool.get(c.toolId) ?? [];
      const stillObliged =
        awards.length > 0 ? awards.some((a) => postComps.has(a)) : postTools.has(c.toolId);
      if (!stillObliged) inFlightContinuing++;
    }
  }

  // competenciesDemoting (R56): (holder, competency) pairs the holder holds
  // current, this change removes, and no surviving requirement still names.
  let competenciesDemoting = 0;
  if (ctx.removedCompetencyIds.length > 0) {
    for (const userId of holderUserIds) {
      const held = await heldCompetencyStates(database, orgId, userId, now);
      const heldNow = new Set(held.filter((h) => countsAsHeld(h)).map((h) => h.competencyId));
      const postComps = postCompsByUser.get(userId) ?? new Set<string>();
      for (const c of ctx.removedCompetencyIds) {
        if (heldNow.has(c) && !postComps.has(c)) competenciesDemoting++;
      }
    }
  }

  return { inFlightContinuing, competenciesDemoting };
}

// ── award links (U2, KTD3, KTD10) ────────────────────────────────────────────

/**
 * The cases a pending award would ACTIVATE across the given roles' holders
 * (KTD3): per role, the same engine semantics every other assignment path uses
 * (open-case and location rules included), planned with the pending award
 * INJECTED (`awardsOverride`) — the world after the link lands — while writing
 * nothing, which is what keeps preview equal to apply (KTD10).
 *
 * `planToolId` is the tool the KTD2 resolver picks for the competency in that
 * post-link world, which is NOT always the tool being linked — see
 * `resolvePendingAward` below.
 *
 * Deduplicated by membership: a person holding two of the roles is one
 * candidate for one tool, and each membership's plan over the same one-tool
 * scope is identical, so the first plan is the plan.
 *
 * SEQUENTIAL over the roles on purpose — these reads may run inside a pinned
 * transaction connection, which serves one query at a time.
 */
async function planActivationCases(
  database: Database,
  orgId: string,
  roleIds: readonly string[],
  planToolId: string,
  awardsOverride: ReadonlyMap<string, readonly string[]>,
  now: Date,
): Promise<CaseToInsert[]> {
  const casesToInsert: CaseToInsert[] = [];
  const planned = new Set<string>();
  for (const roleId of roleIds) {
    const plans = await planAssignmentsForRole(database, orgId, roleId, [planToolId], now, {
      awardsOverride,
    });
    for (const plan of plans) {
      if (planned.has(plan.membershipId)) continue;
      planned.add(plan.membershipId);
      casesToInsert.push(
        ...plan.cases.map((c) => ({ ...c, orgId, candidateUserId: plan.userId })),
      );
    }
  }
  return casesToInsert;
}

/**
 * WHICH TOOL WILL ACTUALLY AWARD `competencyId` ONCE `toolId`'S LINK LANDS.
 *
 * The tool being linked is NOT automatically the answer. KTD2's resolver picks
 * the FIRST candidate by (createdAt, id) ascending among the org's tools that
 * award the competency and have a published current version — so when an
 * EARLIER published tool already awards it, that earlier tool keeps winning
 * after the link. Planning the activation against `toolId` regardless would
 * create a case for a tool no read site ever names again: the converted role's
 * `requiredToolIdsByRole` would resolve to the earlier tool, the case would
 * satisfy nothing, and preview-equals-apply would hold only against a write
 * the rest of the system disagrees with.
 *
 * So the pending award is injected into the SHARED resolver and the winner it
 * returns is what gets planned. Refusing the link instead (409) was considered
 * and rejected: KTD2 deliberately defines a deterministic winner for the
 * many-tools case, and an admin's backfill must still work when a second tool
 * happens to award the same ticket.
 *
 * Null means nothing bookable will award it — `toolId`'s own template has no
 * published version and no other tool qualifies — which plans zero cases, the
 * evidence-only outcome (R7).
 */
async function resolvePendingAward(
  database: Database,
  orgId: string,
  toolId: string,
  competencyId: string,
): Promise<{ planToolId: string | null; awardsOverride: ReadonlyMap<string, readonly string[]> }> {
  const awardsOverride = new Map<string, readonly string[]>([[toolId, [competencyId]]]);
  const resolved = await awardingToolByCompetency(database, orgId, [competencyId], {
    awardsOverride,
  });
  return { planToolId: resolved.get(competencyId) ?? null, awardsOverride };
}

/** How the conversion writes each legacy role's direct link (unique index!). */
export interface RoleLinkStep {
  roleId: string;
  /**
   * `insert` — no (role, competency) row exists yet.
   * `upgrade` — a RECOMMENDED row exists; conversion promotes its tier, never
   *   inserts a second row (role_required_competencies_uq).
   * `exists` — a required row already exists; nothing to write.
   */
  action: 'insert' | 'upgrade' | 'exists';
  /** The existing row to upgrade, when action is 'upgrade'. */
  existingLinkId?: string;
}

export interface AwardLinkPlan {
  effects: { rolesLinked: number; affected: number; created: number };
  /** `length === effects.created`, by construction (KTD10). */
  casesToInsert: CaseToInsert[];
  roleLinkPlan: RoleLinkStep[];
}

/**
 * The FIRST-LINK computation (U2): what linking `competencyId` as `toolId`'s
 * award converts and activates. Reads only — the preview returns the effects,
 * the apply executes the plan inside one transaction.
 *
 * Linking ACTIVATES assignment rather than preserving it (KTD3): the tool
 * awarded nothing, so the engine treated it as vacuously satisfied and planned
 * no case for anyone. The plan below is therefore computed with the pending
 * award INJECTED (`awardsOverride`) — the world after the link lands — while
 * writing nothing, which is what keeps preview equal to apply.
 */
export async function computeAwardLinkChange(
  database: Database,
  orgId: string,
  toolId: string,
  competencyId: string,
  now: Date,
): Promise<AwardLinkPlan> {
  // The roles that legacy-require this tool — the rows conversion drains.
  const legacyRows = await database.query.roleRequiredAssessments.findMany({
    where: and(
      eq(schema.roleRequiredAssessments.orgId, orgId),
      eq(schema.roleRequiredAssessments.toolId, toolId),
    ),
  });
  const roleIds = [...new Set(legacyRows.map((r) => r.roleId))];

  // Existing (role, competency) links decide insert-vs-upgrade per role.
  const existingLinks = roleIds.length
    ? await database.query.roleRequiredCompetencies.findMany({
        where: and(
          eq(schema.roleRequiredCompetencies.orgId, orgId),
          inArray(schema.roleRequiredCompetencies.roleId, roleIds),
          eq(schema.roleRequiredCompetencies.competencyId, competencyId),
        ),
      })
    : [];
  const existingByRole = new Map(existingLinks.map((l) => [l.roleId, l]));
  const roleLinkPlan: RoleLinkStep[] = roleIds.map((roleId) => {
    const existing = existingByRole.get(roleId);
    if (!existing) return { roleId, action: 'insert' };
    if (existing.tier === 'recommended')
      return { roleId, action: 'upgrade', existingLinkId: existing.id };
    return { roleId, action: 'exists' };
  });

  // Holders across the linked roles — the headcount the preview shows.
  const holderRows = roleIds.length
    ? await database.query.membershipRoles.findMany({
        where: and(
          inArray(schema.membershipRoles.roleId, roleIds),
          isNull(schema.membershipRoles.withdrawnAt),
        ),
      })
    : [];
  const membershipIds = [...new Set(holderRows.map((h) => h.membershipId))];

  // The cases the link WOULD create: per linked role, the holders who do not
  // hold the competency and have no open case for the tool that will award it
  // — the shared activation planner, pending award injected, deduplicated by
  // membership. The tool planned for is the KTD2 WINNER, which is `toolId`
  // only while no earlier published tool already awards this competency.
  const { planToolId, awardsOverride } = await resolvePendingAward(
    database,
    orgId,
    toolId,
    competencyId,
  );
  const casesToInsert = planToolId
    ? await planActivationCases(database, orgId, roleIds, planToolId, awardsOverride, now)
    : [];

  return {
    effects: {
      rolesLinked: roleIds.length,
      affected: membershipIds.length,
      created: casesToInsert.length,
    },
    casesToInsert,
    roleLinkPlan,
  };
}

/** How each outgoing required link is carried to the incoming competency. */
export interface CarryStep {
  /** The outgoing (role, oldCompetency) row. */
  linkId: string;
  roleId: string;
  /**
   * `repoint` — no (role, incoming) row exists; the outgoing row's
   *   competencyId is rewritten in place.
   * `merge-upgrade` — a RECOMMENDED (role, incoming) row exists; it is
   *   promoted to required and the outgoing row deleted (unique index).
   * `merge-delete` — a required (role, incoming) row already exists; the
   *   outgoing row is simply deleted.
   */
  action: 'repoint' | 'merge-upgrade' | 'merge-delete';
  /** The existing (role, incoming) row, for the merge actions. */
  targetLinkId?: string;
}

export interface AwardRelinkPlan {
  effects: { outgoingGrants: number; rolesRequiringOutgoing: number; created: number };
  /** `length === effects.created`, by construction (KTD10). */
  casesToInsert: CaseToInsert[];
  carryPlan: CarryStep[];
}

/**
 * The RE-LINK computation (KTD10): what re-pointing `toolId`'s award from
 * `outgoingCompetencyId` to `incomingCompetencyId` touches. Grants of the
 * outgoing competency are counted for the confirm and NEVER touched — history
 * is state; they stay attached to the competency they attest.
 *
 * Only REQUIRED-tier links of the outgoing competency are carried: they are
 * the requirement that would lose its awarding tool. A recommended link never
 * enforced anything, so it keeps pointing at the outgoing competency.
 */
export async function computeAwardRelinkChange(
  database: Database,
  orgId: string,
  toolId: string,
  outgoingCompetencyId: string,
  incomingCompetencyId: string,
  carryRoleLinks: boolean,
  now: Date,
): Promise<AwardRelinkPlan> {
  const grantRows = await database.query.competencyHolders.findMany({
    where: and(
      eq(schema.competencyHolders.orgId, orgId),
      eq(schema.competencyHolders.competencyId, outgoingCompetencyId),
      isNull(schema.competencyHolders.revokedAt),
    ),
  });

  const outgoingLinks = await database.query.roleRequiredCompetencies.findMany({
    where: and(
      eq(schema.roleRequiredCompetencies.orgId, orgId),
      eq(schema.roleRequiredCompetencies.competencyId, outgoingCompetencyId),
      eq(schema.roleRequiredCompetencies.tier, 'required'),
    ),
  });
  const roleIds = [...new Set(outgoingLinks.map((l) => l.roleId))];

  // What each carried role already says about the INCOMING competency —
  // the dedupe/upgrade against the unique (roleId, competencyId) index.
  const incomingLinks = roleIds.length
    ? await database.query.roleRequiredCompetencies.findMany({
        where: and(
          eq(schema.roleRequiredCompetencies.orgId, orgId),
          inArray(schema.roleRequiredCompetencies.roleId, roleIds),
          eq(schema.roleRequiredCompetencies.competencyId, incomingCompetencyId),
        ),
      })
    : [];
  const incomingByRole = new Map(incomingLinks.map((l) => [l.roleId, l]));
  const carryPlan: CarryStep[] = outgoingLinks.map((link) => {
    const target = incomingByRole.get(link.roleId);
    if (!target) return { linkId: link.id, roleId: link.roleId, action: 'repoint' };
    if (target.tier === 'recommended')
      return { linkId: link.id, roleId: link.roleId, action: 'merge-upgrade', targetLinkId: target.id };
    return { linkId: link.id, roleId: link.roleId, action: 'merge-delete', targetLinkId: target.id };
  });

  // The cases the incoming competency would create for the carried roles'
  // holders — only when the links travel with it; without the carry the roles
  // stop deriving this tool and nothing new is owed. Planned by the shared
  // activation planner against the KTD2 winner, same correction as the first
  // link: another published tool may already award the INCOMING competency and
  // would keep winning the resolution after this re-link.
  let casesToInsert: CaseToInsert[] = [];
  if (carryRoleLinks && roleIds.length > 0) {
    const { planToolId, awardsOverride } = await resolvePendingAward(
      database,
      orgId,
      toolId,
      incomingCompetencyId,
    );
    if (planToolId) {
      casesToInsert = await planActivationCases(
        database,
        orgId,
        roleIds,
        planToolId,
        awardsOverride,
        now,
      );
    }
  }

  return {
    effects: {
      outgoingGrants: grantRows.length,
      rolesRequiringOutgoing: roleIds.length,
      created: casesToInsert.length,
    },
    casesToInsert,
    carryPlan,
  };
}
