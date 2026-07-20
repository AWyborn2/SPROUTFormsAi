import { and, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { PermissionAction, PermissionCategory, Role } from '@formai/shared';
import { db } from '../db.js';

/**
 * Whether the tenant's role grants `category.action` in the org's stored
 * permission matrix. Fails closed: no db, no matrix row, or an unset action
 * all read as denied. Shared by every route that gates a mutation on the
 * matrix (team, submissions, fill-links).
 */
export async function hasPermission(
  tenant: { orgId: string; role: string },
  category: PermissionCategory,
  action: PermissionAction,
): Promise<boolean> {
  if (!db) return false;
  const row = await db.query.rolePermissions.findFirst({
    where: and(
      eq(schema.rolePermissions.orgId, tenant.orgId),
      eq(schema.rolePermissions.role, tenant.role as Role),
    ),
  });
  return row?.matrix[category]?.[action] === true;
}
