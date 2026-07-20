import { relations, sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { BrandingKit } from '@formai/shared';
import { membershipStatusEnum, roleEnum } from './enums.ts';

/**
 * DB-level default for the branding column. Mirrors `DEFAULT_BRANDING` in
 * @formai/shared; inlined here so the schema stays self-contained for
 * drizzle-kit's bundler (the app always writes explicit values).
 */
const DEFAULT_BRANDING: BrandingKit = {
  logoAssetUrl: null,
  primaryColor: '#253439',
  secondaryColor: '#7c898b',
  accentColor: '#6ec792',
  formFont: 'Inter',
};

/** The tenant. Owns forms, members, billing, and its branding kit. */
export const organizations = pgTable('organizations', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  plan: text().notNull().default('Business'),
  branding: jsonb().$type<BrandingKit>().notNull().default(DEFAULT_BRANDING),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  /** Plan tier: 'individual' | 'team' | 'business' | 'enterprise'. Controls feature access and seat limits. */
  planTier: text('plan_tier').notNull().default('business'),
  /** Maximum active memberships allowed by the current plan. */
  seatLimit: integer('seat_limit').notNull().default(15),
  /** Whether this is a solo workspace ('individual') or a shared team ('team'). */
  accountKind: text('account_kind').notNull().default('team'),
});

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').unique(),
  name: text().notNull(),
  email: text().notNull().unique(),
  passwordHash: text('password_hash'),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

/**
 * A pending invitation. Deliberately NOT a `users` row plus an `invited`
 * membership: the membership is created only when the invite is accepted, and
 * it binds to whoever presents `token` while authenticated — never to an
 * identity resolved from `email`.
 */
export const invites = pgTable(
  'invites',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Where the invite link was sent. Delivery only — never an identity claim. */
    email: text().notNull(),
    role: roleEnum().notNull().default('viewer'),
    /** Unguessable; the sole authorization for accepting. */
    token: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }),
    acceptedAt: timestamp({ withTimezone: true }),
    acceptedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('invites_token_uq').on(t.token),
    /** At most one pending invite per email per org — the 409 the dialog reports. */
    uniqueIndex('invites_org_email_pending_uq')
      .on(t.orgId, t.email)
      .where(sql`${t.acceptedAt} IS NULL`),
    index('invites_org_idx').on(t.orgId),
  ],
);

/** A user's role within one org. Composite tenant + role. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: roleEnum().notNull().default('viewer'),
    status: membershipStatusEnum().notNull().default('invited'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('memberships_user_org_uq').on(t.userId, t.orgId),
    index('memberships_org_idx').on(t.orgId),
  ],
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  invites: many(invites),
}));

export const invitesRelations = relations(invites, ({ one }) => ({
  org: one(organizations, { fields: [invites.orgId], references: [organizations.id] }),
  acceptedBy: one(users, { fields: [invites.acceptedByUserId], references: [users.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  org: one(organizations, {
    fields: [memberships.orgId],
    references: [organizations.id],
  }),
}));
