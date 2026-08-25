/**
 * The shared printed-square column evidence (U1/U2, R2/R3/R4/R6).
 *
 * `findRectColumns` is the column test `proposeRectGrid` already trusts,
 * extracted so the page-wide derivation measures columns identically;
 * `matchRectColumnsToGrid` is the marriage between those columns and a
 * text-derived grid — row alignment as the no-hands substitute for the drawn
 * box (KTD1).
 *
 * Fixtures are MEASURED, per this module's discipline. The square column is
 * the Mine Site SME cover's: 9×9pt at x=1231 on a 28.4pt pitch (already the
 * `pdf-geometry-rect-grid` fixture). The grid bands are the dozer page-7
 * derivation's own output values: option bands at [496.05, 511.7],
 * [511.7, 531.9], [531.9, 556.65] over row baselines 630.8 / 614 / 597.1 /
 * 580.3 — evenly-spaced synthetic data would not exercise a single real
 * irregularity.
 */
import { describe, expect, it } from 'vitest';
import type { GeometryBand } from '@formai/shared';
import { findRectColumns, matchRectColumnsToGrid } from './pdf-geometry.js';
import type { PrintedRect } from '../screens/import/inspector/geometry-actions.js';

/** The Mine Site SME method squares: 9pt sides, x=1231, 28.4pt pitch. */
function methodSquares(count = 5, dy = 0): PrintedRect[] {
  return Array.from({ length: count }, (_, i) => ({
    x: 1231,
    y: 760 - dy - i * 28.4,
    width: 9,
    height: 9,
  }));
}

describe('findRectColumns — the column test, extracted (U1)', () => {
  it('separates checkboxes from the ruled cells around them into two columns', () => {
    // A bordered table prints both: the 9pt squares and the row cells around
    // them. Different x, different size — two groups, both real columns, and
    // WHICH one a grid trusts is the marriage's decision, not this helper's.
    const cells: PrintedRect[] = [0, 1, 2, 3, 4].map((i) => ({
      x: 438,
      y: 752 - i * 28.4,
      width: 839,
      height: 28,
    }));

    const columns = findRectColumns([...cells, ...methodSquares()]);

    expect(columns).toHaveLength(2);
    expect(columns.map((c) => c.length)).toEqual([5, 5]);
  });

  it('drops a group whose members are not one repeated control', () => {
    // A checkbox and the cell it sits in can share a left edge on a
    // tightly-set table; only size tells them apart, and a mixed group is not
    // a column of anything.
    const mixed: PrintedRect[] = [
      { x: 1231, y: 760, width: 9, height: 9 },
      { x: 1231, y: 731.6, width: 9, height: 9 },
      { x: 1231, y: 703.2, width: 40, height: 20 },
    ];

    expect(findRectColumns(mixed)).toEqual([]);
  });

  it('drops a run of fewer than three — a pair is a coincidence, not a column', () => {
    expect(findRectColumns(methodSquares(2))).toEqual([]);
  });

  it('returns each column top-down, the order a reader assigns rows in', () => {
    const [column] = findRectColumns([...methodSquares()].reverse());

    const ys = column!.map((r) => r.y);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
  });

  it('splits one x-run at a gap outlier into two candidate columns (R3)', () => {
    // Two stacked five-row checklists share an x: ten squares in one run, with
    // the between-tables clearance a multiple of the 28.4pt pitch. Page-wide
    // there is no drawn box to keep them apart, so the gap is the scoping.
    const stacked = [...methodSquares(5), ...methodSquares(5, 300)];

    const columns = findRectColumns(stacked, { splitOnRowGap: true });

    expect(columns).toHaveLength(2);
    expect(columns.map((c) => c.length)).toEqual([5, 5]);
    // The first fragment is the upper checklist, intact.
    expect(columns[0]![0]).toEqual({ x: 1231, y: 760, width: 9, height: 9 });
    expect(columns[1]![0]).toEqual({ x: 1231, y: 460, width: 9, height: 9 });
  });

  it('does not split an evenly-pitched column', () => {
    // Nine squares on the measured pitch: every gap is the same, there is no
    // outlier jump, and a false split would cost a real checklist.
    const columns = findRectColumns(methodSquares(9), { splitOnRowGap: true });

    expect(columns).toHaveLength(1);
    expect(columns[0]).toHaveLength(9);
  });

  it('re-checks each fragment against the minimum after splitting', () => {
    // Five squares plus a lone straggler far below: the split leaves a
    // fragment of one, which is not a column and adds no noise.
    const columns = findRectColumns([...methodSquares(5), ...methodSquares(1, 300)], {
      splitOnRowGap: true,
    });

    expect(columns).toHaveLength(1);
    expect(columns[0]).toHaveLength(5);
  });

  it('keeps the split OFF by default — the drawn-box path scopes with the drag instead (R2)', () => {
    const stacked = [...methodSquares(5), ...methodSquares(5, 300)];

    const columns = findRectColumns(stacked);

    expect(columns).toHaveLength(1);
    expect(columns[0]).toHaveLength(10);
  });
});

