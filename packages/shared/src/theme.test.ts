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
import { DEFAULT_THEME, resolveTheme, type ThemeTokens } from './theme.js';

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
