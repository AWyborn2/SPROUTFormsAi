import { eq } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import type { AuditCategory, TenantContext } from '@formai/shared';

export interface AuditInput {
  action: string;
  target?: string;
  category: AuditCategory;
  icon?: string;
}

/**
 * Thin insert helper into `audit_log_entries`, called by every mutating
 * route added across this plan (team, competency, and — later — billing
 * changes) so none of them has to invent its own insert logic.
 */
export async function recordAudit(db: Db, tenant: TenantContext, input: AuditInput): Promise<void> {
  const actor = await db.query.users.findFirst({ where: eq(schema.users.id, tenant.userId) });
  await db.insert(schema.auditLogEntries).values({
    orgId: tenant.orgId,
    actorId: tenant.userId,
    actorName: actor?.name ?? 'System',
    action: input.action,
    target: input.target ?? '',
    category: input.category,
    icon: input.icon ?? 'activity',
  });
}

/** Row → JSON shape shared by `GET /audit` and the dashboard's activity feed. */
export function auditEntryDto(r: typeof schema.auditLogEntries.$inferSelect) {
  return {
    id: r.id,
    actorName: r.actorName,
    action: r.action,
    target: r.target,
    category: r.category,
    icon: r.icon,
    createdAt: r.createdAt.toISOString(),
  };
}
