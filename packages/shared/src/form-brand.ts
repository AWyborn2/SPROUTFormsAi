/**
 * A brand a form is presented in — usually a CLIENT's, not the org's own.
 *
 * WHY THIS IS NOT A PER-FORM SETTING. The theme model already allows a form to
 * override the org's theme, on the assumption that the org's brand is the
 * baseline and a deviation is exceptional. That assumption is wrong for a
 * SUBCONTRACTOR: they fill out their clients' documents, so most of their forms
 * carry somebody else's brand and their own is one among several. Per-form
 * overrides would mean a copy of each client's colours in every form that
 * client owns — and changing that client's brand would mean finding all of
 * them.
 *
 * So a brand is NAMED and SHARED, and a form selects one. Six brands, dozens of
 * forms, one place to edit each.
 *
 * WHAT IT IS NOT. This themes the on-screen fill surface only. The evidence PDF
 * is already exact — `round-trip.ts` draws onto the client's original document,
 * so its letterhead, layout and fonts were never ours to theme. And a theme
 * cannot reproduce a printed form's column arrangement or table borders; that
 * is what the structure editor does. A brand makes a form FEEL like the
 * client's, which is a real goal and a smaller one than pixel-matching.
 */

import { DEFAULT_BRANDING, type BrandingKit, type FormFont } from './branding.js';
import { resolveTheme, type ThemeTokens } from './theme.js';

/**
 * What a brand overrides on the org's own kit — a SPARSE PATCH, where an absent
 * key means "inherit".
 *
 * Deliberately not `Partial<BrandingKit>`. A `BrandingKit` also carries
 * `voiceInput`, which is a workspace POLICY about whether people may dictate
 * into forms, not part of a client's visual identity. Letting a brand set it
 * would mean adding a client silently changed what respondents are allowed to
 * do — so the type omits it rather than relying on nobody passing it.
 */
export interface FormBrandKit {
  /**
   * The brand's logo. `null` is a real value meaning "this brand has none, show
   * nothing" — distinct from absent, which inherits the org's. A client's form
   * carrying OUR logo is the confusion this whole feature exists to remove, so
   * "no logo" has to be sayable.
   */
  logoAssetUrl?: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  formFont?: FormFont;
  /** A sparse theme patch, layered by `resolveTheme` like any other. */
  theme?: ThemeTokens;
}

/** Every key of `FormBrandKit`, so an unknown one can be dropped on the way in. */
export const FORM_BRAND_KIT_KEYS: (keyof FormBrandKit)[] = [
  'logoAssetUrl',
  'primaryColor',
  'secondaryColor',
  'accentColor',
  'formFont',
  'theme',
];

export interface FormBrand {
  id: string;
  /** What the brand is called, e.g. the client's name. Unique per org. */
  name: string;
  branding: FormBrandKit;
  createdAt: string;
}

/** What a caller may set when creating or editing a brand. */
export interface FormBrandInput {
  name: string;
  branding?: FormBrandKit;
}

/**
 * The kit a fill surface should render: the org's own, patched by the form's
 * brand, with the form's theme override last.
 *
 * THE LAYER ORDER IS THE POINT.
 *
 *   org kit → brand → form theme override
 *
 * The brand sits above the org because a subcontractor's forms mostly carry a
 * CLIENT's brand — the org's kit is the fallback for a form nobody has
 * assigned, not a baseline everything deviates from. The per-form override
 * stays last so a genuine one-off still beats its brand.
 *
 * `theme` is layered by `resolveTheme` rather than replaced, so a brand that
 * sets three tokens says three tokens; every other key of the kit is a scalar
 * and is replaced outright. Unknown keys on the patch are dropped, because this
 * value reaches CSS custom properties.
 */
export function resolveBrandKit(
  orgKit: BrandingKit | null | undefined,
  brand: FormBrandKit | null | undefined,
  formThemeOverride?: ThemeTokens | null,
): BrandingKit {
  const base = orgKit ?? DEFAULT_BRANDING;
  const patch: FormBrandKit = {};
  if (brand && typeof brand === 'object') {
    for (const key of FORM_BRAND_KIT_KEYS) {
      const value = (brand as Record<string, unknown>)[key];
      if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
    }
  }
  const { theme: brandTheme, ...scalars } = patch;
  return {
    ...base,
    ...scalars,
    theme: resolveTheme(base.theme, brandTheme, formThemeOverride),
  };
}

/**
 * The colours and logo read off a client's document, offered as a starting
 * point for a brand.
 *
 * A PROPOSAL, NEVER A DECISION — the same posture as every other thing this
 * product reads off a page. A document's dominant colour may be its letterhead,
 * its table borders or a photograph; the author confirms. Every field is
 * optional because a monochrome form legitimately yields nothing, and inventing
 * a brand colour for one would be worse than offering none.
 */
export interface BrandProposal {
  /** Hex colours found in the document, most prominent first. */
  colors: string[];
  /** What the model made of the document's identity, for the brand's name. */
  suggestedName?: string;
  /** Free-text notes — an unreadable logo, a document with no colour at all. */
  notes: string[];
}
