/**
 * The decisions the geometry panel offers, as pure functions.
 *
 * Kept out of the component for the usual reason — the rules are testable and
 * the rendering is not — but also because these decide what a reviewer is
 * ALLOWED to confirm, and that is the guard standing between an AI-derived
 * grid and marks drawn onto a competency record. It belongs somewhere it can
 * be read and tested directly.
 */
import type { FormField, GeometryBand, GroupOrdinal, PageBox } from '@formai/shared';
import { markPlacement } from '@formai/shared';
import type { PositionedText, TableProposal, TextPage } from '../../../lib/pdf-geometry.js';
import { proposeTableSegments } from '../../../lib/pdf-geometry.js';

/**
 * The part of a field grid derivation reads: its shape, its row count, and —
 * when the reviewer split a side-by-side block — which printed group it is.
 * `groupOrdinal` is not a `FormField` property (it is review-only, carried in
 * `reviewMeta`), so it is spelled out here rather than picked from `FormField`.
 */
export type DerivableField = Pick<FormField, 'type' | 'columns' | 'fixedRows'> & {
  groupOrdinal?: GroupOrdinal;
};

/**
 * How much more confident the best row-count match must be than an equally
 * close rival before derivation trusts it over refusing (KTD2/R1).
 *
 * Measured across the library. Derivation confidence is built from discrete
 * penalties in `proposeTableSegments`: a corroborated, fully-located header
 * scores 1.0; losing corroboration costs 0.2; each inferred or merged column
 * costs 0.3. So the separations that actually occur between two same-row-count
 * candidates are: 0.0 (two structurally-identical corroborated tables — the
 * `ADMN-FRM-111` category blocks and the dozer's repeated per-page tables both
 * land here), 0.2 (a corroborated winner over an uncorroborated rival), and
 * 0.3+ (a clean locate over an inferred/merged one). A band of 0.15 sits in the
 * empty gap between the 0.0 ties it must refuse and the ≥0.2 genuine winners it
 * must keep — so no real single-region derivation is lost (R5) while a true
 * coin-flip between indistinguishable tables refuses.
 */
export const NEAR_EQUAL_CONFIDENCE = 0.15;

/** A proposal's leftmost option-column x — the key the ordinal orders on. */
function optionLeftX(proposal: TableProposal): number {
  const cols = proposal.segment.columnBands ?? [];
  return cols.length > 0 ? Math.min(...cols.map((c) => c.start)) : proposal.segment.x;
}

/**
 * Order side-by-side proposals left-to-right by their option columns, taking the
 * higher one first on an x tie. Only reached after `selectByOrdinal` has
 * established the proposals really are side-by-side (x-spread over y-spread), so
 * the x key carries the ordering and the y tie-break is just a stable fallback.
 */
function orderedByColumn(proposals: readonly TableProposal[]): TableProposal[] {
  return [...proposals].sort((a, b) => {
    const dx = optionLeftX(a) - optionLeftX(b);
    return dx !== 0 ? dx : b.segment.y - a.segment.y;
  });
}

/**
 * Select the proposal a group ordinal points at, or refuse.
 *
 * The count matching is necessary but NOT sufficient, and getting that wrong
 * mis-placed grids on the real form. A split records N side-by-side groups, so
 * the ordinal only means something when the page surfaces N proposals that are
 * genuinely side-by-side: on ONE baseline, spread across the page in x. The
 * failure it must refuse is N proposals that merely happen to number N while
 * being VERTICALLY STACKED — e.g. `ADMN-FRM-111`, whose three category blocks
 * (A, B, C) each collapse to one proposal, giving three proposals that share an
 * x column and differ only in y. Counting alone, `3 === 3` matched and the
 * ordinal mapped Category A's groups onto Categories B and C. Side-by-side
 * groups share a header row (same y, different x); stacked categories are the
 * opposite. So the proposals must be arranged more horizontally than
 * vertically, or there is no honest group→proposal mapping and it refuses.
 */
