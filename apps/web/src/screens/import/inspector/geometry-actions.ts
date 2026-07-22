/**
 * The decisions the geometry panel offers, as pure functions.
 *
 * Kept out of the component for the usual reason — the rules are testable and
 * the rendering is not — but also because these decide what a reviewer is
 * ALLOWED to confirm, and that is the guard standing between an AI-derived
 * grid and marks drawn onto a competency record. It belongs somewhere it can
 * be read and tested directly.
 */
import type { FormField, PageBox } from '@formai/shared';
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
