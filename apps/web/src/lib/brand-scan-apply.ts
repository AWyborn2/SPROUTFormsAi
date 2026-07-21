/**
 * Turns a scan proposal into a branding patch.
 *
 * Pure and separate from the panel because component rendering is untestable
 * in this workspace, and because "which fields does Apply actually change" is
 * the question a reviewer will ask about this feature.
 *
 * Two rules:
 *
 * 1. **Only what was found.** A key is present in the patch only when the scan
 *    produced a usable value, so applying a partial result never blanks a
 *    colour the owner already chose.
 * 2. **No logo.** `logoAssetUrl` accepts only URLs this API minted through the
 *    upload path, and the server enforces that. Writing a third-party URL
 *    straight from a scanned page would either be rejected or, worse, make the
 *    org's forms hotlink an image an outsider controls and can change later.
 *    The panel points the owner at the upload control instead.
 */
import type { BrandingKit } from '@formai/shared';
import { isValidFormFont } from '@formai/shared';
import type { BrandScanProposal } from './data/types.js';

const HEX = /^#[0-9a-f]{6}$/i;

function usableColor(value: string | undefined): string | null {
  return value && HEX.test(value) ? value.toLowerCase() : null;
}

/**
 * Build the patch an explicit "Apply" should write.
 *
 * `current` is accepted so a future refinement can avoid overwriting
 * hand-picked values; today Apply is an explicit user action on a reviewed
 * proposal, so a found value wins.
 */
export function buildScanPatch(
  proposal: BrandScanProposal,
  _current: BrandingKit,
): Partial<BrandingKit> {
  const patch: Partial<BrandingKit> = {};

  const primary = usableColor(proposal.colors.primary);
  const secondary = usableColor(proposal.colors.secondary);
  const accent = usableColor(proposal.colors.accent);

  if (primary) patch.primaryColor = primary;
  if (secondary) patch.secondaryColor = secondary;
  if (accent) patch.accentColor = accent;

  // Re-check the font against the catalog even though the server already did:
  // this value crossed the network, and an unknown family would be persisted
  // and then silently render as the fallback stack.
  if (proposal.font && isValidFormFont(proposal.font)) patch.formFont = proposal.font;

  return patch;
}
