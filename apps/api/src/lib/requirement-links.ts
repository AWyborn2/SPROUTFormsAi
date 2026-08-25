/**
 * The SHARED resolver that inverts the requirement derivation (KTD2).
 *
 * Scopes now store requirements as competencies (`competency_requirements`),
 * but the assignment engine still speaks in TOOLS — a case is opened for the
 * assessment that awards the missing competency. `awardingToolByCompetency` is
 * the one place that translation happens: the assignment seam, the
 * requirement-change compute, the compliance bookability flag and the standing
 * sibling all call it, so preview and apply cannot resolve a competency to two
 * different tools.
 *
 * Above it sits exactly ONE membership-shaped read — `requiredToolIdsByMembership`
 * (and its single-membership shape). The per-ROLE dual read that predated the
 * scopes was deleted with its last caller (see the note above it): a role's
 * requirements are only part of a person's obligation once location, department
 * and org scopes exist, so a second resolver keyed by role could only drift.
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
  unionKeys,
  type MembershipScopeKeys,
  type Reader,
  type ScopeRequirementIndex,
} from './standing.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;

/*
  ONE SNAPSHOT FOR EVERY READ A RESOLUTION MAKES (KTD3). An award conversion
  deletes a legacy row and inserts the direct link in one commit — and since
  U2 the membership-shaped reads span the PLACEMENT tables too, where a
  location transfer could commit mid-read. Run on the root client, such a
  commit could land between two of the reads and the requirement would vanish
  from both halves (or the expansion would plan against half a world) for the
  duration of a request. In production every surface handed in exposes
  `.transaction` — the root client opens a real one, an already-open
  transaction nests as a savepoint on the same snapshot — so the reads are
  always pinned. The guard tolerates the lean read-only fakes tests drive the
  callers with.

  REPEATABLE READ, not the default READ COMMITTED: under READ COMMITTED each
  statement takes a fresh snapshot and the wrapper pins nothing, so a
  conversion's commit could still land between the two halves. Read-only, so
  the stricter level cannot raise a serialization failure here. A NESTED call
  becomes a savepoint and inherits the OUTER transaction's level — the option
  is ignored there, which is why any caller wrapping these in its own
  transaction must open that one at repeatable read too.

  EXPORTED for exactly that reason. A caller that needs the tool resolution AND
  a second read to agree — `assignForMembership` pairing it with the membership
  context, `replanMemberships` pairing it with the batch plan — wraps BOTH in
  one of these; the nested resolution then rides the outer snapshot as a
  savepoint instead of taking a fresh one of its own. Sharing this helper is
  what keeps "repeatable read" from being retyped (and mistyped) at each seam.
*/
export function runSnapshotted<T>(
  database: Database | Reader,
  run: (reader: Reader) => Promise<T>,
): Promise<T> {
  const transactional = database as Database;
  if (typeof transactional.transaction === 'function') {
    return transactional.transaction((tx) => run(tx), { isolationLevel: 'repeatable read' });
  }
  return run(database as Reader);
}

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

/** The tool-row fields the resolution reads — structural, so both the stored
 * rows and a test's plain objects fit. */
interface AwardingToolRow {
  id: string;
  templateId: string;
  awardedCompetencyIds: string[] | null;
  createdAt: Date;
}

/** A pending award injected by the caller WINS over the stored list, so the
 * ordering below ranks the post-link world rather than the stored one. */
const awardsOf = (t: AwardingToolRow, options: ResolveOptions): readonly string[] =>
  options.awardsOverride?.get(t.id) ?? t.awardedCompetencyIds ?? [];

/**
 * THE KTD2 RULE'S ONE IMPLEMENTATION — the shared tail of the wanted-set and
 * org-wide resolutions below. Private so the rule cannot grow a third public
 * spelling: both entry points differ only in how `wanted` is built, and the
 * candidate filter, the published-template gate and the (createdAt, id)
 * ordering live here exactly once.
 */
