import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import {
  assignmentCaseValues,
  insertPlannedCases,
  planAssignmentsForMemberships,
  type MembershipPlan,
} from '../lib/assignment.js';
import { requiredToolIdsByMembership, runSnapshotted } from '../lib/requirement-links.js';
import {
  computeRequiredAssessmentsChange,
  requirementScopeWhere,
  type RequirementScopeRef,
} from '../lib/requirement-change.js';
import { withdrawRoleFromAllHolders } from '../lib/membership-placement.js';
import { isSerializationFailure, isUniqueViolation } from '../lib/db-errors.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;
/** The root client OR an open transaction — what a read-only helper accepts. */
type Reader = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The organisation's taxonomy — Locations, Departments and the Roles each
 * Department offers — plus the three organisation settings that govern how far
 * a person may be spread across them.
 *
 * Gated at Business and above on the same `assessments` feature the taxonomy
 * drives (R13, R14): below it an organisation holds no candidate seats and no
 * assessments, so a taxonomy would have nothing to configure. Managing any of
 * it requires the Admin access level (R12); Owner holds everything Admin holds.
 *
 * Retiring is a status change, never a delete (R114, R16). There is no delete
 * route for a value that is in use. Returning a retired value to active is the
 * same PATCH in reverse (R122). A rename reaches every record pointing at the
 * value with no further work, because records hold the id, not the name (R136).
 */
export const taxonomyRouter: Router = Router();

/** Early-return helper: writes the response and returns void, so a handler
 * typed Promise<void> can end a branch in one line. */
function reply(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

/** R12: taxonomy management is an Admin act. Owner ⊇ Admin. */
function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

const TAXONOMY_GATE = [requireTenant, requirePlanFeature('assessments')] as const;

/** Case-insensitive active-name clash within a scope. Null id skips self on rename. */
async function activeNameTaken(
  table: typeof schema.locations | typeof schema.departments,
  scope: { column: 'orgId'; value: string },
  name: string,
  exceptId: string | null,
): Promise<boolean> {
  if (!db) return false;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table[scope.column], scope.value),
        eq(table.status, 'active'),
        sql`lower(${table.name}) = lower(${name})`,
      ),
    );
  return rows.some((r) => r.id !== exceptId);
}

// ── the whole taxonomy in one read, for the settings screen ──────────────────

taxonomyRouter.get(
  '/',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const [locations, departments, roles, org] = await Promise.all([
      db.query.locations.findMany({
        where: eq(schema.locations.orgId, tenant.orgId),
        orderBy: [asc(schema.locations.name)],
      }),
      db.query.departments.findMany({
        where: eq(schema.departments.orgId, tenant.orgId),
        orderBy: [asc(schema.departments.name)],
      }),
      db.query.jobRoles.findMany({
        where: eq(schema.jobRoles.orgId, tenant.orgId),
        orderBy: [asc(schema.jobRoles.name)],
      }),
      db.query.organizations.findFirst({ where: eq(schema.organizations.id, tenant.orgId) }),
    ]);
    res.json({
      locations: locations.map(locationDto),
      departments: departments.map((d) => ({
        ...departmentDto(d),
        roles: roles.filter((r) => r.departmentId === d.id).map(roleDto),
      })),
      settings: {
        allowMultipleLocations: org?.allowMultipleLocations ?? false,
        allowMultipleDepartments: org?.allowMultipleDepartments ?? false,
        allowSelfAssessment: org?.allowSelfAssessment ?? false,
        displayIdentifier: org?.displayIdentifier ?? 'employee_number',
        pooledCaseOverdueDays: org?.pooledCaseOverdueDays ?? 14,
        notificationLeadDays: org?.notificationLeadDays ?? 30,
        dateFormat: org?.dateFormat ?? 'dmy',
        candidateSelfStartRecommended: org?.candidateSelfStartRecommended ?? false,
      },
    });
  }),
);

// ── Locations ────────────────────────────────────────────────────────────────

const nameBody = z.object({ name: z.string().trim().min(1).max(120) });
const statusOrNameBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'retired']).optional(),
});

taxonomyRouter.post(
  '/locations',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = nameBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    if (await activeNameTaken(schema.locations, { column: 'orgId', value: tenant.orgId }, parsed.data.name, null))
      return reply(res, 409, { error: 'duplicate_name' });
    const [row] = await db
      .insert(schema.locations)
      .values({ orgId: tenant.orgId, name: parsed.data.name })
      .returning();
    if (!row) throw new Error('location_create_failed');
    await recordAudit(db, tenant, {
      action: 'Created location',
      target: row.name,
      category: 'settings',
      icon: 'map-pin',
    });
    res.status(201).json(locationDto(row));
  }),
);

taxonomyRouter.patch(
  '/locations/:id',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = statusOrNameBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const existing = await db.query.locations.findFirst({
      where: and(eq(schema.locations.id, req.params.id!), eq(schema.locations.orgId, tenant.orgId)),
    });
    if (!existing) return reply(res, 404, { error: 'not_found' });
    if (
      parsed.data.name &&
      (await activeNameTaken(
        schema.locations,
        { column: 'orgId', value: tenant.orgId },
        parsed.data.name,
        existing.id,
      ))
    )
      return reply(res, 409, { error: 'duplicate_name' });
    const [row] = await db
      .update(schema.locations)
      .set({
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
      })
      .where(eq(schema.locations.id, existing.id))
      .returning();
    await recordAudit(db, tenant, {
      action: parsed.data.status ? `Set location ${parsed.data.status}` : 'Renamed location',
      target: row?.name ?? existing.name,
      category: 'settings',
      icon: 'map-pin',
    });
    /*
      KTD8/U5: a STATUS FLIP is a requirement-affecting write under the
      four-scope resolver — retiring drops this Location's requirements from
      everyone placed here ("stops applying", the U4 split), and returning it
      to active restores them. Retirement must not be the one write that
      changes required sets with no re-plan (R6's spirit), so every placed
      active member re-plans after the flip in EITHER direction: the
      retire-side run is a harmless no-op today (removal never cancels a
      case, R55), and the reactivate-side run is what plans the restored
      requirements' cases. A rename re-plans nothing.
    */
    if (parsed.data.status && parsed.data.status !== existing.status) {
      await replanPlacedActiveMemberships(db, tenant.orgId, 'location', existing.id);
    }
    res.json(locationDto(row ?? existing));
  }),
);

// ── Departments ──────────────────────────────────────────────────────────────

const createDepartmentBody = z.object({
  name: z.string().trim().min(1).max(120),
  allowsMultipleRoles: z.boolean().optional(),
});
const patchDepartmentBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  allowsMultipleRoles: z.boolean().optional(),
  status: z.enum(['active', 'retired']).optional(),
});

taxonomyRouter.post(
  '/departments',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = createDepartmentBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    if (await activeNameTaken(schema.departments, { column: 'orgId', value: tenant.orgId }, parsed.data.name, null))
      return reply(res, 409, { error: 'duplicate_name' });
    const [row] = await db
      .insert(schema.departments)
      .values({
        orgId: tenant.orgId,
        name: parsed.data.name,
        allowsMultipleRoles: parsed.data.allowsMultipleRoles ?? false,
      })
      .returning();
    if (!row) throw new Error('department_create_failed');
    await recordAudit(db, tenant, {
      action: 'Created department',
      target: row.name,
      category: 'settings',
      icon: 'layers',
    });
    res.status(201).json(departmentDto(row));
  }),
);

taxonomyRouter.patch(
  '/departments/:id',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = patchDepartmentBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const existing = await db.query.departments.findFirst({
      where: and(eq(schema.departments.id, req.params.id!), eq(schema.departments.orgId, tenant.orgId)),
    });
    if (!existing) return reply(res, 404, { error: 'not_found' });
    if (
      parsed.data.name &&
      (await activeNameTaken(
        schema.departments,
        { column: 'orgId', value: tenant.orgId },
        parsed.data.name,
        existing.id,
      ))
    )
      return reply(res, 409, { error: 'duplicate_name' });
    const [row] = await db
      .update(schema.departments)
      .set({
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.allowsMultipleRoles !== undefined
          ? { allowsMultipleRoles: parsed.data.allowsMultipleRoles }
          : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
      })
      .where(eq(schema.departments.id, existing.id))
      .returning();
    await recordAudit(db, tenant, {
      action: parsed.data.status ? `Set department ${parsed.data.status}` : 'Updated department',
      target: row?.name ?? existing.name,
      category: 'settings',
      icon: 'layers',
    });
    // KTD8/U5: same posture as the location flip above — a status change moves
    // this Department's requirements in or out of every placed member's union,
    // so each re-plans (fail-soft); a rename or count-rule change re-plans
    // nothing.
    if (parsed.data.status && parsed.data.status !== existing.status) {
      await replanPlacedActiveMemberships(db, tenant.orgId, 'department', existing.id);
    }
    res.json(departmentDto(row ?? existing));
  }),
);

// ── Department tightening (U17 — R110, R111, R112, R113) ──────────────────────

/** The active roles of a Department, plus which memberships hold each — the shape both tightening routes read. */
async function loadDepartmentForTightening(
  database: Database,
  orgId: string,
  departmentId: string,
): Promise<{ department: typeof schema.departments.$inferSelect; roleIds: string[]; roleById: Map<string, typeof schema.jobRoles.$inferSelect> } | null> {
  const department = await database.query.departments.findFirst({
    where: and(eq(schema.departments.id, departmentId), eq(schema.departments.orgId, orgId)),
  });
  if (!department) return null;
  // Every Role the Department carries, ANY status — a retired-but-held Role still
  // counts toward the held total the one-or-several rule governs (R119), so a
  // person over the count because of one is still surfaced and still chooses.
  const roles = await database.query.jobRoles.findMany({
    where: and(
      eq(schema.jobRoles.orgId, orgId),
      eq(schema.jobRoles.departmentId, departmentId),
    ),
  });
  return {
    department,
    roleIds: roles.map((r) => r.id),
    roleById: new Map(roles.map((r) => [r.id, r])),
  };
}

/**
 * The people a tightening still has to resolve (U17, R112) — a LIVE query, no
 * stored queue: every membership placed in this Department that still holds MORE
 * THAN ONE of its Roles (`withdrawnAt IS NULL`). Because "affected" is derived
 * from the held rows, the list is correct after any interruption and the whole
 * remediation is resumable for free (R110, R111). Scoped to this Department's
 * Roles, so a person's Roles in other Departments never enter the count (R6).
 */
