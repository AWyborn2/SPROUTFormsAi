import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import { validatePlacement, type PlacementContext, type PlacementResult } from '@formai/shared';

/**
 * Reading and writing where a member is placed — the Locations, Departments and
 * Roles on their membership (R21, R22). One place owns it, so hand-placement on
 * the team screen and a bulk-import row write through the same rules
 * (`validatePlacement`) and cannot disagree (R5, R6). Reused by U11 (assign on
 * placement change) and U24 (import).
 */

export interface PlacementInput {
  locationIds: string[];
  departmentIds: string[];
  roleIds: string[];
}

/** The organisation's ACTIVE taxonomy — the offer sets and count rules the validator reads. */
export async function loadPlacementContext(db: Db, orgId: string): Promise<PlacementContext> {
  const [departments, roles] = await Promise.all([
    db.query.departments.findMany({
      where: and(eq(schema.departments.orgId, orgId), eq(schema.departments.status, 'active')),
    }),
    db.query.jobRoles.findMany({
      where: and(eq(schema.jobRoles.orgId, orgId), eq(schema.jobRoles.status, 'active')),
    }),
  ]);
  return {
    departments: departments.map((d) => ({ id: d.id, allowsMultipleRoles: d.allowsMultipleRoles })),
    roles: roles.map((r) => ({ id: r.id, departmentId: r.departmentId })),
  };
}

/**
 * Widen a base taxonomy to also admit the Roles this member currently HOLDS
 * (withdrawnAt IS NULL) and the Departments those Roles belong to — regardless
 * of either's status.
 *
 * Retiring a Role leaves it held on the record of anyone already placed in it
 * (R119: retirement withdraws nobody); it only bars NEW placements. So an Admin
 * editing such a member — adding a Location, say — re-submits the held retired
 * Role as part of the placement. Validated against active-only taxonomy that
 * Role reads as `unknown_role` (a 400), and dropping it to dodge the error would
 * withdraw a Role retirement was never meant to remove. Admitting what the
 * member already holds keeps the edit idempotent for it, while a newly-added
 * retired Role — not held, so not admitted — is still refused.
 *
 * The per-Department too_many_roles cap is unaffected: an admitted Department
 * carries its own allowsMultipleRoles setting, retired or not, so the count is
 * still bounded by that Department's own rule (R6).
 */
