/**
 * Band derivation from the PDF text layer (U3, R5/R6/R15).
 *
 * Every fixture here is MEASURED from the real fixture documents, not invented.
 * That is deliberate and load-bearing: the option columns on the dozer are
 * ~7-13pt wide against a 192pt label header, the gaps between them are uneven
 * (2.4pt then 17.5pt), the tick is an unmappable Private-Use glyph, `/ x`
 * arrives as one text run, and `N/A` sits on a baseline 0.9pt off its own
 * header row. Evenly-spaced synthetic data passes a derivation that would fail
 * on every real document in the library.
 */
import { describe, expect, it } from 'vitest';
import { resolveGeometry } from '@formai/shared';
import type { RepeatingColumn } from '@formai/shared';
import { proposeTableSegments } from './pdf-geometry.js';
import type { PositionedText } from './pdf-geometry.js';

const A4 = { pageWidth: 595, pageHeight: 842 };

/** The dozer's tick / cross / N-A shape: label column plus three options. */
function tickCrossNaColumns(): RepeatingColumn[] {
  return [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'tick', label: '✓', type: 'boolean_yes_no' },
    { key: 'cross', label: '×', type: 'boolean_yes_no' },
    { key: 'na', label: 'N/A', type: 'boolean_yes_no' },
  ];
}

/**
 * Page 7 of `Authorised to Operate Track Dozer`, first table, verbatim.
 *
 * Note `N/A` at y=648.6 against the rest of the header at y=647.7 — the row is
 * not flat, and a baseline tolerance under ~1pt drops the anchor.
 */
function dozerPage7Table1(): PositionedText[] {
  return [
    { text: 'PART 2 – PRACTICAL DEMONSTRATION', x: 141.1, y: 702, width: 312.9 },
    { text: '1.', x: 38.7, y: 664.7, width: 8.3 },
    { text: 'Plan and Prepare', x: 73.5, y: 664.7, width: 81.7 },
    // Header row.
    { text: 'N/A', x: 539.9, y: 648.6, width: 13.3 },
    { text: 'During the demonstration, did the candidate:', x: 37.5, y: 647.7, width: 192 },
    { text: '', x: 502.6, y: 647.7, width: 7.1 },
    { text: '/ ×', x: 512.1, y: 647.7, width: 10.3 },
    // Rows.
    { text: 'Receive – interpret and clarifies work instructions', x: 37.5, y: 630.8, width: 258.1 },
    { text: 'Identify and report potential hazards', x: 37.5, y: 614, width: 143.6 },
    { text: 'Communicate with other personnel when required', x: 37.5, y: 597.1, width: 198.6 },
    { text: 'Wearing correct PPE', x: 37.5, y: 580.3, width: 84 },
  ];
}

/**
 * Page 7's SECOND table header, verbatim. Carries a stray ':' at x=228 — short,
 * and to the right of the label header's right edge. A naive "short items right
 * of the label" rule takes it as a fourth anchor for a three-column table.
 */
function dozerPage7Table2Header(): PositionedText[] {
  return [
    { text: 'N/A', x: 539.9, y: 546.4, width: 13.3 },
    { text: 'During the demonstration, did the Candidate', x: 37.5, y: 545.4, width: 190.5 },
    { text: ':', x: 228, y: 545.4, width: 2.5 },
    { text: '', x: 502.6, y: 545.4, width: 7.1 },
    { text: '/ ×', x: 512.1, y: 545.4, width: 10.3 },
    // Two rows, the first of which WRAPS onto a second line (10.4pt gap against
    // a ~16.8pt row pitch).
    { text: 'Isolates machine correctly using personnel safety locks', x: 37.5, y: 528.6, width: 442.7 },
    { text: 'into the footprint of the dozer?', x: 37.5, y: 518.2, width: 119.6 },
    { text: 'Maintain three (3) point contact when manoeuvring over', x: 37.5, y: 501.4, width: 434.2 },
    { text: 'All lights for condition', x: 37.5, y: 484.5, width: 85 },
  ];
}

function propose(items: PositionedText[], columns = tickCrossNaColumns()) {
  return proposeTableSegments({ page: 6, ...A4, items, columns });
}

