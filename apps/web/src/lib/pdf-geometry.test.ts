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

/**
 * The same table repeated lower on the page.
 *
 * Real pages carry two or three occurrences of a table and its header — U1
 * measured 2 on page 7 and 3 on pages 8 and 9 — and that repetition is what
 * corroborates a header. A single-table fixture is the unrepresentative case,
 * so any scenario about *inference* needs a sibling to be realistic.
 */
function repeated(items: PositionedText[], dy = 200): PositionedText[] {
  return [...items, ...items.map((i) => ({ ...i, y: i.y - dy }))];
}

/**
 * Page 7's first table with the tick gone from the text layer — the measured
 * Small Loader shape, where `/ ×` and `N/A` reach the text layer but no
 * Private-Use tick does.
 */
function withoutTick(): PositionedText[] {
  return dozerPage7Table1().filter((i) => i.text.codePointAt(0) !== 0xf0fc);
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

  it('holds back full confidence when nothing on the page corroborates the header', () => {
    // Locating every anchor is necessary but not sufficient. A lone header
    // cannot be cross-checked against a sibling, so it stays short of full
    // confidence and says why — a running head also "locates every anchor".
    const [proposal] = propose(dozerPage7Table1());

    expect(proposal!.confidence).toBeLessThan(1);
    expect(proposal!.notes.join(' ')).toMatch(/could not be cross-checked/);
  });

  it('reports full confidence when a second table confirms the header shape', () => {
    const [proposal] = propose([...dozerPage7Table1(), ...dozerPage7Table2Header()]);

    expect(proposal!.confidence).toBe(1);
    expect(proposal!.notes).toEqual([]);
  });

  it('derives one row band per printed row', () => {
    const [proposal] = propose(dozerPage7Table1());

    expect(proposal?.segment.rowBands).toHaveLength(4);
  });
});

