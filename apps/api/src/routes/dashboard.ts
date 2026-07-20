import { Router } from 'express';
import { and, count, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { auditEntryDto } from '../audit/record.js';
import { db } from '../db.js';

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
      db
        .select({ count: count() })
        .from(schema.submissions)
        .where(eq(schema.submissions.orgId, tenant.orgId)),
      db
        .select({ count: count() })
        .from(schema.submissions)
        .where(
          and(
            eq(schema.submissions.orgId, tenant.orgId),
            inArray(schema.submissions.status, [...PENDING_REVIEW_STATUSES]),
          ),
        ),
      db.query.auditLogEntries.findMany({
        where: eq(schema.auditLogEntries.orgId, tenant.orgId),
        orderBy: (a, { desc }) => [desc(a.createdAt)],
        limit: RECENT_ACTIVITY_LIMIT,
      }),
    ]);

    res.json({
      activeForms: activeForms?.count ?? 0,
      submissionsTotal: submissionsTotal?.count ?? 0,
      pendingReview: pendingReview?.count ?? 0,
      recentActivity: recentActivity.map(auditEntryDto),
    });
  }),
);
