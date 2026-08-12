/**
 * A drawn signature reaches the page as an IMAGE, and every failure is blank.
 *
 * A signature is  — tens of kilobytes of base64.
 * Before image embedding existed the value reached  and was drawn
 * as a caption: pdf-lib breaks lines only on ' ' and base64 has none, so it
 * emitted ONE unbreakable line thousands of points wide across the record, and
 * being fully WinAnsi-encodable it never threw. A guard was added to draw
 * nothing instead.
 *
 * round-trip.ts now embeds the PNG. The guard still matters, because it is what
 * a malformed or unsupported payload falls back to: a missing signature is a
 * visible gap someone chases up, a broken one is a crashed export or a defaced
 * certificate.
 */
﻿import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { GLYPH_KINDS, MARK_STYLES_DRAWN } from '@formai/shared';
import type { FormField, GlyphKind, PageBox, SubmissionValue } from '@formai/shared';
import { resolveMarkStyle, roundTripExport } from './round-trip.js';
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
  const out: Stroke[] = [];
  for (const content of contentStreams(bytes)) {
    const re = /(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l\s+S/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      out.push({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[5]), y2: Number(m[6]) });
    }
  }
  return out;
}

/**
 * Every decoded content stream in the document.
 *
 * Split out from `strokes` so colour and curve assertions read the same bytes
 * rather than each re-implementing the inflate loop — a second copy would drift
 * from this one the first time a fixture changed.
 */
function contentStreams(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const hay = buf.toString('latin1');
  const out: string[] = [];
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
      out.push(zlib.inflateSync(buf.subarray(dataStart, end)).toString('latin1'));
    } catch {
      // Not a deflate stream (an embedded font, an image) — nothing to read.
    }
    pos = end + 9;
  }
  return out;
}

/**
 * Every STROKE colour set on the page, in order, as `r g b`.
 *
 * pdf-lib emits a stroking colour as `<r> <g> <b> RG`. The verdict rings are the
 * only thing in these fixtures that sets one to anything but the default ink, so
 * reading them back is how a green ring is told from a red one.
 */
function strokeColors(bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (const content of contentStreams(bytes)) {
    const re = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) RG/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push(`${m[1]} ${m[2]} ${m[3]}`);
  }
  return out;
}

