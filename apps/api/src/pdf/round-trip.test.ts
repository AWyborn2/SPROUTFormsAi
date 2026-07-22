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

interface Glyph {
  x: number;
  y: number;
  text: string;
}

/**
 * Every text run drawn on the page, with the point coordinates it was placed
 * at. Column placement is the whole point of the answer-set export, so the
 * assertions have to look at WHERE a glyph landed, not just that it exists.
 */
function drawnGlyphs(bytes: Uint8Array): Glyph[] {
  const buf = Buffer.from(bytes);
  const hay = buf.toString('latin1');
  const out: Glyph[] = [];
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
    let content: string;
    try {
      content = zlib.inflateSync(buf.subarray(dataStart, end)).toString('latin1');
    } catch {
      pos = end + 9;
      continue;
    }
    const re = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      out.push({
        x: Number(m[1]),
        y: Number(m[2]),
        text: Buffer.from(m[3]!, 'hex').toString('latin1'),
      });
    }
    pos = end + 9;
  }
  return out;
}

/** X positions of every `X` mark drawn, sorted. */
function markXs(bytes: Uint8Array): number[] {
  return drawnGlyphs(bytes)
    .filter((g) => g.text === 'X')
    .map((g) => g.x)
    .sort((a, b) => a - b);
}

/** Table box used by the grouped fixtures: 4 columns of 100pt each from x=40. */
const GROUPED_POS = {
  page: 0,
  x: 40,
  y: 400,
  width: 400,
  height: 120,
  pageWidth: 600,
  pageHeight: 800,
} as const;

/** Cell text x for column index `ci` in a 4-column GROUPED_POS table. */
const cellX = (ci: number): number => GROUPED_POS.x + (GROUPED_POS.width / 4) * ci + 3;

const GROUPED_FIELD: FormField = {
  id: 'checks',
  type: 'repeating_group',
  label: 'Pre-start checks',
  required: false,
  source: 'imported',
  columns: [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
    { key: 'fault', label: 'Fault', type: 'boolean_yes_no' },
    { key: 'na', label: 'N/A', type: 'boolean_yes_no' },
  ],
  answerSets: [{ key: 'status', columnKeys: ['ok', 'fault', 'na'] }],
  sourcePosition: { ...GROUPED_POS },
};

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

  it('still exports the remaining fields when one has no source position', async () => {
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
      fields: [builtField, ...FIELDS],
      values: { note: 'should not appear', ...VALUES },
    });
    expect(bytesInclude(output, 'should not appear')).toBe(false);
    expect(bytesInclude(output, 'Warehouse B')).toBe(true);
    expect(bytesInclude(output, 'Fire extinguishers tagged')).toBe(true);
  });

  it('exports an ungrouped table with one mark per truthy cell', async () => {
    const original = await makeFlatPdf();
    const output = await roundTripExport({ originalPdf: original, fields: FIELDS, values: VALUES });
    // Both rows tick the single `pass` column (index 1 of 2 columns, width 200).
    expect(markXs(output)).toEqual([40 + 200 + 3, 40 + 200 + 3]);
  });
});

