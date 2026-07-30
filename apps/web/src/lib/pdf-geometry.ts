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

/**
 * How far a line's run may reach toward the first option column before it is
 * read as a heading rather than an item label, in points.
 *
 * The signal that ends a table is geometric, not textual (KTD1/KTD4): an item
 * label's run at the label margin stays LEFT of the first option column, while a
 * between-tables section heading is a single wide run that crosses INTO the
 * option region. Measured clearance between the widest kept item label and its
 * leftmost option glyph is comfortable and consistent across the library — the
 * `ADMN-FRM-111` Category A label `Collision Avoidance System` ends at 146.8
 * against the option at 164.5 (17.7pt), Category B's widest ends at 141.9
 * against 161.9 (20.0pt), and the dozer's longest wrapping label ends at 480.2
 * against 502.6 (22.4pt). The headings that must be cut overshoot by hundreds of
 * points (Category B's run ends at 521.4, Category C's at 436.8). A 4pt window
 * sits far inside every real label's clearance while still catching a heading
 * that stopped a touch short of the column — the same measured-tolerance scale
 * as REPEAT_TOLERANCE.
 */
const OPTION_INTRUSION_TOLERANCE = 4;

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
  // Two uniform-width items is not evidence of anything — a running head with
  // two glyphs of the same width satisfies it, and with two option columns the
  // "inferred but uncorroborated" refusal never fires to catch it. Three is the
  // smallest header the library actually prints (the dozer family's
  // tick / cross / N-A), so it costs no real document and closes that hole.
  if (row.items.length < 3) return null;

  const widths = row.items.map((i) => i.width);
  const min = Math.min(...widths);
  const max = Math.max(...widths);
  if (!(min > 0) || max / min > UNIFORM_WIDTH_RATIO) return null;

  // The label column is the margin of the row immediately beneath the header —
  // the first item of the table this header sits on. Deliberately NOT a mode
  // over every row below: `rows` is the whole page, so a long instruction
  // paragraph further down would outvote the table's own rows and the grid
  // would be laid over prose at full confidence.
  const below = rows.filter((r) => r.y < row.y - BASELINE_TOLERANCE);
  const labelLeft = below[0]?.items[0]?.x;
  if (labelLeft === undefined) return null;

  // And it has to REPEAT, or one stray line under the header would set it.
  // Compared at full precision: the measured margin here is 37.5 and a numbered
  // section heading sits at 38.7, so rounding to an integer would put both
  // inside the 1pt window and count the heading as a table row.
  const shared = below.filter((r) => Math.abs(r.items[0]!.x - labelLeft) <= LABEL_MARGIN_TOLERANCE);
  if (shared.length < 2) return null;

  // Every option must sit right of the label margin, or this is not a header
  // sitting above a table.
  if (row.items.some((i) => i.x <= labelLeft)) return null;

  return { candidates: row.items, labelLeft, labelRight: labelLeft };
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
  const marginRun = (r: Row) => r.items.find((i) => Math.abs(i.x - labelLeft) <= LABEL_MARGIN_TOLERANCE);
  const below = rows
    .filter((r) => r.y < header.row.y - BASELINE_TOLERANCE && r.y > floor)
    // The label column has ONE left margin. A numbered section heading printed
    // at x=38.7 against the label column's 37.5 is close enough to pass a loose
    // tolerance, and counting it as a row offsets every answer after it.
    .filter((r) => marginRun(r) !== undefined)
    .sort((a, b) => b.y - a.y);
  if (below.length === 0) return [];

  // Stop at the last genuine item row (U1, R1/R2). A between-tables section
  // heading — `Category 'B' faults: …` on ADMN-FRM-111 — prints at the SAME
  // left margin as the item labels, so the margin filter above cannot exclude
  // it; on a 6-row table it was counted as a 7th row and the overlay leaked into
  // the next section. The discriminator is horizontal extent, never text
  // (KTD1): an item label's run at the margin stays left of the first option
  // column, while the heading is a single wide run that crosses into the option
  // region. Once such a line appears the table has ended, so cut there rather
  // than skipping it (KTD2): a genuine item never follows the next section's
  // heading.
  //
  // The reference is where THIS table's first option column sits — the column an
  // intruding heading is measured against — and the two header shapes locate it
  // differently:
  //   - A standalone option-header row (ADMN-FRM-111) carries only option glyphs
  //     and no label of its own, so the first option is the leftmost glyph on the
  //     row (164.5). The reconciled anchors are the WRONG reference here: that
  //     form is a three-up checklist and rightmostCluster keeps only its
  //     rightmost OK/NA pair (512.6), but a heading in the middle block runs only
  //     to 436.8 and must still be judged against the FIRST column it crosses.
  //   - A labelled header (the dozer) carries a wide label whose cells beneath
  //     legitimately run long (to 480.2), so the reference must be the option
  //     cluster, not the label. The reconciled anchors are exactly that, with any
  //     stray already stripped — the ':' at x=228 that shares the label's right
  //     edge would otherwise be mistaken for the first option and cut every row.
  const isStandalone = header.labelRight === header.labelLeft;
  const optionLeft = isStandalone
    ? Math.min(...header.row.items.map((i) => i.x))
    : (header.anchors[0]?.x ?? Infinity);
  const intrusion = optionLeft - OPTION_INTRUSION_TOLERANCE;
  const headingAt = below.findIndex((r) => {
    const run = marginRun(r)!;
    return run.x + run.width >= intrusion;
  });
  if (headingAt === 0) return [];
  const rowsOnly = headingAt > 0 ? below.slice(0, headingAt) : below;

  const pitch = rowPitch(rowsOnly.slice(1).map((r, i) => rowsOnly[i]!.y - r.y));

  // Merge wrapped continuation lines into the row they belong to.
  const baselines: number[] = [];
  for (const row of rowsOnly) {
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

/* ── Non-table fields ─────────────────────────────────────────────────────── */

/**
 * A field whose answer is printed as a row of option cells, but which was NOT
 * extracted as a repeating table.
 *
 * This is the shape the assessment tools actually take. The dozer's theory
 * pages LOOK like a table — a question per row, tick / cross / N-A columns down
 * the right — but the extraction profile deliberately emits one FIELD per
 * question rather than one table with 31 rows, because a question needs its own
 * answer key and its own outcome cell. `proposeTableSegments` therefore never
 * fires on them, and every one of those cells has to be drawn by hand.
 *
 * The page is still geometrically a table, so the column derivation above
 * applies unchanged. What is new is only the row: instead of taking every row
 * beneath the header, one field is matched to ONE row by its label text.
 */
export interface FieldProposeInput {
  page: number;
  pageWidth: number;
  pageHeight: number;
  items: PositionedText[];
  /** The field's label, as extracted. Matched against the printed row. */
  label: string;
  /** Option keys in PRINTED left-to-right order — one cell each. */
  options: readonly string[];
}

export interface FieldProposal {
  /** One box per option, each carrying its `optionKey`. */
  segments: PageBox[];
  /** 0..1. Reduced for every anchor inferred rather than found. */
  confidence: number;
  /** Why confidence was reduced, or why the match was close. For the reviewer. */
  notes: string[];
}

/**
 * Normalize text for label matching.
 *
 * Aggressive on purpose. The extracted label came from a vision model reading
 * the same page, so it agrees on WORDS but not on punctuation, spacing, or the
 * question number — and the text layer splits a line into runs at arbitrary
 * points. Comparing anything finer than a word sequence compares artefacts of
 * two different extractors rather than the sentence both of them read.
 */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Leading enumeration — "12.", "Q3", "(a)" — which the model often drops from
 * the label and the page always prints.
 */
function stripEnumeration(text: string): string {
  // Also handles a bare leading letter enumeration ("a b) True" normalizes to
  // "a true"), which the stacked multiple-choice rows carry.
  return text.replace(/^(?:q(?:uestion)?\s*)?\d+\s*/, '').trim();
}

/**
 * Every row inside a band, top-down, as one normalized string.
 *
 * The HEADER row is excluded. The first band's top edge IS the header baseline,
 * so the header falls inside it — and its text is the column names (`N/A`, and
 * the question stem "During the demonstration, did the candidate:"). Counting
 * that as part of the first row both invents label text and makes the column
 * names look like options printed in the row, which refused every first
 * criterion on the page.
 */
function bandText(rows: Row[], band: GeometryBand, headerY: number): string {
  return normalizeForMatch(
    rows
      .filter((r) => r.y > band.start && r.y <= band.end && r.y !== headerY)
      .sort((a, b) => b.y - a.y)
      .flatMap((r) => [...r.items].sort((a, b) => a.x - b.x).map((i) => i.text))
      .join(' '),
  );
}

/**
 * Is `needle` present in `haystack` as a run of WHOLE words?
 *
 * Token-wise rather than substring, because the normalizer collapses
 * punctuation to spaces: `N/A` becomes `n a`, which occurs as a substring of
 * "operates in a safe manner" and of half the criteria on the form. As tokens
 * it does not.
 */
function containsTokens(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const hay = haystack.split(' ').filter(Boolean);
  const want = needle.split(' ').filter(Boolean);
  if (want.length === 0 || want.length > hay.length) return false;

  for (let i = 0; i + want.length <= hay.length; i++) {
    if (want.every((w, j) => hay[i + j] === w)) return true;
  }
  return false;
}

/**
 * Are this field's options printed INSIDE the row, rather than as columns?
 *
 * The discriminator between the two shapes a choice field takes on these forms,
 * and the guard that stops the column mapping being applied to the wrong one:
 *
 *   - A practical criterion — "Manoeuvres dozer safely" with options `✓ / ×`
 *     and `N/A` — names the COLUMNS down the right of the page. Its options are
 *     column headers and appear nowhere in the row itself.
 *   - A theory question — "Q1. The track dozer must be isolated…" with options
 *     `True` and `False` — prints its answers inline, beside the question. Its
 *     boxes sit next to those printed words, nowhere near the outcome columns.
 *
 * Both reach this module as "a choice field with two options", and both sit on
 * a page carrying a `✓ / × N/A` header. Mapping the second onto the columns
 * would put a tick for "True" in the tick column of an outcome cell — a
 * confident mark in a cell nobody measured, which is the failure this whole
 * module is arranged to prevent. So: if an option is printed in the row, the
 * options are not the columns, and this refuses.
 *
 * Symbol-only options (`✓ / ×` normalizes to nothing) carry no evidence either
 * way and are skipped rather than counted as absent.
 */
function optionsPrintedInRow(text: string, options: readonly string[]): boolean {
  return options.some((option) => {
    const needle = normalizeForMatch(option);
    // Two characters is not enough to be evidence of anything.
    if (needle.length < 2) return false;
    return containsTokens(text, needle);
  });
}

/**
 * Does this row band carry the field's label?
 *
 * Containment in EITHER direction: the model's label can be a shortened form of
 * the printed question, or can carry a heading the print splits across the
 * band. Requiring equality matched almost nothing.
 *
 * Deciding which band wins — and refusing when several do — is the caller's
 * job, because ambiguity is a property of the whole page rather than of any one
 * band. See `proposeFieldOptionCells`.
 */
function bandMatches(rows: Row[], band: GeometryBand, label: string, headerY: number): boolean {
  const wanted = stripEnumeration(normalizeForMatch(label));
  // A handful of characters is not enough to identify a row: "yes", "date",
  // "name" match half the page. Below this the only safe answer is to let a
  // reviewer draw it, which is the visible failure rather than the silent one.
  if (wanted.length < 12) return false;

  // The printed side is stripped too. The page numbers its rows ("1. Plan and
  // Prepare") while the extracted label often does not, and an unstripped number
  // sits at the front of the haystack where it breaks containment in both
  // directions.
  const text = stripEnumeration(bandText(rows, band, headerY));
  if (text.length === 0) return false;
  return text.includes(wanted) || wanted.includes(text);
}

/**
 * Propose one option cell per option for a non-table field.
 *
 * Returns null rather than a guess whenever the page does not settle it — no
 * option header, a label that matches no row or several, anchors that cannot be
 * reconciled against the option count. Every refusal leaves the field exporting
 * as data, which is a visibly incomplete PDF someone notices; a confident box in
 * the wrong cell stamps a competency mark against something nobody checked.
 */
export function proposeFieldOptionCells(input: FieldProposeInput): FieldProposal | null {
  if (input.options.length < 2 || input.items.length === 0) return null;

  const rows = toRows(input.items);
  // Top-down, so a page carrying several tables uses the header that actually
  // governs the matched row rather than whichever was found first.
  const headers = findHeaderRows(rows).sort((a, b) => b.row.y - a.row.y);
  if (headers.length === 0) return null;

  // Every match on the WHOLE page is collected before any is used. Judging
  // ambiguity per header would miss the case that matters most: a page carrying
  // the same question under two tables offers one match beneath each, and each
  // header on its own looks unambiguous.
  const matches: { header: HeaderRow; band: GeometryBand }[] = [];
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h]!;
    const bands = rowBands(rows, header, headers[h + 1]?.row.y ?? 0);
    for (const band of bands) {
      if (bandMatches(rows, band, input.label, header.row.y)) matches.push({ header, band });
    }
  }

  // Absence and ambiguity are the same answer: let a reviewer draw it. Placing
  // the cell on the wrong occurrence records an assessment against something
  // nobody asked.
  if (matches.length !== 1) return null;
  const { header, band } = matches[0]!;

  // The options must BE the page's columns. When they are printed in the row
  // instead, this is a question with inline answers and its boxes are beside
  // those words — see `optionsPrintedInRow`.
  if (optionsPrintedInRow(bandText(rows, band, header.row.y), input.options)) return null;

  const rightmostText = Math.max(...header.row.items.map((i) => i.x + i.width));
  const reconciled = reconcile(header.anchors, input.options.length, rightmostText);
  if (!reconciled) return null;

  const columns = centresToBands(
    reconciled.centres,
    [...input.options],
    header.labelRight,
    input.pageWidth,
  );
  const height = band.end - band.start;
  if (!(height > 0)) return null;

  const segments: PageBox[] = columns.map((column) => ({
    page: input.page,
    x: column.start,
    y: band.start,
    width: column.end - column.start,
    height,
    pageWidth: input.pageWidth,
    pageHeight: input.pageHeight,
    optionKey: column.key,
  }));

  // The same validator the reviewer's hand-drawn boxes pass. A proposal that
  // cannot survive it would be dropped silently at export.
  if (
    segments.some(
      (s) => resolveGeometry({ geometry: { segments: [s] } }, input.page + 1).segments.length === 0,
    )
  ) {
    return null;
  }

  const notes: string[] = [];
  let confidence = 1;
  if (reconciled.inferred > 0) {
    confidence -= 0.25 * reconciled.inferred;
    notes.push(`${reconciled.inferred} option column(s) inferred from pitch, not found in the text.`);
  }
  if (reconciled.merged > 0) {
    notes.push(`${reconciled.merged} header run(s) merged to match the option count.`);
  }
  if (!header.corroborated) {
    confidence -= 0.15;
    notes.push('Only one option header on the page — nothing corroborates the column positions.');
  }

  return { segments, confidence: Math.max(0, Math.min(1, confidence)), notes };
}

