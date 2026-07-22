/**
 * Band derivation — propose where a printed table's columns and rows sit on the
 * original PDF, from the page's text layer (U3, R5/R6/R15).
 *
 * The whole approach rests on one measured fact: every form in the compliance
 * library is born-digital, so each column header and row label is real text at
 * an exact coordinate. Nothing here infers geometry from pixels.
 *
 * It rests equally on a second fact, which is why nothing here matches
 * characters: the header encoding VARIES ACROSS DOCUMENTS. On the dozer the
 * tick is `U+F0FC`, a Private-Use glyph pdfjs cannot map to Unicode; on the
 * Small Loader no tick reaches the text layer at all; on the Grader neither the
 * tick nor the cross does. A rule keyed on "find the ✓" fails on a third of the
 * library. So anchors are located by GEOMETRY — short, narrow items clustered to
 * the right of a wide label header — and characters are only ever used to label
 * a band after the fact.
 *
 * Pure module: no pdfjs, no DOM. The caller adapts `getTextContent()` items into
 * `PositionedText`. That boundary is what makes this testable against measured
 * fixtures with no PDF in the loop.
 */
import { resolveGeometry } from '@formai/shared';
import type { GeometryBand, PageBox, RepeatingColumn } from '@formai/shared';

/**
 * One positioned text run, in PDF point space (origin bottom-left).
 *
 * `y` is the BASELINE, not the top edge — that is what pdfjs reports, and rows
 * are grouped by it.
 */
export interface PositionedText {
  text: string;
  x: number;
  y: number;
  width: number;
}

export interface TableProposal {
  /** A segment ready to hand to the geometry model — already validator-clean. */
  segment: PageBox;
  /** 0..1. Reduced for every anchor inferred rather than found. */
  confidence: number;
  anchorsLocated: number;
  anchorsInferred: number;
  /** Why confidence was reduced, for the reviewer. */
  notes: string[];
}

export interface ProposeInput {
  page: number;
  pageWidth: number;
  pageHeight: number;
  items: PositionedText[];
  columns: RepeatingColumn[];
}

/**
 * Baselines within this many points are one row.
 *
 * Measured, not guessed: on the dozer's page-7 header `N/A` sits at y=648.6
 * while the rest of the row sits at 647.7. A tolerance below ~1pt splits that
 * header and loses the anchor.
 */
const BASELINE_TOLERANCE = 1.5;

/** An option header is at most this fraction of the label header's width. */
const OPTION_WIDTH_RATIO = 0.25;

/** A row whose baseline gap is below this fraction of the row pitch is a wrap. */
const WRAP_PITCH_RATIO = 0.75;

/** A gap this many times the typical one splits the option cluster. */
const CLUSTER_GAP_FACTOR = 3;

/**
 * How far a row's first item may sit from the label column's left margin.
 *
 * Measured: label lines print at exactly x=37.5 while numbered section headings
 * print at 38.7, so the window has to be tight enough to tell them apart.
 */
const LABEL_MARGIN_TOLERANCE = 1;

interface Row {
  y: number;
  items: PositionedText[];
}

/** Group items into printed rows by baseline. */
function toRows(items: PositionedText[]): Row[] {
  const sorted = [...items].filter((i) => i.text.trim() !== '' || i.width > 0).sort((a, b) => b.y - a.y);
  const rows: Row[] = [];

  for (const item of sorted) {
    const row = rows.find((r) => Math.abs(r.y - item.y) <= BASELINE_TOLERANCE);
    if (row) {
      row.items.push(item);
      continue;
    }
    rows.push({ y: item.y, items: [item] });
  }

  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * Keep the rightmost cluster of option headers, discarding stray short items.
 *
 * Measured need: page 7's second header carries a `:` at x=228 — short, and to
 * the right of the label header's right edge — while the real options sit at
 * 502.6, 512.1 and 539.9. Taking the colon as an anchor gives four anchors for
 * three columns and shifts every band left. The colon is 274pt from the
 * cluster; the cluster's own gaps are 2.4pt and 17.5pt, so an outlier gap
 * separates them cleanly without needing to know what a colon is.
 */
function rightmostCluster(candidates: PositionedText[]): PositionedText[] {
  if (candidates.length < 3) return candidates;

  const gaps = candidates.slice(1).map((c, i) => c.x - candidates[i]!.x);
  const typical = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;

  let cutAfter = -1;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i]! > Math.max(typical * CLUSTER_GAP_FACTOR, 1)) cutAfter = i;
  }

  return cutAfter < 0 ? candidates : candidates.slice(cutAfter + 1);
}

