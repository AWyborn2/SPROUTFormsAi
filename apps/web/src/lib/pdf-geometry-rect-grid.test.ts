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
import type { PageBox, RepeatingColumn } from '@formai/shared';
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

/** The table as extracted: a label column and one answer column. */
const COLUMNS: RepeatingColumn[] = [
  { key: 'method', label: 'Method', type: 'text' },
  { key: 'used', label: 'Used', type: 'check_cross' },
];

const outcome = (
  rects: readonly PrintedRect[] | undefined,
  within: PageBox = drawn,
  columns: readonly RepeatingColumn[] | undefined = COLUMNS,
) => proposeRectGrid({ page: 0, ...PAGE, rects, within, columns });

/** The measured grid, or `null` when it refused — for the happy-path tests. */
const propose = (rects: readonly PrintedRect[], within: PageBox = drawn) => {
  const result = outcome(rects, within);
  return result.ok ? result.proposal : null;
};

/** The refusal code, or `null` when it measured a grid. */
const refusal = (
  rects: readonly PrintedRect[] | undefined,
  within: PageBox = drawn,
  columns: readonly RepeatingColumn[] | undefined = COLUMNS,
) => {
  const result = outcome(rects, within, columns);
  return result.ok ? null : result.code;
};

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

  it('takes a checkbox the drag ran THROUGH rather than around', () => {
    /*
      FULL ENCLOSURE WAS UNUSABLE AT THIS SCALE. A checkbox is 9pt, and a
      hand-drawn box around a column of them clips one by a fraction of a point
      almost every time — each clipped box silently dropped out, and the
      reported result was "Only 0 printed boxes sit fully inside what you drew"
      from a drag visibly covering five of them.
    */
    // Runs THROUGH the squares on every side: 2pt inside their left and right
    // edges, and ending between the top and bottom rows' outer edges. Under
    // full enclosure this selected nothing at all.
    const tight: PageBox = { page: 0, x: 1233, y: 648, width: 5, height: 118, ...PAGE };

    expect(propose(methodBoxes, tight)?.segment.rowBands).toHaveLength(5);
  });

  it('still scopes to the drag — a table further down is not swept in', () => {
    // The centre test keeps what enclosure was there for: a checkbox belonging
    // to the next table has its centre well outside this drag.
    const below: PrintedRect[] = [0, 1, 2].map((i) => ({
      x: 1231,
      y: 400 - i * 28.4,
      width: 9,
      height: 9,
    }));

    expect(propose([...methodBoxes, ...below])?.segment.rowBands).toHaveLength(5);
  });

  it('picks the checkboxes over the cells when both columns are the same length', () => {
    /*
      A bordered table yields two columns of EXACTLY the same length — the
      checkboxes and the ruled cells around each row. Tie-breaking by document
      order picks whichever has the lower x, which is the cell, so every mark
      would be centred in the whole row instead of in the printed square: a grid
      that looks right and is wrong by an inch.
    */
    const cells: PrintedRect[] = [0, 1, 2, 3, 4].map((i) => ({
      x: 438,
      y: 748 - i * 28.4,
      width: 839,
      height: 26,
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
    expect(refusal(methodBoxes.slice(0, 2))).toBe('too-few-boxes');
  });

  it('refuses boxes of different sizes', () => {
    // A checkbox and the cell it sits in can share a left edge on a tightly-set
    // table; only size tells them apart.
    const mixed = [
      { x: 1231, y: 760, width: 9, height: 9 },
      { x: 1231, y: 731, width: 9, height: 9 },
      { x: 1231, y: 703, width: 40, height: 20 },
    ];

    expect(refusal(mixed)).toBe('boxes-differ-in-size');
  });

  it('refuses boxes that do not share an x', () => {
    const scattered = [
      { x: 1231, y: 760, width: 9, height: 9 },
      { x: 1100, y: 731, width: 9, height: 9 },
      { x: 900, y: 703, width: 9, height: 9 },
    ];

    expect(refusal(scattered)).toBe('boxes-not-in-a-column');
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
    expect(refusal([])).toBe('too-few-boxes');
  });

  /*
    EVERY REFUSAL NAMES ITSELF, because a refusal and a success used to look
    identical: both left a box on the page, one subdivided and one not, with
    nothing saying which had happened. An author who cannot tell "I drew it
    wrong" from "this table's columns are wrong" redraws the same box until
    they conclude the feature is broken.
  */
  describe('refusals say what is wrong', () => {
    it('names a table with no answer column, which no redrawing can fix', () => {
      /*
        The exporter writes a row's mark with `columnBandFor(segment, columnKey)`
        and draws NOTHING when that misses. A band keyed to a column the field
        does not declare is a band no mark ever lands in — placed, plausible on
        screen, silently absent from the exported page. The fix is the table's
        columns, not the drawing, so it is its own code.
      */
      expect(refusal(methodBoxes, drawn, [{ key: 'method', label: 'Method', type: 'text' }])).toBe(
        'no-answer-column',
      );
      expect(refusal(methodBoxes, drawn, [])).toBe('no-answer-column');
      // Called directly: a DEFAULT PARAMETER swallows an explicit `undefined`,
      // so routing this through the helper would silently test `COLUMNS` again
      // and pass without ever exercising the undefined path.
      const noColumns = proposeRectGrid({
        page: 0,
        ...PAGE,
        rects: methodBoxes,
        within: drawn,
        columns: undefined,
      });
      expect(noColumns.ok).toBe(false);
      if (!noColumns.ok) expect(noColumns.code).toBe('no-answer-column');
    });

    it('refuses rather than guessing which of several answer columns is meant', () => {
      const three: RepeatingColumn[] = [
        { key: 'method', label: 'Method', type: 'text' },
        { key: 'yes', label: 'Yes', type: 'check_cross' },
        { key: 'no', label: 'No', type: 'check_cross' },
      ];

      expect(refusal(methodBoxes, drawn, three)).toBe('ambiguous-answer-column');
    });

    it('distinguishes a page that was never measured from one with no boxes', () => {
      // Absent is NOT MEASURED. Reporting it as "no boxes found" would send an
      // author looking at their drag for a fault that is in the page read.
      expect(refusal(undefined)).toBe('page-not-measured');
      expect(refusal([])).toBe('too-few-boxes');
    });

    it('carries a sentence an author can act on, not just a code', () => {
      const result = outcome(methodBoxes, drawn, [{ key: 'method', label: 'Method', type: 'text' }]);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail).toMatch(/structure step/i);
    });
  });
});