/**
 * How far left of an option's text a marker glyph may sit and still be its own.
 *
 * A checkbox printed in the text layer sits immediately before the words it
 * labels. Beyond about a dozen points the nearest run is the previous option's
 * text or the question stem, not a marker.
 */
const MARKER_GAP = 12;

/** A marker glyph is a box or bullet, never a word. */
const MARKER_MAX_WIDTH = 15;

/** Fallback marker side length, and the gap it leaves before the text. */
const SYNTHETIC_MARKER_SIZE = 10;
const SYNTHETIC_MARKER_GAP = 3;

/**
 * How many printed rows below the question its answers may occupy.
 *
 * Six options is the largest on the measured library ("All of these answers are
 * correct" questions run to six), and a wrapped option takes two lines. Beyond
 * that the search has left the question and is reading the next one.
 */
const INLINE_SEARCH_ROWS = 14;

/**
 * Propose one box per option for a question whose answers are PRINTED INLINE.
 *
 * The counterpart to `proposeFieldOptionCells`, for the other population of
 * choice fields on these forms. A theory question — "Q1. The track dozer must
 * be isolated…" with `True` and `False` — prints its answers beside or beneath
 * itself, and its marks belong next to those printed words. It has no option
 * columns at all, so the column derivation must never be applied to it (see
 * `optionsPrintedInRow`, which is the guard on the other side of this line).
 *
 * Anchoring on the option's OWN text is what makes this safe. The column rule
 * could put a tick for "True" in the tick column of an unrelated outcome cell —
 * a mark against the wrong answer. Here the worst case is a box a few points
 * off the printed checkbox but unambiguously against the option it names, which
 * is a cosmetic error rather than a false record.
 *
 * Refuses unless EVERY option is found exactly once. A partial placement is
 * worse than none: the options a reviewer can see placed are the ones they stop
 * checking.
 */
