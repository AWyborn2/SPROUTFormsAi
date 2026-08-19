/**
 * Printed rectangles — the shapes rule-line extraction is built to discard.
 *
 * `rulesFromSegments` keeps only segments at least 18pt long, reasoning that
 * nothing shorter could be a grid line. True, and it also throws away every
 * CHECKBOX on the page: a printed checkbox is 8–10pt a side, so all four of its
 * edges fail the test. The one shape an author most often traces was invisible
 * to the snapper.
 *
 * The visible failure, on the real Mine Site SME cover page: trace the
 * prerequisite checkbox — a ~10pt square centred in a ~28pt table row — and both
 * horizontal edges snap out to the row's borders, because after the 18pt filter
 * those are the only targets within `RULE_SNAP_RANGE`. A perfect square goes in
 * and a full-row-height rectangle comes out.
 *
 * Length is the wrong question. A letter stroke and a checkbox side are the same
 * length; only one of them closes on itself. These tests pin that distinction.
 */
import { describe, expect, it } from 'vitest';
import {
  RECT_TRACE_MIN_OVERLAP,
  axisSnapRange,
  rectFromSubpath,
  rectTraced,
  segmentsFromDrawOps,
  snapDrawnBox,
  subpathsFromDrawOps,
  DRAW_SNAP_RANGE,
  RULE_SNAP_RANGE,
  type DrawSegment,
  type PrintedRect,
} from './geometry-actions.js';

const seg = (x1: number, y1: number, x2: number, y2: number): DrawSegment => ({ x1, y1, x2, y2 });

/** The four sides of an axis-aligned rectangle, drawn as a closed path would. */
const boxSides = (x: number, y: number, w: number, h: number): DrawSegment[] => [
  seg(x, y, x + w, y),
  seg(x + w, y, x + w, y + h),
  seg(x + w, y + h, x, y + h),
  seg(x, y + h, x, y),
];

// pdf.js `DrawOPS`, as `segmentsFromDrawOps` reads them.
const MOVE = 0;
const LINE = 1;
const CURVE = 2;
const CLOSE = 4;

describe('subpathsFromDrawOps', () => {
  it('keeps each closed shape separate', () => {
    // Two checkboxes in one constructPath — the common case for a column of
    // them. Flattened, they are eight anonymous short segments; grouped, they
    // are two recognisable squares.
    const subpaths = subpathsFromDrawOps([
      MOVE, 0, 0, LINE, 10, 0, LINE, 10, 10, LINE, 0, 10, CLOSE,
      MOVE, 0, 40, LINE, 10, 40, LINE, 10, 50, LINE, 0, 50, CLOSE,
    ]);

    expect(subpaths).toHaveLength(2);
    expect(subpaths[0]).toHaveLength(4);
    expect(subpaths[1]).toHaveLength(4);
  });

  it('is exactly what segmentsFromDrawOps flattens', () => {
    /*
      The two must never drift: rule extraction reads the flat list and
      rectangle detection reads the grouped one, off the same page, and a
      difference between them would be a shape that snaps one way and reports
      another.
    */
    const ops = [MOVE, 0, 0, LINE, 10, 0, LINE, 10, 10, CLOSE, MOVE, 50, 50, LINE, 90, 50];

    expect(subpathsFromDrawOps(ops).flat()).toEqual(segmentsFromDrawOps(ops));
  });

  it('advances the cursor through a curve without emitting a segment', () => {
    // A grid is never a curve, but a page is full of them; the cursor still has
    // to land on the curve's end point or every following segment is wrong.
    const subpaths = subpathsFromDrawOps([MOVE, 0, 0, CURVE, 1, 1, 2, 2, 30, 30, LINE, 30, 60]);

    expect(subpaths).toEqual([[seg(30, 30, 30, 60)]]);
  });
});

