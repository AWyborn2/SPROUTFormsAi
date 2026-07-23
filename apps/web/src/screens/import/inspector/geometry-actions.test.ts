/**
 * Geometry panel decisions (U4, R7/R8/R9).
 *
 * The fixtures are the same measured page-7 header the derivation is tested
 * against, for the same reason: this code decides what a reviewer is allowed to
 * confirm, and evenly-spaced synthetic input would not exercise a single real
 * irregularity.
 */
import { describe, expect, it } from 'vitest';
import type { FormField, GroupOrdinal, PageBox } from '@formai/shared';
import { markPlacement, resolveGeometry } from '@formai/shared';
import type { PositionedText } from '../../../lib/pdf-geometry.js';
import {
  NEAR_EQUAL_CONFIDENCE,
  NUDGE_POINTS,
  SNAP_RANGE,
  columnHandles,
  type DerivableField,
  deriveAcrossPages,
  deriveForField,
  handleAdjustment,
  nudgedEdge,
  panelState,
  previewMarks,
  snapDrawnBox,
  snapEdge,
  snapTargets,
  snapTargetsY,
  unsupportedReason,
} from './geometry-actions.js';

const A4 = { width: 595, height: 842 };

/**
 * A repeating table field. Carries a 4-row `fixedRows` by default so it matches
 * the 4-row table in `pageText()` — a field with no row count AND no ordinal now
 * refuses (R3), so tests that want a derivation must give it an anchor. Pass
 * `fixedRows: undefined` to exercise the no-anchor refusal.
 */
function tableField(patch: Partial<FormField> & { groupOrdinal?: GroupOrdinal } = {}): DerivableField {
  return {
    type: 'repeating_group',
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'tick', label: '✓', type: 'boolean_yes_no' },
      { key: 'cross', label: '×', type: 'boolean_yes_no' },
      { key: 'na', label: 'N/A', type: 'boolean_yes_no' },
    ],
    fixedRows: ['r0', 'r1', 'r2', 'r3'],
    ...patch,
  };
}

/**
 * One occurrence of the measured page-7 table, shifted down the page by `dy`.
 * Stacking copies keeps them at identical x, so their headers corroborate the
 * same shape — the only way `proposeTableSegments` returns more than one
 * proposal for a page (a non-matching header is dropped as furniture).
 */
function measuredTable(dy: number, rows: number): PositionedText[] {
  return [
    { text: 'N/A', x: 539.9, y: 648.6 - dy, width: 13.3 },
    { text: 'During the demonstration, did the candidate:', x: 37.5, y: 647.7 - dy, width: 192 },
    { text: '', x: 502.6, y: 647.7 - dy, width: 7.1 },
    { text: '/ ×', x: 512.1, y: 647.7 - dy, width: 10.3 },
    ...Array.from({ length: rows }, (_, i) => ({
      text: `Row ${i}`,
      x: 37.5,
      y: 630.8 - dy - i * 16.8,
      width: 120,
    })),
  ];
}

/** Two occurrences of the measured page-7 table, so headers corroborate. */
function pageText(): PositionedText[] {
  return [...measuredTable(0, 4), ...measuredTable(200, 2)];
}

describe('unsupportedReason', () => {
  it('rejects a non-table field', () => {
    expect(unsupportedReason(tableField({ type: 'text' }))).toMatch(/Only a table/);
  });

  it('rejects a table with no option columns', () => {
    expect(unsupportedReason(tableField({ columns: [{ key: 'item', label: 'Item', type: 'text' }] }))).toMatch(
      /no option columns/,
    );
  });

  it('accepts a real option table', () => {
    expect(unsupportedReason(tableField())).toBeNull();
  });
});

