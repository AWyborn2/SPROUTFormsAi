import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { FormField, SubmissionValue } from '@formai/shared';
import { roundTripExport } from './round-trip.js';
import { LETTERHEAD, makeFlatPdf } from './test-pdfs.js';

/** Decode `<hex>` PDF string literals in a content stream to plain text. */
function decodeHexLiterals(content: string): string {
  return content.replace(/<([0-9A-Fa-f\s]+)>/g, (_m, hex: string) => {
    const clean = hex.replace(/\s+/g, '');
    if (clean.length % 2 !== 0) return _m;
    try {
      return Buffer.from(clean, 'hex').toString('latin1');
    } catch {
      return _m;
    }
  });
}

/**
 * Concatenate the raw bytes with every inflated + hex-decoded stream, so
 * drawn-text literals are searchable regardless of how pdf-lib encoded them
 * (content streams are Flate-compressed and pdf-lib writes text as `<hex> Tj`).
 */
function decodedText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const hay = buf.toString('latin1');
  let out = hay;
  let pos = 0;
  while ((pos = hay.indexOf('stream', pos)) !== -1) {
    if (hay.slice(pos - 3, pos + 6) === 'endstream') {
      pos += 9;
      continue;
    }
    let dataStart = pos + 6;
    if (hay[dataStart] === '\r') dataStart++;
    if (hay[dataStart] === '\n') dataStart++;
    const end = hay.indexOf('endstream', dataStart);
    if (end === -1) break;
    try {
      out += decodeHexLiterals(zlib.inflateSync(buf.subarray(dataStart, end)).toString('latin1'));
    } catch {
      /* not a flate stream — the raw copy already covers it */
    }
    pos = end + 9;
  }
  return out;
}

function bytesInclude(bytes: Uint8Array, needle: string): boolean {
  return decodedText(bytes).includes(needle);
}

const FIELDS: FormField[] = [
  {
    id: 'site',
    type: 'text',
    label: 'Site name',
    required: true,
    source: 'imported',
    sourcePosition: { page: 0, x: 130, y: 680, width: 200, height: 16, pageWidth: 600, pageHeight: 800 },
  },
  {
    id: 'items',
    type: 'repeating_group',
    label: 'Inspection items',
    required: false,
    source: 'imported',
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'pass', label: 'Pass', type: 'boolean_yes_no' },
    ],
    sourcePosition: { page: 0, x: 40, y: 400, width: 400, height: 120, pageWidth: 600, pageHeight: 800 },
  },
];

const VALUES: Record<string, SubmissionValue> = {
  site: 'Warehouse B',
  items: [
    { item: 'Fire extinguishers tagged', pass: true },
    { item: 'Exits unobstructed', pass: true },
  ],
};

describe('roundTripExport', () => {
  it('overlays values onto the original PDF with letterhead untouched', async () => {
    const original = await makeFlatPdf();

    // Preconditions: the letterhead exists; the value does not yet.
    expect(bytesInclude(original, LETTERHEAD)).toBe(true);
    expect(bytesInclude(original, 'Warehouse B')).toBe(false);

    const output = await roundTripExport({ originalPdf: original, fields: FIELDS, values: VALUES });

    // The original letterhead survives (we overlaid, never regenerated)…
    expect(bytesInclude(output, LETTERHEAD)).toBe(true);
    // …and the submitted values are now drawn on the page.
    expect(bytesInclude(output, 'Warehouse B')).toBe(true);
    expect(bytesInclude(output, 'Fire extinguishers tagged')).toBe(true);

    // Structure is preserved: same page count and page dimensions.
    const before = await PDFDocument.load(original);
    const after = await PDFDocument.load(output);
    expect(after.getPageCount()).toBe(before.getPageCount());
    expect(after.getPage(0).getSize()).toEqual(before.getPage(0).getSize());
  });

  it('skips fields without a source position (nothing to anchor to)', async () => {
    const original = await makeFlatPdf();
    const builtField: FormField = {
      id: 'note',
      type: 'text',
      label: 'Internal note',
      required: false,
      source: 'built',
    };
    const output = await roundTripExport({
      originalPdf: original,
      fields: [builtField],
      values: { note: 'should not appear' },
    });
    expect(bytesInclude(output, 'should not appear')).toBe(false);
    expect(bytesInclude(output, LETTERHEAD)).toBe(true);
  });
});