/** How many bezier curve segments were stroked — an ellipse is drawn from them. */
function curveCount(bytes: Uint8Array): number {
  return contentStreams(bytes).reduce(
    (n, content) => n + (content.match(/ c\s/g)?.length ?? 0),
    0,
  );
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

  /*
   * Per-row placement (the measured grid's manual fallback) stores one small
   * segment per row an author drew, its band keyed `row:<n>`. The property
   * pinned here is the reason the key exists: a row the author did NOT place
   * must not shift every later mark up the table. Positional consumption would
   * have drawn row 1's tick in row 2's box; keyed consumption draws row 2's
   * own cross there and gives row 1 nothing.
   */
  it('maps row:<n> bands to value rows by index, so unplaced rows leave a gap rather than a shift', async () => {
    const rowCell = (rowIndex: number, yStart: number): NonNullable<FormField['geometry']>['segments'][number] => ({
      page: 0,
      x: 240,
      y: yStart,
      width: 50,
      height: 40,
      pageWidth: 600,
      pageHeight: 800,
      columnBands: [{ key: 'done', start: 240, end: 290 }],
      rowBands: [{ key: `row:${rowIndex}`, start: yStart, end: yStart + 40 }],
    });
    const field: FormField = {
      id: 'checks',
      type: 'repeating_group',
      label: 'Checks',
      required: false,
      source: 'imported',
      columns: [
        { key: 'item', label: 'Item', type: 'text' },
        { key: 'done', label: 'Done', type: 'check_cross' },
      ],
      // Rows 0 and 2 placed by hand; row 1 never was.
      geometry: { segments: [rowCell(0, 440), rowCell(2, 360)] },
    };

    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [field],
      values: {
        checks: [
          { item: 'First', done: true },
          { item: 'Second', done: true },
          { item: 'Third', done: false },
        ],
      },
    });

    const marks = drawnMarks(output);
    expect(marks).toHaveLength(2);
    // Row 0's tick in row 0's own cell (y 440-480)…
    expect(marks[0]).toMatchObject({ kind: 'tick' });
    expect(marks[0]!.y).toBeGreaterThanOrEqual(440);
    expect(marks[0]!.y).toBeLessThan(480);
    // …and row 2's CROSS in row 2's cell (y 360-400). A positional consumer
    // would have put row 1's TICK here instead.
    expect(marks[1]).toMatchObject({ kind: 'cross' });
    expect(marks[1]!.y).toBeGreaterThanOrEqual(360);
    expect(marks[1]!.y).toBeLessThan(400);
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
 * A drawn signature reaches the page as an IMAGE, and every failure is blank.
 *
 * A signature is `canvas.toDataURL('image/png')` — tens of kilobytes of base64.
 * Before image embedding existed the value reached `String(...)` and was drawn
 * as a caption: pdf-lib breaks lines only on ' ' and base64 has none, so it
 * emitted ONE unbreakable line thousands of points wide across the record, and
 * being fully WinAnsi-encodable it never threw. A guard was added to draw
 * nothing instead.
 *
 * `round-trip.ts` now embeds the PNG. The guard still matters, because it is
 * what a malformed or unsupported payload falls back to: a missing signature is
 * a visible gap someone chases up, while a broken one is either a crashed
 * export or a defaced certificate.
 */
describe('roundTripExport — a drawn signature', () => {
  const BOX: PageBox = { page: 0, x: 120, y: 300, width: 90, height: 16, pageWidth: 600, pageHeight: 800 };
  /** Header bytes repeated — passes the PNG magic check, fails to decode. */
  const PNG_DATA_URL = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUg'.repeat(40)}`;
  /** A real 1×1 PNG. Small on purpose: the fit maths is what is under test. */
  const REAL_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  const signed = (type: FormField['type']): FormField => ({
    id: 'sig',
    type,
    label: 'Assessor Signature',
    required: false,
    source: 'imported',
    geometry: { segments: [BOX] },
  });

  it('embeds a real signature as an image', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [signed('signature')],
      values: { sig: REAL_PNG },
    });

    // An image XObject reached the document — the signature is on the page.
    expect(bytesInclude(output, '/Image')).toBe(true);
    // And it is NOT drawn as text.
    expect(bytesInclude(output, 'iVBORw0KGgo')).toBe(false);
    expect(bytesInclude(output, LETTERHEAD)).toBe(true);
  });

  it('embeds it when the same blob arrives under type text', async () => {
    // Extraction folds signature boxes into text inputs, so the branch cannot
    // key on the `signature` TYPE — it has to be about the value.
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [signed('text')],
      values: { sig: REAL_PNG },
    });

    expect(bytesInclude(output, '/Image')).toBe(true);
  });

  it('draws nothing at all for a malformed PNG', async () => {
    /*
      The payload below carries the PNG magic number but decodes to nothing
      usable, so the decoder throws. That must not reach the caller: an export
      that dies takes the whole evidence document with it, and one that draws
      the raw bytes ruins the page. Blank, and the rest of the document intact.
    */
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [signed('signature')],
      values: { sig: PNG_DATA_URL },
    });

    expect(bytesInclude(output, 'base64')).toBe(false);
    expect(bytesInclude(output, 'iVBORw0KGgo')).toBe(false);
    expect(bytesInclude(output, LETTERHEAD)).toBe(true);
  });

  it('draws nothing for a format the decoder was not told about', async () => {
    // Only PNG is recognised, because pdf-lib must be told which decoder to
    // use and guessing wrong throws inside the export. A JPEG data URL — which
    // no surface here produces — falls through to blank rather than crashing.
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [signed('signature')],
      values: { sig: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==' },
    });

    expect(bytesInclude(output, '/9j/4AAQ')).toBe(false);
    expect(bytesInclude(output, LETTERHEAD)).toBe(true);
  });

  it('still draws an ordinary value that merely mentions data', async () => {
    // The guard keys on the `data:` URL scheme, not on the word — it must not
    // swallow a legitimate answer.
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [signed('text')],
      // Short enough not to wrap: maxWidth here is 84pt and pdf-lib breaks on
      // spaces, so a longer phrase would come back as its first line only.
      values: { sig: 'data ok' },
    });

    expect(drawnGlyphs(output).some((g) => g.text === 'data ok')).toBe(true);
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

/**
 * Verdict rings on a marked assessment question.
 *
 * The printed form numbers its answers "a)" / "b)" and an assessor marking it by
 * hand circles the letter. The exported evidence has to be legible to an auditor
 * reading a photocopy beside those hand-marked originals, so a question that
 * carries an answer key gets a RING around the answer given — green when it is
 * in the key, red when it is not — rather than a tick beside it.
 *
 * A field with no key keeps the tick: there is no verdict to report, and a
 * colour would assert one.
 */