interface HeaderRow {
  row: Row;
  labelHeader: PositionedText;
  anchors: PositionedText[];
}

/**
 * A header row is a wide label header plus a cluster of short items to its right.
 *
 * Two or more anchors are required. One anchor yields no pitch, so a
 * three-column table could not be derived from it without inventing two
 * boundaries — and a single short item to the right of a wide one is an
 * extremely common shape in ordinary prose, so accepting it would find headers
 * everywhere.
 */
function findHeaderRows(rows: Row[]): HeaderRow[] {
  const headers: HeaderRow[] = [];

  for (const row of rows) {
    const labelHeader = row.items.reduce((a, b) => (b.width > a.width ? b : a), row.items[0]!);
    if (!labelHeader || labelHeader.width <= 0) continue;

    const right = labelHeader.x + labelHeader.width;
    const candidates = row.items.filter(
      (i) => i !== labelHeader && i.x >= right && i.width <= labelHeader.width * OPTION_WIDTH_RATIO,
    );
    if (candidates.length < 2) continue;

    const anchors = rightmostCluster(candidates);
    if (anchors.length < 2) continue;

    headers.push({ row, labelHeader, anchors });
  }

  return headers;
}

/**
 * Reconcile located anchors against the option-column count.
 *
 * Returns anchor centres, one per option column, left to right. Fewer anchors
 * than columns is the normal case on several library documents, so the missing
 * ones are extended from the median pitch of those found rather than refused.
 */
function reconcile(
  anchors: PositionedText[],
  expected: number,
): { centres: number[]; located: number; inferred: number } | null {
  const centres = anchors.map((a) => a.x + a.width / 2).sort((a, b) => a - b);

  if (centres.length === expected) return { centres, located: centres.length, inferred: 0 };

  if (centres.length > expected) {
    // Merge the closest neighbours until the count matches — an over-segmented
    // header (one option printed as two runs) is likelier than a phantom column.
    const merged = [...centres];
    while (merged.length > expected) {
      let bestIdx = 0;
      let bestGap = Infinity;
      for (let i = 1; i < merged.length; i++) {
        const gap = merged[i]! - merged[i - 1]!;
        if (gap < bestGap) {
          bestGap = gap;
          bestIdx = i;
        }
      }
      merged.splice(bestIdx - 1, 2, (merged[bestIdx - 1]! + merged[bestIdx]!) / 2);
    }
    return { centres: merged, located: expected, inferred: 0 };
  }

  // Fewer anchors than columns: extend leftward on the median pitch. Leftward
  // because the label column bounds the left edge, so there is known room
  // there, whereas extending right would run off the page.
  const gaps = centres.slice(1).map((c, i) => c - centres[i]!);
  if (gaps.length === 0) return null;
  const pitch = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
  if (!(pitch > 0)) return null;

  const extended = [...centres];
  while (extended.length < expected) extended.unshift(extended[0]! - pitch);

  return { centres: extended, located: centres.length, inferred: expected - centres.length };
}

/**
 * Turn anchor centres into contiguous bands.
 *
 * Interior boundaries are midpoints. The OUTER edges extend by half the typical
 * inter-anchor pitch rather than reaching for the label column: anchoring the
 * first band at the label column's right edge gave the dozer's tick a 282pt
 * span across blank paper, so a mark anywhere in that emptiness would have
 * resolved as "ticked". `leftLimit` only clamps the result so the label column
 * can never be overlapped.
 */
function centresToBands(centres: number[], keys: string[], leftLimit: number): GeometryBand[] {
  const gaps = centres.slice(1).map((c, i) => c - centres[i]!);
  const pitch = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : 12;
  const margin = pitch / 2;

  return centres.map((centre, i) => ({
    key: keys[i]!,
    start: i === 0 ? Math.max(centre - margin, leftLimit) : (centres[i - 1]! + centre) / 2,
    end: i === centres.length - 1 ? centre + margin : (centre + centres[i + 1]!) / 2,
  }));
}

