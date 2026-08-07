import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import { displayIdentityOf, type DisplayIdentity, type DisplayIdentifierChoice } from '@formai/shared';

/**
 * How members are identified on screen (R7, R24) — resolved LIVE, never captured.
 *
 * One place owns the read so every surface that names a person agrees: the team
 * list, an assessment case, a signed attempt. R61 is the reason it is a read
 * rather than a stored copy — unlike the printed name, which a signed attempt
 * keeps as it was signed (R60), a corrected employee number must correct itself
 * everywhere it appears. Nothing here writes an identifier onto a case or an
 * attempt, and no such column exists for it to write to.
 *
 * Keyed by USER id because that is what every caller holds — a case names a
 * candidate by user id, the team list joins memberships to users. The profile
 * itself hangs off the membership (R1), so the join runs through it and is
 * naturally scoped to this organisation: the same person working for two
 * customers resolves to a different identity in each.
 */

export type { DisplayIdentity };

/** The org setting plus the profile fields the resolution reads. Nothing else. */
export interface DisplayIdentityLookup {
  /** user id → identity, absent where the person holds no profile in this org yet. */
  byUserId: Map<string, DisplayIdentity>;
  /** Which number the organisation shows, for a caller resolving one more person. */
  choice: DisplayIdentifierChoice;
}

/**
 * Resolve display identities for `userIds` within one organisation.
 *
 * Returns an empty lookup rather than throwing when nobody has a profile yet,
 * which is the ordinary state until the workforce is imported or entered — a
 * surface that names people must keep working through that, falling back to the
 * name it already had.
 */
export async function loadDisplayIdentities(
  db: Db,
  orgId: string,
  userIds: readonly string[],
): Promise<DisplayIdentityLookup> {
  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, orgId),
  });
  const choice: DisplayIdentifierChoice = org?.displayIdentifier ?? 'employee_number';

  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return { byUserId: new Map(), choice };

  const memberships = await db.query.memberships.findMany({
    where: and(eq(schema.memberships.orgId, orgId), inArray(schema.memberships.userId, unique)),
  });
  if (memberships.length === 0) return { byUserId: new Map(), choice };

  const userIdByMembership = new Map(memberships.map((m) => [m.id, m.userId]));
  const profiles = await db.query.memberProfiles.findMany({
    where: inArray(
      schema.memberProfiles.membershipId,
      memberships.map((m) => m.id),
    ),
  });

  const byUserId = new Map<string, DisplayIdentity>();
  for (const profile of profiles) {
    const userId = userIdByMembership.get(profile.membershipId);
    if (!userId) continue;
    byUserId.set(userId, displayIdentityOf(profile, choice));
  }
  return { byUserId, choice };
}

/**
 * The name to print for one person, and the identifier beside it.
 *
 * `fallbackName` is what the surface already had — `users.name` — and is used
 * where no profile exists yet. Where one does, the profile's derived display
 * name wins: it is the one built from the first and last names an Admin can
 * correct per organisation (R3), while `users.name` is a single product-wide
 * string no organisation owns.
 */
export function identifyMember(
  lookup: DisplayIdentityLookup,
  userId: string | null | undefined,
  fallbackName: string,
): { name: string; identifier: string | null } {
  const identity = userId ? lookup.byUserId.get(userId) : undefined;
  if (!identity) return { name: fallbackName, identifier: null };
  return { name: identity.displayName || fallbackName, identifier: identity.identifier };
}