export async function admitHeldRoles(
  db: Db,
  orgId: string,
  membershipId: string,
  base: PlacementContext,
): Promise<PlacementContext> {
  const held = await db.query.membershipRoles.findMany({
    where: and(
      eq(schema.membershipRoles.membershipId, membershipId),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });
  const heldRoleIds = held.map((r) => r.roleId);
  if (heldRoleIds.length === 0) return base;

  const heldRoles = await db.query.jobRoles.findMany({
    where: and(eq(schema.jobRoles.orgId, orgId), inArray(schema.jobRoles.id, heldRoleIds)),
  });
  const heldDeptIds = [...new Set(heldRoles.map((r) => r.departmentId))];
  const heldDepartments = heldDeptIds.length
    ? await db.query.departments.findMany({
        where: and(
          eq(schema.departments.orgId, orgId),
          inArray(schema.departments.id, heldDeptIds),
        ),
      })
    : [];

  // Union by id: a value offered actively AND held collapses to one entry (both
  // reads are the same row, so the overlay is a no-op there); a held-only value
  // is what the widening adds.
  const roles = new Map(base.roles.map((r) => [r.id, r]));
  for (const r of heldRoles) roles.set(r.id, { id: r.id, departmentId: r.departmentId });

  const departments = new Map(base.departments.map((d) => [d.id, d]));
  for (const d of heldDepartments) {
    departments.set(d.id, { id: d.id, allowsMultipleRoles: d.allowsMultipleRoles });
  }

  return { departments: [...departments.values()], roles: [...roles.values()] };
}

/** A member's current placement. Roles are the HELD set only (withdrawnAt IS NULL). */
export async function readPlacement(db: Db, membershipId: string): Promise<PlacementInput> {
  const [locations, departments, roles] = await Promise.all([
    db.query.membershipLocations.findMany({
      where: eq(schema.membershipLocations.membershipId, membershipId),
      orderBy: (t, { asc }) => [asc(t.position)],
    }),
    db.query.membershipDepartments.findMany({
      where: eq(schema.membershipDepartments.membershipId, membershipId),
      orderBy: (t, { asc }) => [asc(t.position)],
    }),
    db.query.membershipRoles.findMany({
      where: and(
        eq(schema.membershipRoles.membershipId, membershipId),
        isNull(schema.membershipRoles.withdrawnAt),
      ),
      orderBy: (t, { asc }) => [asc(t.position)],
    }),
  ]);
  return {
    locationIds: locations.map((l) => l.locationId),
    departmentIds: departments.map((d) => d.departmentId),
    roleIds: roles.map((r) => r.roleId),
  };
}

/**
 * Validates a placement against the organisation's taxonomy and, when valid,
 * writes it. Locations and Departments are replaced outright (they carry no
 * withdrawn state). Roles are RECONCILED: a listed Role is inserted or
 * reinstated (withdrawnAt cleared), and a currently-held Role no longer listed
 * is withdrawn rather than deleted (R52) — nothing erases a Role someone was
 * placed in. Returns the validation result; on ok:false nothing is written.
 *
 * Validation runs against the active taxonomy WIDENED with what this member
 * already holds (`admitHeldRoles`), so an Admin can edit the placement of a
 * member holding a since-retired Role without it being rejected or silently
 * dropped (R119).
 */
export async function writePlacement(
  db: Db,
  orgId: string,
  membershipId: string,
  input: PlacementInput,
  ctx?: PlacementContext,
): Promise<PlacementResult> {
  const base = ctx ?? (await loadPlacementContext(db, orgId));
  const context = await admitHeldRoles(db, orgId, membershipId, base);
  const result = validatePlacement(input, context);
  if (!result.ok) return result;

  await db.transaction(async (tx) => {
    // Locations — replace.
    await tx
      .delete(schema.membershipLocations)
      .where(eq(schema.membershipLocations.membershipId, membershipId));
    if (input.locationIds.length) {
      await tx.insert(schema.membershipLocations).values(
        input.locationIds.map((locationId, position) => ({ membershipId, locationId, position })),
      );
    }

    // Departments — replace.
    await tx
      .delete(schema.membershipDepartments)
      .where(eq(schema.membershipDepartments.membershipId, membershipId));
    if (input.departmentIds.length) {
      await tx.insert(schema.membershipDepartments).values(
        input.departmentIds.map((departmentId, position) => ({ membershipId, departmentId, position })),
      );
    }

    // Roles — reconcile, never delete (R52).
    const existing = await tx.query.membershipRoles.findMany({
      where: eq(schema.membershipRoles.membershipId, membershipId),
    });
    const existingById = new Map(existing.map((r) => [r.roleId, r]));
    const listed = new Set(input.roleIds);

    for (let position = 0; position < input.roleIds.length; position++) {
      const roleId = input.roleIds[position]!;
      const current = existingById.get(roleId);
      if (current) {
        // Reinstate if withdrawn, and pin the new order.
        await tx
          .update(schema.membershipRoles)
          .set({ withdrawnAt: null, position })
          .where(eq(schema.membershipRoles.id, current.id));
      } else {
        await tx.insert(schema.membershipRoles).values({ membershipId, roleId, position });
      }
    }

    // Withdraw held Roles no longer listed (R52) — mark, do not delete.
    for (const row of existing) {
      if (!listed.has(row.roleId) && row.withdrawnAt === null) {
        await tx
          .update(schema.membershipRoles)
          .set({ withdrawnAt: new Date() })
          .where(eq(schema.membershipRoles.id, row.id));
      }
    }
  });

  return { ok: true };
}
