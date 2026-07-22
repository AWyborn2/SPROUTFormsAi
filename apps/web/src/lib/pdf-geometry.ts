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

/**
 * One page's text plus its own dimensions.
 *
 * The size travels WITH the text because derivation needs both and a
 * mixed-orientation document has no single page size to fall back on — the
 * compliance library is full of them (the dozer assessment runs to eighteen
 * pages and mixes portrait with landscape).
 */
export interface TextPage {
  items: PositionedText[];
  width: number;
  height: number;
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
 * Reject a header whose anchors span more than this multiple of their own
 * combined glyph width.
 *
 * Calibrated across the library, not tuned to one form. Clean option clusters
 * measure 1.00-3.68 (Scraper 3.68, dozer 1.65, Small Excavator 1.80); the same
 * headers with a stray item included measure 9.76-10.69 (dozer, Small Loader,
 * Small Excavator). A threshold of 5 sits in that gap with room on both sides.
 *
 * This keys on glyph WIDTHS, which the centre-based band derivation never
 * reads — so it is real corroboration rather than a restatement of the inputs.
 * It does NOT separate furniture from real headers (furniture measures
 * 1.99-2.15, tighter than a genuine Scraper cluster); header repetition is what
 * catches furniture.
 */
const MAX_CLUSTER_SPREAD = 5;

/** A sorted-gap jump of at least this ratio separates wraps from rows. */
const GAP_SPLIT_RATIO = 1.4;

/**
 * Two headers are the same table shape when every anchor agrees within this.
 *
 * Measured across the library rather than assumed. The dozer family repeats its
 * header at identical x on every page (variance ~0). `ADMN-FRM-111` prints its
 * three category blocks at 512.6/540.7, 510/538.3 and 510/538.3 — a real
 * within-document variance of 2.6pt, which a 2pt window wrongly split, refusing
 * the largest table on the form. The discriminating case is far outside this:
 * that form's Shift row sits 7.2pt and 12.4pt from the real columns, so 4pt
 * admits the genuine variance while still refusing the impostor with margin.
 */
const REPEAT_TOLERANCE = 4;

/**
 * A header row carrying no label of its own is recognised only when its items
 * are near-uniform in width — the widest at most this multiple of the narrowest.
 *
 * This is what separates an option-header row from ordinary prose. Measured:
 * `ADMN-FRM-111`'s `OK NA OK NA OK NA` row spans 12.2-12.6 (ratio 1.03), while
 * the label lines beneath it run 60.8, 112.1 and 94.8 on one baseline (ratio
 * 1.84). Option glyphs are set from the same short vocabulary and are therefore
 * almost exactly as wide as each other; running text never is.
 */
const UNIFORM_WIDTH_RATIO = 1.5;

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

/**
 * Median of a list, or undefined when empty.
 *
 * Every caller here works from a median gap — between header anchors, between
 * option centres, between row baselines — but each wants a different answer for
 * "there were no gaps", so the fallback stays with the caller.
 */
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Mean of the middle pair on an even-length list. Taking the upper middle
  // instead makes the median of a two-element list equal to its LARGER member,
  // which silently disabled outlier detection wherever exactly two gaps were
  // measured — the reference value became the outlier it was meant to catch.
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Group items into printed rows by baseline. */
function toRows(items: PositionedText[]): Row[] {
  const sorted = [...items]
    // pdfjs can report a degenerate measurement, and a non-finite coordinate
    // fails every comparison below rather than throwing — so the item would be
    // quietly dropped from the header candidates and its column treated as
    // MISSING rather than as unmeasured. Drop it here so a corrupt measurement
    // cannot masquerade as an absent glyph.
    .filter((i) => Number.isFinite(i.x) && Number.isFinite(i.y) && Number.isFinite(i.width))
    .filter((i) => i.text.trim() !== '' || i.width > 0)
    .sort((a, b) => b.y - a.y);
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
  const typical = median(gaps)!;

  let cutAfter = -1;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i]! > Math.max(typical * CLUSTER_GAP_FACTOR, 1)) cutAfter = i;
  }

  return cutAfter < 0 ? candidates : candidates.slice(cutAfter + 1);
}

interface HeaderRow {
  row: Row;
  /** Left edge of the label column, in points. */
  labelLeft: number;
  /** Right edge of the label column — the leftmost an option band may start. */
  labelRight: number;
  anchors: PositionedText[];
  /** Whether another header on the page confirms this anchor pattern. */
  corroborated?: boolean;
}

