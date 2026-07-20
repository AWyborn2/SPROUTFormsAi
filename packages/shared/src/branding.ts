/**
 * Org branding kit — set up during onboarding (not deferred), applied to every
 * form the org publishes, especially external-facing ones.
 */

import { findGoogleFont } from './google-fonts-catalog.js';

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

/**
 * Contrast rule: Sprout Green only passes contrast with dark ink text on top.
 * Returns the readable text color for a given background hex. Mirrors the
 * prototype's `contrastText()` (luminance > 0.62 -> dark ink, else white).
 */
export function contrastText(hex: string): '#12321f' | '#ffffff' {
  try {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return channelLuminance(r, g, b) > 0.62 ? '#12321f' : '#ffffff';
  } catch {
    return '#12321f';
  }
}
