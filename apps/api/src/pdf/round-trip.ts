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
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import {
  MARK_INSET,
  MARK_SIZE_CEIL,
  MARK_SIZE_FLOOR,
  columnBandFor,
  geometrySegments,
  isChoiceField,
  isFileRef,
  isMatchingQuestion,
  isSelfAnswering,
  markPlacement,
  matchAnchorsFor,
  matchSides,
  resolveAnswerSets,
  selectedOption,
  visibleFields,
} from '@formai/shared';
import type {
  FormField,
  GlyphKind,
  PageBox,
  RepeatingRowValue,
  SubmissionValue,
} from '@formai/shared';

/**
 * What the exporter can actually draw.
 *
 * Deliberately SMALLER than `GlyphKind`. The builder lets an author choose from
 * twelve styles because the design prototype offered twelve; this names the
 * five the export really produces, and everything else resolves to the field
 * type's own default rather than being silently dropped. A mark that never
 * prints is indistinguishable, on a competency record, from an assessment
 * nobody made — so the honest failure is to draw the default, and the
 * inspector says which styles reach the page.
 */
export type DrawnGlyph =
  | 'tick'
  | 'cross'
  | 'ring'
  | 'text'
  | 'signature'
  /** A fixed word — PASS, N/A — rather than the recorded value. */
  | 'stamp'
  /** The recorded value reduced to its initials. */
  | 'initials'
  /** A translucent wash over the box, leaving the printed text readable. */
  | 'highlight'
  /** A connector drawn ACROSS the box, for a matching question. */
  | 'match_line';

/**
 * Authored glyph → what the exporter draws for it.
 *
 * `tick_hand` and `tick_block` both resolve to the one vector tick this file
 * draws: the export honours the CATEGORY, not the stylistic variant, and
 * pretending otherwise would put a difference on screen that never reaches the
 * paper. `stamp_date` is text because a date stamp is a date, drawn through the
 * same scalar path.
 *
 * EVERY GLYPH NOW DRAWS. There is no longer an authorable-but-ignored tier:
 * `MARK_STYLES_DRAWN` in `builder.ts` lists all of them, and the test that
 * walks it is what keeps this table and that list from drifting. A style the
 * exporter silently ignored was a mark an author believed was on a competency
 * record and was not.
 */
const DRAWN_BY_GLYPH: Record<GlyphKind, DrawnGlyph> = {
  tick_hand: 'tick',
  tick_block: 'tick',
  cross_hand: 'cross',
  ring: 'ring',
  typed: 'text',
  stamp_date: 'text',
  signature: 'signature',
  stamp_pass: 'stamp',
  stamp_na: 'stamp',
  initials: 'initials',
  highlight: 'highlight',
  match_line: 'match_line',
};

/** The word a stamp glyph prints. Fixed text, not the recorded value. */
const STAMP_WORD: Partial<Record<GlyphKind, string>> = {
  stamp_pass: 'PASS',
  stamp_na: 'N/A',
};

/**
 * Which glyph a segment draws — the authored one, or the caller's default.
 *
 * ABSENT IS THE DEFAULT AND THE DEFAULT IS TODAY'S BEHAVIOUR. Every placement
 * authored before mark styles existed carries no `markStyle`, and this returns
 * the fallback unchanged for all of them, so their exports are byte-identical.
 * That property is what makes this seam safe to add to a file that draws
 * competency records, and it is pinned by a characterization test rather than
 * asserted here.
 *
 * A glyph this exporter does not draw ALSO returns the fallback. The author is
 * told in the inspector; the page gets the field's own mark rather than
 * nothing, because a blank cell on this document class reads as unassessed.
 */
export function resolveMarkStyle(segment: PageBox | undefined, fallback: DrawnGlyph): DrawnGlyph {
  const glyph = segment?.markStyle?.glyph;
  if (!glyph) return fallback;
  return DRAWN_BY_GLYPH[glyph] ?? fallback;
}

/**
 * A person's initials from whatever their name was recorded as.
 *
 * First letter of each word, capped — an assessor signing "Ash Wyborn" initials
 * "AW". Capped at four because past that it is not an initialling, and a long
 * value would run out of the cell it is drawn in.
 *
 * A value that yields nothing draws NOTHING rather than a placeholder: an
 * invented mark on a competency record is the failure this whole file is
 * arranged against.
 */
