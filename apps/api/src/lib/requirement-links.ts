/**
 * The SHARED resolver that inverts the requirement derivation (KTD2).
 *
 * Roles now store requirements as competencies (`role_required_competencies`),
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
import { db } from '../db.js';

type Database = NonNullable<typeof db>;
/** The root client OR an open transaction — the reads run on either surface. */
type Reader = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

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
): Promise<Map<string, string>> {
  const byCompetency = new Map<string, string>();
  const wanted = new Set(competencyIds);
  if (wanted.size === 0) return byCompetency;

  const tools = await reader.query.assessmentTools.findMany({
    where: eq(schema.assessmentTools.orgId, orgId),
  });
  const candidates = tools.filter((t) =>
    (t.awardedCompetencyIds ?? []).some((c) => wanted.has(c)),
  );
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
    for (const competencyId of tool.awardedCompetencyIds ?? []) {
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
): Promise<string | null> {
  const byCompetency = await awardingToolByCompetency(reader, orgId, [competencyId]);
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
    const linkRows = await reader.query.roleRequiredCompetencies.findMany({
      where: and(
        eq(schema.roleRequiredCompetencies.orgId, orgId),
        inArray(schema.roleRequiredCompetencies.roleId, uniqueRoleIds),
        eq(schema.roleRequiredCompetencies.tier, 'required'),
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
  */
  const transactional = database as Database;
  if (typeof transactional.transaction === 'function') {
    return transactional.transaction((tx) => run(tx));
  }
  return run(database as Reader);
}
