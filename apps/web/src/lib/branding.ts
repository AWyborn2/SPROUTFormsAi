/**
 * Org-brand → CSS custom-property mapping, shared by every surface that
 * renders inside a tenant's brand: the onboarding/white-label previews (via
 * `useOnboarding().brandStyle`) and the public fill page (which gets the
 * serving org's kit from `GET /fill/:token`). Pure so it's unit-testable.
 */
import type { CSSProperties } from 'react';
import type { BrandingKit, FormFont } from '@formai/shared';
import { contrastText, DEFAULT_BRANDING } from '@formai/shared';

/** Web font stacks for the brand-kit font choices. */
export const FONT_STACK: Record<FormFont, string> = {
  Inter: "'Inter',sans-serif",
  Sora: "'Sora',sans-serif",
  Spectral: "'Spectral',serif",
  'JetBrains Mono': "'JetBrains Mono',monospace",
};

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
    '--org-font': FONT_STACK[b.formFont] ?? FONT_STACK.Inter,
  } as CSSProperties;
}