function selectByOrdinal(proposals: readonly TableProposal[], ordinal: GroupOrdinal): TableProposal | null {
  if (proposals.length !== ordinal.count) return null;
  if (ordinal.index < 0 || ordinal.index >= proposals.length) return null;

  const xs = proposals.map(optionLeftX);
  const ys = proposals.map((p) => p.segment.y);
  const xSpread = Math.max(...xs) - Math.min(...xs);
  const ySpread = Math.max(...ys) - Math.min(...ys);
  // Side-by-side ⇒ x varies far more than y. Stacked (different tables that
  // merely count the same as the groups) ⇒ refuse rather than mis-place.
  if (xSpread <= ySpread) return null;

  return orderedByColumn(proposals)[ordinal.index]!;
}

/**
 * Pick the proposal whose row count is closest to the field's, refusing when the
 * winner is not clearly better than an equally-close rival (R1/KTD2).
 */
function selectByRowCount(proposals: readonly TableProposal[], wantRows: number): TableProposal | null {
  const delta = (p: TableProposal) => Math.abs((p.segment.rowBands?.length ?? 0) - wantRows);
  const best = proposals.reduce((b, p) => {
    const d = delta(p);
    const bd = delta(b);
    if (d !== bd) return d < bd ? p : b;
    return p.confidence > b.confidence ? p : b;
  });

  // A rival matches the row count exactly as well. If it is within the near-equal
  // band, the two are indistinguishable on every signal derivation has and
  // picking one would be a coin-flip on table identity — so refuse.
  const bestDelta = delta(best);
  const rivalConfidence = proposals
    .filter((p) => p !== best && delta(p) === bestDelta)
    .reduce((max, p) => Math.max(max, p.confidence), -Infinity);
  if (best.confidence - rivalConfidence < NEAR_EQUAL_CONFIDENCE) return null;

  return best;
}

/** What the panel should show for the selected field. */
export type GeometryPanelState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'draw-only'; reason: string }
  | { kind: 'no-proposal'; reason: string }
  | { kind: 'proposed'; segment: PageBox; confidence: number; notes: string[]; confirmed: boolean };

/**
 * Derive a proposal for one field from a page's text.
 *
 * A page carries several tables and derivation cannot see which printed table a
 * field belongs to, so selection is table-aware or it refuses (parent R16
 * extended to table identity):
 *
 *   1. A split-group field carries its printed-group ordinal — order the page's
 *      proposals left-to-right and take the ordinal-th (`selectByOrdinal`).
 *   2. Otherwise match on row count, but refuse when the winner is not clearly
 *      better than an equally-close rival (`selectByRowCount`).
 *   3. A field with no row count AND no ordinal has nothing to tie it to any one
 *      table, so it refuses rather than grabbing the best-confidence proposal
 *      from an unrelated table (R3/KTD3 — the `FAULTS` sliver bug).
 *
 * A refusal returns null and surfaces through the `no-proposal` panel state: the
 * field exports as data and can be hand-placed. A confidently-wrong grid on a
 * competency record is worse than none.
 */
export function deriveForField(
  field: DerivableField,
  pageIndex: number,
  pageText: PositionedText[],
  pageWidth: number,
  pageHeight: number,
): TableProposal | null {
  if (field.type !== 'repeating_group' || !field.columns || field.columns.length < 2) return null;

  const proposals = proposeTableSegments({
    page: pageIndex,
    pageWidth,
    pageHeight,
    items: pageText,
    columns: field.columns,
  });
  if (proposals.length === 0) return null;

  if (field.groupOrdinal) return selectByOrdinal(proposals, field.groupOrdinal);

  const wantRows = field.fixedRows?.length;
  if (wantRows === undefined) return null;

  return selectByRowCount(proposals, wantRows);
}

