import { and, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  matrixAllows,
  resolveScope,
  type PermissionAction,
  type PermissionCategory,
  type PermissionScope,
  type Role,
} from '@formai/shared';
import { db } from '../db.js';

/** Fetch the tenant role's stored matrix, or undefined when unavailable. */
async function matrixFor(tenant: { orgId: string; role: string }) {
  if (!db) return undefined;
  const row = await db.query.rolePermissions.findFirst({
    where: and(
      eq(schema.rolePermissions.orgId, tenant.orgId),
      eq(schema.rolePermissions.role, tenant.role as Role),
    ),
  });
  return row?.matrix;
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
