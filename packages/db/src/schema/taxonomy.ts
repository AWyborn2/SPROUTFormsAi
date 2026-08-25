import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { requirementTierEnum, taxonomyStatusEnum } from './enums.ts';
import { memberships, organizations } from './organizations.ts';
import { competencies } from './governance.ts';

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
    /*
      Whether this Role's required-assessment list has ever been set (R50). A
      Role with no requirement rows is ambiguous — never configured, or
      configured and then emptied — and the two read differently: the first is
      "nobody has set this up", the second is "this Role deliberately requires
      nothing". Row count cannot tell them apart, so the fact is stored, flipped
      true the first time the list is written. Both still assign nothing (R49).
    */
    requirementsConfigured: boolean('requirements_configured').notNull().default(false),
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

/**
 * The competencies a SCOPE names — its required set and its never-enforced
 * recommended set — at any of the four scopes: Organisation, Location,
 * Department, Role (R1, KTD1). Renamed from `role_required_competencies` when
 * `role_id` stopped being the only scope. This is the STORED requirement; the
 * tool link stays derived (via each assessment's awarded competency), which is
 * what makes a licence-type requirement — a competency no assessment awards —
 * expressible at every scope (AE6).
 *
 * ONE TABLE, not four, because a person's obligation is the UNION over the
 * scopes their placement expands to (R2), and a union over four tables is the
 * same read four times. AT MOST ONE of the three scope columns is non-null
 * (the CHECK below); ALL THREE NULL **is** the org scope — never a fifth kind
 * of row, and never a sentinel id (KTD1).
 *
 * A REAL JOIN TABLE, not jsonb, for the same reason it always was: a
 * requirement is the blast radius a requirement-change preview has to count,
 * so rows must be queryable by scope and by competency. One row per (scope,
 * competencyId) — the tier is a COLUMN and a tier change is an UPDATE within
 * its scope, so required and recommended can never disagree about one link.
 *
 * The competency FK CASCADES on delete. The DELETE route's dependency check
 * (the prior round's KTD8) 409s while any row here depends on it — now at ALL
 * FOUR scopes — so the cascade is unreachable while depended-on and exists
 * only to keep an orphaned link from surviving a forced cleanup.
 */
export const competencyRequirements = pgTable(
  'competency_requirements',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /*
      FK postures follow the taxonomy (KTD1): the Role keeps `cascade` as
      shipped (a deleted Role takes its own requirements with it), while
      Locations and Departments are retire-not-delete values, so `restrict` —
      the same posture their placement rows take above.
    */
    roleId: uuid('role_id').references(() => jobRoles.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'restrict' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'restrict' }),
    competencyId: uuid('competency_id')
      .notNull()
      .references(() => competencies.id, { onDelete: 'cascade' }),
    /** `required` or `recommended` — see `requirementTierEnum` for what each tier may do. */
    tier: requirementTierEnum().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // KTD1: a row belongs to exactly one scope. Two scope columns set is not
    // a richer requirement, it is a corrupt one — the union would double it.
    check(
      'competency_requirements_one_scope_ck',
      sql`num_nonnulls(${t.roleId}, ${t.locationId}, ${t.departmentId}) <= 1`,
    ),
    /*
      Uniqueness is PER SCOPE, via four PARTIAL indexes (KTD1). Postgres treats
      NULLs as distinct, so one composite unique over the scope columns would
      quietly permit duplicates at every scope — partial indexes are the only
      honest uniqueness here. Cross-scope duplicates are deliberately LEGAL
      (KTD2): the same competency may be required org-wide AND on a role; the
      resolution union dedupes, and every write stays scope-local. A scope
      names a competency once; promoting recommended → required is an UPDATE
      of `tier` on that row, never a second row.
    */
    uniqueIndex('competency_requirements_role_uq')
      .on(t.roleId, t.competencyId)
      .where(sql`${t.roleId} IS NOT NULL`),
    uniqueIndex('competency_requirements_location_uq')
      .on(t.locationId, t.competencyId)
      .where(sql`${t.locationId} IS NOT NULL`),
    uniqueIndex('competency_requirements_department_uq')
      .on(t.departmentId, t.competencyId)
      .where(sql`${t.departmentId} IS NOT NULL`),
    // Org scope has no scope id of its own, so the org fk anchors uniqueness.
    uniqueIndex('competency_requirements_org_uq')
      .on(t.orgId, t.competencyId)
      .where(
        sql`${t.roleId} IS NULL AND ${t.locationId} IS NULL AND ${t.departmentId} IS NULL`,
      ),
    index('competency_requirements_org_idx').on(t.orgId),
    index('competency_requirements_role_idx').on(t.roleId),
    index('competency_requirements_location_idx').on(t.locationId),
    index('competency_requirements_department_idx').on(t.departmentId),
    index('competency_requirements_competency_idx').on(t.competencyId),
  ],
);

