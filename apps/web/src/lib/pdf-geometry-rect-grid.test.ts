/**
 * A repeating table's grid, measured from the checkboxes printed inside it.
 *
 * WHY TEXT DERIVATION CANNOT DO THIS. `proposeTableSegments` finds columns from
 * header glyphs and rows from label baselines. A checkbox column has neither:
 * "Observation/Practical Demonstration ☐" puts every glyph in the label and
 * nothing at all in the answer column. So the derivation that exists places a
 * band where the words stop — wherever the longest label happened to end.
 *
 * The reported symptom, on the Mine Site SME cover page's "Methods used to
 * assess competence": five methods, one tall undivided box, and no way to know
 * whether a mark would land in a printed square or beside it. The exporter
 * draws into "the answered column of each row", so with no bands there is no
 * row and no column to draw into.
 *
 * One band per printed square is not an inference. It is where the square is.
 *
 * Coordinates below are the real table: five rows on ~28.4pt pitch, each with a
 * 9pt checkbox at x≈1231 in the right-hand column, inside a table running from
 * x≈438 to x≈1277.
 */
import { describe, expect, it } from 'vitest';
import type { PageBox } from '@formai/shared';
import { proposeRectGrid } from './pdf-geometry.js';
import type { PrintedRect } from '../screens/import/inspector/geometry-actions.js';

const PAGE = { pageWidth: 1400, pageHeight: 990 };

/** The five method checkboxes, top row first as they print. */
const methodBoxes: PrintedRect[] = [0, 1, 2, 3, 4].map((i) => ({
  x: 1231,
  y: 760 - i * 28.4,
  width: 9,
  height: 9,
}));

/** The author's drag around the whole methods block. */
const drawn: PageBox = {
  page: 0,
  x: 438,
  y: 640,
  width: 839,
  height: 140,
  ...PAGE,
};

const propose = (rects: readonly PrintedRect[], within: PageBox = drawn) =>
  proposeRectGrid({ page: 0, ...PAGE, rects, within, columnKey: 'used' });

describe('proposeRectGrid', () => {
  it('gives one row band per printed checkbox', () => {
    const p = propose(methodBoxes);

    expect(p?.segment.rowBands).toHaveLength(5);
  });

  it('puts each band exactly on its checkbox', () => {
    // The whole point: the band IS the square's extent, so a mark centred in
    // the band is a mark centred in the printed box.
    const bands = propose(methodBoxes)!.segment.rowBands!;

    expect(bands[0]).toEqual({ key: 'r1', start: 760, end: 769 });
    expect(bands[4]).toEqual({ key: 'r5', start: 760 - 4 * 28.4, end: 769 - 4 * 28.4 });
  });

  it('orders rows top-down, as a reader assigns them', () => {
    // PDF y grows upward, so sorting ascending would number the bottom method
    // "row 1" and mark the wrong line on every submission.
    const bands = propose([...methodBoxes].reverse())!.segment.rowBands!;
    const starts = bands.map((b) => b.start);

    expect(starts).toEqual([...starts].sort((a, b) => b - a));
  });

  it('puts the column band on the checkboxes, not where the text stops', () => {
    const cols = propose(methodBoxes)!.segment.columnBands!;

    expect(cols).toEqual([{ key: 'used', start: 1231, end: 1240 }]);
  });

  it('reports full confidence and nothing inferred', () => {
    // Every band is a measured extent. There is no guess in this proposal, and
    // the reviewer's confirm gate should not imply otherwise.
    const p = propose(methodBoxes)!;

    expect(p.confidence).toBe(1);
    expect(p.anchorsInferred).toBe(0);
    expect(p.anchorsLocated).toBe(5);
  });

  it('keeps the author’s left edge so the rows stay identifiable', () => {
    // Narrowing the box to the checkbox column would leave five bands floating
    // beside the labels they belong to, unreadable on screen.
    expect(propose(methodBoxes)!.segment.x).toBe(438);
  });

  it('ignores the ruled cells around the rows', () => {
    /*
      A drag over a bordered table encloses the checkboxes AND the cell
      rectangles. They neither share the checkboxes' x nor their size, so
      grouping separates them and the size test rejects the cell group. Mixing
      the two would put some row bands on squares and some on whole cells.
    */
    const cells: PrintedRect[] = [0, 1, 2, 3, 4].map((i) => ({
      x: 438,
      y: 752 - i * 28.4,
      width: 839,
      height: 28,
    }));

    const bands = propose([...cells, ...methodBoxes])!.segment.rowBands!;

    expect(bands).toHaveLength(5);
    expect(bands[0]!.end - bands[0]!.start).toBeCloseTo(9, 5);
  });

  it('refuses a stray box on the far side of the page', () => {
    // Only the column is taken, so a lone rectangle elsewhere cannot drag the
    // band across the row. Here it is simply not in the winning group.
    const cols = propose([...methodBoxes, { x: 600, y: 700, width: 9, height: 9 }])!
      .segment.columnBands!;

    expect(cols[0]).toEqual({ key: 'used', start: 1231, end: 1240 });
  });

  it('refuses two checkboxes — a pair is a coincidence, not a column', () => {
    expect(propose(methodBoxes.slice(0, 2))).toBeNull();
  });

  it('refuses boxes of different sizes', () => {
    // A checkbox and the cell it sits in can share a left edge on a tightly-set
    // table; only size tells them apart.
    const mixed = [
      { x: 1231, y: 760, width: 9, height: 9 },
      { x: 1231, y: 731, width: 9, height: 9 },
      { x: 1231, y: 703, width: 40, height: 20 },
    ];

    expect(propose(mixed)).toBeNull();
  });

  it('refuses boxes that do not share an x', () => {
    const scattered = [
      { x: 1231, y: 760, width: 9, height: 9 },
      { x: 1100, y: 731, width: 9, height: 9 },
      { x: 900, y: 703, width: 9, height: 9 },
    ];

    expect(propose(scattered)).toBeNull();
  });

  it('takes only what the drawn box fully encloses', () => {
    /*
      BOUNDED SUBDIVISION (KTD4/R7). The drag is the corroboration that scopes
      detection to one table, so two structurally identical tables on a page
      cannot bleed into each other. A checkbox clipped by the edge of the drag
      belongs to whatever is outside it.
    */
    const below: PrintedRect[] = [0, 1, 2].map((i) => ({
      x: 1231,
      y: 560 - i * 28.4,
      width: 9,
      height: 9,
    }));

    expect(propose([...methodBoxes, ...below])!.segment.rowBands).toHaveLength(5);
  });

  it('refuses when the page carried no rectangles', () => {
    // Absent is NOT MEASURED. Refusing is what leaves the plain drawn box in
    // place rather than inventing a grid over it.
    expect(propose([])).toBeNull();
  });
});