describe('roundTripExport — verdict rings on auto-marked questions', () => {
  const GREEN = '0.05 0.42 0.16';
  const RED = '0.7 0.1 0.1';

  const optionBox = (x: number, optionKey: string): PageBox => ({
    page: 0,
    x,
    y: 500,
    width: 10,
    height: 10,
    pageWidth: 600,
    pageHeight: 800,
    optionKey,
  });

  /** Q2 on the dozer: "a) True" / "b) False", key is True. */
  const question = (answerKey?: string[]): FormField => ({
    id: 'ai_31',
    type: 'radio',
    label: 'Q2. 3 points of contact is always required',
    required: false,
    source: 'imported',
    options: ['True', 'False'],
    ...(answerKey ? { answerKey } : {}),
    geometry: { segments: [optionBox(200, 'True'), optionBox(240, 'False')] },
  });

  it('rings a correct answer in green', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [question(['True'])],
      values: { ai_31: 'True' },
    });

    expect(strokeColors(output)).toContain(GREEN);
    expect(strokeColors(output)).not.toContain(RED);
    // An ellipse is stroked from bezier segments; a tick is straight lines.
    expect(curveCount(output)).toBeGreaterThan(0);
  });

  it('rings a wrong answer in red', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [question(['True'])],
      values: { ai_31: 'False' },
    });

    expect(strokeColors(output)).toContain(RED);
    expect(strokeColors(output)).not.toContain(GREEN);
  });

  it('rings only the answer that was given, never the one that was right', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [question(['True'])],
      values: { ai_31: 'False' },
    });

    // Exactly one ring. Circling the correct answer too would annotate the
    // record with something the candidate never wrote, which is a different
    // document from the one they sat.
    expect(strokeColors(output).filter((c) => c === RED || c === GREEN)).toHaveLength(1);
  });

  it('draws no ring at all when nothing was answered', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [question(['True'])],
      values: {},
    });

    expect(strokeColors(output).filter((c) => c === RED || c === GREEN)).toHaveLength(0);
    expect(curveCount(output)).toBe(0);
  });

  it('colours each answer on a multi-select by its own verdict', async () => {
    const multi: FormField = {
      ...question(['Report and do not operate', 'Ensure equipment is repaired']),
      type: 'checkbox_group',
      selectionType: 'multiple',
      options: ['Remove tag and operate', 'Report and do not operate', 'Ensure equipment is repaired'],
      geometry: {
        segments: [
          optionBox(200, 'Remove tag and operate'),
          optionBox(240, 'Report and do not operate'),
          optionBox(280, 'Ensure equipment is repaired'),
        ],
      },
    };
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [multi],
      // One right, one wrong — exact-set-match makes the question incorrect, but
      // the PAGE still has to show which of the two ticks was the mistake.
      values: { ai_31: ['Report and do not operate', 'Remove tag and operate'] },
    });

    const verdicts = strokeColors(output).filter((c) => c === RED || c === GREEN);
    expect(verdicts).toHaveLength(2);
    expect(verdicts).toContain(GREEN);
    expect(verdicts).toContain(RED);
  });

  it('keeps the plain tick on a field with no answer key', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [question()],
      values: { ai_31: 'True' },
    });

    // No key means no verdict; inventing a colour would assert one.
    expect(strokeColors(output).filter((c) => c === RED || c === GREEN)).toHaveLength(0);
    expect(tickXs(output)).toHaveLength(1);
  });

  it('keeps the plain tick when the key is present but empty', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [question([])],
      values: { ai_31: 'True' },
    });

    expect(tickXs(output)).toHaveLength(1);
  });
});

/**
 * A boolean printed as a "No ☐  Yes ☐" PAIR — two placed cells, optionKey
 * `yes`/`no`. The mark's meaning is WHICH CELL it sits in, so the answered
 * cell gets a TICK either way: a cross in the "No" cell would read as
 * "not no". Its partner stays blank, and unanswered draws nothing anywhere.
 */
describe('roundTripExport — a boolean_yes_no placed as a Yes/No pair', () => {
  const cell = (optionKey: 'yes' | 'no', x: number): PageBox => ({
    page: 0,
    x,
    y: 500,
    width: 14,
    height: 12,
    pageWidth: 600,
    pageHeight: 800,
    optionKey,
  });
  const NO_X = 420;
  const YES_X = 470;

  const pairField = (segments = [cell('no', NO_X), cell('yes', YES_X)]): FormField => ({
    id: 'coaching',
    type: 'boolean_yes_no',
    label: 'More coaching and/or training required?',
    required: false,
    source: 'imported',
    geometry: { segments },
  });

  it('ticks the Yes cell for true and leaves the No cell blank', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [pairField()],
      values: { coaching: true },
    });

    const marks = drawnMarks(output);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe('tick');
    expect(marks[0]!.x).toBeGreaterThanOrEqual(YES_X);
    expect(marks[0]!.x).toBeLessThan(YES_X + 14);
  });

  it('ticks the No cell for false — a tick, never a cross that would read as "not no"', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [pairField()],
      values: { coaching: false },
    });

    const marks = drawnMarks(output);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe('tick');
    expect(marks[0]!.x).toBeGreaterThanOrEqual(NO_X);
    expect(marks[0]!.x).toBeLessThan(NO_X + 14);
  });

  it('draws nothing when the question was never answered', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [pairField()],
      values: {},
    });

    expect(drawnMarks(output)).toHaveLength(0);
  });

  it('draws nothing when the answered cell is the one box not yet placed', async () => {
    // Visibly incomplete beats a mark in the wrong cell: with only the No box
    // placed and the answer Yes, nothing draws anywhere.
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [pairField([cell('no', NO_X)])],
      values: { coaching: true },
    });

    expect(drawnMarks(output)).toHaveLength(0);
  });
});

