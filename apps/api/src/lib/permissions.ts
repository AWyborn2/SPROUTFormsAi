import { and, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  DEFAULT_ROLE_PERMISSIONS,
  matrixAllows,
  resolveScope,
  ROLES,
  type PermissionAction,
  type PermissionCategory,
  type PermissionScope,
  type Role,
} from '@formai/shared';
import { db } from '../db.js';

/**
 * The tenant role's effective matrix, or undefined when nothing can be
 * resolved.
 *
 * A KNOWN role with no stored row falls back to the product default. This is
 * what seeds the roles added after an org was created: PostgreSQL will not let
 * a migration insert a row using an enum value added in the same transaction
 * (55P04), and drizzle applies all pending migrations in one transaction — so
 * new-role matrices cannot be backfilled in SQL alongside the enum change.
 * Resolving the default here removes the ordering dependency entirely, and
 * cannot be forgotten the way a follow-up migration can.
 *
 * The fallback is narrow on purpose. An UNKNOWN role resolves to undefined
 * (denied), and so does an unavailable database — the fail-closed guarantees
 * both still hold. It only answers "this org never customised a role the
 * product ships", which is a default, not an escalation.
 */
async function matrixFor(tenant: { orgId: string; role: string }) {
  if (!db) return undefined;
  const row = await db.query.rolePermissions.findFirst({
    where: and(
      eq(schema.rolePermissions.orgId, tenant.orgId),
      eq(schema.rolePermissions.role, tenant.role as Role),
    ),
  });
  if (row?.matrix) return row.matrix;
  return (ROLES as readonly string[]).includes(tenant.role)
    ? DEFAULT_ROLE_PERMISSIONS[tenant.role as Role]
    : undefined;
}

/**
 * Whether the tenant's role grants `category.action` ORG-WIDE in the org's
 * stored permission matrix. Fails closed: no db, no matrix row, an unset
 * action, or an own-scoped grant all read as denied.
 *
 * A scoped (`'own'`) grant answering false here is the point — every call site
 * that predates record scoping asks this question, and none of them filter by
 * owner, so answering true would hand a candidate the whole org. Routes that
 * understand ownership call `permissionScope` instead.
 */
export async function hasPermission(
  tenant: { orgId: string; role: string },
  category: PermissionCategory,
  action: PermissionAction,
): Promise<boolean> {
  return matrixAllows(await matrixFor(tenant), category, action);
}

/**
 * How broadly the tenant's role grants `category.action`: `all` for org-wide,
 * `own` for records the user owns, `none` for denied. A caller that receives
 * `own` MUST filter its query by owner — returning unfiltered rows on an `own`
 * scope is the bug this distinction exists to prevent.
 */
export async function permissionScope(
  tenant: { orgId: string; role: string },
  category: PermissionCategory,
  action: PermissionAction,
): Promise<PermissionScope> {
  return resolveScope(await matrixFor(tenant), category, action);
}
