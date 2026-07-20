/**
 * Plan-tier gating decisions for the branding settings surface.
 *
 * Pure and separate from the screen because `apps/web` runs vitest in a `node`
 * environment (no jsdom), so the gate itself is what gets tested rather than
 * the rendered block. The flags arrive from `GET /org/billing`, which serves
 * `PLAN_CONFIG` in `packages/db/src/plans.ts` verbatim.
 */

import type { PlanFeatures } from './data/types.js';

export interface BlockAccess {
  editable: boolean;
  /** Upgrade copy for the gated state; `null` whenever the block is editable. */
  upgradeHint: string | null;
}

const EDITABLE: BlockAccess = { editable: true, upgradeHint: null };

const WHITE_LABEL_HINT =
  'Custom form domains and sender addresses are part of the Business plan.';

type Features = Pick<PlanFeatures, 'branding' | 'whiteLabel'>;

/**
 * The logo/colours/font block. Branding is free at every tier (R9), so an
 * unresolved billing read opens rather than locks it — a brief flash of a
 * padlock on a feature nobody is ever denied would be a lie either way.
 */
export function brandingBlockAccess(features: Features | null | undefined): BlockAccess {
  return features == null || features.branding ? EDITABLE : { editable: false, upgradeHint: null };
}

/**
 * Custom domain / sender address / badge removal. This is the *only* consumer
 * of the `whiteLabel` flag: the old `PATCH /org` branding gate was removed when
 * branding went free, so without this check white-label would be free too.
 * Fails closed while billing is unresolved.
 */
export function whiteLabelBlockAccess(features: Features | null | undefined): BlockAccess {
  return features?.whiteLabel ? EDITABLE : { editable: false, upgradeHint: WHITE_LABEL_HINT };
}