/**
 * Derive a proposal for one field across EVERY page.
 *
 * A table extracted by the model carries no `sourcePosition` — only AcroForm
 * fields get one — so there is no page to start from, and deriving against
 * page 0 would silently place an eighteen-page assessment's table on its cover
 * sheet. Every page is tried; the table-awareness lives in `deriveForField`,
 * which already refuses within a page it cannot resolve, so this only combines
 * the per-page picks.
 *
 * An ordinal field resolves entirely inside one page (the ordinal orders THAT
 * page's proposals), so the first page that yields a pick wins — the same
 * "anchor where it starts" rule the row-count path uses on a tie.
 */
export function deriveAcrossPages(
  field: DerivableField,
  pages: readonly TextPage[],
): TableProposal | null {
  if (field.groupOrdinal) {
    for (const [i, page] of pages.entries()) {
      const p = deriveForField(field, i, page.items, page.width, page.height);
      if (p) return p;
    }
    return null;
  }

  const wantRows = field.fixedRows?.length;
  let best: TableProposal | null = null;

  for (const [i, page] of pages.entries()) {
    const p = deriveForField(field, i, page.items, page.width, page.height);
    if (!p) continue;
    if (!best) {
      best = p;
      continue;
    }
    if (wantRows !== undefined) {
      const d = Math.abs((p.segment.rowBands?.length ?? 0) - wantRows);
      const bestD = Math.abs((best.segment.rowBands?.length ?? 0) - wantRows);
      if (d !== bestD) {
        if (d < bestD) best = p;
        continue;
      }
    }
    if (p.confidence > best.confidence) best = p;
  }

  return best;
}

/**
 * Why a field has NO geometry path at all — neither a derived grid nor a
 * hand-drawn box.
 *
 * A non-table field is deliberately NOT unsupported any more (U2/R9): it cannot
 * carry a *derived* grid — there is nothing to derive for a scalar — but it can
 * carry a hand-drawn single-box placement, surfaced through the `draw-only`
 * panel state and confirmed exactly like a grid. The only true dead-end left is
 * a repeating table whose extraction captured no option columns: there is no
 * grid to confirm and no per-cell placement to draw.
 */
export function unsupportedReason(
  field: Pick<FormField, 'type' | 'columns'>,
): string | null {
  if (field.type === 'repeating_group' && (!field.columns || field.columns.length < 2)) {
    return 'This table has no option columns to place, so there is no grid to confirm.';
  }
  return null;
}

/**
 * How far a band edge moves per nudge, in PDF points.
 *
 * A point is roughly a third of a millimetre on the printed page, and the
 * option columns being aligned to are 7-13pt wide — so a 1pt step is the
 * finest correction that is still visible, and anything coarser cannot land
 * inside a narrow column.
 */
export const NUDGE_POINTS = 1;

/**
 * How far from a printed glyph a dragged edge still counts as meaning it.
 *
 * The objection to dragging is real and documented on `BandNudger`: a pointer
 * over a scaled preview cannot resolve a 7-13pt column. Snapping answers it by
 * changing what the pointer has to do — it picks WHICH printed thing the edge
 * belongs to, and the text layer supplies the coordinate, so precision stops
 * depending on the pointer at all (KTD12).
 *
 * 12pt is one option glyph wide: `ADMN-FRM-111` prints OK at 12.2 and NA at
 * 12.6, and the dozer family's N/A is 13.3. Inside a glyph's own width the
 * reviewer meant that glyph; beyond it they meant a bare coordinate, and
 * pulling them to a distant column would be the overshoot the buttons exist to
 * avoid. Ambiguity between two nearby targets is not settled by this number —
 * `snapEdge` takes the NEAREST target, so the closest edge always wins.
 */
export const SNAP_RANGE = 12;

/**
 * Where a dragged edge may land: both edges of every printed run on the page.
 *
 * Deliberately the raw text layer rather than the derivation's own output.
 * `proposeTableSegments` isolates the RIGHTMOST cluster on a row by design, so
 * its bands know 512.6/540.7 on `ADMN-FRM-111` and nothing about the two
 * groups printed to the left — which are exactly the places a reviewer needs
 * to drag to. Extra targets cost nothing here: the pointer has already
 * narrowed the choice to within a glyph's width before any of them apply.
 */
