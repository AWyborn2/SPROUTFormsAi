import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq, isNull } from 'drizzle-orm';
import { PLAN_CONFIG, PLAN_TIERS, schema } from '@formai/db';
import type { PlanTier } from '@formai/db';
import { isValidFormFont } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { deleteSupersededLogo, logoKeyFromPublicUrl } from './assets.js';
import { db } from '../db.js';

/**
 * Org settings and billing info.
 *
 * PATCH /org — update name, branding, teamSize, and/or stamp onboarding
 *   completion (owner/admin; branding is available on every plan).
 * GET  /org/billing — current plan, seat usage, features, and all tier configs.
 * POST /org/plan — DEV/TESTING ONLY: switch planTier directly (owner-only, no
 *   payment processing). Replace with real billing integration before going live.
 */
export const orgRouter: Router = Router();

const brandingBody = z.object({
  // Only a URL this API minted (`POST /org/logo` → `logoPublicUrl`) is
  // storable. An arbitrary string would let an admin point their org at
  // another tenant's logo key — or at an off-site host — while bypassing the
  // upload path entirely. Externally-hosted logos are therefore unsupported,
  // which matches the shipped client: `LogoUploadControl` only ever writes
  // back a value returned by `POST /org/logo`. The owning-org check lives in
  // the handler, where the tenant is known.
  logoAssetUrl: z
    .string()
    .nullable()
    .refine((v) => v === null || logoKeyFromPublicUrl(v) !== null, {
      message: 'logoAssetUrl must be a URL returned by POST /org/logo',
    }),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  secondaryColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  // Any family in the bundled Google Fonts catalog, not just the four legacy
  // presets. Validated against the closed snapshot rather than accepted as a
  // free string: the web app interpolates this value straight into a
  // `fonts.googleapis.com/css2` URL, so an arbitrary string would be an
  // injection point into that request (and into the CSS `font-family` stack).
  formFont: z.string().refine(isValidFormFont, { message: 'Unknown font family' }),
});

const patchOrgBody = z
  .object({
    name: z.string().trim().min(1).optional(),
    branding: brandingBody.optional(),
    /** Self-reported team size bucket (e.g. '2-5'). Display/analytics only. */
    teamSize: z.string().trim().min(1).max(32).optional(),
    /** Marks the onboarding wizard finished. Stamps once; repeats are no-ops. */
    onboardingComplete: z.literal(true).optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.branding !== undefined ||
      b.teamSize !== undefined ||
      b.onboardingComplete !== undefined,
    { message: 'At least one of name, branding, teamSize or onboardingComplete is required' },
  );

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

    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, tenant.orgId),
    });
    if (!org) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const { name, branding, teamSize, onboardingComplete } = parsed.data;

    // The Zod refine proved the URL is one we minted; this proves it is *ours*.
    // Without it an admin could assign another tenant's logo key to their org.
    if (branding?.logoAssetUrl) {
      const key = logoKeyFromPublicUrl(branding.logoAssetUrl);
      if (!key || !key.startsWith(`${tenant.orgId}/`)) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'logoAssetUrl must reference a logo owned by this organisation.',
        });
        return;
      }
    }

    const updates = {
      ...(name !== undefined ? { name } : {}),
      ...(branding !== undefined ? { branding } : {}),
      ...(teamSize !== undefined ? { teamSize } : {}),
    };
    if (Object.keys(updates).length > 0) {
      await db
        .update(schema.organizations)
        .set(updates)
        .where(eq(schema.organizations.id, tenant.orgId));
    }

    // Stamp completion only once. The read above is an optimisation, not the
    // guard: two concurrent completion PATCHes both see a null column, so the
    // UPDATE itself carries `isNull(...)` and the DB decides the winner. An
    // empty `returning()` means someone else stamped first — keep their
    // timestamp rather than overwriting it, and don't re-audit.
    let onboardingCompletedAt = org.onboardingCompletedAt ?? null;
    let stamped = false;
    if (onboardingComplete === true && onboardingCompletedAt == null) {
      const rows = await db
        .update(schema.organizations)
        .set({ onboardingCompletedAt: new Date() })
        .where(
          and(
            eq(schema.organizations.id, tenant.orgId),
            isNull(schema.organizations.onboardingCompletedAt),
          ),
        )
        .returning({ onboardingCompletedAt: schema.organizations.onboardingCompletedAt });
      const won = rows[0]?.onboardingCompletedAt ?? null;
      if (won) {
        onboardingCompletedAt = won;
        stamped = true;
      }
    }

    // A branding write that swaps in a different logo strands the old object.
    // Reap it best-effort so a superseded logo isn't publicly reachable
    // forever. Deliberately un-awaited: the settings write has already landed
    // and the result is never read, so storage latency must not sit in front
    // of the client's response. `deleteSupersededLogo` swallows its own
    // failures; the `.catch` is belt-and-braces against an unhandled rejection.
    if (branding !== undefined) {
      const previousUrl = (org.branding as { logoAssetUrl?: string | null } | null)?.logoAssetUrl ?? null;
      if (previousUrl && previousUrl !== branding.logoAssetUrl) {
        void deleteSupersededLogo(tenant.orgId, previousUrl).catch(() => {});
      }
    }

    // Audit what actually changed. A teamSize-only or onboarding-only PATCH is
    // not a branding edit, and a PATCH that changed nothing isn't an event.
    const renamed = name !== undefined && name !== org.name;
    const changed = renamed || branding !== undefined || teamSize !== undefined || stamped;
    if (changed) {
      await recordAudit(db, tenant, {
        action: renamed ? 'Renamed organisation' : 'Updated organisation settings',
        target: renamed
          ? `${org.name} → ${name}`
          : branding !== undefined
            ? 'Branding kit'
            : stamped
              ? 'Onboarding completed'
              : 'Organisation details',
        category: 'settings',
        icon: 'settings',
      });
    }

    res.json({
      id: org.id,
      name: name ?? org.name,
      branding: branding ?? org.branding,
      teamSize: teamSize ?? org.teamSize ?? null,
      onboardingCompletedAt: onboardingCompletedAt?.toISOString() ?? null,
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