describe('proposeTableSegments — the measured dozer header', () => {
  it('yields exactly three option bands for a three-option table', () => {
    const [proposal] = propose(dozerPage7Table1());

    expect(proposal?.segment.columnBands).toHaveLength(3);
  });

  it('keys the bands to the option columns in x order, never the label column', () => {
    const [proposal] = propose(dozerPage7Table1());

    expect(proposal?.segment.columnBands?.map((b) => b.key)).toEqual(['tick', 'cross', 'na']);
  });

  it('treats the combined "/ ×" run as ONE anchor, not two', () => {
    // The '/' is punctuation separating the printed ✓ and ×, sharing a text run
    // with the ×. Splitting the run would invent a band for the separator.
    const [proposal] = propose(dozerPage7Table1());

    expect(proposal?.anchorsLocated).toBe(3);
    expect(proposal?.anchorsInferred).toBe(0);
  });

  it('accepts the unmappable U+F0FC glyph as an anchor', () => {
    const items = dozerPage7Table1();
    const [proposal] = propose(items);

    const tick = proposal?.segment.columnBands?.find((b) => b.key === 'tick');
    // The tick glyph sits at x=502.6; its band must cover it.
    expect(tick!.start).toBeLessThanOrEqual(502.6);
    expect(tick!.end).toBeGreaterThan(502.6);
  });

  it('groups a header row whose baselines differ by ~1pt', () => {
    // N/A is at y=648.6 while the rest of the row is at 647.7.
    const [proposal] = propose(dozerPage7Table1());

    expect(proposal?.segment.columnBands?.some((b) => b.key === 'na')).toBe(true);
  });

  it('never overlaps the 192pt label column', () => {
    const [proposal] = propose(dozerPage7Table1());

    // The first option band starts exactly WHERE the label header ends
    // (37.5 + 192 = 229.5) — abutting is correct and keeps the bands gapless;
    // starting anywhere below that would make the label column answerable.
    for (const band of proposal!.segment.columnBands!) {
      expect(band.start).toBeGreaterThanOrEqual(229.5);
    }
  });

  it('produces contiguous bands with no gaps between them', () => {
    const [proposal] = propose(dozerPage7Table1());
    const bands = proposal!.segment.columnBands!;

    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.start).toBe(bands[i - 1]!.end);
    }
  });

  it('reports full confidence when every anchor was located', () => {
    const [proposal] = propose(dozerPage7Table1());

    expect(proposal!.confidence).toBe(1);
  });

  it('derives one row band per printed row', () => {
    const [proposal] = propose(dozerPage7Table1());

    expect(proposal?.segment.rowBands).toHaveLength(4);
  });
});

describe('proposeTableSegments — anchor reconciliation', () => {
  it('infers a missing anchor from pitch when the tick is absent from the text layer', () => {
    // The Small Loader shape: 18 "/ x" runs and 18 "N/A", zero Private-Use ticks.
    const items = dozerPage7Table1().filter((i) => i.text !== '');

    const [proposal] = propose(items);

    expect(proposal?.segment.columnBands).toHaveLength(3);
    expect(proposal?.anchorsLocated).toBe(2);
    expect(proposal?.anchorsInferred).toBe(1);
  });

  it('scores an inferred anchor strictly below a fully located one', () => {
    const located = propose(dozerPage7Table1())[0]!;
    const inferred = propose(dozerPage7Table1().filter((i) => i.text !== ''))[0]!;

    expect(inferred.confidence).toBeLessThan(located.confidence);
  });

  it('returns no proposal for a Grader-shaped header carrying a single anchor', () => {
    // One point yields no pitch, so three bands cannot be honestly derived.
    const items = dozerPage7Table1().filter((i) => i.text !== '' && i.text !== '/ ×');

    expect(propose(items)).toEqual([]);
  });

  it('excludes a stray short item far to the left of the option cluster', () => {
    // Page 7's second header carries a ':' at x=228 — short, and right of the
    // label header. Taking it as an anchor would give four anchors for three
    // columns and shift every band left.
    const [proposal] = propose(dozerPage7Table2Header());

    expect(proposal?.anchorsLocated).toBe(3);
    expect(proposal?.segment.columnBands?.map((b) => b.key)).toEqual(['tick', 'cross', 'na']);
  });

  it('handles a two-option OK/NA table', () => {
    const columns: RepeatingColumn[] = [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
      { key: 'na', label: 'NA', type: 'boolean_yes_no' },
    ];
    // ADMN-FRM-111's shape: ASCII headers, A5 landscape.
    const items: PositionedText[] = [
      { text: 'Item', x: 40, y: 300, width: 60 },
      { text: 'OK', x: 164.5, y: 300, width: 9 },
      { text: 'NA', x: 192.7, y: 300, width: 9 },
      { text: 'Engine oil level', x: 40, y: 286, width: 55 },
      { text: 'Coolant level', x: 40, y: 272, width: 50 },
    ];

    const [proposal] = proposeTableSegments({
      page: 0,
      pageWidth: 595,
      pageHeight: 420,
      items,
      columns,
    });

    expect(proposal?.segment.columnBands?.map((b) => b.key)).toEqual(['ok', 'na']);
    expect(proposal?.confidence).toBe(1);
  });
});

