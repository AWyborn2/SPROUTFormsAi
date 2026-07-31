/**
 * Horizontal rule-lines, keeping the extent `rulesFromSegments` throws away.
 *
 * Snapping a dragged edge only needs a coordinate. Placing a box on a printed
 * write-on line needs the line's start and end, because those ARE the box's x
 * and width — measured, rather than invented from whitespace. That distinction
 * is the whole reason a scalar placement rule can exist: `PositionedText`
 * carries no height and no strokes, so text alone has nothing to say about a
 * box's vertical position or extent.
 *
 * The real document draws 687 horizontal rules across six pages, 341 of them
 * under 200pt — the length class of a per-field line rather than a table border.
 */
import { describe, expect, it } from 'vitest';
import { horizontalRuleSpans, type DrawSegment } from './geometry-actions.js';

const seg = (x1: number, y1: number, x2: number, y2: number): DrawSegment => ({ x1, y1, x2, y2 });

describe('horizontalRuleSpans', () => {
  it('keeps each rule’s endpoints', () => {
    const spans = horizontalRuleSpans([seg(200, 698, 380, 698)]);

    expect(spans).toEqual([{ y: 698, x1: 200, x2: 380 }]);
  });

  it('normalises a right-to-left segment', () => {
    // A path may be drawn in either direction; the span is the same line.
    expect(horizontalRuleSpans([seg(380, 698, 200, 698)])).toEqual([{ y: 698, x1: 200, x2: 380 }]);
  });

  it('ignores verticals and anything too short to be a rule', () => {
    const spans = horizontalRuleSpans([
      seg(100, 600, 100, 700), // vertical
      seg(100, 500, 110, 500), // 10pt — a glyph stroke or a tick, not a rule
      seg(100, 400, 200, 400), // a real one
    ]);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.y).toBe(400);
  });

  it('merges the two long edges of a line drawn as a thin rectangle', () => {
    /*
      A write-on line printed as a 0.6pt filled rectangle reaches us as its two
      long edges. Without merging, every such line looks like TWO candidates and
      the scalar rule refuses the entire population as ambiguous.
    */
    const spans = horizontalRuleSpans([seg(200, 698, 380, 698), seg(200, 698.6, 380, 698.6)]);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.x1).toBe(200);
    expect(spans[0]!.x2).toBe(380);
  });

  /*
    THIS TEST USED TO ASSERT THE OPPOSITE — that two touching segments join.

    They must not. Adjacent cells on a table row share a baseline and their
    borders meet end-to-end, so joining them collapses the row into one
    full-width rule and destroys the per-cell extents. Measured on the real
    document, one cover-page row carries three cell borders AND the table's
    outer border, all at y≈701:

      31.4 → 221.8 · 222.3 → 384.8 · 385.3 → 563.5 · and 31.4 → 563.5

    With touching merged, every caption on that row measured the whole table
    instead of its own cell, and two different fields proposed the same box.
  */
  it('keeps two touching segments apart — they are adjacent cell borders', () => {
    const spans = horizontalRuleSpans([seg(200, 698, 290, 698), seg(290, 698, 380, 698)]);

    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.x2)).toEqual([290, 380]);
  });

  it('keeps a cell border out of the outer border that contains it', () => {
    // The other half of the same defect: merging on overlap alone swallows a
    // cell's border into the table's, which is a superset of it.
    const spans = horizontalRuleSpans([seg(31, 701.5, 222, 701.5), seg(31, 701.9, 563, 701.9)]);

    expect(spans).toHaveLength(2);
    expect(spans.map((s) => Math.round(s.x2))).toEqual([222, 563]);
  });

  it('keeps two separate lines on the same baseline apart', () => {
    // The cover page prints two captioned lines on one row. Merging them would
    // hand the first field a box running across the second's answer area.
    const spans = horizontalRuleSpans([seg(160, 698, 290, 698), seg(430, 698, 555, 698)]);

    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.x1)).toEqual([160, 430]);
  });

  it('keeps lines on different rows apart', () => {
    const spans = horizontalRuleSpans([seg(200, 698, 380, 698), seg(200, 678, 380, 678)]);

    expect(spans).toHaveLength(2);
  });

  it('drops a segment with a non-finite coordinate rather than trusting it', () => {
    const spans = horizontalRuleSpans([
      { x1: Number.NaN, y1: 698, x2: 380, y2: 698 },
      seg(200, 600, 380, 600),
    ]);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.y).toBe(600);
  });
});
