/**
 * Loading around the pure standing resolver (U16, extended for the
 * role-competency links round).
 *
 * `packages/shared/src/standing.ts` decides required-vs-recommended-vs-optional
 * from a person's held Roles and what those Roles require; this reads that
 * context from the database. Nothing is stored — standing is recomputed on
 * every read (KTD6), so this is pure loading with no writes.
 *
 * REQUIRED standing is a DUAL READ during the transition (KTD3): the union of
 * (a) the legacy derivation — Role → required tools → each tool's awarded
 * competencies — and (b) direct `competency_requirements` rows with tier
 * 'required'. Conversion moves a requirement from (a) to (b) one tool at a
 * time, and the union keeps it visible whichever side it currently lives on.
 *
 * Batched by user because the two surfaces that show standing ask it
 * differently: a person's own record asks for one user, the holder register
 * asks for the many people who hold one competency. One query path serves both.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requiredCompetencyIds } from '@formai/shared';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;
/** The root client OR an open transaction — the reads run on either surface. */
export type Reader = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The Roles each requested user currently HOLDS, resolved membership-first.
 * Withdrawn Roles are filtered here (R52, R90), so a withdrawn Role's
 * requirement — from EITHER source — never reaches a resolver. Returns null
 * when nobody holds anything, which every caller maps to all-empty sets.
 */