interface HeaderShape {
  candidates: PositionedText[];
  labelLeft: number;
  labelRight: number;
}

/**
 * Shape one: a wide label header plus a cluster of short items to its right.
 *
 * Two or more candidates are required. One yields no pitch, so a three-column
 * table could not be derived from it without inventing two boundaries — and a
 * single short item to the right of a wide one is an extremely common shape in
 * ordinary prose, so accepting it would find headers everywhere.
 */
function labelledHeader(row: Row): HeaderShape | null {
  const labelHeader = row.items.reduce((a, b) => (b.width > a.width ? b : a), row.items[0]!);
  if (!labelHeader || labelHeader.width <= 0) return null;

  const right = labelHeader.x + labelHeader.width;
  const candidates = row.items.filter(
    (i) => i !== labelHeader && i.x >= right && i.width <= labelHeader.width * OPTION_WIDTH_RATIO,
  );
  if (candidates.length < 2) return null;

  return { candidates, labelLeft: labelHeader.x, labelRight: right };
}

/**
 * Shape two: option headers on a baseline of their own, with no label text.
 *
 * `ADMN-FRM-111` prints `OK NA OK NA OK NA` on its own row and puts the item
 * names on the rows beneath. Shape one cannot see that at all — it takes the
 * widest item as the label header, then looks for candidates a quarter of that
 * width, and among six near-identical glyphs there are none. The row was
 * discarded and the form's Shift row accepted in its place.
 *
 * Recognised by width UNIFORMITY, which is what actually distinguishes a row of
 * option glyphs from a row of running text: option labels come from the same
 * short vocabulary and are near-identical in width, prose never is. The label
 * column then comes from the rows beneath — the left margin they share.
 *
 * This is a SECOND shape, deliberately, not a relaxation of the first. Widening
 * shape one's filter would admit more page furniture, which is the opposite of
 * what this unit is for.
 */
function standaloneHeader(row: Row, rows: Row[]): HeaderShape | null {
  if (row.items.length < 2) return null;

  const widths = row.items.map((i) => i.width);
  const min = Math.min(...widths);
  const max = Math.max(...widths);
  if (!(min > 0) || max / min > UNIFORM_WIDTH_RATIO) return null;

  // The label column is whatever left margin the rows beneath share. Without
  // rows there is no table, and no way to bound the label column either.
  const below = rows.filter((r) => r.y < row.y - BASELINE_TOLERANCE);
  const labelLeft = mostCommon(below.map((r) => Math.round(r.items[0]!.x)));
  if (labelLeft === undefined) return null;

  // Every option must sit right of the label margin, or this is not a header
  // sitting above a table.
  if (row.items.some((i) => i.x <= labelLeft)) return null;

  return { candidates: row.items, labelLeft, labelRight: labelLeft };
}

