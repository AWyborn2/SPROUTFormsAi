import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import { DEACTIVATED_STATUS } from '../middleware/tenant.js';

/**
 * API keys still live whose issuing Admin has been deactivated (R65).
 *
 * THE KEY IS THE ORGANISATION'S, NOT THE PERSON'S. It is scoped to the org,
 * carries its OWN role rather than the issuer's, and any Admin holding
 * `team.manage` can revoke it. `created_by_user_id` records who authorised it so
 * an agent's writes name a real actor — it is an attribution device, not an
 * authorisation source.
 *
 * So a leaver does not walk out with THEIR credential. They walk out holding a
 * copy of the ORGANISATION's, and the product's failure was never telling
 * anybody. Revoking automatically would turn an HR event into an unannounced
 * outage of whatever integration that key drives; the remedy for a leaked
 * organisational credential is rotation, and rotation is an Admin's decision.
 *
 * This is the read behind all three notices — the working list, the badge on the
 * keys screen, and the count recorded when somebody is deactivated — so none of
 * them can drift from the others about which keys are affected.
 */

export interface OrphanedKey {
  id: string;
  name: string;
  /** The key's own role, which is what it actually authenticates as. */
  role: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  issuerUserId: string;
  issuerName: string;
}

/**
 * Every unrevoked key in the organisation whose issuer holds a deactivated
 * membership of it.
 *
 * A key whose issuer holds no membership at all is NOT included: they were never
 * deactivated here, so there is nothing for an Admin to act on and listing it
 * would be noise on a surface that empties by being acted upon.
 */
export async function orphanedApiKeys(db: Db, orgId: string): Promise<OrphanedKey[]> {
  const keys = await db.query.apiKeys.findMany({
    where: and(eq(schema.apiKeys.orgId, orgId), isNull(schema.apiKeys.revokedAt)),
  });
  const issuerIds = [...new Set(keys.map((k) => k.createdByUserId).filter((id): id is string => Boolean(id)))];
  if (issuerIds.length === 0) return [];

  const memberships = await db.query.memberships.findMany({
    where: and(eq(schema.memberships.orgId, orgId), inArray(schema.memberships.userId, issuerIds)),
  });
  const deactivated = new Set(
    memberships.filter((m) => m.status === DEACTIVATED_STATUS).map((m) => m.userId),
  );
  if (deactivated.size === 0) return [];

  const users = await db.query.users.findMany({ where: inArray(schema.users.id, [...deactivated]) });
  const nameFor = new Map(users.map((u) => [u.id, u.name]));

  return keys
    .filter((k) => k.createdByUserId && deactivated.has(k.createdByUserId))
    .map((k) => ({
      id: k.id,
      name: k.name,
      role: k.role,
      prefix: k.prefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      issuerUserId: k.createdByUserId!,
      issuerName: nameFor.get(k.createdByUserId!) ?? 'a former member',
    }));
}

/**
 * Whether ONE user's deactivation leaves keys live, for the entry
 * `deactivateMember` records.
 *
 * Counted rather than listed, because the audit entry is a fact about the
 * decision — "this many doors were left open, knowingly" — and the working list
 * is where an Admin goes to see which.
 */
export async function liveKeysIssuedBy(db: Db, orgId: string, userId: string): Promise<number> {
  /*
    FAIL SOFT. This count exists to raise a notice, and a notice that cannot be
    computed must not roll back the deactivation it was observing — ending
    somebody's reach is the security act, and reporting on it is the courtesy.
    Zero reads as "nothing to tell an Admin about", which is also what an
    organisation with no keys looks like.
  */
  try {
    const keys = await db.query.apiKeys.findMany({
      where: and(
        eq(schema.apiKeys.orgId, orgId),
        eq(schema.apiKeys.createdByUserId, userId),
        isNull(schema.apiKeys.revokedAt),
      ),
    });
    return keys.length;
  } catch {
    return 0;
  }
}
