import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { PermissionMatrix } from '@formai/shared';
import { auditCategoryEnum, roleEnum } from './enums.ts';
import { organizations, users } from './organizations.ts';
import { formTemplates } from './forms.ts';

/** Competencies held by workers (Should-tier gating). */
export const competencies = pgTable(
  'competencies',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    code: text().notNull(),
    holders: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('competencies_org_idx').on(t.orgId)],
);

/** Which competency unlocks which form section. */
export const competencyRules = pgTable(
  'competency_rules',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    templateId: uuid()
      .notNull()
      .references(() => formTemplates.id, { onDelete: 'cascade' }),
    sectionRef: text().notNull(),
    competencyId: uuid()
      .notNull()
      .references(() => competencies.id, { onDelete: 'cascade' }),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('competency_rules_org_idx').on(t.orgId)],
);

/** Per-org, per-role capability matrix. Seeded from the prototype defaults. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: roleEnum().notNull(),
    matrix: jsonb().$type<PermissionMatrix>().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('role_permissions_org_role_uq').on(t.orgId, t.role)],
);

/** Who did what, when, on which entity. Append-only. */
export const auditLogEntries = pgTable(
  'audit_log_entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    actorName: text().notNull().default('System'),
    action: text().notNull(),
    target: text().notNull().default(''),
    category: auditCategoryEnum().notNull().default('general'),
    icon: text().notNull().default('activity'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('audit_org_idx').on(t.orgId),
    index('audit_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

export const competenciesRelations = relations(competencies, ({ one, many }) => ({
  org: one(organizations, {
    fields: [competencies.orgId],
    references: [organizations.id],
  }),
  rules: many(competencyRules),
}));

export const competencyRulesRelations = relations(competencyRules, ({ one }) => ({
  org: one(organizations, {
    fields: [competencyRules.orgId],
    references: [organizations.id],
  }),
  template: one(formTemplates, {
    fields: [competencyRules.templateId],
    references: [formTemplates.id],
  }),
  competency: one(competencies, {
    fields: [competencyRules.competencyId],
    references: [competencies.id],
  }),
}));
