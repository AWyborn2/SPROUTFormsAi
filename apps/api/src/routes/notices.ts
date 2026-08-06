import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { db } from '../db.js';

/**
 * A person's own expiry notices (U21). This own-scope read is the second of the
 * two delivery routes R98 names: a login. Rendering the sent-notice rows on a
 * person's own record means someone with a login but no reachable email address
 * is still notified — which is why "unreachable" (R99) means holding no login AND
 * an address an Admin has marked unreachable, not merely a bad email.
 *
 * OWN-SCOPE, like a candidate reading their own assessments: the caller reads
 * their OWN notices only, so the permission matrix does not gate it.
 */
export const noticesRouter: Router = Router();

noticesRouter.get(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.sentNotices.findMany({
      where: and(
        eq(schema.sentNotices.orgId, tenant.orgId),
        eq(schema.sentNotices.userId, tenant.userId),
      ),
      orderBy: (t) => [desc(t.sentAt)],
    });
    if (rows.length === 0) {
      res.json([]);
      return;
    }
    const competencies = await db.query.competencies.findMany({
      where: inArray(
        schema.competencies.id,
        rows.map((r) => r.competencyId),
      ),
    });
    const nameById = new Map(competencies.map((c) => [c.id, c.name]));
    res.json(
      rows.map((r) => ({
        id: r.id,
        competencyId: r.competencyId,
        competencyName: nameById.get(r.competencyId) ?? 'A competency',
        expiresOn: r.expiresOn,
        sentAt: r.sentAt.toISOString(),
      })),
    );
  }),
);
