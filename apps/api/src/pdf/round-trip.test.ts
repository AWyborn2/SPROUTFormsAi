import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { FormField, PageBox, SubmissionValue } from '@formai/shared';
import { roundTripExport } from './round-trip.js';
import { LETTERHEAD, makeFlatPdf, makeTwoPageFlatPdf } from './test-pdfs.js';

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

/** X positions of every glyph whose text is exactly `ch`, sorted. */
function glyphXs(bytes: Uint8Array, ch: string): number[] {
  return drawnGlyphs(bytes)
    .filter((g) => g.text === ch)
    .map((g) => g.x)
    .sort((a, b) => a - b);
}

interface Stroke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Every stroked line segment on the page. `drawMark` (the tick/cross vector
 * glyph) is the only thing in these fixtures that strokes lines — the base PDFs
 * draw text only — so every segment here belongs to a mark. pdf-lib emits each
 * `drawLine` as `<x1> <y1> m  <x1> <y1> m  <x2> <y2> l  S` (the move is
 * repeated), which this regex reads back.
 */
function strokes(bytes: Uint8Array): Stroke[] {
  const buf = Buffer.from(bytes);
  const hay = buf.toString('latin1');
  const out: Stroke[] = [];
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
    const re = /(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l\s+S/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      out.push({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[5]), y2: Number(m[6]) });
    }
    pos = end + 9;
  }
  return out;
}

interface Mark {
  kind: 'tick' | 'cross';
  x: number;
  y: number;
}

/**
 * Every vector mark (`drawMark`) drawn on the page. Each mark is two
 * consecutive line segments; a tick's second segment starts where its first
 * ended (the elbow), a cross's two segments do not meet — that is how the two
 * are told apart. The anchor `x` is the first segment's start, which is the
 * mark's leftmost point and equals the shared `markPlacement` x — so a tick's
 * `x` lands at exactly the same column position an `X` text mark used to.
 */
function drawnMarks(bytes: Uint8Array): Mark[] {
  const s = strokes(bytes);
  const out: Mark[] = [];
  for (let i = 0; i + 1 < s.length; i += 2) {
    const a = s[i]!;
    const b = s[i + 1]!;
    const elbow = Math.abs(a.x2 - b.x1) < 0.01 && Math.abs(a.y2 - b.y1) < 0.01;
    out.push({ kind: elbow ? 'tick' : 'cross', x: a.x1, y: a.y1 });
  }
  return out;
}

