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
import {
  columnBandFor,
  geometrySegments,
  markPlacement,
  resolveAnswerSets,
  selectedOption,
  visibleFields,
} from '@formai/shared';
import type { FormField, PageBox, RepeatingRowValue, SubmissionValue } from '@formai/shared';

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
    // One resolver for both geometry sources: confirmed page-scoped bands
    // where they exist, the legacy single box otherwise. A field with neither
    // resolves to no segments and is skipped — it exports as data.
    const segments = geometrySegments(field, pages.length);
    if (segments.length === 0) continue;

    const value = values[field.id];

    if (field.type === 'repeating_group' && Array.isArray(value)) {
      drawRepeatingGroup(pages, font, field, value as RepeatingRowValue[], segments);
      continue;
    }

    // A scalar field occupies one box; if geometry ever gives it several, the
    // first is its anchor.
    const pos = segments[0]!;
    const page = pages[pos.page];
    if (!page) continue;

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
 * Draw repeating rows into their RECORDED cells.
 *
 * There is no arithmetic fallback, deliberately. This used to divide the
 * field's box into equal rows and columns, which is only faithful on a uniform
 * grid — and the compliance tables it exists for have a wide label column
 * beside narrow option columns, so equal division put marks in visibly wrong
 * cells while the export still reported success. A mark in the wrong cell of a
 * competency record is a false statement that an operator was assessed on
 * something nobody checked, so a cell that cannot be placed from real geometry
 * is not drawn at all. The field then exports as data: visibly incomplete,
 * which someone notices and can fix.
 *
 * Rows are distributed across segments in order, which is what lets one table
 * continue across a page break — each segment draws the rows its own bands
 * describe.
 */
function drawRepeatingGroup(
  pages: import('pdf-lib').PDFPage[],
  font: import('pdf-lib').PDFFont,
  field: FormField,
  rows: RepeatingRowValue[],
  segments: PageBox[],
): void {
  const cols = field.columns ?? [];
  if (cols.length === 0 || rows.length === 0) return;

  // Grouped columns are answered as a set: exactly one member carries the row's
  // mark. Resolution and the "which member won" rule live in @formai/shared so
  // the exported page agrees cell-for-cell with the fill view and validation.
  const { sets } = resolveAnswerSets(field);
  const groupedKeys = new Set(sets.flatMap((s) => s.columnKeys));

  let rowCursor = 0;
  for (const segment of segments) {
    const page = pages[segment.page];
    const bands = segment.rowBands ?? [];
    if (!page || bands.length === 0) continue;

    for (const rowBand of bands) {
      const row = rows[rowCursor];
      rowCursor += 1;
      if (!row) return; // fewer answered rows than the table prints

      /** Place text in a column's own recorded band, or nowhere. */
      const mark = (columnKey: string, text: string) => {
        const band = columnBandFor(segment, columnKey);
        if (!band) return; // no band for this column — placing it would be a guess
        // Placement is the shared `markPlacement` (@formai/shared) so the
        // exported mark lands exactly where the review preview draws it.
        const { x, y, size } = markPlacement(rowBand, band);
        page.drawText(text, {
          x,
          y,
          size,
          font,
          color: INK,
          maxWidth: Math.max(4, band.end - band.start - 6),
        });
      };

      // One mark per answer set — a malformed row (two truthy members) still
      // yields a single cell, because `selectedOption` picks the first.
      for (const set of sets) {
        const { columnKey } = selectedOption(set, row);
        if (columnKey === null) continue; // unanswered — the whole set stays blank
        mark(columnKey, 'X');
      }

      for (const col of cols) {
        if (groupedKeys.has(col.key)) continue; // already handled by its answer set
        const raw = row[col.key];

        if (SELF_ANSWERING.has(col.type)) {
          // Only a real boolean is an answer here; null/'' is untouched and must
          // stay blank. `false` is a recorded fail and MUST leave a mark.
          if (typeof raw !== 'boolean') continue;
          if (col.type === 'check_cross') {
            const band = columnBandFor(segment, col.key);
            if (band) {
              const { x, y, size } = markPlacement(rowBand, band);
              drawMark(page, raw ? 'tick' : 'cross', x, y, size);
            }
          } else {
            // boolean_yes_no keeps its existing 'X' for true; 'N' is the fix for
            // a false that used to export as an empty cell.
            mark(col.key, raw ? 'X' : 'N');
          }
          continue;
        }

        const text =
          typeof raw === 'boolean' ? (raw ? 'X' : '') : raw === null || raw === undefined ? '' : String(raw);
        if (!text) continue;
        mark(col.key, text);
      }
    }
  }
}
