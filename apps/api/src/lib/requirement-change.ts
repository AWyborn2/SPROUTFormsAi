/**
 * The blast radius of a retrospective change to a SCOPE's requirements (U12,
 * KTD10 — reworked into COMPETENCY terms by the role-competency links round,
 * scope-generalised by the requirement inheritance round, U4/KTD5), plus the
 * award-link computations that share its compute-then-apply shape (U2, KTD3,
 * KTD10 — those stay ROLE-scoped, KTD2: legacy rows only ever lived on roles).
 *
 * ONE function computes the effects AND the write plan, reading only. The
 * preview endpoint runs it and discards the plan; the apply endpoint runs the
 * SAME function and then executes the plan. Because `created` is the length of
 * the plan the apply inserts, the previewed and applied counts agree on
 * unchanged data — the guarantee KTD10 exists to give. Preview == apply now
 * holds at all FOUR scopes (R6): an org-level save's preview covers every
 * active membership in the org.
 *
 * The removal effects (R55, R56) are computed PER HOLDER against each person's
 * post-change required set — the union of the holder's OTHER scopes (their
 * other roles' links and legacy rows, their placed locations and departments,
 * the org scope) plus the edited scope's desired set — so AE4 falls out of
 * the same computation: removing a competency from a role while the org still
 * requires it demotes nothing, and the preview says so (KTD5).
 */
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  CASE_STATES,
  countsAsHeld,
  isTerminalCaseState,
  type RequiredAssessmentsChangeEffects,
} from '@formai/shared';
import {
  heldCompetencyStatesByUser,
  planAssignmentsForMemberships,
  planAssignmentsForRole,
  type PlannedCase,
} from './assignment.js';
import { awardingToolByCompetency } from './requirement-links.js';
import {
  requirementIndexForScopes,
  scopeKeysForMemberships,
  type MembershipScopeKeys,
  type Reader,
  type RequirementScopeRef,
} from './standing.js';

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
   * the awaitingLink exit (KTD9). ROLE SCOPE ONLY (KTD6): legacy rows never
   * existed at the other scopes, and the routes refuse the field elsewhere.
   * The requirement PUT never touches legacy rows; only the explicit remove
   * action names ids here.
   */
  removeLegacyToolIds?: readonly string[];
}

/** Re-exported so route code can name a scope without importing standing.ts. */
export type { RequirementScopeRef };

/**
 * The `competency_requirements` rows OF one scope — the single definition of
 * "scope-local" every read below and the route's `loadRequirementState`
 * share (KTD7: a fingerprint hashes exactly these rows and nothing inherited).
 * The org scope is the CHECK-enforced all-null shape, never a sentinel (KTD1).
 */
export function requirementScopeWhere(orgId: string, scope: RequirementScopeRef) {
  const cr = schema.competencyRequirements;
  switch (scope.kind) {
    case 'role':
      return and(eq(cr.orgId, orgId), eq(cr.roleId, scope.id));
    case 'location':
      return and(eq(cr.orgId, orgId), eq(cr.locationId, scope.id));
    case 'department':
      return and(eq(cr.orgId, orgId), eq(cr.departmentId, scope.id));
    case 'org':
      return and(
        eq(cr.orgId, orgId),
        isNull(cr.roleId),
        isNull(cr.locationId),
        isNull(cr.departmentId),
      );
  }
}

/**
 * The memberships a scope's requirements REACH — the KTD5 holder expansion,
 * one query per scope kind:
 *   role       → `membership_roles` still held (withdrawnAt IS NULL, R52)
 *   department → `membership_departments` (placement, R3)
 *   location   → `membership_locations` (placement, R3)
 *   org        → every ACTIVE membership of the organisation (R6/AE3 — the
 *                blast radius an org save previews is everyone active; a
 *                deactivated membership plans nothing anyway, R64).
 */
export async function membershipIdsForScope(
  database: Database,
  orgId: string,
  scope: RequirementScopeRef,
): Promise<string[]> {
  switch (scope.kind) {
    case 'role': {
      const rows = await database.query.membershipRoles.findMany({
        where: and(
          eq(schema.membershipRoles.roleId, scope.id),
          isNull(schema.membershipRoles.withdrawnAt),
        ),
      });
      return [...new Set(rows.map((r) => r.membershipId))];
    }
    case 'department': {
      const rows = await database.query.membershipDepartments.findMany({
        where: eq(schema.membershipDepartments.departmentId, scope.id),
      });
      return [...new Set(rows.map((r) => r.membershipId))];
    }
    case 'location': {
      const rows = await database.query.membershipLocations.findMany({
        where: eq(schema.membershipLocations.locationId, scope.id),
      });
      return [...new Set(rows.map((r) => r.membershipId))];
    }
    case 'org': {
      const rows = await database.query.memberships.findMany({
        where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active')),
      });
      return rows.map((r) => r.id);
    }
  }
}

