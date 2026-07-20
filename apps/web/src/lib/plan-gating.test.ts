import { describe, expect, it } from 'vitest';
import type { PlanFeatures, PlanTier } from './data/types.js';
import { brandingBlockAccess, whiteLabelBlockAccess } from './plan-gating.js';

/**
 * Mirrors `PLAN_CONFIG` in `packages/db/src/plans.ts` for the two flags this
 * screen reads. Duplicated rather than imported because `apps/web` does not
 * depend on `@formai/db` — the server sends these values on `GET /org/billing`.
 */
const FEATURES: Record<PlanTier, PlanFeatures> = {
  individual: {
    branding: true,
    whiteLabel: false,
    sso: false,
    auditExport: false,
    competencyGating: false,
  },
  team: {
    branding: true,
    whiteLabel: false,
    sso: false,
    auditExport: false,
    competencyGating: false,
  },
  business: {
    branding: true,
    whiteLabel: true,
    sso: false,
    auditExport: true,
    competencyGating: false,
  },
  enterprise: {
    branding: true,
    whiteLabel: true,
    sso: true,
    auditExport: true,
    competencyGating: true,
  },
};

describe('branding block access', () => {
  // R9: branding is the product hook — free at every tier, including the ones
  // that had `features.branding: false` before this feature.
  it('is editable on every tier', () => {
    for (const tier of Object.keys(FEATURES) as PlanTier[]) {
      expect(brandingBlockAccess(FEATURES[tier])).toEqual({ editable: true, upgradeHint: null });
    }
  });

  it('stays editable while billing has not loaded, so the free block never flashes locked', () => {
    expect(brandingBlockAccess(undefined).editable).toBe(true);
    expect(brandingBlockAccess(null).editable).toBe(true);
  });
});

describe('white-label block access', () => {
  // AE4 (gated half). The old `PATCH /org` branding gate is gone, so this is
  // the only place white-label is still held behind the plan.
  it('is gated with an upgrade hint on individual and team tiers', () => {
    for (const tier of ['individual', 'team'] as const) {
      const access = whiteLabelBlockAccess(FEATURES[tier]);
      expect(access.editable).toBe(false);
      expect(access.upgradeHint).toBeTruthy();
    }
  });

  it('is editable on business and enterprise', () => {
    for (const tier of ['business', 'enterprise'] as const) {
      expect(whiteLabelBlockAccess(FEATURES[tier])).toEqual({ editable: true, upgradeHint: null });
    }
  });

  it('fails closed when the feature set is unknown', () => {
    expect(whiteLabelBlockAccess(undefined).editable).toBe(false);
    expect(whiteLabelBlockAccess(null).editable).toBe(false);
  });
});