describe('deriveForField', () => {
  it('derives a grid for a repeating table', () => {
    const proposal = deriveForField(tableField(), 6, pageText(), A4.width, A4.height);

    expect(proposal?.segment.columnBands?.map((b) => b.key)).toEqual(['tick', 'cross', 'na']);
  });

  it('returns nothing for a field that cannot carry a grid', () => {
    expect(deriveForField(tableField({ type: 'text' }), 6, pageText(), A4.width, A4.height)).toBeNull();
  });

  it('returns nothing when the page offers no proposal', () => {
    const prose: PositionedText[] = [
      { text: 'Just a sentence running across the page', x: 37.5, y: 600, width: 300 },
    ];

    expect(deriveForField(tableField(), 6, prose, A4.width, A4.height)).toBeNull();
  });

  it('picks the proposal whose row count matches the field, not merely the first', () => {
    // A page carries several tables and the derivation cannot say which belongs
    // to this field. Row count is the strongest available signal, and here the
    // 2-row table is the unique closest match — no rival ties it, so it derives.
    const field = tableField({ fixedRows: ['a', 'b'] });

    const proposal = deriveForField(field, 6, pageText(), A4.width, A4.height);

    expect(proposal?.segment.rowBands).toHaveLength(2);
  });

  it('refuses a field with no row count and no ordinal (R3/KTD3 — the FAULTS sliver)', () => {
    // An open blank-entry table has no row count, and with no split ordinal
    // there is nothing to tie it to any one table on the page. The old fallback
    // grabbed the highest-confidence proposal anywhere — a sliver from an
    // unrelated table. Refusing is the honest output.
    const field = tableField({ fixedRows: undefined });

    expect(deriveForField(field, 6, pageText(), A4.width, A4.height)).toBeNull();
  });
});

describe('table-aware selection: ordinal, then refuse-on-ambiguity (U2, R1/R2/R3)', () => {
  const split = (index: number, count: number): DerivableField =>
    tableField({ groupOrdinal: { index, count } });

  it('refuses ordinal-matching proposals that are vertically STACKED, not side-by-side (ADMN regression)', () => {
    // The regression this guards: three proposals arise only from STACKED tables
    // (`proposeTableSegments` returns more than one proposal only when copies
    // share an x column and their headers corroborate). On the real
    // `ADMN-FRM-111` those three are Categories A, B and C — three different
    // tables that merely NUMBER three, matching a 3-way split. Counting alone,
    // `3 === 3` fired and the ordinal mapped Category A's groups onto Categories
    // B and C — a grid on the wrong table. Side-by-side groups share a baseline
    // (same y, different x); these are the opposite, so every ordinal must
    // refuse rather than mis-place. Genuine per-group placement is deferred to
    // the per-group-proposal work — until then a split group refuses and is
    // hand-placed.
    const page = [...measuredTable(0, 4), ...measuredTable(200, 4), ...measuredTable(400, 4)];

    expect(deriveForField(split(0, 3), 0, page, A4.width, A4.height)).toBeNull();
    expect(deriveForField(split(1, 3), 0, page, A4.width, A4.height)).toBeNull();
    expect(deriveForField(split(2, 3), 0, page, A4.width, A4.height)).toBeNull();
  });

  it('refuses an ordinal with no matching set of blocks rather than indexing past the end', () => {
    // The page yields only two proposals, but the field was split into three
    // groups. There is no honest group-to-block mapping, so every ordinal
    // refuses instead of placing a grid on the wrong table.
    const page = pageText(); // two tables → two proposals

    expect(deriveForField(split(0, 3), 6, page, A4.width, A4.height)).toBeNull();
    expect(deriveForField(split(2, 3), 6, page, A4.width, A4.height)).toBeNull();
  });

  it('Covers AE3. refuses when two identical tables match a no-ordinal field equally', () => {
    // Two corroborated 4-row tables at full, identical confidence. A field with
    // the same row count and no ordinal cannot tell them apart — a coin-flip on
    // table identity, so it refuses (R1/KTD2).
    const page = [...measuredTable(0, 4), ...measuredTable(200, 4)];
    const field = tableField({ fixedRows: ['a', 'b', 'c', 'd'] });

    expect(deriveForField(field, 6, page, A4.width, A4.height)).toBeNull();
  });

  it('Covers AE4. still derives when one table is the unique row-count match (no false refusal)', () => {
    // The 4-row and 2-row tables are different shapes; a field wanting four rows
    // has exactly one closest match, so it derives as before — the refusal must
    // not fire on a genuine single winner (R5).
    const field = tableField({ fixedRows: ['a', 'b', 'c', 'd'] });

    const proposal = deriveForField(field, 6, pageText(), A4.width, A4.height);

    expect(proposal).not.toBeNull();
    expect(proposal!.segment.rowBands).toHaveLength(4);
  });

  it('the near-equal band is positive and below the smallest genuine-winner separation', () => {
    // Reachable same-row-count rivals on one page are equi-confident (0.0 apart:
    // matching headers corroborate to the same score, non-matching ones are
    // dropped), so the band need only be > 0 to refuse every real tie. It is
    // also held below 0.2 — a corroborated winner over an uncorroborated rival —
    // so a genuine winner would still derive.
    expect(NEAR_EQUAL_CONFIDENCE).toBeGreaterThan(0);
    expect(NEAR_EQUAL_CONFIDENCE).toBeLessThan(0.2);
  });
});