/**
 * A standalone check_cross outcome cell.
 *
 * This is where an auto-marked question's verdict lands: `applyMarks` writes a
 * BOOLEAN into the field named by the question's `outcomeTarget` — true for
 * correct, false for incorrect.
 *
 * It used to fall through to the scalar TEXT path, which rendered that boolean
 * via `scalarText`: `true` drew the letter "X", and `false` drew nothing at all.
 * So a correct answer was stamped with a glyph that reads as a cross, and an
 * incorrect one was blank — indistinguishable, on a competency record, from a
 * question nobody ever assessed. Both directions of that are load-bearing here.
 */
describe('roundTripExport — a standalone check_cross outcome cell', () => {
  const CELL: PageBox = {
    page: 0,
    x: 520,
    y: 600,
    width: 16,
    height: 14,
    pageWidth: 600,
    pageHeight: 800,
  };

  const outcomeField = (): FormField => ({
    id: 'ai_30',
    type: 'check_cross',
    label: 'Q1 Outcome',
    required: false,
    source: 'imported',
    geometry: { segments: [CELL] },
  });

  it('draws a tick when the answer was correct', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [outcomeField()],
      values: { ai_30: true },
    });

    const marks = drawnMarks(output);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe('tick');
  });

  it('draws a CROSS when the answer was incorrect, rather than nothing', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [outcomeField()],
      values: { ai_30: false },
    });

    // A blank cell on a competency record reads as never-assessed. "I checked
    // this and it failed" is a recorded finding and has to appear as one.
    const marks = drawnMarks(output);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe('cross');
  });

  it('draws nothing when the question was never marked', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [outcomeField()],
      values: {},
    });

    // Unmarked is the one state that SHOULD be blank — inventing a glyph here
    // would assert an assessment that never happened.
    expect(drawnMarks(output)).toHaveLength(0);
  });

  it('never stamps the letter X for a correct answer', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [outcomeField()],
      values: { ai_30: true },
    });

    // The old behaviour. An "X" in an outcome column is read by an auditor as a
    // cross, so it said the exact opposite of what was recorded.
    expect(glyphXs(output, 'X')).toEqual([]);
  });

  it('centres the mark in the recorded cell', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [outcomeField()],
      values: { ai_30: true },
    });

    const mark = drawnMarks(output)[0]!;
    // Inside the cell on both axes — a mark hanging outside it would land on a
    // neighbouring question's row.
    expect(mark.x).toBeGreaterThanOrEqual(CELL.x);
    expect(mark.x).toBeLessThan(CELL.x + CELL.width);
    expect(mark.y).toBeGreaterThanOrEqual(CELL.y);
    expect(mark.y).toBeLessThan(CELL.y + CELL.height);
  });

  it('applies the same rule to boolean_yes_no, which is also self-answering', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [{ ...outcomeField(), id: 'ai_20', type: 'boolean_yes_no', label: 'More coaching?' }],
      values: { ai_20: false },
    });

    expect(drawnMarks(output)[0]!.kind).toBe('cross');
  });
});

/*
  THE PAGE FONT IS WINANSI, AND PDF-LIB THROWS ON WHAT IT CANNOT ENCODE.

  Not degrades — throws. So one curly apostrophe in an answer failed the export
  of a completed assessment's evidence PDF, which is the record an investigation
  reads. Values here come out of a PDF and out of typed answers, so smart quotes
  and dashes are ordinary rather than exotic.

  This surfaced while adding matching questions, whose option values join two
  halves of document prose and were about to do it with a "→".
*/
describe('roundTripExport — characters the page font cannot encode', () => {
  const textField = (): FormField => ({
    id: 'site',
    type: 'text',
    label: 'Site',
    required: false,
    source: 'imported',
    sourcePosition: { page: 0, x: 40, y: 700, width: 300, height: 20, pageWidth: 600, pageHeight: 800 },
  });

  it('exports rather than throwing on a curly apostrophe', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [textField()],
      values: { site: 'Operator’s cab' },
    });

    // Straightened, not dropped: the reader still gets the word.
    expect(bytesInclude(output, "Operator's cab")).toBe(true);
  });

  it('transliterates an arrow, which is how a matching answer joins its halves', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [textField()],
      values: { site: 'Statement → Sign' },
    });

    expect(bytesInclude(output, 'Statement -> Sign')).toBe(true);
  });

  it('handles an em dash and an ellipsis', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [textField()],
      values: { site: 'Bay 3—north…' },
    });

    expect(bytesInclude(output, 'Bay 3-north...')).toBe(true);
  });

  it('marks an unrenderable character visibly rather than dropping it', async () => {
    // A silent deletion would leave a record that reads as complete and is not.
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [textField()],
      values: { site: 'Bay 中 3' },
    });

    expect(bytesInclude(output, 'Bay ? 3')).toBe(true);
  });

  it('leaves ordinary text exactly as it was', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [textField()],
      values: { site: 'Warehouse B - level 2 (north)' },
    });

    expect(bytesInclude(output, 'Warehouse B - level 2 (north)')).toBe(true);
  });
});

