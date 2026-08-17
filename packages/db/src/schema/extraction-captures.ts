import { relations } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './organizations.ts';

/**
 * The RAW output of one extraction, kept so a later step can learn from how the
 * reviewer corrected it.
 *
 * WHY THIS EXISTS. Extraction is a model reading a printed form, and it gets
 * things wrong in patterned ways — an open question read as a radio, an orphaned
 * choice emitted as its own field, a checklist collapsed into questions. The
 * reviewer fixes those in the builder, and today that correction is the only
 * record of what was wrong — but the extraction it corrected is thrown away the
 * moment it reaches the client, so the two can never be compared. Without the
 * BEFORE, there is nothing to diff the AFTER against, and the same mistake is
 * made on the next paper with no way to notice it recurs.
 *
 * This is the BEFORE: the extraction result exactly as the pipeline produced it,
 * stored verbatim. Pairing it with the reviewer-approved form (the import draft
 * snapshot, or the published version) is a later, human-gated step — this table
 * only captures the signal so that step becomes possible. It changes no
 * extraction behaviour and is written best-effort: a failed capture must never
 * fail an import (see `captureExtraction`).
 *
 * THE PDF IS NOT HERE. Like an import draft, it is already in storage under
 * `assetId`; copying the bytes into every capture would duplicate megabytes
 * already stored. A capture from the inline-base64 path carries no `assetId` and
 * simply cannot be paired back to a stored asset — that is honest, not a defect.
 *
 * `result` is our OWN shape (`ExtractionResult` from @formai/shared), unlike the
 * import-draft snapshot which belongs to the review surface. `fieldCount` and
 * `path` are denormalised out of it so aggregate queries ("how often does the AI
 * path get corrected?") need not open the jsonb.
 *
 * RETENTION is deliberately not enforced here. These accumulate one row per
 * extraction and are training data, not operational state; pruning old captures
 * is a policy decision for when the distillation step lands, not something to
 * bake into the capture.
 */
export const extractionCaptures = pgTable(
  'extraction_captures',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * Storage id of the PDF this extraction read, when there was one. Null for
     * the inline-base64 path, which cannot be paired back to a stored asset.
     */
    assetId: text('asset_id'),
    /** The uploaded file name, for recognising a capture without opening it. */
    fileName: text('file_name').notNull(),
    /** The `DocumentType` selected for this import, or null when unspecified. */
    documentType: text('document_type'),
    /** Which extraction path ran: `acroform` (deterministic) or `ai`. */
    path: text().notNull(),
    /** Page count of the source document, as the pipeline reported it. */
    pageCount: integer('page_count').notNull(),
    /** The extraction model, when the AI path ran; null for the AcroForm path. */
    model: text(),
    /** The full `ExtractionResult`, verbatim — the BEFORE the loop diffs against. */
    result: jsonb().notNull(),
    /** Field count denormalised from `result`, so counts need not open the jsonb. */
    fieldCount: integer('field_count').notNull(),
    /** Who ran the extraction. Set null if the user is later removed. */
    extractedByUserId: uuid('extracted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('extraction_captures_org_idx').on(t.orgId),
    /*
      (org, asset) is how a capture is later paired with the reviewer-approved
      form for the same asset — the whole reason it is stored — so it is the one
      lookup worth an index up front.
    */
    index('extraction_captures_org_asset_idx').on(t.orgId, t.assetId),
  ],
);

export const extractionCapturesRelations = relations(extractionCaptures, ({ one }) => ({
  org: one(organizations, {
    fields: [extractionCaptures.orgId],
    references: [organizations.id],
  }),
  extractedBy: one(users, {
    fields: [extractionCaptures.extractedByUserId],
    references: [users.id],
  }),
}));