export function initialsOf(value: string): string {
  return value
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

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
/**
 * Highlighter amber. Survives a photocopier as a visible tint rather than
 * vanishing, which is the whole point of marking something for attention on a
 * record that travels by fax.
 */
const HIGHLIGHT_INK = rgb(0.98, 0.80, 0.20);

/** How far a ring is drawn OUTSIDE the box it encircles, in points. */
const RING_PAD = 1.6;
/** A ring below this radius reads as a blob rather than a circle. */
const RING_MIN_RADIUS = 4;

/*
  WHICH TYPES SELF-ANSWER is `isSelfAnswering` in `@formai/shared`, read here by
  both the repeating-column path and the scalar one. The list used to be written
  out in this file and again in the web app, and the builder's outcome-box
  picker was about to write it a third time — a picker offering a target THIS
  file would not draw in is a mark an author believes is on a competency record
  and is not.
*/

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
  /**
   * The paper document's revision identity, drawn once as a small line at the
   * very bottom edge of page 1 — below any printed content, where auditors
   * expect a document-control mark. Absent on plain forms and on versions
   * that predate revisions, which export exactly as before.
   */
  revisionIdentity?: { code?: string; reviewedOn?: string; note?: string } | null;
}

/**
 * The identity line's text — "Rev 3 (reviewed 08/2026) — Annual review", or
 * whichever of the three parts exist. Empty when none do, so the caller can
 * skip drawing entirely.
 */