/** X positions of every tick drawn, sorted. */
function tickXs(bytes: Uint8Array): number[] {
  return drawnMarks(bytes)
    .filter((m) => m.kind === 'tick')
    .map((m) => m.x)
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

/**
 * Explicit bands reproducing the four 100pt columns the old arithmetic implied.
 *
 * The exporter no longer divides a box into equal cells — equal division is
 * only faithful on a uniform grid, and the compliance tables it exists for have
 * a wide label column beside narrow option columns. These fixtures therefore
 * STATE their geometry instead of having it inferred, which is what the shipped
 * path now requires. Column positions are unchanged, so every `cellX`
 * assertion still means exactly what it did.
 */
function groupedGeometry(keys: string[], rowCount = 4) {
  const rowHeight = GROUPED_POS.height / rowCount;
  return {
    segments: [
      {
        ...GROUPED_POS,
        columnBands: keys.map((key, i) => ({
          key,
          start: GROUPED_POS.x + (GROUPED_POS.width / keys.length) * i,
          end: GROUPED_POS.x + (GROUPED_POS.width / keys.length) * (i + 1),
        })),
        rowBands: Array.from({ length: rowCount }, (_, i) => ({
          key: `r${i}`,
          start: GROUPED_POS.y + GROUPED_POS.height - rowHeight * (i + 1),
          end: GROUPED_POS.y + GROUPED_POS.height - rowHeight * i,
        })),
      },
    ],
  };
}

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
  geometry: groupedGeometry(['item', 'ok', 'fault', 'na']),
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
    geometry: groupedGeometry(['item', 'pass']),
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

  it('exports an ungrouped boolean_yes_no table with Y per truthy cell', async () => {
    const original = await makeFlatPdf();
    const output = await roundTripExport({ originalPdf: original, fields: FIELDS, values: VALUES });
    // `pass` is a boolean_yes_no column, so true renders the literal answer `Y`
    // (not `X`). Both rows draw it in the single option column (index 1 of 2,
    // width 200), and nothing draws a bare `X` any more.
    expect(glyphXs(output, 'Y')).toEqual([40 + 200 + 3, 40 + 200 + 3]);
    expect(markXs(output)).toEqual([]);
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
    // A chosen answer-set member is a ticked checkbox, so it renders as a tick
    // (vector, via drawMark) — never a literal `X`. Placement is unchanged: the
    // ticks land at the same column x the old `X` marks used (`na` = index 3,
    // `ok` = index 1).
    expect(tickXs(output)).toEqual([cellX(1), cellX(3)]);
    expect(markXs(output)).toEqual([]);
    // …and on that row (the topmost, so the highest y) its two siblings are blank.
    const marks = drawnMarks(output).filter((m) => m.kind === 'tick');
    const topY = Math.max(...marks.map((m) => m.y));
    const firstRow = marks.filter((m) => m.y === topY).map((m) => m.x);
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
    expect(drawnMarks(output)).toEqual([]);
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
    // The chosen member renders as a single tick.
    expect(tickXs(output)).toEqual([cellX(1)]);
    expect(markXs(output)).toEqual([]);
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
      geometry: groupedGeometry(['item', 'ok', 'fault', 'comment']),
    };
    const output = await roundTripExport({
      originalPdf: original,
      fields: [field],
      values: { checks: [{ item: 'Engine oil level', fault: true, comment: 'Topped up' }] },
    });
    // The chosen set member (`fault`, index 2) draws a tick; the free-text
    // column keeps drawing its literal text at its own column.
    expect(tickXs(output)).toEqual([cellX(2)]);
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
    geometry: groupedGeometry(['item', 'result', 'note', 'spare']),
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

  it('covers AE3 — marks a boolean_yes_no true as Y, not X', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [{ ...CHECK_FIELD, columns: columnsWith('boolean_yes_no') as FormField['columns'] }],
      values: { checks: [{ item: 'Isolation applied', result: true }] as never },
    });
    // A yes/no answer renders its literal glyph: Y for true. Never a bare `X`.
    expect(glyphXs(output, 'Y')).toEqual([cellX(1)]);
    expect(markXs(output)).toEqual([]);
  });

  it('covers AE2 — an independent checkbox true draws a tick, not X', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [{ ...CHECK_FIELD, columns: columnsWith('checkbox') as FormField['columns'] }],
      values: { checks: [{ item: 'Isolation applied', result: true }] as never },
    });
    // A ticked checkbox renders as a vector tick (the page font has no `✓`),
    // at the same column x a text mark would use. No literal `X` is drawn.
    expect(tickXs(output)).toEqual([cellX(1)]);
    expect(markXs(output)).toEqual([]);
  });

  it('covers AE4 — check_cross still draws a tick for true and a cross for false', async () => {
    const trueOut = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [CHECK_FIELD],
      values: { checks: [{ item: 'Isolation applied', result: true }] as never },
    });
    const falseOut = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [CHECK_FIELD],
      values: { checks: [{ item: 'Isolation applied', result: false }] as never },
    });
    // Unchanged behaviour, now pinned on the drawn marks themselves: one tick
    // for true, one cross for false, both at the result column.
    expect(drawnMarks(trueOut)).toEqual([{ kind: 'tick', x: cellX(1), y: expect.any(Number) }]);
    expect(drawnMarks(falseOut)).toEqual([{ kind: 'cross', x: cellX(1), y: expect.any(Number) }]);
  });

  it('places every column type at the same column x — only the glyph differs', async () => {
    const row = { item: 'Isolation applied', result: true } as never;
    const tickOut = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [{ ...CHECK_FIELD, columns: columnsWith('checkbox') as FormField['columns'] }],
      values: { checks: [row] },
    });
    const yesNoOut = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [{ ...CHECK_FIELD, columns: columnsWith('boolean_yes_no') as FormField['columns'] }],
      values: { checks: [row] },
    });
    // The tick's anchor x and the `Y` glyph's x are identical — placement is
    // shared across glyph types, so swapping the glyph never moves the mark.
    expect(tickXs(tickOut)).toEqual(glyphXs(yesNoOut, 'Y'));
  });
});

