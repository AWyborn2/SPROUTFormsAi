/**
 * How a client's brand layers over the org's own kit.
 *
 * The whole point of a brand is that a SUBCONTRACTOR's forms mostly carry
 * somebody else's identity. That makes the layer order load-bearing in a way it
 * is not for an org theming its own forms: getting it backwards renders a
 * client's document in our colours, which looks like a perfectly working page
 * and is exactly the confusion this feature exists to remove.
 */
import { describe, expect, it } from 'vitest';
import type { BrandingKit } from './branding.js';
import { resolveBrandKit, type FormBrandKit } from './form-brand.js';

const ORG: BrandingKit = {
  logoAssetUrl: '/api/assets/logo/org-1/logo-ours.png',
  primaryColor: '#253439',
  secondaryColor: '#7c898b',
  accentColor: '#6ec792',
  formFont: 'Inter',
  theme: { radius: 4, density: 'compact' },
};

describe('resolveBrandKit', () => {
  it('returns the org’s own kit when the form has no brand', () => {
    // Unassigned is the common case and must cost nothing.
    const kit = resolveBrandKit(ORG, null);
    expect(kit.primaryColor).toBe('#253439');
    expect(kit.logoAssetUrl).toBe('/api/assets/logo/org-1/logo-ours.png');
  });

  it('replaces the colours and font the brand sets', () => {
    const kit = resolveBrandKit(ORG, { primaryColor: '#0044cc', formFont: 'Roboto' });
    expect(kit.primaryColor).toBe('#0044cc');
    expect(kit.formFont).toBe('Roboto');
  });

  it('inherits everything the brand does not mention', () => {
    // Sparse is the point: a brand that sets one colour says one colour.
    const kit = resolveBrandKit(ORG, { primaryColor: '#0044cc' });
    expect(kit.secondaryColor).toBe('#7c898b');
    expect(kit.formFont).toBe('Inter');
  });

  it('SHOWS THE BRAND’S LOGO INSTEAD OF THE ORG’S', () => {
    // The one a respondent notices first — they believe they are looking at
    // their own company's document.
    const kit = resolveBrandKit(ORG, { logoAssetUrl: '/api/assets/logo/org-1/logo-client.png' });
    expect(kit.logoAssetUrl).toBe('/api/assets/logo/org-1/logo-client.png');
  });

  it('treats an explicit null logo as "this brand shows none"', () => {
    /*
      Distinct from absent, which inherits. Without the distinction a client
      with no logo of their own would get OURS on their form, and there would be
      no way to say otherwise.
    */
    expect(resolveBrandKit(ORG, { logoAssetUrl: null }).logoAssetUrl).toBeNull();
    expect(resolveBrandKit(ORG, { primaryColor: '#0044cc' }).logoAssetUrl).toBe(
      '/api/assets/logo/org-1/logo-ours.png',
    );
  });

  it('LAYERS the theme rather than replacing it', () => {
    // A brand that sets three tokens says three tokens. Replacing the object
    // would silently reset every token the org had chosen.
    const kit = resolveBrandKit(ORG, { theme: { radius: 20 } });
    expect(kit.theme!.radius).toBe(20);
    expect(kit.theme!.density).toBe('compact');
  });

  it('lets a per-form theme override beat the brand', () => {
    // A genuine one-off inside a client's brand is a real thing, and the
    // override is the narrower statement.
    const kit = resolveBrandKit(ORG, { theme: { radius: 20 } }, { radius: 0 });
    expect(kit.theme!.radius).toBe(0);
  });

  it('drops keys that are not part of a brand kit', () => {
    /*
      Including `voiceInput`, which the type deliberately omits: it is a
      workspace POLICY about whether people may dictate into forms, not part of
      a client's visual identity. Adding a client must not silently change what
      respondents are allowed to do.
    */
    const kit = resolveBrandKit(ORG, { voiceInput: false } as unknown as FormBrandKit);
    expect('voiceInput' in kit).toBe(false);
  });

  it('falls back to the product defaults when the org has no kit at all', () => {
    // Defensive: `organizations.branding` is nullable, and a brand must still
    // resolve to something renderable rather than throwing on a fill page.
    expect(resolveBrandKit(null, { primaryColor: '#0044cc' }).primaryColor).toBe('#0044cc');
    expect(resolveBrandKit(null, null).formFont).toBeTruthy();
  });
});
