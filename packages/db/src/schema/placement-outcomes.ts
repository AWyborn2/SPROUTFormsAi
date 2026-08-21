import { relations } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './organizations.ts';

/**
 * The outcomes of one placement session — what the geometry engine proposed
 * per field and what the reviewer then did about it — the training signal of
 * the (human-gated) PLACEMENT learning loop.
 *
 * WHY THIS EXISTS. `extraction_corrections` records how a reviewer corrected
 * what the extraction READ; it deliberately excludes geometry, because a
 * placement edit says nothing about text quality. This table is that excluded
 * signal's own home: per-field proposal tiers (auto-confirm / needs-review /
 * no-match), accepts, adjustments (kind + coarse magnitude bucket), rejections,
 * manual draws and page retargets — the evidence a tuning PR to the placement
 * engine is judged against. A NEW table rather than an extension, because the
 * lifecycles differ in every dimension that matters: placement happens on
 * VERSION fields, possibly repeatedly and long after import; there is often no
 * capture to key on; and the denormalised counters mean different things.
 * See docs/plans/2026-08-20-003-feat-placement-learning-loop-plan.md.
 *
 * WRITTEN AT SAVE PLACEMENT ONLY — this surface's commit gate, the analogue of
 * the text loop's publish. A session abandoned without saving writes nothing:
 * an uncommitted placement is not ground truth. One row PER SAVE, not per
 * session: the client recorder drains its buffer on every send, so each event
 * is stored exactly once and rows from repeated saves in one session sum
 * correctly. The write is fire-and-forget off the save path; a failure never
 * blocks or slows a save.
 *
 * `formId` / `versionId` are plain ids rather than foreign keys, for the same
 * reason `extraction_corrections.formId` is: the record outlives the form it
 * taught us about, and must never be deleted or blocked by its lifecycle.
 *
 * The counters are denormalised out of the `outcomes` jsonb — recomputed
 * server-side from the events at write time — so the hit-rate metric is a
 * cheap aggregate that never opens the payload.
 */
export const placementOutcomes = pgTable(
  'placement_outcomes',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Provenance of the placed version — plain ids, not foreign keys (see above). */
    formId: text('form_id'),
    versionId: text('version_id'),
    /** The `DocumentType` the host mount knew, when it knew one. */
    documentType: text('document_type'),
    /** Which mount recorded the session: `standalone` or `builder`. */
    context: text().notNull(),
    /** The full `PlacementOutcomes` record, verbatim. */
    outcomes: jsonb().notNull(),
    /** Fields whose latest derive produced any tier — the attempt denominator. */
    proposalsAttempted: integer('proposals_attempted').notNull(),
    /** Fields tiered auto-confirm — the hit-rate numerator. */
    autoConfirmed: integer('auto_confirmed').notNull(),
    /** Fields accepted from the review queue, adjusted first or not. */
    acceptedAsIs: integer('accepted_as_is').notNull(),
    /** Fields the reviewer adjusted, once per field. */
    adjusted: integer().notNull(),
    /** Fields whose needs-review proposal was rejected. */
    rejected: integer().notNull(),
    /** Fields the engine refused — its latest tier was no-match. */
    noMatch: integer('no_match').notNull(),
    /** Fields hand-drawn after a refusal or rejection. */
    manualDraws: integer('manual_draws').notNull(),
    /** Page retargets — one per field moved, per move. */
    retargets: integer().notNull(),
    /** Fields on the version — the eligibility universe. */
    fieldCount: integer('field_count').notNull(),
    /** Who saved the placement. Set null if the user is later removed. */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /*
      (org, documentType) is the metric slice — "what is the auto-place hit
      rate for assessment papers" — and (org, createdAt) is the weekly trend
      that says whether a tuning PR moved it. Both reads the insights endpoint
      makes, so both are worth an index up front.
    */
    index('placement_outcomes_org_type_idx').on(t.orgId, t.documentType),
    index('placement_outcomes_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

export const placementOutcomesRelations = relations(placementOutcomes, ({ one }) => ({
  org: one(organizations, {
    fields: [placementOutcomes.orgId],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [placementOutcomes.createdByUserId],
    references: [users.id],
  }),
}));
