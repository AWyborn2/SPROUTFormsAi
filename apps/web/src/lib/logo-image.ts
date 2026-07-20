/**
 * Client-side logo preparation for `POST /org/logo`.
 *
 * Two jobs: enforce the same type/size rules the API enforces (so the user
 * gets an instant, specific error rather than a round-trip), and rasterise
 * SVG to PNG before upload. SVG is rasterised rather than uploaded because
 * serving user-supplied SVG from the app origin is a stored-XSS vector — the
 * API's whitelist is PNG/JPEG/WebP only, verified by magic bytes, so an SVG
 * that reached it would simply be rejected.
 */

/** Must match `MAX_LOGO_BYTES` in apps/api/src/routes/assets.ts. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Raster types the API accepts as-is. */
const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Target width for a rasterised SVG. Retina-safe for a header mark. */
const SVG_TARGET_WIDTH = 512;

export interface PreparedLogo {
  imageBase64: string;
  mimeType: string;
}

export class LogoValidationError extends Error {}

/**
 * Derives raster dimensions for an SVG from its `viewBox`, scaled to
 * `SVG_TARGET_WIDTH` with aspect preserved. Brand SVGs very often carry a
 * viewBox and no `width`/`height`, in which case drawing them to a canvas
 * yields 0×0 or a browser-default 300×150 — so the viewBox is the primary
 * source and the width/height attributes are only a fallback. Returns
 * `{ width: 0, height: 0 }` when neither yields usable numbers; the caller
 * treats that as a validation error rather than uploading an empty image.
 */
export function svgRasterSize(svgText: string): { width: number; height: number } {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== 'svg') return { width: 0, height: 0 };

  let intrinsicWidth = 0;
  let intrinsicHeight = 0;

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      intrinsicWidth = parts[2]!;
      intrinsicHeight = parts[3]!;
    }
  }
  if (intrinsicWidth <= 0 || intrinsicHeight <= 0) {
    intrinsicWidth = parseFloat(svg.getAttribute('width') ?? '');
    intrinsicHeight = parseFloat(svg.getAttribute('height') ?? '');
  }
  if (!(intrinsicWidth > 0) || !(intrinsicHeight > 0)) return { width: 0, height: 0 };

  const scale = SVG_TARGET_WIDTH / intrinsicWidth;
  return {
    width: SVG_TARGET_WIDTH,
    height: Math.max(1, Math.round(intrinsicHeight * scale)),
  };
}

/** Strips the `data:...;base64,` prefix a FileReader data URL carries. */
function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(base64FromDataUrl(String(reader.result)));
    reader.onerror = () => reject(new LogoValidationError('That file could not be read.'));
    reader.readAsDataURL(blob);
  });
}

/** Renders SVG text to a PNG blob at viewBox-derived dimensions. */
async function rasteriseSvg(svgText: string): Promise<Blob> {
  const { width, height } = svgRasterSize(svgText);
  if (width === 0 || height === 0) {
    throw new LogoValidationError(
      'That SVG has no usable size — it needs a viewBox or width/height. Try a PNG instead.',
    );
  }

  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new LogoValidationError('That SVG could not be rendered.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new LogoValidationError('Your browser could not process that SVG.');
    ctx.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new LogoValidationError('That SVG could not be converted to a PNG.')),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Validates a picked file and returns the base64 payload for `POST /org/logo`.
 * Raster files pass through; SVG is converted to PNG first. Throws
 * `LogoValidationError` with a user-facing message on anything rejectable.
 */
export async function prepareLogoUpload(file: File): Promise<PreparedLogo> {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);

  if (!isSvg && !RASTER_TYPES.includes(file.type)) {
    throw new LogoValidationError('Logos must be an SVG, PNG, JPEG or WebP image.');
  }
  if (file.size > MAX_LOGO_BYTES) {
    throw new LogoValidationError('That file is over 2 MB — try a smaller version.');
  }

  if (isSvg) {
    const png = await rasteriseSvg(await file.text());
    if (png.size > MAX_LOGO_BYTES) {
      throw new LogoValidationError('That logo is too detailed to convert — try a PNG under 2 MB.');
    }
    return { imageBase64: await blobToBase64(png), mimeType: 'image/png' };
  }
  return { imageBase64: await blobToBase64(file), mimeType: file.type };
}