describe('panelState', () => {
  const derived = () => deriveForField(tableField(), 6, pageText(), A4.width, A4.height);

  it('reports unsupported for a scalar field', () => {
    const state = panelState(tableField({ type: 'text' }), undefined, false, null);

    expect(state.kind).toBe('unsupported');
  });

  it('explains that publishing still works when nothing is proposed', () => {
    // Refusing is a normal outcome, not a failure, and the panel must not read
    // like an error — a reviewer who thinks the import broke will go looking
    // for a problem that is not there.
    const state = panelState(tableField(), undefined, false, null);

    expect(state.kind).toBe('no-proposal');
    if (state.kind === 'no-proposal') {
      expect(state.reason).toMatch(/still publishes/);
    }
  });

  it('surfaces a proposal as unconfirmed by default (R8)', () => {
    const proposal = derived()!;

    const state = panelState(tableField(), proposal.segment, false, proposal);

    expect(state.kind).toBe('proposed');
    if (state.kind === 'proposed') {
      expect(state.confirmed).toBe(false);
      expect(state.confidence).toBe(1);
    }
  });

  it('carries the derivation notes so the reviewer knows what to check', () => {
    // Only the first table — the second sits at y 414-449, so a looser cut
    // would leave it in and the header would still be corroborated.
    const single: PositionedText[] = pageText().filter((i) => i.y > 500);
    const proposal = deriveForField(tableField(), 6, single, A4.width, A4.height)!;

    const state = panelState(tableField(), proposal.segment, false, proposal);

    if (state.kind === 'proposed') {
      expect(state.notes.join(' ')).toMatch(/cross-checked/);
      expect(state.confidence).toBeLessThan(1);
    }
  });

  it('reports a confirmed proposal as confirmed', () => {
    const proposal = derived()!;

    const state = panelState(tableField(), proposal.segment, true, proposal);

    if (state.kind === 'proposed') expect(state.confirmed).toBe(true);
  });
});

