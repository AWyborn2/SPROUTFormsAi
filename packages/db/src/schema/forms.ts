import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { FormContainer, FormField } from '@formai/shared';
import { formSourceTypeEnum, templateStatusEnum, versionStateEnum } from './enums.ts';
import { organizations, users } from './organizations.ts';

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