/**
 * Row bands from the label column's baselines.
 *
 * A label that wraps onto a second line is ONE row. Measured need: page 7's
 * `Isolates machine correctly...` wraps, leaving a 10.4pt gap against a ~16.8pt
 * row pitch, and counting it as two rows would offset every answer below it.
 */
function rowBands(rows: Row[], header: HeaderRow, labelLeft: number, floor: number): GeometryBand[] {
  const below = rows
    .filter((r) => r.y < header.row.y - BASELINE_TOLERANCE && r.y > floor)
    // The label column has ONE left margin. A numbered section heading printed
    // at x=38.7 against the label column's 37.5 is close enough to pass a loose
    // tolerance, and counting it as a row offsets every answer after it.
    .filter((r) => r.items.some((i) => Math.abs(i.x - labelLeft) <= LABEL_MARGIN_TOLERANCE))
    .sort((a, b) => b.y - a.y);
  if (below.length === 0) return [];

  const gaps = below.slice(1).map((r, i) => below[i]!.y - r.y);
  const pitch = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : 0;

  // Merge wrapped continuation lines into the row they belong to.
  const baselines: number[] = [];
  for (const row of below) {
    const prev = baselines[baselines.length - 1];
    if (prev !== undefined && pitch > 0 && prev - row.y < pitch * WRAP_PITCH_RATIO) continue;
    baselines.push(row.y);
  }

  const step = pitch > 0 ? pitch : 12;
  return baselines.map((y, i) => {
    const next = baselines[i + 1];
    const bottom = next !== undefined ? (y + next) / 2 : y - step / 2;
    const top = i === 0 ? header.row.y : (baselines[i - 1]! + y) / 2;
    return { key: `r${i}`, start: bottom, end: top };
  });
}

/**
 * Propose one segment per table header found on the page.
 *
 * Returns [] rather than a guess whenever the page does not carry enough signal
 * — no header, one anchor, no option columns. An empty grid a reviewer must
 * draw by hand is a visible, correctable state; a confidently wrong grid stamps
 * a competency mark in a cell nobody measured.
 */
export function proposeTableSegments(input: ProposeInput): TableProposal[] {
  const optionColumns = input.columns.slice(1);
  if (optionColumns.length === 0 || input.items.length === 0) return [];

  const rows = toRows(input.items);
  const headers = findHeaderRows(rows).sort((a, b) => b.row.y - a.row.y);
  const proposals: TableProposal[] = [];

  for (const [index, header] of headers.entries()) {
    const resolved = reconcile(header.anchors, optionColumns.length);
    if (!resolved) continue;

    // A table ends where the next one begins. Without this floor the first
    // table on a page claims every label line beneath it — 35 rows for a table
    // that prints 4, putting every later answer on the wrong row.
    const floor = headers[index + 1]?.row.y ?? -Infinity;

    const bands = rowBands(rows, header, header.labelHeader.x, floor);
    if (bands.length === 0) continue;

    const columnBands = centresToBands(
      resolved.centres,
      optionColumns.map((c) => c.key),
      header.labelHeader.x + header.labelHeader.width,
    );

    const left = header.labelHeader.x;
    const right = Math.min(columnBands[columnBands.length - 1]!.end, input.pageWidth);
    const bottom = Math.min(...bands.map((b) => b.start));
    const top = header.row.y;

    const notes: string[] = [];
    let confidence = 1;
    if (resolved.inferred > 0) {
      confidence -= 0.3 * resolved.inferred;
      notes.push(
        `${resolved.inferred} of ${optionColumns.length} column positions inferred from pitch — the header glyphs were not in the text layer.`,
      );
    }

    const segment: PageBox = {
      page: input.page,
      x: left,
      y: bottom,
      width: right - left,
      height: top - bottom,
      pageWidth: input.pageWidth,
      pageHeight: input.pageHeight,
      columnBands,
      rowBands: bands,
    };

    // R15: a proposal the shipped validator rejects is dropped silently
    // downstream, leaving the reviewer an empty grid with no stated reason. Check
    // it here, where the reason is still known, rather than shipping it blind.
    if (resolveGeometry({ geometry: { segments: [segment] } }).segments.length !== 1) continue;

    proposals.push({
      segment,
      confidence: Math.max(0, Math.round(confidence * 100) / 100),
      anchorsLocated: resolved.located,
      anchorsInferred: resolved.inferred,
      notes,
    });
  }

  return proposals;
}
