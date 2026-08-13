import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { auditEntryDto, isSensitiveEntry } from '../audit/record.js';
import { db } from '../db.js';

/** Read-only audit trail. Rows are written by `recordAudit` from other routes. */
export const auditRouter: Router = Router();

/** Owner holds everything Admin holds, so both pass every Admin-only rule. */
function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

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
    /*
      R58: an entry covering a sensitive profile field is Admin-only.

      This NARROWS the Reviewer's existing audit read rather than removing it —
      a Reviewer holds `audit.view` today without holding Admin rights, so the
      two meet here. The filter compares the entry's structured `field` against
      the inventory's sensitive marks; an entry whose field is null (every entry
      that is not about one field, and every entry written before the column
      existed) is untouched.
    */
    const visible = isAdmin(tenant.role) ? rows : rows.filter((r) => !isSensitiveEntry(r));
    res.json(visible.map(auditEntryDto));
  }),
);
