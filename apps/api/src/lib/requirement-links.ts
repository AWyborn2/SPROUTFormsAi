/**
 * The SHARED resolver that inverts the requirement derivation (KTD2).
 *
 * Roles now store requirements as competencies (`competency_requirements`),
 * but the assignment engine still speaks in TOOLS — a case is opened for the
 * assessment that awards the missing competency. This module is the one place
 * that translation happens, called from every real read site (the assignment
 * seam, the requirement-change compute, and — for standing — the sibling
 * derivation in standing.ts), so preview and apply cannot resolve a competency
 * to two different tools.
 *
 * Resolution rule (KTD2, stated once, used everywhere): the candidate tools
 * for a competency are the organisation's assessment tools whose awards list
 * contains it AND whose template has a published current version; they are
 * ordered by (createdAt, id) ascending and the FIRST wins. Zero candidates
 * means the competency is evidence-only (R7) — no tool, no case, tracked as a
 * compliance gap by the standing reads instead.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  requirementIndexForScopes,
  scopeKeysForMemberships,
  type MembershipScopeKeys,
  type Reader,
} from './standing.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;

/**
 * Optional knobs for a resolution run.
 *
 * `awardsOverride` substitutes a tool's awards list for the duration of the
 * resolution — the same mechanism `PlanOptions.awardsOverride` gives the
 * assignment planner, and needed for the same reason (U2, KTD10): an award
 * link that has not committed yet is invisible to this read, so a first-link
 * preview asking "which tool will award this competency once I press save?"
 * must inject the pending award. Without it the resolver would answer for the
 * PRE-link world while the apply wrote the post-link one.
 */
