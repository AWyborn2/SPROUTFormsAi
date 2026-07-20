import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { SubmissionValue } from '@formai/shared';
import { submissionStatusEnum } from './enums.ts';
import { organizations } from './organizations.ts';
import { formTemplates, formTemplateVersions } from './forms.ts';

/** A filled instance of a specific, immutable template version. */
export const submissions = pgTable(
  'submissions',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    templateId: uuid()
      .notNull()
      .references(() => formTemplates.id, { onDelete: 'restrict' }),
    /** Pins the exact version filled against — never the live template. */
    templateVersionId: uuid()
      .notNull()
      .references(() => formTemplateVersions.id, { onDelete: 'restrict' }),
    submitterName: text().notNull().default(''),
    submitterEmail: text().notNull().default(''),
    values: jsonb().$type<Record<string, SubmissionValue>>().notNull().default({}),
    status: submissionStatusEnum().notNull().default('submitted'),
    flag: text().notNull().default(''),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('submissions_org_idx').on(t.orgId),
    index('submissions_template_idx').on(t.templateId),
    index('submissions_version_idx').on(t.templateVersionId),
  ],
);

export const submissionsRelations = relations(submissions, ({ one }) => ({
  org: one(organizations, {
    fields: [submissions.orgId],
    references: [organizations.id],
  }),
  template: one(formTemplates, {
    fields: [submissions.templateId],
    references: [formTemplates.id],
  }),
  version: one(formTemplateVersions, {
    fields: [submissions.templateVersionId],
    references: [formTemplateVersions.id],
  }),
}));