describe('deriveAcrossPages', () => {
  /*
    A model-extracted table carries no `sourcePosition` — only AcroForm fields
    get one — so there is no page to start from. Deriving against page 0 would
    place an eighteen-page assessment's table on its cover sheet.
  */
  const blank = { items: [], width: A4.width, height: A4.height };
  const withTable = { items: pageText(), width: A4.width, height: A4.height };

  it('finds the table on a later page, not just page 0', () => {
    const got = deriveAcrossPages(tableField(), [blank, blank, withTable]);
    expect(got).not.toBeNull();
    expect(got!.segment.page).toBe(2);
  });

  it('returns null when no page yields a proposal', () => {
    expect(deriveAcrossPages(tableField(), [blank, blank])).toBeNull();
  });

  it('returns null for a field that cannot carry a grid at all', () => {
    expect(deriveAcrossPages(tableField({ type: 'text' }), [withTable])).toBeNull();
  });

  it('keeps the earlier page when two pages tie', () => {
    // A table continued across a page break should anchor where it starts.
    const got = deriveAcrossPages(tableField(), [withTable, withTable]);
    expect(got!.segment.page).toBe(0);
  });

  it('carries each page its OWN size, so a mixed-orientation document still derives', () => {
    // Landscape first, portrait second. If the first page's size leaked into
    // the second, the segment box would be measured against the wrong extent.
    const landscape = { items: [], width: A4.height, height: A4.width };
    const got = deriveAcrossPages(tableField(), [landscape, withTable]);
    expect(got!.segment.page).toBe(1);
    expect(got!.segment.pageWidth).toBe(A4.width);
    expect(got!.segment.pageHeight).toBe(A4.height);
  });

  it('is empty-safe before the viewer has read the PDF', () => {
    expect(deriveAcrossPages(tableField(), [])).toBeNull();
  });
});

describe('snapping a dragged edge to the printed page (U10, R19)', () => {
  /**
   * `ADMN-FRM-111`'s three option-header groups as measured, at y=306.2. These
   * are the six places a reviewer needs to be able to drag a band to; the
   * derivation only ever offers the rightmost pair.
   */
  const OPTION_HEADERS: PositionedText[] = [
    { text: 'OK', x: 164.5, y: 306.2, width: 12.2 },
    { text: 'NA', x: 192.7, y: 306.2, width: 12.6 },
    { text: 'OK', x: 345.7, y: 306.2, width: 12.2 },
    { text: 'NA', x: 371.1, y: 306.2, width: 12.6 },
    { text: 'OK', x: 512.6, y: 306.2, width: 12.2 },
    { text: 'NA', x: 540.7, y: 306.2, width: 12.6 },
  ];

  it('offers both edges of every printed run', () => {
    const targets = snapTargets(OPTION_HEADERS);

    // Left edge of the leftmost OK and right edge of the rightmost NA — the
    // two ends of the reachable range.
    expect(targets[0]).toBeCloseTo(164.5, 5);
    expect(targets[targets.length - 1]).toBeCloseTo(553.3, 5);
    expect(targets).toHaveLength(12);
  });

  it('reaches the groups the derivation never proposes', () => {
    // proposeTableSegments isolates the RIGHTMOST cluster by design, so its
    // bands know 512.6/540.7 and nothing about the two groups to the left.
    const targets = snapTargets(OPTION_HEADERS);

    expect(targets).toContain(164.5);
    expect(targets).toContain(345.7);
  });

  it('collapses a column of items printed at one x into a single target', () => {
    const column: PositionedText[] = [0, 1, 2, 3].map((r) => ({
      text: 'OK', x: 164.5, y: 306.2 - r * 16, width: 12.2,
    }));

    expect(snapTargets(column)).toEqual([164.5, 176.7]);
  });

  it('pulls a rough drag onto the printed column, not the pointer coordinate', () => {
    const targets = snapTargets(OPTION_HEADERS);

    // A drag that lands 3pt short of the middle group's OK.
    expect(snapEdge(342.4, targets)).toBeCloseTo(345.7, 5);
  });

  it('takes the nearest target when two are in range', () => {
    const targets = snapTargets(OPTION_HEADERS);

    // 371.1 (NA left edge) and 357.9 (OK right edge) are both within range of
    // 366; the nearer one wins.
    expect(snapEdge(366, targets)).toBeCloseTo(371.1, 5);
  });

  it('leaves a drag with nothing near it exactly where it was put', () => {
    const targets = snapTargets(OPTION_HEADERS);

    // Mid-gutter, 30pt from anything printed. Jumping to a distant column here
    // would be the overshoot the step buttons exist to avoid.
    expect(snapEdge(280, targets)).toBe(280);
  });

  it('is empty-safe before the viewer has read the page', () => {
    expect(snapTargets([])).toEqual([]);
    expect(snapEdge(280, [])).toBe(280);
  });

  it('snaps within one option glyph and no further', () => {
    // SNAP_RANGE is one option glyph wide (OK 12.2, NA 12.6, dozer N/A 13.3):
    // inside a glyph's own width the reviewer meant that glyph.
    expect(snapEdge(164.5 - SNAP_RANGE + 0.5, [164.5])).toBe(164.5);
    expect(snapEdge(164.5 - SNAP_RANGE - 0.5, [164.5])).toBe(164.5 - SNAP_RANGE - 0.5);
  });

  it('still steps by 1pt after a snap, for when snapping picks wrong', () => {
    // Snapping is gross placement; the buttons remain the fine correction.
    expect(NUDGE_POINTS).toBe(1);
    expect(snapEdge(345.7 + NUDGE_POINTS, [345.7], 0)).toBe(345.7 + NUDGE_POINTS);
  });
});