export interface ResolveOptions {
  awardsOverride?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Resolve each given competency to its ONE awarding tool, per the KTD2 rule.
 * A competency with no qualifying tool is simply absent from the map — the
 * caller reads absence as "evidence-only".
 *
 * `awardedCompetencyIds` is jsonb with no FK, so containment is filtered in
 * JS over the org's tools rather than pushed into SQL — the same posture the
 * competency in-use check takes, and per-org tool lists are small.
 */
export async function awardingToolByCompetency(
  reader: Reader,
  orgId: string,
  competencyIds: readonly string[],
  options: ResolveOptions = {},
): Promise<Map<string, string>> {
  const byCompetency = new Map<string, string>();
  const wanted = new Set(competencyIds);
  if (wanted.size === 0) return byCompetency;

  const tools = await reader.query.assessmentTools.findMany({
    where: eq(schema.assessmentTools.orgId, orgId),
  });
  // A pending award injected by the caller WINS over the stored list, so the
  // ordering below ranks the post-link world rather than the stored one.
  const awardsOf = (t: { id: string; awardedCompetencyIds: string[] | null }): readonly string[] =>
    options.awardsOverride?.get(t.id) ?? t.awardedCompetencyIds ?? [];
  const candidates = tools.filter((t) => awardsOf(t).some((c) => wanted.has(c)));
  if (candidates.length === 0) return byCompetency;

  // Only a tool whose template has a PUBLISHED version can carry a case —
  // the same filter the assignment planner applies, moved up front so an
  // unbookable tool never wins the resolution over a bookable one.
  const templateIds = [...new Set(candidates.map((t) => t.templateId))];
  const templates = await reader.query.formTemplates.findMany({
    where: and(
      eq(schema.formTemplates.orgId, orgId),
      inArray(schema.formTemplates.id, templateIds),
    ),
  });
  const publishable = new Set(templates.filter((t) => t.currentVersionId).map((t) => t.id));

  // (createdAt, id) ascending, FIRST wins — deterministic, so a preview and
  // its apply (or two admins previewing at once) always name the same tool.
  const ordered = candidates
    .filter((t) => publishable.has(t.templateId))
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  for (const tool of ordered) {
    for (const competencyId of awardsOf(tool)) {
      if (wanted.has(competencyId) && !byCompetency.has(competencyId)) {
        byCompetency.set(competencyId, tool.id);
      }
    }
  }
  return byCompetency;
}

/** Single-competency shape of the resolution — for callers holding one id. */
export async function awardingToolFor(
  reader: Reader,
  orgId: string,
  competencyId: string,
  options: ResolveOptions = {},
): Promise<string | null> {
  const byCompetency = await awardingToolByCompetency(reader, orgId, [competencyId], options);
  return byCompetency.get(competencyId) ?? null;
}

/**
 * The required TOOLS of each given Role — the dual read (KTD2, KTD3): every
 * remaining legacy `role_required_assessments` row, PLUS each direct
 * required-tier competency link resolved to its awarding tool. Every requested
 * roleId maps to an array (possibly empty), so callers can look each role up.
 *
 * Recommended-tier links never appear here: they are the never-enforced tier
 * (R13) and must not reach the assignment engine.
 */
export async function requiredToolIdsByRole(
  database: Database | Reader,
  orgId: string,
  roleIds: readonly string[],
): Promise<Map<string, string[]>> {
  const uniqueRoleIds = [...new Set(roleIds)];
  const byRole = new Map<string, string[]>();
  for (const roleId of uniqueRoleIds) byRole.set(roleId, []);
  if (uniqueRoleIds.length === 0) return byRole;

  const run = async (reader: Reader): Promise<Map<string, string[]>> => {
    const legacyRows = await reader.query.roleRequiredAssessments.findMany({
      where: and(
        eq(schema.roleRequiredAssessments.orgId, orgId),
        inArray(schema.roleRequiredAssessments.roleId, uniqueRoleIds),
      ),
    });
    // Direct half: tier 'required' only — recommended never assigns (R13).
    const linkRows = await reader.query.competencyRequirements.findMany({
      where: and(
        eq(schema.competencyRequirements.orgId, orgId),
        inArray(schema.competencyRequirements.roleId, uniqueRoleIds),
        eq(schema.competencyRequirements.tier, 'required'),
      ),
    });
    const awarding = await awardingToolByCompetency(
      reader,
      orgId,
      linkRows.map((l) => l.competencyId),
    );

    for (const roleId of uniqueRoleIds) {
      // A Set per role: during transition a converted requirement can briefly
      // be named by both halves, and one tool must not become two.
      const toolIds = new Set<string>();
      for (const row of legacyRows) if (row.roleId === roleId) toolIds.add(row.toolId);
      for (const link of linkRows) {
        if (link.roleId !== roleId) continue;
        const toolId = awarding.get(link.competencyId);
        // Absent → evidence-only (R7): required standing tracks it, but there
        // is no assessment to assign for it.
        if (toolId) toolIds.add(toolId);
      }
      byRole.set(roleId, [...toolIds]);
    }
    return byRole;
  };

  /*
    ONE SNAPSHOT FOR BOTH HALVES (KTD3). An award conversion deletes a legacy
    row and inserts the direct link in one commit; read on the root client,
    that commit could land between the two reads here and the requirement
    would vanish from both halves for the duration of a request. In production
    every surface handed in exposes `.transaction` — the root client opens a
    real one, an already-open transaction nests as a savepoint on the same
    snapshot — so the reads are always pinned. The guard tolerates the lean
    read-only fakes tests drive the callers with.

    REPEATABLE READ, not the default READ COMMITTED: under READ COMMITTED each
    statement takes a fresh snapshot and the wrapper pins nothing, so the
    conversion's commit could still land between the two halves. Read-only, so
    the stricter level cannot raise a serialization failure here. A NESTED call
    becomes a savepoint and inherits the OUTER transaction's level — the option
    is ignored there, which is why any caller wrapping this in its own
    transaction must open that one at repeatable read too.
  */
  const transactional = database as Database;
  if (typeof transactional.transaction === 'function') {
    return transactional.transaction((tx) => run(tx), { isolationLevel: 'repeatable read' });
  }
  return run(database as Reader);
}

/**
 * The required TOOLS of ONE membership across its FULL scope union (KTD4) —
 * the read that replaced `requiredToolIdsByRole` at the assignment seam. The
 * membership expands to its scope keys (org implicit, placed Locations and
 * Departments with retired values dropped, held non-withdrawn Roles — the U4
 * split lives in the expansion, not here), the requirement rows union across
 * them, and each required competency resolves to its ONE awarding tool by the
 * KTD2 rule. The legacy `role_required_assessments` derivation rides along
 * for the membership's roles — legacy rows never existed at the other scopes,
 * so the dual read stays role-shaped inside a scope-shaped union.
 *
 * Returns a FLAT deduplicated tool list rather than a per-scope map: the one
 * consumer is the assignment engine, which has always flattened before
 * deciding (KTD4 — `decideAssignments` unions the arrays), and a case records
 * no scope anyway. Recommended-tier links never appear here: they are the
 * never-enforced tier (R13) and must not reach the assignment engine.
 * A competency with no awarding tool is evidence-only (R7): required standing
 * tracks it, but there is no assessment to assign for it.
 */
export async function requiredToolIdsForMembership(
  database: Database | Reader,
  orgId: string,
  membershipId: string,
): Promise<string[]> {
  const run = async (reader: Reader): Promise<string[]> => {
    const keys: MembershipScopeKeys = (
      await scopeKeysForMemberships(reader, orgId, [membershipId])
    ).get(membershipId) ?? { locationIds: [], departmentIds: [], roleIds: [] };

    // Legacy half — ROLE scope only (KTD2); skipped entirely for a role-less
    // membership, whose whole obligation is direct links.
    const legacyRows = keys.roleIds.length
      ? await reader.query.roleRequiredAssessments.findMany({
          where: and(
            eq(schema.roleRequiredAssessments.orgId, orgId),
            inArray(schema.roleRequiredAssessments.roleId, keys.roleIds),
          ),
        })
      : [];

    // Direct half — the shared four-scope read (one definition, standing.ts),
    // flattened here because only membership-level obligation matters to a plan.
    const index = await requirementIndexForScopes(reader, orgId, keys, 'required');
    const competencyIds = [
      ...new Set([
        ...keys.roleIds.flatMap((roleId) => index.byRole.get(roleId) ?? []),
        ...keys.locationIds.flatMap((locationId) => index.byLocation.get(locationId) ?? []),
        ...keys.departmentIds.flatMap((departmentId) => index.byDepartment.get(departmentId) ?? []),
        ...index.orgCompetencyIds,
      ]),
    ];
    const awarding = await awardingToolByCompetency(reader, orgId, competencyIds);

    // A Set: a tool the legacy row names AND a link resolves to — or that two
    // scopes both require through their links — must not become two cases.
    const toolIds = new Set<string>(legacyRows.map((row) => row.toolId));
    for (const competencyId of competencyIds) {
      const toolId = awarding.get(competencyId);
      if (toolId) toolIds.add(toolId); // absent → evidence-only (R7)
    }
    return [...toolIds];
  };

  /*
    ONE SNAPSHOT FOR THE WHOLE EXPANSION (KTD3) — and since U2 that snapshot
    covers the PLACEMENT tables too: a location transfer or an award
    conversion committing between the scope-key read and the requirement read
    would otherwise plan against half a world. Same posture as
    `requiredToolIdsByRole` above: repeatable read (READ COMMITTED would
    re-snapshot per statement and pin nothing), tolerant of the lean read-only
    fakes tests drive the callers with, and inheriting the outer level when
    nested as a savepoint.
  */
  const transactional = database as Database;
  if (typeof transactional.transaction === 'function') {
    return transactional.transaction((tx) => run(tx), { isolationLevel: 'repeatable read' });
  }
  return run(database as Reader);
}