taxonomyRouter.get(
  '/departments/:id/tightening-review',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const loaded = await loadDepartmentForTightening(db, tenant.orgId, req.params.id!);
    if (!loaded) return reply(res, 404, { error: 'not_found' });
    if (loaded.roleIds.length === 0) return reply(res, 200, []);

    const held = await db.query.membershipRoles.findMany({
      where: and(
        inArray(schema.membershipRoles.roleId, loaded.roleIds),
        isNull(schema.membershipRoles.withdrawnAt),
      ),
    });
    // Group held D-Roles per membership; only those over the one-Role count.
    const rolesByMembership = new Map<string, string[]>();
    for (const row of held) {
      const list = rolesByMembership.get(row.membershipId) ?? [];
      list.push(row.roleId);
      rolesByMembership.set(row.membershipId, list);
    }
    const affected = [...rolesByMembership.entries()].filter(([, roleIds]) => roleIds.length > 1);
    if (affected.length === 0) return reply(res, 200, []);

    // ACTIVE memberships of THIS org only — the same scope every sibling review
    // applies (R128). A deactivated person keeps their held Roles (deactivation
    // withdraws none), so without the status filter they would surface here as
    // still to resolve, which is remediation the review is meant to exclude. The
    // org term is defence-in-depth; scope is already transitive via the roleIds.
    const memberships = await db.query.memberships.findMany({
      where: and(
        eq(schema.memberships.orgId, tenant.orgId),
        inArray(schema.memberships.id, affected.map(([membershipId]) => membershipId)),
        eq(schema.memberships.status, 'active'),
      ),
    });
    const userIdByMembership = new Map(memberships.map((m) => [m.id, m.userId]));
    const activeMembershipIds = new Set(memberships.map((m) => m.id));
    const users = await db.query.users.findMany({
      where: inArray(schema.users.id, memberships.map((m) => m.userId)),
    });
    const nameByUser = new Map(users.map((u) => [u.id, u.name]));

    res.json(
      affected
        // Drop anyone no longer active — they are not in the review (R128).
        .filter(([membershipId]) => activeMembershipIds.has(membershipId))
        .map(([membershipId, roleIds]) => {
          const userId = userIdByMembership.get(membershipId)!;
          return {
            membershipId,
            userId,
            name: nameByUser.get(userId) ?? 'Unknown user',
            // The Roles to choose ONE of — this Department's, in a stable order.
            heldRoles: roleIds
              .map((roleId) => loaded.roleById.get(roleId))
              .filter((r): r is typeof schema.jobRoles.$inferSelect => Boolean(r))
              .map((r) => ({ id: r.id, name: r.name })),
          };
        }),
    );
  }),
);

const tighteningResolveBody = z.object({
  membershipId: z.string().uuid(),
  survivingRoleId: z.string().uuid(),
});

/**
 * Apply one person's tightening choice (U17, R112, R113): keep the Role the Admin
 * chose and withdraw every OTHER Role this person holds OF THIS DEPARTMENT. Only
 * this Department's Roles are touched (R6) — a Role in another Department is left
 * alone. The unchosen Roles are withdrawn, not deleted (R113), so they stay on
 * the record marked withdrawn and a competency one alone required demotes to
 * optional through the derivation. No case is touched (R135). Idempotent and
 * safe under two Admins racing: the surviving Role is re-checked as still held,
 * and only `withdrawnAt IS NULL` rows are written.
 */
taxonomyRouter.post(
  '/departments/:id/tightening/resolve',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = tighteningResolveBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const loaded = await loadDepartmentForTightening(db, tenant.orgId, req.params.id!);
    if (!loaded) return reply(res, 404, { error: 'not_found' });

    const { membershipId, survivingRoleId } = parsed.data;
    // The chosen Role must belong to this Department and be one this person still
    // holds — refusing a stale or cross-Department choice, and never withdrawing
    // the last Role out from under a concurrent resolve.
    if (!loaded.roleById.has(survivingRoleId))
      return reply(res, 400, { error: 'role_not_in_department' });
    // The target must be an ACTIVE member of this org — the same scope the review
    // applies (R128), so a deactivated or cross-org membershipId cannot be resolved.
    const membership = await db.query.memberships.findFirst({
      where: and(
        eq(schema.memberships.id, membershipId),
        eq(schema.memberships.orgId, tenant.orgId),
        eq(schema.memberships.status, 'active'),
      ),
    });
    if (!membership) return reply(res, 404, { error: 'not_found' });
    const surviving = await db.query.membershipRoles.findFirst({
      where: and(
        eq(schema.membershipRoles.membershipId, membershipId),
        eq(schema.membershipRoles.roleId, survivingRoleId),
        isNull(schema.membershipRoles.withdrawnAt),
      ),
    });
    if (!surviving) return reply(res, 409, { error: 'role_not_held' });

    const toWithdraw = loaded.roleIds.filter((roleId) => roleId !== survivingRoleId);
    if (toWithdraw.length > 0) {
      await db
        .update(schema.membershipRoles)
        .set({ withdrawnAt: new Date() })
        .where(
          and(
            eq(schema.membershipRoles.membershipId, membershipId),
            isNull(schema.membershipRoles.withdrawnAt),
            inArray(schema.membershipRoles.roleId, toWithdraw),
          ),
        );
    }
    await recordAudit(db, tenant, {
      action: 'Resolved role tightening',
      target: loaded.roleById.get(survivingRoleId)?.name ?? survivingRoleId,
      category: 'settings',
      icon: 'briefcase',
    });
    res.json({ ok: true, membershipId, survivingRoleId });
  }),
);

// ── Roles (created WITHIN a Department — KTD2) ────────────────────────────────

taxonomyRouter.post(
  '/departments/:departmentId/roles',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = nameBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const department = await db.query.departments.findFirst({
      where: and(
        eq(schema.departments.id, req.params.departmentId!),
        eq(schema.departments.orgId, tenant.orgId),
      ),
    });
    if (!department) return reply(res, 404, { error: 'department_not_found' });
    // Uniqueness is per DEPARTMENT (R5): two Departments may each offer a Role
    // of the same name. Check active clashes within this Department only.
    if (db) {
      const clash = await db
        .select({ id: schema.jobRoles.id })
        .from(schema.jobRoles)
        .where(
          and(
            eq(schema.jobRoles.departmentId, department.id),
            eq(schema.jobRoles.status, 'active'),
            sql`lower(${schema.jobRoles.name}) = lower(${parsed.data.name})`,
          ),
        );
      if (clash.length) return reply(res, 409, { error: 'duplicate_name' });
    }
    const [row] = await db
      .insert(schema.jobRoles)
      .values({ orgId: tenant.orgId, departmentId: department.id, name: parsed.data.name })
      .returning();
    if (!row) throw new Error('role_create_failed');
    await recordAudit(db, tenant, {
      action: 'Created role',
      target: `${department.name} / ${row.name}`,
      category: 'settings',
      icon: 'briefcase',
    });
    res.status(201).json(roleDto(row));
  }),
);

taxonomyRouter.patch(
  '/roles/:id',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = statusOrNameBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const existing = await db.query.jobRoles.findFirst({
      where: and(eq(schema.jobRoles.id, req.params.id!), eq(schema.jobRoles.orgId, tenant.orgId)),
    });
    if (!existing) return reply(res, 404, { error: 'not_found' });
    if (parsed.data.name) {
      const clash = await db
        .select({ id: schema.jobRoles.id })
        .from(schema.jobRoles)
        .where(
          and(
            eq(schema.jobRoles.departmentId, existing.departmentId),
            eq(schema.jobRoles.status, 'active'),
            sql`lower(${schema.jobRoles.name}) = lower(${parsed.data.name})`,
          ),
        );
      if (clash.some((r) => r.id !== existing.id))
        return reply(res, 409, { error: 'duplicate_name' });
    }
    const [row] = await db
      .update(schema.jobRoles)
      .set({
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
      })
      .where(eq(schema.jobRoles.id, existing.id))
      .returning();
    await recordAudit(db, tenant, {
      action: parsed.data.status ? `Set role ${parsed.data.status}` : 'Renamed role',
      target: row?.name ?? existing.name,
      category: 'settings',
      icon: 'briefcase',
    });
    res.json(roleDto(row ?? existing));
  }),
);

/**
 * Stop offering a Role (U17, R52) — the Department drops it from its offer.
 *
 * This is a DIFFERENT act from retiring (`PATCH /roles/:id status=retired`, R119),
 * which leaves every holder still holding it. Stopping the offer means the Role
 * is no longer available to anyone in the Department, so there is nothing to put
 * to an Admin: in one transaction it retires the Role (so it can no longer be
 * newly placed) AND withdraws it from every current holder. It touches no
 * assessment case — a case in flight for its requirement runs to completion
 * (R54). A competency the Role alone required demotes to optional through the
 * standing derivation on the next read (R109), with nothing written or revoked.
 * Reversal is `PATCH /roles/:id status=active` (resume the offer), which returns
 * the Role to nobody it was withdrawn from (R53).
 */
taxonomyRouter.post(
  '/roles/:id/stop-offering',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const role = await db.query.jobRoles.findFirst({
      where: and(eq(schema.jobRoles.id, req.params.id!), eq(schema.jobRoles.orgId, tenant.orgId)),
    });
    if (!role) return reply(res, 404, { error: 'not_found' });

    const now = new Date();
    const [row] = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.jobRoles)
        .set({ status: 'retired' })
        .where(eq(schema.jobRoles.id, role.id))
        .returning();
      // Every current holder loses it, on that ground alone (R52). Cases in
      // flight are left to run (R54) — this writes no assessment case.
      await withdrawRoleFromAllHolders(tx, role.id, now);
      return updated;
    });
    await recordAudit(db, tenant, {
      action: 'Stopped offering role',
      target: row?.name ?? role.name,
      category: 'settings',
      icon: 'briefcase',
    });
    res.json(roleDto(row ?? { ...role, status: 'retired' }));
  }),
);

