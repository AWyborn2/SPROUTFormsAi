/**
 * The one precedence rule in the system.
 *
 * Every themed surface resolves through `resolveTheme` and none reads a raw
 * theme object, so "absent means inherit" holds by construction rather than by
 * convention — which only stays true if the layering itself is right. These
 * tests pin the ORDER and the meaning of an absent key, because both are
 * invisible at the call site: a wrong order shows up as a client's form quietly
 * rendering in our colours, which looks like a working page.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  resolveTheme,
  sanitizeThemeValues,
  type ThemeTokens,
} from './theme.js';

describe('resolveTheme', () => {
  it('returns the product defaults when no layer sets anything', () => {
    // An org that has never opened the theme editor renders exactly as before
    // the editor existed.
    expect(resolveTheme()).toEqual(DEFAULT_THEME);
    expect(resolveTheme(null, undefined, {})).toEqual(DEFAULT_THEME);
  });

  it('lets a later layer win over an earlier one', () => {
    expect(resolveTheme({ radius: 4 }, { radius: 20 }).radius).toBe(20);
  });

  it('fills only the keys a layer actually sets', () => {
    // The heart of "sparse patch": a brand that sets one colour says one
    // colour, and everything else still comes from the layer beneath.
    const resolved = resolveTheme({ radius: 4, headingSize: 30 }, { radius: 20 });
    expect(resolved.radius).toBe(20);
    expect(resolved.headingSize).toBe(30);
  });

  it('treats an explicitly-undefined key as "not set", not as "reset"', () => {
    /*
      A plain spread would do the opposite and punch a hole through the lower
      layer — `{ radius: undefined }` arriving from a form that cleared one
      field would blank a value the org had deliberately chosen.
    */
    expect(resolveTheme({ radius: 4 }, { radius: undefined }).radius).toBe(4);
  });

  it('drops keys that are not theme tokens', () => {
    // A stale or hand-edited payload must not be able to inject arbitrary
    // values into the emitted CSS.
    const resolved = resolveTheme({ evil: 'red' } as unknown as ThemeTokens);
    expect('evil' in resolved).toBe(false);
  });

  describe('the layer order a fill surface uses (see resolveBrandKit)', () => {
    /*
      DEFAULTS → ORG → BRAND → FORM OVERRIDE.

      The brand sits ABOVE the org, which is the whole reason this is variadic.
      For a subcontractor most forms carry a CLIENT's brand, so the org's theme
      is the fallback for a form nobody assigned — not a baseline everything
      deviates from. Getting this backwards puts our colours on a client's
      document, which is precisely the confusion the feature removes.
    */
    const org: ThemeTokens = { radius: 4, headingColor: '#000000', bodySize: 12 };
    const brand: ThemeTokens = { radius: 20, headingColor: '#0044cc' };
    const formOverride: ThemeTokens = { headingColor: '#ff0000' };

    it('lets a brand beat the org', () => {
      expect(resolveTheme(org, brand, formOverride).radius).toBe(20);
    });

    it('lets a per-form override beat its brand, for a genuine one-off', () => {
      expect(resolveTheme(org, brand, formOverride).headingColor).toBe('#ff0000');
    });

    it('still inherits from the org where neither the brand nor the form speaks', () => {
      expect(resolveTheme(org, brand, formOverride).bodySize).toBe(12);
    });

    it('falls back to the org theme for a form with no brand', () => {
      // Unassigned is not the same statement as "ours", but the org's theme is
      // the right thing to render for it.
      expect(resolveTheme(org, null, null).radius).toBe(4);
    });
  });

  it('keeps the meaning of the two-argument calls that predate brands', () => {
    // Every existing caller passes (orgTheme, formOverride) and must not have
    // changed behaviour when the signature became variadic.
    expect(resolveTheme({ radius: 4 }, { radius: 20 })).toEqual({
      ...DEFAULT_THEME,
      radius: 20,
    });
  });
});

describe('sanitizeThemeValues', () => {
  /*
    `sanitize` drops unknown KEYS but keeps whatever value a known key carries,
    which is fine for the theme editor — every control there is a select or a
    bounded number input, so the UI is the guard. It is not fine for a patch
    authored anywhere else, and a theme value ends up in a CSS custom property.
  */
  it('keeps a legal value', () => {
    expect(sanitizeThemeValues({ radius: 20, density: 'compact' }).theme).toEqual({
      radius: 20,
      density: 'compact',
    });
  });

  it('DROPS a value out of range rather than clamping it', () => {
    /*
      Clamping turns "make the corners 400px round" into a silent 40 and leaves
      the author believing the instruction was understood. Dropping it says so,
      and they ask again.
    */
    const { theme, rejected } = sanitizeThemeValues({ radius: 400 });
    expect(theme.radius).toBeUndefined();
    expect(rejected).toEqual(['radius: 400']);
  });

  it('refuses a value outside an enum', () => {
    expect(sanitizeThemeValues({ layout: 'spiral' as never }).theme.layout).toBeUndefined();
  });

  it('refuses a font weight the loader cannot request', () => {
    // A css2 request fails ENTIRELY when it asks for a weight the family does
    // not publish, so an out-of-set weight breaks the whole stylesheet.
    expect(sanitizeThemeValues({ headingWeight: 350 as never }).theme.headingWeight).toBeUndefined();
    expect(sanitizeThemeValues({ headingWeight: 700 }).theme.headingWeight).toBe(700);
  });

  it('REFUSES A COLOUR THAT IS NOT A HEX VALUE', () => {
    // These reach CSS custom properties. Anything that is not six hex digits is
    // not a colour and has no business being emitted.
    const { theme, rejected } = sanitizeThemeValues({
      headingColor: 'url(https://evil.example/x)' as never,
    });
    expect(theme.headingColor).toBeUndefined();
    expect(rejected).toHaveLength(1);
  });

  it('keeps the empty string on a colour role', () => {
    // `''` means "use the product default", which is a real choice not a blank.
    expect(sanitizeThemeValues({ headingColor: '' }).theme.headingColor).toBe('');
  });

  it('normalises hex case, so two spellings of one colour compare equal', () => {
    expect(sanitizeThemeValues({ headingColor: '#0044CC' }).theme.headingColor).toBe('#0044cc');
  });

  it('drops unknown keys without reporting them as rejected values', () => {
    // An unknown key is not a value the author asked for — it is noise, and
    // naming it would put junk in front of somebody who cannot act on it.
    const { theme, rejected } = sanitizeThemeValues({ evil: 'red' } as never);
    expect(theme).toEqual({});
    expect(rejected).toEqual([]);
  });
});
