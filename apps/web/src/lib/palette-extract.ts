/**
 * Client-side brand palette extraction from an uploaded logo (KTD7).
 *
 * Split in two deliberately: `selectPalette` is a pure function over RGBA
 * pixel data — no DOM, so it is unit-testable in the web project's `node`
 * vitest environment (same reasoning as `font-loader.ts`) — while
 * `extractPaletteFromImageFile` is the thin canvas wrapper that produces
 * those pixels.
 *
 * Extraction only ever *pre-fills*: every failure path (undecodable file,
 * tainted canvas, zero usable pixels, a thrown error) yields `null`, and
 * `mergeExtractedPalette` turns `null` into an empty patch so the current
 * palette is left exactly as it was. Fields the user has already picked by
 * hand are likewise never overwritten — only values still at their defaults
 * are pre-filled, so a re-upload cannot undo a manual choice (AE5's
 * "pre-filled and remain editable").
 */

/** Edge length the logo is downscaled to before sampling. */
const SAMPLE_SIZE = 48;

/** Alpha below this is anti-aliasing / background noise, not brand colour. */
const MIN_ALPHA = 16;

/** Channel bits kept when bucketing (3 => 8 levels per channel, 512 buckets). */
const BUCKET_BITS = 3;

/**
 * Minimum squared RGB distance between two picked colours. ~72 units of
 * euclidean distance — far enough apart that the three swatches read as
 * distinct rather than three shades of the same ink.
 */
const MIN_DISTANCE_SQ = 72 * 72;

export interface ExtractedPalette {
  primary: string;
  secondary: string;
  accent: string;
}

/** The three branding-kit colour fields, as they appear on `BrandingKit`. */
export interface PaletteFields {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
}

interface Bucket {
  r: number;
  g: number;
  b: number;
  count: number;
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** HSV-style saturation in 0..1; grey is 0, a pure hue is 1. */
function saturation({ r, g, b }: Bucket): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/** Perceived luminance in 0..1 (same weights as `contrastText` in shared). */
function luminance({ r, g, b }: Bucket): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function distanceSq(a: Bucket, b: Bucket): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

/** Mixes `c` toward white (`amount > 0`) or black (`amount < 0`). */
function shift(c: Bucket, amount: number): Bucket {
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  return {
    r: c.r + (target - c.r) * t,
    g: c.g + (target - c.g) * t,
    b: c.b + (target - c.b) * t,
    count: 0,
  };
}

/**
 * Picks `{ primary, secondary, accent }` from raw RGBA pixel data.
 *
 * Near-transparent pixels are dropped, the rest are quantized into coarse
 * colour buckets (averaged back to their true mean so the output hex is the
 * real ink, not the bucket corner), and buckets are ranked by frequency
 * weighted toward saturation — a small saturated mark beats a large flat
 * background wash. Picks must be visibly far apart; a monochrome logo, which
 * offers only one candidate, has its remaining two derived by shifting the
 * primary away from its own luminance, so the result is always three distinct
 * hexes rather than one repeated three times.
 *
 * Returns `null` when there is nothing usable to read — the caller treats
 * that as "leave the palette alone".
 */
export function selectPalette(data: ArrayLike<number>): ExtractedPalette | null {
  const buckets = new Map<number, Bucket>();

  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a < MIN_ALPHA) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const shiftBy = 8 - BUCKET_BITS;
    const key =
      ((r >> shiftBy) << (BUCKET_BITS * 2)) | ((g >> shiftBy) << BUCKET_BITS) | (b >> shiftBy);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
  }

  if (buckets.size === 0) return null;

  const candidates = [...buckets.values()]
    .map((acc) => ({
      r: acc.r / acc.count,
      g: acc.g / acc.count,
      b: acc.b / acc.count,
      count: acc.count,
    }))
    .sort((x, y) => y.count * (1 + 2 * saturation(y)) - x.count * (1 + 2 * saturation(x)));

  const picks: Bucket[] = [];
  for (const c of candidates) {
    if (picks.length === 3) break;
    if (picks.every((p) => distanceSq(p, c) >= MIN_DISTANCE_SQ)) picks.push(c);
  }

  const primary = picks[0];
  if (!primary) return null;

  // Monochrome (or near-monochrome) logo: derive the missing slots from the
  // primary, moving away from its luminance so the shades stay visible on
  // both a black mark and a white one.
  const direction = luminance(primary) > 0.5 ? -1 : 1;
  if (!picks[1]) picks[1] = shift(primary, direction * 0.45);
  if (!picks[2]) picks[2] = shift(primary, direction * 0.75);

  return {
    primary: toHex(primary.r, primary.g, primary.b),
    secondary: toHex(picks[1]!.r, picks[1]!.g, picks[1]!.b),
    accent: toHex(picks[2]!.r, picks[2]!.g, picks[2]!.b),
  };
}

/**
 * Which palette fields an extraction result may write: only those still equal
 * to their default. Anything the user has changed by hand — or every field,
 * when `extracted` is null because extraction failed — is left out of the
 * patch entirely, so `setBranding(patch)` is a no-op for it.
 */
export function mergeExtractedPalette(
  current: PaletteFields,
  extracted: ExtractedPalette | null | undefined,
  defaults: PaletteFields,
): Partial<PaletteFields> {
  if (!extracted) return {};
  const patch: Partial<PaletteFields> = {};
  const isDefault = (key: keyof PaletteFields) =>
    current[key].trim().toLowerCase() === defaults[key].trim().toLowerCase();

  if (isDefault('primaryColor')) patch.primaryColor = extracted.primary;
  if (isDefault('secondaryColor')) patch.secondaryColor = extracted.secondary;
  if (isDefault('accentColor')) patch.accentColor = extracted.accent;
  return patch;
}

/**
 * Draws `file` into a small offscreen canvas and reads its pixels. Extracted
 * from the local `File` the user picked rather than the uploaded URL: the
 * bytes are already in hand, and a same-process blob URL can never taint the
 * canvas the way a cross-origin CDN fetch would.
 *
 * Never throws and never rejects — any failure resolves to `null`.
 */
export async function extractPaletteFromImageFile(file: File): Promise<ExtractedPalette | null> {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(file);
    const objectUrl = url;
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('logo could not be decoded'));
      img.src = objectUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    // An SVG with a viewBox but no intrinsic size can report 0×0 here; there
    // is nothing to sample in that case.
    if (!(image.width > 0) || !(image.height > 0)) return null;
    ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    // Throws a SecurityError on a tainted canvas — caught below.
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return selectPalette(data);
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
