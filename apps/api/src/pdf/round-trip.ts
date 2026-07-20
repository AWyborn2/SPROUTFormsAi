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
import type { FormField, RepeatingRowValue, SubmissionValue } from '@formai/shared';

const INK = rgb(0.094, 0.106, 0.098); // #181b19

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

  for (const field of fields) {
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

/** Lay repeating rows down the field's box, one line per row. */
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

  rows.forEach((row, ri) => {
    // Rows fill top-to-bottom; y decreases as we descend the page.
    const y = pos.y + pos.height - rowHeight * (ri + 1);
    cols.forEach((col, ci) => {
      const raw = row[col.key];
      const text =
        typeof raw === 'boolean' ? (raw ? 'X' : '') : raw === null || raw === undefined ? '' : String(raw);
      if (!text) return;
      page.drawText(text, {
        x: pos.x + colWidth * ci + 3,
        y: y + 3,
        size,
        font,
        color: INK,
        maxWidth: Math.max(16, colWidth - 6),
      });
    });
  });
}