describe('rectFromSubpath', () => {
  it('recognises a checkbox far too small to be a rule', () => {
    // 9pt a side — under the 18pt rule floor on every edge, which is exactly
    // why this cannot be found by measuring lengths.
    expect(rectFromSubpath(boxSides(100, 700, 9, 9))).toEqual({
      x: 100,
      y: 700,
      width: 9,
      height: 9,
    });
  });

  it('recognises a full table cell too', () => {
    // Size is not judged here. A traced cell is as legitimate a target as a
    // traced checkbox; which one the author meant is decided by overlap.
    expect(rectFromSubpath(boxSides(31, 690, 190, 28))).toEqual({
      x: 31,
      y: 690,
      width: 190,
      height: 28,
    });
  });

  it('ignores a zero-length closing segment', () => {
    // A producer that writes an explicit closing lineTo and then a closePath
    // leaves a fifth, degenerate side. Real output, and not a reason to refuse.
    const sides = [...boxSides(100, 700, 9, 9), seg(100, 700, 100, 700)];

    expect(rectFromSubpath(sides)).toEqual({ x: 100, y: 700, width: 9, height: 9 });
  });

  it('refuses an open three-sided path', () => {
    expect(rectFromSubpath(boxSides(100, 700, 9, 9).slice(0, 3))).toBeNull();
  });

  it('refuses a diagonal', () => {
    // A tick mark is two diagonals. It must never become a snap target — it is
    // the thing written IN the box, not the box.
    const sides = [seg(0, 0, 10, 0), seg(10, 0, 15, 8), seg(15, 8, 5, 8), seg(5, 8, 0, 0)];

    expect(rectFromSubpath(sides)).toBeNull();
  });

  it('refuses four axis-aligned sides that do not close into a rectangle', () => {
    /*
      TWO HORIZONTALS AND TWO VERTICALS IS NOT ENOUGH. This zigzag satisfies
      every count and orientation test and still draws nothing rectangular; its
      bounding box is a shape nobody printed, and snapping a trace to it would
      place a mark on blank paper.
    */
    const sides = [seg(0, 0, 10, 0), seg(10, 0, 10, 10), seg(10, 10, 20, 10), seg(20, 10, 20, 20)];

    expect(rectFromSubpath(sides)).toBeNull();
  });

  it('refuses a degenerate rectangle with no area', () => {
    const sides = [seg(0, 0, 10, 0), seg(10, 0, 10, 0), seg(10, 0, 0, 0), seg(0, 0, 0, 0)];

    expect(rectFromSubpath(sides)).toBeNull();
  });

  it('tolerates a hairline wobble in the coordinates', () => {
    // Real path data carries rounding; a side 0.2pt off vertical is vertical.
    const sides = [
      seg(100, 700, 109, 700.1),
      seg(109, 700.1, 109.2, 709),
      seg(109.2, 709, 100.1, 709),
      seg(100.1, 709, 100, 700),
    ];

    expect(rectFromSubpath(sides)).not.toBeNull();
  });
});

describe('rectTraced', () => {
  // The real geometry: a 9pt checkbox centred in a 190×28pt table cell.
  const checkbox: PrintedRect = { x: 196, y: 699, width: 9, height: 9 };
  const cell: PrintedRect = { x: 31, y: 690, width: 190, height: 28 };

  it('picks the checkbox a rough trace of it covers, not the cell around it', () => {
    /*
      THE WHOLE BUG, IN ONE ASSERTION. The author traced the little square. The
      cell contains their drag entirely, so any "is the drag inside this shape"
      test picks the cell — which is how a square became a full-height
      rectangle. Overlap answers the right question: the drag accounts for
      almost all of the checkbox and a fraction of the cell.
    */
    const drag = { x: 195, y: 698, width: 11, height: 11 };

    expect(rectTraced(drag, [cell, checkbox])).toEqual(checkbox);
  });

  it('returns the printed size, not the drawn one', () => {
    // The point of matching a whole rectangle: the box comes back at the size
    // the page prints it, with none of the hand's error carried forward.
    const sloppy = { x: 194, y: 697.5, width: 12.5, height: 12 };

    expect(rectTraced(sloppy, [checkbox])).toEqual(checkbox);
  });

  it('picks the cell when the author traced the cell', () => {
    const drag = { x: 32, y: 691, width: 188, height: 27 };

    expect(rectTraced(drag, [cell, checkbox])).toEqual(cell);
  });

  it('refuses a table or page border a large box was drawn INSIDE', () => {
    /*
      THE FULL-PAGE BUG. Drawing an answer-region box inside a fully-bordered
      table snapped it out to the whole page. The border contains the drag, so
      drag-coverage passes; and a drag covering most of the border's area clears
      IoU 0.35 — this one is 0.6 — so the border came back and the box exploded.
      Rect-coverage refuses it: the drag reaches only 60% of the border's HEIGHT,
      so the two are not the same rectangle and the border is not a trace.
    */
    const border: PrintedRect = { x: 30, y: 200, width: 540, height: 400 };
    const drag = { x: 30, y: 280, width: 540, height: 240 };

    expect(rectTraced(drag, [border])).toBeNull();
  });

  it('refuses a drag that merely overlaps something', () => {
    // A drag across open page that happens to clip a printed box is not a
    // trace of it. Refusing here is what leaves edge-snapping in charge of
    // every ordinary placement.
    const drag = { x: 200, y: 600, width: 120, height: 40 };

    expect(rectTraced(drag, [cell, checkbox])).toBeNull();
  });

  it('refuses when there are no printed rectangles at all', () => {
    expect(rectTraced({ x: 0, y: 0, width: 10, height: 10 }, [])).toBeNull();
  });

  it('refuses a degenerate drag', () => {
    expect(rectTraced({ x: 196, y: 699, width: 0, height: 9 }, [checkbox])).toBeNull();
  });

  it('scores a perfect trace at 1 and so clears any threshold', () => {
    expect(rectTraced(checkbox, [checkbox], 1)).toEqual(checkbox);
  });

  it('leaves room on both sides of the default threshold', () => {
    /*
      The margin is the safety property, so it is asserted rather than assumed.
      A hand trace of the checkbox scores well above the threshold; the cell
      containing that same trace scores well below it.
    */
    const drag = { x: 195, y: 698, width: 11, height: 11 };
    const iou = (r: PrintedRect) => {
      const ix = Math.min(drag.x + drag.width, r.x + r.width) - Math.max(drag.x, r.x);
      const iy = Math.min(drag.y + drag.height, r.y + r.height) - Math.max(drag.y, r.y);
      const inter = Math.max(0, ix) * Math.max(0, iy);
      return inter / (drag.width * drag.height + r.width * r.height - inter);
    };

    expect(iou(checkbox)).toBeGreaterThan(RECT_TRACE_MIN_OVERLAP + 0.2);
    expect(iou(cell)).toBeLessThan(RECT_TRACE_MIN_OVERLAP - 0.2);
  });

  it('refuses to collapse a deliberate two-line box onto either of its lines', () => {
    /*
      THE REPORTED BUG. A textarea spanning two stacked one-line cells: the
      drag covers both, scores IoU 0.5 against EACH — above the trace
      threshold — and near-ties flipped which line won on every redraw. Each
      cell accounts for only half the drag, so neither is what the author
      meant, and the drawn box must survive at its drawn height.
    */
    const lineOne: PrintedRect = { x: 100, y: 714, width: 400, height: 14 };
    const lineTwo: PrintedRect = { x: 100, y: 700, width: 400, height: 14 };
    const drag = { x: 101, y: 701, width: 398, height: 26 };

    expect(rectTraced(drag, [lineOne, lineTwo])).toBeNull();
  });

  it('still traces a single line drawn snugly, with the two-line gate in place', () => {
    // The gate must not cost the feature it protects: a snug trace of ONE
    // line covers most of the drag and comes back at the printed size.
    const lineOne: PrintedRect = { x: 100, y: 714, width: 400, height: 14 };
    const lineTwo: PrintedRect = { x: 100, y: 700, width: 400, height: 14 };
    const drag = { x: 101, y: 713, width: 398, height: 16 };

    expect(rectTraced(drag, [lineOne, lineTwo])).toEqual(lineOne);
  });
});