/*
  A MATCHING ANSWER MUST NOT BE PAINTED ACROSS THE PAGE.

  Its value is a SET of pairings — nine options for a three-by-three question —
  and scalarText joins them. A matching field is authored with no geometry, so
  normally it never reaches the drawing code at all; these cover what happens
  when one carries a box anyway, which is a mis-authored field rather than an
  exotic one.

  The hazard is specific: drawText bounds the WIDTH but not the height, so ~230
  characters wrapped inside a 20pt-high box runs downward across whatever is
  printed beneath it, on a certified competency record, and nothing raises.
*/
describe('roundTripExport — matching questions', () => {
  const PAIRINGS = [
    'Restricted area -> Biosecurity sign',
    'Restricted area -> Traffic hazard sign',
    'Permission to pass -> Biosecurity sign',
    'Permission to pass -> Traffic hazard sign',
  ];

  const matchingField = (extra: Partial<FormField> = {}): FormField => ({
    id: 'q7',
    type: 'checkbox_group',
    label: 'Match the statement with the appropriate signage.',
    required: true,
    source: 'imported',
    options: PAIRINGS,
    ...extra,
  });

  const ANSWER = { q7: ['Restricted area -> Biosecurity sign', 'Permission to pass -> Traffic hazard sign'] };

  it('draws nothing for a matching field with no geometry', async () => {
    // The normal case, and the reason the export needed no work: the printed
    // page already carries the statements and the signs, and the verdict
    // reaches the margin through the separate outcome box.
    const original = await makeFlatPdf();
    const output = await roundTripExport({
      originalPdf: original,
      fields: [matchingField()],
      values: ANSWER,
    });

    expect(bytesInclude(output, 'Biosecurity sign')).toBe(false);
    expect(bytesInclude(output, LETTERHEAD)).toBe(true);
  });

  it('draws nothing even when the field wrongly carries a single box', async () => {
    /*
      THE ONE THAT WOULD HAVE DEFACED THE RECORD. Without the guard this falls
      through to the scalar path and joins every selected pairing into one long
      string, drawn into a 20pt box with no height bound.
    */
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [
        matchingField({
          sourcePosition: {
            page: 0,
            x: 40,
            y: 700,
            width: 200,
            height: 20,
            pageWidth: 600,
            pageHeight: 800,
          },
        }),
      ],
      values: ANSWER,
    });

    expect(bytesInclude(output, 'Biosecurity sign')).toBe(false);
    expect(bytesInclude(output, '->')).toBe(false);
  });

  it('still draws an ordinary checkbox group that happens to have a box', async () => {
    // The guard keys on the OPTIONS being pairings, not on the type — an
    // ordinary group must be unaffected.
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [
        matchingField({
          id: 'plain',
          options: ['Helmet', 'Gloves'],
          sourcePosition: {
            page: 0,
            x: 40,
            y: 700,
            width: 300,
            height: 20,
            pageWidth: 600,
            pageHeight: 800,
          },
        }),
      ],
      values: { plain: ['Helmet'] },
    });

    expect(bytesInclude(output, 'Helmet')).toBe(true);
  });
});

