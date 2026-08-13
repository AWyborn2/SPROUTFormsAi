import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { assignmentCaseValues } from '../lib/assignment.js';
import { computeRequiredAssessmentsChange } from '../lib/requirement-change.js';
import { withdrawRoleFromAllHolders } from '../lib/membership-placement.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;

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

// ── A Role's required assessments (U10 — R43, R49, R50, R121) ─────────────────

const requiredAssessmentsBody = z.object({ toolIds: z.array(z.string().uuid()) });

taxonomyRouter.get(
  '/roles/:id/required-assessments',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const role = await db.query.jobRoles.findFirst({
      where: and(eq(schema.jobRoles.id, req.params.id!), eq(schema.jobRoles.orgId, tenant.orgId)),
    });
    if (!role) return reply(res, 404, { error: 'not_found' });
    const rows = await db
      .select({ toolId: schema.roleRequiredAssessments.toolId })
      .from(schema.roleRequiredAssessments)
      .where(eq(schema.roleRequiredAssessments.roleId, role.id));
    // `configured` is the STORED fact (R50), never `rows.length > 0`: a Role
    // emptied of its requirements is still configured and reads differently from
    // one never set up.
    res.json({ configured: role.requirementsConfigured, toolIds: rows.map((r) => r.toolId) });
  }),
);

/**
 * The guard both the preview and the apply share (U12), so they cannot drift on
 * who may change a Role's requirements or which tools are valid: Admin (R73/R12),
 * the Role is the organisation's and active (R121), and every proposed tool
 * belongs to the organisation. Sends the error response and returns null on any
 * failure; returns the loaded Role and the deduplicated desired set otherwise.
 */
async function loadRequirementChange(
  database: Database,
  req: Request,
  res: Response,
): Promise<{ role: typeof schema.jobRoles.$inferSelect; toolIds: string[] } | null> {
  const tenant = req.tenant!;
  if (!isAdmin(tenant.role)) {
    reply(res, 403, { error: 'forbidden' });
    return null;
  }
  const parsed = requiredAssessmentsBody.safeParse(req.body);
  if (!parsed.success) {
    reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    return null;
  }
  const role = await database.query.jobRoles.findFirst({
    where: and(eq(schema.jobRoles.id, req.params.id!), eq(schema.jobRoles.orgId, tenant.orgId)),
  });
  if (!role) {
    reply(res, 404, { error: 'not_found' });
    return null;
  }
  // R121: a retired Role is frozen — a preview an apply would 409 must 409 too.
  if (role.status !== 'active') {
    reply(res, 409, { error: 'role_retired' });
    return null;
  }
  const toolIds = [...new Set(parsed.data.toolIds)];
  if (toolIds.length > 0) {
    const found = await database
      .select({ id: schema.assessmentTools.id })
      .from(schema.assessmentTools)
      .where(
        and(
          eq(schema.assessmentTools.orgId, tenant.orgId),
          inArray(schema.assessmentTools.id, toolIds),
        ),
      );
    if (found.length !== toolIds.length) {
      reply(res, 400, { error: 'tool_not_found' });
      return null;
    }
  }
  return { role, toolIds };
}

/**
 * The blast radius of a proposed change, BEFORE it commits (U12, R84–R86).
 * Computes the same effects the apply will, and writes nothing — the Admin sees
 * how many people are affected and what the change does, and may abandon it.
 */
taxonomyRouter.post(
  '/roles/:id/required-assessments/preview',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    const change = await loadRequirementChange(db, req, res);
    if (!change) return;
    const { effects } = await computeRequiredAssessmentsChange(
      db,
      tenant.orgId,
      change.role,
      change.toolIds,
      new Date(),
    );
    res.json({ effects });
  }),
);

taxonomyRouter.put(
  '/roles/:id/required-assessments',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    const change = await loadRequirementChange(db, req, res);
    if (!change) return;
    const { role, toolIds } = change;

    // ONE code path (KTD10): the apply runs the SAME computation the preview did,
    // so `effects.created` is exactly the number of cases it inserts. Its reads
    // are of the PRE-change state, so running it before the write is correct.
    const now = new Date();
    const { effects, casesToInsert } = await computeRequiredAssessmentsChange(
      db,
      tenant.orgId,
      role,
      toolIds,
      now,
    );

    /*
      Apply atomically. `compute` derived the additions as a diff against the
      current requirements, so if the requirement rows committed but a case
      insert then failed, a retry would see the new rows as current, compute an
      empty diff, and never create the missing case — the holder would be left
      permanently uncovered. A transaction makes a partial failure roll the
      requirement replacement back with it, so a retry re-plans and re-inserts.

      Replace the whole set rather than diff it (a full replace cannot leave a
      stale requirement behind); removing a tool leaves its in-flight cases
      untouched (R55) — nothing here cancels a case.
    */
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.roleRequiredAssessments)
        .where(eq(schema.roleRequiredAssessments.roleId, role.id));
      if (toolIds.length > 0) {
        await tx
          .insert(schema.roleRequiredAssessments)
          .values(toolIds.map((toolId) => ({ orgId: tenant.orgId, roleId: role.id, toolId })));
      }
      if (!role.requirementsConfigured) {
        await tx
          .update(schema.jobRoles)
          .set({ requirementsConfigured: true })
          .where(eq(schema.jobRoles.id, role.id));
      }
      // The additions' cases, applied with no per-person action (R82, R83, R87).
      // Exactly the plan `compute` counted, so the rows written equal
      // `effects.created`.
      for (const c of casesToInsert) {
        await tx
          .insert(schema.assessmentCases)
          .values(assignmentCaseValues(c.orgId, c.candidateUserId, c));
      }
    });

    await recordAudit(db, tenant, {
      action: 'Set role required assessments',
      target: role.name,
      category: 'settings',
      icon: 'briefcase',
    });
    res.json({ configured: true, toolIds, effects });
  }),
);

// ── U18: Retirement review and remediation ───────────────────────────────────

/** A case is in flight while open (created, not settled) — awaiting review counts (R131). */
const IN_FLIGHT_STATES = ['open', 'awaiting_sign_off'] as const;

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

    const withHolders = <T extends { id: string; name: string }>(
      values: T[],
      map: Map<string, ReviewHolder[]>,
      extra?: (v: T) => Record<string, unknown>,
    ) =>
      values
        .map((v) => ({ id: v.id, name: v.name, ...(extra?.(v) ?? {}), holders: map.get(v.id) ?? [] }))
        .filter((v) => v.holders.length > 0);

    res.json({
      locations: withHolders(locations, byLocation),
      departments: withHolders(departments, byDepartment),
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
