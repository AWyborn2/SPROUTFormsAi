import { relations } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './organizations.ts';
import { extractionCaptures } from './extraction-captures.ts';

/**
 * The structured diff between a raw extraction and the form the reviewer
 * published — the training signal of the (human-gated) extraction learning loop.
 *
 * WHY THIS EXISTS. `extraction_captures` stores the BEFORE (what the model
 * produced). This stores the diff against the AFTER: what the reviewer changed
 * in the builder, as an `ExtractionCorrections` record (from @formai/shared,
 * computed client-side at publish, where both sides sit together). The two
 * together are what a later step clusters into content-free shapes to see which
 * mistakes recur — and, once a rule is promoted, whether the rate of that shape
 * falls. See docs/plans/2026-08-17-001-feat-extraction-learning-loop-plan.md.
 *
 * WRITTEN AT PUBLISH ONLY. A correction is the reviewer's committed final answer,
 * so a row is written when a form is published, never from an abandoned draft —
 * an uncommitted opinion is not ground truth. The write is its own request, not
 * on the publish critical path, so a failure never blocks a publish.
 *
 * `captureId` links to the exact raw extraction this corrects. It is nullable and
 * `set null` on delete: the pairing may not resolve (the inline-base64 path has no
 * capture to link, and captures may be pruned), and a correction outlives the raw
 * it came from. `formId` / `versionId` are provenance of the published AFTER,
 * kept as plain ids rather than foreign keys so a correction record is never
 * deleted or blocked by the lifecycle of the form it taught us about.
 *
 * `correctionCount` and `fieldCount` are denormalised out of the payload so the
 * correction-rate metric (corrections per extracted field) is a cheap aggregate
 * that never opens the jsonb.
 */
export const extractionCorrections = pgTable(
  'extraction_corrections',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The raw-extraction capture this diff is against, when it resolved to one. */
    captureId: uuid('capture_id').references(() => extractionCaptures.id, {
      onDelete: 'set null',
    }),
    /** Storage id of the source PDF, when one exists. */
    assetId: text('asset_id'),
    /** The `DocumentType` of the import, copied from the corrections payload. */
    documentType: text('document_type'),
    /** Provenance of the published AFTER — plain ids, not foreign keys (see above). */
    formId: text('form_id'),
    versionId: text('version_id'),
    /** The full `ExtractionCorrections` record, verbatim. */
    corrections: jsonb().notNull(),
    /** Number of corrections in the payload — the metric numerator. */
    correctionCount: integer('correction_count').notNull(),
    /** Number of fields the raw extraction produced — the metric denominator. */
    fieldCount: integer('field_count').notNull(),
    /** Who published the reviewed form. Set null if the user is later removed. */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /*
      (org, documentType) is how the metric and the clustering slice these — "how
      often is each correction shape seen for assessment imports" — so it is the
      one lookup worth an index up front.
    */
    index('extraction_corrections_org_type_idx').on(t.orgId, t.documentType),
    index('extraction_corrections_capture_idx').on(t.captureId),
  ],
);

export const extractionCorrectionsRelations = relations(extractionCorrections, ({ one }) => ({
  org: one(organizations, {
    fields: [extractionCorrections.orgId],
    references: [organizations.id],
  }),
  capture: one(extractionCaptures, {
    fields: [extractionCorrections.captureId],
    references: [extractionCaptures.id],
  }),
  createdBy: one(users, {
    fields: [extractionCorrections.createdByUserId],
    references: [users.id],
  }),
}));
