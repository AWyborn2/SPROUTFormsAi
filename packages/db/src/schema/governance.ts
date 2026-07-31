import { relations } from 'drizzle-orm';
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
import type { PermissionMatrix } from '@formai/shared';
import { auditCategoryEnum, roleEnum } from './enums.ts';
import { organizations, users } from './organizations.ts';
import { formTemplates } from './forms.ts';
import { submissions } from './submissions.ts';
// One-way: assessments.ts imports nothing from here, so this is not a cycle.
import { assessmentCases } from './assessments.ts';

/** Competencies held by workers (Should-tier gating). */
export const competencies = pgTable(
  'competencies',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    code: text().notNull(),
    holders: integer().notNull().default(0),
    /*
      HOW LONG THIS QUALIFICATION LASTS, in months from the grant date. NULL
      means it never expires — which is every competency until an admin sets
      one, and is deliberately the migration story: nothing lapses the day this
      ships, and a qualification starts expiring the moment it is given a
      validity.

      Set here rather than per grant because it is a property of the
      qualification: "ATO - Track Dozer is valid for three years" is true of the
      ticket, not of one person's copy of it. Expiry is DERIVED from this, so
      setting it applies at once to every existing grant, however old.
    */
    validForMonths: integer('valid_for_months'),
    /*
      Days past expiry during which it still counts, flagged. Per competency and
      admin-set rather than a global constant, because different qualifications
      allow different runway to requalify. NULL or 0 makes expiry a hard date.
    */
    gracePeriodDays: integer('grace_period_days'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('competencies_org_idx').on(t.orgId)],
);

/**
 * Who holds which competency.
 *
 * `competencies.holders` is a denormalised COUNT and always was — it can say
 * "12 people hold this" but not WHICH twelve, so no prerequisite or
 * assessor-eligibility question was answerable before this table. The count
 * column is kept because existing displays read it; it is maintained alongside
 * these rows rather than replaced, so the two never disagree.
 *
 * `evidenceRef` is a free-text pointer at the external record (a certificate
 * number, an LMS record id) for orgs recording competencies by hand. It is
 * display and audit only — nothing resolves it, and until an LMS sync exists it
 * is the only trace of where a grant came from.
 */
export const competencyHolders = pgTable(
  'competency_holders',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    competencyId: uuid()
      .notNull()
      .references(() => competencies.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    evidenceRef: text('evidence_ref'),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /*
      The assessment case that earned this, when the product itself granted it.
      `evidenceRef` above is documented as display-only — a string nothing
      resolves — and "linked to the case as evidence" has to be FOLLOWABLE or it
      is not a link. Null on a hand-recorded grant, which is the existing case.

      `set null` because deleting a case must neither strip someone's competency
      nor be blocked by one.
    */
    sourceCaseId: uuid('source_case_id').references(() => assessmentCases.id, {
      onDelete: 'set null',
    }),
    /*
      Revocation without erasure. An overturned appeal has to be able to strip a
      grant while leaving the fact it was once held on the record — the same
      conclusion this file already reached for API keys, for the same reason:
      something that WAS true needs to stay visible to the audit conversation
      about it. A hard delete would leave the register silently disagreeing with
      the audit log.

      Every eligibility read must filter `revokedAt IS NULL`, or a revoked grant
      goes on counting as a prerequisite.
    */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    /*
      WHEN IT WAS LAST GRANTED — the date expiry counts from.

      Distinct from `createdAt` because granting is an UPSERT: requalifying
      updates the existing row rather than inserting a second one, and
      `createdAt` therefore records when the person FIRST earned the ticket and
      never moves again. Deriving expiry from that would mean a three-year
      ticket earned in 2022 and re-earned last week still reads as expired.

      Defaults to now so existing rows get a sane date, which is also what makes
      "backfill from the grant date" work: those rows already carry a creation
      time, and this column adopts it.
    */
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
    /*
      An explicit end date that OVERRIDES the derived one. Null normally, so
      expiry follows the qualification's validity period.

      Exists for a date that does not fit the formula: a ticket issued with a
      short validity, one extended by hand, or one imported from the training
      system with its own recorded expiry. Without it, a BIS sync would have to
      either lie about the grant date or lose the real expiry.
    */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /** A person holds a competency once; granting twice is idempotent. */
    uniqueIndex('competency_holders_competency_user_uq').on(t.competencyId, t.userId),
    index('competency_holders_user_idx').on(t.userId),
    index('competency_holders_org_idx').on(t.orgId),
  ],
);

/** Which competency unlocks which form section. */
export const competencyRules = pgTable(
  'competency_rules',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    templateId: uuid()
      .notNull()
      .references(() => formTemplates.id, { onDelete: 'cascade' }),
    sectionRef: text().notNull(),
    competencyId: uuid()
      .notNull()
      .references(() => competencies.id, { onDelete: 'cascade' }),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('competency_rules_org_idx').on(t.orgId)],
);

