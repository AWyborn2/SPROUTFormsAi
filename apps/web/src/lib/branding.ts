/**
 * Org-brand → CSS custom-property mapping, shared by every surface that
 * renders inside a tenant's brand: the onboarding/white-label previews (via
 * `useOnboarding().brandStyle`), the public fill page (which gets the serving
 * org's kit from `GET /fill/:token`), and the authed surfaces — the app shell
 * and the mobile fill screen — which take the kit from the session. Pure so
 * it's unit-testable.
 *
 * Two layers feed this: the `BrandingKit` (logo, three brand colours, font
 * family) and the optional `ThemeTokens` layered on top of it. The kit's five
 * original variables keep their exact names and semantics — roughly forty call
 * sites style against them — and everything the theme adds arrives as new
 * variables alongside.
 */
import type { CSSProperties } from 'react';
import type { BrandingKit, FontCategory, ThemeTokens } from '@formai/shared';
import {
  contrastText,
  DEFAULT_BRANDING,
  findGoogleFont,
  resolveTheme,
  type ThemeDensity,
  type ButtonShape,
  type LogoSize,
  type ShadowLevel,
} from '@formai/shared';

/**
 * Generic fallback stacks by catalog category — what renders while the Google
 * Fonts stylesheet is in flight, and permanently if it never arrives.
 */
const FALLBACK: Record<FontCategory, string> = {
  'sans-serif': 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  monospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  cursive: '"Segoe Script", "Brush Script MT", cursive',
};

/**
 * CSS `font-family` value for any catalog family — the fixed four-entry record
 * this replaced could not express the widened picker. An unknown family
 * (defensive: the kit may arrive from the network, or predate a catalog
 * revision) falls back to the product default rather than emitting the
 * unvalidated name into a stack.
 */
export function fontStack(family: string): string {
  const entry = findGoogleFont(family) ?? findGoogleFont(DEFAULT_BRANDING.formFont);
  if (!entry) return FALLBACK['sans-serif'];
  return `"${entry.family}", ${FALLBACK[entry.category]}`;
}

/** Vertical rhythm in px. `comfortable` reproduces today's `gap-6` / `p-[26px]`. */
const DENSITY_SCALE: Record<ThemeDensity, { gap: number; pad: number }> = {
  compact: { gap: 14, pad: 18 },
  comfortable: { gap: 24, pad: 26 },
  spacious: { gap: 34, pad: 36 },
};

/** `rounded` is 6px to match the `rounded-md` the submit button already uses. */
const BUTTON_RADIUS: Record<ButtonShape, number> = {
  rounded: 6,
  pill: 999,
  square: 0,
};

/** Maps onto the product's existing shadow tokens rather than new hex shadows. */
const SHADOW_VALUE: Record<ShadowLevel, string> = {
  none: 'none',
  sm: 'var(--shadow-sm)',
  md: 'var(--shadow-md)',
  lg: 'var(--shadow-lg)',
};

const LOGO_PX: Record<LogoSize, number> = {
  small: 28,
  medium: 40,
  large: 56,
};

/**
 * CSS custom properties applying a brand kit and theme to a subtree — the
 * `--org-*` variables screens style against. `null`/`undefined` branding (e.g.
 * an org that never customised it) falls back to the FormAI defaults, and an
 * unknown font name (defensive: the kit may arrive from the network) falls back
 * to Inter.
 *
 * Colour roles resolving to `''` are **omitted entirely** rather than emitted
 * empty. Those roles are served by the product's own design tokens today, so
 * skipping them is what makes an untouched org render byte-identically instead
 * of inheriting a guessed hex.
 */
export function orgBrandVars(
  branding?: BrandingKit | null,
  themeOverride?: ThemeTokens | null,
): CSSProperties {
  const b = branding ?? DEFAULT_BRANDING;
  // The org's own theme rides inside the kit; `themeOverride` is the per-form
  // layer on top of it. Existing callers pass only the kit and pick up org
  // theming for free.
  const t = resolveTheme(b.theme, themeOverride);
  const density = DENSITY_SCALE[t.density] ?? DENSITY_SCALE.comfortable;

  const vars: Record<string, string> = {
    '--org-primary': b.primaryColor,
    // Both brand colours carry text — the accent on primary-action buttons,
    // the primary behind fill mastheads and the chrome's org identity — so
    // both get their ink resolved rather than assuming a dark brand colour.
    '--org-primary-text': contrastText(b.primaryColor),
    '--org-accent': b.accentColor,
    '--org-accent-text': contrastText(b.accentColor),
    '--org-font': fontStack(b.formFont),

    // The secondary colour has been stored and editable since the branding kit
    // shipped but was never emitted, so changing it did nothing anywhere.
    '--org-secondary': b.secondaryColor,
    '--org-secondary-text': contrastText(b.secondaryColor),

    // Typography roles.
    '--org-heading-size': `${t.headingSize}px`,
    '--org-heading-weight': String(t.headingWeight),
    '--org-body-size': `${t.bodySize}px`,
    '--org-body-weight': String(t.bodyWeight),
    '--org-label-size': `${t.labelSize}px`,
    '--org-label-weight': String(t.labelWeight),
    '--org-button-size': `${t.buttonSize}px`,
    '--org-button-weight': String(t.buttonWeight),

    // Surface.
    '--org-radius': `${t.radius}px`,
    '--org-border-width': `${t.borderWidth}px`,
    '--org-shadow': SHADOW_VALUE[t.shadow] ?? SHADOW_VALUE.lg,

    // Buttons.
    '--org-button-radius': `${BUTTON_RADIUS[t.buttonShape] ?? BUTTON_RADIUS.rounded}px`,

    // Spacing.
    '--org-gap': `${density.gap}px`,
    '--org-pad': `${density.pad}px`,

    // Logo geometry. Consumed by the fill and preview surfaces.
    '--org-logo-size': `${LOGO_PX[t.logoSize] ?? LOGO_PX.medium}px`,
  };

  // Optional roles: emit only when the theme actually sets them, so the
  // product default keeps applying otherwise.
  const optional: Array<[string, string]> = [
    ['--org-page-bg', t.pageBackground],
    ['--org-form-bg', t.formBackground],
    ['--org-heading-color', t.headingColor],
    ['--org-body-color', t.bodyColor],
    ['--org-label-color', t.labelColor],
    ['--org-border-color', t.borderColor],
  ];
  for (const [key, value] of optional) {
    if (value) vars[key] = value;
  }

  return vars as CSSProperties;
}