describe('proposeTableSegments — rows', () => {
  it('merges a label wrapping onto a second line into one row', () => {
    // 'Isolates machine ...' wraps, leaving a 10.4pt gap against a ~16.8pt pitch.
    const [proposal] = propose(dozerPage7Table2Header());

    expect(proposal?.segment.rowBands).toHaveLength(3);
  });

  it('gives every row band a unique key', () => {
    const [proposal] = propose(dozerPage7Table1());
    const keys = proposal!.segment.rowBands!.map((b) => b.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('orders row bands top-to-bottom as printed', () => {
    const [proposal] = propose(dozerPage7Table1());
    const bands = proposal!.segment.rowBands!;

    // PDF y grows upward, so the first printed row has the HIGHEST y.
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.start).toBeLessThan(bands[i - 1]!.start);
    }
  });
});

describe('proposeTableSegments — validator conformance (R15)', () => {
  it('emits a proposal the shipped validator accepts unchanged', () => {
    // Asserted directly rather than assumed: a proposal resolveGeometry rejects
    // is dropped silently downstream and the reviewer sees an empty grid with
    // no stated reason.
    const [proposal] = propose(dozerPage7Table1());

    const resolved = resolveGeometry({ geometry: { segments: [proposal!.segment] } }, 18);

    expect(resolved.dropped).toEqual([]);
    expect(resolved.segments).toHaveLength(1);
  });

  it('emits a validator-clean proposal on the inferred-anchor path too', () => {
    const items = dozerPage7Table1().filter((i) => i.text !== '');
    const [proposal] = propose(items);

    const resolved = resolveGeometry({ geometry: { segments: [proposal!.segment] } }, 18);

    expect(resolved.dropped).toEqual([]);
  });

  it('keeps every band inside the segment box', () => {
    const [proposal] = propose(dozerPage7Table1());
    const { segment } = proposal!;

    for (const b of segment.columnBands!) {
      expect(b.start).toBeGreaterThanOrEqual(segment.x);
      expect(b.end).toBeLessThanOrEqual(segment.x + segment.width);
    }
    for (const b of segment.rowBands!) {
      expect(b.start).toBeGreaterThanOrEqual(segment.y);
      expect(b.end).toBeLessThanOrEqual(segment.y + segment.height);
    }
  });

  it('records the real page index on the segment', () => {
    const [proposal] = propose(dozerPage7Table1());

    expect(proposal?.segment.page).toBe(6);
    expect(proposal?.segment.pageWidth).toBe(595);
  });
});

describe('proposeTableSegments — refusals', () => {
  it('returns nothing when no header row exists', () => {
    const items: PositionedText[] = [
      { text: 'Some prose that runs across the page', x: 37.5, y: 600, width: 300 },
      { text: 'More prose on the next line', x: 37.5, y: 583, width: 250 },
    ];

    expect(propose(items)).toEqual([]);
  });

  it('returns nothing for an empty item list', () => {
    expect(propose([])).toEqual([]);
  });

  it('returns nothing when the field has no option columns', () => {
    const columns: RepeatingColumn[] = [{ key: 'item', label: 'Item', type: 'text' }];

    expect(propose(dozerPage7Table1(), columns)).toEqual([]);
  });

  it('finds both tables when a page carries two header rows', () => {
    const items = [...dozerPage7Table1(), ...dozerPage7Table2Header()];

    expect(propose(items)).toHaveLength(2);
  });

  it('stops collecting rows at the next table on the page', () => {
    // Caught by running the module over the real document: without a lower
    // bound, the first table swallowed every label-column line to the bottom of
    // the page — 35 rows for a table that prints 4, so every answer below the
    // first table would resolve to the wrong row.
    const items = [...dozerPage7Table1(), ...dozerPage7Table2Header()];

    const [first] = propose(items);

    expect(first?.segment.rowBands).toHaveLength(4);
  });

  it('excludes a numbered section heading sitting just off the label margin', () => {
    // '2. Equipment Pre-Operational Checks' is printed at x=38.7 against the
    // label column's 37.5 — close, but not the label column, and counting it as
    // a row would offset every answer after it.
    const items = [
      ...dozerPage7Table1(),
      { text: '2.', x: 38.7, y: 562.5, width: 8.3 },
      { text: 'Equipment Pre-Operational Checks', x: 73.5, y: 562.5, width: 167.8 },
    ];

    const [proposal] = propose(items);

    expect(proposal?.segment.rowBands).toHaveLength(4);
  });
});

describe('proposeTableSegments — band extent', () => {
  it('does not stretch the outermost option band across the label column', () => {
    // Also caught on the real document: anchoring the first band at the label
    // column's right edge gave the tick a 282pt span reaching over blank paper,
    // so a mark at x=250 would have resolved as "ticked".
    const [proposal] = propose(dozerPage7Table1());
    const bands = proposal!.segment.columnBands!;

    const widths = bands.map((b) => b.end - b.start);
    const widest = Math.max(...widths);
    const narrowest = Math.min(...widths);

    // The printed option columns are all of comparable width; nothing should be
    // an order of magnitude wider than its neighbours.
    expect(widest).toBeLessThan(narrowest * 6);
  });

  it('keeps the option bands within the printed option area', () => {
    const [proposal] = propose(dozerPage7Table1());
    const bands = proposal!.segment.columnBands!;

    // The leftmost printed option glyph starts at x=502.6.
    expect(bands[0]!.start).toBeGreaterThan(480);
  });
});
