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
import type { PositionedText, TableProposal } from '../../../lib/pdf-geometry.js';
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
