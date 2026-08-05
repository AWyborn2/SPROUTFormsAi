import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { BrandingKit } from '@formai/shared';
import { displayIdentifierEnum, membershipStatusEnum, roleEnum } from './enums.ts';

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
  /** Maximum active STAFF memberships allowed by the current plan. */
  seatLimit: integer('seat_limit').notNull().default(15),
  /**
   * Maximum active candidate memberships. Counted apart from `seatLimit`
   * because operators outnumber trainers by an order of magnitude — see
   * PlanConfig.candidateSeatLimit.
   *
   * Null means INHERIT FROM THE TIER, not unlimited — the same fallback
   * `seatLimit` uses for rows written before its column existed. Unlimited is
   * expressed by the tier config resolving to null (enterprise), so a legacy
   * enterprise row and an explicitly-unlimited one both land on unlimited.
   */
  candidateSeatLimit: integer('candidate_seat_limit'),
  /** Whether this is a solo workspace ('individual') or a shared team ('team'). */
  accountKind: text('account_kind').notNull().default('team'),
  /** Self-reported team size bucket from signup (e.g. '2-5'). Display/analytics only. */
  teamSize: text('team_size'),
  /** When the onboarding wizard was completed. Null = wizard still pending. */
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
  /**
   * Where to POST a summary when an induction intake is submitted. Empty = off.
   *
   * TREAT THE VALUE AS A SECRET. The intended target is a Power Automate HTTP
   * trigger, and that URL carries its own authorisation in the query string —
   * whoever holds it can fire the flow. So it is never returned in full by the
   * API (see `maskWebhookUrl`) and never written to a log line.
   */
  inductionWebhookUrl: text('induction_webhook_url').notNull().default(''),
  /**
   * Whether a person may be placed at several Locations, and separately in
   * several Departments (R24). Neither caps how many (R25). Both default off,
   * matching the one-Location-one-Department starting point every membership
   * carries today.
   */
  allowMultipleLocations: boolean('allow_multiple_locations').notNull().default(false),
  allowMultipleDepartments: boolean('allow_multiple_departments').notNull().default(false),
  /**
   * Which of the two workforce numbers identifies a person on screen (R40).
   * Defaults to the employee number; the swipe card number is the alternative.
   * The numbers themselves are profile fields owned by the candidate profile
   * artifact — this is only the organisation's choice between them.
   */
  displayIdentifier: displayIdentifierEnum('display_identifier').notNull().default('employee_number'),
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
    /**
     * Where the invite was sent, when it was sent anywhere.
     *
     * NULLABLE because many candidates have no work email — their invite is
     * handed over as a printed QR code instead. Delivery only; never an
     * identity claim, and the acceptor supplies their own address at signup.
     *
     * The pending-uniqueness index below still works: PostgreSQL treats NULLs
     * as distinct, so any number of QR-only invites can be outstanding while
     * emailed ones stay one-per-address.
     */
    email: text(),
    /** Who this invite is for, so a pending QR invite is identifiable. */
    inviteeName: text('invitee_name').notNull().default(''),
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

/**
 * A one-time link that lets someone set their OWN password.
 *
 * This exists so an administrator can help a candidate who is locked out
 * WITHOUT ever choosing or seeing their password. If an admin could set it,
 * they could sign in as that candidate — and since the same admins mark the
 * assessments those candidates sit, that would quietly destroy the evidentiary
 * value of every signed record. The admin issues a token; the candidate picks
 * the password.
 *
 * `orgId` is recorded so the issuing org is auditable and so a reset can only
 * be raised by an org the user actually belongs to.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Unguessable; the sole authorization for setting a new password. */
    token: text().notNull(),
    /** Who raised it, for the audit trail. Null once that admin is deleted. */
    issuedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Stamped on use, which is what makes the link single-use. */
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('password_resets_token_uq').on(t.token),
    index('password_resets_user_idx').on(t.userId),
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