export function snapTargets(items: readonly PositionedText[]): number[] {
  const edges: number[] = [];
  for (const item of items) {
    // pdfjs can report a degenerate measurement, and `toRows` already drops
    // those for the same reason. A single NaN here would sort in place, swallow
    // the dedupe loop's comparison and leave `[NaN]` as the whole target list —
    // every snap would then return NaN, the validator would refuse every move,
    // and dragging would be silently dead on that page.
    if (!Number.isFinite(item.x) || !Number.isFinite(item.width)) continue;
    edges.push(item.x, item.x + item.width);
  }
  edges.sort((a, b) => a - b);

  // Collapse duplicates — a column of items printed at one x contributes that
  // x once, not once per row.
  const unique: number[] = [];
  for (const e of edges) {
    if (unique.length === 0 || e - unique[unique.length - 1]! > 0.5) unique.push(e);
  }
  return unique;
}

/**
 * One draggable vertical edge of a column grid.
 *
 * `left`/`right` name the bands the edge belongs to — an interior edge belongs
 * to BOTH, an outer edge to one.
 */
export interface BandHandle {
  key: string;
  label: string;
  /** Where the edge sits, in PDF points. */
  at: number;
  /** Which grid axis the edge belongs to — routes the validated adjustment. */
  axis: 'column' | 'row';
  left?: string;
  right?: string;
}

/**
 * The draggable edges of a column grid — one per BOUNDARY, not two per band.
 *
 * `centresToBands` makes bands contiguous, so `bands[i].end` and
 * `bands[i+1].start` are the same coordinate. Drawing a handle for each would
 * stack two identical hit targets: the later one always wins, so half of them
 * would be unreachable, and moving one band's edge alone would tear a gap in
 * the grid that a tick can land in and resolve to no column at all. An interior
 * boundary is therefore ONE handle that moves both bands together.
 */
export function columnHandles(bands: readonly GeometryBand[]): BandHandle[] {
  const sorted = [...bands].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const handles: BandHandle[] = [
    { key: `left-${first.key}`, label: `Drag the left edge of ${first.key}`, at: first.start, axis: 'column', right: first.key },
  ];
  for (let i = 0; i < sorted.length - 1; i++) {
    const l = sorted[i]!;
    const r = sorted[i + 1]!;
    handles.push({
      key: `between-${l.key}-${r.key}`,
      label: `Drag the boundary between ${l.key} and ${r.key}`,
      // Contiguous by construction; if a reviewer's earlier edit left a gap,
      // the handle sits on the left band's edge rather than in mid-air.
      at: l.end,
      axis: 'column',
      left: l.key,
      right: r.key,
    });
  }
  handles.push({
    key: `right-${last.key}`,
    label: `Drag the right edge of ${last.key}`,
    at: last.end,
    axis: 'column',
    left: last.key,
  });

  return handles;
}

/**
 * The draggable edges of a ROW grid — one per BOUNDARY, mirroring `columnHandles`.
 *
 * Row bands are contiguous in y exactly as column bands are in x
 * (`centresToBands` again), so the same "one handle per boundary, interior
 * boundary owns both bands" rule holds — drawing a handle per band edge would
 * stack two identical hit targets and let a reviewer tear a gap a tick can fall
 * into. `start`/`end` are the band's bottom/top y in PDF points (bottom-up), so
 * sorting by `start` runs the handles bottom-to-top and the outer handles are
 * the bottommost band's bottom edge and the topmost band's top edge.
 */
