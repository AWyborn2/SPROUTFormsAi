/**
 * Bundled snapshot of the Google Fonts families an org may pick as its form
 * font. Hand-curated (~100 of the most-used families) rather than fetched at
 * runtime: the API validates `branding.formFont` against this list, so it must
 * be available synchronously and offline, and a closed set keeps a
 * user-controlled string out of the `fonts.googleapis.com/css2` URL the web
 * app builds.
 *
 * `weights` carries each family's REAL available weights, and that matters:
 * a bare-family css2 request serves weight 400 only, while branded surfaces
 * render 500–700 — and asking for a weight a static family does not ship
 * fails the ENTIRE css2 request, silently dropping the font. The loader
 * therefore requests the intersection of these weights with the weights the
 * UI actually uses. When in doubt about a family, it is listed with fewer
 * weights (or omitted) rather than more.
 *
 * `category` is the CSS generic the family falls back to, so a stack can be
 * built for any entry without a second lookup table.
 */

export type FontCategory = 'sans-serif' | 'serif' | 'monospace' | 'cursive';

export interface GoogleFontEntry {
  family: string;
  /** Weights this family actually ships, ascending. */
  weights: readonly number[];
  category: FontCategory;
}

const W_100_900 = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export const GOOGLE_FONTS_CATALOG: readonly GoogleFontEntry[] = [
  // ── The four presets FormAI has always offered (kept first so existing
  // saved orgs are provably still valid) ──────────────────────────────────
  { family: 'Inter', weights: W_100_900, category: 'sans-serif' },
  { family: 'Sora', weights: [100, 200, 300, 400, 500, 600, 700, 800], category: 'sans-serif' },
  { family: 'Spectral', weights: [200, 300, 400, 500, 600, 700, 800], category: 'serif' },
  {
    family: 'JetBrains Mono',
    weights: [100, 200, 300, 400, 500, 600, 700, 800],
    category: 'monospace',
  },

  // ── Sans-serif ──────────────────────────────────────────────────────────
  { family: 'Archivo', weights: W_100_900, category: 'sans-serif' },
  { family: 'Assistant', weights: [200, 300, 400, 500, 600, 700, 800], category: 'sans-serif' },
  { family: 'Barlow', weights: W_100_900, category: 'sans-serif' },
  { family: 'Cabin', weights: [400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Catamaran', weights: W_100_900, category: 'sans-serif' },
  { family: 'Chivo', weights: W_100_900, category: 'sans-serif' },
  { family: 'DM Sans', weights: [400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Epilogue', weights: W_100_900, category: 'sans-serif' },
  { family: 'Exo 2', weights: W_100_900, category: 'sans-serif' },
  { family: 'Figtree', weights: [300, 400, 500, 600, 700, 800, 900], category: 'sans-serif' },
  { family: 'Fira Sans', weights: W_100_900, category: 'sans-serif' },
  { family: 'Heebo', weights: W_100_900, category: 'sans-serif' },
  { family: 'Hind', weights: [300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'IBM Plex Sans', weights: [100, 200, 300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Jost', weights: W_100_900, category: 'sans-serif' },
  { family: 'Josefin Sans', weights: [100, 200, 300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Kanit', weights: W_100_900, category: 'sans-serif' },
  { family: 'Karla', weights: [200, 300, 400, 500, 600, 700, 800], category: 'sans-serif' },
  { family: 'Lato', weights: [100, 300, 400, 700, 900], category: 'sans-serif' },
  { family: 'Lexend', weights: W_100_900, category: 'sans-serif' },
  { family: 'Libre Franklin', weights: W_100_900, category: 'sans-serif' },
  { family: 'Manrope', weights: [200, 300, 400, 500, 600, 700, 800], category: 'sans-serif' },
  { family: 'Maven Pro', weights: [400, 500, 600, 700, 800, 900], category: 'sans-serif' },
  { family: 'Montserrat', weights: W_100_900, category: 'sans-serif' },
  { family: 'Mulish', weights: [200, 300, 400, 500, 600, 700, 800, 900], category: 'sans-serif' },
  { family: 'Noto Sans', weights: W_100_900, category: 'sans-serif' },
  { family: 'Nunito', weights: [200, 300, 400, 500, 600, 700, 800, 900], category: 'sans-serif' },
  {
    family: 'Nunito Sans',
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    category: 'sans-serif',
  },
  { family: 'Open Sans', weights: [300, 400, 500, 600, 700, 800], category: 'sans-serif' },
  { family: 'Oswald', weights: [200, 300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Outfit', weights: W_100_900, category: 'sans-serif' },
  { family: 'Overpass', weights: W_100_900, category: 'sans-serif' },
  { family: 'Oxygen', weights: [300, 400, 700], category: 'sans-serif' },
  { family: 'PT Sans', weights: [400, 700], category: 'sans-serif' },
  {
    family: 'Plus Jakarta Sans',
    weights: [200, 300, 400, 500, 600, 700, 800],
    category: 'sans-serif',
  },
  { family: 'Poppins', weights: W_100_900, category: 'sans-serif' },
  { family: 'Prompt', weights: W_100_900, category: 'sans-serif' },
  { family: 'Public Sans', weights: W_100_900, category: 'sans-serif' },
  { family: 'Quicksand', weights: [300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Raleway', weights: W_100_900, category: 'sans-serif' },
  { family: 'Red Hat Display', weights: [300, 400, 500, 600, 700, 800, 900], category: 'sans-serif' },
  { family: 'Red Hat Text', weights: [300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Roboto', weights: W_100_900, category: 'sans-serif' },
  { family: 'Roboto Condensed', weights: W_100_900, category: 'sans-serif' },
  { family: 'Rubik', weights: [300, 400, 500, 600, 700, 800, 900], category: 'sans-serif' },
  { family: 'Signika', weights: [300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Source Sans 3', weights: [200, 300, 400, 500, 600, 700, 800, 900], category: 'sans-serif' },
  { family: 'Space Grotesk', weights: [300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Teko', weights: [300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'Titillium Web', weights: [200, 300, 400, 600, 700, 900], category: 'sans-serif' },
  { family: 'Ubuntu', weights: [300, 400, 500, 700], category: 'sans-serif' },
  { family: 'Urbanist', weights: W_100_900, category: 'sans-serif' },
  { family: 'Work Sans', weights: W_100_900, category: 'sans-serif' },

  // ── Serif ───────────────────────────────────────────────────────────────
  { family: 'Alegreya', weights: [400, 500, 600, 700, 800, 900], category: 'serif' },
  { family: 'Bitter', weights: W_100_900, category: 'serif' },
  { family: 'Cardo', weights: [400, 700], category: 'serif' },
  { family: 'Cormorant Garamond', weights: [300, 400, 500, 600, 700], category: 'serif' },
  { family: 'Crimson Text', weights: [400, 600, 700], category: 'serif' },
  { family: 'Domine', weights: [400, 500, 600, 700], category: 'serif' },
  { family: 'EB Garamond', weights: [400, 500, 600, 700, 800], category: 'serif' },
  { family: 'Faustina', weights: [300, 400, 500, 600, 700, 800], category: 'serif' },
  { family: 'Frank Ruhl Libre', weights: [300, 400, 500, 600, 700, 800, 900], category: 'serif' },
  { family: 'Gelasio', weights: [400, 500, 600, 700], category: 'serif' },
  { family: 'IBM Plex Serif', weights: [100, 200, 300, 400, 500, 600, 700], category: 'serif' },
  { family: 'Libre Baskerville', weights: [400, 700], category: 'serif' },
  { family: 'Literata', weights: [200, 300, 400, 500, 600, 700, 800, 900], category: 'serif' },
  { family: 'Lora', weights: [400, 500, 600, 700], category: 'serif' },
  { family: 'Merriweather', weights: [300, 400, 700, 900], category: 'serif' },
  { family: 'Newsreader', weights: [200, 300, 400, 500, 600, 700, 800], category: 'serif' },
  { family: 'Noto Serif', weights: W_100_900, category: 'serif' },
  { family: 'PT Serif', weights: [400, 700], category: 'serif' },
  { family: 'Petrona', weights: W_100_900, category: 'serif' },
  { family: 'Playfair Display', weights: [400, 500, 600, 700, 800, 900], category: 'serif' },
  { family: 'Roboto Slab', weights: W_100_900, category: 'serif' },
  { family: 'Source Serif 4', weights: [200, 300, 400, 500, 600, 700, 800, 900], category: 'serif' },
  { family: 'Tinos', weights: [400, 700], category: 'serif' },
  { family: 'Vollkorn', weights: [400, 500, 600, 700, 800, 900], category: 'serif' },
  { family: 'Zilla Slab', weights: [300, 400, 500, 600, 700], category: 'serif' },

  // ── Monospace ───────────────────────────────────────────────────────────
  { family: 'Courier Prime', weights: [400, 700], category: 'monospace' },
  { family: 'Cousine', weights: [400, 700], category: 'monospace' },
  { family: 'Fira Code', weights: [300, 400, 500, 600, 700], category: 'monospace' },
  { family: 'IBM Plex Mono', weights: [100, 200, 300, 400, 500, 600, 700], category: 'monospace' },
  { family: 'Inconsolata', weights: [200, 300, 400, 500, 600, 700, 800, 900], category: 'monospace' },
  { family: 'Noto Sans Mono', weights: W_100_900, category: 'monospace' },
  { family: 'Roboto Mono', weights: [100, 200, 300, 400, 500, 600, 700], category: 'monospace' },
  { family: 'Source Code Pro', weights: [200, 300, 400, 500, 600, 700, 800, 900], category: 'monospace' },
  { family: 'Space Mono', weights: [400, 700], category: 'monospace' },
  { family: 'Ubuntu Mono', weights: [400, 700], category: 'monospace' },

  // ── Display / single-weight statement faces ─────────────────────────────
  // Several ship weight 400 only — exactly the case that breaks a naive
  // "always request 400;500;600;700" loader.
  { family: 'Abril Fatface', weights: [400], category: 'serif' },
  { family: 'Anton', weights: [400], category: 'sans-serif' },
  { family: 'Archivo Black', weights: [400], category: 'sans-serif' },
  { family: 'Bebas Neue', weights: [400], category: 'sans-serif' },
  { family: 'Bree Serif', weights: [400], category: 'serif' },
  { family: 'Comfortaa', weights: [300, 400, 500, 600, 700], category: 'sans-serif' },
  { family: 'DM Serif Display', weights: [400], category: 'serif' },
  { family: 'Fjalla One', weights: [400], category: 'sans-serif' },
  { family: 'Marcellus', weights: [400], category: 'serif' },
  { family: 'Righteous', weights: [400], category: 'sans-serif' },
  { family: 'Varela Round', weights: [400], category: 'sans-serif' },
  { family: 'Yeseva One', weights: [400], category: 'serif' },

  // ── Handwriting ─────────────────────────────────────────────────────────
  { family: 'Caveat', weights: [400, 500, 600, 700], category: 'cursive' },
  { family: 'Dancing Script', weights: [400, 500, 600, 700], category: 'cursive' },
  { family: 'Lobster', weights: [400], category: 'cursive' },
  { family: 'Pacifico', weights: [400], category: 'cursive' },
];

/** Family → entry, for O(1) validation on the request path. */
const BY_FAMILY: ReadonlyMap<string, GoogleFontEntry> = new Map(
  GOOGLE_FONTS_CATALOG.map((entry) => [entry.family, entry]),
);

/** All catalog family names, in catalog order. */
export const GOOGLE_FONT_FAMILIES: readonly string[] = GOOGLE_FONTS_CATALOG.map((e) => e.family);

/** Catalog entry for `family`, or `undefined` if it is not in the snapshot. */
export function findGoogleFont(family: string): GoogleFontEntry | undefined {
  return BY_FAMILY.get(family);
}
