/**
 * Form theme tokens — the bounded set of styling an org (and optionally a
 * single form) can control. This is a superset of `BrandingKit`: the kit still
 * owns the logo, the three brand colours, and the font family, while this
 * module owns everything layered on top of them (colour roles, typography
 * roles, button and surface styling, density, logo geometry, layout type).
 *
 * Three rules shape the design:
 *
 * 1. **Every field is optional.** A theme is a sparse patch, never a complete
 *    document. Absent means "inherit", which is what makes org -> form
 *    override work and what makes a pre-feature org render unchanged.
 * 2. **The shape is flat.** Nested groups would force a deep merge in
 *    `resolveTheme` and a second inheritance rule for group-vs-leaf. Flat keys
 *    merge with a single spread and map one-to-one onto CSS custom properties.
 * 3. **Empty string means "use the product default".** Several colour roles are
 *    served today by the product's own design tokens rather than by branding.
 *    Defaulting those to `''` lets the emitter skip the variable entirely, so
 *    today's rendering is reproduced exactly rather than approximated by a
 *    hardcoded hex.
 */

/** Which of the four form layouts renders the fill surface. */
export type ThemeLayout = 'card' | 'hero' | 'split' | 'conversational';

/** Vertical rhythm. Scales field spacing and control height, not font size. */
export type ThemeDensity = 'compact' | 'comfortable' | 'spacious';

export type ButtonShape = 'rounded' | 'pill' | 'square';

/** `soft` is a tinted fill derived from the accent, not a second colour role. */
export type ButtonStyle = 'solid' | 'outline' | 'soft';

export type ShadowLevel = 'none' | 'sm' | 'md' | 'lg';

export type LogoSize = 'small' | 'medium' | 'large';

export type LogoPlacement = 'left' | 'center';

/**
 * Weights the theme may request. Deliberately limited to the four the font
 * loader already requests: a Google Fonts `css2` request fails *entirely* when
 * it asks for a weight the family does not publish, so widening this set
 * without widening the loader's intersection logic would break real families.
 */
export const THEME_FONT_WEIGHTS = [400, 500, 600, 700] as const;
export type ThemeFontWeight = (typeof THEME_FONT_WEIGHTS)[number];

export interface ThemeTokens {
  // ---- Colour roles ------------------------------------------------------
  /** Page backdrop behind the form card. `''` keeps the product surface. */
  pageBackground?: string;
  /** The form card's own fill. */
  formBackground?: string;
  /** Heading text sitting on `formBackground`. */
  headingColor?: string;
  /** Body/answer text. */
  bodyColor?: string;
  /** Field label text. */
  labelColor?: string;

  // ---- Typography roles --------------------------------------------------
  headingSize?: number;
  headingWeight?: ThemeFontWeight;
  bodySize?: number;
  bodyWeight?: ThemeFontWeight;
  labelSize?: number;
  labelWeight?: ThemeFontWeight;
  buttonSize?: number;
  buttonWeight?: ThemeFontWeight;

  // ---- Buttons -----------------------------------------------------------
  buttonShape?: ButtonShape;
  buttonStyle?: ButtonStyle;

  // ---- Surface (mirrors FormContainer, which stays authoritative per form)
  radius?: number;
  borderWidth?: number;
  /** `''` keeps the product's border token. */
  borderColor?: string;
  shadow?: ShadowLevel;

  // ---- Spacing -----------------------------------------------------------
  density?: ThemeDensity;

  // ---- Logo --------------------------------------------------------------
  logoSize?: LogoSize;
  logoPlacement?: LogoPlacement;

  // ---- Layout ------------------------------------------------------------
  layout?: ThemeLayout;
}

/**
 * Concrete baseline reproducing what the fill surface renders today.
 *
 * Surface values (`radius`, `borderWidth`, `shadow`) mirror `DEFAULT_CONTAINER`
 * in `form-field.ts` rather than the values the fill page currently hardcodes.
 * Those two have always disagreed — the builder previews the container's 14px
 * radius while the live page draws `rounded-lg` — and the container is the side
 * that was always meant to win. Aligning them is the point of R2, not a
 * regression.
 *
 * Colour roles default to `''` (product default) so an org that has never
 * opened the theme editor renders byte-identically to before.
 */
export const DEFAULT_THEME: Required<ThemeTokens> = {
  pageBackground: '',
  formBackground: '#ffffff',
  headingColor: '',
  bodyColor: '',
  labelColor: '',

  headingSize: 21,
  headingWeight: 700,
  bodySize: 14,
  bodyWeight: 400,
  labelSize: 13,
  labelWeight: 600,
  buttonSize: 15,
  buttonWeight: 700,

  buttonShape: 'rounded',
  buttonStyle: 'solid',

  radius: 14,
  borderWidth: 1,
  borderColor: '',
  shadow: 'lg',

  density: 'comfortable',

  logoSize: 'medium',
  logoPlacement: 'left',

  layout: 'card',
};

/** Every key of `ThemeTokens`, derived from the default so the two cannot drift. */
export const THEME_TOKEN_KEYS = Object.keys(DEFAULT_THEME) as (keyof ThemeTokens)[];