/**
 * U5 — marks land in RECORDED cells, on the right pages. The equal-division
 * arithmetic that used to place them is gone: it was only faithful on a uniform
 * grid, and a mark in the wrong cell of a competency record is a false
 * statement that an operator was assessed on something nobody checked.
 */
describe('roundTripExport — export against real bands', () => {
  const cols: FormField['columns'] = [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'tick', label: 'Tick', type: 'boolean_yes_no' },
    { key: 'cross', label: 'Cross', type: 'boolean_yes_no' },
  ];

  /** A table continuing from page 0 onto page 1, two rows on each. */
  function twoPageField(): FormField {
    const band = (key: string, start: number, end: number) => ({ key, start, end });
    const segment = (page: number) => ({
      page,
      x: 40,
      y: 400,
      width: 300,
      height: 80,
      pageWidth: 600,
      pageHeight: 800,
      columnBands: [band('item', 40, 240), band('tick', 240, 290), band('cross', 290, 340)],
      rowBands: [band('r0', 440, 480), band('r1', 400, 440)],
    });
    return {
      id: 'checks',
      type: 'repeating_group',
      label: 'Checks',
      required: false,
      source: 'imported',
      columns: cols,
      answerSets: [{ key: 'status', columnKeys: ['tick', 'cross'] }],
      geometry: { segments: [segment(0), segment(1)] },
    };
  }

  it('covers AE2 — the mark lands in the answered column and siblings stay blank', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [twoPageField()],
      values: { checks: [{ item: 'Isolation applied', cross: true }] },
    });

    // `cross` is the chosen answer-set member, so it renders as a tick. The
    // cross band runs 290-340, so the tick anchors at 293 — the same x the old
    // `X` text mark used.
    expect(tickXs(output)).toEqual([293]);
    expect(markXs(output)).toEqual([]);
  });

  it('covers AE1 — a table spanning two pages draws on both', async () => {
    const output = await roundTripExport({
      originalPdf: await makeTwoPageFlatPdf(),
      fields: [twoPageField()],
      values: {
        checks: [
          { item: 'Row one', tick: true },
          { item: 'Row two', tick: true },
          { item: 'Row three', tick: true },
        ],
      },
    });

    const doc = await PDFDocument.load(output);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    // Three rows against two row bands per segment: two land on page 0 and the
    // third continues onto page 1. Each chosen `tick` member renders as a tick
    // at the tick band's x (240-290 → 243) — placement unchanged.
    expect(tickXs(output)).toEqual([243, 243, 243]);
    expect(markXs(output)).toEqual([]);
  });

  it('skips a column that has no band rather than guessing where it sits', async () => {
    const field = twoPageField();
    field.geometry!.segments = field.geometry!.segments.map((s) => ({
      ...s,
      columnBands: s.columnBands!.filter((b) => b.key !== 'cross'),
    }));

    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [field],
      values: { checks: [{ item: 'Isolation applied', cross: true }] },
    });

    expect(tickXs(output)).toEqual([]);
    expect(drawnMarks(output)).toEqual([]);
  });

  it('covers AE4 — a table with no confirmed geometry contributes nothing, and export still succeeds', async () => {
    const field = twoPageField();
    delete field.geometry;

    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [
        field,
        {
          id: 'site',
          type: 'text',
          label: 'Site',
          required: false,
          source: 'imported',
          sourcePosition: { page: 0, x: 130, y: 680, width: 200, height: 16, pageWidth: 600, pageHeight: 800 },
        },
      ],
      values: { checks: [{ item: 'Isolation applied', cross: true }], site: 'Warehouse B' },
    });

    // No arithmetic fallback: the table draws nothing at all...
    expect(tickXs(output)).toEqual([]);
    expect(drawnMarks(output)).toEqual([]);
    // ...while every other field still exports.
    expect(bytesInclude(output, 'Warehouse B')).toBe(true);
  });

  it('draws nothing for rows beyond the bands the table actually has', async () => {
    const output = await roundTripExport({
      originalPdf: await makeTwoPageFlatPdf(),
      fields: [twoPageField()],
      values: {
        checks: Array.from({ length: 9 }, (_, i) => ({ item: `Row ${i}`, tick: true })),
      },
    });

    // Four row bands across two segments — the five extra rows have nowhere
    // recorded to go, so they are not drawn.
    expect(tickXs(output)).toHaveLength(4);
  });

  it('still exports a legacy scalar field positioned by sourcePosition alone', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: FIELDS,
      values: VALUES,
    });

    expect(bytesInclude(output, 'Warehouse B')).toBe(true);
  });
});