describe('column handles are one per boundary, not two per band (U10 review)', () => {
  // Contiguous, as centresToBands produces them: each band's end IS the next
  // band's start.
  const BANDS = [
    { key: 'tick', start: 496, end: 511.7 },
    { key: 'cross', start: 511.7, end: 531.9 },
    { key: 'na', start: 531.9, end: 556.7 },
  ];

  it('gives one handle per edge, not one per band edge', () => {
    // Two per band would be six, two of them stacked exactly on top of two
    // others — the later sibling wins hit-testing, so tick's right edge and
    // cross's right edge could never be grabbed at all.
    const handles = columnHandles(BANDS);

    expect(handles).toHaveLength(4);
    expect(handles.map((h) => h.at)).toEqual([496, 511.7, 531.9, 556.7]);
  });

  it('makes an interior handle own BOTH bands it separates', () => {
    const [, between] = columnHandles(BANDS);

    expect(between).toMatchObject({ left: 'tick', right: 'cross' });
  });

  it('makes the outer handles own one band each', () => {
    const handles = columnHandles(BANDS);

    expect(handles[0]).toMatchObject({ right: 'tick' });
    expect(handles[0]!.left).toBeUndefined();
    expect(handles[3]).toMatchObject({ left: 'na' });
    expect(handles[3]!.right).toBeUndefined();
  });

  it('orders by position even when the bands are not', () => {
    const handles = columnHandles([BANDS[2]!, BANDS[0]!, BANDS[1]!]);

    expect(handles.map((h) => h.at)).toEqual([496, 511.7, 531.9, 556.7]);
  });

  it('gives a single band its two outer edges', () => {
    expect(columnHandles([BANDS[0]!]).map((h) => h.at)).toEqual([496, 511.7]);
  });

  it('is empty-safe', () => {
    expect(columnHandles([])).toEqual([]);
  });
});

