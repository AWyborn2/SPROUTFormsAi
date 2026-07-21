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
import { runBrandScan } from '../brand-scan/scan.js';
import { SafeFetchError } from '../brand-scan/safe-fetch.js';
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

/**
 * Per-org rate limit for the brand scan.
 *
 * This is the only endpoint that makes the server perform an outbound request
 * to an address the caller chooses, which makes it usable as a traffic
 * amplifier or a port scanner even with the SSRF guard refusing private
 * space. `POST /org/logo` shipped without a limit and that gap is a known
 * residual risk; this one starts with one rather than inheriting it.
 *
 * Deliberately in-process: this API runs as a single instance today, and a
 * shared store would be reached for when that stops being true.
 */
const SCAN_WINDOW_MS = 60_000;
const SCAN_MAX_PER_WINDOW = 5;
const scanHits = new Map<string, number[]>();

function scanRateLimited(orgId: string, now = Date.now()): boolean {
  const recent = (scanHits.get(orgId) ?? []).filter((t) => now - t < SCAN_WINDOW_MS);
  if (recent.length >= SCAN_MAX_PER_WINDOW) {
    scanHits.set(orgId, recent);
    return true;
  }
  recent.push(now);
  scanHits.set(orgId, recent);
  return false;
}

/**
 * A theme colour role. Unlike the three brand colours these may be empty:
 * `''` means "keep the product's own token", which is how an unset role is
 * represented and what stops the emitter blanking a surface out.
 */
const roleColor = z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/i)]);

/**
 * Type sizes are bounded rather than free numbers — the value is emitted
 * straight into a CSS custom property, and an absurd size is a defacement
 * vector on a public respondent-facing page, not just a bad look.
 */
const typeSize = z.number().int().min(8).max(96);

/** Only weights the font loader actually requests; see THEME_FONT_WEIGHTS. */
const typeWeight = z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]);

/**
 * Every key optional and unknown keys stripped: a theme is a sparse patch, and
 * `resolveTheme` treats absent as inherit. `.strict()` is deliberately not used
 * — a client on an older build sending a key this server does not know yet
 * should have it ignored, not have the whole save rejected.
 */
const themeBody = z.object({
  pageBackground: roleColor.optional(),
  formBackground: roleColor.optional(),
  headingColor: roleColor.optional(),
  bodyColor: roleColor.optional(),
  labelColor: roleColor.optional(),

  headingSize: typeSize.optional(),
  headingWeight: typeWeight.optional(),
  bodySize: typeSize.optional(),
  bodyWeight: typeWeight.optional(),
  labelSize: typeSize.optional(),
  labelWeight: typeWeight.optional(),
  buttonSize: typeSize.optional(),
  buttonWeight: typeWeight.optional(),

  buttonShape: z.enum(['rounded', 'pill', 'square']).optional(),
  buttonStyle: z.enum(['solid', 'outline', 'soft']).optional(),

  radius: z.number().int().min(0).max(64).optional(),
  borderWidth: z.number().int().min(0).max(8).optional(),
  borderColor: roleColor.optional(),
  shadow: z.enum(['none', 'sm', 'md', 'lg']).optional(),

  density: z.enum(['compact', 'comfortable', 'spacious']).optional(),

  logoSize: z.enum(['small', 'medium', 'large']).optional(),
  logoPlacement: z.enum(['left', 'center']).optional(),

  layout: z.enum(['card', 'hero', 'split', 'conversational']).optional(),
});

const brandScanBody = z.object({ url: z.string().min(1).max(2048) });

/**
 * Propose a theme from the org's own website (R15).
 *
 * Never applies anything: the response is a draft the owner reviews, edits and
 * confirms. That human step is the load-bearing control, because every value
 * here originates from a document the org's own visitors — and anyone else —
 * can influence.
 */
orgRouter.post('/brand-scan', requireTenant, withErrorHandling(async (req, res) => {
  const tenant = req.tenant!;
  if (tenant.role !== 'owner' && tenant.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = brandScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }
  if (scanRateLimited(tenant.orgId)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  // A bare domain is what people type, so add a scheme when there is none.
  // The check is for *any* scheme, not just http(s): testing only for
  // `http(s)://` would rewrite `file:///etc/passwd` into
  // `https://file:///etc/passwd`, turning a value the guard would have
  // rejected outright into a hostname lookup. Anything with a scheme is passed
  // through untouched so `assertFetchableUrl` can refuse it on its merits.
  const raw = parsed.data.url.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  const candidate = hasScheme ? raw : `https://${raw}`;

  try {
    const proposal = await runBrandScan(candidate);
    res.json(proposal);
  } catch (err) {
    if (err instanceof SafeFetchError) {
      // The guard's reason is safe to surface: it tells an owner who typed an
      // internal hostname why it was refused, and reveals nothing they could
      // not learn by trying the URL in their own browser.
      res.status(422).json({ error: 'scan_failed', reason: err.code, detail: err.message });
      return;
    }
    throw err;
  }
}));

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
  /** Optional theme layer. Absent leaves the org on the product defaults. */
  theme: themeBody.optional(),
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