/**
 * The dozer page-7 grid as the derivation itself emits it: option bands from
 * the measured anchor centres (tick 506.15, cross 517.25, N/A 546.55), row
 * bands from the four printed baselines under the header at y=647.7.
 */
const DOZER_COLUMN_BANDS: GeometryBand[] = [
  { key: 'tick', start: 496.05, end: 511.7 },
  { key: 'cross', start: 511.7, end: 531.9 },
  { key: 'na', start: 531.9, end: 556.65 },
];

const DOZER_ROW_BANDS: GeometryBand[] = [
  { key: 'r0', start: 622.4, end: 647.7 },
  { key: 'r1', start: 605.55, end: 622.4 },
  { key: 'r2', start: 588.7, end: 605.55 },
  { key: 'r3', start: 571.9, end: 588.7 },
];

/** A 9pt square column under one option band, one square per printed row. */
function squaresAt(x: number, size = 9): PrintedRect[] {
  // y = baseline - 6 puts the square's centre 1.5pt under the baseline —
  // where a printed checkbox actually sits beside its row's text.
  return [630.8, 614, 597.1, 580.3].map((baseline) => ({
    x,
    y: baseline - 6,
    width: size,
    height: size,
  }));
}

describe('matchRectColumnsToGrid — rows scope, bands assign (U2)', () => {
  it('bijects three square columns onto a three-column grid', () => {
    const columns = [squaresAt(502), squaresAt(513), squaresAt(540)];

    const { matched, conflicting } = matchRectColumnsToGrid(
      columns,
      DOZER_ROW_BANDS,
      DOZER_COLUMN_BANDS,
    );

    expect(conflicting).toBe(false);
    expect([...matched.keys()].sort()).toEqual(['cross', 'na', 'tick']);
    expect(matched.get('tick')![0]).toEqual({ x: 502, y: 624.8, width: 9, height: 9 });
  });

  it('the checkbox beats the ruled cell contending for the same band, by area', () => {
    // A bordered answer column prints both: the square, and the cell drawn
    // around it, row-aligned exactly as well. The smaller control wins —
    // `proposeRectGrid`'s own tie-break, "the cell is furniture around the
    // control" — and the loser is furniture, not a conflict.
    const cells = squaresAt(498, 16);
    const columns = [cells, squaresAt(502), squaresAt(513), squaresAt(540)];

    const { matched, conflicting } = matchRectColumnsToGrid(
      columns,
      DOZER_ROW_BANDS,
      DOZER_COLUMN_BANDS,
    );

    expect(conflicting).toBe(false);
    expect(matched.get('tick')![0]!.width).toBe(9);
  });

  it('ignores a column whose square count disagrees with the row count (KTD1)', () => {
    // Ten squares never corroborate a four-row table — that column belongs to
    // another table, which is exactly what row alignment exists to say.
    const tenRows: PrintedRect[] = Array.from({ length: 10 }, (_, i) => ({
      x: 502,
      y: 624.8 - i * 16.8,
      width: 9,
      height: 9,
    }));

    const { matched, conflicting } = matchRectColumnsToGrid(
      [tenRows],
      DOZER_ROW_BANDS,
      DOZER_COLUMN_BANDS,
    );

    expect(conflicting).toBe(false);
    expect(matched.size).toBe(0);
  });

  it('reports conflict when only two columns row-align for three declared bands', () => {
    const { matched, conflicting } = matchRectColumnsToGrid(
      [squaresAt(502), squaresAt(513)],
      DOZER_ROW_BANDS,
      DOZER_COLUMN_BANDS,
    );

    expect(conflicting).toBe(true);
    // Partial snapping is refused outright — half-measured columns would mix
    // evidence regimes inside one grid.
    expect(matched.size).toBe(0);
  });

  it('reports conflict when a row-aligned column sits outside every band', () => {
    // 60pt left of the tick band: the page prints a real square column on
    // these rows, and it disagrees with where the header says the columns are.
    // That is a signal for the reviewer, never a tiebreak.
    const { conflicting } = matchRectColumnsToGrid(
      [squaresAt(436), squaresAt(513), squaresAt(540)],
      DOZER_ROW_BANDS,
      DOZER_COLUMN_BANDS,
    );

    expect(conflicting).toBe(true);
  });

  it('a column landing two squares in one row does not qualify', () => {
    // Four squares over four rows, but two share the top row's band and no
    // square reaches the third row — the one-per-row pairing fails, so the
    // column is not this table's evidence.
    const twoPerRow: PrintedRect[] = [
      { x: 502, y: 628, width: 9, height: 9 },
      { x: 502, y: 624.8, width: 9, height: 9 },
      { x: 502, y: 608, width: 9, height: 9 },
      { x: 502, y: 574.3, width: 9, height: 9 },
    ];

    const { matched, conflicting } = matchRectColumnsToGrid(
      [twoPerRow],
      DOZER_ROW_BANDS,
      DOZER_COLUMN_BANDS,
    );

    expect(conflicting).toBe(false);
    expect(matched.size).toBe(0);
  });
});