/**
 * The per-row fallback — one hand-drawn box IS one row's cell, stored with the
 * printed row named EXPLICITLY on the band key so a partly-placed table can
 * never shift marks onto the rows below a gap.
 */
describe('proposeRowCell', () => {
  const box: PageBox = { page: 0, x: 1228, y: 730, width: 15, height: 12, ...PAGE };

  it('builds a one-band segment keyed to the printed row', async () => {
    const { proposeRowCell, rowCellIndex } = await import('./pdf-geometry.js');
    const result = proposeRowCell({ box, rowIndex: 3, columns: COLUMNS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segment.rowBands).toEqual([{ key: 'row:3', start: 730, end: 742 }]);
    expect(result.segment.columnBands).toEqual([{ key: 'used', start: 1228, end: 1243 }]);
    expect(rowCellIndex(result.segment)).toBe(3);
  });

  it('refuses a table with no answer column, with a sentence an author can act on', async () => {
    const { proposeRowCell } = await import('./pdf-geometry.js');
    const result = proposeRowCell({
      box,
      rowIndex: 0,
      columns: [{ key: 'method', label: 'Method', type: 'text' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/structure step/i);
  });

  it('refuses two answer columns rather than guessing which printed cell the box is', async () => {
    const { proposeRowCell } = await import('./pdf-geometry.js');
    const three: RepeatingColumn[] = [
      ...COLUMNS,
      { key: 'na', label: 'N/A', type: 'check_cross' },
    ];

    expect(proposeRowCell({ box, rowIndex: 0, columns: three }).ok).toBe(false);
  });

  it('a whole-grid segment is not a row cell', async () => {
    const { proposeRectGrid, rowCellIndex } = await import('./pdf-geometry.js');
    const grid = proposeRectGrid({ page: 0, ...PAGE, rects: methodBoxes, within: drawn, columns: COLUMNS });

    expect(grid.ok).toBe(true);
    if (grid.ok) expect(rowCellIndex(grid.proposal.segment)).toBeNull();
  });
});

/**
 * Manual division — the author's say-so, for a page whose printed shapes
 * cannot be measured. Equal rows seeded from an explicit act, every edge
 * draggable afterwards; nothing here is inferred from the page.
 */
describe('proposeManualGrid', () => {
  const box: PageBox = { page: 7, x: 500, y: 600, width: 120, height: 120, ...PAGE };

  it('divides the drawn box into equal rows, top-down, spanning the answer column', async () => {
    const { proposeManualGrid } = await import('./pdf-geometry.js');
    const result = proposeManualGrid({ box, rows: 4, columns: COLUMNS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segment.page).toBe(7);
    expect(result.segment.rowBands).toHaveLength(4);
    // r1 is the TOP row — the printed order the measured path also uses.
    expect(result.segment.rowBands![0]).toEqual({ key: 'r1', start: 690, end: 720 });
    expect(result.segment.rowBands![3]).toEqual({ key: 'r4', start: 600, end: 630 });
    expect(result.segment.columnBands).toEqual([{ key: 'used', start: 500, end: 620 }]);
  });

  it('splits the width evenly across multiple answer columns, keyed in order', async () => {
    const { proposeManualGrid } = await import('./pdf-geometry.js');
    const three: RepeatingColumn[] = [
      ...COLUMNS,
      { key: 'na', label: 'N/A', type: 'check_cross' },
    ];
    const result = proposeManualGrid({ box, rows: 2, columns: three });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segment.columnBands).toEqual([
      { key: 'used', start: 500, end: 560 },
      { key: 'na', start: 560, end: 620 },
    ]);
  });

  it('refuses a table with no answer column', async () => {
    const { proposeManualGrid } = await import('./pdf-geometry.js');
    const result = proposeManualGrid({
      box,
      rows: 3,
      columns: [{ key: 'method', label: 'Method', type: 'text' }],
    });

    expect(result.ok).toBe(false);
  });

  it('refuses a row count that is not a whole positive number', async () => {
    const { proposeManualGrid } = await import('./pdf-geometry.js');

    expect(proposeManualGrid({ box, rows: 0, columns: COLUMNS }).ok).toBe(false);
    expect(proposeManualGrid({ box, rows: 2.5, columns: COLUMNS }).ok).toBe(false);
    expect(proposeManualGrid({ box, rows: Number.NaN, columns: COLUMNS }).ok).toBe(false);
  });
});