async function resolveAmongTools(
  reader: Reader,
  orgId: string,
  tools: readonly AwardingToolRow[],
  wanted: ReadonlySet<string>,
  options: ResolveOptions,
): Promise<Map<string, string>> {
  const byCompetency = new Map<string, string>();
  const candidates = tools.filter((t) => awardsOf(t, options).some((c) => wanted.has(c)));
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
    for (const competencyId of awardsOf(tool, options)) {
      if (wanted.has(competencyId) && !byCompetency.has(competencyId)) {
        byCompetency.set(competencyId, tool.id);
      }
    }
  }
  return byCompetency;
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
  const wanted = new Set(competencyIds);
  if (wanted.size === 0) return new Map();

  const tools = await reader.query.assessmentTools.findMany({
    where: eq(schema.assessmentTools.orgId, orgId),
  });
  return resolveAmongTools(reader, orgId, tools, wanted, options);
}

/**
 * The WHOLE org's awarding resolution in one read — every competency any org
 * tool awards, resolved to its one tool by the same KTD2 rule (shared tail
 * above, so this and the wanted-set shape cannot rank differently).
 *
 * Exists for the training matrix (U2): the grid resolves competency → tool for
 * every column of every row, and the wanted-set shape would either be called
 * per user (an org-wide tools read multiplied by headcount) or force the route
 * to pre-collect the union of ids the tools read was about to reveal anyway.
 * One call per REQUEST, whatever the workforce size — the same batching
 * discipline `requiredToolIdsByMembership` applies at the assignment seam.
 *
 * The map answers only for competencies some tool AWARDS; a caller holding the
 * org's full competency list reads absence as evidence-only (R7), exactly as
 * with the wanted-set shape.
 */