/** The most frequent value, or undefined for an empty list. Ties take the smallest. */
function mostCommon(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Group rows and pick out the header rows among them.
 */
function findHeaderRows(rows: Row[]): HeaderRow[] {
  const headers: HeaderRow[] = [];

  for (const row of rows) {
    const found = labelledHeader(row) ?? standaloneHeader(row, rows);
    if (!found) continue;

    const anchors = rightmostCluster(found.candidates);
    if (anchors.length < 2) continue;

    // Corroboration by glyph width. The gap-outlier split above needs three or
    // more gaps to have a reference the outlier does not define; with two
    // candidates it cannot fire at all. This catches what it misses: a cluster
    // holding something that is not a column header spreads far wider than its
    // own glyphs. See MAX_CLUSTER_SPREAD for the measured separation.
    const span = anchors[anchors.length - 1]!.x + anchors[anchors.length - 1]!.width - anchors[0]!.x;
    const widthSum = anchors.reduce((sum, a) => sum + a.width, 0);
    if (!(widthSum > 0) || span / widthSum > MAX_CLUSTER_SPREAD) continue;

    headers.push({ row, labelLeft: found.labelLeft, labelRight: found.labelRight, anchors });
  }

  // Corroboration by repetition. A printed table repeats its header per
  // occurrence — measured 2-3 times per page on every real table across five
  // documents — while page furniture (a running head, a signature strip) occurs
  // once. So when a page offers several candidates, one that matches no sibling
  // is furniture and is dropped. A lone candidate cannot be corroborated this
  // way and is kept, because single-table forms are real (ADMN-FRM-111 is one
  // table on one page); it is marked uncorroborated instead so the proposal
  // carries lower confidence and says why.
  if (headers.length < 2) return headers.map((h) => ({ ...h, corroborated: false }));

  const matches = (a: HeaderRow, b: HeaderRow) =>
    a.anchors.length === b.anchors.length &&
    a.anchors.every((anchor, i) => Math.abs(anchor.x - b.anchors[i]!.x) <= REPEAT_TOLERANCE);

  return headers
    .filter((h) => headers.some((other) => other !== h && matches(h, other)))
    .map((h) => ({ ...h, corroborated: true }));
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
  rightmostText?: number,
): { centres: number[]; located: number; inferred: number; merged: number } | null {
  const centres = anchors.map((a) => a.x + a.width / 2).sort((a, b) => a - b);

  if (centres.length === expected) {
    return { centres, located: centres.length, inferred: 0, merged: 0 };
  }

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
    return { centres: merged, located: expected, inferred: 0, merged: centres.length - expected };
  }

  // Fewer anchors than columns: extend leftward on the median pitch. Leftward
  // because the label column bounds the left edge, so there is known room
  // there, whereas extending right would run off the page.
  const pitch = median(centres.slice(1).map((c, i) => c - centres[i]!));
  if (pitch === undefined || !(pitch > 0)) return null;

  // Extending leftward asserts that the MISSING columns are the leftmost ones.
  // Nothing checked that, and when it is wrong every band shifts one column and
  // a recorded cross is stamped in the tick column — reproduced on the dozer
  // header with N/A removed. Only extend when the located cluster is bounded on
  // the right by evidence the derivation did not use: the rightmost text on the
  // header row. If something is printed to the right of the last located
  // anchor, the missing column may well be THAT one, and there is no honest way
  // to tell — so refuse and let the reviewer draw it.
  if (rightmostText !== undefined && rightmostText > centres[centres.length - 1]! + pitch / 2) return null;

  const extended = [...centres];
  while (extended.length < expected) extended.unshift(extended[0]! - pitch);

  return {
    centres: extended,
    located: centres.length,
    inferred: expected - centres.length,
    merged: 0,
  };
}

/**
 * Turn anchor centres into contiguous bands.
 *
 * Interior boundaries are midpoints. The OUTER edges extend by half the typical
 * inter-anchor pitch rather than reaching for the label column: anchoring the
 * first band at the label column's right edge gave the dozer's tick a 282pt
 * span across blank paper, so a mark anywhere in that emptiness would have
 * resolved as "ticked".
 *
 * `leftLimit` is the label HEADER's right edge, which is not the same as the
 * label column's — the header text is often far shorter than the longest label
 * cell beneath it (192pt against 442pt on the measured fixture), so this bounds
 * the bands against the header, not against the widest printed label.
 * `rightLimit` keeps the last band on the page: the segment box is derived from
 * that band's end, so an unclamped overhang made the box narrower than its own
 * band and the whole proposal was then dropped by the validator with no reason
 * surfaced.
 */
function centresToBands(
  centres: number[],
  keys: string[],
  leftLimit: number,
  rightLimit: number,
): GeometryBand[] {
  const pitch = median(centres.slice(1).map((c, i) => c - centres[i]!)) ?? 12;
  const margin = pitch / 2;

  return centres.map((centre, i) => ({
    key: keys[i]!,
    start: i === 0 ? Math.max(centre - margin, leftLimit) : (centres[i - 1]! + centre) / 2,
    end: i === centres.length - 1 ? Math.min(centre + margin, rightLimit) : (centre + centres[i + 1]!) / 2,
  }));
}

/**
 * The row pitch, from the *distribution* of baseline gaps rather than one
 * statistic over them.
 *
 * A median over the raw gaps is circular: the wraps this pitch exists to
 * identify are themselves in the sample, so a table whose labels mostly wrap
 * drags the median down onto a wrap gap and merging stops — while a table with
 * irregular leading drags it up and a genuine row gets merged away. Both were
 * reproduced; both produced a wrong grid at full confidence.
 *
 * Instead: sort the gaps and split at the largest ratio jump. The larger side
 * is the row pitch, the smaller side is wraps. Returns 0 — meaning "merge
 * nothing" — whenever the two sides are the same size, because that is a table
 * where wraps and rows cannot be told apart, and adding a spurious row is
 * recoverable in review while silently deleting a printed one is not.
 */