describe('keyboard nudge on a focused band edge (U1, R1/AE1)', () => {
  // Contiguous, as centresToBands produces them.
  const BANDS = [
    { key: 'tick', start: 496, end: 511.7 },
    { key: 'cross', start: 511.7, end: 531.9 },
    { key: 'na', start: 531.9, end: 556.7 },
  ];

  it('moves a focused edge by exactly one NUDGE_POINTS step, right and left', () => {
    const leftEdge = columnHandles(BANDS)[0]!;

    expect(nudgedEdge(leftEdge, 1)).toBeCloseTo(leftEdge.at + NUDGE_POINTS, 5);
    expect(nudgedEdge(leftEdge, -1)).toBeCloseTo(leftEdge.at - NUDGE_POINTS, 5);
  });

  it('resolves an outer handle to the same single-band edge the stepper button drives', () => {
    const handles = columnHandles(BANDS);
    const leftEdge = handles[0]!;
    const rightEdge = handles[handles.length - 1]!;

    // The left-most handle owns `tick`'s START — identical to the button path's
    // adjustGeometryBand(field, 'column', 'tick', 'start', tick.start ± 1).
    expect(handleAdjustment(leftEdge)).toEqual({ kind: 'edge', key: 'tick', edge: 'start' });
    expect(nudgedEdge(leftEdge, 1)).toBeCloseTo(496 + NUDGE_POINTS, 5);

    // The right-most handle owns `na`'s END.
    expect(handleAdjustment(rightEdge)).toEqual({ kind: 'edge', key: 'na', edge: 'end' });
    expect(nudgedEdge(rightEdge, -1)).toBeCloseTo(556.7 - NUDGE_POINTS, 5);
  });

  it('resolves an interior handle to the boundary that moves BOTH adjacent bands', () => {
    const between = columnHandles(BANDS)[1]!;

    // One coordinate written to both bands' shared edge — no gap a tick can fall
    // into, matching the boundary-drag behaviour (adjustGeometryBoundary).
    expect(handleAdjustment(between)).toEqual({ kind: 'boundary', leftKey: 'tick', rightKey: 'cross' });
    expect(nudgedEdge(between, 1)).toBeCloseTo(511.7 + NUDGE_POINTS, 5);
  });
});

describe('live glyph preview marks (U3, R2/R3/AE2/AE5)', () => {
  const segment: PageBox = {
    page: 0,
    x: 40,
    y: 400,
    width: 300,
    height: 80,
    pageWidth: 600,
    pageHeight: 800,
    columnBands: [
      { key: 'item', start: 40, end: 240 },
      { key: 'tick', start: 240, end: 290 },
      { key: 'cross', start: 290, end: 340 },
    ],
    rowBands: [
      { key: 'r0', start: 440, end: 480 },
      { key: 'r1', start: 400, end: 440 },
    ],
  };

  it('emits one representative mark per row × column cell', () => {
    expect(previewMarks(segment)).toHaveLength(3 * 2);
  });

  it('positions every mark at markPlacement for its cell — preview and export cannot drift', () => {
    for (const m of previewMarks(segment)) {
      const row = segment.rowBands!.find((b) => b.key === m.rowKey)!;
      const col = segment.columnBands!.find((b) => b.key === m.columnKey)!;

      expect({ x: m.x, y: m.y, size: m.size }).toEqual(markPlacement(row, col));
    }
  });

  it('renders nothing for a segment with no columns or no rows (a field with no grid)', () => {
    expect(previewMarks({ ...segment, columnBands: [] })).toEqual([]);
    expect(previewMarks({ ...segment, rowBands: [] })).toEqual([]);
    expect(previewMarks({ ...segment, columnBands: undefined, rowBands: undefined })).toEqual([]);
  });

  it('tracks a moved band — a cell mark follows its column edge (AE5)', () => {
    const cell = (marks: ReturnType<typeof previewMarks>) =>
      marks.find((m) => m.columnKey === 'tick' && m.rowKey === 'r0')!;

    const before = cell(previewMarks(segment));
    const moved: PageBox = {
      ...segment,
      columnBands: segment.columnBands!.map((b) => (b.key === 'tick' ? { ...b, start: 250 } : b)),
    };

    // start 240 → 250 shifts this cell's mark 10pt right, nothing else needed.
    expect(cell(previewMarks(moved)).x).toBeCloseTo(before.x + 10, 5);
  });
});

