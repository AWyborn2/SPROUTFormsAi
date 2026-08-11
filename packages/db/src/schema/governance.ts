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
import type { PermissionMatrix } from '@formai/shared';
import {
  auditCategoryEnum,
  importRowOutcomeEnum,
  roleEnum,
  trainingRequestStateEnum,
} from './enums.ts';
import { organizations, users } from './organizations.ts';
import { formTemplates } from './forms.ts';
import { submissions } from './submissions.ts';
// One-way: assessments.ts imports nothing from here, so this is not a cycle.
import { assessmentCases, assessmentTools } from './assessments.ts';

/** Competencies held by workers (Should-tier gating). */
export const competencies = pgTable(
  'competencies',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /*
      THE NATIONALLY-RECOGNISED CODE, e.g. "RIIWHS204E" — and NULLABLE, which it
      was not. The requirement was modelling accredited units, where a code is
      the identifier people cross-reference against their external LMS. It does
      not fit an internal competency: a contractor endorsement form or an
      in-house equipment induction has no code and never had one, and the only
      way to satisfy a NOT NULL was to invent one — an identifier that is wrong
      quietly, permanently, and against a system that will never resolve it.

      A code stays STRONGLY preferred and is stored, shown and validated exactly
      as before wherever one exists. What is now expressible is its genuine
      absence, and NULL is how that is said — never an empty string, which would
      be a second spelling of the same fact.
    */
    code: text(),
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
      time, and this column adopts it. The default is DEAD for every path that
      actually inserts a row today — `grantCompetency` always stamps an explicit
      `new Date()` — so it exists only as a floor under a future caller that
      forgets to.

      NULLABLE (reversing R153): a migrated competency whose source system never
      recorded a grant date is real and held NOW, not "held once it is dated" —
      withholding the grant entirely until someone backfills a date it may never
      get would lose the person's actual qualification history for no reason.
      Null is written EXPLICITLY by the workforce importer for exactly this case
      (never left to the default, which would fabricate "granted today" — the one
      outcome worse than recording no date, per R153's own reasoning). Downstream,
      `competencyStatus` treats a null grant date as its own `'undated'` state
      rather than folding it into `'held'`, so it stays visibly flagged rather
      than reading as an ordinary, fully-dated grant.
    */
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow(),
    /*
      An explicit end date that OVERRIDES the derived one. Null normally, so
      expiry follows the qualification's validity period.

      Exists for a date that does not fit the formula: a ticket issued with a
      short validity, one extended by hand, or one imported from the training
      system with its own recorded expiry. Without it, a BIS sync would have to
      either lie about the grant date or lose the real expiry.
    */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /*
      WHETHER THIS GRANT ARRIVED IN A BULK IMPORT RUN (R19).

      R19 waives the certificate against the competencies a migration run loads
      — a customer bringing in a decade of tickets has no scans of them — while
      holding a competency recorded on the same person AFTERWARDS to the
      ordinary rule, so the concession never becomes the standard. Nothing on
      the record tells those two apart without this.

      A plain nullable timestamp rather than a reference to the run: the import
      run table belongs to the Organisation Settings artifact, and a foreign key
      to it would make this schema depend on a table that plan has not created
      yet. The owed-file list reads only whether it is set.

      Null on every grant the product itself made, which is the existing case.
    */
    importedAt: timestamp('imported_at', { withTimezone: true }),
    /*
      A LICENCE IS A COMPETENCY, NOT A PROFILE FIELD (R33, R34).

      Class, number, expiry and document have the exact shape this table already
      handles. Recorded here, a licence inherits expiry dates, grace periods,
      revocation and a place in every prerequisite and compliance check for free
      (R35, R36); recorded as three flat fields on a form answer — which is where
      it lives today — it inherits none of that and expires silently.

      Two columns rather than four: the expiry is `expiresAt` above, used exactly
      as an imported record uses it, and the document is a `competency_documents`
      row. Nullable because most competencies are not licences.
    */
    licenceClass: text('licence_class'),
    licenceNumber: text('licence_number'),
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
    /*
      WHICH FIELD this entry covers, as the profile inventory's key (R57, R58).
      Null on every entry that is not about one field, which is every entry
      written before this existed.

      Structured rather than parsed out of `target`, because R58 confines
      sensitive-field entries to Admin and a filter over free text would have to
      pattern-match the same prose that holds the values it is trying to hide —
      leaking a date of birth whenever the match missed, and over-hiding ordinary
      history whenever it matched too much. A column makes the filter a
      comparison on data.
    */
    field: text(),
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
    /*
      CONFIRMATION lives here, per starter, not on the booking. A booking is
      tentative until the Thursday gate check says the starter is ready and the
      seat stands — and that check is per person, so a cohort booking can be
      partially confirmed. The booking reads as confirmed only when every
      starter row is.

      Null means unconfirmed, which is accurate for every row that predates the
      column: no backfill, no destructive change. The actor pair mirrors
      `bookedByUserId`/`bookedByApiKeyId` on the booking, for the same reason —
      a machine confirmation stays distinguishable from a human one.
    */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** The acting user. For a machine call this is the API key's issuer. */
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Set when an agent confirmed it, so machine and human confirmations stay distinguishable. */
    confirmedByApiKeyId: uuid('confirmed_by_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('induction_booking_starters_uq').on(t.bookingId, t.submissionId),
    index('induction_booking_starters_submission_idx').on(t.submissionId),
  ],
);

/**
 * A voluntary training request (U22, KTD9's one new table).
 *
 * A person asks for an assessment no Role obliges them to hold (R94). The
 * request is an action on their OWN record — the requester is always the subject
 * (`userId`), never raised on another's behalf — so the permission matrix does
 * not gate it (R37). It waits `pending` on the working list until an Admin
 * approves it (which assigns the tool through the ordinary assignment path) or
 * declines it; there is no self-service enrolment (R96).
 */
export const trainingRequests = pgTable(
  'training_requests',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The subject AND requester — the two are the same person (R37). */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The assessment tool being asked for — what an approval assigns. */
    toolId: uuid('tool_id')
      .notNull()
      .references(() => assessmentTools.id, { onDelete: 'cascade' }),
    state: trainingRequestStateEnum().notNull().default('pending'),
    /** The Admin who approved or declined it; null while pending. */
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('training_requests_org_idx').on(t.orgId),
    index('training_requests_user_idx').on(t.userId),
    // A person needs at most one open request per tool — a retried click does not
    // stack duplicates on the working list.
    uniqueIndex('training_requests_pending_uq')
      .on(t.userId, t.toolId)
      .where(sql`${t.state} = 'pending'`),
  ],
);

