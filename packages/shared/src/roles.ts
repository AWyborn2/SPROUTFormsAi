/**
 * Roles & permissions.
 *
 * The prototype exercises a 5-role model (Owner/Admin/Builder/Reviewer/Viewer)
 * with a capability matrix. We adopt it as the source of truth (see the
 * implementation plan's "prototype vs brief" note).
 */

export const ROLES = ['owner', 'admin', 'builder', 'reviewer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Human-facing labels, matching the prototype's casing. */
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  builder: 'Builder',
  reviewer: 'Reviewer',
  viewer: 'Viewer',
};

/** Capability categories and the actions each supports. */
export const PERMISSION_CATEGORIES = [
  'forms',
  'submissions',
  'team',
  'billing',
  'audit',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export type PermissionAction =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'export'
  | 'invite'
  | 'manage';

/** A role's full capability matrix: category -> action -> allowed. */
export type PermissionMatrix = Record<
  PermissionCategory,
  Partial<Record<PermissionAction, boolean>>
>;

export type RolePermissions = Record<Role, PermissionMatrix>;

export type MembershipStatus = 'active' | 'invited' | 'suspended';