describe('axisSnapRange', () => {
  it('leaves a big trace’s catch untouched', () => {
    // A 190pt cell box: a third of it is far more than 8pt, so the caller's
    // range still governs and nothing about existing placement changes.
    expect(axisSnapRange(190, RULE_SNAP_RANGE)).toBe(RULE_SNAP_RANGE);
  });

  it('tightens the catch for a small trace', () => {
    // A 9pt checkbox cannot be stretched 8pt. The row border it used to jump to
    // sits ~9pt away, which this no longer reaches.
    expect(axisSnapRange(9, RULE_SNAP_RANGE)).toBeLessThan(9.5 - 4.5);
  });

  it('never drops below the plain draw catch', () => {
    // A deliberately thin box — a write-on line, a signature strip — keeps the
    // modest catch that has always aligned it.
    expect(axisSnapRange(2, RULE_SNAP_RANGE)).toBe(DRAW_SNAP_RANGE);
  });

  it('treats a degenerate extent as no reason to tighten', () => {
    expect(axisSnapRange(0, RULE_SNAP_RANGE)).toBe(RULE_SNAP_RANGE);
    expect(axisSnapRange(Number.NaN, RULE_SNAP_RANGE)).toBe(RULE_SNAP_RANGE);
  });
});

describe('snapDrawnBox with the drag-scaled catch', () => {
  const page = { page: 0, pageWidth: 595, pageHeight: 842 };

  it('no longer inflates a traced checkbox to its table row', () => {
    /*
      THE REGRESSION TEST FOR THE REPORTED BUG, without rectangle detection in
      play — this is the fallback path, and it has to be safe on its own.

      A 10pt square traced at the centre of a 28pt row. The row's borders are
      the only rules within the old 8pt catch, so both edges used to fly to them
      and return a 28pt-high box.
    */
    const rowRules = [690, 718];
    const box = snapDrawnBox(
      { x: 196, y: 699 },
      { x: 206, y: 709 },
      page,
      [],
      rowRules,
      RULE_SNAP_RANGE,
    );

    expect(box.height).toBeCloseTo(10, 5);
    expect(box.y).toBeCloseTo(699, 5);
  });

  it('still snaps a full-cell trace onto the printed rules', () => {
    // The behaviour the catch exists for, unchanged: a rough trace of a real
    // cell locks onto the cell's borders.
    const box = snapDrawnBox(
      { x: 33, y: 692 },
      { x: 219, y: 716 },
      page,
      [31, 221],
      [690, 718],
      RULE_SNAP_RANGE,
    );

    expect(box.x).toBe(31);
    expect(box.width).toBe(190);
    expect(box.y).toBe(690);
    expect(box.height).toBe(28);
  });
});
