/**
 * Plan-tier gating decisions for the authed surfaces.
 *
 * Pure and separate from the screens because `apps/web` runs vitest in a `node`
 * environment (no jsdom), so the gate itself is what gets tested rather than
 * the rendered block. The flags arrive from `GET /org/billing`, which serves
 * `PLAN_CONFIG` in `packages/db/src/plans.ts` verbatim.
 *
 * The fail-open/fail-closed choice is per feature and is the whole point of
 * each function's comment: a free feature opens while billing is unresolved, a
 * paid one stays shut. Guessing "open" on a paid feature hands it out for the
 * duration of a slow billing read; guessing "shut" on a free one shows a
 * padlock nobody is ever behind.
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

const SMART_FILL_HINT =
  'Filling a whole form by voice is part of the Business plan. Dictating into a single field stays free on every plan.';

type Features = Pick<PlanFeatures, 'branding' | 'whiteLabel' | 'smartFill'>;

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

/**
 * Smart Fill — one spoken description of a form mapped onto many answers at
 * once — on the AUTHED surfaces (builder preview, mobile inspection), where
 * `useBilling()` exists. Fails closed like white-label: it bills a model call
 * per press, and the API's `requirePlanFeature('smartFill')` refuses anyway, so
 * an optimistic control while billing loads only buys a 403 the respondent has
 * to interpret.
 *
 * Nothing here gates the per-field mic: on-device dictation is free at every
 * tier and must never consult this. The public fill page has no session to read
 * these flags from at all — it gates on `PublicFillForm.smartFillEnabled`,
 * which the link token's own org resolves server-side.
 */
export function smartFillBlockAccess(features: Features | null | undefined): BlockAccess {
  return features?.smartFill ? EDITABLE : { editable: false, upgradeHint: SMART_FILL_HINT };
}
