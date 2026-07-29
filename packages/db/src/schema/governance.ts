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

/**
 * Who holds which competency.
 *
 * `competencies.holders` is a denormalised COUNT and always was — it can say
 * "12 people hold this" but not WHICH twelve, so no prerequisite or
 * assessor-eligibility question was answerable before this table. The count
 * column is kept because existing displays read it; it is maintained alongside
 * these rows rather than replaced, so the two never disagree.
 *
 * `evidenceRef` is a free-text pointer at the external record (a certificate
 * number, an LMS record id) for orgs recording competencies by hand. It is
 * display and audit only — nothing resolves it, and until an LMS sync exists it
 * is the only trace of where a grant came from.
 */
export const competencyHolders = pgTable(
  'competency_holders',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    competencyId: uuid()
      .notNull()
      .references(() => competencies.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    evidenceRef: text('evidence_ref'),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /** A person holds a competency once; granting twice is idempotent. */
    uniqueIndex('competency_holders_competency_user_uq').on(t.competencyId, t.userId),
    index('competency_holders_user_idx').on(t.userId),
    index('competency_holders_org_idx').on(t.orgId),
  ],
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

/**
 * A machine credential: an org-scoped key an agent presents instead of a
 * session cookie.
 *
 * Only the SHA-256 `hash` of the full key is stored, so a database dump does
 * not yield working credentials and the plaintext exists exactly once, in the
 * create response. `prefix` is the displayable leading segment AND the lookup
 * handle — uniquely indexed so verification is one indexed read followed by a
 * constant-time hash comparison, rather than a scan that hashes every row.
 *
 * `role` reuses the membership role enum, so a key's authority is described in
 * exactly the same vocabulary as a person's and resolves through the same
 * permission matrix. Revocation is a timestamp rather than a delete: a key that
 * did something needs to remain visible to the audit conversation about it.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Human label, e.g. "Induction booking agent". */
    name: text().notNull(),
    role: roleEnum().notNull().default('reviewer'),
    prefix: text().notNull(),
    hash: text().notNull(),
    /**
     * The administrator who issued it. Machine calls act as this user, because
     * `TenantContext.userId` is non-nullable and audit rows must name a real
     * actor — an agent's action is attributable to whoever authorised it.
     */
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('api_keys_prefix_uq').on(t.prefix), index('api_keys_org_idx').on(t.orgId)],
);

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  org: one(organizations, {
    fields: [apiKeys.orgId],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [apiKeys.createdByUserId],
    references: [users.id],
  }),
}));

export const competenciesRelations = relations(competencies, ({ one, many }) => ({
  org: one(organizations, {
    fields: [competencies.orgId],
    references: [organizations.id],
  }),
  rules: many(competencyRules),
  holders: many(competencyHolders),
}));

export const competencyHoldersRelations = relations(competencyHolders, ({ one }) => ({
  org: one(organizations, {
    fields: [competencyHolders.orgId],
    references: [organizations.id],
  }),
  competency: one(competencies, {
    fields: [competencyHolders.competencyId],
    references: [competencies.id],
  }),
  user: one(users, {
    fields: [competencyHolders.userId],
    references: [users.id],
  }),
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
