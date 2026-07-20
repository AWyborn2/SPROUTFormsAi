import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { PLAN_CONFIG, schema } from '@formai/db';
import type { PlanFeatures } from '@formai/db';
import { db } from '../db.js';

/**
 * Middleware that enforces plan-level feature access.
 *
 * Must be placed AFTER `requireTenant` in the middleware chain so that
 * `req.tenant` is already populated. Returns 403 with `feature_not_available`
 * if the org's current plan does not include the requested feature.
 *
 * Usage:
 *   router.get('/', requireTenant, requirePlanFeature('auditExport'), handler)
 */
export function requirePlanFeature(feature: keyof PlanFeatures): RequestHandler {
  return async (req, res, next) => {
    if (!req.tenant) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    try {
      const org = await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, req.tenant.orgId),
      });
      if (!org) {
        res.status(404).json({ error: 'org_not_found' });
        return;
      }
      const tier = (org.planTier ?? 'business') as keyof typeof PLAN_CONFIG;
      const config = PLAN_CONFIG[tier] ?? PLAN_CONFIG.business;
      if (!config.features[feature]) {
        res.status(403).json({
          error: 'feature_not_available',
          feature,
          planTier: tier,
          message: `Your ${tier} plan does not include ${feature}. Upgrade to access this feature.`,
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