export function revisionIdentityLine(identity: {
  code?: string;
  reviewedOn?: string;
  note?: string;
}): string {
  const head = [identity.code, identity.reviewedOn ? `(reviewed ${identity.reviewedOn})` : '']
    .filter(Boolean)
    .join(' ');
  return [head, identity.note].filter(Boolean).join(' — ');
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
  revisionIdentity,
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
      await drawRepeatingGroup(doc, pages, font, field, value as RepeatingRowValue[], segments);
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

      /*
        A MATCHING QUESTION IS DRAWN AS LINES, NOT AS MARKS IN BOXES, and it has
        to be checked BEFORE the per-option path — its geometry also carries
        `optionKey`s, so `drawCheckboxOptions` would happily ring the anchors
        and produce a page full of circles round individual statements instead
        of the connectors a person draws with a pen.

        The anchors name the printed ENTRIES (`l0`, `r2`), so a three-by-three
        question needs six of them rather than nine boxes — and each of those
        nine described a correspondence the page never printed anywhere.
      */
      if (isMatchingQuestion(field.options)) {
        /*
          A MATCHING ANSWER IS NEVER SCALAR TEXT, so this continues either way.

          Its value is a SET of pairings, and `scalarText` joins them — falling
          through would draw roughly 230 characters into whatever single box the
          field happens to carry. `drawText` bounds the width but NOT the
          height, so the wrapped remainder runs downward across whatever is
          printed beneath it, on a certified competency record, with nothing
          raised.
        */
        if (optionSegments.length > 0) drawMatchConnectors(pages, field, value, optionSegments);
        continue;
      }

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
    if (isSelfAnswering(field.type)) {
      /*
        TWO PRINTED CELLS, ONE VERDICT. Plenty of papers print a boolean as a
        "No ☐  Yes ☐" pair rather than one box, and a mark's meaning there is
        WHICH CELL it sits in — so a placed pair (optionKey `yes`/`no`) draws a
        tick in the answered cell and leaves its partner blank. A cross in the
        "No" cell would read as "not no". Unanswered still draws nothing
        anywhere, and a field carrying no pair keeps the single-box behaviour
        below unchanged.
      */
      const pair = segments.filter((s) => s.optionKey === 'yes' || s.optionKey === 'no');
      if (pair.length > 0) {
        const pairVerdict = verdictOf(value);
        if (pairVerdict === undefined) continue;
        const cell = pair.find((s) => s.optionKey === (pairVerdict ? 'yes' : 'no'));
        const cellPage = cell ? pages[cell.page] : undefined;
        // The answered cell may be the one box the author has not placed yet —
        // then nothing draws, which is visibly incomplete rather than a mark
        // in the wrong cell.
        if (cell && cellPage) {
          const glyph = resolveMarkStyle(cell, 'tick');
          if (glyph === 'ring') {
            drawRing(cellPage, cell, INK);
          } else if (glyph === 'highlight') {
            drawHighlight(cellPage, cell);
          } else {
            const { x, y, size } = boxMarkPlacement(cell);
            drawMark(cellPage, glyph === 'cross' ? 'cross' : 'tick', x, y, size);
          }
        }
        continue;
      }

      const verdict = verdictOf(value);
      if (verdict === undefined) continue;
      /*
        The VERDICT decides the default; an authored style may override which
        glyph carries it. A ring is the one alternative that says the same
        thing — "this is the cell I mean" — without asserting a different
        finding, so tick/cross/ring are honoured here and anything else falls
        back to the verdict's own mark. Drawing a date stamp or a signature in
        a pass/fail cell would state something the assessment never recorded.
      */
      const fallback: DrawnGlyph = verdict ? 'tick' : 'cross';
      const glyph = resolveMarkStyle(pos, fallback);
      const verdictInk = verdict ? CORRECT_INK : INCORRECT_INK;

      if (glyph === 'ring') {
        drawRing(page, pos, verdictInk);
        continue;
      }
      if (glyph === 'highlight') {
        drawHighlight(page, pos);
        continue;
      }
      if (glyph === 'match_line') {
        drawMatchLine(page, pos, verdictInk);
        continue;
      }
      /*
        A STAMP IN A VERDICT CELL MUST NOT CONTRADICT THE VERDICT. "PASS" over a
        recorded failure is not a style choice, it is a false record — so the
        word is drawn only where it agrees with what was recorded, and the
        verdict's own mark is drawn where it does not. `N/A` is exempt: it
        asserts no finding either way.
      */
      const stampWord = STAMP_WORD[pos?.markStyle?.glyph ?? 'typed'];
      if (glyph === 'stamp' && stampWord) {
        const contradicts = stampWord === 'PASS' && !verdict;
        if (!contradicts) {
          drawStampText(page, pos, stampWord, font, verdictInk);
          continue;
        }
      }
      const { x, y, size } = boxMarkPlacement(pos);
      drawMark(page, glyph === 'cross' ? 'cross' : glyph === 'tick' ? 'tick' : fallback, x, y, size);
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

    /*
      The authored glyph can change WHAT a scalar box prints, not whether it
      prints. `typed` and `stamp_date` are the recorded value; a stamp is a
      fixed word; `initials` reduces the value to letters. Anything shaped like
      a mark rather than text — a tick, a ring, a highlight, a connector — is
      drawn here too, because a scalar box is a legitimate place to want one.
    */
    const scalarGlyph = pos.markStyle?.glyph;
    const drawn = resolveMarkStyle(pos, 'text');

    if (drawn === 'highlight') {
      drawHighlight(page, pos);
      continue;
    }
    if (drawn === 'match_line') {
      drawMatchLine(page, pos, INK);
      continue;
    }
    if (drawn === 'ring') {
      drawRing(page, pos, INK);
      continue;
    }
    if (drawn === 'tick' || drawn === 'cross') {
      const mark = boxMarkPlacement(pos);
      drawMark(page, drawn, mark.x, mark.y, mark.size);
      continue;
    }

    const stamp = scalarGlyph ? STAMP_WORD[scalarGlyph] : undefined;
    if (drawn === 'stamp' && stamp) {
      drawStampText(page, pos, stamp, font, INK);
      continue;
    }

    const recorded = scalarText(value);
    /*
      Initials still need something recorded to initial. A box whose value is
      empty draws NOTHING — inventing initials would put a person's mark on a
      record they never signed.
    */
    const text = drawn === 'initials' ? initialsOf(recorded) : recorded;
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

  /*
    The revision identity, at the very bottom edge of page 1. 6pt at y=3 sits
    below any printed margin, so it cannot overlap a mapped box; the width is
    truncated to the page rather than wrapped, because a wrapped footer would
    climb into content on a certified record.
  */
  const identityText = revisionIdentity ? revisionIdentityLine(revisionIdentity) : '';
  if (identityText && pages[0]) {
    const page = pages[0];
    const size = 6;
    const maxWidth = page.getWidth() - 12;
    let text = winAnsiSafe(identityText);
    while (text.length > 1 && font.widthOfTextAtSize(text, size) > maxWidth) {
      text = `${text.slice(0, -4)}...`;
    }
    page.drawText(text, { x: 6, y: 3, size, font, color: INK });
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
/**
 * A translucent wash over the box.
 *
 * Drawn with opacity rather than as a solid fill so the PRINTED TEXT UNDERNEATH
 * STAYS READABLE — a highlight that hides the question it marks has destroyed
 * the evidence it was meant to draw attention to. Amber rather than the verdict
 * inks: a highlight says "look here", not "this is correct".
 */
function drawHighlight(
  page: ReturnType<PDFDocument['getPages']>[number],
  box: PageBox,
): void {
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    color: HIGHLIGHT_INK,
    opacity: 0.35,
  });
}

/**
 * A connector drawn across one box.
 *
 * THE BOX IS THE CONNECTOR'S EXTENT here, and that is the fallback rather than
 * the model. It is what an author gets when they choose the `match_line` glyph
 * for an ordinary box: a line through it, left edge to right edge at the
 * vertical centre. Every placement authored before matching anchors existed
 * draws exactly this, unchanged.
 *
 * A real matching question does NOT come through here — `drawMatchConnectors`
 * runs between two anchors and knows both endpoints. This one cannot: a single
 * `PageBox` has one rectangle and no far end.
 *
 * The end dots are what make it read as a drawn connector rather than a rule or
 * a strikethrough — the same two marks a person makes with a pen.
 */
function drawMatchLine(
  page: ReturnType<PDFDocument['getPages']>[number],
  box: PageBox,
  color: ReturnType<typeof rgb>,
): void {
  const midY = box.y + box.height / 2;
  const thickness = Math.max(0.9, Math.min(1.8, box.height / 8));
  page.drawLine({
    start: { x: box.x, y: midY },
    end: { x: box.x + box.width, y: midY },
    thickness,
    color,
  });
  const dot = Math.max(1.2, thickness * 1.4);
  for (const x of [box.x, box.x + box.width]) {
    page.drawEllipse({ x, y: midY, xScale: dot, yScale: dot, color });
  }
}

/** The point on an anchor a connector attaches to — its facing edge, mid-height. */
function anchorPoint(box: PageBox, facing: 'right' | 'left'): { x: number; y: number } {
  return {
    x: facing === 'right' ? box.x + box.width : box.x,
    y: box.y + box.height / 2,
  };
}

/**
 * Draw one line per pairing the candidate chose, between the two printed things
 * it names.
 *
 * THIS IS WHAT A MATCHING ANSWER LOOKS LIKE ON PAPER. A person doing this
 * question with a pen draws a line from the statement to the sign; the evidence
 * export has to show the same thing, or the exported page and the filled page
 * are different documents.
 *
 * ANCHORS, NOT PAIRINGS. The geometry names the printed ENTRIES — `l0`, `r2` —
 * so a three-by-three question needs six anchors rather than nine boxes, and a
 * five-by-five needs ten rather than twenty-five. That is not only less work:
 * eight of those nine boxes described a correspondence the page never printed
 * anywhere, so there was nothing on the paper to place them against.
 *
 * EVERY CHOSEN PAIRING IS DRAWN, RIGHT OR WRONG. Green for a pairing in the
 * key, red for one that is not, and plain ink where the question carries no key
 * at all. Drawing only the correct ones would leave a candidate who paired
 * badly with a blank matching question on their record — indistinguishable from
 * one nobody assessed, which is the failure this whole file is arranged
 * against.
 *
 * A pairing whose anchors are not both placed draws NOTHING. It is the same
 * refusal `drawRepeatingGroup` makes for a cell it cannot place from real
 * geometry: an invented endpoint is a line across a competency record asserting
 * a correspondence nobody can check.
 */
function drawMatchConnectors(
  pages: import('pdf-lib').PDFPage[],
  field: FormField,
  value: SubmissionValue | undefined,
  segments: PageBox[],
): void {
  const chosen = Array.isArray(value) ? (value as unknown[]).map(String) : [];
  if (chosen.length === 0) return;

  const byKey = new Map(segments.filter((s) => s.optionKey !== undefined).map((s) => [s.optionKey!, s]));
  const sides = matchSides(field.options ?? []);
  const key = field.answerKey;
  const marked = key !== undefined && key.length > 0;

  for (const option of chosen) {
    const anchors = matchAnchorsFor(option, sides);
    if (!anchors) continue;
    const from = byKey.get(anchors.left);
    const to = byKey.get(anchors.right);
    // Both ends, on one page. A connector spanning a page break has no
    // meaningful line to draw, and a matching question printed across two
    // sheets is not a shape this document class uses.
    if (!from || !to || from.page !== to.page) continue;
    const page = pages[from.page];
    if (!page) continue;

    const color = marked ? (key.includes(option) ? CORRECT_INK : INCORRECT_INK) : INK;
    /*
      Which edges face each other is read off the geometry, not assumed. The
      prompt column is usually left of the answer column — but a paper that
      prints the signs first is the same question, and attaching to the wrong
      edges would run each line back through the text it starts from.
    */
    const leftIsFirst = from.x + from.width / 2 <= to.x + to.width / 2;
    const start = anchorPoint(from, leftIsFirst ? 'right' : 'left');
    const end = anchorPoint(to, leftIsFirst ? 'left' : 'right');

    const thickness = Math.max(0.9, Math.min(1.8, Math.min(from.height, to.height) / 8));
    page.drawLine({ start, end, thickness, color });
    const dot = Math.max(1.2, thickness * 1.4);
    for (const point of [start, end]) {
      page.drawEllipse({ x: point.x, y: point.y, xScale: dot, yScale: dot, color });
    }
  }
}

/**
 * A fixed word, centred in the box and shrunk to fit it.
 *
 * Sized off the box rather than at a constant, because these land in printed
 * cells that range from a margin tick-box to a full-width comment row, and a
 * stamp that overruns its cell obscures the printed text beside it.
 */
function drawStampText(
  page: ReturnType<PDFDocument['getPages']>[number],
  box: PageBox,
  word: string,
  font: PDFFont,
  color: ReturnType<typeof rgb>,
): void {
  let size = Math.min(11, Math.max(6, box.height - 3));
  // Shrink until it fits the width, with a floor: below 5pt it is unreadable
  // and a mark nobody can read is not a record.
  while (size > 5 && font.widthOfTextAtSize(word, size) > box.width - 2) size -= 0.5;
  const width = font.widthOfTextAtSize(word, size);
  page.drawText(winAnsiSafe(word), {
    x: box.x + Math.max(1, (box.width - width) / 2),
    y: box.y + Math.max(1, (box.height - size) / 2 + size * 0.12),
    size,
    font,
    color,
  });
}

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
async function drawRepeatingGroup(
  doc: import('pdf-lib').PDFDocument,
  pages: import('pdf-lib').PDFPage[],
  font: import('pdf-lib').PDFFont,
  field: FormField,
  rows: RepeatingRowValue[],
  segments: PageBox[],
): Promise<void> {
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
      /*
        WHICH VALUE ROW THIS BAND MARKS. A `row:<n>` key names printed row n
        EXPLICITLY — the per-row placement fallback stores one small segment
        per row an author drew by hand, and the rows they have not placed must
        not shift every later mark up the table. Any other key keeps the
        positional contract every measured grid already relies on: bands
        consume rows in printed order.
      */
      const explicit = /^row:(\d+)$/.exec(rowBand.key);
      const row = explicit ? rows[Number(explicit[1])] : rows[rowCursor];
      if (!explicit) {
        rowCursor += 1;
        if (!row) return; // fewer answered rows than the table prints
      }
      if (!row) continue; // an explicitly-named row the value does not reach

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

        if (isSelfAnswering(col.type)) {
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
        // A drawn signature arrives as a PNG data URL — draw the IMAGE into the
        // cell, never the data-URL string. Type-agnostic like the scalar path:
        // extraction folds signature boxes into text columns, so the blob turns
        // up typed `text` as often as `signature`.
        const png = pngDataUrlBytes(raw);
        if (png) {
          const band = columnBandFor(segment, col.key);
          if (band) {
            const image = await doc.embedPng(png);
            page.drawImage(
              image,
              fitInside(
                {
                  x: band.start,
                  y: rowBand.start,
                  width: band.end - band.start,
                  height: rowBand.end - rowBand.start,
                },
                image,
              ),
            );
          }
          continue;
        }
        const text = raw === null || raw === undefined ? '' : String(raw);
        if (!text) continue;
        mark(col.key, text);
      }
    }
  }
}
