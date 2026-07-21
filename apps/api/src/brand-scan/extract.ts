/**
 * Deterministic brand-signal extraction from a fetched page.
 *
 * Everything here is plain parsing: icons, manifest colours, meta theme-color,
 * Google Fonts links, `@font-face` families, and CSS custom properties. That
 * split is deliberate and is the main prompt-injection control for this
 * feature — the page is attacker-authored, so the less of it that reaches a
 * model, the smaller the surface. Parsing is exact, cheap, testable, and
 * cannot be talked out of its answer.
 *
 * Regex rather than a DOM parser: the signals are a bounded set of `<link>`,
 * `<meta>` and CSS declarations, the input is already size-capped by
 * `safeFetch`, and this avoids adding an HTML-parsing dependency to the API.
 * The trade is real — malformed or exotic markup will be missed — which is
 * acceptable because the whole feature is a *draft* the owner reviews, never
 * an auto-apply.
 *
 * What this cannot see: anything rendered by JavaScript. Site builders (Wix,
 * Framer, Squarespace) and CSS-in-JS apps will often yield little. That is a
 * known v1 limit; a headless browser would widen the SSRF surface
 * considerably for a feature whose output a human confirms anyway.
 */

/** Strip the parts of a document that carry no brand signal but do carry risk. */
export function stripNoise(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

function tagsOf(html: string, tagName: string): string[] {
  return html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? [];
}

const HEX = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi;

function normalizeHex(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(v);
  if (short) {
    const [r, g, b] = short[1]!.split('') as [string, string, string];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/** Resolve a possibly-relative URL against the page it came from. */
function absolute(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export interface IconCandidate {
  url: string;
  /** Larger is better; 0 when the page did not say. */
  size: number;
  source: 'apple-touch-icon' | 'manifest' | 'icon' | 'og-image';
}

export interface BrandCandidates {
  icons: IconCandidate[];
  /** Hex colours, most trustworthy first. */
  colors: string[];
  /** Font family names seen in Google Fonts links or @font-face. */
  fonts: string[];
  /** Absolute stylesheet URLs worth a second fetch. */
  stylesheets: string[];
  /** Manifest URL, when the page declares one. */
  manifest: string | null;
  siteName: string | null;
}

/** Parse the largest declared size out of a `sizes="32x32 64x64"` attribute. */
function largestSize(sizes: string | null): number {
  if (!sizes) return 0;
  const nums = [...sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/**
 * Pull every brand signal available from the page HTML alone.
 * `pageUrl` is used to resolve relative hrefs.
 */
export function extractFromHtml(rawHtml: string, pageUrl: string): BrandCandidates {
  const html = stripNoise(rawHtml);
  const icons: IconCandidate[] = [];
  const colors: string[] = [];
  const fonts: string[] = [];
  const stylesheets: string[] = [];
  let manifest: string | null = null;
  let siteName: string | null = null;

  for (const tag of tagsOf(html, 'link')) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href) continue;
    const url = absolute(href, pageUrl);
    if (!url) continue;

    if (rel.includes('apple-touch-icon')) {
      icons.push({ url, size: largestSize(attr(tag, 'sizes')) || 180, source: 'apple-touch-icon' });
    } else if (rel.split(/\s+/).includes('icon') || rel.includes('shortcut icon')) {
      icons.push({ url, size: largestSize(attr(tag, 'sizes')), source: 'icon' });
    } else if (rel.includes('manifest')) {
      manifest = url;
    } else if (rel.includes('stylesheet')) {
      if (/fonts\.googleapis\.com/i.test(url)) {
        fonts.push(...googleFontFamilies(url));
      } else {
        stylesheets.push(url);
      }
    }
  }

  for (const tag of tagsOf(html, 'meta')) {
    const name = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase();
    const content = attr(tag, 'content');
    if (!content) continue;

    if (name === 'theme-color') {
      const hex = normalizeHex(content);
      // Highest-confidence colour a page can declare about itself.
      if (hex) colors.unshift(hex);
    } else if (name === 'og:site_name') {
      siteName = content;
    } else if (name === 'og:image') {
      const url = absolute(content, pageUrl);
      if (url) icons.push({ url, size: 0, source: 'og-image' });
    }
  }

  return {
    icons: dedupeIcons(icons),
    colors: [...new Set(colors)],
    fonts: [...new Set(fonts)],
    stylesheets: [...new Set(stylesheets)].slice(0, 3),
    manifest,
    siteName,
  };
}

/** `family=Inter:wght@400;700&family=Lora` -> ['Inter', 'Lora'] */
export function googleFontFamilies(cssUrl: string): string[] {
  const out: string[] = [];
  for (const m of cssUrl.matchAll(/family=([^&:]+)/gi)) {
    const name = decodeURIComponent(m[1]!.replace(/\+/g, ' ')).trim();
    if (name) out.push(name);
  }
  return out;
}

function dedupeIcons(icons: IconCandidate[]): IconCandidate[] {
  const seen = new Map<string, IconCandidate>();
  for (const icon of icons) {
    const existing = seen.get(icon.url);
    if (!existing || icon.size > existing.size) seen.set(icon.url, icon);
  }
  // Biggest first: a 180px apple-touch-icon is a far better mark than a 16px
  // favicon, and an og:image is a share card rather than a logo.
  return [...seen.values()].sort((a, b) => b.size - a.size);
}

export interface ManifestSignals {
  colors: string[];
  icons: IconCandidate[];
}

/** Pull `theme_color` and icons out of a web app manifest. */
export function extractFromManifest(json: string, manifestUrl: string): ManifestSignals {
  const colors: string[] = [];
  const icons: IconCandidate[] = [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { colors, icons };
  }

  for (const key of ['theme_color', 'background_color']) {
    const value = parsed[key];
    if (typeof value === 'string') {
      const hex = normalizeHex(value);
      if (hex) colors.push(hex);
    }
  }

  const rawIcons = Array.isArray(parsed.icons) ? parsed.icons : [];
  for (const entry of rawIcons) {
    if (!entry || typeof entry !== 'object') continue;
    const src = (entry as Record<string, unknown>).src;
    if (typeof src !== 'string') continue;
    const url = absolute(src, manifestUrl);
    if (!url) continue;
    icons.push({
      url,
      size: largestSize(String((entry as Record<string, unknown>).sizes ?? '')),
      source: 'manifest',
    });
  }

  return { colors, icons: dedupeIcons(icons) };
}

/**
 * Colours and font families declared in a stylesheet.
 *
 * CSS custom properties come first: a variable literally named `--brand-` or
 * `--primary-` is the most semantically meaningful colour a site publishes
 * about itself. Bulk hex values follow, ranked by how often they appear —
 * frequency is a decent proxy for "this is the brand colour" once the noise
 * of near-white and near-black is dropped.
 */
export function extractFromCss(css: string): { colors: string[]; fonts: string[] } {
  const named: string[] = [];
  for (const m of css.matchAll(/--([a-z0-9-]*(?:brand|primary|accent|secondary)[a-z0-9-]*)\s*:\s*([^;]+);/gi)) {
    const hex = normalizeHex((HEX.exec(m[2]!) ?? [''])[0] ?? '');
    HEX.lastIndex = 0;
    if (hex) named.push(hex);
  }

  const counts = new Map<string, number>();
  for (const m of css.matchAll(HEX)) {
    const hex = normalizeHex(m[0]);
    if (!hex || isNearGreyscale(hex)) continue;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const byFrequency = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);

  const fonts: string[] = [];
  for (const m of css.matchAll(/@font-face\s*\{[^}]*font-family\s*:\s*["']?([^;"'}]+)["']?/gi)) {
    const name = m[1]!.trim();
    if (name) fonts.push(name);
  }

  return {
    colors: [...new Set([...named, ...byFrequency])],
    fonts: [...new Set(fonts)],
  };
}

/**
 * Near-white, near-black and near-grey are almost always page furniture
 * rather than brand identity, and they dominate raw hex counts if kept.
 */
export function isNearGreyscale(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 18) return true; // unsaturated
  return max > 244 || max < 22; // blown out or nearly black
}
