/**
 * Loading around the pure standing resolver (U16).
 *
 * `packages/shared/src/standing.ts` decides required-vs-optional from a person's
 * held Roles and what those Roles require; this reads that context from the
 * database. Nothing is stored — standing is recomputed on every read (KTD6), so
 * this is pure loading with no writes.
 *
 * Batched by user because the two surfaces that show standing ask it differently:
 * a person's own record asks for one user, the holder register asks for the many
 * people who hold one competency. One query path serves both.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requiredCompetencyIds } from '@formai/shared';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;

/**
 * The set of competency ids each given user is OBLIGED to hold — everything
 * awarded by a tool their currently-held Roles require. Withdrawn Roles are
 * filtered here (R52, R90), so a withdrawn Role's requirement never reaches the
 * resolver. A user with no membership, no held Role or no requirement maps to an
 * empty set rather than being absent, so a caller can look every user up.
 */
export async function requiredCompetencyIdsByUser(
  database: Database,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const uniqueUserIds = [...new Set(userIds)];
  const byUser = new Map<string, Set<string>>();
  for (const userId of uniqueUserIds) byUser.set(userId, new Set());
  if (uniqueUserIds.length === 0) return byUser;

  const memberships = await database.query.memberships.findMany({
    where: and(
      eq(schema.memberships.orgId, orgId),
      inArray(schema.memberships.userId, uniqueUserIds),
    ),
  });
  if (memberships.length === 0) return byUser;
  const userIdByMembership = new Map(memberships.map((m) => [m.id, m.userId]));

  // Held Roles only — a withdrawn Role confers no requirement (R52).
  const roleRows = await database.query.membershipRoles.findMany({
    where: and(
      inArray(
        schema.membershipRoles.membershipId,
        memberships.map((m) => m.id),
      ),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  if (roleRows.length === 0) return byUser;
  const roleIds = [...new Set(roleRows.map((r) => r.roleId))];

  const reqRows = await database.query.roleRequiredAssessments.findMany({
    where: and(
      eq(schema.roleRequiredAssessments.orgId, orgId),
      inArray(schema.roleRequiredAssessments.roleId, roleIds),
    ),
  });
  if (reqRows.length === 0) return byUser;
  const toolIdsByRole = new Map<string, string[]>();
  for (const r of reqRows) {
    const list = toolIdsByRole.get(r.roleId) ?? [];
    list.push(r.toolId);
    toolIdsByRole.set(r.roleId, list);
  }

  const toolIds = [...new Set(reqRows.map((r) => r.toolId))];
  const toolRows = toolIds.length
    ? await database.query.assessmentTools.findMany({
        where: and(
          eq(schema.assessmentTools.orgId, orgId),
          inArray(schema.assessmentTools.id, toolIds),
        ),
      })
    : [];
  const awardsByTool: Record<string, readonly string[]> = {};
  for (const t of toolRows) awardsByTool[t.id] = t.awardedCompetencyIds ?? [];

  // Roles held per membership, then the union of their required tools' awards.
  const roleIdsByMembership = new Map<string, string[]>();
  for (const row of roleRows) {
    const list = roleIdsByMembership.get(row.membershipId) ?? [];
    list.push(row.roleId);
    roleIdsByMembership.set(row.membershipId, list);
  }

  for (const membership of memberships) {
    const userId = userIdByMembership.get(membership.id)!;
    const held = roleIdsByMembership.get(membership.id) ?? [];
    const requiredToolIds = [...new Set(held.flatMap((roleId) => toolIdsByRole.get(roleId) ?? []))];
    byUser.set(userId, requiredCompetencyIds(requiredToolIds, awardsByTool));
  }

  return byUser;
}

/** The required-competency set for one user — the single-user shape of the batch. */
export async function requiredCompetencyIdsFor(
  database: Database,
  orgId: string,
  userId: string,
): Promise<Set<string>> {
  const byUser = await requiredCompetencyIdsByUser(database, orgId, [userId]);
  return byUser.get(userId) ?? new Set();
}
