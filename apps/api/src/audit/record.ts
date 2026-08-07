import { eq } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import type { AuditCategory, TenantContext } from '@formai/shared';

export interface AuditInput {
  action: string;
  target?: string;
  category: AuditCategory;
  icon?: string;
  /**
   * The profile inventory's key for the field this entry covers (R57, R58).
   *
   * Set only by a per-field write. R58's filter compares it against the
   * inventory's sensitive marks, which is why it is a column rather than
   * something parsed out of `target` — a filter over free text would have to
   * pattern-match the very prose holding the values it is hiding.
   */
  field?: string | null;
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
    field: input.field ?? null,
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
    /** Null on every entry that is not about one profile field (R57). */
    field: r.field,
    icon: r.icon,
    createdAt: r.createdAt.toISOString(),
  };
}