export function rowHandles(bands: readonly GeometryBand[]): BandHandle[] {
  const sorted = [...bands].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const handles: BandHandle[] = [
    { key: `bottom-${first.key}`, label: `Drag the bottom edge of ${first.key}`, at: first.start, axis: 'row', right: first.key },
  ];
  for (let i = 0; i < sorted.length - 1; i++) {
    const l = sorted[i]!;
    const r = sorted[i + 1]!;
    handles.push({
      key: `between-${l.key}-${r.key}`,
      label: `Drag the boundary between ${l.key} and ${r.key}`,
      // Contiguous by construction; if a reviewer's earlier edit left a gap,
      // the handle sits on the lower band's edge rather than in mid-air.
      at: l.end,
      axis: 'row',
      left: l.key,
      right: r.key,
    });
  }
  handles.push({
    key: `top-${last.key}`,
    label: `Drag the top edge of ${last.key}`,
    at: last.end,
    axis: 'row',
    left: last.key,
  });

  return handles;
}

/**
 * Which validated adjustment a handle maps to (KTD4).
 *
 * The routing mirrors the drag path in `ImportReviewScreen`'s `onBandEdge` and
 * the button path in `GeometryInspector` exactly: an interior boundary owns
 * BOTH adjacent bands and moves as one (`adjustGeometryBoundary`), while an
 * outer edge owns a single band's `start` or `end` (`adjustGeometryBand`).
 * Extracting it as a pure value is what lets a keyboard nudge and a pointer drag
 * be proven to resolve to the identical call, with no DOM.
 */
export type HandleAdjustment =
  | { kind: 'boundary'; leftKey: string; rightKey: string }
  | { kind: 'edge'; key: string; edge: 'start' | 'end' };

export function handleAdjustment(handle: BandHandle): HandleAdjustment | null {
  if (handle.left && handle.right) return { kind: 'boundary', leftKey: handle.left, rightKey: handle.right };
  if (handle.right) return { kind: 'edge', key: handle.right, edge: 'start' };
  if (handle.left) return { kind: 'edge', key: handle.left, edge: 'end' };
  return null;
}

/**
 * The coordinate a keyboard nudge moves a focused handle to (R1/AE1).
 *
 * The same `NUDGE_POINTS` step the stepper buttons use, so an arrow key and a
 * button click land the edge in the same place. The result is fed through the
 * SAME `onBandEdge` path the drag uses, so the shipped validator refuses an
 * inverting or overlapping nudge exactly as it refuses a drag or a step — no new
 * movement or validation path is introduced.
 */
export function nudgedEdge(handle: BandHandle, direction: -1 | 1, step = NUDGE_POINTS): number {
  return handle.at + direction * step;
}

/**
 * A representative mark per target cell of a grid, in PDF point space (R2/R3).
 *
 * Every row band × every column band, each placed by the shared `markPlacement`
 * — the exact function the exporter draws with — so the preview and the exported
 * PDF agree cell-for-cell and cannot drift (AE2/AE3). Empty when the segment
 * carries no rows or no columns, so a field with no grid renders nothing
 * (KTD5).
 */
export interface PreviewMark {
  /** Stable React key: `${rowKey}::${columnKey}`. */
  key: string;
  rowKey: string;
  columnKey: string;
  /** Mark origin/size in PDF points — identical to `markPlacement`. */
  x: number;
  y: number;
  size: number;
}

export function previewMarks(segment: PageBox): PreviewMark[] {
  const rows = segment.rowBands ?? [];
  const cols = segment.columnBands ?? [];
  const marks: PreviewMark[] = [];
  for (const row of rows) {
    for (const col of cols) {
      const { x, y, size } = markPlacement(row, col);
      marks.push({ key: `${row.key}::${col.key}`, rowKey: row.key, columnKey: col.key, x, y, size });
    }
  }
  return marks;
}

/** Pull a dragged coordinate onto the nearest printed edge, or leave it alone. */
export function snapEdge(value: number, targets: readonly number[], range = SNAP_RANGE): number {
  let best: number | null = null;
  for (const t of targets) {
    if (Math.abs(t - value) > range) continue;
    if (best === null || Math.abs(t - value) < Math.abs(best - value)) best = t;
  }
  return best ?? value;
}

