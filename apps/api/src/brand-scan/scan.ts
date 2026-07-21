/**
 * Orchestrates a brand scan: fetch the page through the guarded fetcher,
 * follow the few sub-resources worth reading, and propose a draft.
 *
 * The proposal is never applied. It is returned for the owner to review,
 * edit, and confirm — which is the load-bearing control for this feature, not
 * a nicety. Every value it contains originates from an attacker-influenceable
 * document, so a human confirming it is what stands between a hostile page and
 * an org's public form styling.
 *
 * The fetcher is injected rather than imported directly so this logic is
 * testable. `safeFetch` refuses to connect to loopback by design, which is
 * correct and also makes a local test origin unreachable — the seam exists to
 * resolve that tension without weakening the guard.
 */
import { isValidFormFont } from '@formai/shared';
import { safeFetch, SafeFetchError, type SafeFetchResult } from './safe-fetch.js';
import {
  extractFromCss,
  extractFromHtml,
  extractFromManifest,
  isNearGreyscale,
  type BrandCandidates,
} from './extract.js';

export type Fetcher = (url: string) => Promise<SafeFetchResult>;

export interface BrandScanProposal {
  /** The page actually read, after redirects. */
  sourceUrl: string;
  siteName: string | null;
  /** Best-guess palette. Any field may be absent when nothing was found. */
  colors: { primary?: string; secondary?: string; accent?: string };
  /** Only families the bundled Google Fonts catalog knows. */
  font: string | null;
  /** Candidate logo URLs, best first. Not downloaded here. */
  logoCandidates: string[];
  /** Everything found, so the review UI can offer alternatives. */
  palette: string[];
  /** True when the page yielded nothing useful (R16 degrades to manual). */
  empty: boolean;
  /** Human-readable notes for the review screen. */
  notes: string[];
}

const MAX_SUBRESOURCES = 3;

/** Fetch a sub-resource, treating any failure as "no signal" rather than fatal. */
async function tryFetch(fetcher: Fetcher, url: string): Promise<SafeFetchResult | null> {
  try {
    return await fetcher(url);
  } catch {
    return null;
  }
}

export async function runBrandScan(
  rawUrl: string,
  fetcher: Fetcher = safeFetch,
): Promise<BrandScanProposal> {
  const page = await fetcher(rawUrl);
  const html = extractFromHtml(page.body, page.url);

  const colors: string[] = [...html.colors];
  const fonts: string[] = [...html.fonts];
  const icons = [...html.icons];
  const notes: string[] = [];

  // The manifest is the single most structured brand signal a site publishes,
  // so it is always worth the extra request when declared.
  if (html.manifest) {
    const res = await tryFetch(fetcher, html.manifest);
    if (res) {
      const signals = extractFromManifest(res.body, html.manifest);
      colors.push(...signals.colors);
      icons.push(...signals.icons);
    }
  }

  for (const href of html.stylesheets.slice(0, MAX_SUBRESOURCES)) {
    const res = await tryFetch(fetcher, href);
    if (!res) continue;
    const signals = extractFromCss(res.body);
    colors.push(...signals.colors);
    fonts.push(...signals.fonts);
  }

  const palette = rankColors(colors);
  const font = pickFont(fonts, notes);
  const logoCandidates = icons.map((i) => i.url).slice(0, 5);

  if (palette.length === 0) {
    notes.push('No brand colours could be read from this site — pick them by hand below.');
  }
  if (logoCandidates.length === 0) {
    notes.push('No logo was found — you can upload one directly.');
  }
  if (isLikelyJsRendered(page, html)) {
    notes.push(
      'This site renders most of its styling in the browser, so little could be read from the page source.',
    );
  }

  return {
    sourceUrl: page.url,
    siteName: html.siteName,
    colors: { primary: palette[0], secondary: palette[1], accent: palette[2] },
    font,
    logoCandidates,
    palette,
    empty: palette.length === 0 && logoCandidates.length === 0 && !font,
    notes,
  };
}

/**
 * Order the palette by trustworthiness, keeping the order sources arrived in
 * (theme-color and named brand variables first) and dropping page furniture.
 */
export function rankColors(colors: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const color of colors) {
    const hex = color.toLowerCase();
    if (seen.has(hex) || isNearGreyscale(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out.slice(0, 6);
}

/**
 * Take the first extracted family the bundled catalog actually knows.
 *
 * A site's real font is often self-hosted or licensed and simply cannot be
 * served here, so silently proposing an unknown name would produce a theme
 * that renders as the fallback stack with no explanation. Saying so is more
 * useful than guessing.
 */
export function pickFont(fonts: string[], notes: string[] = []): string | null {
  const known = fonts.find((f) => isValidFormFont(f));
  if (known) return known;
  if (fonts.length > 0) {
    notes.push(
      `This site uses ${fonts[0]}, which isn't available in the font picker — choose the closest match below.`,
    );
  }
  return null;
}

/** A page with almost no static styling signal is usually client-rendered. */
function isLikelyJsRendered(page: SafeFetchResult, html: BrandCandidates): boolean {
  return (
    page.body.length > 2000 &&
    html.colors.length === 0 &&
    html.fonts.length === 0 &&
    html.stylesheets.length === 0
  );
}

export { SafeFetchError };
