import type { Role, RolePermissions } from '@formai/shared';

/**
 * Default role capability matrix, mirroring the prototype's `perms` object.
 * Seeded per-org into `role_permissions` on org creation.
 */
export const DEFAULT_ROLE_PERMISSIONS: RolePermissions = {
  owner: {
    forms: { view: true, create: true, edit: true, delete: true },
    submissions: { view: true, export: true, delete: true },
    team: { view: true, invite: true, manage: true },
    billing: { view: true, manage: true },
    audit: { view: true },
  },
  admin: {
    forms: { view: true, create: true, edit: true, delete: true },
    submissions: { view: true, export: true, delete: true },
    team: { view: true, invite: true, manage: true },
    billing: { view: true, manage: false },
    audit: { view: true },
  },
  builder: {
    forms: { view: true, create: true, edit: true, delete: false },
    submissions: { view: true, export: true, delete: false },
    team: { view: true, invite: false, manage: false },
    billing: { view: false, manage: false },
    audit: { view: false },
  },
  reviewer: {
    forms: { view: true, create: false, edit: false, delete: false },
    submissions: { view: true, export: true, delete: false },
    team: { view: true, invite: false, manage: false },
    billing: { view: false, manage: false },
    audit: { view: true },
  },
  viewer: {
    forms: { view: true, create: false, edit: false, delete: false },
    submissions: { view: true, export: false, delete: false },
    team: { view: false, invite: false, manage: false },
    billing: { view: false, manage: false },
    audit: { view: false },
  },
};

export function defaultMatrixFor(role: Role) {
  return DEFAULT_ROLE_PERMISSIONS[role];
}
