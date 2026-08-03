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
  MARK_INSET,
  MARK_SIZE_CEIL,
  MARK_SIZE_FLOOR,
  columnBandFor,
  geometrySegments,
  isChoiceField,
  isFileRef,
  markPlacement,
  resolveAnswerSets,
  selectedOption,
  visibleFields,
} from '@formai/shared';
import type { FormField, PageBox, RepeatingRowValue, SubmissionValue } from '@formai/shared';

const INK = rgb(0.094, 0.106, 0.098); // #181b19

/**
 * Verdict colours for a marked answer.
 *
 * Dark enough to survive a photocopier and a fax, which is how these records
 * actually travel — a pale highlighter green reproduces as "no mark at all", and
 * an unmarked answer on a competency record reads as never-assessed.
 */
const CORRECT_INK = rgb(0.05, 0.42, 0.16);
const INCORRECT_INK = rgb(0.70, 0.10, 0.10);

/** How far a ring is drawn OUTSIDE the box it encircles, in points. */
const RING_PAD = 1.6;
/** A ring below this radius reads as a blob rather than a circle. */
const RING_MIN_RADIUS = 4;

/**
 * Field and column types whose `false` is a RECORDED answer rather than an empty
 * cell — read by both the repeating-column path and the scalar one.
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
  color = INK,
): void {
  const t = Math.max(0.8, size / 9);
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color });

  if (kind === 'tick') {
    // Down-stroke into the elbow, then the long up-stroke.
    line(x, y + size * 0.45, x + size * 0.35, y + size * 0.08);
    line(x + size * 0.35, y + size * 0.08, x + size * 0.95, y + size * 0.92);
    return;
  }
  line(x, y + size * 0.08, x + size * 0.9, y + size * 0.92);
  line(x, y + size * 0.92, x + size * 0.9, y + size * 0.08);
}

/**
 * Read a self-answering field's recorded verdict.
 *
 * `applyMarks` writes a real boolean into the field a question's `outcomeTarget`
 * names, but a hand-filled cell can arrive as the string a form control posted,
 * so both are accepted. Anything else — a number, a stray value — returns
 * undefined and is drawn as ordinary text rather than silently becoming a tick.
 */
function verdictOf(value: SubmissionValue | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}


/**
 * The PNG bytes of a `data:image/png;base64,...` value, or null.
 *
 * Null for anything else, INCLUDING a JPEG data URL. pdf-lib needs to be told
 * which decoder to use, and guessing wrong throws inside the export rather than
 * degrading — so this recognises only what SignaturePad actually emits
 * (`canvas.toDataURL('image/png')`) and everything else falls through to the
 * blank path.
 */
function pngDataUrlBytes(value: SubmissionValue | undefined): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64');
    // A truncated or empty payload decodes without throwing, so check the PNG
    // magic number rather than trusting the length.
    if (bytes.length < 8) return null;
    const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
    if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

/**
 * Fit a drawn signature inside its box, preserving aspect ratio and centring it.
 *
 * Signatures are drawn on a canvas of whatever size the pad happened to be, and
 * the box is whatever the reviewer placed. Stretching to fill would distort a
 * person's signature on the document that certifies them, which is the one
 * thing a signature must not be.
 */
function fitInside(
  box: { x: number; y: number; width: number; height: number },
  image: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  // 2pt inset so the ink never touches the printed cell border.
  const maxW = Math.max(1, box.width - 4);
  const maxH = Math.max(1, box.height - 4);
  const scale = Math.min(maxW / image.width, maxH / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * Make a string safe for the page font, which is WinAnsi.
 *
 * `StandardFonts.Helvetica` cannot encode anything outside WinAnsi, and pdf-lib
 * THROWS rather than substituting — so one curly apostrophe in an answer fails
 * the whole export. That is the worst available failure here: the evidence PDF
 * is the record of a completed assessment, and refusing to produce it because
 * of a punctuation mark is far worse than producing it with a straight quote.
 *
 * Values come out of a PDF and out of typed answers, so smart quotes, dashes
 * and arrows are ordinary rather than exotic. The common ones are transliterated
 * to their ASCII equivalent; anything else still outside the range becomes '?',
 * which is visibly wrong on the page rather than silently absent.
 */
const WINANSI_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[‐-―]/g, '-'],
  [/[→⇒]/g, '->'],
  [/←/g, '<-'],
  [/…/g, '...'],
  [/[   ]/g, ' '],
  [/[✓✔]/g, 'Y'],
  [/[✗✘✕]/g, 'N'],
];

