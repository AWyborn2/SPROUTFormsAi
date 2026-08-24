import { describe, expect, it } from 'vitest';
import {
  dataUrlByteLength,
  isPngDataUrl,
  MAX_SIGNATURE_BYTES,
  validateSavedSignature,
} from './signature.js';

/** What `canvas.toDataURL('image/png')` actually opens with. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA=';

describe('isPngDataUrl', () => {
  it('accepts a real PNG data URL', () => {
    expect(isPngDataUrl(PNG)).toBe(true);
  });

  it('rejects a JPEG data URL — the exporter would draw a blank box', () => {
    expect(isPngDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).toBe(false);
  });

  it('rejects a PNG-labelled payload whose bytes are not PNG (magic check)', () => {
    // Valid base64, wrong content: "hello world" is not a PNG however the
    // mime prefix labels it.
    expect(isPngDataUrl('data:image/png;base64,aGVsbG8gd29ybGQ=')).toBe(false);
  });

  it('rejects plain text and empty strings', () => {
    expect(isPngDataUrl('J. Bloggs')).toBe(false);
    expect(isPngDataUrl('')).toBe(false);
  });

  it('tolerates whitespace inside the base64 payload, as the exporter does', () => {
    const spaced = PNG.replace('base64,iVBORw0K', 'base64,iVBO Rw0K');
    expect(isPngDataUrl(spaced)).toBe(true);
  });
});

describe('validateSavedSignature', () => {
  it('null (clearing) is always valid', () => {
    expect(validateSavedSignature(null)).toEqual({ ok: true });
  });

  it('a well-formed PNG under the cap is valid', () => {
    expect(validateSavedSignature(PNG)).toEqual({ ok: true });
  });

  it('refuses a non-PNG with the reason named', () => {
    expect(validateSavedSignature('data:image/jpeg;base64,/9j/AAA=')).toEqual({
      ok: false,
      reason: 'not_png_data_url',
    });
  });

  it('refuses an oversized payload', () => {
    // A payload whose decoded size clears the cap: base64 grows bytes by 4/3.
    const big = `data:image/png;base64,iVBORw0K${'A'.repeat(Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3))}`;
    expect(validateSavedSignature(big)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('dataUrlByteLength', () => {
  it('reports the decoded size, accounting for padding', () => {
    // "aGVsbG8=" decodes to "hello" — 5 bytes.
    expect(dataUrlByteLength('data:image/png;base64,aGVsbG8=')).toBe(5);
  });
});
