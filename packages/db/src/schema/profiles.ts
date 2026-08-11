import { relations, sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { memberships, organizations, users } from './organizations.ts';

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

      Both carry an explicit decline value — Undisclosed on gender, Unknown on
      ethnicity (R13). Choosing one records a decline rather than leaving the
      field empty, so a demographic question can still be answered honestly by
      somebody who would rather not say.

      NULLABLE AT THE COLUMN, REQUIRED AT THE FORM (R19, R154). Interactive
      creation still demands both — `validateProfile` is unchanged and the
      profile screen refuses to save without them. What the null permits is the
      ONE case the form cannot cover: a bulk import of an existing workforce,
      where the source system holds an address and a phone number but was never
      asked for a demographic answer.

      The alternative was worse in a way that matters. A NOT NULL column forces
      whoever runs the import to invent a gender and an ethnicity for hundreds
      of people they may never speak to, and an invented Indigenous status is
      not a gap in a report — it is a wrong answer in one, indistinguishable
      from a real one ever after. A null says "nobody has been asked", the
      landed row is FLAGGED naming exactly this field, and the answer arrives
      from the person whose answer it is.
    */
    gender: text(),
    ethnicity: text(),
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

      Nullable for the same reason as the demographics above and under the same
      guard: the form requires them, the column permits their absence so an
      import of an existing workforce can land a partial record FLAGGED for
      follow-up rather than refusing the person outright.
    */
    dateOfBirth: text('date_of_birth'),
    addressStreet: text('address_street'),
    suburb: text(),
    postcode: text(),
    mobile: text(),
    /*
      Next of kin. Deliberately NOT marked sensitive in the shared inventory,
      departing from the induction redaction pattern which withholds both: this
      is who an organisation needs to reach in the moment it matters most.

      Which is also the argument for landing the record without them rather than
      refusing it. A worker with no emergency contact recorded is a gap somebody
      can chase; a worker with no record at all is invisible to the person doing
      the chasing.
    */
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),

    /*
      THE PROFILE PICTURE, as a storage key (R18).

      A key rather than a row of its own because there is one of it and no
      version history to keep — the intake this inventory is adopted from
      carries one photograph, and the licence image it also carries is a
      competency document rather than a second identity picture.

      NULLABLE, and that is a state rather than an omission: a picture MAY
      FOLLOW the record and stays owed until it does. Owed marks and lists, and
      blocks nothing — no case, no assessment and no competency waits on it.
    */
    profilePictureKey: text('profile_picture_key'),

    // ── Organisation-assigned identifiers (R7) ──────────────────────────────
    /*
      How the operation identifies a person on site. Both NULLABLE and both
      unique within the organisation, which is not a contradiction: the
      uniqueness indexes below are PARTIAL, over non-null values only, so two
      members holding neither is not a collision while a second issue of a
      number already held is refused. A plain unique index would make the
      ordinary case — a workforce where most people have no swipe card yet —
      impossible.

      Optional indefinitely rather than owed (R12): they genuinely arrive after
      the person does, and R24 falls back rather than failing when one or both
      are absent. Never the candidate's to write (R53) — the organisation issues
      and corrects them.
    */
    employeeNumber: text('employee_number'),
    swipeCardNumber: text('swipe_card_number'),

    // ── Employment ──────────────────────────────────────────────────────────
    /*
      Nullable on the same import guard as the demographics. Its value lists are
      an intake concept — how somebody came to be here — and a workforce migrated
      out of another system predates the intake that would have asked.
    */
    starterType: text('starter_type'),
    /*
      Optional whatever the intake does with it (R12): it genuinely arrives after
      the person does, and refusing to create a profile until it exists would
      stop an organisation recording somebody it has already hired.
    */
    inductionDate: text('induction_date'),

    /*
      An address an Admin has flagged as reaching nobody (R16, KTD22).

      HERE rather than on `users.email` for two reasons. The address is the
      person-record lookup key and is unique product-wide, so nothing may be
      written into it or cleared from it. And one customer's mail bouncing is
      not a fact about another's — the same person may be perfectly reachable
      at the organisation next door.

      The address itself STAYS on the record and the profile stays valid with
      nothing outstanding: what R16 requires is that a profile carries an
      address, not a working one. Null means nobody has flagged it, which is
      every profile until somebody does.
    */
    emailUnreachableAt: timestamp('email_unreachable_at', { withTimezone: true }),
    /** Who flagged it — an Admin, retained for the audit trail beside the entry. */
    emailUnreachableBy: uuid('email_unreachable_by').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /** One profile per membership — the R1 invariant, enforced rather than assumed. */
    uniqueIndex('member_profiles_membership_uq').on(t.membershipId),
    index('member_profiles_org_idx').on(t.orgId),
    /*
      R7: unique within the ORGANISATION, over non-null values only.

      Scoped per org because the same person may carry different numbers for two
      customers, and case-folded because "EMP001" and "emp001" being two
      different people is exactly the near-miss R7's uniqueness exists to
      prevent — the same reasoning the taxonomy's active-name indexes already
      apply.
    */
    uniqueIndex('member_profiles_org_employee_number_uq')
      .on(t.orgId, sql`lower(${t.employeeNumber})`)
      .where(sql`${t.employeeNumber} IS NOT NULL`),
    uniqueIndex('member_profiles_org_swipe_card_number_uq')
      .on(t.orgId, sql`lower(${t.swipeCardNumber})`)
      .where(sql`${t.swipeCardNumber} IS NOT NULL`),
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
