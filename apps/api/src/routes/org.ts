import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import { PLAN_CONFIG, PLAN_TIERS, schema } from '@formai/db';
import type { PlanTier } from '@formai/db';
import { FORM_FONTS } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { db } from '../db.js';

/**
 * Org settings and billing info.
 *
 * PATCH /org — update name and/or branding (owner/admin; branding gated on plan).
 * GET  /org/billing — current plan, seat usage, features, and all tier configs.
 * POST /org/plan — DEV/TESTING ONLY: switch planTier directly (owner-only, no
 *   payment processing). Replace with real billing integration before going live.
 */
export const orgRouter: Router = Router();

const brandingBody = z.object({
  logoAssetUrl: z.string().nullable(),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  secondaryColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  formFont: z.enum(FORM_FONTS),
});

const patchOrgBody = z
  .object({
    name: z.string().trim().min(1).optional(),
    branding: brandingBody.optional(),
  })
  .refine((b) => b.name !== undefined || b.branding !== undefined, {
    message: 'At least one of name or branding is required',
  });

orgRouter.patch(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = patchOrgBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }

    // Branding changes require the branding plan feature.
    if (parsed.data.branding !== undefined) {
      const org = await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, tenant.orgId),
      });
      const tier = (org?.planTier ?? 'business') as PlanTier;
      const config = PLAN_CONFIG[tier] ?? PLAN_CONFIG.business;
      if (!config.features.branding) {
        res.status(403).json({
          error: 'feature_not_available',
          feature: 'branding',
          planTier: tier,
          message: `Your ${tier} plan does not include custom branding. Upgrade to access this feature.`,
        });
        return;
      }
    }

    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, tenant.orgId),
    });
    if (!org) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const { name, branding } = parsed.data;

    await db
      .update(schema.organizations)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(branding !== undefined ? { branding } : {}),
      })
      .where(eq(schema.organizations.id, tenant.orgId));

    const renamed = name !== undefined && name !== org.name;
    await recordAudit(db, tenant, {
      action: renamed ? 'Renamed organisation' : 'Updated organisation settings',
      target: renamed ? `${org.name} → ${name}` : 'Branding kit',
      category: 'settings',
      icon: 'settings',
    });

    res.json({
      id: org.id,
      name: name ?? org.name,
      branding: branding ?? org.branding,
    });
  }),
);

// ── GET /org/billing ──────────────────────────────────────────────────────

orgRouter.get(
  '/billing',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;

    const [org, seatCountResult] = await Promise.all([
      db.query.organizations.findFirst({
        where: eq(schema.organizations.id, tenant.orgId),
      }),
      db
        .select({ count: count() })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.orgId, tenant.orgId),
            eq(schema.memberships.status, 'active'),
          ),
        ),
    ]);

    if (!org) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const tier = (org.planTier ?? 'business') as PlanTier;
    const config = PLAN_CONFIG[tier] ?? PLAN_CONFIG.business;
    const seatUsed = seatCountResult[0]?.count ?? 0;

    res.json({
      planTier: tier,
      seatLimit: org.seatLimit,
      accountKind: org.accountKind,
      seatUsed,
      features: config.features,
      planConfig: PLAN_CONFIG,
    });
  }),
);

// ── POST /org/plan ────────────────────────────────────────────────────────
//
// DEV/TESTING ONLY — switches the org's planTier and updates seatLimit to
// the tier's default. No payment processing takes place here.
// Replace this endpoint with real billing integration (Stripe, etc.) before
// going live. Restricted to org owners only.

const postPlanBody = z.object({
  planTier: z.enum(PLAN_TIERS as [PlanTier, ...PlanTier[]]),
});

orgRouter.post(
  '/plan',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (tenant.role !== 'owner') {
      res.status(403).json({ error: 'forbidden', message: 'Only org owners can change the plan.' });
      return;
    }
    const parsed = postPlanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { planTier } = parsed.data;
    const config = PLAN_CONFIG[planTier];

    await db
      .update(schema.organizations)
      .set({ planTier, seatLimit: config.seatLimit })
      .where(eq(schema.organizations.id, tenant.orgId));

    await recordAudit(db, tenant, {
      action: 'Changed plan [DEV]',
      target: planTier,
      category: 'settings',
      icon: 'credit-card',
    });

    res.json({ planTier, seatLimit: config.seatLimit, features: config.features });
  }),
);
