/**
 * The saved-signature value contract — one definition of "a signature" shared
 * by the profile save route, the client pad, and the PDF exporter, so what a
 * user can store and what the exporter can embed cannot drift apart. The
 * exporter recognises exactly this shape (`pngDataUrlBytes` in
 * `apps/api/src/pdf/round-trip.ts`); anything else exports a BLANK box,
 * silently — which is why save-time validation fails loud instead.
 */

/** What `SignaturePad` emits: `canvas.toDataURL('image/png')`. PNG only —
 * pdf-lib must be told its decoder, and guessing wrong throws mid-export. */
export const PNG_DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * Generous ceiling for a stored signature. A drawn pad signature is 5–40KB; an
 * uploaded image is downscaled to the pad's bounds before it gets here. The cap
 * keeps a stored mark comfortably inside the API's global 2MB JSON body limit
 * with room for the rest of any payload that carries it.
 */
export const MAX_SIGNATURE_BYTES = 200 * 1024;

/** Approximate decoded size of a data URL's payload, without decoding it. */
export function dataUrlByteLength(value: string): number {
  const comma = value.indexOf(',');
  const payload = comma === -1 ? '' : value.slice(comma + 1).replace(/\s+/g, '');
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/**
 * Whether a string is a PNG data URL by shape AND content: the base64 payload
 * must open with the PNG signature. `iVBORw0K` is the exact base64 encoding of
 * the first six magic bytes (89 50 4E 47 0D 0A), so this is a real magic-number
 * check that needs no decoding and runs identically in the browser and on the
 * server.
 */
export function isPngDataUrl(value: string): boolean {
  const match = PNG_DATA_URL_RE.exec(value);
  if (!match) return false;
  return match[1]!.replace(/\s+/g, '').startsWith('iVBORw0K');
}

/**
 * Validate a candidate saved signature. Null (clearing) is always valid; a
 * non-null value must be a magic-checked PNG data URL under the size cap.
 * Returns the refusal reason rather than a boolean so callers surface it.
 */
export function validateSavedSignature(
  value: string | null,
): { ok: true } | { ok: false; reason: 'not_png_data_url' | 'too_large' } {
  if (value === null) return { ok: true };
  if (!isPngDataUrl(value)) return { ok: false, reason: 'not_png_data_url' };
  if (dataUrlByteLength(value) > MAX_SIGNATURE_BYTES) return { ok: false, reason: 'too_large' };
  return { ok: true };
}