describe('snapTargets survives a degenerate pdfjs measurement (U10 review)', () => {
  it('drops a non-finite run instead of poisoning every target', () => {
    // One NaN sorts in place, then `e - NaN > 0.5` is false for everything
    // after it — the whole list collapses to [NaN], every snap returns NaN, the
    // validator refuses every move, and dragging is silently dead on that page.
    const items: PositionedText[] = [
      { text: 'bad', x: Number.NaN, y: 306.2, width: 12.2 },
      { text: 'OK', x: 164.5, y: 306.2, width: Number.POSITIVE_INFINITY },
      { text: 'NA', x: 192.7, y: 306.2, width: 12.6 },
    ];

    const targets = snapTargets(items);

    expect(targets).toHaveLength(2);
    expect(targets[0]).toBeCloseTo(192.7, 5);
    expect(targets[1]).toBeCloseTo(205.3, 5);
    expect(snapEdge(190, targets)).toBe(192.7);
  });
});

describe('draw-a-box: snap a dragged rectangle to the page (U1, R1)', () => {
  // ADMN-FRM-111 scalar-cell anchors (measured): the Date value cell sits to the
  // right of the "Date" label at x=37.5; printed run edges nearby give the snap
  // targets a rough drag lands on.
  const items: PositionedText[] = [
    { text: 'Date', x: 37.5, y: 306, width: 22 },
    { text: 'Asset No', x: 250, y: 306, width: 40 },
    { text: 'Site', x: 460, y: 306, width: 20 },
    { text: 'HRS/KMS', x: 37.5, y: 288, width: 44 },
  ];
  const page = { page: 0, pageWidth: 595.32, pageHeight: 419.52 };

  it('snaps each edge of a rough drag onto the nearest printed edge', () => {
    const xs = snapTargets(items);
    const ys = snapTargetsY(items);
    // A sloppy drag near the Asset No cell: left ~3pt off 290 (Asset No right
    // edge), right ~2pt off 460 (Site left edge), bottom near the 288 baseline.
    const box = snapDrawnBox({ x: 293, y: 290 }, { x: 458, y: 305 }, page, xs, ys);

    expect(box.x).toBeCloseTo(290, 5); // Asset No right edge
    expect(box.x + box.width).toBeCloseTo(460, 5); // Site left edge
    expect(box.y).toBeCloseTo(288, 5); // HRS/KMS baseline
    expect(box.columnBands).toBeUndefined(); // a scalar placement box has no bands
  });

  it('normalises an inverted drag (released up-and-left of the start)', () => {
    const box = snapDrawnBox({ x: 400, y: 310 }, { x: 200, y: 250 }, page, [], []);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBe(200);
    expect(box.y).toBe(250);
  });

  it('clamps a drag that runs off the page', () => {
    const box = snapDrawnBox({ x: -50, y: -20 }, { x: 9000, y: 9000 }, page, [], []);
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.x + box.width).toBeCloseTo(page.pageWidth, 5);
    expect(box.y + box.height).toBeCloseTo(page.pageHeight, 5);
  });

  it('does not let a snap collapse an axis onto one target', () => {
    // Both edges within range of the same single target (100). Snapping both
    // would give a zero-width box; the axis must keep the raw drag instead.
    const box = snapDrawnBox({ x: 98, y: 200 }, { x: 104, y: 260 }, page, [100], []);
    expect(box.width).toBeGreaterThanOrEqual(1);
  });

  it('produces a box the shipped validator accepts', () => {
    const box = snapDrawnBox({ x: 100, y: 100 }, { x: 200, y: 140 }, page, [], []);
    expect(resolveGeometry({ geometry: { segments: [box] } }, 1).segments).toHaveLength(1);
  });

  it('snapTargetsY dedupes baselines and drops non-finite ys', () => {
    const rows: PositionedText[] = [
      { text: 'a', x: 10, y: 300, width: 5 },
      { text: 'b', x: 80, y: 300, width: 5 }, // same baseline → one target
      { text: 'c', x: 10, y: 284, width: 5 },
      { text: 'bad', x: 10, y: Number.NaN, width: 5 },
    ];
    expect(snapTargetsY(rows)).toEqual([284, 300]);
  });
});
