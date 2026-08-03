import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './organizations.ts';

/**
 * A half-mapped import, saved deliberately and by name.
 *
 * Mapping an eighteen-page assessment is hours of work — every field corrected,
 * every option box placed and confirmed against the printed page — and until
 * this existed none of it survived leaving the wizard.
 *
 * DISTINCT FROM THE LOCAL AUTOSAVE, which lives in the browser and exists so
 * that an INTERRUPTION costs nothing. This is the other thing the same work
 * needs: a laptop can die, a form can be started by one person and finished by
 * another, and a mapping can be parked for a fortnight while the paper document
 * goes through a revision. None of that is served by a copy that only exists in
 * one browser profile on one machine.
 *
 * THE PDF IS NOT HERE. It is already in storage under `assetId` — the same id
 * the wizard uploaded it against and the same one a published template records
 * as its source. Copying the bytes into every save would multiply the size of
 * the row for something already stored, and leave two copies to disagree.
 *
 * The snapshot is opaque JSON on purpose. Its shape belongs to the review
 * surface and carries a version the client checks on load; a snapshot the
 * client no longer understands is discarded rather than migrated, so there is
 * nothing here for the database to validate and nothing it could usefully
 * enforce.
 */
export const importDrafts = pgTable(
  'import_drafts',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** What the person called it — how they will recognise it in a fortnight. */
    name: text().notNull(),
    /** Storage id of the uploaded PDF this mapping belongs to. */
    assetId: text('asset_id').notNull(),
    /** The review state, as `ImportSnapshot`. Opaque here; versioned by the client. */
    snapshot: jsonb().notNull(),
    /**
     * Who saved it last, not who created it. A draft is explicitly something a
     * colleague may pick up, so the useful question on a list of them is whose
     * work you would be continuing.
     */
    savedByUserId: uuid('saved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /*
      One draft per name per org, so saving under a name you have used before
      OVERWRITES it. That is what "save" means everywhere else, and the
      alternative — silently accumulating "Track Dozer" seven times — makes the
      list useless at exactly the point it matters.
    */
    unique('import_drafts_org_name_uq').on(t.orgId, t.name),
    index('import_drafts_org_idx').on(t.orgId),
  ],
);

export const importDraftsRelations = relations(importDrafts, ({ one }) => ({
  org: one(organizations, {
    fields: [importDrafts.orgId],
    references: [organizations.id],
  }),
  savedBy: one(users, {
    fields: [importDrafts.savedByUserId],
    references: [users.id],
  }),
}));
