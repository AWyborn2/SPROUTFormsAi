/**
 * Reading a client's colours off their own document.
 *
 * DETERMINISTIC PARSING, NOT A MODEL. Colours live in the PDF content stream as
 * explicit operators — `0.1 0.3 0.8 rg` sets a fill in RGB — so this is exact,
 * cheap, testable, and cannot be talked out of its answer. The same split the
 * website brand scan already makes between `extract.ts` (parsing) and the model
 * (nothing): the less of an attacker-authored document that reaches a model, the
 * smaller the surface, and a colour is precisely the kind of fact worth reading
 * rather than asking about.
 *
 * A PROPOSAL, NEVER A DECISION. What comes back is an ordered list of the
 * colours the document actually uses, for the author to pick from. It is NOT a
 * claim about which one is the brand: a document's most-set colour may be its
 * table borders rather than its letterhead, because this counts how often a
 * colour is SELECTED and not how much of the page it covers. Computing real ink
 * coverage would mean interpreting the whole content stream — every path, fill
 * rule and clipping region — for a value a person confirms in one glance
 * anyway.
 *
 * WHAT IT CANNOT SEE. Colours inside embedded images (a rasterised letterhead),
 * ICC and separation spaces beyond their tint fallback, and anything drawn by
 * an XObject this does not descend into. A document that yields nothing is a
 * normal outcome, reported as one — inventing a brand colour would be worse
 * than offering none.
 */
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

/** Pages read before stopping. A letterhead is on the first page or nowhere. */
const MAX_PAGES = 3;

/** Distinct colours returned. Past this it is a palette, not a proposal. */
const MAX_COLORS = 8;

/**
 * How near-grey a colour may be before it is dropped.
 *
 * Text is black, rules are grey, and a page is white. Those are the three most
 * frequent colours in nearly every document and none of them is a brand — a
 * proposal led by `#000000` would be technically correct and useless.
 */
const GREY_TOLERANCE = 0.06;

function isNearGrey(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min <= GREY_TOLERANCE;
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * CMYK → RGB by the naive conversion, which is what a viewer without a colour
 * profile does too. Exactness is not the goal: the author is picking a swatch,
 * and a value a few percent off the press colour is still recognisably theirs.
 */
function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

const NUM = '(-?\\d*\\.?\\d+)';
const WS = '\\s+';

/** `r g b rg` (fill) and `r g b RG` (stroke). */
const RGB_OP = new RegExp(`${NUM}${WS}${NUM}${WS}${NUM}${WS}(rg|RG)(?![A-Za-z])`, 'g');
/** `c m y k k` (fill) and `c m y k K` (stroke). */
const CMYK_OP = new RegExp(`${NUM}${WS}${NUM}${WS}${NUM}${WS}${NUM}${WS}(k|K)(?![A-Za-z])`, 'g');
/**
 * `c1 … cn sc|scn` — a colour in whatever space is current. Only the three- and
 * four-operand forms are read, as RGB and CMYK respectively: with one operand
 * the space is almost always greyscale or a separation tint, whose meaning
 * depends on a colour space dictionary this does not resolve. Guessing there
 * would produce confident nonsense.
 */
const SCN_OP = new RegExp(
  `${NUM}${WS}${NUM}${WS}${NUM}(?:${WS}${NUM})?${WS}(scn|sc|SCN|SC)(?![A-Za-z])`,
  'g',
);

/** Every colour set in one decoded content stream, in order, with duplicates. */
export function colorsInContentStream(content: string): string[] {
  const found: string[] = [];

  for (const m of content.matchAll(RGB_OP)) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isNearGrey(r, g, b)) found.push(toHex(r, g, b));
  }
  for (const m of content.matchAll(CMYK_OP)) {
    const [r, g, b] = cmykToRgb(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
    if (!isNearGrey(r, g, b)) found.push(toHex(r, g, b));
  }
  for (const m of content.matchAll(SCN_OP)) {
    const nums = [m[1], m[2], m[3], m[4]].filter((v) => v !== undefined).map(Number);
    const [r, g, b] =
      nums.length === 4
        ? cmykToRgb(nums[0]!, nums[1]!, nums[2]!, nums[3]!)
        : [nums[0]!, nums[1]!, nums[2]!];
    if (!isNearGrey(r, g, b)) found.push(toHex(r, g, b));
  }

  return found;
}

/**
 * Decoded content of one page, or `''` when it cannot be read.
 *
 * Never throws: a page with an encoding this cannot decode is one page with no
 * signal, not a failed scan. A client's document is a real-world file and some
 * of them will be strange.
 */
function pageContent(doc: PDFDocument, index: number): string {
  try {
    const page = doc.getPage(index);
    const contents = page.node.get(PDFName.of('Contents'));
    if (!contents) return '';
    // A page's content may be one stream or an array of them; the array form is
    // what most generators emit once a document has been edited.
    const refs = 'asArray' in (contents as object) ? (contents as never as { asArray(): unknown[] }).asArray() : [contents];
    const parts: string[] = [];
    for (const ref of refs) {
      const stream = doc.context.lookup(ref as never);
      if (stream instanceof PDFRawStream) {
        parts.push(Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'));
      }
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

export interface PdfBrandColors {
  /** Distinct colours, most-used first. Empty on a monochrome document. */
  colors: string[];
  notes: string[];
}

/**
 * The colours a client's document uses, most-used first.
 *
 * Ordered by how often each is set, with ties broken by first appearance so the
 * result is stable between runs on the same file — a list that reorders itself
 * is a list somebody picks differently from the second time.
 */
export async function readBrandColors(pdfBytes: Uint8Array): Promise<PdfBrandColors> {
  const notes: string[] = [];
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return { colors: [], notes: ['That file could not be read as a PDF.'] };
  }

  const pageCount = doc.getPageCount();
  const readPages = Math.min(pageCount, MAX_PAGES);
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;

  for (let i = 0; i < readPages; i += 1) {
    for (const hex of colorsInContentStream(pageContent(doc, i))) {
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
      if (!firstSeen.has(hex)) firstSeen.set(hex, order++);
    }
  }

  if (pageCount > readPages) {
    // Said out loud rather than silently capped: "we looked at three pages" is
    // a different statement from "this document has these colours".
    notes.push(`Read the first ${readPages} of ${pageCount} pages.`);
  }

  const colors = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || firstSeen.get(a[0])! - firstSeen.get(b[0])!)
    .slice(0, MAX_COLORS)
    .map(([hex]) => hex);

  if (colors.length === 0) {
    notes.push(
      'This document is black and white, or its colour is inside an image. Pick the client’s colours yourself.',
    );
  }

  return { colors, notes };
}