export function proposeInlineOptionCells(input: FieldProposeInput): FieldProposal | null {
  if (input.options.length < 2 || input.items.length === 0) return null;

  const wanted = stripEnumeration(normalizeForMatch(input.label));
  if (wanted.length < 12) return null;

  const rows = toRows(input.items);
  if (rows.length === 0) return null;

  // Where the question is printed. Ambiguity refuses, exactly as it does for
  // the column rule — the dozer asks "True / False" of many questions, and the
  // label is the only thing telling them apart.
  const matchingRows: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    // Enumeration stripped from the PRINTED row as well as the label. The page
    // prints "1. The track dozer must be isolated…" while the extracted label
    // reads "Q1. …", and leaving the row's number in place broke containment in
    // both directions for any question long enough to wrap.
    const text = stripEnumeration(normalizeForMatch(rows[i]!.items.map((x) => x.text).join(' ')));
    // A short row is not evidence. Without this floor a bare "true" or a page
    // number could satisfy `wanted.includes(text)` for any question at all.
    if (text.length < 12) continue;
    if (text.includes(wanted) || wanted.includes(text)) matchingRows.push(i);
  }

  // ADJACENT matches are one wrapped question, not two questions. A question
  // printed over two lines matches on both of them — each line's words are a
  // subset of the label — and counting that as ambiguity refused every long
  // question while short ones placed correctly. Genuine ambiguity is matches in
  // SEPARATED places, which is what this still refuses.
  const runs: number[][] = [];
  for (const i of matchingRows) {
    const last = runs[runs.length - 1];
    if (last && i === last[last.length - 1]! + 1) last.push(i);
    else runs.push([i]);
  }
  if (runs.length !== 1) return null;

  const startIndex = runs[0]![0]!;
  const window = rows.slice(startIndex, startIndex + INLINE_SEARCH_ROWS);

  // Locate every option's printed text first. Nothing can be placed until all
  // of them are found: a partial placement is worse than none, because the
  // options a reviewer can see placed are the ones they stop checking.
  const located: { option: string; row: Row; item: PositionedText }[] = [];
  for (const option of input.options) {
    const needle = normalizeForMatch(option);
    if (needle.length < 2) return null;

    const hits: { row: Row; item: PositionedText }[] = [];
    for (const row of window) {
      for (const item of row.items) {
        if (containsTokens(normalizeForMatch(item.text), needle)) hits.push({ row, item });
      }
    }
    // Found nowhere, or in several places — either way there is no single box
    // this option names, and guessing between them records an answer nobody
    // gave.
    if (hits.length !== 1) return null;
    located.push({ option, row: hits[0]!.row, item: hits[0]!.item });
  }

  // WHICH SIDE the checkbox sits on is measured, never assumed. Both layouts
  // are real and this module cannot tell them apart a priori: the dozer prints
  // "No ☐ Yes ☐" with the box AFTER the word, while a stacked multiple-choice
  // prints "☐ All the above" with it BEFORE. Assuming one put every mark about
  // twenty points off the printed box on the other.
  const sightings = located
    .map(({ row, item }) => ({ before: markerBefore(row, item), after: markerAfter(row, item) }))
    .map((m) => (m.after ? ('after' as const) : m.before ? ('before' as const) : null))
    .filter((side): side is 'before' | 'after' => side !== null);

  // No marker glyph anywhere on this field. It is drawn as vector strokes,
  // which this module never reads, and there is no evidence for which side it
  // is on — so refuse rather than place every box on a guessed side.
  if (sightings.length === 0) return null;

  const side = sightings.filter((x) => x === 'after').length >= sightings.length / 2 ? 'after' : 'before';

  const pitch = rowPitch(window.slice(1).map((r, i) => window[i]!.y - r.y));
  const size = Math.min(SYNTHETIC_MARKER_SIZE, pitch > 0 ? pitch * 0.7 : SYNTHETIC_MARKER_SIZE);

  const segments: PageBox[] = [];
  let synthesized = 0;

  for (const { option, row, item } of located) {
    const marker = side === 'after' ? markerAfter(row, item) : markerBefore(row, item);

    if (marker) {
      segments.push({
        page: input.page,
        x: marker.x,
        y: row.y - size * 0.2,
        width: marker.width,
        height: size,
        pageWidth: input.pageWidth,
        pageHeight: input.pageHeight,
        optionKey: option,
      });
      continue;
    }

    // This option's own glyph is missing while its siblings' are present, so
    // the side is known even though the box is not. Estimate it there.
    const x =
      side === 'after'
        ? item.x + item.width + SYNTHETIC_MARKER_GAP
        : item.x - SYNTHETIC_MARKER_GAP - size;
    if (x < 0 || x + size > input.pageWidth) return null;
    synthesized++;
    segments.push({
      page: input.page,
      x,
      y: row.y - size * 0.2,
      width: size,
      height: size,
      pageWidth: input.pageWidth,
      pageHeight: input.pageHeight,
      optionKey: option,
    });
  }

  if (segments.length !== input.options.length) return null;

  // The same validator the reviewer's hand-drawn boxes pass.
  if (
    segments.some(
      (s) => resolveGeometry({ geometry: { segments: [s] } }, input.page + 1).segments.length === 0,
    )
  ) {
    return null;
  }

  const notes: string[] = [];
  let confidence = 1;
  notes.push(
    side === 'after'
      ? 'Checkboxes read as printed AFTER each answer.'
      : 'Checkboxes read as printed BEFORE each answer.',
  );
  if (synthesized > 0) {
    // Halved rather than nudged: an estimated box is the case a reviewer most
    // needs to look at, and it should not read as nearly-certain.
    confidence = 0.5;
    notes.push(
      `${synthesized} of ${segments.length} checkbox(es) were not found in the PDF's text layer — those boxes are estimated and should be checked against the page.`,
    );
  }

  return { segments, confidence, notes };
}