/**
 * Drop keys whose value is `undefined` so a sparse patch cannot punch a hole
 * through a lower layer. `{ radius: undefined }` must mean "I did not set
 * radius", not "reset radius to nothing" — a plain spread would do the latter.
 * Unknown keys are dropped too, so a stale or hand-edited payload cannot inject
 * arbitrary values into the emitted CSS.
 */
function sanitize(patch: ThemeTokens | null | undefined): ThemeTokens {
  if (!patch || typeof patch !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const key of THEME_TOKEN_KEYS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as ThemeTokens;
}

/**
 * Resolve the theme a surface should render: defaults, then each layer in turn,
 * each filling only the keys it actually sets. Later layers win.
 *
 * This is the single precedence rule in the system. Every surface resolves
 * through here and no surface reads a raw theme object, so "absent means
 * inherit" is true by construction rather than by convention.
 *
 * VARIADIC RATHER THAN FIXED, so a layer can be added between two existing ones
 * without every caller changing. The order today is:
 *
 *   DEFAULT_THEME → the org's theme → the form's BRAND → the form's override
 *
 * The brand sits above the org because a subcontractor's forms mostly carry a
 * CLIENT's brand, not their own — the org's theme is the fallback for a form
 * nobody has assigned, not the baseline everything deviates from. The per-form
 * override stays last so a genuine one-off still beats its brand.
 *
 * Existing two-argument calls keep their exact meaning: org, then override.
 */
export function resolveTheme(...layers: (ThemeTokens | null | undefined)[]): Required<ThemeTokens> {
  return layers.reduce<Required<ThemeTokens>>(
    (out, layer) => ({ ...out, ...sanitize(layer) }),
    DEFAULT_THEME,
  );
}

/**
 * The value domain of every theme token, for input that is not a `<select>`.
 *
 * `sanitize` above drops unknown KEYS but keeps whatever value a known key
 * carries, which is safe for the theme editor because each control is a select
 * or a bounded number input — the UI is the guard. It is NOT safe for a patch
 * authored anywhere else, and a theme value ends up in a CSS custom property.
 *
 * Exported separately rather than folded into `sanitize` so the existing
 * resolution path keeps its exact behaviour: every stored theme in the product
 * was written through those controls, and quietly dropping a value now would
 * restyle live forms on deploy.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;

const ENUM_DOMAINS: Partial<Record<keyof ThemeTokens, readonly string[]>> = {
  buttonShape: ['rounded', 'pill', 'square'],
  buttonStyle: ['solid', 'outline', 'soft'],
  shadow: ['none', 'sm', 'md', 'lg'],
  density: ['compact', 'comfortable', 'spacious'],
  logoSize: ['small', 'medium', 'large'],
  logoPlacement: ['left', 'center'],
  layout: ['card', 'hero', 'split', 'conversational'],
};

const NUMBER_DOMAINS: Partial<Record<keyof ThemeTokens, [number, number]>> = {
  headingSize: [12, 48],
  bodySize: [10, 24],
  labelSize: [10, 24],
  buttonSize: [10, 24],
  radius: [0, 40],
  borderWidth: [0, 6],
};

const WEIGHT_KEYS: (keyof ThemeTokens)[] = [
  'headingWeight',
  'bodyWeight',
  'labelWeight',
  'buttonWeight',
];

const COLOR_KEYS: (keyof ThemeTokens)[] = [
  'pageBackground',
  'formBackground',
  'headingColor',
  'bodyColor',
  'labelColor',
  'borderColor',
];

/**
 * Keep only theme values that are actually in range, reporting what was not.
 *
 * A rejected value is DROPPED, never clamped to the nearest legal one. Clamping
 * turns "make the corners 400px round" into a silent 40 and leaves the author
 * believing the instruction was understood; dropping it says so, and the author
 * asks again. `''` stays legal on a colour role — it means "use the product
 * default", which is a real choice rather than a blank.
 */
export function sanitizeThemeValues(patch: ThemeTokens | null | undefined): {
  theme: ThemeTokens;
  rejected: string[];
} {
  const source = sanitize(patch);
  const theme: Record<string, unknown> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(source) as [keyof ThemeTokens, unknown][]) {
    const enumDomain = ENUM_DOMAINS[key];
    if (enumDomain) {
      if (typeof value === 'string' && enumDomain.includes(value)) theme[key] = value;
      else rejected.push(`${key}: ${String(value)}`);
      continue;
    }
    const range = NUMBER_DOMAINS[key];
    if (range) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= range[0] && value <= range[1]) {
        theme[key] = value;
      } else {
        rejected.push(`${key}: ${String(value)}`);
      }
      continue;
    }
    if (WEIGHT_KEYS.includes(key)) {
      if ((THEME_FONT_WEIGHTS as readonly number[]).includes(value as number)) theme[key] = value;
      else rejected.push(`${key}: ${String(value)}`);
      continue;
    }
    if (COLOR_KEYS.includes(key)) {
      if (value === '' || (typeof value === 'string' && HEX.test(value))) {
        theme[key] = typeof value === 'string' ? value.toLowerCase() : value;
      } else {
        rejected.push(`${key}: ${String(value)}`);
      }
      continue;
    }
    // Unreachable while every token appears in exactly one table above; a new
    // token with no domain is refused rather than admitted by default.
    rejected.push(`${key}: ${String(value)}`);
  }

  return { theme: theme as ThemeTokens, rejected };
}
