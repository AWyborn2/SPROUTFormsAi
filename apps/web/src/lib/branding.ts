/**
 * Org-brand → CSS custom-property mapping, shared by every surface that
 * renders inside a tenant's brand: the onboarding/white-label previews (via
 * `useOnboarding().brandStyle`) and the public fill page (which gets the
 * serving org's kit from `GET /fill/:token`). Pure so it's unit-testable.
 */
import type { CSSProperties } from 'react';
import type { BrandingKit, FontCategory } from '@formai/shared';
import { contrastText, DEFAULT_BRANDING, findGoogleFont } from '@formai/shared';

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

/**
 * CSS custom properties applying a brand kit to a subtree — the `--org-*`
 * variables screens style against. `null`/`undefined` (e.g. an org that
 * never customised its branding) falls back to the FormAI defaults, and an
 * unknown font name (defensive: the kit may arrive from the network) falls
 * back to Inter.
 */
export function orgBrandVars(branding?: BrandingKit | null): CSSProperties {
  const b = branding ?? DEFAULT_BRANDING;
  return {
    '--org-primary': b.primaryColor,
    '--org-accent': b.accentColor,
    '--org-accent-text': contrastText(b.accentColor),
    '--org-font': fontStack(b.formFont),
  } as CSSProperties;
}
