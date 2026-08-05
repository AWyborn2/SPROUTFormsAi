/**
 * The single answer to "may this person hold these Roles at these Locations?"
 *
 * Called wherever a membership is placed — by hand on the team screen and by a
 * bulk-import row alike — so one rule decides both and they cannot disagree
 * (R5, R6). The rules:
 *
 *  - At least one Location (R21, and the precondition U11's assignment
 *    resolution depends on: a case takes its Location from the membership, so a
 *    membership with none has no case Location). The import imposes the same on
 *    a row (R151, R168).
 *  - Each Role must be offered by one of the Departments the person is placed
 *    in (R5). A Role belongs to exactly one Department, so "offered by a placed
 *    Department" is: its departmentId is among the placed Departments. Placing
 *    someone in several Departments COMBINES their offers rather than
 *    intersecting (R5) — a Role any placed Department offers is holdable.
 *  - Within each Department, a person holds one of its Roles or several,
 *    per that Department's own setting (R6). The count is bounded per
 *    Department, never across the whole placement, so two Departments with
 *    different settings raise no contradiction.
 */

export interface PlacementInput {
  locationIds: string[];
  departmentIds: string[];
  roleIds: string[];
}

/** The offer sets and count rules the validator reads — the org's active taxonomy. */
export interface PlacementContext {
  departments: Array<{ id: string; allowsMultipleRoles: boolean }>;
  /** Active Roles in the organisation, each with the Department that offers it. */
  roles: Array<{ id: string; departmentId: string }>;
}

export type PlacementErrorCode =
  | 'no_location'
  | 'unknown_role'
  | 'role_not_offered'
  | 'too_many_roles';

export interface PlacementError {
  code: PlacementErrorCode;
  /** The Role or Department the failure is about, when there is one. */
  subjectId?: string;
}

export type PlacementResult = { ok: true } | { ok: false; error: PlacementError };

export function validatePlacement(input: PlacementInput, ctx: PlacementContext): PlacementResult {
  // R21 / U11 precondition: a membership carries at least one Location.
  if (input.locationIds.length === 0) {
    return { ok: false, error: { code: 'no_location' } };
  }

  const deptById = new Map(ctx.departments.map((d) => [d.id, d]));
  const roleById = new Map(ctx.roles.map((r) => [r.id, r]));
  const placedDepartments = new Set(input.departmentIds);

  // Every Role must exist and be offered by a placed Department (R5).
  const rolesPerDepartment = new Map<string, number>();
  for (const roleId of input.roleIds) {
    const role = roleById.get(roleId);
    if (!role) {
      return { ok: false, error: { code: 'unknown_role', subjectId: roleId } };
    }
    if (!placedDepartments.has(role.departmentId)) {
      return { ok: false, error: { code: 'role_not_offered', subjectId: roleId } };
    }
    rolesPerDepartment.set(
      role.departmentId,
      (rolesPerDepartment.get(role.departmentId) ?? 0) + 1,
    );
  }

  // Count is bounded PER Department by that Department's own setting (R6).
  for (const [departmentId, count] of rolesPerDepartment) {
    const department = deptById.get(departmentId);
    if (count > 1 && !department?.allowsMultipleRoles) {
      return { ok: false, error: { code: 'too_many_roles', subjectId: departmentId } };
    }
  }

  return { ok: true };
}