describe('proposeTableSegments — anchor reconciliation', () => {
  it('infers a missing anchor from pitch when the tick is absent from the text layer', () => {
    // The Small Loader shape: 18 "/ x" runs and 18 "N/A", zero Private-Use ticks.
    const items = repeated(withoutTick());

    const [proposal] = propose(items);

    expect(proposal?.segment.columnBands).toHaveLength(3);
    expect(proposal?.anchorsLocated).toBe(2);
    expect(proposal?.anchorsInferred).toBe(1);
  });

  it('scores an inferred anchor strictly below a fully located one', () => {
    const located = propose(repeated(dozerPage7Table1()))[0]!;
    const inferred = propose(repeated(withoutTick()))[0]!;

    expect(inferred.confidence).toBeLessThan(located.confidence);
  });

  it('returns no proposal for a Grader-shaped header carrying a single anchor', () => {
    // One point yields no pitch, so three bands cannot be honestly derived.
    const items = withoutTick().filter((i) => i.text !== '/ ×');

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
    // A single-table form is real (ADMN-FRM-111 is one table on one page), so
    // it still proposes — just uncorroborated, and marked as such.
    expect(proposal?.confidence).toBe(0.8);
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
    const items = repeated(withoutTick());
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

describe('proposeTableSegments — corroboration (U7, R16)', () => {
  it('refuses a document-control running head', () => {
    // Executed counter-example: this previously produced a proposal at
    // confidence 0.7 on a page where the real table is the Grader shape that
    // is asserted to return nothing.
    const items: PositionedText[] = [
      { text: 'Charles Hull Contracting Pty Ltd — Operator Competency', x: 37.5, y: 800, width: 250 },
      { text: 'Rev 4', x: 480, y: 800, width: 20 },
      { text: '07/2026', x: 520, y: 800, width: 30 },
      { text: 'Some body line', x: 37.5, y: 780, width: 90 },
      { text: 'Another body line', x: 37.5, y: 763, width: 95 },
    ];

    expect(propose(items)).toEqual([]);
  });

  it('refuses a signature strip', () => {
    const items: PositionedText[] = [
      { text: 'I declare that the assessment above was conducted correctly', x: 37.5, y: 300, width: 260 },
      { text: 'Date:', x: 420, y: 300, width: 22 },
      { text: 'Time:', x: 480, y: 300, width: 22 },
      { text: 'Assessor name', x: 37.5, y: 283, width: 60 },
      { text: 'Candidate name', x: 37.5, y: 266, width: 65 },
    ];

    expect(propose(items)).toEqual([]);
  });

  it('drops the header whose anchor pattern no sibling confirms', () => {
    // A running head sharing a page with two real tables: the real headers
    // corroborate each other, the furniture matches neither.
    const items = [
      { text: 'Charles Hull Contracting Pty Ltd — Operator Competency', x: 37.5, y: 800, width: 250 },
      { text: 'Rev 4', x: 480, y: 800, width: 20 },
      { text: '07/2026', x: 520, y: 800, width: 30 },
      { text: 'Doc line', x: 37.5, y: 783, width: 40 },
      ...dozerPage7Table1(),
      ...dozerPage7Table2Header(),
    ];

    const out = propose(items);

    expect(out).toHaveLength(2);
    for (const p of out) {
      expect(p.segment.columnBands?.map((b) => b.key)).toEqual(['tick', 'cross', 'na']);
    }
  });

  it('refuses a header whose anchor cluster spreads far wider than its own glyphs', () => {
    // The stray ':' survives the gap-outlier split when there are too few gaps
    // for it to have an uncontaminated reference. Glyph width is the
    // independent signal: measured clean clusters span 1.00-3.68x their own
    // width, contaminated ones 9.76-10.69x.
    const items: PositionedText[] = [
      { text: 'During the demonstration, did the Candidate', x: 37.5, y: 545.4, width: 190.5 },
      { text: ':', x: 228, y: 545.4, width: 2.5 },
      { text: 'N/A', x: 539.9, y: 545.4, width: 13.3 },
      { text: 'A row label', x: 37.5, y: 528.6, width: 60 },
      { text: 'Another row label', x: 37.5, y: 511.8, width: 70 },
    ];

    const columns: RepeatingColumn[] = [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
      { key: 'na', label: 'NA', type: 'boolean_yes_no' },
    ];

    expect(propose(items, columns)).toEqual([]);
  });

  it('refuses to infer leftward when text sits right of the last located anchor', () => {
    // Executed counter-example: with N/A removed, inference shifted every band
    // one column left, stamping a recorded cross in the tick column. The
    // printed N/A text is still on the row, so the missing column may be the
    // RIGHTMOST one — which cannot be told apart, so refuse.
    // 'Comments' is wide enough not to read as an option header, so only two
    // anchors are located for three columns — but it proves something IS
    // printed to the right of them.
    const items = [
      ...dozerPage7Table1().filter((i) => i.text !== 'N/A'),
      { text: 'Comments', x: 539.9, y: 647.7, width: 60 },
    ];
    const withSibling = [...items, ...dozerPage7Table2Header()];

    expect(propose(withSibling).filter((p) => p.anchorsInferred > 0)).toEqual([]);
  });
});

describe('proposeTableSegments — row pitch from the gap distribution (U7)', () => {
  function tableWithRowGaps(gaps: number[]): PositionedText[] {
    const items = [...dozerPage7Table1()].filter((i) => !i.text.startsWith('Receive') && !i.text.startsWith('Identify') && !i.text.startsWith('Communicate') && !i.text.startsWith('Wearing'));
    let y = 630.8;
    items.push({ text: 'Row label 0', x: 37.5, y, width: 80 });
    gaps.forEach((g, n) => {
      y -= g;
      items.push({ text: `Row label ${n + 1}`, x: 37.5, y, width: 80 });
    });
    return items;
  }

  it('does not merge a genuine row away when leading is irregular', () => {
    // Executed counter-example: gaps [16.8, 30] gave 2 bands for 3 printed
    // rows, because the median landed on the larger gap and the wrap threshold
    // then swallowed the smaller one.
    const [proposal] = propose(tableWithRowGaps([16.8, 30]));

    expect(proposal?.segment.rowBands).toHaveLength(3);
  });

  it('still merges a wrap when the gap distribution separates cleanly', () => {
    const [proposal] = propose(tableWithRowGaps([10.4, 16.8, 16.9]));

    expect(proposal?.segment.rowBands).toHaveLength(3);
  });

  it('merges nothing when wraps and rows cannot be told apart', () => {
    // Equal-sized clusters: adding a spurious row is recoverable in review,
    // silently deleting a printed one is not.
    const [proposal] = propose(tableWithRowGaps([10.4, 16.8]));

    expect(proposal?.segment.rowBands).toHaveLength(3);
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

/**
 * U8 — a header row that carries no label of its own (R17).
 *
 * Every fixture is measured from `ADMN-FRM-111 Light Vehicle Pre-start
 * Checklist`, whose option headers sit on their own baseline with the item
 * names on the rows beneath. That shape is invisible to the original detector,
 * which requires a wide label header on the same baseline — so the real header
 * was discarded and the form's Shift row was accepted in its place, putting the
 * night-shift checkbox where the N/A column should be.
 */
describe('proposeTableSegments — standalone option-header rows (U8)', () => {
  const okNaColumns: RepeatingColumn[] = [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
    { key: 'na', label: 'NA', type: 'boolean_yes_no' },
  ];

  const A5_LANDSCAPE = { pageWidth: 595, pageHeight: 420 };

  /** One category block: its option-header row plus `rows` label lines. */
  function categoryBlock(headerY: number, xs: number[], rows: number): PositionedText[] {
    const header = xs.map((x, i) => ({
      text: i % 2 === 0 ? 'OK' : 'NA',
      x,
      y: headerY,
      width: i % 2 === 0 ? 12.2 : 12.6,
    }));
    const labels = Array.from({ length: rows }, (_, i) => ({
      text: `Item ${i}`,
      x: 42,
      y: headerY - 13.7 - i * 14.65,
      width: 60 + i,
    }));
    return [...header, ...labels];
  }

  /** The measured page: three category blocks, each with three OK/NA pairs. */
  function admnFrm111(): PositionedText[] {
    return [
      ...categoryBlock(306.2, [164.5, 192.7, 345.7, 371.1, 512.6, 540.7], 6),
      ...categoryBlock(188.3, [161.9, 190.3, 345.7, 368.7, 510, 538.3], 2),
      ...categoryBlock(129, [161.9, 190.3, 345.7, 368.7, 510, 538.3], 2),
    ];
  }

  /** The form's Shift row — the wrong header the old detector accepted. */
  function shiftRow(): PositionedText[] {
    return [
      { text: 'HRS/KMS', x: 42, y: 339.9, width: 39.8 },
      { text: 'Operator', x: 242.1, y: 339.9, width: 38.1 },
      { text: 'Shift', x: 435.6, y: 339.9, width: 19.1 },
      { text: 'D', x: 472.8, y: 339.3, width: 6.1 },
      { text: '☐', x: 481.2, y: 339.3, width: 8.6 },
      { text: 'N', x: 517.2, y: 339.3, width: 6.4 },
      { text: '☐', x: 525.9, y: 339.3, width: 8.6 },
    ];
  }

  const proposeAdmn = (items: PositionedText[]) =>
    proposeTableSegments({ page: 0, ...A5_LANDSCAPE, items, columns: okNaColumns });

  it('recognises an option-header row with no wide label on its baseline', () => {
    // Six items of near-identical width (12.2/12.6) and no label text. The
    // original detector took the widest as the label header and then found no
    // candidate narrow enough to be an option, discarding the row entirely.
    const out = proposeAdmn(admnFrm111());

    expect(out.length).toBeGreaterThan(0);
  });

  it('finds one proposal per printed category block', () => {
    expect(proposeAdmn(admnFrm111())).toHaveLength(3);
  });

  it('places the bands over real printed columns, not the gutter', () => {
    const [first] = proposeAdmn(admnFrm111());
    const ok = first!.segment.columnBands?.find((b) => b.key === 'ok');
    const na = first!.segment.columnBands?.find((b) => b.key === 'na');

    // Category A's rightmost pair prints at OK x=512.6 and NA x=540.7.
    expect(ok!.start).toBeLessThanOrEqual(512.6);
    expect(ok!.end).toBeGreaterThan(512.6);
    expect(na!.start).toBeLessThanOrEqual(540.7);
    expect(na!.end).toBeGreaterThan(540.7);
  });

  it('REFUSES the Shift row rather than merely ranking it lower', () => {
    // The failure this unit exists for. Its anchors [517.2, 525.9] match no
    // sibling header on the page, so the corroboration check already shipped in
    // U7 rejects it — once the real headers are candidates and can corroborate
    // each other.
    const out = proposeAdmn([...admnFrm111(), ...shiftRow()]);

    for (const proposal of out) {
      const ok = proposal.segment.columnBands!.find((b) => b.key === 'ok')!;
      // The Shift row would put the ok band around x=515-525.
      expect(ok.end - ok.start).toBeGreaterThan(12);
    }
    expect(out).toHaveLength(3);
  });

  it('refuses the Shift row even when it is the only candidate shape present', () => {
    // No real headers to corroborate against, so nothing confirms it.
    const out = proposeAdmn([
      ...shiftRow(),
      { text: 'Engine oil level', x: 42, y: 292.5, width: 60.8 },
      { text: 'Engine coolant level', x: 42, y: 277.9, width: 81.3 },
    ]);

    expect(out.every((p) => p.confidence < 1)).toBe(true);
  });

  it('does not mistake a row of ordinary prose for an option header', () => {
    // Three label-column lines of differing width — the widths are what tell
    // this apart from a header of near-uniform option glyphs.
    const prose: PositionedText[] = [
      { text: 'Engine oil level', x: 42, y: 292.5, width: 60.8 },
      { text: 'Tyre Condition/ Wheel nuts', x: 218.6, y: 292.5, width: 112.1 },
      { text: 'Brake & indicator lights', x: 397, y: 292.5, width: 94.8 },
      { text: 'Engine coolant level', x: 42, y: 277.9, width: 81.3 },
      { text: 'Park brake', x: 218.6, y: 277.9, width: 43.3 },
    ];

    expect(proposeAdmn(prose)).toEqual([]);
  });

  it('still proposes for the dozer shape, whose header does carry a label', () => {
    // The first shape is unchanged; adding a second must not disturb it.
    const [proposal] = propose(repeated(dozerPage7Table1()));

    expect(proposal?.segment.columnBands?.map((b) => b.key)).toEqual(['tick', 'cross', 'na']);
  });

  it('emits proposals the shipped validator accepts', () => {
    for (const proposal of proposeAdmn(admnFrm111())) {
      const resolved = resolveGeometry({ geometry: { segments: [proposal.segment] } }, 1);
      expect(resolved.dropped).toEqual([]);
    }
  });
});

/**
 * U1 — a between-tables section heading printed at the label margin must not
 * be counted as a final row (R1, R2).
 *
 * Every coordinate below is MEASURED from page 1 of `ADMN-FRM-111 Light Vehicle
 * Pre-start Checklist`, verbatim from its text layer. Category A is a three-up
 * checklist: item labels sit in three sub-columns (x=42, 218.6, 397) answered
 * by three OK/NA pairs (164.5/192.7, 345.7/371.1, 512.6/540.7). Between the last
 * Category A item and the Category B block sits a single wide run,
 * `Category 'B' faults: …`, printed at x=42 — the SAME left margin as the item
 * labels. It passes the label-margin filter and was counted as a seventh row,
 * so the derived grid ran one row too far and the overlay leaked into the
 * heading. The discriminator is geometric: an item label's run at the margin
 * stays left of the first option column (ends by 146.8, against the leftmost
 * option glyph at 164.5), while the heading run crosses far into the option
 * region (ends at 521.4).
 */
describe('proposeTableSegments — row-band tightening at the table end (U1)', () => {
  const okNaColumns: RepeatingColumn[] = [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
    { key: 'na', label: 'NA', type: 'boolean_yes_no' },
  ];
  const A5_LANDSCAPE = { pageWidth: 595.32, pageHeight: 419.52 };

  /** Category A, verbatim: the OK/NA header, six three-column item rows, then
   * the wide `Category 'B' faults:` heading that shares the label margin. */
  function categoryABlock(): PositionedText[] {
    return [
      // Option-header row (three OK/NA pairs on their own baseline).
      { text: 'OK', x: 164.5, y: 306.2, width: 12.2 },
      { text: 'NA', x: 192.7, y: 306.2, width: 12.6 },
      { text: 'OK', x: 345.7, y: 306.2, width: 12.2 },
      { text: 'NA', x: 371.1, y: 306.2, width: 12.6 },
      { text: 'OK', x: 512.6, y: 306.2, width: 12.2 },
      { text: 'NA', x: 540.7, y: 306.2, width: 12.6 },
      // Six item rows, each three real columns wide.
      { text: 'Engine oil level', x: 42, y: 292.5, width: 60.8 },
      { text: 'Tyre Condition/ Wheel nuts', x: 218.6, y: 292.5, width: 112.1 },
      { text: 'Brake & indicator lights', x: 397, y: 292.5, width: 94.8 },
      { text: 'Engine coolant level', x: 42, y: 277.9, width: 81.3 },
      { text: 'Park brake', x: 218.6, y: 277.9, width: 43.3 },
      { text: 'Headlights', x: 397, y: 277.9, width: 43.0 },
      { text: 'Power steering fluid level', x: 42, y: 263.2, width: 102.8 },
      { text: 'Foot brake', x: 218.6, y: 263.2, width: 43.8 },
      { text: 'Flashing light', x: 397, y: 263.2, width: 53.2 },
      { text: 'Steering', x: 42, y: 248.6, width: 33.5 },
      { text: 'Seat belts', x: 218.6, y: 248.6, width: 39.6 },
      { text: 'Flag (if required)', x: 397, y: 248.6, width: 67.2 },
      { text: 'Locking pins on Tray', x: 42, y: 233.9, width: 82.2 },
      { text: '2-way radio', x: 218.6, y: 233.9, width: 47.8 },
      { text: 'Fire extinguisher', x: 397, y: 233.9, width: 67.5 },
      { text: 'Collision Avoidance System', x: 42, y: 219.4, width: 104.8 },
      { text: 'Horn', x: 218.6, y: 219.3, width: 20.2 },
      { text: 'Reverse Alarm', x: 397, y: 219.3, width: 58.8 },
      // The between-tables heading at the label margin — NOT a seventh row.
      {
        text: "Category 'B' faults: The machine MUST NOT be operated unless fault is rectified or operation is APPROVED by competent person",
        x: 42,
        y: 200.8,
        width: 479.4,
      },
    ];
  }

  const proposeA = (items: PositionedText[]) =>
    proposeTableSegments({ page: 0, ...A5_LANDSCAPE, items, columns: okNaColumns });

  it('derives six row bands for Category A, excluding the Category B heading', () => {
    const [proposal] = proposeA(categoryABlock());

    // Six printed item rows, not seven — the wide heading at y=200.8 is not a row.
    expect(proposal?.segment.rowBands).toHaveLength(6);
  });

  it('leaves no row band covering the heading line', () => {
    const [proposal] = proposeA(categoryABlock());
    const bands = proposal!.segment.rowBands!;

    // The heading baseline is 200.8; no band may reach down onto it.
    for (const band of bands) {
      expect(band.start).toBeGreaterThan(200.8);
    }
  });

  it('keeps every genuine item row when the table is the last thing on the page', () => {
    // No trailing heading — the six items are the whole table. Nothing is cut.
    const noHeading = categoryABlock().filter((i) => !i.text.startsWith("Category 'B'"));
    const [proposal] = proposeA(noHeading);

    expect(proposal?.segment.rowBands).toHaveLength(6);
  });

  it('still merges a wrapped continuation line rather than cutting at it', () => {
    // The dozer wrap: a real label spilling onto a second line stays within the
    // label column, so it is merged, not read as a heading and cut.
    const [proposal] = propose(dozerPage7Table2Header());

    expect(proposal?.segment.rowBands).toHaveLength(3);
  });
});

describe('the standalone header shape does not admit page furniture (U8 review)', () => {
  const COLS = [
    { key: 'item', label: 'Item', type: 'text' as const },
    { key: 'ok', label: 'OK', type: 'boolean_yes_no' as const },
    { key: 'na', label: 'NA', type: 'boolean_yes_no' as const },
  ];

  function propose(items: PositionedText[]) {
    return proposeTableSegments({
      page: 0, pageWidth: 595, pageHeight: 420, items, columns: COLS,
    });
  }

  it('refuses a two-glyph row of equal width', () => {
    // Two identical-width runs are uniform by construction, and with two option
    // columns nothing is INFERRED, so the uncorroborated-inference refusal
    // never fires to catch them. Only the item-count floor does.
    const items: PositionedText[] = [
      { text: '☐', x: 300, y: 306.2, width: 8.6 },
      { text: '☐', x: 500, y: 306.2, width: 8.6 },
      ...[0, 1, 2].map((r) => ({ text: `Item ${r}`, x: 42, y: 290 - r * 16, width: 60 })),
    ];

    expect(propose(items)).toEqual([]);
  });

  /** Two corroborating header blocks — a lone header is refused by U7 anyway. */
  function headerAt(y: number): PositionedText[] {
    return [
      { text: 'OK', x: 345.7, y, width: 12.2 },
      { text: 'NA', x: 371.1, y, width: 12.6 },
      { text: 'OK', x: 512.6, y, width: 12.2 },
      { text: 'NA', x: 540.7, y, width: 12.6 },
    ];
  }

  it('takes the label margin from the table under the header, not from prose further down', () => {
    // Six rows at x=42 under the first header, three under the second, then a
    // ten-line instruction paragraph at x=38. A page-global mode of the left
    // margins picks 38 for the second block and lays its grid over the
    // paragraph — at full confidence, because corroboration keys on the option
    // anchors, which the mistake does not touch.
    const items: PositionedText[] = [
      ...headerAt(306.2),
      ...[0, 1, 2, 3, 4, 5].map((r) => ({ text: `Check ${r}`, x: 42, y: 290 - r * 16, width: 60 })),
      ...headerAt(180),
      ...[0, 1, 2].map((r) => ({ text: `Later ${r}`, x: 42, y: 164 - r * 16, width: 60 })),
      ...Array.from({ length: 10 }, (_, r) => ({
        text: `Instruction line ${r}`, x: 38, y: 100 - r * 12, width: 400,
      })),
    ];

    const got = propose(items);

    expect(got.length).toBeGreaterThan(0);
    for (const p of got) {
      expect(p.segment.x).toBeCloseTo(42, 5);
    }
  });

  it('still refuses a numbered section heading printed just off the label margin', () => {
    // 37.5 vs 38.7 is 1.2pt apart — inside LABEL_MARGIN_TOLERANCE only if the
    // margin is rounded to an integer first.
    const items: PositionedText[] = [
      ...headerAt(306.2),
      { text: 'Engine oil level', x: 37.5, y: 290, width: 60 },
      { text: 'Park brake', x: 37.5, y: 274, width: 60 },
      { text: '4. Section heading', x: 38.7, y: 258, width: 80 },
      { text: 'Tyres', x: 37.5, y: 242, width: 60 },
      ...headerAt(180),
      { text: 'Steering', x: 37.5, y: 164, width: 60 },
      { text: 'Horn', x: 37.5, y: 148, width: 60 },
    ];

    const got = propose(items);

    expect(got.length).toBeGreaterThan(0);
    // Three item rows in the first block; the heading is not one of them.
    expect(got[0]!.segment.rowBands!).toHaveLength(3);
  });
});