export function winAnsiSafe(text: string): string {
  let out = text;
  for (const [pattern, replacement] of WINANSI_SUBSTITUTIONS) out = out.replace(pattern, replacement);
  // WinAnsi covers most of Latin-1 plus a scattering of higher code points.
  // Rather than encode that table, anything above it is replaced — the font
  // cannot draw it either way, and '?' says so.
  return out.replace(/[^ -ÿ]/g, '?');
}

/** Render a scalar value to the string drawn on the page. */
function scalarText(value: SubmissionValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'X' : '';
  // An attachment has no scalar rendering — the bytes live in storage, not on
  // the page. Draw the file's name so the exported evidence PDF records THAT a
  // file was supplied and which one, rather than "[object Object]" (which is
  // what `String(...)` below would otherwise stamp onto the form).
  if (isFileRef(value)) return value.fileName;
  if (Array.isArray(value)) {
    // string[] (checkbox group) — join; repeating rows are handled separately.
    if (value.every((v) => typeof v === 'string')) return (value as string[]).join(', ');
    return '';
  }
  /*
    A DATA URL IS NEVER TEXT.

    A drawn signature is `canvas.toDataURL('image/png')` — tens of kilobytes of
    base64. There is no image-embedding path in this module yet, so without this
    guard the value reaches `String(...)` below and is drawn as a caption:
    pdf-lib breaks lines only on ' ', and base64 contains none, so it emits ONE
    unbreakable line thousands of points wide straight across the record. It is
    fully WinAnsi-encodable, so nothing throws — the page is simply ruined.

    Deliberately type-agnostic rather than a `signature` branch. Extraction
    folds signature boxes into text inputs, so the same blob arrives under type
    `text`; and this renderer is shared with the submission export
    (routes/pdf.ts), which has its own ways of acquiring one.

    Blank is the correct failure. A competency record that is missing a mark is
    a visible gap someone fixes; one defaced by a wall of base64 is neither
    readable nor trustworthy. When image embedding lands, this becomes the
    branch that draws the image.
  */
  if (typeof value === 'string' && value.startsWith('data:')) return '';
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

    // A choice field — checkbox_group, radio ("multiple choice") or dropdown —
    // draws a CHECKMARK in each selected option's own box, not the option's
    // text. Each segment names its option via `optionKey`. The exception is a
    // field the reviewer set to print its selected value as TEXT
    // (`printSelectedValue`): that falls through to the scalar text path below,
    // which draws the value in its single box. A field with no per-option
    // geometry also falls through (a legacy single box, or none).
    if (isChoiceField(field.type) && !field.printSelectedValue) {
      const optionSegments = segments.filter((s) => s.optionKey !== undefined);
      if (optionSegments.length > 0) {
        drawCheckboxOptions(pages, value, optionSegments, field.answerKey);
        continue;
      }
    }

    // A scalar field occupies one box; if geometry ever gives it several, the
    // first is its anchor.
    const pos = segments[0]!;
    const page = pages[pos.page];
    if (!page) continue;

    /*
      A SELF-ANSWERING cell carries a verdict, not a value, and both of its
      states are recorded findings.

      This used to fall through to the text path below, which rendered the
      boolean through `scalarText`: `true` stamped the letter "X" and `false`
      stamped nothing. So a CORRECT answer was marked with a glyph an auditor
      reads as a cross — the precise opposite of what was recorded — and an
      INCORRECT one was left blank, which on a competency record is
      indistinguishable from a question nobody ever assessed.

      Absent stays blank, and only absent: never-marked is the one state that
      must not draw, because a glyph there asserts an assessment that never
      happened.
    */
    if (SELF_ANSWERING.has(field.type)) {
      const verdict = verdictOf(value);
      if (verdict === undefined) continue;
      const { x, y, size } = boxMarkPlacement(pos);
      drawMark(page, verdict ? 'tick' : 'cross', x, y, size);
      continue;
    }

    /*
      A DRAWN SIGNATURE IS AN IMAGE, and this is the only place in the export
      that draws one.

      It must come BEFORE the scalar text path, which refuses a data URL and
      draws nothing — that refusal exists because a signature reaching
      `String(value)` emits one unbreakable line of base64 straight across the
      record. With this branch the value is drawn as what it is; without it the
      guard still holds and the box stays blank.

      Keyed on the VALUE, not the field type, for the same reason the guard is:
      extraction folds signature boxes into text inputs, so the blob arrives
      typed `text` as often as `signature`.

      EVERY failure draws nothing. A malformed payload, an unsupported format, a
      decoder that throws — all fall through to blank, because a missing
      signature is a visible gap someone chases up, while a broken one is either
      a crashed export or a defaced page.
    */
    const png = pngDataUrlBytes(value);
    if (png) {
      try {
        const image = await doc.embedPng(png);
        page.drawImage(image, fitInside(pos, image));
      } catch {
        // Deliberately blank — see above.
      }
      continue;
    }

    const text = scalarText(value);
    if (!text) continue;

    const size = Math.min(11, Math.max(8, pos.height - 4));
    // Baseline a few points up from the field's bottom edge.
    page.drawText(winAnsiSafe(text), {
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

/** Where a centred mark sits inside a standalone option box, in PDF points. */
function boxMarkPlacement(box: PageBox): { x: number; y: number; size: number } {
  const size = Math.max(MARK_SIZE_FLOOR, Math.min(MARK_SIZE_CEIL, Math.min(box.width, box.height) - MARK_INSET));
  return {
    x: box.x + Math.max(0, (box.width - size) / 2),
    y: box.y + Math.max(0, (box.height - size) / 2),
    size,
  };
}

/**
 * Draw a checkmark in each SELECTED option's own recorded box.
 *
 * A checkbox group prints a row of `☐` boxes; the reviewer has drawn one
 * geometry segment per option (each carrying its `optionKey`), and every option
 * the submission selected is ticked in its own box. This is why a `Shift` field
 * answered `D` draws a ✓ in the D box rather than printing the letter "D" — the
 * mark is the answer, exactly as it is in a repeating table's option column.
 *
 * The value may be an array (multi-select) or a single string; both resolve to
 * the set of chosen option keys. An option with no matching selection is left
 * blank — an unticked box, which is a recorded "not this one", not a guess.
 */
/**
 * Ring the answer the candidate chose, in its verdict colour.
 *
 * A ring rather than a tick because of what these documents are FOR. The
 * printed form numbers its answers "a)" / "b)", an assessor marking it by hand
 * circles the letter, and the exported evidence has to be legible to an auditor
 * reading a photocopy beside hand-marked originals. A tick sitting next to a
 * letter says "something was marked here"; a ring around the letter says which
 * answer was given, in the same visual language as the paper it replaces.
 *
 * Drawn OUTSIDE the recorded box, not inside it. The box sits on the printed
 * letter, so an inset mark would strike through the very glyph the ring is meant
 * to identify.
 */
function drawRing(
  page: ReturnType<PDFDocument['getPages']>[number],
  box: PageBox,
  color: ReturnType<typeof rgb>,
): void {
  const xScale = Math.max(RING_MIN_RADIUS, box.width / 2 + RING_PAD);
  const yScale = Math.max(RING_MIN_RADIUS, box.height / 2 + RING_PAD);
  page.drawEllipse({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    xScale,
    yScale,
    borderColor: color,
    borderWidth: Math.max(0.9, Math.min(xScale, yScale) / 6),
  });
}

/**
 * Mark each selected option in its own recorded box.
 *
 * TWO PRESENTATIONS, decided by whether the field is auto-marked:
 *
 *  - An assessment question (it carries an `answerKey`) gets a RING around the
 *    answer it chose, green when that answer is in the key and red when it is
 *    not. The verdict belongs on the page because the exported PDF is the
 *    artefact an auditor reads — reconstructing right from wrong by
 *    cross-referencing a key held elsewhere is exactly the work this removes.
 *  - Any other checkbox group keeps the tick it has always drawn. A form with no
 *    key has no verdict to report, and inventing a colour would assert one.
 */
function drawCheckboxOptions(
  pages: import('pdf-lib').PDFPage[],
  value: SubmissionValue | undefined,
  segments: PageBox[],
  answerKey?: readonly string[],
): void {
  const selected = new Set(
    Array.isArray(value)
      ? (value as unknown[]).map(String)
      : value === null || value === undefined || value === ''
        ? []
        : [String(value)],
  );

  const marked = answerKey !== undefined && answerKey.length > 0;

  for (const seg of segments) {
    if (seg.optionKey === undefined || !selected.has(seg.optionKey)) continue;
    const page = pages[seg.page];
    if (!page) continue;

    if (marked) {
      drawRing(page, seg, answerKey.includes(seg.optionKey) ? CORRECT_INK : INCORRECT_INK);
      continue;
    }
    const { x, y, size } = boxMarkPlacement(seg);
    drawMark(page, 'tick', x, y, size);
  }
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
        page.drawText(winAnsiSafe(text), {
          x,
          y,
          size,
          font,
          color: INK,
          maxWidth: Math.max(4, band.end - band.start - 6),
        });
      };

      /**
       * Draw a vector tick in a column's own recorded band, or nowhere. A
       * checkbox — grouped answer-set member or independent — renders as a
       * checkmark, and the page font (Helvetica/WinAnsi) has no `✓`, so the
       * mark is drawn with `drawMark`, exactly as `check_cross` already does,
       * at the same `markPlacement` coordinates `mark` uses. Placement is
       * therefore identical to text marks — only the glyph differs.
       */
      const markTick = (columnKey: string) => {
        const band = columnBandFor(segment, columnKey);
        if (!band) return; // no band for this column — placing it would be a guess
        const { x, y, size } = markPlacement(rowBand, band);
        drawMark(page, 'tick', x, y, size);
      };

      // One mark per answer set — a malformed row (two truthy members) still
      // yields a single cell, because `selectedOption` picks the first. The
      // chosen member is a ticked checkbox, so it renders as a tick.
      for (const set of sets) {
        const { columnKey } = selectedOption(set, row);
        if (columnKey === null) continue; // unanswered — the whole set stays blank
        markTick(columnKey);
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
            // boolean_yes_no renders the literal answer the field represents:
            // Y for true, N for false. (Both are recorded answers; only
            // null/'' — filtered above — stays blank.)
            mark(col.key, raw ? 'Y' : 'N');
          }
          continue;
        }

        // Independent (non-self-answering) columns. A boolean is a checkbox:
        // true is a ticked box and renders as a checkmark via `drawMark` (the
        // page font has no `✓`), false leaves the cell blank. Anything else is
        // free text drawn as-is.
        if (typeof raw === 'boolean') {
          if (raw) markTick(col.key);
          continue;
        }
        const text = raw === null || raw === undefined ? '' : String(raw);
        if (!text) continue;
        mark(col.key, text);
      }
    }
  }
}
