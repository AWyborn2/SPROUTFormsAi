import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { BuilderDraft } from '@formai/shared';
import { organizations, users } from './organizations.ts';
import { formTemplates, formTemplateVersions } from './forms.ts';

/**
 * An assessment tool being BUILT — the seven-step builder's working state.
 *
 * Distinct from `import_drafts`, which holds a half-mapped IMPORT: an import
 * draft ends at a published template version, and this carries three more
 * things a template version has no room for — the part manifest, the answer
 * keys, and the workflow. Folding them into the import snapshot would put the
 * complete answer key to a safety-critical assessment inside a record whose
 * shape the review surface owns and versions independently.
 *
 * WHY THIS IS A ROW AND NOT BROWSER STORAGE. Authoring a tool takes days: the
 * placement pass alone is a couple of hours across three hundred boxes, and the
 * answer key usually waits on somebody else confirming it against the source
 * manuals. A copy that lives in one browser profile on one machine cannot be
 * picked up by a colleague, does not survive a reinstall, and — for the key
 * specifically — means the answers to a safety assessment sit in `localStorage`
 * on a laptop.
 *
 * THE PDF IS NOT HERE, for the same reason it is not in an import draft: it is
 * already in storage under `assetId`, and a second copy is a second thing to
 * disagree.
 *
 * The state is opaque JSON, typed as `BuilderDraft` for the reader's benefit
 * and validated at the route boundary only as far as "is this an object". Its
 * shape belongs to the builder, and a shape the database validated would mean
 * every client-side addition failing to save until a migration caught up.
 */
export const assessmentToolDrafts = pgTable(
  'assessment_tool_drafts',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** What the author called it — usually the document's own title once read. */
    name: text().notNull(),
    /** Storage id of the uploaded PDF this tool is being built from. */
    assetId: text('asset_id').notNull(),
    /** Which of the seven steps to reopen on. */
    step: text().notNull().default('upload'),
    /** The builder's whole working state. Opaque here; owned by the builder. */
    state: jsonb().$type<Partial<BuilderDraft>>().notNull(),
    /*
      The form this draft publishes into, once one exists.

      Created early rather than at publish so the placement step can run against
      a real draft version — which is what lets it reuse the existing placement
      screen unchanged instead of growing a second geometry path.

      `set null` on both: deleting a form should not delete the record of the
      authoring work, and a builder draft pointing at a form that has gone is a
      recoverable state (re-publish into a new one) where a cascade would be a
      silent loss of the manifest and the keys.
    */
    formId: uuid('form_id').references(() => formTemplates.id, { onDelete: 'set null' }),
    versionId: uuid('version_id').references(() => formTemplateVersions.id, {
      onDelete: 'set null',
    }),
    /**
     * Who saved it last, not who created it. Like an import draft, this is
     * explicitly work a colleague may pick up, so the useful question on a list
     * is whose work you would be continuing.
     */
    savedByUserId: uuid('saved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /*
      One draft per name per org, so saving under a name already used
      OVERWRITES it — the same rule `import_drafts` follows, and for the same
      reason: a list that silently accumulates seven "Track Dozer"s is useless
      at exactly the point somebody needs to find theirs.
    */
    unique('assessment_tool_drafts_org_name_uq').on(t.orgId, t.name),
    index('assessment_tool_drafts_org_idx').on(t.orgId),
  ],
);

export const assessmentToolDraftsRelations = relations(assessmentToolDrafts, ({ one }) => ({
  org: one(organizations, {
    fields: [assessmentToolDrafts.orgId],
    references: [organizations.id],
  }),
  savedBy: one(users, {
    fields: [assessmentToolDrafts.savedByUserId],
    references: [users.id],
  }),
  form: one(formTemplates, {
    fields: [assessmentToolDrafts.formId],
    references: [formTemplates.id],
  }),
  version: one(formTemplateVersions, {
    fields: [assessmentToolDrafts.versionId],
    references: [formTemplateVersions.id],
  }),
}));
