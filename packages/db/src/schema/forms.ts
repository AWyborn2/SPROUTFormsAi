import { relations } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { FormContainer, FormField, RevisionIdentity, ThemeTokens } from '@formai/shared';
import { formSourceTypeEnum, templateStatusEnum, versionStateEnum } from './enums.ts';
import { organizations, users } from './organizations.ts';
import { formBrands } from './form-brands.ts';

/**
 * DB-level default for the container column. Mirrors `DEFAULT_CONTAINER` in
 * @formai/shared; inlined so the schema stays self-contained for drizzle-kit.
 */
const DEFAULT_CONTAINER: FormContainer = {
  maxWidth: 600,
  padding: 26,
  radius: 14,
  borderWidth: 1,
  borderColor: '',
  background: '',
  shadow: 'lg',
};

/**
 * A form template. Mutable metadata; the field content lives in versions.
 * `currentVersionId` points at the version shown as "the" template.
 */
export const formTemplates = pgTable(
  'form_templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    dept: text(),
    sourceType: formSourceTypeEnum().notNull(),
    status: templateStatusEnum().notNull().default('draft'),
    /** FK set after the first version row exists (nullable to break the cycle). */
    currentVersionId: uuid(),
    /**
     * Per-form theme override — a sparse patch over the org's theme, where an
     * absent key means "inherit". Null when the form has never been restyled.
     *
     * Deliberately on the mutable template rather than on the version beside
     * `container`: versions are immutable once published, so putting theme
     * there would mint a new form version on every colour tweak and leave live
     * forms stale until someone republished them.
     */
    /**
     * The BRAND this form is presented in — usually a client's, not the org's.
     *
     * Null falls back to the org's own theme, which is right for a form nobody
     * has assigned. It is deliberately NOT a default-to-our-brand: a
     * subcontractor's forms mostly carry somebody else's, so "unassigned" and
     * "ours" are different statements and collapsing them would silently put
     * our colours on a client's document.
     *
     * `set null` on delete rather than cascade: deleting a brand must not
     * delete the forms that used it. They fall back to the org's theme, which
     * is visible and recoverable.
     */
    brandId: uuid('brand_id').references(() => formBrands.id, { onDelete: 'set null' }),
    themeOverride: jsonb('theme_override').$type<ThemeTokens>(),
    /**
     * Per-form voice-input override, three-state by design: NULL inherits the
     * workspace default (`organizations.branding.voiceInput`, absent = on),
     * true/false pins this form regardless of it. Same reasoning as
     * `themeOverride` for living on the mutable template rather than a
     * version: flipping voice off must take effect on live fill links
     * immediately, not after a republish. Resolution is `resolveVoiceInput`
     * in @formai/shared — the one rule every enforcement door shares.
     */
    voiceInput: boolean('voice_input'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('form_templates_org_idx').on(t.orgId)],
);

/**
 * An immutable-once-published version of a template. Publishing freezes
 * `fields`; editing a published version forks a new `draft` row. Submissions
 * pin the exact version they were filled against.
 */
export const formTemplateVersions = pgTable(
  'form_template_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    templateId: uuid()
      .notNull()
      .references(() => formTemplates.id, { onDelete: 'cascade' }),
    versionLabel: text().notNull(),
    state: versionStateEnum().notNull().default('draft'),
    /** Frozen field set (JSONB). Do not mutate when state === 'published'. */
    fields: jsonb().$type<FormField[]>().notNull().default([]),
    container: jsonb().$type<FormContainer>().notNull().default(DEFAULT_CONTAINER),
    /** For pdf_import templates — Supabase Storage id of the original PDF. */
    sourcePdfAssetId: text(),
    /**
     * The paper document's own revision identity — code, review date, change
     * note — for versions produced by an assessment-tool revision. Null on
     * every version that predates revisions and on plain forms, which never
     * set it. Written only by the republish path; surfaces in version history
     * and on printed evidence, where auditors read the document's identity,
     * not the internal version label.
     */
    revisionIdentity: jsonb('revision_identity').$type<RevisionIdentity>(),
    publishedAt: timestamp({ withTimezone: true }),
    publishedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('form_template_versions_template_idx').on(t.templateId)],
);

export const formTemplatesRelations = relations(formTemplates, ({ one, many }) => ({
  org: one(organizations, {
    fields: [formTemplates.orgId],
    references: [organizations.id],
  }),
  versions: many(formTemplateVersions),
}));

export const formTemplateVersionsRelations = relations(formTemplateVersions, ({ one }) => ({
  template: one(formTemplates, {
    fields: [formTemplateVersions.templateId],
    references: [formTemplates.id],
  }),
}));
