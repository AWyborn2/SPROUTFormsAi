import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING, type BrandingKit } from '@formai/shared';
import { buildScanPatch } from './brand-scan-apply.js';
import type { BrandScanProposal } from './data/types.js';

const KIT: BrandingKit = { ...DEFAULT_BRANDING };

function proposal(patch: Partial<BrandScanProposal> = {}): BrandScanProposal {
  return {
    sourceUrl: 'https://example.com/',
    siteName: 'Example Co',
    colors: {},
    font: null,
    logoCandidates: [],
    palette: [],
    empty: false,
    notes: [],
    ...patch,
  };
}

describe('buildScanPatch', () => {
  it('maps found colours onto the branding fields', () => {
    const patch = buildScanPatch(
      proposal({ colors: { primary: '#3366CC', secondary: '#445566', accent: '#6ec792' } }),
      KIT,
    );
    expect(patch).toEqual({
      primaryColor: '#3366cc',
      secondaryColor: '#445566',
      accentColor: '#6ec792',
    });
  });

  /**
   * Partial results are the normal case. Applying two of three colours must
   * not blank the third, or a scan of a sparse site would quietly wipe
   * something the owner picked by hand.
   */
  it('omits colours the scan did not find', () => {
    const patch = buildScanPatch(proposal({ colors: { primary: '#3366cc' } }), KIT);
    expect(patch).toEqual({ primaryColor: '#3366cc' });
    expect(patch).not.toHaveProperty('secondaryColor');
    expect(patch).not.toHaveProperty('accentColor');
  });

  it('returns an empty patch when nothing was found', () => {
    expect(buildScanPatch(proposal({ empty: true }), KIT)).toEqual({});
  });

  it('applies a catalog font', () => {
    expect(buildScanPatch(proposal({ font: 'Lora' }), KIT).formFont).toBe('Lora');
  });

  /**
   * The server validates this too. Re-checking matters because the value
   * crossed the network: an unknown family would persist and then render as
   * the fallback stack with no explanation.
   */
  it('drops a font the catalog does not know', () => {
    expect(buildScanPatch(proposal({ font: 'Proprietary Sans' }), KIT)).not.toHaveProperty(
      'formFont',
    );
  });

  /**
   * `logoAssetUrl` only accepts URLs this API minted. Writing a scanned
   * third-party URL would be rejected server-side, and if it were not, the
   * org's public forms would hotlink an image an outsider can change later.
   */
  it('never applies a scanned logo URL directly', () => {
    const patch = buildScanPatch(
      proposal({ logoCandidates: ['https://evil.example/logo.svg'] }),
      KIT,
    );
    expect(patch).not.toHaveProperty('logoAssetUrl');
  });

  it.each([
    ['a named colour', 'rebeccapurple'],
    ['a partial hex', '#12'],
    ['a CSS payload', '#fff; background: url(//evil)'],
    ['an empty string', ''],
  ])('ignores %s', (_label, value) => {
    const patch = buildScanPatch(proposal({ colors: { primary: value } }), KIT);
    expect(patch).not.toHaveProperty('primaryColor');
  });

  it('does not mutate the current kit', () => {
    const kit = { ...KIT };
    buildScanPatch(proposal({ colors: { primary: '#3366cc' } }), kit);
    expect(kit).toEqual(KIT);
  });
});
