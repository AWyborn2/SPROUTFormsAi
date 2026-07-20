/**
 * Org branding kit — set up during onboarding (not deferred), applied to every
 * form the org publishes, especially external-facing ones.
 */

export const FORM_FONTS = ['Inter', 'Sora', 'Spectral', 'JetBrains Mono'] as const;
export type FormFont = (typeof FORM_FONTS)[number];

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
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.62 ? '#12321f' : '#ffffff';
  } catch {
    return '#12321f';
  }
}
