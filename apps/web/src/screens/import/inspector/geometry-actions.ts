/**
 * The decisions the geometry panel offers, as pure functions.
 *
 * Kept out of the component for the usual reason — the rules are testable and
 * the rendering is not — but also because these decide what a reviewer is
 * ALLOWED to confirm, and that is the guard standing between an AI-derived
 * grid and marks drawn onto a competency record. It belongs somewhere it can
 * be read and tested directly.
 */
import type { FormField, GeometryBand, PageBox } from '@formai/shared';
import { markPlacement } from '@formai/shared';
import type { PositionedText, TableProposal, TextPage } from '../../../lib/pdf-geometry.js';
import { proposeTableSegments } from '../../../lib/pdf-geometry.js';

/** What the panel should show for the selected field. */
export type GeometryPanelState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'no-proposal'; reason: string }
  | { kind: 'proposed'; segment: PageBox; confidence: number; notes: string[]; confirmed: boolean };

/**
 * Derive a proposal for one field from a page's text.
 *
 * Returns the best proposal only. A page carries several tables and the
 * derivation cannot say which belongs to *this* field — so it picks the
 * proposal whose row count is closest to the field's own row count, and where
 * that is unknowable, the highest-confidence one. The reviewer confirms or
 * rejects either way, which is why a wrong pick is recoverable and a silent
 * one would not be.
 */
export function deriveForField(
  field: Pick<FormField, 'type' | 'columns' | 'fixedRows'>,
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

  const wantRows = field.fixedRows?.length;
  if (wantRows === undefined) {
    return proposals.reduce((best, p) => (p.confidence > best.confidence ? p : best));
  }

  return proposals.reduce((best, p) => {
    const d = Math.abs((p.segment.rowBands?.length ?? 0) - wantRows);
    const bestD = Math.abs((best.segment.rowBands?.length ?? 0) - wantRows);
    if (d !== bestD) return d < bestD ? p : best;
    return p.confidence > best.confidence ? p : best;
  });
}

/**
 * Derive a proposal for one field across EVERY page.
 *
 * A table extracted by the model carries no `sourcePosition` — only AcroForm
 * fields get one — so there is no page to start from, and deriving against
 * page 0 would silently place an eighteen-page assessment's table on its cover
 * sheet. Every page is tried and the best single proposal wins, by the same
 * rule `deriveForField` uses within one page: closest row count first, then
 * confidence. Ties keep the earlier page, so a table split across a page break
 * anchors to where it starts.
 */
export function deriveAcrossPages(
  field: Pick<FormField, 'type' | 'columns' | 'fixedRows'>,
  pages: readonly TextPage[],
): TableProposal | null {
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

/** Why a field cannot carry a derived grid at all. */
export function unsupportedReason(
  field: Pick<FormField, 'type' | 'columns'>,
): string | null {
  if (field.type !== 'repeating_group') {
    return 'Only a table can carry a column grid. Other fields export at their own position.';
  }
  if (!field.columns || field.columns.length < 2) {
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
    { key: `left-${first.key}`, label: `Drag the left edge of ${first.key}`, at: first.start, right: first.key },
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
      left: l.key,
      right: r.key,
    });
  }
  handles.push({
    key: `right-${last.key}`,
    label: `Drag the right edge of ${last.key}`,
    at: last.end,
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

  return {
    kind: 'no-proposal',
    reason:
      'The page did not give enough signal to place this table confidently, so nothing is proposed. Draw the grid by hand, or leave it — the form still publishes and exports its answers as data.',
  };
}
