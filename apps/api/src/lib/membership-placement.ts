import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Db, type DbOrTx } from '@formai/db';
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
export async function loadPlacementContext(db: DbOrTx, orgId: string): Promise<PlacementContext> {
  const [locations, departments, roles] = await Promise.all([
    // Locations joined the offer set when they started conferring requirements
    // (U5/KTD8): a retired Location must be refusable exactly like a retired
    // Role, so the validator now needs to know which Locations are offerable.
    db.query.locations.findMany({
      where: and(eq(schema.locations.orgId, orgId), eq(schema.locations.status, 'active')),
    }),
    db.query.departments.findMany({
      where: and(eq(schema.departments.orgId, orgId), eq(schema.departments.status, 'active')),
    }),
    db.query.jobRoles.findMany({
      where: and(eq(schema.jobRoles.orgId, orgId), eq(schema.jobRoles.status, 'active')),
    }),
  ]);
  return {
    locations: locations.map((l) => ({ id: l.id })),
    departments: departments.map((d) => ({ id: d.id, allowsMultipleRoles: d.allowsMultipleRoles })),
    roles: roles.map((r) => ({ id: r.id, departmentId: r.departmentId })),
  };
}

/**
 * Widen a base taxonomy to also admit what this member currently HOLDS: their
 * non-withdrawn Roles and the Departments those Roles belong to, and — since
 * Locations joined the offer set (U5) — the Locations they are currently
 * placed at. All regardless of status.
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
 * HELD LOCATIONS get the mirror-image treatment (U5): a member already AT a
 * since-retired Location survives an unrelated placement edit — the retired
 * Location rides along admitted — while placing anyone NEW onto it reads
 * `unknown_location` (a 400), because a Location now confers requirements and
 * a retired one confers nothing (the U4 split).
 *
 * The per-Department too_many_roles cap is unaffected: an admitted Department
 * carries its own allowsMultipleRoles setting, retired or not, so the count is
 * still bounded by that Department's own rule (R6).
 */
export async function admitHeldRoles(
  db: DbOrTx,
  orgId: string,
  membershipId: string,
  base: PlacementContext,
): Promise<PlacementContext> {
  const heldLocationRows = await db.query.membershipLocations.findMany({
    where: eq(schema.membershipLocations.membershipId, membershipId),
  });
  const held = await db.query.membershipRoles.findMany({
    where: and(
      eq(schema.membershipRoles.membershipId, membershipId),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });

  // Union by id: a value offered actively AND held collapses to one entry (both
  // reads are the same row, so the overlay is a no-op there); a held-only value
  // is what the widening adds. Locations need no status read at all — the id
  // alone is the admission, since the context carries nothing else for one.
  const locations = new Map(base.locations.map((l) => [l.id, l]));
  for (const row of heldLocationRows) locations.set(row.locationId, { id: row.locationId });

  const heldRoleIds = held.map((r) => r.roleId);
  if (heldRoleIds.length === 0) {
    return { ...base, locations: [...locations.values()] };
  }

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

  const roles = new Map(base.roles.map((r) => [r.id, r]));
  for (const r of heldRoles) roles.set(r.id, { id: r.id, departmentId: r.departmentId });

  const departments = new Map(base.departments.map((d) => [d.id, d]));
  for (const d of heldDepartments) {
    departments.set(d.id, { id: d.id, allowsMultipleRoles: d.allowsMultipleRoles });
  }

  return {
    locations: [...locations.values()],
    departments: [...departments.values()],
    roles: [...roles.values()],
  };
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
  db: DbOrTx,
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

/**
 * Withdraw a Role from EVERY person who currently holds it (U17, R52) — the
 * mechanism behind a Department that stops offering a Role, where the Role is no
 * longer available and there is nothing to put to an Admin.
 *
 * Marks, never deletes (R52): only rows currently held (`withdrawnAt IS NULL`)
 * are touched, so it is idempotent and preserves the timestamp on rows already
 * withdrawn. It touches no assessment case — a case in flight for the Role's
 * requirement runs to completion (R54); deactivation is the only act that stops
 * one. Demotion of any competency the Role alone required is left to the standing
 * derivation, which reads the held set on the next call (R109) — nothing is
 * written to a competency here.
 *
 * The caller MUST have verified the Role belongs to the organisation before
 * calling; `membership_roles` carries no org column, so the org scope is the
 * Role's. Runs against whatever handle it is given (a transaction, so the offer
 * withdrawal and the Role's status flip commit together).
 */
export async function withdrawRoleFromAllHolders(
  // A transaction or the base handle — only `.update` is used, so both satisfy
  // it, and the caller runs this inside the same transaction as the status flip.
  db: Pick<Db, 'update'>,
  roleId: string,
  now: Date,
): Promise<void> {
  await db
    .update(schema.membershipRoles)
    .set({ withdrawnAt: now })
    .where(
      and(
        eq(schema.membershipRoles.roleId, roleId),
        isNull(schema.membershipRoles.withdrawnAt),
      ),
    );
}
