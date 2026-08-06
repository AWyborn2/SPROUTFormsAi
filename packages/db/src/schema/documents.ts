import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { documentStateEnum } from './enums.ts';
import { organizations, users } from './organizations.ts';
import { competencyHolders } from './governance.ts';

/**
 * The bytes behind a competency's evidence (R25–R32).
 *
 * WHY A ROW AND NOT A COLUMN. `competency_holders.evidence_ref` is free text
 * pointing at some external register that nothing resolves — a note that a
 * document once existed. An assessor is required to SIGHT a certificate and
 * produce it as evidence of training competency, and there has been nothing to
 * open. R28 also admits several documents on one competency, which a column
 * cannot hold.
 *
 * WHY THE BYTES ARE NOT HERE. The row records a storage KEY minted by the
 * uploader that already exists (KTD23) — the one validator that checks PNG,
 * JPEG, WebP and PDF at ten megabytes against their magic bytes. Nothing about
 * that validator, its key namespace or its storage adapters changes; this table
 * adds the history and the authorisation the attachment route never had.
 *
 * HISTORY IS STATE, NEVER A DELETE (KTD24). R31 retains a superseded document
 * as evidence of what was held and sighted at the time, R52 retains a rejected
 * replacement as a record of what the candidate submitted, and R32 makes
 * outright removal Admin-only, audited and reasoned. One `state` column carries
 * all four, and every "the document on this competency" read filters to `held`
 * — the same discipline `revoked_at IS NULL` already states for the grant
 * itself.
 */
export const competencyDocuments = pgTable(
  'competency_documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /*
      The GRANT this evidences, not the competency definition: two people
      holding the same ticket have their own certificates. Cascade, because a
      grant that is gone has no evidence to keep — revocation is a timestamp
      rather than a delete, so this reaches only a genuinely removed row.
    */
    competencyHolderId: uuid('competency_holder_id')
      .notNull()
      .references(() => competencyHolders.id, { onDelete: 'cascade' }),
    /**
     * The storage key the uploader minted. NOT a path the client chose — the
     * key is server-side, which is what makes the namespace check on the
     * serving route meaningful.
     */
    storageKey: text('storage_key').notNull(),
    /** Display only, sanitised at upload. Never a path component. */
    fileName: text('file_name').notNull().default(''),
    /** The server's VERIFIED type, from the magic-byte check — not the client's claim. */
    contentType: text('content_type').notNull(),
    state: documentStateEnum().notNull().default('held'),
    /*
      Who put it there and when. A candidate supplying a replacement under R52 is
      the uploader of a `pending` row, which is how the queue tells a submission
      apart from an Admin's attachment.
    */
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
    /*
      APPROVAL: evidence that a human opened the certificate and accepted it
      (R43). Deliberately inert — it changes neither the competency's currency
      nor its standing nor whether it satisfies a prerequisite, and a document
      nobody has approved yet blocks nothing (R46).
    */
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /*
      REJECTION (R47, R52). Rejecting flags the document to an Admin to resolve
      with the person and REVOKES NO COMPETENCY: revocation means the
      qualification was taken away, and an illegible photograph is not that.
    */
    rejectedByUserId: uuid('rejected_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    /*
      REMOVAL (R32) — Admin-only, audited, and carrying a reason. It exists for
      the document uploaded to the wrong person's record, not as a way to tidy:
      a superseded document is retained under R31 rather than removed this way.
      The row and the stored object both stay; only the state moves.
    */
    removedByUserId: uuid('removed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedReason: text('removed_reason'),
    /** The document this one replaced, when it superseded another (R31). */
    supersededDocumentId: uuid('superseded_document_id'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('competency_documents_org_idx').on(t.orgId),
    index('competency_documents_holder_idx').on(t.competencyHolderId),
    /** The serving route resolves a key to its row to authorise it, and the attachment route to refuse it. */
    index('competency_documents_key_idx').on(t.storageKey),
  ],
);

export const competencyDocumentsRelations = relations(competencyDocuments, ({ one }) => ({
  org: one(organizations, {
    fields: [competencyDocuments.orgId],
    references: [organizations.id],
  }),
  holder: one(competencyHolders, {
    fields: [competencyDocuments.competencyHolderId],
    references: [competencyHolders.id],
  }),
}));