/**
 * The effects of changing ONE SCOPE's required competencies to the desired set
 * (and/or, at role scope, removing named legacy rows), and the cases an apply
 * would create. Reads only — safe to run at the top of an apply transaction,
 * before any write.
 *
 * The diff runs over the scope's DIRECT required links only: the PUT owns
 * nothing but this scope's `competency_requirements` rows (KTD9, KTD7), so a
 * competency a remaining legacy row still derives — or another scope still
 * names (KTD2) — keeps obliging through the union regardless of what this
 * change does to the links.
 */
export async function computeRequiredAssessmentsChange(
  database: Database,
  orgId: string,
  scope: RequirementScopeRef,
  desired: RequiredCompetencyChange,
  now: Date,
): Promise<RequiredAssessmentsChangePlan> {
  const desiredRequired = new Set(desired.requiredCompetencyIds);

  // 1. Diff current vs desired, in competency terms — this scope's rows only.
  const currentLinks = await database.query.competencyRequirements.findMany({
    where: requirementScopeWhere(orgId, scope),
  });
  const currentRequired = new Set(
    currentLinks.filter((l) => l.tier === 'required').map((l) => l.competencyId),
  );
  const addedCompetencyIds = [...desiredRequired].filter((id) => !currentRequired.has(id));
  const removedLinkCompetencyIds = [...currentRequired].filter((id) => !desiredRequired.has(id));

  // The Role's legacy rows, and which of them this change removes — ROLE SCOPE
  // ONLY (KTD2/KTD6): the other three scopes never had a legacy derivation, so
  // for them both lists are simply empty. Filtered to rows that actually exist
  // so a stale id cannot inflate the effect counts.
  const legacyRows =
    scope.kind === 'role'
      ? await database.query.roleRequiredAssessments.findMany({
          where: eq(schema.roleRequiredAssessments.roleId, scope.id),
        })
      : [];
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

  // 2. Holders / affected — every membership the scope reaches (KTD5 headcount).
  const membershipIds = await membershipIdsForScope(database, orgId, scope);
  const affected = membershipIds.length;

  // 3. Addition plan — each ADDED competency resolved to its awarding tool
  //    through the SHARED resolver (KTD2), so the preview and the apply cannot
  //    name different tools. A competency with no awarding tool plans nothing
  //    (R7, R9 — evidence-only); `created` is a case count. The plan itself is
  //    batched set-wise over the holders (`planAssignmentsForMemberships`,
  //    U4's org-scale discipline) — an org save must not loop contexts.
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
      const plans = await planAssignmentsForMemberships(
        database,
        orgId,
        membershipIds,
        addedToolIds,
        now,
      );
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
      scope,
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
  scope: RequirementScopeRef,
  ctx: {
    /** The edited scope's post-change direct required competencies. */
    desiredRequired: ReadonlySet<string>;
    /** The edited Role's legacy rows surviving the change (role scope only). */
    remainingLegacyToolIds: readonly string[];
    /** The competencies leaving required standing (links + removed-legacy awards). */
    removedCompetencyIds: readonly string[];
    /** Legacy tool rows this change explicitly removes (role scope only). */
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
    Post-change requirements PER HOLDER — the edited scope's desired set (and,
    at role scope, its surviving legacy rows) plus the UNION OF THE HOLDER'S
    OTHER SCOPES (KTD5): their other held roles' links and legacy derivation,
    their placed locations, their placed departments, and the org scope. The
    edited scope's own key is SUBTRACTED per membership and the desired set
    substituted, which is what makes AE4 fall out: a competency the org still
    requires cannot demote when a role drops it, and vice versa.

    The expansion reuses `scopeKeysForMemberships` — so the U4 retirement
    split holds here exactly as it does in standing: a retired location or
    department contributes NOTHING to a post-change set (its requirements
    stopped applying), while a retired-but-held role keeps contributing
    (R119 posture; withdrawal is what ends its obligations).

    BATCHED SET-WISE throughout (U4's org-scale discipline): one expansion,
    one requirement-index read over the union of keys, one legacy read, one
    tool read, one case read, one held-competency pair — never a per-holder
    loop of queries.
  */
  const keysByMembership = await scopeKeysForMemberships(database, orgId, membershipIds);
  // Subtract the edited scope's own key from each membership's expansion.
  const otherKeysByMembership = new Map<string, MembershipScopeKeys>();
  for (const [membershipId, keys] of keysByMembership) {
    otherKeysByMembership.set(membershipId, {
      roleIds: scope.kind === 'role' ? keys.roleIds.filter((id) => id !== scope.id) : keys.roleIds,
      locationIds:
        scope.kind === 'location'
          ? keys.locationIds.filter((id) => id !== scope.id)
          : keys.locationIds,
      departmentIds:
        scope.kind === 'department'
          ? keys.departmentIds.filter((id) => id !== scope.id)
          : keys.departmentIds,
    });
  }
  const unionOtherKeys: MembershipScopeKeys = { roleIds: [], locationIds: [], departmentIds: [] };
  for (const keys of otherKeysByMembership.values()) {
    unionOtherKeys.roleIds.push(...keys.roleIds);
    unionOtherKeys.locationIds.push(...keys.locationIds);
    unionOtherKeys.departmentIds.push(...keys.departmentIds);
  }
  unionOtherKeys.roleIds = [...new Set(unionOtherKeys.roleIds)];
  unionOtherKeys.locationIds = [...new Set(unionOtherKeys.locationIds)];
  unionOtherKeys.departmentIds = [...new Set(unionOtherKeys.departmentIds)];

  // The OTHER scopes' direct required rows, via the one shared four-scope read
  // (standing.ts) — org rows ride along and apply below unless the org scope
  // is the one being edited (its contribution is `desiredRequired` then).
  const otherIndex = await requirementIndexForScopes(database, orgId, unionOtherKeys, 'required');
  const otherOrgCompetencyIds = scope.kind === 'org' ? [] : otherIndex.orgCompetencyIds;

  // Legacy half of the other roles (KTD2 — role scope only ever had one). The
  // edited role's own surviving rows arrive via `ctx.remainingLegacyToolIds`.
  const otherLegacyRows = unionOtherKeys.roleIds.length
    ? await database.query.roleRequiredAssessments.findMany({
        where: and(
          eq(schema.roleRequiredAssessments.orgId, orgId),
          inArray(schema.roleRequiredAssessments.roleId, unionOtherKeys.roleIds),
        ),
      })
    : [];
  const toolsByOtherRole = new Map<string, string[]>();
  for (const r of otherLegacyRows) {
    const list = toolsByOtherRole.get(r.roleId) ?? [];
    list.push(r.toolId);
    toolsByOtherRole.set(r.roleId, list);
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

  // Collapse to per-USER post-change sets (a user may reach the scope via one
  // membership): the legacy TOOLS still required, and the COMPETENCIES still
  // required through any surviving source — the AE4 subtraction's other half.
  const postToolsByUser = new Map<string, Set<string>>();
  const postCompsByUser = new Map<string, Set<string>>();
  for (const membershipId of membershipIds) {
    const userId = userByMembership.get(membershipId);
    if (!userId) continue;
    const tools = postToolsByUser.get(userId) ?? new Set<string>(ctx.remainingLegacyToolIds);
    const comps = postCompsByUser.get(userId) ?? new Set<string>(ctx.desiredRequired);
    const keys = otherKeysByMembership.get(membershipId);
    for (const rid of keys?.roleIds ?? []) {
      for (const t of toolsByOtherRole.get(rid) ?? []) tools.add(t);
      for (const c of otherIndex.byRole.get(rid) ?? []) comps.add(c);
    }
    for (const lid of keys?.locationIds ?? []) {
      for (const c of otherIndex.byLocation.get(lid) ?? []) comps.add(c);
    }
    for (const did of keys?.departmentIds ?? []) {
      for (const c of otherIndex.byDepartment.get(did) ?? []) comps.add(c);
    }
    // Org scope applies to every membership unconditionally (R2) — unless the
    // org scope is the very one being edited, whose post state is the desired
    // set already seeded above.
    for (const c of otherOrgCompetencyIds) comps.add(c);
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
  // Batched (U4): one held-state read for the whole holder set, not per user.
  let competenciesDemoting = 0;
  if (ctx.removedCompetencyIds.length > 0) {
    const heldByUser = await heldCompetencyStatesByUser(database, orgId, holderUserIds, now);
    for (const userId of holderUserIds) {
      const held = heldByUser.get(userId) ?? [];
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
   *   inserts a second row (competency_requirements_role_uq).
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
    ? await database.query.competencyRequirements.findMany({
        where: and(
          eq(schema.competencyRequirements.orgId, orgId),
          inArray(schema.competencyRequirements.roleId, roleIds),
          eq(schema.competencyRequirements.competencyId, competencyId),
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

  // ROLE-SCOPE ROWS ONLY (KTD2): award-link conversion is inherently
  // role-scoped — legacy rows only ever lived on roles — so an org/location/
  // department requirement of the outgoing competency is neither carried nor
  // counted; without this filter the carry plan would ingest null-roleId rows.
  const outgoingRows = await database.query.competencyRequirements.findMany({
    where: and(
      eq(schema.competencyRequirements.orgId, orgId),
      eq(schema.competencyRequirements.competencyId, outgoingCompetencyId),
      eq(schema.competencyRequirements.tier, 'required'),
      isNotNull(schema.competencyRequirements.roleId),
    ),
  });
  // The WHERE guarantees roleId; the flatMap narrows what TS cannot see, so a
  // CarryStep can keep its non-null roleId contract.
  const outgoingLinks = outgoingRows.flatMap((l) =>
    l.roleId === null ? [] : [{ ...l, roleId: l.roleId }],
  );
  const roleIds = [...new Set(outgoingLinks.map((l) => l.roleId))];

  // What each carried role already says about the INCOMING competency —
  // the dedupe/upgrade against the unique (roleId, competencyId) index.
  const incomingLinks = roleIds.length
    ? await database.query.competencyRequirements.findMany({
        where: and(
          eq(schema.competencyRequirements.orgId, orgId),
          inArray(schema.competencyRequirements.roleId, roleIds),
          eq(schema.competencyRequirements.competencyId, incomingCompetencyId),
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
