import { Router } from 'express';
import { and, count, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { auditEntryDto, isSensitiveEntry } from '../audit/record.js';
import { db } from '../db.js';

/** Owner holds everything Admin holds, so both pass every Admin-only rule. */
function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

/**
 * Statuses the dashboard's "Needs review" tile counts — submissions still
 * awaiting a reviewer decision. Decided ('approved'/'rejected'/'reviewed'/
 * 'complete') and unsubmitted ('draft') statuses are excluded.
 */
const PENDING_REVIEW_STATUSES = ['submitted', 'review', 'pending'] as const;

/** How many audit entries feed the dashboard's recent-activity list. */
const RECENT_ACTIVITY_LIMIT = 8;

/**
 * Org-scoped dashboard aggregates: active (published) form count, submission
 * counts, and the newest audit entries for the activity feed. Read-only —
 * the web's `store.dashboard()` is the consumer.
 */
export const dashboardRouter: Router = Router();

dashboardRouter.get(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;

    /*
      Each aggregate is gated on the grant that guards the data it summarises —
      submission counts on `submissions.view`, the activity feed on
      `audit.view`. Without the gate, any authenticated member (a candidate, an
      own-scoped role, a narrow API key) could read org-wide submission volumes
      and the audit trail's actors and targets through this one route.

      A denied grant EMPTIES its fields rather than failing the request: this
      is a shared landing read, and a caller legitimately here for one
      aggregate must not 403 on an unrelated one. Zeros/empty are exactly what
      the workspace dashboard renders for them anyway.
    */
    const [canViewSubmissions, canViewAudit] = await Promise.all([
      hasPermission(tenant, 'submissions', 'view'),
      hasPermission(tenant, 'audit', 'view'),
    ]);
    const deniedCount = [{ count: 0 }];

    const [[activeForms], [submissionsTotal], [pendingReview], recentActivity] = await Promise.all([
      db
        .select({ count: count() })
        .from(schema.formTemplates)
        .where(
          and(
            eq(schema.formTemplates.orgId, tenant.orgId),
            eq(schema.formTemplates.status, 'published'),
          ),
        ),
      canViewSubmissions
        ? db
            .select({ count: count() })
            .from(schema.submissions)
            .where(eq(schema.submissions.orgId, tenant.orgId))
        : deniedCount,
      canViewSubmissions
        ? db
            .select({ count: count() })
            .from(schema.submissions)
            .where(
              and(
                eq(schema.submissions.orgId, tenant.orgId),
                inArray(schema.submissions.status, [...PENDING_REVIEW_STATUSES]),
              ),
            )
        : deniedCount,
      canViewAudit
        ? db.query.auditLogEntries.findMany({
            where: eq(schema.auditLogEntries.orgId, tenant.orgId),
            orderBy: (a, { desc }) => [desc(a.createdAt)],
            limit: RECENT_ACTIVITY_LIMIT,
          })
        : [],
    ]);

    /*
      R58, same narrowing as `GET /audit`: an entry covering a sensitive
      profile field is Admin-only, and a Reviewer holds `audit.view` without
      holding Admin rights. Filtered after the LIMIT — a non-admin's feed may
      run short of 8 rather than this route over-fetching to backfill.
    */
    const visibleActivity = isAdmin(tenant.role)
      ? recentActivity
      : recentActivity.filter((r) => !isSensitiveEntry(r));

    res.json({
      activeForms: activeForms?.count ?? 0,
      submissionsTotal: submissionsTotal?.count ?? 0,
      pendingReview: pendingReview?.count ?? 0,
      recentActivity: visibleActivity.map(auditEntryDto),
    });
  }),
);
