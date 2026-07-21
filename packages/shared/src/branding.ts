/**
 * Org branding kit — set up during onboarding (not deferred), applied to every
 * form the org publishes, especially external-facing ones.
 */

import { findGoogleFont } from './google-fonts-catalog.js';
import type { ThemeTokens } from './theme.js';

/**
 * The quick-pick presets surfaced above the font search in the branding
 * picker — a curated shortlist, NOT the set of legal values. Any family in
 * `GOOGLE_FONTS_CATALOG` is selectable and persistable; these four are simply
 * what the product has always offered, and remain valid by construction
 * (the catalog lists them first).
 */
export const FORM_FONTS = ['Inter', 'Sora', 'Spectral', 'JetBrains Mono'] as const;

/**
 * A Google Fonts family name. Widened from the old four-value union to a
 * string validated against the bundled catalog — see `isValidFormFont`, which
 * is what the API enforces. Kept as a named alias so the intent at each use
 * site stays legible.
 */
export type FormFont = string;

/** True when `family` is a family the bundled Google Fonts catalog knows. */
export function isValidFormFont(family: string): boolean {
  return findGoogleFont(family) !== undefined;
}

/**
 * The weights `family` actually ships, or `null` for an unknown family.
 * Callers building a `css2` URL must intersect these with the weights they
 * need: requesting a weight a family lacks fails the whole request.
 */
export function getFontWeights(family: string): readonly number[] | null {
  return findGoogleFont(family)?.weights ?? null;
}

export interface BrandingKit {
  /** Public URL of the uploaded logo asset (Supabase Storage), or null. */
  logoAssetUrl: string | null;
  /** Hex colors, e.g. "#253439". */
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  formFont: FormFont;
  /**
   * Optional theme layered on top of the kit — colour and typography roles,
   * button and surface styling, density, logo geometry, layout type.
   *
   * Optional rather than required, and stored inside the existing `branding`
   * jsonb column rather than beside it, so adding it needs no migration and an
   * org that predates theming keeps rendering exactly as before: absent means
   * `DEFAULT_THEME`.
   */
  theme?: ThemeTokens;
}

/** FormAI's own defaults, mirroring the prototype's initial brand state. */
export const DEFAULT_BRANDING: BrandingKit = {
  logoAssetUrl: null,
  primaryColor: '#253439',
  secondaryColor: '#7c898b',
  accentColor: '#6ec792',
  formFont: 'Inter',
};

/** Decoded-bytes ceiling for an uploaded org logo. Logos are marks, not photography. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * Perceived luminance in 0..1 from 8-bit channels. Shared so `contrastText`
 * and the logo palette extractor judge lightness by the same rule.
 */
export function channelLuminance(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** The two inks `contrastText` chooses between for a given background. */
export interface InkPair {
  /** Used when the background is light. */
  dark: string;
  /** Used when the background is dark. */
  light: string;
}

/**
 * The product's original pair. `#12321f` is Sprout-green-specific rather than a
 * neutral, which is fine for the brand primary and accent it was written for.
 * Roles carrying arbitrary customer colours can pass their own pair instead.
 */
export const DEFAULT_INK: InkPair = { dark: '#12321f', light: '#ffffff' };

export function contrastText(hex: string): '#12321f' | '#ffffff';
export function contrastText(hex: string, ink: InkPair): string;
/**
 * Contrast rule: returns the readable text color for a given background hex
 * (luminance > 0.62 -> dark ink, else light). Mirrors the prototype's
 * `contrastText()`.
 *
 * Called with one argument it behaves exactly as before, so existing callers
 * and their assertions are untouched. The optional `ink` pair exists because a
 * theme applies this rule to arbitrary customer-chosen role colours, where the
 * brand-specific dark is not always the right answer.
 */
export function contrastText(hex: string, ink: InkPair = DEFAULT_INK): string {
  try {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return ink.dark;
    return channelLuminance(r, g, b) > 0.62 ? ink.dark : ink.light;
  } catch {
    return ink.dark;
  }
}