/**
 * Vertical snap targets: the printed text baselines on a page (U1).
 *
 * The horizontal `snapTargets` gives the left/right edges a column-band drag
 * lands on; a hand-drawn box also needs to snap its TOP and BOTTOM, so this is
 * the y counterpart. `PositionedText` carries only a baseline y (no glyph
 * height), so a baseline is the one honest vertical anchor — a scalar value
 * prints on the same baseline as its printed label. Same NaN guard and
 * dedupe as `snapTargets`, for the same reason.
 */
export function snapTargetsY(items: readonly PositionedText[]): number[] {
  const ys: number[] = [];
  for (const item of items) {
    if (!Number.isFinite(item.y)) continue;
    ys.push(item.y);
  }
  ys.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const y of ys) {
    if (unique.length === 0 || y - unique[unique.length - 1]! > 0.5) unique.push(y);
  }
  return unique;
}

/**
 * Turn two dragged corners into a snapped, page-clamped box (U1).
 *
 * The pure core of draw-a-box: the component converts the pointer's two corners
 * from screen pixels into PDF points (flipping y, which is bottom-up in PDF
 * space) and hands them here. Precision is the U10 lesson — a free drag over a
 * scaled preview cannot resolve a 7-13pt column, so each edge snaps to the
 * text layer (`snapEdge`) and the pointer only has to get within range. The box
 * is normalised (an inverted drag is fine), clamped to the page, and returned
 * with NO bands: it is a scalar placement box, or the outer box a table's
 * subdivision (U4) will fill in.
 *
 * A snap is applied per axis only when it keeps the box non-degenerate —
 * snapping both edges of an axis onto one target would collapse it, so that
 * axis keeps the raw drag instead.
 */
export function snapDrawnBox(
  a: { x: number; y: number },
  b: { x: number; y: number },
  page: { page: number; pageWidth: number; pageHeight: number },
  xTargets: readonly number[],
  yTargets: readonly number[],
): PageBox {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  let left = clamp(Math.min(a.x, b.x), page.pageWidth);
  let right = clamp(Math.max(a.x, b.x), page.pageWidth);
  let bottom = clamp(Math.min(a.y, b.y), page.pageHeight);
  let top = clamp(Math.max(a.y, b.y), page.pageHeight);

  const sLeft = snapEdge(left, xTargets);
  const sRight = snapEdge(right, xTargets);
  if (sRight - sLeft >= 1) {
    left = sLeft;
    right = sRight;
  }
  const sBottom = snapEdge(bottom, yTargets);
  const sTop = snapEdge(top, yTargets);
  if (sTop - sBottom >= 1) {
    bottom = sBottom;
    top = sTop;
  }

  return {
    page: page.page,
    x: left,
    y: bottom,
    width: right - left,
    height: top - bottom,
    pageWidth: page.pageWidth,
    pageHeight: page.pageHeight,
  };
}

/** The panel state for a field, given what has been proposed and confirmed. */
export function panelState(
  field: Pick<FormField, 'type' | 'columns'>,
  proposal: PageBox | undefined,
  confirmed: boolean,
  derived: TableProposal | null,
): GeometryPanelState {
  const unsupported = unsupportedReason(field);
  if (unsupported) return { kind: 'unsupported', reason: unsupported };

  if (proposal) {
    return {
      kind: 'proposed',
      segment: proposal,
      confidence: derived?.confidence ?? 1,
      notes: derived?.notes ?? [],
      confirmed,
    };
  }

  // A non-table field has nothing to derive — its value prints in one place.
  // Offer the draw tool directly rather than the "derived grid" language a
  // table uses, so the copy only ever names the action actually available (R5).
  if (field.type !== 'repeating_group') {
    return {
      kind: 'draw-only',
      reason:
        'Draw a box on the PDF where this field’s value should print, then confirm it. Until you do, the form still publishes and exports this answer as data.',
    };
  }

  return {
    kind: 'no-proposal',
    reason:
      'The page did not give enough signal to place this table confidently, so nothing could be placed automatically. That is fine to leave — the form still publishes and exports its answers as data. (Hand placement is coming.)',
  };
}