function rowPitch(gaps: number[]): number {
  if (gaps.length === 0) return 0;
  if (gaps.length === 1) return gaps[0]!;

  const sorted = [...gaps].sort((a, b) => a - b);
  let splitAt = -1;
  let widest = GAP_SPLIT_RATIO;
  for (let i = 1; i < sorted.length; i++) {
    const ratio = sorted[i]! / sorted[i - 1]!;
    if (ratio >= widest) {
      widest = ratio;
      splitAt = i;
    }
  }

  // No separable jump: every gap is a row gap.
  if (splitAt < 0) return median(sorted) ?? 0;

  const wraps = sorted.slice(0, splitAt);
  const rows = sorted.slice(splitAt);
  if (rows.length <= wraps.length) return 0;
  return median(rows) ?? 0;
}

/**
 * Row bands from the label column's baselines.
 *
 * A label that wraps onto a second line is ONE row. Measured need: page 7's
 * `Isolates machine correctly...` wraps, leaving a 10.4pt gap against a ~16.8pt
 * row pitch, and counting it as two rows would offset every answer below it.
 */
function rowBands(rows: Row[], header: HeaderRow, floor: number): GeometryBand[] {
  const labelLeft = header.labelLeft;
  const below = rows
    .filter((r) => r.y < header.row.y - BASELINE_TOLERANCE && r.y > floor)
    // The label column has ONE left margin. A numbered section heading printed
    // at x=38.7 against the label column's 37.5 is close enough to pass a loose
    // tolerance, and counting it as a row offsets every answer after it.
    .filter((r) => r.items.some((i) => Math.abs(i.x - labelLeft) <= LABEL_MARGIN_TOLERANCE))
    .sort((a, b) => b.y - a.y);
  if (below.length === 0) return [];

  const pitch = rowPitch(below.slice(1).map((r, i) => below[i]!.y - r.y));

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
    // Clamped to the page: the last row's band extends half a pitch below its
    // baseline, which runs off the bottom of a table printed near the margin.
    const bottom = Math.max(next !== undefined ? (y + next) / 2 : y - step / 2, 0);
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
    const rightmostText = Math.max(...header.row.items.map((i) => i.x + i.width));
    const resolved = reconcile(header.anchors, optionColumns.length, rightmostText);
    if (!resolved) continue;

    // Inference on an uncorroborated header stacks a guess on a guess: the
    // header itself is unconfirmed, and inference then invents a column
    // position on top of it. That combination is what turned a running head
    // ("Rev 4", "07/2026" beside a document title) into a plausible three-column
    // grid. A confirmed header may infer; an unconfirmed one must be exact.
    if (resolved.inferred > 0 && header.corroborated === false) continue;

    // A table ends where the next one begins. Without this floor the first
    // table on a page claims every label line beneath it — 35 rows for a table
    // that prints 4, putting every later answer on the wrong row.
    const floor = headers[index + 1]?.row.y ?? -Infinity;

    const bands = rowBands(rows, header, floor);
    if (bands.length === 0) continue;

    const columnBands = centresToBands(
      resolved.centres,
      optionColumns.map((c) => c.key),
      header.labelRight,
      input.pageWidth,
    );

    const left = header.labelLeft;
    const right = Math.min(columnBands[columnBands.length - 1]!.end, input.pageWidth);
    const bottom = Math.min(...bands.map((b) => b.start));
    const top = header.row.y;

    const notes: string[] = [];
    let confidence = 1;
    if (resolved.inferred > 0) {
      confidence -= 0.3 * resolved.inferred;
      notes.push(
        `${resolved.inferred} of ${optionColumns.length} column positions inferred from pitch — the header glyphs were not in the text layer. Inference assumes the MISSING columns are the leftmost ones; check the rightmost located header really is the last printed column.`,
      );
    }
    if (header.corroborated === false) {
      confidence -= 0.2;
      notes.push(
        'No second table on this page confirms this header shape, so the grid could not be cross-checked — verify it is a real column header and not a running head or signature strip.',
      );
    }
    if (resolved.merged > 0) {
      // Merging is a guess, and reporting it as a clean locate inverted the one
      // signal the reviewer has. More anchors than columns means either an
      // over-segmented header or a non-header item taken as an anchor, and the
      // second is the dangerous reading.
      confidence -= 0.3 * resolved.merged;
      notes.push(
        `${resolved.located + resolved.merged} anchors were found for ${optionColumns.length} columns and the closest were merged — the header may be over-segmented, or something that is not a column header was taken as one.`,
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
