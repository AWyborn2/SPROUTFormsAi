import { relations, sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { displayIdentifierEnum, taxonomyStatusEnum } from './enums.ts';
import { organizations } from './organizations.ts';

/**
 * The organisation's own taxonomy: Locations, Departments, and the Roles each
 * Department offers. These replace the department/role map hardcoded for one
 * customer (R3) so a second customer can be onboarded without a release.
 *
 * Every record that carries one of these values points at it by id (R136), so
 * a rename reaches a membership, a case in flight and a submission at once with
 * nothing to find and rewrite. Names are never copied onto other records —
 * the one exception is a settled assessment record, which captures the words it
 * was signed with (R138), and that capture lives on the case, not here.
 *
 * `status` is active or retired (R15). Retiring keeps the value on the records
 * that hold it and blocks it for new ones (R16, R114); it is never a delete.
 * The uniqueness constraints are therefore PARTIAL — scoped to active rows —
 * so a retired name does not block re-creating an active one.
 */

/** Where the organisation assesses. Chosen from this list, never typed (R76, R77). */
export const locations = pgTable(
  'locations',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    status: taxonomyStatusEnum().notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('locations_org_idx').on(t.orgId),
    // Two ACTIVE Locations in one org cannot share a name, case-insensitively.
    // A value chosen from a list cannot be a near-miss (R79's premise).
    uniqueIndex('locations_org_name_active_uq')
      .on(t.orgId, sql`lower(${t.name})`)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * A Department classifies assessments (R9) and carries the Roles it offers plus
 * the one-or-several-Roles rule (R5). `allowsMultipleRoles` preserves the
 * load-bearing behaviour where Operations crews hold several machine roles and
 * every other department holds one (R7).
 */
export const departments = pgTable(
  'departments',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** R5: whether a person placed here may hold several of this Department's Roles. */
    allowsMultipleRoles: boolean('allows_multiple_roles').notNull().default(false),
    status: taxonomyStatusEnum().notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('departments_org_idx').on(t.orgId),
    uniqueIndex('departments_org_name_active_uq')
      .on(t.orgId, sql`lower(${t.name})`)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * A job Role, offered WITHIN a Department rather than against an org-wide list
 * (R5). Two Departments offering a Role of the same name offer two Roles, each
 * with its own required assessments — which is why the parent is the Department
 * and uniqueness is per Department, not per org.
 *
 * The table is `roles` (job roles); the ACCESS-LEVEL concept is the `role` enum
 * on memberships, unchanged (R19 renames the vocabulary, not the column). The
 * TS type is exported as `JobRole` to keep the two apart in code.
 *
 * `onDelete: 'restrict'` on the Department: a Department offering Roles is not
 * deletable, matching the restrict posture assessment cases already take on
 * their tool. Retirement, not deletion, is how a Department is withdrawn.
 */
export const jobRoles = pgTable(
  'roles',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    status: taxonomyStatusEnum().notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('roles_org_idx').on(t.orgId),
    index('roles_department_idx').on(t.departmentId),
    // Per DEPARTMENT, not per org: a fitter Role in Maintenance and a fitter
    // Role on a contract crew are two Roles (R5).
    uniqueIndex('roles_department_name_active_uq')
      .on(t.departmentId, sql`lower(${t.name})`)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const locationsRelations = relations(locations, ({ one }) => ({
  org: one(organizations, { fields: [locations.orgId], references: [organizations.id] }),
}));

export const departmentsRelations = relations(departments, ({ one, many }) => ({
  org: one(organizations, { fields: [departments.orgId], references: [organizations.id] }),
  roles: many(jobRoles),
}));

export const jobRolesRelations = relations(jobRoles, ({ one }) => ({
  org: one(organizations, { fields: [jobRoles.orgId], references: [organizations.id] }),
  department: one(departments, {
    fields: [jobRoles.departmentId],
    references: [departments.id],
  }),
}));