export const competencyRequirementsRelations = relations(competencyRequirements, ({ one }) => ({
  org: one(organizations, {
    fields: [competencyRequirements.orgId],
    references: [organizations.id],
  }),
  role: one(jobRoles, {
    fields: [competencyRequirements.roleId],
    references: [jobRoles.id],
  }),
  location: one(locations, {
    fields: [competencyRequirements.locationId],
    references: [locations.id],
  }),
  department: one(departments, {
    fields: [competencyRequirements.departmentId],
    references: [departments.id],
  }),
  competency: one(competencies, {
    fields: [competencyRequirements.competencyId],
    references: [competencies.id],
  }),
}));

export const locationsRelations = relations(locations, ({ one }) => ({
  org: one(organizations, { fields: [locations.orgId], references: [organizations.id] }),
}));

export const departmentsRelations = relations(departments, ({ one, many }) => ({
  org: one(organizations, { fields: [departments.orgId], references: [organizations.id] }),
  roles: many(jobRoles),
}));

export const jobRolesRelations = relations(jobRoles, ({ one, many }) => ({
  org: one(organizations, { fields: [jobRoles.orgId], references: [organizations.id] }),
  department: one(departments, {
    fields: [jobRoles.departmentId],
    references: [departments.id],
  }),
  holders: many(membershipRoles),
}));

/**
 * Where a person is placed — the Locations, Departments and Roles on their
 * membership of one organisation (R21). Each axis is its own join table so a
 * person may hold several of the first two (R24). Every row carries a
 * `position` assigned on insert, which is what R60 reads when both case-Location
 * tie-breaks are exhausted ("the first Location on the membership"); it is
 * stored rather than derived because insertion order is not a stable read in
 * Postgres.
 *
 * The value side is `restrict`: a taxonomy value carrying placements is not
 * deletable (retirement, not deletion, is how it is withdrawn). The membership
 * side is `cascade`: deleting a membership removes its placements.
 */
export const membershipLocations = pgTable(
  'membership_locations',
  {
    id: uuid().primaryKey().defaultRandom(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    /** Order on the membership; R60 reads the first. */
    position: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('membership_locations_uq').on(t.membershipId, t.locationId),
    index('membership_locations_membership_idx').on(t.membershipId),
    index('membership_locations_location_idx').on(t.locationId),
  ],
);

export const membershipDepartments = pgTable(
  'membership_departments',
  {
    id: uuid().primaryKey().defaultRandom(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    position: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('membership_departments_uq').on(t.membershipId, t.departmentId),
    index('membership_departments_membership_idx').on(t.membershipId),
    index('membership_departments_department_idx').on(t.departmentId),
  ],
);

/**
 * A Role a person holds. `withdrawnAt` (KTD7) is the whole of how a Role stops
 * being held (R52): it stays on the record, marked, and stops counting. Every
 * read of "the Roles this person holds" filters `withdrawnAt IS NULL`, mirroring
 * the `revokedAt IS NULL` discipline the competency register already keeps. The
 * column lands here, where the table is created, so that discipline holds from
 * the first read (U11 onward) rather than being retrofitted when U17 adds the
 * withdrawal triggers.
 */
export const membershipRoles = pgTable(
  'membership_roles',
  {
    id: uuid().primaryKey().defaultRandom(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => jobRoles.id, { onDelete: 'restrict' }),
    position: integer().notNull().default(0),
    /** Non-null once withdrawn (R52). A held Role has this null. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // A person holds a Role once; reinstating flips `withdrawnAt` back to null
    // on the same row rather than inserting a second.
    uniqueIndex('membership_roles_uq').on(t.membershipId, t.roleId),
    index('membership_roles_membership_idx').on(t.membershipId),
    index('membership_roles_role_idx').on(t.roleId),
  ],
);

export const membershipLocationsRelations = relations(membershipLocations, ({ one }) => ({
  membership: one(memberships, {
    fields: [membershipLocations.membershipId],
    references: [memberships.id],
  }),
  location: one(locations, {
    fields: [membershipLocations.locationId],
    references: [locations.id],
  }),
}));

export const membershipDepartmentsRelations = relations(membershipDepartments, ({ one }) => ({
  membership: one(memberships, {
    fields: [membershipDepartments.membershipId],
    references: [memberships.id],
  }),
  department: one(departments, {
    fields: [membershipDepartments.departmentId],
    references: [departments.id],
  }),
}));

export const membershipRolesRelations = relations(membershipRoles, ({ one }) => ({
  membership: one(memberships, {
    fields: [membershipRoles.membershipId],
    references: [memberships.id],
  }),
  role: one(jobRoles, {
    fields: [membershipRoles.roleId],
    references: [jobRoles.id],
  }),
}));