/** A short narrow run immediately BEFORE the option's words, same baseline. */
function markerBefore(row: Row, item: PositionedText): PositionedText | undefined {
  return nearestMarker(
    row.items.filter((c) => c !== item && c.x < item.x),
    (c) => item.x - (c.x + c.width),
  );
}

/** A short narrow run immediately AFTER the option's words, same baseline. */
function markerAfter(row: Row, item: PositionedText): PositionedText | undefined {
  return nearestMarker(
    row.items.filter((c) => c !== item && c.x >= item.x + item.width),
    (c) => c.x - (item.x + item.width),
  );
}

/**
 * The closest candidate that is narrow enough to be a box or bullet rather than
 * a word, and close enough to belong to this option rather than the next.
 */
function nearestMarker(
  candidates: PositionedText[],
  gapOf: (c: PositionedText) => number,
): PositionedText | undefined {
  let best: PositionedText | undefined;
  let bestGap = Infinity;
  for (const candidate of candidates) {
    if (!(candidate.width > 0) || candidate.width > MARKER_MAX_WIDTH) continue;
    const gap = gapOf(candidate);
    if (gap < 0 || gap > MARKER_GAP) continue;
    if (gap < bestGap) {
      bestGap = gap;
      best = candidate;
    }
  }
  return best;
}