// ── A SCOPE's requirements, in COMPETENCY terms (U10/U12, reworked by U3 of
//    the role-competency links round; scope-addressed by U4 of the requirement
//    inheritance round — R1, R6, KTD5–KTD7, plus the shipped R5, R50, R121,
//    KTD9 posture at role scope) ────────────────────────────────────────────

/*
  TWO ADDRESSES, ONE CONTRACT (KTD6). The scope routes are the real interface:
  `GET/PUT /taxonomy/requirements/org` and
  `GET/PUT /taxonomy/requirements/:scope/:scopeId` (+ `/preview` POSTs, + the
  role-only legacy DELETE) — same body/response shapes at every scope, with
  `configured` and `awaitingLink` appearing at role scope only, because only
  roles carry the R50 flag and the legacy derivation. The shipped
  `/roles/:id/required-assessments` paths remain as THIN DELEGATES onto the
  same handlers: the web store, its tests and the deployed client all address
  them, and renaming would force the web rework to land in the same deploy or
  404 (the prior round's KTD9 path-keeping posture).
*/

const requirementTierShapes = {
  required: z.array(z.string().uuid()),
  recommended: z.array(z.string().uuid()),
};
const requirementsPutBody = z.object({
  ...requirementTierShapes,
  /** The GET's fingerprint, echoed back — the KTD9 stale-edit guard. */
  fingerprint: z.string().min(1),
});
const requirementsPreviewBody = z.object({
  ...requirementTierShapes,
  /** Legacy rows the caller would ALSO remove — the awaitingLink exit (KTD9). */
  removeLegacyToolIds: z.array(z.string().uuid()).optional(),
});
const legacyRemoveBody = z.object({ fingerprint: z.string().min(1) });

/**
 * The KTD9 stale-echo signal, THROWN from inside the apply transaction.
 *
 * The guard has to run on the same connection and snapshot as the write it
 * protects, which means it cannot simply `return` a 409 — the only way out of
 * a transaction callback without committing is to throw. This carries the
 * refusal back to the handler, which maps it to the unchanged 409 body; every
 * other error keeps propagating to the error middleware as a 500.
 */
class RequirementsChangedError extends Error {
  constructor() {
    super('requirements_changed');
    this.name = 'RequirementsChangedError';
  }
}

/**
 * The scope retired UNDER the write, thrown from inside the apply transaction
 * for the same reason `RequirementsChangedError` is (the only way out of a
 * transaction callback without committing).
 *
 * `loadRequirementScope`'s retired check runs on the root client BEFORE the
 * transaction opens, which makes it a check-then-act across two connections: a
 * retirement committing in the gap let the save through, writing requirements
 * onto a scope the resolver had just stopped consulting — a silent no-op the
 * admin was told had succeeded. Re-checked inside the transaction, behind the
 * advisory lock, the refusal is real. The CODE travels with it so the 409 body
 * stays exactly what the pre-transaction check would have sent (`role_retired`
 * for deployed clients, `scope_retired` elsewhere).
 */
class ScopeRetiredError extends Error {
  constructor(readonly code: 'scope_retired' | 'role_retired') {
    super(code);
    this.name = 'ScopeRetiredError';
  }
}

/**
 * SERIALISE WRITERS OF ONE SCOPE (review-verified P1). The fingerprint guard is
 * a lost-update guard, and inside a REPEATABLE READ transaction it protects
 * nothing against a same-scope concurrent save: both admins' snapshots predate
 * each other's commit, so both read the SAME pre-change rows, both compute the
 * same fingerprint, and both pass. On a scope with existing rows the replace
 * writes then collide on the partial unique index (a 23505, mapped below); on
 * an EMPTY scope nothing collides at all — both deletes match nothing, both
 * inserts succeed, and the scope ends up holding the UNION of two lists while
 * each admin is told their exact list was saved. Nobody is warned, and the
 * extra requirements silently book cases.
 *
 * A transaction-scoped advisory lock, taken as the FIRST statement, converts
 * that into the intended sequence: the second writer blocks until the first
 * commits, then reads the CHANGED rows, fails the fingerprint check, and gets
 * the 409 it should always have got. Scope-keyed (org + kind + id), so it
 * serialises only writers of the same list — KTD7's cross-scope commutation is
 * untouched, and an org-scope save never blocks a role editor.
 *
 * `pg_advisory_xact_lock` releases on commit OR rollback with no unlock call to
 * forget, which is what makes it safe to take inside a transaction that can
 * throw its way out (both sentinels above do exactly that).
 */
function requirementLockKey(orgId: string, ref: RequirementScopeRef): string {
  return `${orgId}:${ref.kind}:${ref.kind === 'org' ? '' : ref.id}`;
}

/**
 * The two things every requirement WRITE must do before it reads anything:
 * take the scope's advisory lock, then re-check that the scope is still
 * writable on THIS snapshot. Shared by the PUT and the legacy DELETE so the
 * two cannot drift on either guarantee.
 */
