/**
 * Round-trip export — overlay submitted values back onto the ORIGINAL PDF at
 * the stored point coordinates. We never regenerate the document: the original
 * bytes (letterhead, fonts, layout) are loaded and we only draw on top. This is
 * the fidelity claim the product depends on.
 *
 * Stored `SourcePosition` is in PDF point space (origin bottom-left, 72
 * units/inch) — the same space pdf-lib's `drawText` uses — so values land
 * exactly where the source field was, at any DPI the original was authored in.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { resolveAnswerSets, selectedOption, visibleFields } from '@formai/shared';
import type { FormField, RepeatingRowValue, SubmissionValue } from '@formai/shared';

const INK = rgb(0.094, 0.106, 0.098); // #181b19

/**
 * Column types whose `false` is a RECORDED answer rather than an empty cell.
 *
 * A plain `checkbox` that is false is simply unticked, and drawing anything
 * would invent an answer. A `check_cross` that is false is an assessor saying
 * "I checked this and it failed" — exporting that as blank made it identical
 * to never-assessed on the one artefact an investigation actually reads.
 */
const SELF_ANSWERING = new Set(['check_cross', 'boolean_yes_no']);

/**
 * Draw a tick or a cross as vector strokes.
 *
 * Not text: the page font is `StandardFonts.Helvetica`, which is WinAnsi, and
 * neither U+2713 nor U+2717 exists in that encoding — pdf-lib cannot draw them
 * at all. (PR #15's spike hit the same wall from the other side: the source
 * PDFs' own ticks are Private-Use glyphs.) Two line segments each need no font,
 * no embedded asset, and scale to whatever the cell is.
 */
function drawMark(
  page: ReturnType<PDFDocument['getPages']>[number],
  kind: 'tick' | 'cross',
  x: number,
  y: number,
  size: number,
): void {
  const t = Math.max(0.8, size / 9);
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: INK });

  if (kind === 'tick') {
    // Down-stroke into the elbow, then the long up-stroke.
    line(x, y + size * 0.45, x + size * 0.35, y + size * 0.08);
    line(x + size * 0.35, y + size * 0.08, x + size * 0.95, y + size * 0.92);
    return;
  }
  line(x, y + size * 0.08, x + size * 0.9, y + size * 0.92);
  line(x, y + size * 0.92, x + size * 0.9, y + size * 0.08);
}

/** Render a scalar value to the string drawn on the page. */
function scalarText(value: SubmissionValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'X' : '';
  if (Array.isArray(value)) {
    // string[] (checkbox group) — join; repeating rows are handled separately.
    if (value.every((v) => typeof v === 'string')) return (value as string[]).join(', ');
    return '';
  }
  return String(value);
}

export interface RoundTripInput {
  originalPdf: Uint8Array;
  fields: FormField[];
  values: Record<string, SubmissionValue>;
}

/**
 * Overlay `values` onto `originalPdf` using each field's `sourcePosition`.
 * Fields without a source position (built-from-scratch) are skipped — only
 * imported fields have a place on the original page. Returns the saved bytes.
 */
export async function roundTripExport({
  originalPdf,
  fields,
  values,
}: RoundTripInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(originalPdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  // Conditional visibility is applied HERE rather than left to the caller
  // (U11). An exported PDF is read in incident investigations as evidence of
  // what was recorded — a question the filler never saw must not appear on it
  // carrying a stale answer from before its source question changed. Putting
  // the filter inside the exporter means no future caller can forget it.
  for (const field of visibleFields(fields, values)) {
    const pos = field.sourcePosition;
    if (!pos) continue;
    const page = pages[pos.page];
    if (!page) continue;

    const value = values[field.id];

    if (field.type === 'repeating_group' && Array.isArray(value)) {
      drawRepeatingGroup(page, font, field, value as RepeatingRowValue[], pos);
      continue;
    }

    const text = scalarText(value);
    if (!text) continue;

    const size = Math.min(11, Math.max(8, pos.height - 4));
    // Baseline a few points up from the field's bottom edge.
    page.drawText(text, {
      x: pos.x + 3,
      y: pos.y + Math.max(3, (pos.height - size) / 2),
      size,
      font,
      color: INK,
      maxWidth: Math.max(20, pos.width - 6),
    });
  }

  return doc.save();
}

/**
 * Lay repeating rows down the field's box, one line per row.
 *
 * NOT dead code, despite being unreachable today: `roundTripExport` skips any
 * field without a `sourcePosition`, and only the AcroForm extraction path sets
 * one — and that path never produces `columns`. So no repeating table in the
 * product currently carries geometry, and this function is exercised by tests
 * with an injected `sourcePosition`. It is written ahead of geometry capture so
 * that adding capture later is a change to extraction alone, not to export.
 */
function drawRepeatingGroup(
  page: import('pdf-lib').PDFPage,
  font: import('pdf-lib').PDFFont,
  field: FormField,
  rows: RepeatingRowValue[],
  pos: NonNullable<FormField['sourcePosition']>,
): void {
  const cols = field.columns ?? [];
  if (cols.length === 0 || rows.length === 0) return;
  const rowHeight = Math.max(12, pos.height / (rows.length + 1));
  const colWidth = pos.width / cols.length;
  const size = Math.min(9, rowHeight - 3);

  // Grouped columns are answered as a set: exactly one member carries the row's
  // mark. Resolution and the "which member won" rule live in @formai/shared so
  // the exported page agrees cell-for-cell with the fill view and validation.
  const { sets } = resolveAnswerSets(field);
  const groupedKeys = new Set(sets.flatMap((s) => s.columnKeys));
  const colIndex = new Map(cols.map((c, i) => [c.key, i]));

  rows.forEach((row, ri) => {
    // Rows fill top-to-bottom; y decreases as we descend the page.
    const y = pos.y + pos.height - rowHeight * (ri + 1);
    const mark = (ci: number, text: string) => {
      page.drawText(text, {
        x: pos.x + colWidth * ci + 3,
        y: y + 3,
        size,
        font,
        color: INK,
        maxWidth: Math.max(16, colWidth - 6),
      });
    };

    // One mark per answer set — a malformed row (two truthy members) still
    // yields a single cell, because `selectedOption` picks the first.
    for (const set of sets) {
      const { columnKey } = selectedOption(set, row);
      if (columnKey === null) continue; // unanswered — the whole set stays blank
      const ci = colIndex.get(columnKey);
      if (ci !== undefined) mark(ci, 'X');
    }

    cols.forEach((col, ci) => {
      if (groupedKeys.has(col.key)) return; // already handled by its answer set
      const raw = row[col.key];

      if (SELF_ANSWERING.has(col.type)) {
        // Only a real boolean is an answer here; null/'' is untouched and must
        // stay blank. `false` is a recorded fail and MUST leave a mark.
        if (typeof raw !== 'boolean') return;
        if (col.type === 'check_cross') {
          drawMark(page, raw ? 'tick' : 'cross', pos.x + colWidth * ci + 3, y + 3, size);
        } else {
          // boolean_yes_no keeps its existing 'X' for true; 'N' is the fix for
          // a false that used to export as an empty cell.
          mark(ci, raw ? 'X' : 'N');
        }
        return;
      }

      const text =
        typeof raw === 'boolean' ? (raw ? 'X' : '') : raw === null || raw === undefined ? '' : String(raw);
      if (!text) return;
      mark(ci, text);
    });
  });
}
