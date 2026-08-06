import { eq } from 'drizzle-orm';
import { DEFAULT_ROLE_PERMISSIONS, PLAN_CONFIG, schema, type Db } from '@formai/db';
import type { Role, TenantContext } from '@formai/shared';
import { isUniqueViolation } from '../lib/db-errors.js';
import { insertUserWithUsername } from '../lib/username.js';
import { DEACTIVATED_STATUS } from '../middleware/tenant.js';

/**
 * Raised when every membership a person holds has been deactivated (R64).
 *
 * A distinct error rather than a null return, so a caller cannot mistake "this
 * person has no usable membership" for "this person does not exist" and quietly
 * provision them a brand-new organisation — which is what the first-sign-in
 * branch below would otherwise do for a leaver.
 */
export class DeactivatedMemberError extends Error {
  constructor() {
    super('every membership for this person has been deactivated');
    this.name = 'DeactivatedMemberError';
  }
}
import type { UserProfile } from './replit-auth.js';

async function findOrCreateUser(
  db: Db,
  profile: UserProfile,
): Promise<typeof schema.users.$inferSelect> {
  const existing = await db.query.users.findFirst({
    where: eq(schema.users.email, profile.email),
  });
  if (existing) return existing;

  try {
    /*
      One of the three places a person is born, so one of the three that issues
      a username (R21, KTD21). Wiring only the backfill would leave everybody
      arriving after this shipped unable to sign in by one.
    */
    const created = await insertUserWithUsername(db, { name: profile.name, email: profile.email });
    if (!created) throw new Error('tenant_provisioning_failed: user insert returned no row');
    return created;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const raced = await db.query.users.findFirst({
        where: eq(schema.users.email, profile.email),
      });
      if (raced) return raced;
    }
    throw err;
  }
}

async function findOrCreateOrg(
  db: Db,
  profile: UserProfile,
): Promise<typeof schema.organizations.$inferSelect> {
  const accountKind = profile.accountKind ?? 'team';
  const isIndividual = accountKind === 'individual';

  const orgName = isIndividual
    ? `${profile.name}'s workspace`
    : (profile.orgName ?? `${profile.name}'s organization`);

  const planTier = isIndividual ? 'individual' : 'team';
  const planConfig = PLAN_CONFIG[planTier];

  const [created] = await db
    .insert(schema.organizations)
    .values({
      name: orgName,
      planTier,
      seatLimit: planConfig.seatLimit,
      candidateSeatLimit: planConfig.candidateSeatLimit,
      accountKind,
      // Solo workspaces skip the team onboarding wizard entirely.
      ...(isIndividual ? { onboardingCompletedAt: new Date() } : {}),
    })
    .returning();
  if (!created) throw new Error('tenant_provisioning_failed: organization insert returned no row');
  return created;
}

/**
 * Upserts the org/membership/role-permissions rows for a user profile.
 * On first sign-in the user gets their own org (owner role).
 * Returning users reuse their existing membership.
 */
export async function provisionTenant(db: Db, profile: UserProfile): Promise<TenantContext> {
  const user = await findOrCreateUser(db, profile);

  const memberships = await db.query.memberships.findMany({
    where: eq(schema.memberships.userId, user.id),
  });

  /*
    RESOLVE AN ACTIVE MEMBERSHIP, not simply the first one found (R64).

    Deactivation retains the membership rather than deleting it (R62), so the
    row a leaver held is exactly the row this returned — handing them a fresh
    seven-day session at their old access level and defeating both R64 and the
    revalidation `requireTenant` now performs. Shutting the door on live
    sessions while leaving the front door open would be no closure at all.

    A person deactivated in one organisation but active in another still signs
    in, reaching the one they are still a member of: the deactivation is a fact
    about one membership, not about the person.
  */
  const usable = memberships.filter((m) => m.status !== DEACTIVATED_STATUS);
  if (usable.length > 0) {
    const membership = usable[0]!;
    return { userId: user.id, orgId: membership.orgId, role: membership.role };
  }
  if (memberships.length > 0) {
    // Every membership they hold has been deactivated: there is no tenant to
    // resolve, and the login route turns this into a refusal.
    throw new DeactivatedMemberError();
  }

  const org = await findOrCreateOrg(db, profile);

  await db.insert(schema.memberships).values({
    userId: user.id,
    orgId: org.id,
    role: 'owner',
    status: 'active',
  });

  await db.insert(schema.rolePermissions).values(
    (Object.keys(DEFAULT_ROLE_PERMISSIONS) as Role[]).map((role) => ({
      orgId: org.id,
      role,
      matrix: DEFAULT_ROLE_PERMISSIONS[role],
    })),
  );

  return { userId: user.id, orgId: org.id, role: 'owner' };
}
