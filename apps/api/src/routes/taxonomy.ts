import { Router, type Response } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { db } from '../db.js';

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
        displayIdentifier: org?.displayIdentifier ?? 'employee_number',
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

taxonomyRouter.put(
  '/roles/:id/required-assessments',
  ...TAXONOMY_GATE,
  withErrorHandling(async (req, res) => {
    if (!db) return reply(res, 503, { error: 'db_unavailable' });
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) return reply(res, 403, { error: 'forbidden' });
    const parsed = requiredAssessmentsBody.safeParse(req.body);
    if (!parsed.success)
      return reply(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() });
    const role = await db.query.jobRoles.findFirst({
      where: and(eq(schema.jobRoles.id, req.params.id!), eq(schema.jobRoles.orgId, tenant.orgId)),
    });
    if (!role) return reply(res, 404, { error: 'not_found' });
    // R121: a retired Role is frozen — it takes on no new obligations for the
    // people on their way off it.
    if (role.status !== 'active') return reply(res, 409, { error: 'role_retired' });

    const toolIds = [...new Set(parsed.data.toolIds)];
    if (toolIds.length > 0) {
      const found = await db
        .select({ id: schema.assessmentTools.id })
        .from(schema.assessmentTools)
        .where(
          and(
            eq(schema.assessmentTools.orgId, tenant.orgId),
            inArray(schema.assessmentTools.id, toolIds),
          ),
        );
      if (found.length !== toolIds.length) return reply(res, 400, { error: 'tool_not_found' });
    }

    // Replace the whole set rather than diff it: the list is short, and a full
    // replace cannot leave a stale requirement behind.
    await db
      .delete(schema.roleRequiredAssessments)
      .where(eq(schema.roleRequiredAssessments.roleId, role.id));
    if (toolIds.length > 0) {
      await db
        .insert(schema.roleRequiredAssessments)
        .values(toolIds.map((toolId) => ({ orgId: tenant.orgId, roleId: role.id, toolId })));
    }
    if (!role.requirementsConfigured) {
      await db
        .update(schema.jobRoles)
        .set({ requirementsConfigured: true })
        .where(eq(schema.jobRoles.id, role.id));
    }

    await recordAudit(db, tenant, {
      action: 'Set role required assessments',
      target: role.name,
      category: 'settings',
      icon: 'briefcase',
    });
    res.json({ configured: true, toolIds });
  }),
);

// ── Organisation settings (R24, R25, R40) ────────────────────────────────────

const settingsBody = z.object({
  allowMultipleLocations: z.boolean().optional(),
  allowMultipleDepartments: z.boolean().optional(),
  displayIdentifier: z.enum(['employee_number', 'swipe_card_number']).optional(),
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
        ...(parsed.data.displayIdentifier ? { displayIdentifier: parsed.data.displayIdentifier } : {}),
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
      displayIdentifier: row?.displayIdentifier ?? 'employee_number',
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