/**
 * U2 / parent R9 — the closure lock. A scalar field on an AI-extracted flat
 * form has NO `sourcePosition` (only AcroForm fields ever get one), so the only
 * place its value can print is the reviewer's hand-drawn, confirmed box. The
 * export side was already built; this proves the loop is genuinely closed —
 * confirmed single-box geometry renders the value, and a scalar with no
 * geometry is skipped exactly as before.
 */
describe('roundTripExport — scalar hand-drawn geometry (R9)', () => {
  const BOX: PageBox = {
    page: 0,
    x: 120,
    y: 300,
    width: 90,
    height: 16,
    pageWidth: 600,
    pageHeight: 800,
  };

  const drawnScalar = (geometry?: PageBox): FormField => ({
    id: 'date',
    type: 'text',
    label: 'Date',
    required: false,
    source: 'imported',
    // Deliberately no `sourcePosition` — the AI-extracted state R9 is about.
    ...(geometry ? { geometry: { segments: [geometry] } } : {}),
  });

  it('draws a confirmed scalar box’s value inside the drawn box', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [drawnScalar(BOX)],
      values: { date: '23/07/2026' },
    });

    // The value landed on the page, at the box's own x (the scalar draw path
    // insets by 3pt) — proof it rendered at the hand-drawn placement, not a
    // legacy sourcePosition.
    const glyph = drawnGlyphs(output).find((g) => g.text === '23/07/2026');
    expect(glyph).toBeDefined();
    expect(glyph!.x).toBeCloseTo(BOX.x + 3, 5);
  });

  it('skips the same scalar when it carries no geometry (unchanged)', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [drawnScalar(undefined)],
      values: { date: '23/07/2026' },
    });

    expect(bytesInclude(output, '23/07/2026')).toBe(false);
    expect(bytesInclude(output, LETTERHEAD)).toBe(true);
  });
});

/**
 * Checkbox-group per-option geometry. A checkbox group prints a row of `☐`
 * boxes; the reviewer draws one box per option (each carrying its `optionKey`),
 * and every SELECTED option is drawn as a checkmark in its own box — not as the
 * option's letter. This is the `Shift` (D / N) fix: answering `D` draws a ✓ in
 * the D box, where the old scalar path printed the literal "D".
 */
describe('roundTripExport — checkbox-group per-option checkmarks', () => {
  const D_BOX: PageBox = {
    page: 0, x: 200, y: 500, width: 14, height: 14, pageWidth: 600, pageHeight: 800, optionKey: 'D',
  };
  const N_BOX: PageBox = {
    page: 0, x: 260, y: 500, width: 14, height: 14, pageWidth: 600, pageHeight: 800, optionKey: 'N',
  };

  const shiftField = (geometry?: PageBox[]): FormField => ({
    id: 'shift',
    type: 'checkbox_group',
    label: 'Shift',
    required: false,
    source: 'imported',
    options: ['D', 'N'],
    selectionType: 'single',
    ...(geometry ? { geometry: { segments: geometry } } : {}),
  });

  // The tick's own origin x, centred inside a 14pt box: size = clamp(14-3)=9,
  // so x = boxX + (14 - 9) / 2 = boxX + 2.5.
  const tickCentreX = (boxX: number) => boxX + 2.5;

  it('draws a ✓ in the SELECTED option’s box and nothing in the other', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [shiftField([D_BOX, N_BOX])],
      values: { shift: ['D'] },
    });

    const xs = tickXs(output);
    expect(xs).toHaveLength(1);
    expect(xs[0]).toBeCloseTo(tickCentreX(D_BOX.x), 5); // the D box, not the N box
  });

  it('accepts a single string value as well as an array', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [shiftField([D_BOX, N_BOX])],
      values: { shift: 'N' },
    });

    const xs = tickXs(output);
    expect(xs).toHaveLength(1);
    expect(xs[0]).toBeCloseTo(tickCentreX(N_BOX.x), 5);
  });

  it('ticks every selected option on a multi-select', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [{ ...shiftField([D_BOX, N_BOX]), selectionType: 'multiple' }],
      values: { shift: ['D', 'N'] },
    });

    expect(tickXs(output)).toHaveLength(2);
  });

  it('draws nothing when no option is selected', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [shiftField([D_BOX, N_BOX])],
      values: { shift: [] },
    });

    expect(tickXs(output)).toHaveLength(0);
  });

  it('exports as data (no mark) when the field has no per-option geometry', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [shiftField(undefined)],
      values: { shift: ['D'] },
    });

    expect(tickXs(output)).toHaveLength(0);
  });
})

