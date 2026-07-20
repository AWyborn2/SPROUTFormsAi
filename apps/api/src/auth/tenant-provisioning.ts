import { eq } from 'drizzle-orm';
import { DEFAULT_ROLE_PERMISSIONS, PLAN_CONFIG, schema, type Db } from '@formai/db';
import type { Role, TenantContext } from '@formai/shared';
import { isUniqueViolation } from '../lib/db-errors.js';
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
    const [created] = await db
      .insert(schema.users)
      .values({ name: profile.name, email: profile.email })
      .returning();
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

  if (memberships.length > 0) {
    const membership = memberships[0]!;
    return { userId: user.id, orgId: membership.orgId, role: membership.role };
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