/** Per-org, per-role capability matrix. Seeded from the prototype defaults. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: roleEnum().notNull(),
    matrix: jsonb().$type<PermissionMatrix>().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('role_permissions_org_role_uq').on(t.orgId, t.role)],
);

/** Who did what, when, on which entity. Append-only. */
export const auditLogEntries = pgTable(
  'audit_log_entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    actorName: text().notNull().default('System'),
    action: text().notNull(),
    target: text().notNull().default(''),
    category: auditCategoryEnum().notNull().default('general'),
    icon: text().notNull().default('activity'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('audit_org_idx').on(t.orgId),
    index('audit_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

/**
 * A machine credential: an org-scoped key an agent presents instead of a
 * session cookie.
 *
 * Only the SHA-256 `hash` of the full key is stored, so a database dump does
 * not yield working credentials and the plaintext exists exactly once, in the
 * create response. `prefix` is the displayable leading segment AND the lookup
 * handle — uniquely indexed so verification is one indexed read followed by a
 * constant-time hash comparison, rather than a scan that hashes every row.
 *
 * `role` reuses the membership role enum, so a key's authority is described in
 * exactly the same vocabulary as a person's and resolves through the same
 * permission matrix. Revocation is a timestamp rather than a delete: a key that
 * did something needs to remain visible to the audit conversation about it.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Human label, e.g. "Induction booking agent". */
    name: text().notNull(),
    role: roleEnum().notNull().default('reviewer'),
    prefix: text().notNull(),
    hash: text().notNull(),
    /**
     * The administrator who issued it. Machine calls act as this user, because
     * `TenantContext.userId` is non-nullable and audit rows must name a real
     * actor — an agent's action is attributable to whoever authorised it.
     */
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('api_keys_prefix_uq').on(t.prefix), index('api_keys_org_idx').on(t.orgId)],
);

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  org: one(organizations, {
    fields: [apiKeys.orgId],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [apiKeys.createdByUserId],
    references: [users.id],
  }),
}));

/**
 * A booked induction: one date, N seats, the starters it covers.
 *
 * Deliberately its own record rather than a submission status. A status string
 * cannot hold a seat count, an external reference, or the many-starters-to-one
 * -booking shape the site actually books in — and conflating "this intake was
 * approved" with "this cohort was booked" would leave neither answerable.
 *
 * `inductionDate` is text in the same ISO form the intake answer uses, so the
 * two compare without a conversion in between.
 */
export const inductionBookings = pgTable(
  'induction_bookings',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** ISO `YYYY-MM-DD`, matching the intake answer it was booked from. */
    inductionDate: text('induction_date').notNull(),
    /** Seats taken. Derived from the starters, stored so the booking reads on its own. */
    seats: integer().notNull(),
    /** The external system's handle, e.g. a BISTrainer transaction reference. */
    externalReference: text('external_reference').notNull().default(''),
    note: text().notNull().default(''),
    /**
     * Why the four-business-day notice rule was waived, when it was.
     *
     * Empty on an ordinary booking. Non-empty is the trace of a deliberate
     * exception: the API refuses to record a short-notice booking without one,
     * so an auditor asking "who agreed to this, and why" finds the answer
     * stored beside the booking rather than in somebody's inbox.
     */
    noticeOverrideReason: text('notice_override_reason').notNull().default(''),
    /** The acting user. For a machine call this is the API key's issuer. */
    bookedByUserId: uuid('booked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set when an agent booked it, so machine and human bookings stay distinguishable. */
    bookedByApiKeyId: uuid('booked_by_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('induction_bookings_org_idx').on(t.orgId),
    index('induction_bookings_org_date_idx').on(t.orgId, t.inductionDate),
  ],
);

/**
 * One starter's seat in a booking.
 *
 * `starterName` is captured at booking time on purpose: the submission it came
 * from stays editable, and the record of who was actually booked must not
 * change underneath the booking. The unique index is what makes a retried tool
 * call idempotent rather than double-booking a seat.
 */
export const inductionBookingStarters = pgTable(
  'induction_booking_starters',
  {
    id: uuid().primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => inductionBookings.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'restrict' }),
    starterName: text('starter_name').notNull(),
  },
  (t) => [
    uniqueIndex('induction_booking_starters_uq').on(t.bookingId, t.submissionId),
    index('induction_booking_starters_submission_idx').on(t.submissionId),
  ],
);

export const inductionBookingsRelations = relations(inductionBookings, ({ one, many }) => ({
  org: one(organizations, {
    fields: [inductionBookings.orgId],
    references: [organizations.id],
  }),
  starters: many(inductionBookingStarters),
}));

export const inductionBookingStartersRelations = relations(inductionBookingStarters, ({ one }) => ({
  booking: one(inductionBookings, {
    fields: [inductionBookingStarters.bookingId],
    references: [inductionBookings.id],
  }),
  submission: one(submissions, {
    fields: [inductionBookingStarters.submissionId],
    references: [submissions.id],
  }),
}));

export const competenciesRelations = relations(competencies, ({ one, many }) => ({
  org: one(organizations, {
    fields: [competencies.orgId],
    references: [organizations.id],
  }),
  rules: many(competencyRules),
  holders: many(competencyHolders),
}));

export const competencyHoldersRelations = relations(competencyHolders, ({ one }) => ({
  org: one(organizations, {
    fields: [competencyHolders.orgId],
    references: [organizations.id],
  }),
  competency: one(competencies, {
    fields: [competencyHolders.competencyId],
    references: [competencies.id],
  }),
  user: one(users, {
    fields: [competencyHolders.userId],
    references: [users.id],
  }),
}));

export const competencyRulesRelations = relations(competencyRules, ({ one }) => ({
  org: one(organizations, {
    fields: [competencyRules.orgId],
    references: [organizations.id],
  }),
  template: one(formTemplates, {
    fields: [competencyRules.templateId],
    references: [formTemplates.id],
  }),
  competency: one(competencies, {
    fields: [competencyRules.competencyId],
    references: [competencies.id],
  }),
}));