async function heldRolesByUser(reader: Reader, orgId: string, uniqueUserIds: readonly string[]) {
  const membershipRows = await reader.query.memberships.findMany({
    where: and(
      eq(schema.memberships.orgId, orgId),
      inArray(schema.memberships.userId, [...uniqueUserIds]),
    ),
  });
  if (membershipRows.length === 0) return null;

  // Held Roles only — a withdrawn Role confers no requirement (R52).
  const roleRows = await reader.query.membershipRoles.findMany({
    where: and(
      inArray(
        schema.membershipRoles.membershipId,
        membershipRows.map((m) => m.id),
      ),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  if (roleRows.length === 0) return null;

  const roleIdsByMembership = new Map<string, string[]>();
  for (const row of roleRows) {
    const list = roleIdsByMembership.get(row.membershipId) ?? [];
    list.push(row.roleId);
    roleIdsByMembership.set(row.membershipId, list);
  }

  return {
    memberships: membershipRows,
    roleIdsByMembership,
    roleIds: [...new Set(roleRows.map((r) => r.roleId))],
  };
}

/**
 * The set of competency ids each given user is OBLIGED to hold — everything a
 * held Role requires DIRECTLY (a `competency_requirements` row, tier
 * 'required') plus everything awarded by a tool a held Role still requires the
 * legacy way. A user with no membership, no held Role or no requirement maps to
 * an empty set rather than being absent, so a caller can look every user up.
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

  /*
    ONE SNAPSHOT FOR BOTH HALVES (KTD3). Conversion deletes a legacy
    `role_required_assessments` row and inserts the direct link in one commit;
    if these reads ran on the root client, that commit could land BETWEEN the
    legacy read and the direct read, and the requirement would be visible to
    neither — a person reading compliant for the duration of a request purely
    because an admin clicked Accept at the wrong moment. A transaction pins
    every read here to one snapshot, so a moving requirement is seen on exactly
    one side, always.

    REPEATABLE READ IS THE LOAD-BEARING HALF. Postgres defaults to READ
    COMMITTED, where every statement takes a FRESH snapshot — the transaction
    alone would be decorative here, since the conversion's commit would still
    become visible between the two reads. `repeatable read` fixes one snapshot
    for the whole block, which is the guarantee KTD3 actually asks for. Safe to
    ask for: this block only reads, so it can never raise a serialization
    failure of its own.
  */
  return database.transaction(
    async (tx) => {
      const held = await heldRolesByUser(tx, orgId, uniqueUserIds);
      if (!held) return byUser;
      const { memberships, roleIdsByMembership, roleIds } = held;

      // Legacy half: Role → required tools → each tool's awarded competencies.
      const reqRows = await tx.query.roleRequiredAssessments.findMany({
        where: and(
          eq(schema.roleRequiredAssessments.orgId, orgId),
          inArray(schema.roleRequiredAssessments.roleId, roleIds),
        ),
      });
      const toolIdsByRole = new Map<string, string[]>();
      for (const r of reqRows) {
        const list = toolIdsByRole.get(r.roleId) ?? [];
        list.push(r.toolId);
        toolIdsByRole.set(r.roleId, list);
      }
      const toolIds = [...new Set(reqRows.map((r) => r.toolId))];
      const toolRows = toolIds.length
        ? await tx.query.assessmentTools.findMany({
            where: and(
              eq(schema.assessmentTools.orgId, orgId),
              inArray(schema.assessmentTools.id, toolIds),
            ),
          })
        : [];
      const awardsByTool: Record<string, readonly string[]> = {};
      for (const t of toolRows) awardsByTool[t.id] = t.awardedCompetencyIds ?? [];

      // Direct half: tier 'required' links only. Recommended NEVER enters this
      // set — it is the never-enforced tier (R13), read by its own sibling below.
      const linkRows = await tx.query.competencyRequirements.findMany({
        where: and(
          eq(schema.competencyRequirements.orgId, orgId),
          inArray(schema.competencyRequirements.roleId, roleIds),
          eq(schema.competencyRequirements.tier, 'required'),
        ),
      });
      const directByRole = new Map<string, string[]>();
      for (const l of linkRows) {
        if (l.roleId === null) continue; // unreachable: the inArray above is role-keyed (KTD2); narrows the nullable scope column
        const list = directByRole.get(l.roleId) ?? [];
        list.push(l.competencyId);
        directByRole.set(l.roleId, list);
      }

      // Per membership: the UNION of both halves across the held Roles. A Set,
      // so a competency both halves name during transition counts once.
      for (const membership of memberships) {
        const heldRoleIds = roleIdsByMembership.get(membership.id) ?? [];
        const requiredToolIds = [
          ...new Set(heldRoleIds.flatMap((roleId) => toolIdsByRole.get(roleId) ?? [])),
        ];
        const union = requiredCompetencyIds(requiredToolIds, awardsByTool);
        for (const roleId of heldRoleIds) {
          for (const competencyId of directByRole.get(roleId) ?? []) union.add(competencyId);
        }
        byUser.set(membership.userId, union);
      }

      return byUser;
    },
    { isolationLevel: 'repeatable read' },
  );
}

/**
 * The set of competency ids each given user's held Roles RECOMMEND — direct
 * `competency_requirements` rows with tier 'recommended', nothing else.
 * There is no legacy half: the legacy world had no recommended tier, so this
 * read has a single source and needs no KTD3 transaction — nothing can move a
 * recommendation between tables mid-request. Same contract as the required
 * sibling: every requested userId is present, empty Set by default.
 */
export async function recommendedCompetencyIdsByUser(
  database: Database,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const uniqueUserIds = [...new Set(userIds)];
  const byUser = new Map<string, Set<string>>();
  for (const userId of uniqueUserIds) byUser.set(userId, new Set());
  if (uniqueUserIds.length === 0) return byUser;

  const held = await heldRolesByUser(database, orgId, uniqueUserIds);
  if (!held) return byUser;
  const { memberships, roleIdsByMembership, roleIds } = held;

  const linkRows = await database.query.competencyRequirements.findMany({
    where: and(
      eq(schema.competencyRequirements.orgId, orgId),
      inArray(schema.competencyRequirements.roleId, roleIds),
      eq(schema.competencyRequirements.tier, 'recommended'),
    ),
  });
  const byRole = new Map<string, string[]>();
  for (const l of linkRows) {
    if (l.roleId === null) continue; // unreachable: the inArray above is role-keyed (KTD2); narrows the nullable scope column
    const list = byRole.get(l.roleId) ?? [];
    list.push(l.competencyId);
    byRole.set(l.roleId, list);
  }

  for (const membership of memberships) {
    const set = new Set<string>();
    for (const roleId of roleIdsByMembership.get(membership.id) ?? []) {
      for (const competencyId of byRole.get(roleId) ?? []) set.add(competencyId);
    }
    byUser.set(membership.userId, set);
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

/** The recommended-competency set for one user — the single-user shape of the batch. */
export async function recommendedCompetencyIdsFor(
  database: Database,
  orgId: string,
  userId: string,
): Promise<Set<string>> {
  const byUser = await recommendedCompetencyIdsByUser(database, orgId, [userId]);
  return byUser.get(userId) ?? new Set();
}