export async function awardingToolByCompetencyForOrg(
  reader: Reader,
  orgId: string,
  options: ResolveOptions = {},
): Promise<Map<string, string>> {
  const tools = await reader.query.assessmentTools.findMany({
    where: eq(schema.assessmentTools.orgId, orgId),
  });
  // The award universe IS the wanted set: nothing outside it could resolve.
  const wanted = new Set<string>();
  for (const tool of tools) {
    for (const competencyId of awardsOf(tool, options)) wanted.add(competencyId);
  }
  return resolveAmongTools(reader, orgId, tools, wanted, options);
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

/*
  THE PER-ROLE DUAL READ IS GONE (U3/KTD4, review-verified). `requiredToolIdsByRole`
  was superseded by the membership-shaped read below the moment assignment
  dropped its zero-roles early return: a role's tool list answers nobody's
  obligation on its own, because location, department and org requirements are
  placement-shaped (R3) and a role has no placement. It survived U3 with no
  production caller and only its own tests proving it still worked — a dual read
  that no read site uses is a second definition of resolution waiting to drift
  from the one below. Deleted rather than kept "just in case": KTD2 exists so
  preview and apply cannot name different tools, and that guarantee is weakest
  when there are two resolvers.
*/

/**
 * The required TOOLS of each given membership across its FULL scope union
 * (KTD4) — the ONE read at the assignment seam, BATCHED (U4's org-scale discipline at the KTD8 re-plan seam: a status
 * flip or transfer re-plans whole placements, and a per-membership loop of
 * transactions would issue thousands of queries). Each membership expands to
 * its scope keys (org implicit, placed Locations and Departments with retired
 * values dropped, held non-withdrawn Roles — the U4 split lives in the
 * expansion, not here), the requirement rows union across them, and each
 * required competency resolves to its ONE awarding tool by the KTD2 rule. The
 * legacy `role_required_assessments` derivation rides along for the
 * memberships' roles — legacy rows never existed at the other scopes, so the
 * dual read stays role-shaped inside a scope-shaped union.
 *
 * The batch reads are set-wise over the UNION of every membership's keys —
 * one query per table however many memberships are asked about — and each
 * membership's tool set is then assembled from its OWN keys, so one member's
 * placement never obliges another. Every requested membershipId maps to a
 * FLAT deduplicated tool list (possibly empty) rather than a per-scope map:
 * the consumer is the assignment engine, which has always flattened before
 * deciding (KTD4 — `decideAssignments` unions the arrays), and a case records
 * no scope anyway. Recommended-tier links never appear here: they are the
 * never-enforced tier (R13) and must not reach the assignment engine.
 * A competency with no awarding tool is evidence-only (R7): required standing
 * tracks it, but there is no assessment to assign for it.
 */
export async function requiredToolIdsByMembership(
  database: Database | Reader,
  orgId: string,
  membershipIds: readonly string[],
): Promise<Map<string, string[]>> {
  const uniqueMembershipIds = [...new Set(membershipIds)];
  const byMembership = new Map<string, string[]>();
  for (const id of uniqueMembershipIds) byMembership.set(id, []);
  if (uniqueMembershipIds.length === 0) return byMembership;

  const run = async (reader: Reader): Promise<Map<string, string[]>> => {
    const keysByMembership = await scopeKeysForMemberships(reader, orgId, uniqueMembershipIds);
    const allKeys = unionKeys(keysByMembership);

    // Legacy half — ROLE scope only (KTD2); skipped entirely when no
    // membership holds a role, whose whole obligation is then direct links.
    const legacyRows = allKeys.roleIds.length
      ? await reader.query.roleRequiredAssessments.findMany({
          where: and(
            eq(schema.roleRequiredAssessments.orgId, orgId),
            inArray(schema.roleRequiredAssessments.roleId, allKeys.roleIds),
          ),
        })
      : [];
    const legacyToolIdsByRole = new Map<string, string[]>();
    for (const row of legacyRows) {
      const list = legacyToolIdsByRole.get(row.roleId) ?? [];
      list.push(row.toolId);
      legacyToolIdsByRole.set(row.roleId, list);
    }

    // Direct half — the shared four-scope read (one definition, standing.ts),
    // flattened here because only membership-level obligation matters to a plan.
    const competencyIdsFor = (keys: MembershipScopeKeys, index: ScopeRequirementIndex) => [
      ...new Set([
        ...keys.roleIds.flatMap((roleId) => index.byRole.get(roleId) ?? []),
        ...keys.locationIds.flatMap((locationId) => index.byLocation.get(locationId) ?? []),
        ...keys.departmentIds.flatMap((departmentId) => index.byDepartment.get(departmentId) ?? []),
        ...index.orgCompetencyIds,
      ]),
    ];
    const index = await requirementIndexForScopes(reader, orgId, allKeys, 'required');
    const awarding = await awardingToolByCompetency(reader, orgId, competencyIdsFor(allKeys, index));

    for (const membershipId of uniqueMembershipIds) {
      const keys: MembershipScopeKeys = keysByMembership.get(membershipId) ?? {
        locationIds: [],
        departmentIds: [],
        roleIds: [],
      };
      // A Set: a tool the legacy row names AND a link resolves to — or that two
      // scopes both require through their links — must not become two cases.
      const toolIds = new Set<string>(
        keys.roleIds.flatMap((roleId) => legacyToolIdsByRole.get(roleId) ?? []),
      );
      for (const competencyId of competencyIdsFor(keys, index)) {
        const toolId = awarding.get(competencyId);
        if (toolId) toolIds.add(toolId); // absent → evidence-only (R7)
      }
      byMembership.set(membershipId, [...toolIds]);
    }
    return byMembership;
  };

  /*
    ONE SNAPSHOT FOR THE WHOLE EXPANSION (KTD3) — see `runSnapshotted` above;
    since U2 the snapshot covers the PLACEMENT tables too: a location transfer
    or an award conversion committing between the scope-key read and the
    requirement read would otherwise plan against half a world.
  */
  return runSnapshotted(database, run);
}

/** The required tools of ONE membership — the single-membership shape of the batch. */
export async function requiredToolIdsForMembership(
  database: Database | Reader,
  orgId: string,
  membershipId: string,
): Promise<string[]> {
  const byMembership = await requiredToolIdsByMembership(database, orgId, [membershipId]);
  return byMembership.get(membershipId) ?? [];
}