async function lockAndVerifyScope(
  tx: Reader,
  orgId: string,
  ref: RequirementScopeRef,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requirementLockKey(orgId, ref)}))`);
  switch (ref.kind) {
    // The organisation cannot retire — there is nothing to re-check.
    case 'org':
      return;
    case 'location': {
      const row = await tx.query.locations.findFirst({
        where: and(eq(schema.locations.id, ref.id), eq(schema.locations.orgId, orgId)),
      });
      if (row && row.status !== 'active') throw new ScopeRetiredError('scope_retired');
      return;
    }
    case 'department': {
      const row = await tx.query.departments.findFirst({
        where: and(eq(schema.departments.id, ref.id), eq(schema.departments.orgId, orgId)),
      });
      if (row && row.status !== 'active') throw new ScopeRetiredError('scope_retired');
      return;
    }
    case 'role': {
      const row = await tx.query.jobRoles.findFirst({
        where: and(eq(schema.jobRoles.id, ref.id), eq(schema.jobRoles.orgId, orgId)),
      });
      if (row && row.status !== 'active') throw new ScopeRetiredError('role_retired');
      return;
    }
  }
}

/**
 * Map an apply transaction's failure to its response, or re-throw.
 *
 * Both sentinels above are deliberate refusals. The two SQLSTATEs are belt and
 * braces behind the advisory lock: 40001 (serialization failure) is what a
 * repeatable-read transaction raises when a concurrent commit invalidated its
 * snapshot, and 23505 is the partial unique index catching a same-scope
 * duplicate the lock should already have prevented. Both mean exactly what the
 * fingerprint means — "the world moved under you, re-read and decide again" —
 * so both get the SAME 409 rather than a 500 the editor cannot act on. They
 * are mapped and not merely tolerated because a 500 here would tell an admin
 * their save broke the server when it simply lost a race.
 */
function requirementWriteFailure(
  err: unknown,
): { status: 409; body: { error: string } } | null {
  if (err instanceof RequirementsChangedError) return { status: 409, body: { error: 'requirements_changed' } };
  if (err instanceof ScopeRetiredError) return { status: 409, body: { error: err.code } };
  if (isSerializationFailure(err) || isUniqueViolation(err))
    return { status: 409, body: { error: 'requirements_changed' } };
  return null;
}

/**
 * The fingerprint the GET serves and the PUT/DELETE echo (KTD9): a
 * deterministic hash over the Role's direct links (both tiers) AND its
 * remaining legacy rows. Any conversion, edit or legacy-row removal landing
 * between an editor's GET and PUT changes it, so the stale write 409s instead
 * of silently erasing the other change with its replace-write.
 */
function requirementsFingerprint(
  links: readonly { competencyId: string; tier: string }[],
  legacyToolIds: readonly string[],
): string {
  const required = links.filter((l) => l.tier === 'required').map((l) => l.competencyId).sort();
  const recommended = links
    .filter((l) => l.tier === 'recommended')
    .map((l) => l.competencyId)
    .sort();
  const legacy = [...legacyToolIds].sort();
  return createHash('sha1')
    .update(JSON.stringify({ required, recommended, legacy }))
    .digest('hex');
}

/**
 * A scope's stored requirement state — links, legacy rows, fingerprint. The
 * state is SCOPE-LOCAL (KTD7): only this scope's own rows are read and hashed
 * (plus its legacy tool rows at role scope — the only scope that ever had
 * them), so an org-level save does not invalidate an open role editor, and
 * concurrent edits at different scopes commute on the requirement rows.
 *
 * Takes a `Reader` because the PUT re-runs it INSIDE its apply transaction:
 * the fingerprint comparison is the KTD9 lost-update guard, and a guard that
 * reads on one connection while the write it protects runs on another is not
 * a guard at all.
 */
async function loadRequirementState(database: Reader, orgId: string, ref: RequirementScopeRef) {
  const links = await database.query.competencyRequirements.findMany({
    where: requirementScopeWhere(orgId, ref),
  });
  const legacyRows =
    ref.kind === 'role'
      ? await database.query.roleRequiredAssessments.findMany({
          where: eq(schema.roleRequiredAssessments.roleId, ref.id),
        })
      : [];
  const legacyToolIds = [...new Set(legacyRows.map((r) => r.toolId))];
  return {
    links,
    legacyToolIds,
    required: links.filter((l) => l.tier === 'required').map((l) => l.competencyId),
    recommended: links.filter((l) => l.tier === 'recommended').map((l) => l.competencyId),
    fingerprint: requirementsFingerprint(links, legacyToolIds),
  };
}

/** The scope path segment → ref, or null for an address that names no scope. */
function scopeRefFromParams(scope: string, scopeId: string): RequirementScopeRef | null {
  if (scope === 'location') return { kind: 'location', id: scopeId };
  if (scope === 'department') return { kind: 'department', id: scopeId };
  if (scope === 'role') return { kind: 'role', id: scopeId };
  return null;
}

/** A scope loaded for a requirement route: its ref, display name, and (role only) its row. */
interface LoadedRequirementScope {
  ref: RequirementScopeRef;
  /** Audit target and copy — the organisation's OWN name at org scope (U4). */
  name: string;
  /** Present at role scope only: the R50 flag and legacy machinery live on it. */
  role?: typeof schema.jobRoles.$inferSelect;
}

/**
 * The guard every requirement route shares, so they cannot drift on who may
 * change a scope's requirements: Admin (R73/R12 — the gate SURVIVES both
 * reworks unchanged), the value is the organisation's, and — for a WRITE —
 * the value is active. Editing at a retired scope 409s: `role_retired` at
 * role scope (the shipped R121 code deployed clients read) and
 * `scope_retired` at location/department scope (the same posture, named for
 * the generalisation). The org scope cannot retire. Reads skip the retired
 * check, as the shipped role GET always did — a retired value's list is
 * still inspectable. Sends the error response and returns null on failure.
 */
async function loadRequirementScope(
  database: Database,
  req: Request,
  res: Response,
  ref: RequirementScopeRef,
  opts: { write: boolean },
): Promise<LoadedRequirementScope | null> {
  const tenant = req.tenant!;
  if (!isAdmin(tenant.role)) {
    reply(res, 403, { error: 'forbidden' });
    return null;
  }
  switch (ref.kind) {
    case 'org': {
      const org = await database.query.organizations.findFirst({
        where: eq(schema.organizations.id, tenant.orgId),
      });
      return { ref, name: org?.name ?? '' };
    }
    case 'location': {
      const row = await database.query.locations.findFirst({
        where: and(eq(schema.locations.id, ref.id), eq(schema.locations.orgId, tenant.orgId)),
      });
      if (!row) {
        reply(res, 404, { error: 'not_found' });
        return null;
      }
      if (opts.write && row.status !== 'active') {
        reply(res, 409, { error: 'scope_retired' });
        return null;
      }
      return { ref, name: row.name };
    }
    case 'department': {
      const row = await database.query.departments.findFirst({
        where: and(eq(schema.departments.id, ref.id), eq(schema.departments.orgId, tenant.orgId)),
      });
      if (!row) {
        reply(res, 404, { error: 'not_found' });
        return null;
      }
      if (opts.write && row.status !== 'active') {
        reply(res, 409, { error: 'scope_retired' });
        return null;
      }
      return { ref, name: row.name };
    }
    case 'role': {
      const role = await database.query.jobRoles.findFirst({
        where: and(eq(schema.jobRoles.id, ref.id), eq(schema.jobRoles.orgId, tenant.orgId)),
      });
      if (!role) {
        reply(res, 404, { error: 'not_found' });
        return null;
      }
      // R121: a retired Role is frozen — a preview an apply would 409 must 409
      // too. The shipped error code, kept for deployed clients.
      if (opts.write && role.status !== 'active') {
        reply(res, 409, { error: 'role_retired' });
        return null;
      }
      return { ref, name: role.name, role };
    }
  }
}

/** Audit copy per scope — the shipped role wording kept verbatim (R11). */
const REQUIREMENTS_AUDIT: Record<
  RequirementScopeRef['kind'],
  { action: string; icon: string }
> = {
  org: { action: 'Set organisation required competencies', icon: 'settings' },
  location: { action: 'Set location required competencies', icon: 'map-pin' },
  department: { action: 'Set department required competencies', icon: 'layers' },
  role: { action: 'Set role required competencies', icon: 'briefcase' },
};

/**
 * Normalise and validate the two tiers: deduplicate each, refuse an overlap
 * (one row per (role, competency) — the tier is a column, so a competency
 * cannot be both, KTD1), and mirror the old tool-ownership check onto
 * competencies. Sends the error response and returns null on failure.
 */
async function normalizeRequirementTiers(
  database: Database,
  res: Response,
  orgId: string,
  body: { required: string[]; recommended: string[] },
): Promise<{ required: string[]; recommended: string[] } | null> {
  const required = [...new Set(body.required)];
  const recommended = [...new Set(body.recommended)];
  const requiredSet = new Set(required);
  if (recommended.some((id) => requiredSet.has(id))) {
    reply(res, 400, { error: 'tiers_overlap' });
    return null;
  }
  const all = [...required, ...recommended];
  if (all.length > 0) {
    const found = await database.query.competencies.findMany({
      where: and(
        eq(schema.competencies.orgId, orgId),
        inArray(schema.competencies.id, all),
      ),
    });
    // Compared by ID, not by count — a duplicate row could mask a missing one.
    const foundIds = new Set(found.map((c) => c.id));
    if (all.some((id) => !foundIds.has(id))) {
      reply(res, 400, { error: 'competency_not_found' });
      return null;
    }
  }
  return { required, recommended };
}

async function handleRequirementsGet(
  req: Request,
  res: Response,
  ref: RequirementScopeRef,
): Promise<void> {
  if (!db) return reply(res, 503, { error: 'db_unavailable' });
  const tenant = req.tenant!;
  const loaded = await loadRequirementScope(db, req, res, ref, { write: false });
  if (!loaded) return;
  const state = await loadRequirementState(db, tenant.orgId, ref);
  if (ref.kind === 'role') {
    // `configured` is the STORED fact (R50), never a row count: a Role emptied
    // of its requirements is still configured and reads differently from one
    // never set up. `awaitingLink` is the legacy rows still deriving the old
    // way (R15) — tools whose award has not been linked yet, listed so the
    // editor can point at the backfill or remove them explicitly (KTD9). Both
    // fields are ROLE-SCOPE ONLY (KTD6/KTD9): the other scopes have no legacy
    // ambiguity, so their row count is unambiguous and carries no flag.
    res.json({
      configured: loaded.role!.requirementsConfigured,
      required: state.required,
      recommended: state.recommended,
      awaitingLink: state.legacyToolIds,
      fingerprint: state.fingerprint,
    });
    return;
  }
  res.json({
    required: state.required,
    recommended: state.recommended,
    fingerprint: state.fingerprint,
  });
}

// Scope-addressed reads (KTD6). `/requirements/org` registers BEFORE the
// parameterised path so the org address never reads as scope='org' missing an
// id; an unknown scope segment is an address that exists for nothing → 404.
taxonomyRouter.get(
  '/requirements/org',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => handleRequirementsGet(req, res, { kind: 'org' })),
);
taxonomyRouter.get(
  '/requirements/:scope/:scopeId',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    const ref = scopeRefFromParams(req.params.scope!, req.params.scopeId!);
    if (!ref) return reply(res, 404, { error: 'not_found' });
    return handleRequirementsGet(req, res, ref);
  }),
);
// The shipped role path — a thin delegate (KTD6).
taxonomyRouter.get(
  '/roles/:id/required-assessments',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) =>
    handleRequirementsGet(req, res, { kind: 'role', id: req.params.id! }),
  ),
);

/**
 * The blast radius of a proposed change, BEFORE it commits (U12, R84–R86; at
 * all four scopes since U4, R6 — an org preview counts every active
 * membership, AE3). Computes the same effects the apply will, and writes
 * nothing — the Admin sees how many people are affected and what the change
 * does, and may abandon it. Takes the PUT body minus the fingerprint (a
 * preview cannot go stale), plus — at role scope only — the optional
 * legacy-row removals so the awaitingLink exit previews through the same door.
 */
async function handleRequirementsPreview(
  req: Request,
  res: Response,
  ref: RequirementScopeRef,
): Promise<void> {
  if (!db) return reply(res, 503, { error: 'db_unavailable' });
  const tenant = req.tenant!;
  const loaded = await loadRequirementScope(db, req, res, ref, { write: true });
  if (!loaded) return;
  const parsed = requirementsPreviewBody.safeParse(req.body);
  if (!parsed.success)
    return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
  // Legacy rows are role-scope machinery only (KTD2/KTD6) — naming them at
  // another scope is a malformed request, not a silently-ignored field.
  if (ref.kind !== 'role' && parsed.data.removeLegacyToolIds !== undefined)
    return reply(res, 400, {
      error: 'invalid_request',
      detail: 'removeLegacyToolIds applies to the role scope only',
    });
  const tiers = await normalizeRequirementTiers(db, res, tenant.orgId, parsed.data);
  if (!tiers) return;
  const { effects } = await computeRequiredAssessmentsChange(
    db,
    tenant.orgId,
    ref,
    {
      requiredCompetencyIds: tiers.required,
      ...(parsed.data.removeLegacyToolIds
        ? { removeLegacyToolIds: parsed.data.removeLegacyToolIds }
        : {}),
    },
    new Date(),
  );
  res.json({ effects });
}

taxonomyRouter.post(
  '/requirements/org/preview',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => handleRequirementsPreview(req, res, { kind: 'org' })),
);
taxonomyRouter.post(
  '/requirements/:scope/:scopeId/preview',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    const ref = scopeRefFromParams(req.params.scope!, req.params.scopeId!);
    if (!ref) return reply(res, 404, { error: 'not_found' });
    return handleRequirementsPreview(req, res, ref);
  }),
);
taxonomyRouter.post(
  '/roles/:id/required-assessments/preview',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) =>
    handleRequirementsPreview(req, res, { kind: 'role', id: req.params.id! }),
  ),
);

/** The scope columns one requirement row carries — exactly one non-null, or none at org scope (KTD1). */
function scopeRowColumns(
  ref: RequirementScopeRef,
): Partial<Pick<typeof schema.competencyRequirements.$inferInsert, 'roleId' | 'locationId' | 'departmentId'>> {
  switch (ref.kind) {
    case 'role':
      return { roleId: ref.id };
    case 'location':
      return { locationId: ref.id };
    case 'department':
      return { departmentId: ref.id };
    case 'org':
      return {};
  }
}

async function handleRequirementsPut(
  req: Request,
  res: Response,
  ref: RequirementScopeRef,
): Promise<void> {
  if (!db) return reply(res, 503, { error: 'db_unavailable' });
  const tenant = req.tenant!;
  const loaded = await loadRequirementScope(db, req, res, ref, { write: true });
  if (!loaded) return;
  const parsed = requirementsPutBody.safeParse(req.body);
  if (!parsed.success)
    return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
  const tiers = await normalizeRequirementTiers(db, res, tenant.orgId, parsed.data);
  if (!tiers) return;

  /*
    Apply atomically, and to the LINKS TABLE ONLY (KTD9): legacy rows leave
    via conversion or the explicit remove below, never as a side effect of a
    requirement save. The full-replace posture carries over from the tool
    era — `compute` derived the additions as a diff against the current
    links, so if the link rows committed but a case insert then failed, a
    retry would see the new rows as current, compute an empty diff, and
    never create the missing case. A transaction makes a partial failure
    roll the replacement back with it. Removing a competency leaves its
    in-flight cases untouched (R55) — nothing here cancels a case. The
    replace is SCOPE-LOCAL (KTD7): only this scope's rows are deleted and
    rewritten, so two admins saving different scopes commute on the
    requirement rows.

    THE TRANSACTION OPENS FIRST, and the KTD9 fingerprint guard runs INSIDE
    it. Read on the root client beforehand, the guard was a check-then-act
    spanning two connections: two admins each holding the same fresh
    fingerprint both passed it and both ran the replace-write, which is
    exactly the lost update the fingerprint exists to prevent. Guard, plan
    and write now share one snapshot — REPEATABLE READ, because under the
    default READ COMMITTED each statement re-reads the newest commit and the
    snapshot would drift back apart between the check and the delete.

    AND THE ADVISORY LOCK COMES BEFORE ALL OF IT (`lockAndVerifyScope`, see
    its comment): repeatable read alone does not make the fingerprint a guard
    against a SAME-SCOPE concurrent save, because both writers' snapshots
    predate each other's commit and both pass the check. The lock is what
    turns the second writer's pass into the 409 it should be. The retired
    re-check rides the same call for the same reason — the pre-transaction one
    is a check-then-act too.
  */
  const now = new Date();
  const role = loaded.role;
  const flipConfigured =
    ref.kind === 'role' && !role!.requirementsConfigured && tiers.required.length > 0;
  const applied = await db
    .transaction(
      async (tx) => {
        await lockAndVerifyScope(tx, tenant.orgId, ref);
        const state = await loadRequirementState(tx, tenant.orgId, ref);
        if (state.fingerprint !== parsed.data.fingerprint) throw new RequirementsChangedError();

        // ONE code path (KTD10): the apply runs the SAME computation the
        // preview did, so `effects.created` is exactly the number of cases
        // it inserts. Its reads are of the PRE-change state, so running it
        // before the write — on this same `tx` — is correct.
        const { effects, casesToInsert } = await computeRequiredAssessmentsChange(
          tx,
          tenant.orgId,
          ref,
          { requiredCompetencyIds: tiers.required },
          now,
        );

        await tx
          .delete(schema.competencyRequirements)
          .where(requirementScopeWhere(tenant.orgId, ref));
        const scopeColumns = scopeRowColumns(ref);
        const rows = [
          ...tiers.required.map((competencyId) => ({
            orgId: tenant.orgId,
            ...scopeColumns,
            competencyId,
            tier: 'required' as const,
          })),
          ...tiers.recommended.map((competencyId) => ({
            orgId: tenant.orgId,
            ...scopeColumns,
            competencyId,
            tier: 'recommended' as const,
          })),
        ];
        if (rows.length > 0) {
          await tx.insert(schema.competencyRequirements).values(rows);
        }
        /*
          `requirementsConfigured` flips only when the REQUIRED tier is
          authored (KTD9), and only at ROLE scope — the flag exists to split
          never-set-up from deliberately-empty under the legacy ambiguity
          (R50/KTD9 of this round), which the other scopes never had. A
          recommended-only save on a never-configured Role leaves it reading
          never-configured, because recommending is not deciding what the
          Role demands.
        */
        if (flipConfigured) {
          await tx
            .update(schema.jobRoles)
            .set({ requirementsConfigured: true })
            .where(eq(schema.jobRoles.id, role!.id));
        }
        // The additions' cases, applied with no per-person action (R82, R83,
        // R87). Exactly the plan `compute` counted, so the rows written equal
        // `effects.created` — preview == apply at every scope (R6).
        for (const c of casesToInsert) {
          await tx
            .insert(schema.assessmentCases)
            .values(assignmentCaseValues(c.orgId, c.candidateUserId, c));
        }
        return { ok: true as const, effects, legacyToolIds: state.legacyToolIds };
      },
      { isolationLevel: 'repeatable read' },
    )
    .catch((err: unknown) => {
      // Stale echo, a scope retired underneath, or a lost race the database
      // itself caught → 409, the editor reloads and re-decides. Everything
      // else is a real failure and keeps going to the error middleware.
      const refusal = requirementWriteFailure(err);
      if (refusal) return { ok: false as const, refusal };
      throw err;
    });
  if (!applied.ok) return reply(res, applied.refusal.status, applied.refusal.body);

  // Every scope PUT audits, with a scope-derived target (U4): the location,
  // department or role name — or the organisation's OWN name at org scope.
  const audit = REQUIREMENTS_AUDIT[ref.kind];
  await recordAudit(db, tenant, {
    action: audit.action,
    target: loaded.name,
    category: 'settings',
    icon: audit.icon,
  });
  // The post-write fingerprint, so the editor can save again without a
  // fresh GET.
  const fingerprint = requirementsFingerprint(
    [
      ...tiers.required.map((competencyId) => ({ competencyId, tier: 'required' })),
      ...tiers.recommended.map((competencyId) => ({ competencyId, tier: 'recommended' })),
    ],
    applied.legacyToolIds,
  );
  if (ref.kind === 'role') {
    // The shipped role response shape, kept verbatim for deployed clients.
    res.json({
      configured: role!.requirementsConfigured || flipConfigured,
      required: tiers.required,
      recommended: tiers.recommended,
      awaitingLink: applied.legacyToolIds,
      effects: applied.effects,
      fingerprint,
    });
    return;
  }
  res.json({
    required: tiers.required,
    recommended: tiers.recommended,
    effects: applied.effects,
    fingerprint,
  });
}

taxonomyRouter.put(
  '/requirements/org',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => handleRequirementsPut(req, res, { kind: 'org' })),
);
taxonomyRouter.put(
  '/requirements/:scope/:scopeId',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    const ref = scopeRefFromParams(req.params.scope!, req.params.scopeId!);
    if (!ref) return reply(res, 404, { error: 'not_found' });
    return handleRequirementsPut(req, res, ref);
  }),
);
taxonomyRouter.put(
  '/roles/:id/required-assessments',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) =>
    handleRequirementsPut(req, res, { kind: 'role', id: req.params.id! }),
  ),
);

/**
 * Remove ONE awaitingLink legacy row — the exit for a tool that will never be
 * linked (KTD9). The requirement PUT deliberately cannot touch legacy rows, so
 * without this route an abandoned unlinked tool would sit in `awaitingLink`
 * forever, still deriving requirements the old way. The removal effects are
 * previewed through the SAME preview POST (pass `removeLegacyToolIds`), and
 * the apply here is fingerprint-guarded like the PUT: a conversion landing
 * in between changes the legacy set this row belongs to, and the stale
 * removal must 409 rather than fire against a world the admin never saw.
 */
async function handleLegacyRequirementDelete(
  req: Request,
  res: Response,
  roleId: string,
  toolId: string,
): Promise<void> {
  if (!db) return reply(res, 503, { error: 'db_unavailable' });
  const tenant = req.tenant!;
  const ref: RequirementScopeRef = { kind: 'role', id: roleId };
  const loaded = await loadRequirementScope(db, req, res, ref, { write: true });
  if (!loaded) return;
  const role = loaded.role!;
  const parsed = legacyRemoveBody.safeParse(req.body);
  if (!parsed.success)
    return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });

  /*
    THE SAME TRANSACTION SHAPE AS THE PUT (review-verified). This guard used to
    run on the root client with the delete following it as a separate
    statement: load → compare fingerprint → compute → delete, four round trips
    with three windows between them. A conversion (or the PUT itself) landing
    mid-sequence passed a stale guard and then deleted a row the admin had not
    seen the world for — the exact lost update the fingerprint exists to
    prevent, left unguarded on the one route that removes a requirement source
    outright. Load, guard, compute and delete now share ONE repeatable-read
    transaction behind the SAME scope advisory lock the PUT takes, so the two
    writers of a role's requirement state serialise against each other rather
    than only against themselves. `recordAudit` stays AFTER the commit: an
    audit row is a record of what happened, and a rolled-back delete did not.
  */
  const now = new Date();
  const outcome = await db
    .transaction(
      async (tx) => {
        await lockAndVerifyScope(tx, tenant.orgId, ref);
        const state = await loadRequirementState(tx, tenant.orgId, ref);
        // Not a refusal — an address for a row that is not there. Nothing was
        // written, so returning out of the callback simply commits nothing.
        if (!state.legacyToolIds.includes(toolId)) return { kind: 'not_found' as const };
        if (state.fingerprint !== parsed.data.fingerprint) throw new RequirementsChangedError();

        // The same compute as the preview ran: current tiers unchanged, this
        // one legacy row removed — so the effects reported here equal the
        // previewed ones on unchanged data (KTD10).
        const { effects } = await computeRequiredAssessmentsChange(
          tx,
          tenant.orgId,
          ref,
          { requiredCompetencyIds: state.required, removeLegacyToolIds: [toolId] },
          now,
        );

        await tx
          .delete(schema.roleRequiredAssessments)
          .where(
            and(
              eq(schema.roleRequiredAssessments.roleId, role.id),
              eq(schema.roleRequiredAssessments.toolId, toolId),
            ),
          );
        return {
          kind: 'done' as const,
          effects,
          links: state.links,
          legacyToolIds: state.legacyToolIds,
        };
      },
      { isolationLevel: 'repeatable read' },
    )
    .catch((err: unknown) => {
      const refusal = requirementWriteFailure(err);
      if (refusal) return { kind: 'refused' as const, refusal };
      throw err;
    });
  if (outcome.kind === 'not_found') return reply(res, 404, { error: 'not_found' });
  if (outcome.kind === 'refused') return reply(res, outcome.refusal.status, outcome.refusal.body);

  await recordAudit(db, tenant, {
    action: 'Removed legacy required assessment',
    target: role.name,
    category: 'settings',
    icon: 'briefcase',
  });
  const remainingLegacy = outcome.legacyToolIds.filter((id) => id !== toolId);
  res.json({
    awaitingLink: remainingLegacy,
    effects: outcome.effects,
    fingerprint: requirementsFingerprint(outcome.links, remainingLegacy),
  });
}

// The legacy exit exists at ROLE SCOPE ONLY (KTD6): no other scope ever had
// `role_required_assessments` rows, so there is nothing to address elsewhere.
taxonomyRouter.delete(
  '/requirements/role/:scopeId/:toolId',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) =>
    handleLegacyRequirementDelete(req, res, req.params.scopeId!, req.params.toolId!),
  ),
);
taxonomyRouter.delete(
  '/roles/:id/required-assessments/:toolId',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) =>
    handleLegacyRequirementDelete(req, res, req.params.id!, req.params.toolId!),
  ),
);

// ── U18: Retirement review and remediation ───────────────────────────────────

/** A case is in flight while open (created, not settled) — awaiting review counts (R131). */
const IN_FLIGHT_STATES = ['open', 'awaiting_sign_off'] as const;

/**
 * Re-plan assignments for a set of memberships AFTER a placement-affecting
 * write commits (KTD8, R7): every transfer route and the location/department
 * status flips call this, so no placement write path silently skips the
 * re-plan.
 *
 * BATCHED (U4's org-scale discipline): a status flip re-plans a whole
 * placement's population, so the requirement resolution and the plan run as
 * one set-wise pass — `requiredToolIdsByMembership` then
 * `planAssignmentsForMemberships` over the union of everyone's tools — never
 * a per-membership loop of transactions and scope expansions. Each
 * membership's planned cases are then filtered back to ITS OWN required
 * tools: the engine decides every tool independently (KTD16's skip rule is
 * per tool), so the filtered batch plans exactly what a per-member run would
 * have, and one member's placement never books another.
 *
 * ONE SNAPSHOT OVER BOTH HALVES (KTD3, review-verified — the batch shape of
 * the pairing `assignForMembership` makes): the resolution and the plan are
 * two reads of the same people, and run on separate snapshots a transfer
 * committing between them books the OLD requirements at the NEW placement.
 * `runSnapshotted` opens one repeatable-read transaction; the resolver's own
 * wrapper nests as a savepoint inside it. The INSERTS stay outside it, on the
 * root client — they must survive one another's failure (below), which a
 * shared transaction would forbid.
 *
 * FAIL-SOFT (the workforce-import posture, workforce-import-run.ts): the
 * placement change is already committed and real, so one member's failed
 * case INSERT must not undo the others' or fail the request — and a failed
 * batch PLAN fails all of them equally softly, for the same reason. The
 * sweep assigns them on its next pass; the planning is read-only and the
 * inserts idempotent by construction (KTD16), so re-running is always safe.
 *
 * FAIL-SOFT IS NOT FAIL-SILENT (review-verified). Both catches LOG — orgId and
 * the membership id(s) with the error — matching the with-error-handling
 * posture everywhere else in this file. A swallowed exception here means a
 * placement changed and nobody was re-planned until the next sweep: recoverable,
 * but the operator has to be able to find out it happened, and a bare `return`
 * makes a systematic failure (a bad tool manifest, a dead resolver read)
 * indistinguishable from "there was nothing to do".
 */
async function replanMemberships(
  database: Database,
  orgId: string,
  membershipIds: Iterable<string>,
): Promise<void> {
  const ids = [...new Set(membershipIds)];
  if (ids.length === 0) return;
  let planned: { ownToolIds: Map<string, string[]>; plans: MembershipPlan[] } | null;
  try {
    planned = await runSnapshotted(database, async (reader) => {
      const ownToolIds = await requiredToolIdsByMembership(reader, orgId, ids);
      const allToolIds = [...new Set([...ownToolIds.values()].flat())];
      // Zero TOOLS anywhere stays an early return: nothing to plan, nothing to
      // load. An evidence-only obligation (R7) lands here — visible in
      // standing, no case.
      if (allToolIds.length === 0) return null;
      const plans = await planAssignmentsForMemberships(reader, orgId, ids, allToolIds, new Date());
      return { ownToolIds, plans };
    });
  } catch (err) {
    // Fail-soft: the sweep is the backstop (KTD8) — but say so.
    console.error('replan: batch plan failed', { orgId, membershipIds: ids, err });
    return;
  }
  if (!planned) return;
  for (const plan of planned.plans) {
    const own = new Set(planned.ownToolIds.get(plan.membershipId) ?? []);
    try {
      await insertPlannedCases(
        database,
        orgId,
        plan.userId,
        plan.cases.filter((c) => own.has(c.toolId)),
      );
    } catch (err) {
      // Fail-soft per member: the sweep is the backstop (KTD8) — but say so.
      console.error('replan: case insert failed', { orgId, membershipId: plan.membershipId, err });
    }
  }
}

/**
 * The KTD8/U5 status-flip re-plan, shared by the location and department
 * PATCH handlers (one definition parameterised by the placement axis — the
 * `requiredCountByValue` posture): everyone PLACED at the flipped value,
 * narrowed to ACTIVE memberships of this org, re-plans fail-soft.
 */
async function replanPlacedActiveMemberships(
  database: Database,
  orgId: string,
  axis: 'location' | 'department',
  valueId: string,
): Promise<void> {
  const placed =
    axis === 'location'
      ? await database.query.membershipLocations.findMany({
          where: eq(schema.membershipLocations.locationId, valueId),
        })
      : await database.query.membershipDepartments.findMany({
          where: eq(schema.membershipDepartments.departmentId, valueId),
        });
  const placedIds = [...new Set(placed.map((p) => p.membershipId))];
  const activeMemberships = placedIds.length
    ? await database.query.memberships.findMany({
        where: and(
          eq(schema.memberships.orgId, orgId),
          inArray(schema.memberships.id, placedIds),
          eq(schema.memberships.status, 'active'),
        ),
      })
    : [];
  await replanMemberships(database, orgId, activeMemberships.map((m) => m.id));
}

/** One active person still holding a retired value. */
interface ReviewHolder {
  membershipId: string;
  userId: string;
  name: string;
}

/**
 * The people still holding a retired value (U18, KTD8, R116, R128). A PURE
 * query: nothing is written on retirement and nothing removed on remediation, so
 * returning a value to active clears its review simply by the query finding
 * nobody (R123). Only ACTIVE memberships appear — a person moved off the value,
 * or deactivated, drops out on their own (R128). Retirement itself changes no
 * competency's standing, because the value stays on the record (R119).
 */
taxonomyRouter.get(
  '/retirement-review',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const orgId = tenant.orgId;

    const [locations, departments, roles] = await Promise.all([
      db.query.locations.findMany({
        where: and(eq(schema.locations.orgId, orgId), eq(schema.locations.status, 'retired')),
      }),
      db.query.departments.findMany({
        where: and(eq(schema.departments.orgId, orgId), eq(schema.departments.status, 'retired')),
      }),
      db.query.jobRoles.findMany({
        where: and(eq(schema.jobRoles.orgId, orgId), eq(schema.jobRoles.status, 'retired')),
      }),
    ]);

    const [locHolders, deptHolders, roleHolders] = await Promise.all([
      locations.length
        ? db.query.membershipLocations.findMany({
            where: inArray(schema.membershipLocations.locationId, locations.map((l) => l.id)),
          })
        : [],
      departments.length
        ? db.query.membershipDepartments.findMany({
            where: inArray(schema.membershipDepartments.departmentId, departments.map((d) => d.id)),
          })
        : [],
      roles.length
        ? db.query.membershipRoles.findMany({
            where: and(
              inArray(schema.membershipRoles.roleId, roles.map((r) => r.id)),
              isNull(schema.membershipRoles.withdrawnAt),
            ),
          })
        : [],
    ]);

    const allMembershipIds = [
      ...new Set([
        ...locHolders.map((h) => h.membershipId),
        ...deptHolders.map((h) => h.membershipId),
        ...roleHolders.map((h) => h.membershipId),
      ]),
    ];
    // ACTIVE memberships only — the review is who is still around and holding it.
    const memberships = allMembershipIds.length
      ? await db.query.memberships.findMany({
          where: and(
            eq(schema.memberships.orgId, orgId),
            inArray(schema.memberships.id, allMembershipIds),
            eq(schema.memberships.status, 'active'),
          ),
        })
      : [];
    const activeMembership = new Map(memberships.map((m) => [m.id, m]));
    const users = memberships.length
      ? await db.query.users.findMany({
          where: inArray(schema.users.id, memberships.map((m) => m.userId)),
        })
      : [];
    const nameByUser = new Map(users.map((u) => [u.id, u.name]));

    // valueId → its ACTIVE holders, built from an axis's holder rows. `keyOf`
    // pulls the value id (locationId / departmentId / roleId) off each row.
    const holdersByValue = <T extends { membershipId: string }>(rows: T[], keyOf: (r: T) => string) => {
      const map = new Map<string, ReviewHolder[]>();
      for (const row of rows) {
        const membership = activeMembership.get(row.membershipId);
        if (!membership) continue; // not active → not in the review (R128)
        const list = map.get(keyOf(row)) ?? [];
        list.push({
          membershipId: row.membershipId,
          userId: membership.userId,
          name: nameByUser.get(membership.userId) ?? 'Unknown user',
        });
        map.set(keyOf(row), list);
      }
      return map;
    };

    const byLocation = holdersByValue(locHolders, (r) => r.locationId);
    const byDepartment = holdersByValue(deptHolders, (r) => r.departmentId);
    const byRole = holdersByValue(roleHolders, (r) => r.roleId);

    /*
      REQUIREMENT FALLOUT (KTD8/U5): under the four-scope resolver, retiring a
      Location or Department is a requirement-affecting act — its required
      competencies STOP APPLYING to everyone placed there (the U4 split). The
      review is where an Admin sees retirement's consequences, so each retired
      value carries the count for "N required competencies stop applying to M
      placed people" (M is the holders list already here). ROLES deliberately
      carry none: a retired-but-held role keeps contributing (R119 posture),
      so role retirement stops nothing — the transfer/withdraw flow is what
      ends its obligations. One batched read per axis, counted from the same
      rows the resolver reads, so the review and the resolution cannot
      disagree.
    */
    const requiredCountByValue = async (
      column: typeof schema.competencyRequirements.locationId | typeof schema.competencyRequirements.departmentId,
      valueIds: string[],
    ): Promise<Map<string, number>> => {
      const counts = new Map<string, number>();
      if (valueIds.length === 0) return counts;
      const rows = await db!.query.competencyRequirements.findMany({
        where: and(
          eq(schema.competencyRequirements.orgId, orgId),
          inArray(column, valueIds),
          eq(schema.competencyRequirements.tier, 'required'),
        ),
      });
      for (const row of rows) {
        const key = column === schema.competencyRequirements.locationId ? row.locationId : row.departmentId;
        if (!key) continue; // unreachable: the inArray above is keyed on the column
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    };
    const [locRequirementCounts, deptRequirementCounts] = await Promise.all([
      requiredCountByValue(schema.competencyRequirements.locationId, locations.map((l) => l.id)),
      requiredCountByValue(schema.competencyRequirements.departmentId, departments.map((d) => d.id)),
    ]);

    const withHolders = <T extends { id: string; name: string }>(
      values: T[],
      map: Map<string, ReviewHolder[]>,
      extra?: (v: T) => Record<string, unknown>,
    ) =>
      values
        .map((v) => ({ id: v.id, name: v.name, ...(extra?.(v) ?? {}), holders: map.get(v.id) ?? [] }))
        .filter((v) => v.holders.length > 0);

    res.json({
      locations: withHolders(locations, byLocation, (l) => ({
        requiredCompetenciesStopped: locRequirementCounts.get(l.id) ?? 0,
      })),
      departments: withHolders(departments, byDepartment, (d) => ({
        requiredCompetenciesStopped: deptRequirementCounts.get(d.id) ?? 0,
      })),
      roles: withHolders(roles, byRole, (r) => ({ departmentId: r.departmentId })),
    });
  }),
);

/** Shared loader for a Location transfer's preview and apply — same moved set, no drift (KTD10). */
async function planLocationTransfer(
  database: Database,
  orgId: string,
  locationId: string,
  replacementLocationId: string,
  membershipId: string | undefined,
): Promise<
  | { error: { status: number; body: unknown } }
  | { movedMembershipIds: string[]; movedUserIds: string[]; inFlightCaseIds: string[] }
> {
  if (replacementLocationId === locationId)
    return { error: { status: 400, body: { error: 'same_location' } } };
  const [from, to] = await Promise.all([
    database.query.locations.findFirst({
      where: and(eq(schema.locations.id, locationId), eq(schema.locations.orgId, orgId)),
    }),
    database.query.locations.findFirst({
      where: and(eq(schema.locations.id, replacementLocationId), eq(schema.locations.orgId, orgId)),
    }),
  ]);
  if (!from || !to) return { error: { status: 404, body: { error: 'not_found' } } };

  const holderRows = await database.query.membershipLocations.findMany({
    where: eq(schema.membershipLocations.locationId, locationId),
  });
  let membershipIds = [...new Set(holderRows.map((h) => h.membershipId))];
  // One person, or everyone — the same choice serves R126 and R132.
  if (membershipId) membershipIds = membershipIds.filter((id) => id === membershipId);
  if (membershipIds.length === 0)
    return { movedMembershipIds: [], movedUserIds: [], inFlightCaseIds: [] };

  const memberships = await database.query.memberships.findMany({
    where: and(
      eq(schema.memberships.orgId, orgId),
      inArray(schema.memberships.id, membershipIds),
      eq(schema.memberships.status, 'active'),
    ),
  });
  const movedMembershipIds = memberships.map((m) => m.id);
  const movedUserIds = [...new Set(memberships.map((m) => m.userId))];
  if (movedUserIds.length === 0)
    return { movedMembershipIds: [], movedUserIds: [], inFlightCaseIds: [] };

  const inFlight = await database.query.assessmentCases.findMany({
    where: and(
      eq(schema.assessmentCases.orgId, orgId),
      eq(schema.assessmentCases.locationId, locationId),
      inArray(schema.assessmentCases.candidateUserId, movedUserIds),
      inArray(schema.assessmentCases.state, [...IN_FLIGHT_STATES]),
    ),
  });
  return { movedMembershipIds, movedUserIds, inFlightCaseIds: inFlight.map((c) => c.id) };
}

const locationTransferPreviewBody = z.object({
  replacementLocationId: z.string().uuid(),
  membershipId: z.string().uuid().optional(),
});

/** What a Location transfer would move, before committing (R132): people and in-flight cases. */
taxonomyRouter.post(
  '/locations/:id/transfer/preview',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = locationTransferPreviewBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const plan = await planLocationTransfer(
      db,
      tenant.orgId,
      req.params.id!,
      parsed.data.replacementLocationId,
      parsed.data.membershipId,
    );
    if ('error' in plan) return reply(res, plan.error.status, plan.error.body);
    res.json({ peopleMoved: plan.movedMembershipIds.length, inFlightCases: plan.inFlightCaseIds.length });
  }),
);

const locationTransferBody = z.object({
  replacementLocationId: z.string().uuid(),
  membershipId: z.string().uuid().optional(),
  // Carry the in-flight cases unchanged, or rewrite them to the replacement
  // Location. There is no third outcome that voids a case (R133).
  caseOutcome: z.enum(['carry', 'rewrite']),
});

/**
 * Move people off a retired Location to a replacement (U18, R125, R126, R133,
 * R134). Their placement moves; each in-flight case is either carried unchanged
 * (keeps the Location it was assessed at) or rewritten to the replacement — the
 * one choice applies to every case, with no per-case action. Nothing voids a
 * case: stopping a part-assessed case is what deactivation does, not a transfer.
 */
taxonomyRouter.post(
  '/locations/:id/transfer',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = locationTransferBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const { replacementLocationId, membershipId, caseOutcome } = parsed.data;
    const locationId = req.params.id!;
    const plan = await planLocationTransfer(db, tenant.orgId, locationId, replacementLocationId, membershipId);
    if ('error' in plan) return reply(res, plan.error.status, plan.error.body);

    if (plan.movedMembershipIds.length > 0) {
      await db.transaction(async (tx) => {
        // Move each person's placement off the retired Location. Repoint the row
        // unless they already hold the replacement, in which case just drop the
        // retired one (the unique (membership, location) pair forbids a repeat).
        const existing = await tx.query.membershipLocations.findMany({
          where: inArray(schema.membershipLocations.membershipId, plan.movedMembershipIds),
        });
        const holdsReplacement = new Set(
          existing
            .filter((row) => row.locationId === replacementLocationId)
            .map((row) => row.membershipId),
        );
        for (const mId of plan.movedMembershipIds) {
          if (holdsReplacement.has(mId)) {
            await tx
              .delete(schema.membershipLocations)
              .where(
                and(
                  eq(schema.membershipLocations.membershipId, mId),
                  eq(schema.membershipLocations.locationId, locationId),
                ),
              );
          } else {
            await tx
              .update(schema.membershipLocations)
              .set({ locationId: replacementLocationId })
              .where(
                and(
                  eq(schema.membershipLocations.membershipId, mId),
                  eq(schema.membershipLocations.locationId, locationId),
                ),
              );
          }
        }
        // Rewrite the in-flight cases only when asked; carry leaves them be.
        if (caseOutcome === 'rewrite' && plan.inFlightCaseIds.length > 0) {
          await tx
            .update(schema.assessmentCases)
            .set({ locationId: replacementLocationId })
            .where(inArray(schema.assessmentCases.id, plan.inFlightCaseIds));
        }
      });
    }

    await recordAudit(db, tenant, {
      action: 'Transferred people off retired location',
      target: locationId,
      category: 'settings',
      icon: 'map-pin',
    });
    // KTD8/AE2: the move changed what each moved person's placement requires —
    // the replacement Location's requirements apply the moment they land, so
    // their newly-required bookable competencies get cases NOW, not on the
    // next sweep. After the commit, fail-soft per member.
    await replanMemberships(db, tenant.orgId, plan.movedMembershipIds);
    res.json({
      peopleMoved: plan.movedMembershipIds.length,
      casesRewritten: caseOutcome === 'rewrite' ? plan.inFlightCaseIds.length : 0,
      casesCarried: caseOutcome === 'carry' ? plan.inFlightCaseIds.length : 0,
    });
  }),
);

const roleTransferBody = z.object({
  replacementRoleId: z.string().uuid(),
  membershipId: z.string().uuid().optional(),
});

/**
 * Move people off a retired Role to a replacement (U18, R135). A case records a
 * Location and neither a Role nor a Department, so there is nothing on it to
 * rewrite and no carry-or-rewrite choice arises: cases in flight are left
 * untouched and only standing recalculates, emergently. The retired Role is
 * withdrawn (marked, not deleted) and the replacement given in its place.
 */
taxonomyRouter.post(
  '/roles/:id/transfer',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = roleTransferBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const roleId = req.params.id!;
    const { replacementRoleId, membershipId } = parsed.data;
    if (replacementRoleId === roleId) return reply(res, 400, { error: 'same_role' });

    const [from, to] = await Promise.all([
      db.query.jobRoles.findFirst({
        where: and(eq(schema.jobRoles.id, roleId), eq(schema.jobRoles.orgId, tenant.orgId)),
      }),
      db.query.jobRoles.findFirst({
        where: and(eq(schema.jobRoles.id, replacementRoleId), eq(schema.jobRoles.orgId, tenant.orgId)),
      }),
    ]);
    if (!from || !to) return reply(res, 404, { error: 'not_found' });

    let holders = await db.query.membershipRoles.findMany({
      where: and(eq(schema.membershipRoles.roleId, roleId), isNull(schema.membershipRoles.withdrawnAt)),
    });
    if (membershipId) holders = holders.filter((h) => h.membershipId === membershipId);
    if (holders.length === 0) return reply(res, 200, { peopleMoved: 0 });

    const movedMembershipIds = [...new Set(holders.map((h) => h.membershipId))];
    // Only ACTIVE memberships are moved — a deactivated one is not in the review.
    const memberships = await db.query.memberships.findMany({
      where: and(
        eq(schema.memberships.orgId, tenant.orgId),
        inArray(schema.memberships.id, movedMembershipIds),
        eq(schema.memberships.status, 'active'),
      ),
    });
    const activeIds = new Set(memberships.map((m) => m.id));

    await db.transaction(async (tx) => {
      // Whether the person already holds the replacement (withdrawn or not).
      const existingReplacement = await tx.query.membershipRoles.findMany({
        where: and(
          eq(schema.membershipRoles.roleId, replacementRoleId),
          inArray(schema.membershipRoles.membershipId, [...activeIds]),
        ),
      });
      const replacementRow = new Map(existingReplacement.map((r) => [r.membershipId, r]));
      for (const mId of activeIds) {
        // Withdraw the retired Role (marked, not deleted).
        await tx
          .update(schema.membershipRoles)
          .set({ withdrawnAt: new Date() })
          .where(
            and(
              eq(schema.membershipRoles.membershipId, mId),
              eq(schema.membershipRoles.roleId, roleId),
              isNull(schema.membershipRoles.withdrawnAt),
            ),
          );
        // Give the replacement — reinstate a withdrawn row, or insert a new one.
        const existing = replacementRow.get(mId);
        if (existing) {
          await tx
            .update(schema.membershipRoles)
            .set({ withdrawnAt: null })
            .where(eq(schema.membershipRoles.id, existing.id));
        } else {
          await tx
            .insert(schema.membershipRoles)
            .values({ membershipId: mId, roleId: replacementRoleId, position: 0 });
        }
      }
    });

    await recordAudit(db, tenant, {
      action: 'Transferred people off retired role',
      target: from.name,
      category: 'settings',
      icon: 'briefcase',
    });
    // KTD8 (the review-verified THIRD dark write site): the replacement Role's
    // requirements apply immediately, so each moved holder's newly-required
    // cases are planned now rather than left to the sweep. Fail-soft per member.
    await replanMemberships(db, tenant.orgId, activeIds);
    res.json({ peopleMoved: activeIds.size });
  }),
);

const departmentTransferBody = z.object({
  replacementDepartmentId: z.string().uuid(),
  membershipId: z.string().uuid().optional(),
});

/**
 * Move people off a retired Department to a replacement (U18, R135). A case
 * records a Location and neither a Department nor a Role, so — as with a Role
 * transfer — nothing on a case is rewritten and no carry-or-rewrite choice
 * arises: cases in flight are left untouched and only standing recalculates,
 * emergently. Each person's placement is repointed to the replacement Department
 * (or the retired row dropped when they already hold the replacement, the unique
 * pair forbidding a repeat), and every Role they held OF THE RETIRED DEPARTMENT
 * is withdrawn — those Roles belong to the Department being left. A withdrawn
 * Role is marked, not deleted (R113). The replacement Department grants no Roles;
 * a person lands there with none, to be given the new Department's Roles on the
 * team screen as needed.
 */
taxonomyRouter.post(
  '/departments/:id/transfer',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = departmentTransferBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const departmentId = req.params.id!;
    const { replacementDepartmentId, membershipId } = parsed.data;
    if (replacementDepartmentId === departmentId) return reply(res, 400, { error: 'same_department' });

    const [from, to] = await Promise.all([
      db.query.departments.findFirst({
        where: and(eq(schema.departments.id, departmentId), eq(schema.departments.orgId, tenant.orgId)),
      }),
      db.query.departments.findFirst({
        where: and(
          eq(schema.departments.id, replacementDepartmentId),
          eq(schema.departments.orgId, tenant.orgId),
        ),
      }),
    ]);
    if (!from || !to) return reply(res, 404, { error: 'not_found' });

    let holders = await db.query.membershipDepartments.findMany({
      where: eq(schema.membershipDepartments.departmentId, departmentId),
    });
    if (membershipId) holders = holders.filter((h) => h.membershipId === membershipId);
    if (holders.length === 0) return reply(res, 200, { peopleMoved: 0 });

    const holderMembershipIds = [...new Set(holders.map((h) => h.membershipId))];
    // Only ACTIVE memberships are moved — a deactivated one is not in the review (R128).
    const memberships = await db.query.memberships.findMany({
      where: and(
        eq(schema.memberships.orgId, tenant.orgId),
        inArray(schema.memberships.id, holderMembershipIds),
        eq(schema.memberships.status, 'active'),
      ),
    });
    const activeIds = new Set(memberships.map((m) => m.id));
    if (activeIds.size === 0) return reply(res, 200, { peopleMoved: 0 });

    // Every Role the retired Department carries, ANY status — a retired-but-held
    // Role of this Department is still one being left behind, so it is withdrawn
    // on the way out too (R119).
    const deptRoles = await db.query.jobRoles.findMany({
      where: and(
        eq(schema.jobRoles.orgId, tenant.orgId),
        eq(schema.jobRoles.departmentId, departmentId),
      ),
    });
    const deptRoleIds = deptRoles.map((r) => r.id);

    await db.transaction(async (tx) => {
      // Repoint each person's Department placement to the replacement — unless
      // they already hold it, in which case just drop the retired row (the unique
      // (membership, department) pair forbids a repeat).
      const existing = await tx.query.membershipDepartments.findMany({
        where: inArray(schema.membershipDepartments.membershipId, [...activeIds]),
      });
      const holdsReplacement = new Set(
        existing
          .filter((row) => row.departmentId === replacementDepartmentId)
          .map((row) => row.membershipId),
      );
      for (const mId of activeIds) {
        if (holdsReplacement.has(mId)) {
          await tx
            .delete(schema.membershipDepartments)
            .where(
              and(
                eq(schema.membershipDepartments.membershipId, mId),
                eq(schema.membershipDepartments.departmentId, departmentId),
              ),
            );
        } else {
          await tx
            .update(schema.membershipDepartments)
            .set({ departmentId: replacementDepartmentId })
            .where(
              and(
                eq(schema.membershipDepartments.membershipId, mId),
                eq(schema.membershipDepartments.departmentId, departmentId),
              ),
            );
        }
      }
      // Withdraw the retired Department's held Roles (marked, not deleted) — they
      // belong to the Department being left. No assessment case is touched (R135).
      if (deptRoleIds.length > 0) {
        await tx
          .update(schema.membershipRoles)
          .set({ withdrawnAt: new Date() })
          .where(
            and(
              inArray(schema.membershipRoles.membershipId, [...activeIds]),
              inArray(schema.membershipRoles.roleId, deptRoleIds),
              isNull(schema.membershipRoles.withdrawnAt),
            ),
          );
      }
    });

    await recordAudit(db, tenant, {
      action: 'Transferred people off retired department',
      target: from.name,
      category: 'settings',
      icon: 'layers',
    });
    // KTD8: the replacement Department's requirements follow placement (R3) and
    // apply the moment the repoint commits — plan the newly-required cases now.
    // Fail-soft per member; the role withdrawals above changed required sets
    // too, and the idempotent run absorbs both in one pass.
    await replanMemberships(db, tenant.orgId, activeIds);
    res.json({ peopleMoved: activeIds.size });
  }),
);

// ── Organisation settings (R24, R25, R40) ────────────────────────────────────

const settingsBody = z.object({
  allowMultipleLocations: z.boolean().optional(),
  allowMultipleDepartments: z.boolean().optional(),
  // Whether a qualified assessor may run and certify their own case. Policy
  // differs by organisation; the default is the stricter reading.
  allowSelfAssessment: z.boolean().optional(),
  displayIdentifier: z.enum(['employee_number', 'swipe_card_number']).optional(),
  // At least a day, so a zero/negative threshold cannot mark every fresh pooled
  // case overdue (U13, R63).
  pooledCaseOverdueDays: z.number().int().min(1).max(365).optional(),
  // How far ahead of an expiry the sweep notifies (U21, KTD12).
  notificationLeadDays: z.number().int().min(1).max(365).optional(),
  dateFormat: z.enum(['dmy', 'mdy']).optional(),
  /*
    Whether a candidate may SELF-START recommended training (R14, KTD6).
    Default OFF — the stricter reading. The toggle gates the candidate
    affordance and scopes the candidate's training-request POST to their
    recommended set; it never touches required-gap requests (which are always
    available) nor assessor/admin assignment, which rides the ordinary New
    Case flow regardless (R13, R14).
  */
  candidateSelfStartRecommended: z.boolean().optional(),
});

taxonomyRouter.patch(
  '/settings',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const [row] = await db
      .update(schema.organizations)
      .set({
        ...(parsed.data.allowMultipleLocations !== undefined
          ? { allowMultipleLocations: parsed.data.allowMultipleLocations }
          : {}),
        ...(parsed.data.allowMultipleDepartments !== undefined
          ? { allowMultipleDepartments: parsed.data.allowMultipleDepartments }
          : {}),
        ...(parsed.data.allowSelfAssessment !== undefined
          ? { allowSelfAssessment: parsed.data.allowSelfAssessment }
          : {}),
        ...(parsed.data.displayIdentifier ? { displayIdentifier: parsed.data.displayIdentifier } : {}),
        ...(parsed.data.pooledCaseOverdueDays !== undefined
          ? { pooledCaseOverdueDays: parsed.data.pooledCaseOverdueDays }
          : {}),
        ...(parsed.data.notificationLeadDays !== undefined
          ? { notificationLeadDays: parsed.data.notificationLeadDays }
          : {}),
        ...(parsed.data.dateFormat ? { dateFormat: parsed.data.dateFormat } : {}),
        ...(parsed.data.candidateSelfStartRecommended !== undefined
          ? { candidateSelfStartRecommended: parsed.data.candidateSelfStartRecommended }
          : {}),
      })
      .where(eq(schema.organizations.id, tenant.orgId))
      .returning();
    await recordAudit(db, tenant, {
      action: 'Updated taxonomy settings',
      target: '',
      category: 'settings',
      icon: 'settings',
    });
    res.json({
      allowMultipleLocations: row?.allowMultipleLocations ?? false,
      allowMultipleDepartments: row?.allowMultipleDepartments ?? false,
      allowSelfAssessment: row?.allowSelfAssessment ?? false,
      displayIdentifier: row?.displayIdentifier ?? 'employee_number',
      pooledCaseOverdueDays: row?.pooledCaseOverdueDays ?? 14,
      notificationLeadDays: row?.notificationLeadDays ?? 30,
      dateFormat: row?.dateFormat ?? 'dmy',
      candidateSelfStartRecommended: row?.candidateSelfStartRecommended ?? false,
    });
  }),
);

// ── DTOs ─────────────────────────────────────────────────────────────────────

function locationDto(r: typeof schema.locations.$inferSelect) {
  return { id: r.id, name: r.name, status: r.status, createdAt: r.createdAt.toISOString() };
}
function departmentDto(r: typeof schema.departments.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    allowsMultipleRoles: r.allowsMultipleRoles,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}
function roleDto(r: typeof schema.jobRoles.$inferSelect) {
  return {
    id: r.id,
    departmentId: r.departmentId,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}
