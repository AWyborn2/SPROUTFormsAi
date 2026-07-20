import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { auditEntryDto } from '../audit/record.js';
import { db } from '../db.js';

/** Read-only audit trail. Rows are written by `recordAudit` from other routes. */
export const auditRouter: Router = Router();

auditRouter.get(
  '/',
  requireTenant,
  requirePlanFeature('auditExport'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.auditLogEntries.findMany({
      where: eq(schema.auditLogEntries.orgId, tenant.orgId),
      orderBy: (a, { desc }) => [desc(a.createdAt)],
    });
    res.json(rows.map(auditEntryDto));
  }),
);