describe('roundTripExport — answer sets', () => {
  it('marks only the column the row answered', async () => {
    const original = await makeFlatPdf();
    const output = await roundTripExport({
      originalPdf: original,
      fields: [GROUPED_FIELD],
      values: {
        checks: [
          { item: 'Engine oil level', na: true },
          // Stored as the string 'true' — `isChosen` counts it, so it marks the
          // cell rather than printing the literal text.
          { item: 'Coolant', ok: 'true' },
        ],
      },
    });
    // The third member column (`na`, column index 3) is marked…
    expect(markXs(output)).toEqual([cellX(1), cellX(3)]);
    // …and on that row (the topmost, so the highest y) its two siblings are blank.
    const marks = drawnGlyphs(output).filter((g) => g.text === 'X');
    const topY = Math.max(...marks.map((g) => g.y));
    const firstRow = marks.filter((g) => g.y === topY).map((g) => g.x);
    expect(firstRow).toEqual([cellX(3)]);
    expect(bytesInclude(output, 'Engine oil level')).toBe(true);
  });

  it('marks nothing for an unanswered grouped row', async () => {
    const original = await makeFlatPdf();
    const output = await roundTripExport({
      originalPdf: original,
      fields: [GROUPED_FIELD],
      values: { checks: [{ item: 'Engine oil level', ok: false, fault: null }] },
    });
    expect(markXs(output)).toEqual([]);
    expect(bytesInclude(output, 'Engine oil level')).toBe(true);
  });

  it('marks one cell, not two, for a malformed row with two truthy members', async () => {
    const original = await makeFlatPdf();
    const output = await roundTripExport({
      originalPdf: original,
      fields: [GROUPED_FIELD],
      values: { checks: [{ item: 'Engine oil level', ok: true, fault: true }] },
    });
    // `selectedOption` reports the first truthy member; the sibling stays blank.
    expect(markXs(output)).toEqual([cellX(1)]);
  });

  it('renders a grouped set and an ungrouped free-text column together', async () => {
    const original = await makeFlatPdf();
    const field: FormField = {
      ...GROUPED_FIELD,
      columns: [
        { key: 'item', label: 'Item', type: 'text' },
        { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
        { key: 'fault', label: 'Fault', type: 'boolean_yes_no' },
        { key: 'comment', label: 'Comment', type: 'text' },
      ],
      answerSets: [{ key: 'status', columnKeys: ['ok', 'fault'] }],
    };
    const output = await roundTripExport({
      originalPdf: original,
      fields: [field],
      values: { checks: [{ item: 'Engine oil level', fault: true, comment: 'Topped up' }] },
    });
    expect(markXs(output)).toEqual([cellX(2)]);
    const comment = drawnGlyphs(output).find((g) => g.text === 'Topped up');
    expect(comment?.x).toBe(cellX(3));
  });
});

/**
 * U11 — the exported PDF is evidence of what was RECORDED. A field the filler
 * never saw must not be drawn on the page, even when a stale value for it is
 * still sitting in the submission (a draft saved before the source answer
 * changed). The filter lives inside `roundTripExport` so no caller can forget
 * it.
 */
describe('roundTripExport — conditional visibility', () => {
  const trigger: FormField = {
    id: 'has_plant',
    type: 'boolean_yes_no',
    label: 'Plant on site?',
    required: false,
    source: 'imported',
    sourcePosition: { page: 0, x: 130, y: 720, width: 200, height: 16, pageWidth: 600, pageHeight: 800 },
  };
  const conditional: FormField = {
    id: 'plant_reg',
    type: 'text',
    label: 'Plant registration',
    required: false,
    source: 'imported',
    visibleWhen: { fieldId: 'has_plant', op: 'equals', value: 'true' },
    sourcePosition: { page: 0, x: 130, y: 660, width: 200, height: 16, pageWidth: 600, pageHeight: 800 },
  };

  it('does not draw a hidden field, even when a stale value survives for it', async () => {
    const original = await makeFlatPdf();
    const output = await roundTripExport({
      originalPdf: original,
      fields: [trigger, conditional],
      values: { has_plant: false, plant_reg: 'STALE-REG-9' },
    });
    expect(bytesInclude(output, 'STALE-REG-9')).toBe(false);
    expect(bytesInclude(output, LETTERHEAD)).toBe(true);
  });

  it('draws the same field once its condition is met', async () => {
    const original = await makeFlatPdf();
    const output = await roundTripExport({
      originalPdf: original,
      fields: [trigger, conditional],
      values: { has_plant: true, plant_reg: 'REG-9' },
    });
    expect(bytesInclude(output, 'REG-9')).toBe(true);
  });

  it('drops a whole hidden section, header scope included', async () => {
    const original = await makeFlatPdf();
    const header: FormField = {
      id: 'plant_section',
      type: 'section_header',
      label: 'Plant',
      required: false,
      source: 'imported',
      visibleWhen: { fieldId: 'has_plant', op: 'equals', value: 'true' },
    };
    const inSection: FormField = {
      id: 'plant_owner',
      type: 'text',
      label: 'Owner',
      required: false,
      source: 'imported',
      sourcePosition: { page: 0, x: 130, y: 600, width: 200, height: 16, pageWidth: 600, pageHeight: 800 },
    };
    const output = await roundTripExport({
      originalPdf: original,
      fields: [trigger, header, inSection],
      values: { has_plant: false, plant_owner: 'SECTION-OWNER' },
    });
    expect(bytesInclude(output, 'SECTION-OWNER')).toBe(false);
  });

  it('exports a condition-free form exactly as it does today', async () => {
    const original = await makeFlatPdf();
    const output = await roundTripExport({ originalPdf: original, fields: FIELDS, values: VALUES });
    expect(bytesInclude(output, 'Warehouse B')).toBe(true);
    expect(bytesInclude(output, 'Fire extinguishers tagged')).toBe(true);
  });
});

/**
 * A check/cross column records THREE states and the export must preserve all
 * three. `scalarText` used to collapse `false` to an empty string, so an
 * assessor's explicit cross reached the PDF as a blank cell — indistinguishable
 * from never-assessed on the one artefact an investigation actually reads.
 *
 * The marks are vector strokes, not glyphs, because the page font is
 * `StandardFonts.Helvetica` (WinAnsi) and neither U+2713 nor U+2717 exists in
 * that encoding. So these assert on the drawn CONTENT rather than on decoded
 * text: counting stroke operators is unreliable against a compressed stream,
 * but "did the page change, and did it change differently" is exactly the
 * property that matters.
 */
describe('roundTripExport — check/cross columns', () => {
  const columnsWith = (type: string) => [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'result', label: 'Result', type },
    { key: 'note', label: 'Note', type: 'text' },
    { key: 'spare', label: 'Spare', type: 'text' },
  ];

  const CHECK_FIELD: FormField = {
    id: 'checks',
    type: 'repeating_group',
    label: 'Competency checks',
    required: false,
    source: 'imported',
    columns: columnsWith('check_cross') as FormField['columns'],
    sourcePosition: { ...GROUPED_POS },
  };

  /** Export one row, optionally overriding the result column's type. */
  async function exportRow(result: unknown, type = 'check_cross'): Promise<string> {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [{ ...CHECK_FIELD, columns: columnsWith(type) as FormField['columns'] }],
      values: { checks: [{ item: 'Isolation applied', result }] as never },
    });
    return decodedText(output);
  }

  it('draws something for an explicit false — the cross must not vanish', async () => {
    // Before the fix these were byte-identical: a recorded fail and an
    // untouched cell produced the same page.
    expect(await exportRow(false)).not.toBe(await exportRow(null));
  });

  it('draws a different mark for true than for false', async () => {
    // A tick has an elbow, a cross does not. If these ever match, the two
    // states are indistinguishable on the page — the whole failure this column
    // type exists to prevent.
    expect(await exportRow(true)).not.toBe(await exportRow(false));
  });

  it('draws nothing for an untouched cell', async () => {
    // Same page as a plain checkbox left false, which draws no mark at all.
    expect(await exportRow(null)).toBe(await exportRow(false, 'checkbox'));
  });

  it('still draws the row label alongside the mark', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [CHECK_FIELD],
      values: { checks: [{ item: 'Isolation applied', result: false }] as never },
    });
    expect(bytesInclude(output, 'Isolation applied')).toBe(true);
  });

  it('leaves a plain checkbox false blank — there, unticked is not an answer', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [{ ...CHECK_FIELD, columns: columnsWith('checkbox') as FormField['columns'] }],
      values: { checks: [{ item: 'Isolation applied', result: false }] as never },
    });
    expect(markXs(output)).toEqual([]);
  });

  it('marks a boolean_yes_no false as N rather than leaving it blank', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [{ ...CHECK_FIELD, columns: columnsWith('boolean_yes_no') as FormField['columns'] }],
      values: { checks: [{ item: 'Isolation applied', result: false }] as never },
    });
    expect(drawnGlyphs(output).filter((g) => g.text === 'N').map((g) => g.x)).toEqual([cellX(1)]);
  });
});