/**
 * A notice the expiry sweep has already sent (U21, KTD11). Its existence is what
 * makes the sweep idempotent: a competency inside its notification window is
 * notified UNLESS a row already records it for that holder and that window, so a
 * second sweep before the window changes sends nothing twice. The window is keyed
 * by the EXPIRY DATE — a renewal moves the expiry, opening a fresh window that
 * may notify again. The row is also the LOGIN delivery route (R98): served to its
 * holder on their own record, so a person with a login but no reachable email is
 * still reached.
 */
export const sentNotices = pgTable(
  'sent_notices',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    competencyId: uuid('competency_id')
      .notNull()
      .references(() => competencies.id, { onDelete: 'cascade' }),
    /** The expiry the notice was about, `YYYY-MM-DD` — the window key (R97). */
    expiresOn: text('expires_on').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('sent_notices_org_idx').on(t.orgId),
    index('sent_notices_user_idx').on(t.userId),
    // One notice per holder per competency per window — the idempotence guard.
    uniqueIndex('sent_notices_uq').on(t.userId, t.competencyId, t.expiresOn),
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

/**
 * One workforce-import run (U24, R171).
 *
 * PERSISTED because the rejection list is the artifact an Admin needs to correct
 * the source file and re-import, and a report that lived only in the page would
 * die with the tab. Addressable by id afterwards for exactly that reason.
 *
 * Carries no counters. Every figure the report names — profiles created, people
 * merged, seats per pool, competencies recorded, rows rejected — is DERIVED from
 * `import_run_rows`, because a stored tally and the rows it counts can disagree
 * and the rows are what an Admin acts on anyway.
 */
export const importRuns = pgTable(
  'import_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The Admin who confirmed the run. A run is never automatic (R144). */
    startedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    /** Null while the run is in progress — what the screen polls against. */
    completedAt: timestamp({ withTimezone: true }),
    /** Rows the file carried, so progress reads as processed-against-total. */
    rowsTotal: integer().notNull().default(0),
  },
  (t) => [index('import_runs_org_idx').on(t.orgId)],
);