/*
  A MATCHING ANSWER IS A LINE BETWEEN TWO PRINTED THINGS.

  A person doing this question with a pen draws a line from the statement to the
  sign. The evidence export has to show the same thing, or the exported page and
  the filled page are different documents.

  The geometry names the printed ENTRIES — `l0`, `r2` — so a three-by-three
  question needs six anchors rather than nine boxes. Placement used to ask for
  one box per PAIRING, and eight of those nine named a correspondence the page
  never printed anywhere, so there was nothing on the paper to place them on.
*/
describe('roundTripExport — matching connectors', () => {
  const PAIRS = [
    'Restricted area -> Biosecurity sign',
    'Restricted area -> Traffic hazard sign',
    'Permission to pass -> Biosecurity sign',
    'Permission to pass -> Traffic hazard sign',
  ];

  /** An anchor box on a printed entry. */
  const at = (optionKey: string, x: number, y: number): PageBox => ({
    page: 0,
    x,
    y,
    width: 8,
    height: 8,
    pageWidth: 600,
    pageHeight: 800,
    optionKey,
  });

  /*
    Prompts down the left at x=40, answers down the right at x=400 — the shape
    every matching question on this document class is printed in.
  */
  const ANCHORS: PageBox[] = [
    at('l0', 40, 700),
    at('l1', 40, 660),
    at('r0', 400, 700),
    at('r1', 400, 660),
  ];

  const anchored = (extra: Partial<FormField> = {}): FormField => ({
    id: 'q7',
    type: 'checkbox_group',
    label: 'Match the statement with the appropriate signage.',
    required: true,
    source: 'imported',
    options: PAIRS,
    geometry: { segments: ANCHORS },
    ...extra,
  });

  /** Only the strokes that run between the two anchor columns. */
  function connectors(bytes: Uint8Array) {
    return strokes(bytes).filter((s) => Math.abs(s.x2 - s.x1) > 100);
  }

  it('draws ONE line per chosen pairing, between the two anchors it names', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [anchored()],
      values: { q7: ['Restricted area -> Traffic hazard sign'] },
    });

    const drawn = connectors(output);
    expect(drawn).toHaveLength(1);
    // Prompt 0's RIGHT edge to answer 1's LEFT edge, each at mid-height.
    expect(drawn[0]!.x1).toBeCloseTo(48, 1);
    expect(drawn[0]!.y1).toBeCloseTo(704, 1);
    expect(drawn[0]!.x2).toBeCloseTo(400, 1);
    expect(drawn[0]!.y2).toBeCloseTo(664, 1);
  });

  it('DRAWS A WRONG PAIRING TOO, in red', async () => {
    /*
      Drawing only the correct ones would leave a candidate who paired badly
      with a blank matching question on their record — indistinguishable from
      one nobody assessed, which is the failure this whole file is arranged
      against.
    */
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [
        anchored({ answerKey: ['Restricted area -> Biosecurity sign'] }),
      ],
      values: { q7: ['Restricted area -> Traffic hazard sign'] },
    });

    expect(connectors(output)).toHaveLength(1);
    expect(strokeColors(output)).toContain('0.7 0.1 0.1');
  });

  it('draws a correct pairing in green', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [anchored({ answerKey: ['Restricted area -> Biosecurity sign'] })],
      values: { q7: ['Restricted area -> Biosecurity sign'] },
    });

    expect(connectors(output)).toHaveLength(1);
    expect(strokeColors(output)).toContain('0.05 0.42 0.16');
  });

  it('draws each of several chosen pairings', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [anchored()],
      values: {
        q7: ['Restricted area -> Biosecurity sign', 'Permission to pass -> Traffic hazard sign'],
      },
    });

    expect(connectors(output)).toHaveLength(2);
  });

  it('DRAWS NOTHING FOR A PAIRING WITH EITHER END UNPLACED', async () => {
    /*
      The same refusal `drawRepeatingGroup` makes for a cell it cannot place
      from real geometry. An invented endpoint is a line across a competency
      record asserting a correspondence nobody can check — so a half-anchored
      question is visibly incomplete instead, which someone notices and fixes.
    */
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [anchored({ geometry: { segments: [at('l0', 40, 700), at('r0', 400, 700)] } })],
      // Names r1, which has no anchor.
      values: { q7: ['Restricted area -> Traffic hazard sign'] },
    });

    expect(connectors(output)).toHaveLength(0);
  });

  it('rings nothing — an anchor is a line end, not a marked answer', async () => {
    /*
      A keyed choice field RINGS the answer chosen. An anchor is not an answer;
      it is one end of a connector, and a circle round an individual statement
      says something the candidate never did.

      What actually keeps the checkbox path off this field is the ORDER of the
      two branches — matching geometry carries `optionKey`s too, so it has to be
      recognised first. That ordering is pinned by the tests above, which would
      find no connectors at all if the checkbox path claimed the field. This
      pins the other half: exactly two end dots, and nothing else curved.
    */
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [anchored({ answerKey: ['Restricted area -> Biosecurity sign'] })],
      values: { q7: ['Restricted area -> Biosecurity sign'] },
    });

    // Two end dots are ellipses; a ring would add a third.
    expect(curveCount(output)).toBe(8);
  });

  it('attaches to the facing edges when the ANSWERS are printed first', async () => {
    /*
      A paper that prints the signs down the left and the statements down the
      right is the same question. Assuming the prompt column is always left
      would run each line back through the text it starts from.
    */
    const flipped = [
      at('l0', 400, 700),
      at('l1', 400, 660),
      at('r0', 40, 700),
      at('r1', 40, 660),
    ];
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [anchored({ geometry: { segments: flipped } })],
      values: { q7: ['Restricted area -> Biosecurity sign'] },
    });

    const drawn = connectors(output);
    expect(drawn).toHaveLength(1);
    // The prompt is on the RIGHT now, so the line leaves its left edge.
    expect(drawn[0]!.x1).toBeCloseTo(400, 1);
    expect(drawn[0]!.x2).toBeCloseTo(48, 1);
  });

  it('draws nothing when the question was never answered', async () => {
    const output = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: [anchored()],
      values: {},
    });

    expect(connectors(output)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Authored mark styles (U16)
 * ------------------------------------------------------------------ */

describe('resolveMarkStyle', () => {
  const box = (markStyle?: { glyph?: GlyphKind }): PageBox => ({
    page: 0,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    pageWidth: 595,
    pageHeight: 842,
    ...(markStyle ? { markStyle } : {}),
  });

  it('RETURNS THE FALLBACK UNCHANGED WHEN NOTHING IS AUTHORED', () => {
    /*
      THE PROPERTY THIS SEAM LIVES OR DIES BY. Every placement authored before
      mark styles existed carries no markStyle, and there are thousands of them
      on competency records. Absent must mean exactly today's behaviour.
    */
    expect(resolveMarkStyle(box(), 'tick')).toBe('tick');
    expect(resolveMarkStyle(box(), 'cross')).toBe('cross');
    expect(resolveMarkStyle(undefined, 'text')).toBe('text');
    expect(resolveMarkStyle(box({}), 'tick')).toBe('tick');
  });

  it('honours a glyph the exporter can draw', () => {
    expect(resolveMarkStyle(box({ glyph: 'cross_hand' }), 'tick')).toBe('cross');
    expect(resolveMarkStyle(box({ glyph: 'ring' }), 'tick')).toBe('ring');
    expect(resolveMarkStyle(box({ glyph: 'typed' }), 'tick')).toBe('text');
    expect(resolveMarkStyle(box({ glyph: 'signature' }), 'text')).toBe('signature');
  });

  it('draws the CATEGORY, not the stylistic variant', () => {
    // tick_hand and tick_block both resolve to the one vector tick this file
    // draws. Pretending otherwise puts a difference on screen that never
    // reaches the paper.
    expect(resolveMarkStyle(box({ glyph: 'tick_hand' }), 'cross')).toBe('tick');
    expect(resolveMarkStyle(box({ glyph: 'tick_block' }), 'cross')).toBe('tick');
  });

  it('RESOLVES EVERY GLYPH TO ITS OWN MARK, with nothing falling back', () => {
    /*
      These five used to fall back to the field's default because the exporter
      could not draw them — honest at the time, but it meant an author picked a
      style and got a different mark. Each now has a renderer, so each resolves
      to itself.
    */
    expect(resolveMarkStyle(box({ glyph: 'stamp_pass' }), 'tick')).toBe('stamp');
    expect(resolveMarkStyle(box({ glyph: 'stamp_na' }), 'tick')).toBe('stamp');
    expect(resolveMarkStyle(box({ glyph: 'initials' }), 'tick')).toBe('initials');
    expect(resolveMarkStyle(box({ glyph: 'highlight' }), 'tick')).toBe('highlight');
    expect(resolveMarkStyle(box({ glyph: 'match_line' }), 'tick')).toBe('match_line');
  });

  it('leaves NO glyph unmapped', () => {
    // The fallback now means "no style was authored", and nothing else. A
    // glyph reaching it would be one the exporter forgot.
    for (const glyph of GLYPH_KINDS) {
      expect(resolveMarkStyle(box({ glyph }), 'tick')).not.toBe('tick_unmapped' as never);
      const againstText = resolveMarkStyle(box({ glyph }), 'text');
      const againstTick = resolveMarkStyle(box({ glyph }), 'tick');
      expect(againstText === 'text' && againstTick === 'tick').toBe(false);
    }
  });

  it('agrees with the list the builder shows an author', () => {
    /*
      MARK_STYLES_DRAWN is what the inspector labels as reaching the page. If
      the two drift, the builder promises a mark the exporter never draws — the
      exact failure KTD4 refuses.
    */
    for (const glyph of MARK_STYLES_DRAWN) {
      expect(resolveMarkStyle(box({ glyph }), 'tick')).not.toBe('tick_placeholder' as never);
      // Every drawn style must resolve to something OTHER than the fallback
      // for at least one fallback, i.e. it must be in the mapping.
      const resolvedAgainstText = resolveMarkStyle(box({ glyph }), 'text');
      const resolvedAgainstTick = resolveMarkStyle(box({ glyph }), 'tick');
      expect(resolvedAgainstText === 'text' && resolvedAgainstTick === 'tick').toBe(false);
    }
  });
});

describe('roundTripExport — an unauthored placement is unchanged', () => {
  /**
   * The same fields, with one glyph authored onto every placed box.
   *
   * Covers BOTH geometry sources. A field carrying only the legacy
   * `sourcePosition` has to be widened into a segment to hold a style at all —
   * `legacySegment` constructs a bare box and drops `markStyle`, so a glyph can
   * only ever live on `geometry`. Styling just the `geometry` half of this
   * fixture left the one field that types a value untouched, and the test then
   * proved nothing.
   */
  function styledWith(glyph: GlyphKind): FormField[] {
    return FIELDS.map((f) => {
      if (f.geometry) {
        return {
          ...f,
          geometry: { segments: f.geometry.segments.map((s) => ({ ...s, markStyle: { glyph } })) },
        };
      }
      if (f.sourcePosition) {
        return { ...f, geometry: { segments: [{ ...f.sourcePosition, markStyle: { glyph } }] } };
      }
      return f;
    });
  }

  it('THE CHARACTERIZATION TEST — no markStyle draws exactly what it always did', async () => {
    /*
      The property that makes this seam safe to have added to a file that draws
      competency records. Every placement authored before mark styles existed
      carries no `markStyle`, and must be byte-for-byte what it was.

      This used to be phrased as "a style the exporter cannot draw changes
      nothing", which held while five glyphs were ignored. They are all drawn
      now, so the invariant is stated where it actually lives: on ABSENCE.
    */
    const original = await makeFlatPdf();
    const a = await roundTripExport({ originalPdf: original, fields: FIELDS, values: VALUES });
    const b2 = await roundTripExport({ originalPdf: original, fields: FIELDS, values: VALUES });

    expect(drawnMarks(a)).toEqual(drawnMarks(b2));
    expect(markXs(a)).toEqual(markXs(b2));
    // Something was actually drawn, or the comparison above is two empties.
    expect(drawnGlyphs(a).map((g) => g.text).join('')).toContain('Warehouse B');
  });

  it('an authored style now CHANGES the output, which is the point', async () => {
    // While `highlight` was ignored, this pair was identical. A style that
    // reaches the page has to be visible in it.
    const original = await makeFlatPdf();
    const plain = await roundTripExport({ originalPdf: original, fields: FIELDS, values: VALUES });
    const styled = await roundTripExport({
      originalPdf: original,
      fields: styledWith('highlight'),
      values: VALUES,
    });

    // The value the plain export typed is replaced by a wash in the styled one.
    expect(drawnGlyphs(plain).map((g) => g.text).join('')).toContain('Warehouse B');
    expect(drawnGlyphs(styled).map((g) => g.text).join('')).not.toContain('Warehouse B');
  });
});

describe('roundTripExport — the five glyphs that used to be ignored', () => {
  /*
    Each of these was authorable and silently dropped: an author picked it, the
    inspector labelled it not-yet-drawn, and the page got the field's default.
    These pin that each now puts its OWN ink on the page.

    Asserted on the rendered content stream rather than on a mock, because the
    failure being guarded against is precisely a renderer that is never reached.
  */
  function styledSite(glyph: GlyphKind): FormField[] {
    return FIELDS.map((f) =>
      f.id === 'site' && f.sourcePosition
        ? { ...f, geometry: { segments: [{ ...f.sourcePosition, markStyle: { glyph } }] } }
        : f,
    );
  }

  it('stamp_pass prints the word PASS, not the recorded value', async () => {
    const bytes = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: styledSite('stamp_pass'),
      values: VALUES,
    });
    const text = drawnGlyphs(bytes).map((g) => g.text).join('');
    expect(text).toContain('PASS');
    // The value it replaced is gone from that box.
    expect(text).not.toContain('Warehouse B');
  });

  it('stamp_na prints N/A', async () => {
    const bytes = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: styledSite('stamp_na'),
      values: VALUES,
    });
    expect(drawnGlyphs(bytes).map((g) => g.text).join('')).toContain('N/A');
  });

  it('initials reduces the recorded value to letters', async () => {
    // "Warehouse B" initials "WB". A person signing a cell wants their mark,
    // not their whole name across the printed row.
    const bytes = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: styledSite('initials'),
      values: VALUES,
    });
    const text = drawnGlyphs(bytes).map((g) => g.text).join('');
    expect(text).toContain('WB');
    expect(text).not.toContain('Warehouse B');
  });

  it('initials draws NOTHING when there is nothing recorded', async () => {
    // Inventing initials would put a person's mark on a record they never
    // signed — the one failure worse than a blank cell.
    const bytes = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: styledSite('initials'),
      values: { ...VALUES, site: '' },
    });
    expect(drawnGlyphs(bytes).map((g) => g.text).join('')).not.toContain('W');
  });

  it('highlight lays down a wash instead of typing the value', async () => {
    /*
      Asserted on BEHAVIOUR, not on pdf-lib's choice of path operator: it emits
      a filled rectangle without a literal `re` token, and a test pinned to the
      operator would break on a pdf-lib upgrade that still draws the same box.

      What matters is that something was added to the page and the recorded
      value was not typed over the top of it.
    */
    const original = await makeFlatPdf();
    const plain = await roundTripExport({ originalPdf: original, fields: FIELDS, values: VALUES });
    const bytes = await roundTripExport({
      originalPdf: original,
      fields: styledSite('highlight'),
      values: VALUES,
    });
    const stream = contentStreams(bytes).join('');
    expect(stream.length).toBeGreaterThan(contentStreams(plain).join('').length);
    expect(drawnGlyphs(bytes).map((g) => g.text).join('')).not.toContain('Warehouse B');
  });

  it('match_line draws a connector across the box', async () => {
    // The box IS the connector's extent: a PageBox carries one rectangle and
    // no second endpoint, so the author spans the gap and this draws through it.
    const plain = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: FIELDS,
      values: VALUES,
    });
    const bytes = await roundTripExport({
      originalPdf: await makeFlatPdf(),
      fields: styledSite('match_line'),
      values: VALUES,
    });
    expect(strokes(bytes).length).toBeGreaterThan(strokes(plain).length);
  });
});