/**
 * The same per-option checkmark path serves radio ("multiple choice") and
 * dropdown, not only checkbox_group — every choice field can carry one box per
 * option and tick the selected one, rather than printing its text.
 */
describe('roundTripExport — per-option checkmarks for radio and dropdown', () => {
  const A_BOX: PageBox = {
    page: 0, x: 200, y: 500, width: 14, height: 14, pageWidth: 600, pageHeight: 800, optionKey: 'Day',
  };
  const B_BOX: PageBox = {
    page: 0, x: 260, y: 500, width: 14, height: 14, pageWidth: 600, pageHeight: 800, optionKey: 'Night',
  };

  const choiceField = (type: FormField['type']): FormField => ({
    id: 'shift',
    type,
    label: 'Shift',
    required: false,
    source: 'imported',
    options: ['Day', 'Night'],
    geometry: { segments: [A_BOX, B_BOX] },
  });

  for (const type of ['radio', 'dropdown'] as const) {
    it(`ticks the selected option's box for a ${type} (single string value)`, async () => {
      const output = await roundTripExport({
        originalPdf: await makeFlatPdf(),
        fields: [choiceField(type)],
        values: { shift: 'Night' },
      });

      const xs = tickXs(output);
      expect(xs).toHaveLength(1);
      expect(xs[0]).toBeCloseTo(B_BOX.x + 2.5, 5); // the Night box, not Day
    });

    it(`draws nothing for a ${type} with no per-option geometry`, async () => {
      const field = choiceField(type);
      const output = await roundTripExport({
        originalPdf: await makeFlatPdf(),
        fields: [{ ...field, geometry: undefined }],
        values: { shift: 'Night' },
      });

      expect(tickXs(output)).toHaveLength(0);
    });
  }
})

/**
 * A choice field the reviewer set to `printSelectedValue` draws its selected
 * value as TEXT in one box, not a checkmark per option — the write-in dropdown
 * case (a PDF with one blank for the chosen value, not a row of tick boxes).
 */
describe('roundTripExport — a printSelectedValue dropdown writes its value as text', () => {
  const BOX: PageBox = {
    page: 0, x: 200, y: 500, width: 120, height: 16, pageWidth: 600, pageHeight: 800,
  };

  const dropdown = (printSelectedValue: boolean, geometry: PageBox[]): FormField => ({
    id: 'shift',
    type: 'dropdown',
    label: 'Shift',
    required: false,
    source: 'imported',
    options: ['Day', 'Night'],
    printSelectedValue,
    geometry: { segments: geometry },
  });

  it('draws the value as text and no checkmark when printSelectedValue is set', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [dropdown(true, [BOX])], // one box, no optionKey — a scalar placement
      values: { shift: 'Night' },
    });

    expect(bytesInclude(output, 'Night')).toBe(true); // the value, printed as text
    expect(tickXs(output)).toHaveLength(0); // and NOT a tick
  });

  it('still ticks per option when printSelectedValue is off (default)', async () => {
    const NIGHT_BOX: PageBox = { ...BOX, width: 14, optionKey: 'Night' };
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [dropdown(false, [NIGHT_BOX])],
      values: { shift: 'Night' },
    });

    expect(tickXs(output)).toHaveLength(1); // a tick in the Night box
    expect(bytesInclude(output, 'Night')).toBe(false); // not the letter/word
  });
})