/**
 * What one row of the file did (U24, R154, R171).
 *
 * ONE ROW PER PROFILE ROW, whatever happened to it — landed, merged,
 * reactivated, repeated, or rejected with its reason. The rejected ones are
 * what an Admin re-exports to fix the file; the flagged ones are what R154
 * marks incomplete; the differences are what an Admin settles on the team
 * screen. All three read this table.
 */
export const importRunRows = pgTable(
  'import_run_rows',
  {
    id: uuid().primaryKey().defaultRandom(),
    runId: uuid()
      .notNull()
      .references(() => importRuns.id, { onDelete: 'cascade' }),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The row's line in the source file, so a rejection points at what to fix. */
    rowNumber: integer().notNull(),
    /** Name or address, for a report a person can read without the file open. */
    subject: text().notNull(),
    outcome: importRowOutcomeEnum().notNull(),
    /**
     * Why it was rejected — the validator's own reason, or a run-time one
     * (`seat_limit_reached`, `placement_invalid`). Null on anything that landed.
     */
    reason: text(),
    /** Free-text detail beside the reason, e.g. the value that was not recognised. */
    detail: text(),
    /** Set where the row produced or matched one. */
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    membershipId: uuid(),
    /**
     * Inventory keys the row left empty (R154). A landed row is FLAGGED naming
     * exactly what is missing rather than having whoever ran the import invent
     * demographic answers for somebody they may never speak to.
     */
    flagged: jsonb().$type<string[]>().notNull().default([]),
    /**
     * Values the file carries that an existing ACTIVE membership does not
     * (R149) — reported for an Admin to settle, never written over. An import
     * must not be able to demote an administrator on the strength of a column.
     */
    differences: jsonb()
      .$type<Array<{ field: string; existing: string; fromFile: string }>>()
      .notNull()
      .default([]),
    /**
     * Competencies this row's lines recorded, and — of those — how many carry
     * no grant date (R153, reversed: an undated line is still RECORDED, just
     * flagged for someone to date later, rather than withheld). Both count
     * lines that landed; an undated one is a subset of recorded, never a
     * separate "did not record" bucket.
     */
    competenciesRecorded: integer().notNull().default(0),
    competenciesUndated: integer().notNull().default(0),
    /** Assessments assignment created for this person after their competencies landed (R163). */
    assessmentsAssigned: integer().notNull().default(0),
    /** Which pool the row's seat came from, or null where it cost none (R143). */
    seatPool: text(),
  },
  (t) => [index('import_run_rows_run_idx').on(t.runId)],
);

export const importRunsRelations = relations(importRuns, ({ one, many }) => ({
  org: one(organizations, {
    fields: [importRuns.orgId],
    references: [organizations.id],
  }),
  rows: many(importRunRows),
}));

export const importRunRowsRelations = relations(importRunRows, ({ one }) => ({
  run: one(importRuns, {
    fields: [importRunRows.runId],
    references: [importRuns.id],
  }),
}));
