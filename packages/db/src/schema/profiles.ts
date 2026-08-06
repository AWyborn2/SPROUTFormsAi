import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { memberships, organizations } from './organizations.ts';

/**
 * The organisation's workforce record for one member (R1, R2).
 *
 * KEYED ON THE MEMBERSHIP, one row to one, and that is the whole design. R1
 * resolves a profile to a person AND to that person's single membership of the
 * organisation, and makes one organisation's view of somebody unreachable from
 * another's. Personal detail therefore cannot live on `users`: that row is
 * product-wide and uniquely keyed on an email address shared across every
 * organisation the person works for, so a contractor working for two customers
 * would have one address, one date of birth and one emergency contact between
 * them. Keying here gives each organisation its own, and lets an Admin correct a
 * surname without reaching into a record another customer holds.
 *
 * It is also not columns on `memberships`. That row is read by every seat count
 * and every permission resolution in the product; widening it by twelve columns
 * of personal detail would put a date of birth in the working set of every
 * authorisation check.
 *
 * DESPITE THE ARTIFACT'S NAME this serves every member, not candidates alone. An
 * assessor's and an administrator's record is this one, under these rules.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *  - the email address, which stays on `users` where it is unique product-wide
 *    and is the person-record lookup key (R16);
 *  - the display name and Indigenous status, both DERIVED on read and never
 *    stored (KTD19) — a stored copy is a second source that can disagree with
 *    the first, the posture standing already takes;
 *  - the username, which is a sign-in identity and so belongs on `users` (KTD21);
 *  - Location, Department and Role, which R1 puts on the membership and the
 *    Organisation Settings artifact already built as join tables;
 *  - the licence, which is a competency rather than a profile field (R33).
 */
export const memberProfiles = pgTable(
  'member_profiles',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** One profile per membership (R1). Cascade: deleting a membership takes its profile. */
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),

    // ── Identity ────────────────────────────────────────────────────────────
    /*
      Three name columns rather than the one `users.name` holds, because R3
      derives a display name from the first and the last and excludes the middle
      — which an undivided string cannot answer. The middle name is nullable
      because the intake this inventory is adopted from treats it as optional
      (R12): plenty of people have none, and refusing the record over it would
      be a stricter rule than the form already in production use.
    */
    firstName: text('first_name').notNull(),
    middleName: text('middle_name'),
    lastName: text('last_name').notNull(),

    // ── Demographics ────────────────────────────────────────────────────────
    /*
      Text validated against the shared lists rather than pg enums. The lists are
      the only ones the product defines and they carry one customer's wording, so
      whether they are product-wide or per-organisation is an open question (R14)
      — text keeps that answer a change to one shared module instead of a
      migration on live rows.

      Both are REQUIRED and both carry an explicit decline value — Undisclosed on
      gender, Unknown on ethnicity (R13). Choosing one records a decline rather
      than leaving the field empty, so a required demographic question can still
      be answered honestly by somebody who would rather not say.
    */
    gender: text().notNull(),
    ethnicity: text().notNull(),
    /*
      NO `indigenous_status` COLUMN, deliberately (R15, KTD19). It is derived
      from the ethnicity answer and entered by nobody, which is what makes it
      unable to contradict the answer it comes from and what keeps "not stated"
      from ever being reported as "not Indigenous".
    */

    // ── Contact ─────────────────────────────────────────────────────────────
    /*
      ISO `YYYY-MM-DD` text, matching `induction_bookings.induction_date` and the
      intake answer it is seeded from. A `date` column would round-trip through a
      timezone on the way to and from the client, and a date of birth that moves
      by a day depending on where the reader sits is a defect in a field used to
      verify identity against a licence.
    */
    dateOfBirth: text('date_of_birth').notNull(),
    addressStreet: text('address_street').notNull(),
    suburb: text().notNull(),
    postcode: text().notNull(),
    mobile: text().notNull(),
    /*
      Next of kin. Deliberately NOT marked sensitive in the shared inventory,
      departing from the induction redaction pattern which withholds both: this
      is who an organisation needs to reach in the moment it matters most.
    */
    emergencyContactName: text('emergency_contact_name').notNull(),
    emergencyContactPhone: text('emergency_contact_phone').notNull(),

    // ── Employment ──────────────────────────────────────────────────────────
    starterType: text('starter_type').notNull(),
    /*
      Optional whatever the intake does with it (R12): it genuinely arrives after
      the person does, and refusing to create a profile until it exists would
      stop an organisation recording somebody it has already hired.
    */
    inductionDate: text('induction_date'),

    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /** One profile per membership — the R1 invariant, enforced rather than assumed. */
    uniqueIndex('member_profiles_membership_uq').on(t.membershipId),
    index('member_profiles_org_idx').on(t.orgId),
  ],
);

export const memberProfilesRelations = relations(memberProfiles, ({ one }) => ({
  org: one(organizations, {
    fields: [memberProfiles.orgId],
    references: [organizations.id],
  }),
  membership: one(memberships, {
    fields: [memberProfiles.membershipId],
    references: [memberships.id],
  }),
}));
