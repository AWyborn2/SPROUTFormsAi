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
import type { FieldProposal, PositionedText, TableProposal, TextPage } from '../../../lib/pdf-geometry.js';
import { proposeFieldOptionCells, proposeMatchAnchorCells } from '../../../lib/pdf-geometry.js';
import {
  pageWindowOf,
  windowVerdict,
  WINDOW_CONFIDENCE_CAP,
  WINDOW_MARGIN_PAGES,
  NEAR_EQUAL_CONFIDENCE,
  NUDGE_POINTS,
  SNAP_RANGE,
  DRAW_SNAP_RANGE,
  appendRowBelow,
  applyFieldChanges,
  applyMatrix,
  retargetPageChanges,
  classifyProposalTier,
  columnHandles,
  type FieldChange,
  deleteRowBand,
  type DerivableField,
  deriveAcrossPages,
  deriveForField,
  deriveOptionCellsAcrossPages,
  evenGrid,
  handleAdjustment,
  itemsInBox,
  matrixMultiply,
  moveBand,
  moveBoundary,
  nudgedEdge,
  panelState,
  previewMarks,
  rowHandles,
  rulesFromSegments,
  segmentsFromDrawOps,
  snapDrawnBox,
  snapEdge,
  snapTargets,
  snapTargetsY,
  splitRowBand,
  subdivideBox,
  unsupportedReason,
  moveSegment,
  keyMove,
  isDeleteKey,
  removeSegment,
  replaceSegmentOnPage,
  NUDGE_POINTS_COARSE,
  clampDelta,
  nudgeStep,
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
  it('does NOT reject a non-table field — a scalar is draw-only, not unsupported (U2/R9)', () => {
    // A scalar has no derived grid, but it can carry a hand-drawn placement box,
    // so it is no longer a hard block — `panelState` routes it to `draw-only`.
    expect(unsupportedReason(tableField({ type: 'text' }))).toBeNull();
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

  it('reports draw-only for a scalar field, with no derivation offered (U2/R9/R5)', () => {
    const state = panelState(tableField({ type: 'text' }), undefined, false, null);

    expect(state.kind).toBe('draw-only');
    if (state.kind === 'draw-only') {
      // Names drawing a box, never a column grid, and reassures publishing works.
      expect(state.reason).toMatch(/Draw a box/);
      expect(state.reason).not.toMatch(/grid/);
      expect(state.reason).toMatch(/still publishes/);
    }
  });

  it('reports unsupported for a table whose extraction captured no option columns', () => {
    const state = panelState(
      tableField({ columns: [{ key: 'item', label: 'Item', type: 'text' }] }),
      undefined,
      false,
      null,
    );

    expect(state.kind).toBe('unsupported');
  });

  it('surfaces a proposed scalar box (no bands) as a confirmable proposal', () => {
    // A scalar's proposal is a band-less PageBox — the same `proposed` state a
    // table uses, so it gets confirm/adjust; there is simply no grid to nudge.
    const box: PageBox = {
      page: 0,
      x: 100,
      y: 200,
      width: 120,
      height: 16,
      pageWidth: 595,
      pageHeight: 842,
    };
    const state = panelState(tableField({ type: 'text' }), box, false, null);

    expect(state.kind).toBe('proposed');
    if (state.kind === 'proposed') {
      expect(state.segment.columnBands).toBeUndefined();
      expect(state.confirmed).toBe(false);
    }
    // …and that band-less box is valid geometry the publish boundary accepts.
    expect(resolveGeometry({ geometry: { segments: [box] } }, 1).segments).toHaveLength(1);
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

describe('classifyProposalTier', () => {
  // A minimal box — its geometry is irrelevant here, only `confidence` is under
  // test — reused for both proposal shapes so the fixtures stay tiny.
  const box: PageBox = { page: 0, x: 0, y: 0, width: 10, height: 10, pageWidth: 595, pageHeight: 842 };
  const tableProposal = (confidence: number): TableProposal => ({
    segment: box,
    confidence,
    anchorsLocated: 2,
    anchorsInferred: 0,
    notes: [],
  });
  const fieldProposal = (confidence: number): FieldProposal => ({
    segments: [box],
    confidence,
    notes: [],
  });

  it('classifies a null proposal as no-match', () => {
    expect(classifyProposalTier(null)).toBe('no-match');
  });

  it('classifies confidence 1 as auto-confirm, for both proposal shapes', () => {
    expect(classifyProposalTier(tableProposal(1))).toBe('auto-confirm');
    expect(classifyProposalTier(fieldProposal(1))).toBe('auto-confirm');
  });

  it('classifies anything below 1 as needs-review, for both proposal shapes', () => {
    expect(classifyProposalTier(tableProposal(0.6))).toBe('needs-review');
    expect(classifyProposalTier(tableProposal(0.99))).toBe('needs-review');
    expect(classifyProposalTier(fieldProposal(0.6))).toBe('needs-review');
    expect(classifyProposalTier(fieldProposal(0.99))).toBe('needs-review');
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

describe('row handles are one per boundary, not two per band (U3)', () => {
  // Contiguous in y, as centresToBands produces them: each band's end IS the
  // next band's start. `start`/`end` are the band's bottom/top y (bottom-up).
  const BANDS = [
    { key: 'r0', start: 400, end: 440 },
    { key: 'r1', start: 440, end: 480 },
    { key: 'r2', start: 480, end: 524 },
  ];

  it('gives one handle per edge, not one per band edge', () => {
    const handles = rowHandles(BANDS);

    expect(handles).toHaveLength(4);
    expect(handles.map((h) => h.at)).toEqual([400, 440, 480, 524]);
  });

  it('makes an interior handle own BOTH bands it separates', () => {
    const [, between] = rowHandles(BANDS);

    expect(between).toMatchObject({ left: 'r0', right: 'r1' });
  });

  it('makes the outer handles own one band each', () => {
    const handles = rowHandles(BANDS);

    expect(handles[0]).toMatchObject({ right: 'r0' });
    expect(handles[0]!.left).toBeUndefined();
    expect(handles[3]).toMatchObject({ left: 'r2' });
    expect(handles[3]!.right).toBeUndefined();
  });

  it('orders by position even when the bands are not', () => {
    const handles = rowHandles([BANDS[2]!, BANDS[0]!, BANDS[1]!]);

    expect(handles.map((h) => h.at)).toEqual([400, 440, 480, 524]);
  });

  it('gives a single band its two outer edges', () => {
    expect(rowHandles([BANDS[0]!]).map((h) => h.at)).toEqual([400, 440]);
  });

  it('resolves outer/interior handles to the same adjustments the row steppers drive', () => {
    const handles = rowHandles(BANDS);
    // Bottom handle owns r0's START; top handle owns r2's END — the button path's
    // adjustGeometryBand(field, 'row', key, 'start'|'end', ...).
    expect(handleAdjustment(handles[0]!)).toEqual({ kind: 'edge', key: 'r0', edge: 'start' });
    expect(handleAdjustment(handles[3]!)).toEqual({ kind: 'edge', key: 'r2', edge: 'end' });
    // Interior handle writes both bands' shared edge — adjustGeometryBoundary.
    expect(handleAdjustment(handles[1]!)).toEqual({ kind: 'boundary', leftKey: 'r0', rightKey: 'r1' });
    expect(nudgedEdge(handles[1]!, 1)).toBeCloseTo(440 + NUDGE_POINTS, 5);
  });

  it('is empty-safe', () => {
    expect(rowHandles([])).toEqual([]);
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

describe('bounded subdivision inside a drawn box (U4, R4/R7/AE5/AE6)', () => {
  // Two structurally identical OK/NA groups printed side by side on ONE page,
  // sharing the header baseline (y=306) and every row baseline — the shape the
  // collision fix (2026-07-23-007) refuses page-wide, because `rightmostCluster`
  // would take whichever group sits furthest right. The reviewer's box is what
  // says WHICH group this field is, so detection must run over only the runs
  // inside it.
  const OK_NA = [
    { key: 'item', label: 'Item', type: 'text' as const },
    { key: 'ok', label: 'OK', type: 'boolean_yes_no' as const },
    { key: 'na', label: 'NA', type: 'boolean_yes_no' as const },
  ];

  /** One 4-row OK/NA group whose label column starts at `x0`. */
  function group(x0: number): PositionedText[] {
    return [
      { text: 'Checklist', x: x0, y: 306, width: 60 },
      { text: 'OK', x: x0 + 80, y: 306, width: 12 },
      { text: 'NA', x: x0 + 110, y: 306, width: 12 },
      ...Array.from({ length: 4 }, (_, i) => ({ text: `Item ${i}`, x: x0, y: 290 - i * 16, width: 40 })),
    ];
  }

  // Left group at x=40 (options 120/150), right group at x=270 (options 350/380).
  // Neither fits on a 595pt page beside the dozer's full-width table, which is
  // exactly the compact 3-up shape ADMN-FRM-111 prints.
  const sideBySide = (): PositionedText[] => [...group(40), ...group(270)];

  const leftBox: PageBox = { page: 0, x: 20, y: 220, width: 180, height: 100, pageWidth: 595, pageHeight: 842 };
  const rightBox: PageBox = { page: 0, x: 250, y: 220, width: 180, height: 100, pageWidth: 595, pageHeight: 842 };

  it('keeps only the runs whose midpoint is inside the box (AE5 scoping primitive)', () => {
    const inside = itemsInBox(sideBySide(), leftBox);

    // The left group's header (3) plus its 4 rows — and nothing from the right.
    expect(inside).toHaveLength(7);
    expect(inside.every((i) => i.x < 250)).toBe(true);
  });

  it('Covers AE5. detects the boxed group’s columns from inside-box glyphs only', () => {
    const result = subdivideBox({ box: leftBox, items: sideBySide(), columns: OK_NA, wantRows: 4 });

    expect(result).not.toBeNull();
    expect(result!.segment.columnBands?.map((b) => b.key)).toEqual(['ok', 'na']);
    // Every band sits in the LEFT group — the right group at x≥350 contributed
    // nothing, which is the whole point of scoping to the drawn box.
    expect(Math.max(...result!.segment.columnBands!.map((b) => b.end))).toBeLessThan(250);
    expect(result!.segment.rowBands).toHaveLength(4);
  });

  it('the SAME page, boxed around the other group, detects THAT group instead', () => {
    // Proof the box — not the page — selects the table: page-wide derivation
    // would always take the rightmost cluster, but the left box gave the left
    // group and the right box gives the right one.
    const result = subdivideBox({ box: rightBox, items: sideBySide(), columns: OK_NA, wantRows: 4 });

    expect(result).not.toBeNull();
    expect(Math.min(...result!.segment.columnBands!.map((b) => b.start))).toBeGreaterThan(250);
  });

  it('Covers AE6. returns null over a region with no detectable table', () => {
    const prose: PositionedText[] = [{ text: 'A sentence running across the page', x: 40, y: 280, width: 220 }];

    expect(subdivideBox({ box: leftBox, items: prose, columns: OK_NA })).toBeNull();
  });

  it('returns null when the box encloses nothing', () => {
    expect(subdivideBox({ box: leftBox, items: [], columns: OK_NA })).toBeNull();
    const empty: PageBox = { ...leftBox, x: 560, width: 20 }; // off to the side of everything
    expect(subdivideBox({ box: empty, items: sideBySide(), columns: OK_NA })).toBeNull();
  });

  it('the detected grid survives the shipped validator (R6)', () => {
    const result = subdivideBox({ box: leftBox, items: sideBySide(), columns: OK_NA, wantRows: 4 })!;

    expect(resolveGeometry({ geometry: { segments: [result.segment] } }, 1).segments).toHaveLength(1);
  });
});

describe('manual even-seed fallback and row dividers (U4, R4/AE6)', () => {
  const box: PageBox = { page: 0, x: 100, y: 200, width: 300, height: 120, pageWidth: 595, pageHeight: 842 };

  it('splits the box into N option columns, reserving the leftmost for the label', () => {
    const grid = evenGrid(box, ['ok', 'na'], ['r0', 'r1', 'r2']);

    // Three equal parts across 300pt; the label takes parts[0] (100–200), the
    // two options take 200–300 and 300–400.
    expect(grid.columnBands?.map((b) => b.key)).toEqual(['ok', 'na']);
    expect(grid.columnBands![0]!.start).toBeCloseTo(200, 5);
    expect(grid.columnBands![0]!.end).toBeCloseTo(300, 5);
    expect(grid.columnBands![1]!.end).toBeCloseTo(400, 5); // the box's right edge
  });

  it('bands EVERY column across the full width when no label is reserved (open table)', () => {
    // An open row-entry table: all three columns are fillable, so all three get
    // bands spanning the box left-to-right — no phantom leftmost label part.
    const grid = evenGrid(box, ['wo', 'plant', 'hours'], ['r0'], false);

    expect(grid.columnBands?.map((b) => b.key)).toEqual(['wo', 'plant', 'hours']);
    // 300pt / 3 = 100pt each, starting at the box's own left edge (100).
    expect(grid.columnBands![0]!.start).toBeCloseTo(100, 5);
    expect(grid.columnBands![0]!.end).toBeCloseTo(200, 5);
    expect(grid.columnBands![2]!.end).toBeCloseTo(400, 5); // the box's right edge
    // The first column now carries a band, so the exporter can place its value.
    expect(resolveGeometry({ geometry: { segments: [grid] } }, 1).segments).toHaveLength(1);
  });

  it('divides the height evenly with r0 the TOP row (matches the exporter’s order)', () => {
    const grid = evenGrid(box, ['ok', 'na'], ['r0', 'r1', 'r2']);

    expect(grid.rowBands).toHaveLength(3);
    // Top of the box is y = 200 + 120 = 320; the top row's band reaches it.
    expect(grid.rowBands![0]!.end).toBeCloseTo(320, 5);
    expect(grid.rowBands![0]!.start).toBeCloseTo(280, 5);
    // Bottom row reaches the box's bottom edge.
    expect(grid.rowBands![2]!.start).toBeCloseTo(200, 5);
  });

  it('seeds a grid the validator accepts, then each divider snaps onto a printed line', () => {
    const grid = evenGrid(box, ['ok', 'na'], ['r0', 'r1', 'r2']);
    expect(resolveGeometry({ geometry: { segments: [grid] } }, 1).segments).toHaveLength(1);

    // The seed is scaffolding — a seeded edge at 200 snaps onto a printed run at
    // 205 exactly as a derived edge would (R4).
    expect(snapEdge(grid.columnBands![0]!.start, [205])).toBeCloseTo(205, 5);
  });

  it('adds a row divider by splitting one band in two, re-keyed top-to-bottom', () => {
    const grid = evenGrid(box, ['ok', 'na'], ['r0', 'r1']);

    const split = splitRowBand(grid, 'r0');

    expect(split.rowBands).toHaveLength(3);
    expect(split.rowBands!.map((b) => b.key)).toEqual(['r0', 'r1', 'r2']);
    // Still contiguous and in range.
    const sorted = [...split.rowBands!].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start).toBeCloseTo(sorted[i - 1]!.end, 5);
    expect(resolveGeometry({ geometry: { segments: [split] } }, 1).segments).toHaveLength(1);
  });

  it('deletes a row divider by closing the gap, keeping the grid contiguous', () => {
    const grid = splitRowBand(evenGrid(box, ['ok', 'na'], ['r0', 'r1']), 'r0'); // 3 rows

    const del = deleteRowBand(grid, 'r1');

    expect(del.rowBands).toHaveLength(2);
    const sorted = [...del.rowBands!].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start).toBeCloseTo(sorted[i - 1]!.end, 5);
    expect(resolveGeometry({ geometry: { segments: [del] } }, 1).segments).toHaveLength(1);
  });

  it('refuses to delete the only row — a table needs at least one', () => {
    const grid = evenGrid(box, ['ok'], ['r0']);

    expect(deleteRowBand(grid, 'r0').rowBands).toHaveLength(1);
  });

  describe('appendRowBelow — extend the table down with even spacing', () => {
    it('adds one row of the same height directly below the bottom row', () => {
      // 3 even rows over 120pt → 40pt each; box spans y 200–320.
      const grid = evenGrid(box, ['ok', 'na'], ['r0', 'r1', 'r2']);
      const next = appendRowBelow(grid);

      expect(next.rowBands).toHaveLength(4);
      // The new bottom row is 40pt tall and sits directly under the old bottom
      // (which reached y=200), so it spans 160–200.
      const sorted = [...next.rowBands!].sort((a, b) => a.start - b.start);
      expect(sorted[0]!.start).toBeCloseTo(160, 5);
      expect(sorted[0]!.end).toBeCloseTo(200, 5);
      // Every row stays 40pt — the spacing is preserved, not halved.
      for (const b of sorted) expect(b.end - b.start).toBeCloseTo(40, 5);
    });

    it('grows the segment box downward to contain the new row and re-keys top-to-bottom', () => {
      const grid = evenGrid(box, ['ok', 'na'], ['r0', 'r1']); // 60pt rows, y 200–320
      const next = appendRowBelow(grid);

      expect(next.y).toBeCloseTo(140, 5); // 200 - 60
      expect(next.height).toBeCloseTo(180, 5); // 320 - 140
      expect(next.rowBands!.map((b) => b.key)).toEqual(['r0', 'r1', 'r2']);
      // Contiguous and accepted by the shipped validator.
      const sorted = [...next.rowBands!].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start).toBeCloseTo(sorted[i - 1]!.end, 5);
      expect(resolveGeometry({ geometry: { segments: [next] } }, 1).segments).toHaveLength(1);
    });

    it('clamps the new row to the page bottom, leaving the box unchanged when there is no room', () => {
      // A grid whose bottom row already sits on the page bottom (y=0).
      const atFloor: PageBox = { page: 0, x: 100, y: 0, width: 300, height: 40, pageWidth: 595, pageHeight: 842 };
      const grid = evenGrid(atFloor, ['ok'], ['r0']);

      expect(appendRowBelow(grid)).toEqual(grid);
    });
  });
});

describe('panelState routes a drawn table box to subdivision (U4)', () => {
  it('a table with a drawn box but no grid needs subdivision, not confirmation', () => {
    const box: PageBox = { page: 0, x: 40, y: 400, width: 200, height: 80, pageWidth: 595, pageHeight: 842 };

    const state = panelState(tableField(), box, false, null);

    expect(state.kind).toBe('needs-subdivision');
    if (state.kind === 'needs-subdivision') {
      expect(state.box).toBe(box);
      expect(state.reason).toMatch(/Detect the grid/);
    }
  });

  it('a table WITH a grid is proposed, not needs-subdivision', () => {
    const proposal = deriveForField(tableField(), 6, pageText(), A4.width, A4.height)!;

    const state = panelState(tableField(), proposal.segment, false, proposal);

    expect(state.kind).toBe('proposed');
  });

  it('a scalar’s band-less box stays a confirmable proposal, never subdivision', () => {
    const box: PageBox = { page: 0, x: 100, y: 200, width: 120, height: 16, pageWidth: 595, pageHeight: 842 };

    expect(panelState(tableField({ type: 'text' }), box, false, null).kind).toBe('proposed');
  });

  it('no-proposal copy now names drawing the box, not a promise of future placement (R5)', () => {
    const state = panelState(tableField(), undefined, false, null);

    expect(state.kind).toBe('no-proposal');
    if (state.kind === 'no-proposal') {
      expect(state.reason).toMatch(/draw the table’s box/);
      expect(state.reason).not.toMatch(/coming/);
    }
  });
});

describe('draw-box snapping is tight, so a trace no longer jumps to distant text (draw-jump fix)', () => {
  const page = { page: 0, pageWidth: 595, pageHeight: 842 };

  it('does NOT pull an edge onto a text edge 10pt away (the old 12pt jump)', () => {
    // A careful trace of a cell whose border sits 10pt from the "Date" label's
    // edge used to be yanked onto the label. At DRAW_SNAP_RANGE the box stays.
    const box = snapDrawnBox({ x: 300, y: 500 }, { x: 400, y: 520 }, page, [290], []);
    expect(box.x).toBe(300); // stayed where drawn, not snapped to 290
  });

  it('still settles onto an edge the reviewer was already touching (within range)', () => {
    const box = snapDrawnBox({ x: 292, y: 500 }, { x: 400, y: 520 }, page, [290], []);
    expect(box.x).toBeCloseTo(290, 5); // 2pt away → snaps
  });

  it('honours a wider range when snapping to rule-lines', () => {
    // A rule-line is the correct target, so a rough 6pt trace should lock on when
    // the caller passes the rule range.
    const box = snapDrawnBox({ x: 296, y: 500 }, { x: 400, y: 520 }, page, [290], [], 8);
    expect(box.x).toBeCloseTo(290, 5);
  });

  it('DRAW_SNAP_RANGE is far tighter than the band-edge SNAP_RANGE', () => {
    expect(DRAW_SNAP_RANGE).toBeLessThan(SNAP_RANGE);
  });
});

describe('rule-line extraction from a page path (draw-jump: snap to the grid)', () => {
  it('reads a straight lineTo as one segment', () => {
    // moveTo(40,700) lineTo(555,700) — a horizontal rule.
    const segs = segmentsFromDrawOps([0, 40, 700, 1, 555, 700]);
    expect(segs).toEqual([{ x1: 40, y1: 700, x2: 555, y2: 700 }]);
  });

  it('closes a stroked rectangle into four sides', () => {
    // moveTo + 3 lineTo + closePath — a cell rectangle.
    const segs = segmentsFromDrawOps([0, 10, 10, 1, 20, 10, 1, 20, 20, 1, 10, 20, 4]);
    expect(segs).toHaveLength(4);
    // The closePath side runs from the last point back to the start.
    expect(segs[3]).toEqual({ x1: 10, y1: 20, x2: 10, y2: 10 });
  });

  it('advances the cursor across a curve without emitting a segment', () => {
    // moveTo(0,0) curveTo(c1,c2,end=5,5) lineTo(9,5) — the curve is not a rule,
    // but the lineTo after it starts from the curve's end point.
    const segs = segmentsFromDrawOps([0, 0, 0, 2, 1, 1, 2, 2, 5, 5, 1, 9, 5]);
    expect(segs).toEqual([{ x1: 5, y1: 5, x2: 9, y2: 5 }]);
  });

  it('classifies vertical and horizontal rules and drops short strokes', () => {
    const { xs, ys } = rulesFromSegments(
      [
        { x1: 100, y1: 200, x2: 100, y2: 260 }, // vertical rule at x=100
        { x1: 40, y1: 500, x2: 555, y2: 500 }, // horizontal rule at y=500
        { x1: 10, y1: 10, x2: 13, y2: 10 }, // 3pt stroke — too short
      ],
      { minLength: 12 },
    );
    expect(xs).toEqual([100]);
    expect(ys).toEqual([500]);
  });

  it('dedupes doubled rules within tolerance', () => {
    const { xs } = rulesFromSegments([
      { x1: 100, y1: 0, x2: 100, y2: 60 },
      { x1: 100.2, y1: 0, x2: 100.2, y2: 60 }, // overdrawn same rule
      { x1: 300, y1: 0, x2: 300, y2: 60 },
    ]);
    expect(xs).toEqual([100, 300]);
  });

  it('applyMatrix and matrixMultiply place a rule in page space', () => {
    // A translate-by-(40,700) matrix maps the local origin to the page point.
    const translate = [1, 0, 0, 1, 40, 700] as const;
    expect(applyMatrix(translate, 0, 0)).toEqual([40, 700]);
    // Composing with a scale-by-2 then applying: local (5,5) → (50, 710).
    const scale = [2, 0, 0, 2, 0, 0] as const;
    const ctm = matrixMultiply(translate, scale);
    expect(applyMatrix(ctm, 5, 5)).toEqual([50, 710]);
  });
})

/**
 * Document-wide option-cell derivation for non-table fields.
 *
 * The page-level rule is proved in `pdf-geometry.test.ts` against measured
 * fixtures. What is added here is the DOCUMENT rule: the dozer repeats the same
 * criterion under several parts, and a mark placed under the wrong one records
 * an assessment against a criterion nobody checked.
 */
describe('deriveOptionCellsAcrossPages', () => {
  const A4_PAGE = { width: 595, height: 842 };

  /** A minimal page carrying the dozer's measured tick / cross / N-A header. */
  function questionPage(question: string): TextPage {
    return {
      ...A4_PAGE,
      items: [
        { text: 'N/A', x: 539.9, y: 648.6, width: 13.3 },
        { text: 'During the demonstration, did the candidate:', x: 37.5, y: 647.7, width: 192 },
        { text: '\uf0fc', x: 502.6, y: 647.7, width: 7.1 },
        { text: '/ \u00d7', x: 512.1, y: 647.7, width: 10.3 },
        { text: question, x: 37.5, y: 630.8, width: 258.1 },
        { text: 'Wearing correct PPE', x: 37.5, y: 614, width: 84 },
      ],
    };
  }

  const OPTIONS = ['tick', 'cross', 'na'];

  it('finds the question on whichever page prints it', () => {
    const pages = [questionPage('Receive and clarify the work instructions'), questionPage('Something else entirely')];
    const res = deriveOptionCellsAcrossPages(
      { label: 'Receive and clarify the work instructions', options: OPTIONS },
      pages,
    );

    expect(res).not.toBeNull();
    expect(res!.segments).toHaveLength(3);
    expect(res!.segments[0]!.page).toBe(0);
  });

  it('records the page it matched, not page zero', () => {
    const pages = [questionPage('Something else entirely'), questionPage('Receive and clarify the work instructions')];
    const res = deriveOptionCellsAcrossPages(
      { label: 'Receive and clarify the work instructions', options: OPTIONS },
      pages,
    );

    expect(res!.segments.every((s) => s.page === 1)).toBe(true);
  });

  it('refuses when two pages both print the same criterion', () => {
    // The real hazard: "Wearing correct PPE" appears under several parts of the
    // dozer. Nothing distinguishes the occurrences, so neither may be chosen.
    const pages = [questionPage('Receive and clarify the work instructions'), questionPage('Receive and clarify the work instructions')];

    expect(
      deriveOptionCellsAcrossPages(
        { label: 'Receive and clarify the work instructions', options: OPTIONS },
        pages,
      ),
    ).toBeNull();
  });

  it('refuses a field with fewer than two options', () => {
    const pages = [questionPage('Receive and clarify the work instructions')];

    expect(
      deriveOptionCellsAcrossPages(
        { label: 'Receive and clarify the work instructions', options: ['tick'] },
        pages,
      ),
    ).toBeNull();
    expect(
      deriveOptionCellsAcrossPages({ label: 'Receive and clarify the work instructions' }, pages),
    ).toBeNull();
  });

  it('refuses when no page prints the question', () => {
    const pages = [questionPage('Receive and clarify the work instructions')];

    expect(
      deriveOptionCellsAcrossPages(
        { label: 'Conducts a pre-start inspection of the ROPS', options: OPTIONS },
        pages,
      ),
    ).toBeNull();
  });
});

/**
 * The two option shapes must not claim each other's fields.
 *
 * This is the invariant the whole pair rests on. Both populations arrive as "a
 * choice field with N options" and `deriveOptionCellsAcrossPages` tries both
 * rules, so if either accepted the other's field the marks would land in the
 * wrong place with full confidence — a tick for "True" in an outcome column, or
 * an outcome tick beside a printed word.
 */
describe('deriveOptionCellsAcrossPages — routing between the two shapes', () => {
  const A4_PAGE = { width: 595, height: 842 };

  /** Practical criteria: labels left, ✓ / × and N/A columns right. */
  const criteriaPage: TextPage = {
    ...A4_PAGE,
    items: [
      { text: 'N/A', x: 539.9, y: 648.6, width: 13.3 },
      { text: 'During the demonstration, did the candidate:', x: 37.5, y: 647.7, width: 192 },
      { text: '\uf0fc', x: 502.6, y: 647.7, width: 7.1 },
      { text: '/ \u00d7', x: 512.1, y: 647.7, width: 10.3 },
      { text: 'Correct & controlled steering techniques', x: 37.5, y: 630.8, width: 258.1 },
      { text: 'Manoeuvres dozer safely', x: 37.5, y: 614, width: 143.6 },
    ],
  };

  /** A theory question printing its own answers. */
  const theoryPage: TextPage = {
    ...A4_PAGE,
    items: [
      { text: 'Q1. The track dozer must be isolated with a lock and hasp', x: 37.5, y: 630.8, width: 300 },
      { text: '\u2610', x: 430, y: 630.8, width: 9 },
      { text: 'True', x: 443, y: 630.8, width: 18 },
      { text: '\u2610', x: 480, y: 630.8, width: 9 },
      { text: 'False', x: 493, y: 630.8, width: 20 },
    ],
  };

  it('maps a practical criterion onto the option columns', () => {
    const res = deriveOptionCellsAcrossPages(
      { label: 'Correct & controlled steering techniques', options: ['\u2713 / \u00d7', 'N/A'] },
      [criteriaPage],
    );

    expect(res).not.toBeNull();
    // Right of the label header — the glyph columns, not the row.
    for (const segment of res!.segments) expect(segment.x).toBeGreaterThan(450);
  });

  it('anchors a theory question on its own printed answers', () => {
    const res = deriveOptionCellsAcrossPages(
      { label: 'Q1. The track dozer must be isolated with a lock and hasp', options: ['True', 'False'] },
      [theoryPage],
    );

    expect(res).not.toBeNull();
    // The printed ☐ glyphs, nowhere near where an outcome column would be.
    expect(res!.segments.map((s) => s.x)).toEqual([430, 480]);
  });

  it('does not place a theory question in the outcome columns of its own page', () => {
    // The page carries BOTH: a criteria header and a question with inline
    // answers. This is the real Track Dozer layout, and the trap.
    const mixed: TextPage = { ...A4_PAGE, items: [...criteriaPage.items, ...theoryPage.items] };
    const res = deriveOptionCellsAcrossPages(
      { label: 'Q1. The track dozer must be isolated with a lock and hasp', options: ['True', 'False'] },
      [mixed],
    );

    // Either it anchors on the printed ☐ glyphs at 430 and 480, or it refuses.
    // What it must never do is map True/False onto the ✓ / × and N/A columns,
    // whose anchors sit at 502.6, 512.1 and 539.9.
    if (res) {
      expect(res.segments.map((s) => s.x)).toEqual([430, 480]);
    }
  });
});

/**
 * `applyFieldChanges` (U2/KTD3).
 *
 * `GeometryEditorScreen`'s `mutate()` used to compute `fields.map(...)` fresh
 * off the same pre-click `fields` snapshot on every call, so more than one
 * synchronous `mutate()` call in a single handler — the "Place all N" button
 * already loops once per segment — left only the LAST call's result in state.
 * This is the pure-function regression coverage for the fold-over-one-snapshot
 * fix; `GeometryEditorScreen` itself now only calls this via a functional
 * `setState` updater, so proving the fold is correct here is what proves the
 * bug cannot recur regardless of how the component wires it up.
 */
describe('applyFieldChanges', () => {
  function choiceField(id: string, options: string[]): FormField {
    return { id, type: 'checkbox_group', label: id, required: false, source: 'imported', options };
  }

  function box(optionKey: string): PageBox {
    return { page: 0, x: 0, y: 0, width: 10, height: 10, pageWidth: 595, pageHeight: 842, optionKey };
  }

  /**
   * Mirrors `GeometryEditorScreen`'s `setOptionBox` change body exactly: drop
   * any existing box for this option, then append the new one. Reused so the
   * regression tests exercise the real shape of change a caller passes, not a
   * toy replacement function.
   */
  function setOptionBoxChange(optionKey: string): (f: FormField) => FormField {
    return (f) => {
      const kept = (f.geometry?.segments ?? []).filter((s) => s.optionKey !== optionKey);
      return { ...f, geometry: { segments: [...kept, box(optionKey)] } };
    };
  }

  it('applies two changes to the SAME field — both option boxes land, not just the last (KTD3 regression)', () => {
    // This is the direct regression test: it MUST fail if `applyFieldChanges`
    // recomputes each change from the original `fields` snapshot instead of
    // folding over the accumulating result (verified by temporarily reverting
    // the implementation to that pattern and re-running — see report).
    const field = choiceField('f1', ['Yes', 'No']);
    const changes: FieldChange[] = [
      { fieldId: 'f1', change: setOptionBoxChange('Yes') },
      { fieldId: 'f1', change: setOptionBoxChange('No') },
    ];

    const result = applyFieldChanges([field], changes);

    const optionKeys = (result[0]!.geometry?.segments ?? []).map((s) => s.optionKey);
    expect(optionKeys).toEqual(['Yes', 'No']);
  });

  it('applies changes to two DIFFERENT fields, independent of call order', () => {
    const a = choiceField('a', ['Yes']);
    const b = choiceField('b', ['No']);
    const changesInOrder: FieldChange[] = [
      { fieldId: 'a', change: setOptionBoxChange('Yes') },
      { fieldId: 'b', change: setOptionBoxChange('No') },
    ];
    const changesReversed: FieldChange[] = [...changesInOrder].reverse();

    for (const changes of [changesInOrder, changesReversed]) {
      const result = applyFieldChanges([a, b], changes);
      expect(result.find((f) => f.id === 'a')?.geometry?.segments?.[0]?.optionKey).toBe('Yes');
      expect(result.find((f) => f.id === 'b')?.geometry?.segments?.[0]?.optionKey).toBe('No');
    }
  });

  it('returns the input unchanged for an empty changes array', () => {
    const fields = [choiceField('a', ['Yes']), choiceField('b', ['No'])];

    expect(applyFieldChanges(fields, [])).toEqual(fields);
  });

  it('characterizes the "Place all N" loop: N option-box changes for ONE field in one pass all land', () => {
    // Mirrors the loop in `PlacementPanel`'s "Place all N" button exactly: one
    // change per proposed segment, all for the same field, applied in one
    // batch. Before U2 this was N separate `mutate()` calls each recomputing
    // from the same pre-click snapshot — only the last one survived.
    const field = choiceField('f1', ['Yes', 'No', 'Maybe']);
    const changes: FieldChange[] = ['Yes', 'No', 'Maybe'].map((optionKey) => ({
      fieldId: 'f1',
      change: setOptionBoxChange(optionKey),
    }));

    const result = applyFieldChanges([field], changes);

    const optionKeys = (result[0]!.geometry?.segments ?? []).map((s) => s.optionKey);
    expect(optionKeys).toEqual(['Yes', 'No', 'Maybe']);
  });

  it('documents why this is a real regression test: the OLD per-call-from-original-snapshot pattern drops all but the last change', () => {
    /*
      This does not call `applyFieldChanges` — it reproduces the OLD `mutate()`
      shape directly: every call maps from the SAME captured `fields`, exactly
      as `GeometryEditorScreen` did before U2. Calling `setEdited(value)` more
      than once synchronously with a plain (non-functional) value means only
      the LAST call's value ends up as state — earlier calls' results are
      simply overwritten, never merged. This is why two changes to one field,
      like the "Place all N" loop makes, used to lose everything but the last.
    */
    const original = [choiceField('f1', ['Yes', 'No'])];
    const oldMutate = (fields: FormField[], fieldId: string, change: (f: FormField) => FormField) =>
      fields.map((f) => (f.id === fieldId ? change(f) : f));

    const pendingStates = [
      oldMutate(original, 'f1', setOptionBoxChange('Yes')),
      oldMutate(original, 'f1', setOptionBoxChange('No')),
    ];
    const survivingState = pendingStates[pendingStates.length - 1]!; // only the last setEdited(...) call wins

    const optionKeys = (survivingState[0]!.geometry?.segments ?? []).map((s) => s.optionKey);
    expect(optionKeys).toEqual(['No']);
    expect(optionKeys).not.toContain('Yes');
  });
});

describe('moveBand / moveBoundary (U6, R7/R8) — pure core of import-session.ts adjustGeometryBand/Boundary', () => {
  /**
   * The exact fixture `import-session.test.ts`'s "geometry review (U4, R8)"
   * suite uses for `adjustGeometryBand`/`adjustGeometryBoundary`, so every
   * case below can be cross-checked input-for-input against what that suite
   * already asserts for `adjustGeometryBand('f1', ...)` /
   * `adjustGeometryBoundary('f1', ...)` against the same starting segment.
   */
  const SEGMENT: PageBox = {
    page: 6,
    x: 37.5,
    y: 570,
    width: 520,
    height: 80,
    pageWidth: 595,
    pageHeight: 842,
    columnBands: [
      { key: 'tick', start: 496, end: 511.7 },
      { key: 'cross', start: 511.7, end: 531.9 },
      { key: 'na', start: 531.9, end: 556.7 },
    ],
    rowBands: [
      { key: 'r0', start: 620, end: 640 },
      { key: 'r1', start: 600, end: 620 },
    ],
  };

  it('Covers AE5. moves a column band edge, matching adjustGeometryBand("f1", "column", "na", "end", 560)', () => {
    const next = moveBand(SEGMENT, 'column', 'na', 'end', 560);

    expect(next?.columnBands?.find((b) => b.key === 'na')?.end).toBe(560);
  });

  it('Covers AE5. grows the segment box to contain a band dragged past its edge', () => {
    // 560 sits beyond the box's right edge of 557.5 — matches
    // import-session.test.ts's "grows the segment box to contain a band
    // dragged past its edge".
    const next = moveBand(SEGMENT, 'column', 'na', 'end', 560);

    expect(next).not.toBeNull();
    expect(next!.x + next!.width).toBeGreaterThanOrEqual(560);
    expect(resolveGeometry({ geometry: { segments: [next!] } }).dropped).toEqual([]);
  });

  it('never grows the box beyond the page — matches adjustGeometryBand("f1", "column", "na", "end", 900)', () => {
    // 900 exceeds the 595pt page, so the shipped validator refuses the whole
    // edit rather than producing a box that runs off the paper.
    expect(moveBand(SEGMENT, 'column', 'na', 'end', 900)).toBeNull();
  });

  it('refuses an adjustment that would overlap a neighbouring band — matches adjustGeometryBand("f1", "column", "tick", "end", 540)', () => {
    expect(moveBand(SEGMENT, 'column', 'tick', 'end', 540)).toBeNull();
  });

  it('refuses an inverted adjustment — matches adjustGeometryBand("f1", "column", "cross", "end", 400)', () => {
    expect(moveBand(SEGMENT, 'column', 'cross', 'end', 400)).toBeNull();
  });

  it('moves a row band as well as a column band — matches adjustGeometryBand("f1", "row", "r1", "start", 595)', () => {
    const next = moveBand(SEGMENT, 'row', 'r1', 'start', 595);

    expect(next?.rowBands?.find((b) => b.key === 'r1')?.start).toBe(595);
  });

  it('refuses a band key that does not exist on the given axis', () => {
    expect(moveBand(SEGMENT, 'column', 'nope', 'end', 505)).toBeNull();
  });

  it('Covers AE5. moves both bands sharing an interior boundary, leaving no gap — matches adjustGeometryBoundary("f1", "column", "tick", "cross", 505)', () => {
    const next = moveBoundary(SEGMENT, 'column', 'tick', 'cross', 505);

    const bands = next?.columnBands!;
    expect(bands.find((b) => b.key === 'tick')!.end).toBe(505);
    expect(bands.find((b) => b.key === 'cross')!.start).toBe(505);
  });

  it('refuses a boundary drag past either neighbour rather than inverting a band — matches adjustGeometryBoundary("f1", "column", "tick", "cross", 490 / 540)', () => {
    // left of tick.start
    expect(moveBoundary(SEGMENT, 'column', 'tick', 'cross', 490)).toBeNull();
    // right of cross.end
    expect(moveBoundary(SEGMENT, 'column', 'tick', 'cross', 540)).toBeNull();
  });

  it('publishes a boundary-adjusted grid the shipped validator accepts — matches adjustGeometryBoundary("f1", "column", "cross", "na", 528)', () => {
    const next = moveBoundary(SEGMENT, 'column', 'cross', 'na', 528);

    expect(next).not.toBeNull();
    expect(resolveGeometry({ geometry: { segments: [next!] } }).dropped).toEqual([]);
  });

  it('ignores a boundary between bands that do not exist — matches adjustGeometryBoundary("f1", "column", "tick", "nope", 505)', () => {
    expect(moveBoundary(SEGMENT, 'column', 'tick', 'nope', 505)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Whole-box movement
 * ------------------------------------------------------------------ */

describe('moveSegment', () => {
  function box(over: Partial<PageBox> = {}): PageBox {
    return {
      page: 0,
      x: 100,
      y: 200,
      width: 60,
      height: 40,
      pageWidth: 595,
      pageHeight: 842,
      ...over,
    };
  }

  it('MOVES THE BANDS WITH THE BOX', () => {
    /*
      THE FAILURE THIS EXISTS FOR. GeometryBand.start/end are absolute PDF
      points in the same space as PageBox.x/y — `markPlacement` reads
      columnBand.start directly as the mark's x. Moving the outline without the
      bands leaves every mark where it was: the box lands where the author put
      it and the export draws ticks in the old cells.
    */
    const moved = moveSegment(
      box({
        columnBands: [{ key: 'a', start: 100, end: 130 }],
        rowBands: [{ key: 'r1', start: 200, end: 220 }],
      }),
      10,
      -5,
    );

    expect(moved.x).toBe(110);
    expect(moved.y).toBe(195);
    expect(moved.columnBands).toEqual([{ key: 'a', start: 110, end: 140 }]);
    expect(moved.rowBands).toEqual([{ key: 'r1', start: 195, end: 215 }]);
  });

  it('moves column bands on x only and row bands on y only', () => {
    const moved = moveSegment(
      box({
        columnBands: [{ key: 'a', start: 100, end: 130 }],
        rowBands: [{ key: 'r1', start: 200, end: 220 }],
      }),
      10,
      0,
    );
    expect(moved.columnBands![0]!.start).toBe(110);
    expect(moved.rowBands![0]!.start).toBe(200);
  });

  it('keeps a scalar box with no bands intact', () => {
    const moved = moveSegment(box(), 5, 5);
    expect(moved.columnBands).toBeUndefined();
    expect(moved.rowBands).toBeUndefined();
    expect([moved.x, moved.y]).toEqual([105, 205]);
  });

  it('will not let a box leave the page', () => {
    // A mark outside the media box does not appear on the printed page at all,
    // which on a competency record reads as a mark nobody made.
    const atLeft = moveSegment(box({ x: 4 }), -50, 0);
    expect(atLeft.x).toBe(0);

    const atRight = moveSegment(box({ x: 500 }), 200, 0);
    expect(atRight.x).toBe(595 - 60);

    const atBottom = moveSegment(box({ y: 3 }), 0, -50);
    expect(atBottom.y).toBe(0);

    const atTop = moveSegment(box({ y: 800 }), 0, 200);
    expect(atTop.y).toBe(842 - 40);
  });

  it('slides along an edge rather than stopping dead', () => {
    // Clamping the DELTA rather than the result means the axis with room keeps
    // moving — a drag along the page edge still tracks the pointer.
    const moved = moveSegment(box({ x: 0, y: 400 }), -20, 30);
    expect(moved.x).toBe(0);
    expect(moved.y).toBe(430);
  });

  it('returns the SAME segment when the clamped delta is zero', () => {
    // A drag held against the edge produces no re-render, and a nudge at the
    // boundary is a no-op rather than a churn of identical states.
    const at = box({ x: 0, y: 0 });
    expect(moveSegment(at, -10, -10)).toBe(at);
    expect(moveSegment(at, 0, 0)).toBe(at);
  });
});

describe('keyMove', () => {
  it('steps 1pt, and 10pt with the coarse modifier', () => {
    expect(keyMove('ArrowRight', false)).toEqual({ dx: 1, dy: 0 });
    expect(keyMove('ArrowRight', true)).toEqual({ dx: 10, dy: 0 });
  });

  it('sends ArrowUp UP THE PRINTED PAGE', () => {
    // PDF y grows upward and the screen's grows downward. Getting this
    // backwards sends every box the wrong way and reads as a broken control.
    expect(keyMove('ArrowUp', false)!.dy).toBe(1);
    expect(keyMove('ArrowDown', false)!.dy).toBe(-1);
  });

  it('makes ten fine steps land where one coarse step does', () => {
    // A coarse step that is not a multiple of the fine one makes the two
    // disagree about where a box ends up.
    expect(NUDGE_POINTS_COARSE).toBe(NUDGE_POINTS * 10);
  });

  it('returns null for a key it does not own', () => {
    // So a caller can leave the event unhandled — swallowing every keystroke
    // would stop an author typing in the filter box.
    expect(keyMove('a', false)).toBeNull();
    expect(keyMove('Enter', false)).toBeNull();
  });
});

describe('isDeleteKey', () => {
  it('accepts both keys a reviewer will reach for', () => {
    expect(isDeleteKey('Delete')).toBe(true);
    expect(isDeleteKey('Backspace')).toBe(true);
    expect(isDeleteKey('x')).toBe(false);
  });
});

describe('removeSegment', () => {
  const a: PageBox = { page: 0, x: 1, y: 1, width: 1, height: 1, pageWidth: 595, pageHeight: 842 };
  const b: PageBox = { ...a, page: 1 };

  it('drops the named page’s box', () => {
    expect(removeSegment([a, b], 0)).toEqual([b]);
  });

  it('drops one option’s box without touching its siblings', () => {
    // A multi-option field carries one segment per option; deleting the box for
    // "b" must not take "a" with it.
    const oa = { ...a, optionKey: 'a' };
    const ob = { ...a, optionKey: 'b' };
    expect(removeSegment([oa, ob], 0, 'b')).toEqual([oa]);
  });

  it('returns undefined when the last segment goes', () => {
    // geometry.ts treats an absent footprint as "not placed"; a geometry with
    // zero segments is a third state nothing reads — it passes a "has geometry"
    // check and then draws nothing.
    expect(removeSegment([a], 0)).toBeUndefined();
  });

  it('returns the SAME array when nothing matched', () => {
    const segments = [a, b];
    expect(removeSegment(segments, 7)).toBe(segments);
  });
});

describe('replaceSegmentOnPage — the page-scoped write behind a band-edge drag / box move', () => {
  // A repeating table spanning a page break: one whole-field box per page, BOTH
  // with a null option key. This is the exact shape that made "the second box
  // won't divide" — editing page 1 must not rewrite page 0's box.
  const p0: PageBox = {
    page: 0,
    x: 10,
    y: 20,
    width: 100,
    height: 200,
    pageWidth: 595,
    pageHeight: 842,
    rowBands: [{ key: 'a', start: 20, end: 120 }],
  };
  const p1: PageBox = { ...p0, page: 1, rowBands: [{ key: 'b', start: 20, end: 120 }] };

  it('replaces ONLY the box on the named page, leaving the other page’s box untouched', () => {
    const next: PageBox = { ...p1, height: 300, rowBands: [{ key: 'b', start: 20, end: 320 }] };
    const out = replaceSegmentOnPage([p0, p1], null, 1, next);
    expect(out).toEqual([p0, next]);
    // The page-0 box is the very same object — it was never rewritten.
    expect(out[0]).toBe(p0);
  });

  it('does NOT collapse every page’s box onto the edited one (the clobber this guards against)', () => {
    // The bug: matching on optionKey alone (both null) rewrote every whole-field
    // box to `next`, so the continuation vanished onto the edited page.
    const next: PageBox = { ...p0, x: 50 };
    const out = replaceSegmentOnPage([p0, p1], null, 0, next);
    expect(out).toEqual([next, p1]);
    expect(out.filter((s) => s.page === 1)).toHaveLength(1);
  });

  it('scopes to a single option on a per-option field', () => {
    const oa: PageBox = { ...p0, optionKey: 'a', rowBands: undefined };
    const ob: PageBox = { ...p0, optionKey: 'b', rowBands: undefined };
    const next: PageBox = { ...ob, x: 77 };
    expect(replaceSegmentOnPage([oa, ob], 'b', 0, next)).toEqual([oa, next]);
  });

  it('returns the SAME array when nothing matched, so the caller can skip a no-op write', () => {
    const segments = [p0, p1];
    expect(replaceSegmentOnPage(segments, null, 9, { ...p0, page: 9 })).toBe(segments);
  });
});

import { deriveMatchAnchorsAcrossPages } from './geometry-actions.js';

/**
 * A matching question, across the whole document.
 *
 * The same document-wide ambiguity refusal `deriveOptionCellsAcrossPages`
 * makes, and for the same reason: a question claimed by two pages is a question
 * the document does not place, and anchoring the wrong page's copy draws every
 * one of the candidate's lines onto text they never read.
 */
describe('deriveMatchAnchorsAcrossPages', () => {
  const A4_PAGE = { width: 595, height: 842 };

  const signItems: PositionedText[] = [
    { text: 'Restricted area', x: 60, y: 700, width: 78 },
    { text: 'Biosecurity sign', x: 380, y: 700, width: 80 },
    { text: 'Permission to pass', x: 60, y: 670, width: 92 },
    { text: 'Traffic hazard sign', x: 380, y: 670, width: 92 },
  ];

  const ANCHORS = [
    { key: 'l0', side: 'l' as const, text: 'Restricted area' },
    { key: 'l1', side: 'l' as const, text: 'Permission to pass' },
    { key: 'r0', side: 'r' as const, text: 'Biosecurity sign' },
    { key: 'r1', side: 'r' as const, text: 'Traffic hazard sign' },
  ];

  const blank: TextPage = { ...A4_PAGE, items: [] };
  const signs: TextPage = { ...A4_PAGE, items: signItems };

  it('finds the question on whichever page prints it, and says which', () => {
    const res = deriveMatchAnchorsAcrossPages(ANCHORS, [blank, blank, signs]);

    expect(res).not.toBeNull();
    expect(res!.segments).toHaveLength(4);
    expect(new Set(res!.segments.map((s) => s.page))).toEqual(new Set([2]));
  });

  it('REFUSES WHEN TWO PAGES BOTH CLAIM IT', () => {
    expect(deriveMatchAnchorsAcrossPages(ANCHORS, [signs, blank, signs])).toBeNull();
  });

  it('refuses when no page carries it', () => {
    expect(deriveMatchAnchorsAcrossPages(ANCHORS, [blank, blank])).toBeNull();
  });

  it('refuses a question with fewer than two entries before reading a page', () => {
    expect(deriveMatchAnchorsAcrossPages([ANCHORS[0]!], [signs])).toBeNull();
  });
});

describe('retargetPageChanges', () => {
  /*
    The duplicated-checklist paper: Parts 2, 4 and 6 print the identical
    checklist, detection lands all three parts' boxes on the first matching
    page, and the x/y it found are right everywhere but the page number.
  */
  const box = (page: number, x = 40, optionKey?: string) => ({
    page,
    x,
    y: 60,
    width: 20,
    height: 14,
    pageWidth: 600,
    pageHeight: 800,
    ...(optionKey ? { optionKey } : {}),
  });
  const placed = (id: string, pages: number[]): FormField => ({
    id,
    type: 'check_cross',
    label: id,
    required: false,
    source: 'imported',
    geometry: { segments: pages.map((p, i) => box(p, 40 + i * 30, i === 0 ? undefined : `opt${i}`)) },
  });
  const unplaced: FormField = {
    id: 'bare',
    type: 'text',
    label: 'bare',
    required: false,
    source: 'imported',
  };

  it('re-stamps every segment onto the target page, keeping position and keys', () => {
    const fields = [placed('a', [7, 7]), unplaced];

    const next = applyFieldChanges(fields, retargetPageChanges(fields, ['a'], 11));
    const segments = next[0]!.geometry!.segments;

    expect(segments.map((s) => s.page)).toEqual([11, 11]);
    // Position and option identity survive verbatim — the layouts are identical.
    expect(segments.map((s) => s.x)).toEqual([40, 70]);
    expect(segments[1]!.optionKey).toBe('opt1');
  });

  it('skips fields with no boxes rather than inventing empty geometry', () => {
    const fields = [placed('a', [7]), unplaced];

    const changes = retargetPageChanges(fields, ['a', 'bare', 'ghost'], 11);

    expect(changes.map((c) => c.fieldId)).toEqual(['a']);
  });

  it('is a no-op for a field already on the target page', () => {
    const fields = [placed('a', [11, 11])];

    expect(retargetPageChanges(fields, ['a'], 11)).toEqual([]);
  });
});

/**
 * The extraction window as a soft prior (sourcePages scoping).
 *
 * Every AI field carries the 1-based page range of the 4-page batch that
 * produced it. These tests pin the whole discipline: the window softens
 * exactly one refusal (ambiguous document-wide, unique in-window), never
 * auto-confirms what it influenced, never vetoes the only candidate, and —
 * asserted with deep-equality fixtures, not assumed — leaves a field without
 * a window byte-identical to the pre-window behaviour (R6).
 */
describe('pageWindowOf (R7/KTD3)', () => {
  it('converts 1-based to 0-based, dilates one page each side, and keeps the stamped range for notes', () => {
    expect(pageWindowOf({ from: 5, to: 8 }, 18)).toEqual({ first: 3, last: 8, from: 5, to: 8 });
  });

  it('clamps the dilated bounds to the document', () => {
    expect(pageWindowOf({ from: 1, to: 4 }, 18)).toEqual({ first: 0, last: 4, from: 1, to: 4 });
    expect(pageWindowOf({ from: 15, to: 18 }, 18)).toEqual({ first: 13, last: 17, from: 15, to: 18 });
  });

  it('the margin is one page and the cap sits strictly below the auto-confirm boundary', () => {
    // classifyProposalTier auto-confirms at confidence === 1 exactly; the cap
    // must never reach it, or a window-guessed page could publish unreviewed.
    expect(WINDOW_MARGIN_PAGES).toBe(1);
    expect(WINDOW_CONFIDENCE_CAP).toBeLessThan(1);
    expect(classifyProposalTier({ segments: [], confidence: WINDOW_CONFIDENCE_CAP, notes: [] })).toBe(
      'needs-review',
    );
  });

  it('treats every malformed shape as absent', () => {
    expect(pageWindowOf(undefined, 18)).toBeNull();
    expect(pageWindowOf({ from: 0, to: 2 }, 18)).toBeNull(); // 1-based, so 0 is malformed
    expect(pageWindowOf({ from: 5, to: 4 }, 18)).toBeNull(); // inverted
    expect(pageWindowOf({ from: 2.5, to: 3 }, 18)).toBeNull(); // not a page number
    expect(pageWindowOf({ from: 1, to: 2 }, 0)).toBeNull(); // no document to scope
  });

  it('ignores a window wholly past the end of the document (shorter-PDF defense)', () => {
    expect(pageWindowOf({ from: 19, to: 22 }, 18)).toBeNull();
    // …but a window that still touches the document survives, clamped.
    expect(pageWindowOf({ from: 18, to: 22 }, 18)).toEqual({ first: 16, last: 17, from: 18, to: 22 });
  });
});

describe('windowVerdict (R2-R5 truth table)', () => {
  // Stamped pages 6-8 of a 20-page document: dilated 0-based bounds 4..8.
  const window = pageWindowOf({ from: 6, to: 8 }, 20)!;
  const hits = (...pages: number[]) => pages.map((page) => ({ page }));

  it('refuses when nothing matched anywhere', () => {
    expect(windowVerdict([], window)).toEqual({ kind: 'refuse' });
  });

  it('places a unique in-window hit UNWINDOWED — the prior changed nothing and leaves no trace (AE4)', () => {
    expect(windowVerdict(hits(6), window)).toEqual({ kind: 'place', page: 6, windowed: false });
  });

  it('dilation admits a hit one page before or after the stamped range (KTD3)', () => {
    // Stamped 6-8 is 0-based 5..7; pages 4 and 8 are the one-page tolerance.
    expect(windowVerdict(hits(4), window)).toEqual({ kind: 'place', page: 4, windowed: false });
    expect(windowVerdict(hits(8), window)).toEqual({ kind: 'place', page: 8, windowed: false });
  });

  it('places the one in-window hit over document-wide rivals, naming the excluded pages (AE1/R5)', () => {
    const verdict = windowVerdict(hits(6, 11, 16), window);

    expect(verdict).toEqual({
      kind: 'place',
      page: 6,
      windowed: true,
      note: 'Matched on page 7; pages 12 and 17 excluded by the extraction window (pages 6–8).',
    });
  });

  it('refuses two in-window hits — ambiguity INSIDE the window is a question the window cannot answer (AE2)', () => {
    expect(windowVerdict(hits(5, 6), window)).toEqual({ kind: 'refuse' });
    // Outsiders change nothing about that.
    expect(windowVerdict(hits(5, 6, 15), window)).toEqual({ kind: 'refuse' });
  });

  it('places a unique OUT-of-window hit, flagged — the soft prior never vetoes the only candidate (AE5)', () => {
    expect(windowVerdict(hits(15), window)).toEqual({
      kind: 'place',
      page: 15,
      windowed: true,
      note: 'Matched on page 16, outside the extraction window (pages 6–8) — check the page.',
    });
  });

  it('refuses two out-of-window hits, exactly as the unwindowed scan would', () => {
    expect(windowVerdict(hits(12, 15), window)).toEqual({ kind: 'refuse' });
  });

  it('names a one-page stamped window as a single page', () => {
    const single = pageWindowOf({ from: 6, to: 6 }, 20)!;

    const verdict = windowVerdict(hits(5, 11), single);
    expect(verdict.kind).toBe('place');
    if (verdict.kind === 'place' && verdict.windowed) {
      expect(verdict.note).toBe(
        'Matched on page 6; page 12 excluded by the extraction window (page 6).',
      );
    }
  });
});

describe('deriveOptionCellsAcrossPages through the window (U4)', () => {
  /** A minimal page carrying the dozer's measured tick / cross / N-A header. */
  function questionPage(question: string): TextPage {
    return {
      width: 595,
      height: 842,
      items: [
        { text: 'N/A', x: 539.9, y: 648.6, width: 13.3 },
        { text: 'During the demonstration, did the candidate:', x: 37.5, y: 647.7, width: 192 },
        { text: '', x: 502.6, y: 647.7, width: 7.1 },
        { text: '/ ×', x: 512.1, y: 647.7, width: 10.3 },
        { text: question, x: 37.5, y: 630.8, width: 258.1 },
        { text: 'Wearing correct PPE', x: 37.5, y: 614, width: 84 },
      ],
    };
  }

  const LABEL = 'Receive and clarify the work instructions';
  const OPTIONS = ['tick', 'cross', 'na'];
  const q = questionPage(LABEL);
  const other = questionPage('Something else entirely');

  it('AE1: places the one in-window copy of a criterion three pages print, capped and noted', () => {
    // Pages 1, 4 and 6 (as printed) all carry the criterion; the field's batch
    // was page 4. Stamped {4,4} dilates to 0-based 2..4, so only page 4 is in.
    const pages = [q, other, other, q, other, q];

    const res = deriveOptionCellsAcrossPages(
      { label: LABEL, options: OPTIONS },
      pages,
      pageWindowOf({ from: 4, to: 4 }, pages.length),
    );

    expect(res).not.toBeNull();
    expect(res!.segments.every((s) => s.page === 3)).toBe(true);
    expect(res!.confidence).toBeLessThanOrEqual(WINDOW_CONFIDENCE_CAP);
    expect(classifyProposalTier(res)).toBe('needs-review');
    expect(res!.notes[res!.notes.length - 1]).toBe(
      'Matched on page 4; pages 1 and 6 excluded by the extraction window (page 4).',
    );
  });

  it('AE2: two in-window copies still refuse — the window resolves nothing inside itself', () => {
    const pages = [other, other, q, q];

    expect(
      deriveOptionCellsAcrossPages(
        { label: LABEL, options: OPTIONS },
        pages,
        pageWindowOf({ from: 3, to: 4 }, pages.length),
      ),
    ).toBeNull();
  });

  it('AE3: no window is byte-identical to the pre-change scan — deep-equal on the single hit, null on two', () => {
    const pages = [other, q];

    // The across-pages wrapper adds nothing to the untouched per-page rule:
    // its no-window output IS proposeFieldOptionCells' own proposal, verbatim.
    const expected = proposeFieldOptionCells({
      page: 1,
      pageWidth: q.width,
      pageHeight: q.height,
      items: q.items,
      label: LABEL,
      options: OPTIONS,
    });
    expect(expected).not.toBeNull();
    expect(deriveOptionCellsAcrossPages({ label: LABEL, options: OPTIONS }, pages)).toEqual(expected);
    // An explicit null window is the same absent-window path.
    expect(deriveOptionCellsAcrossPages({ label: LABEL, options: OPTIONS }, pages, null)).toEqual(
      expected,
    );

    expect(deriveOptionCellsAcrossPages({ label: LABEL, options: OPTIONS }, [q, other, q])).toBeNull();
  });

  it('AE4: a window that was not needed leaves no fingerprints — same confidence, same notes', () => {
    const pages = [other, q, other];

    const unwindowed = deriveOptionCellsAcrossPages({ label: LABEL, options: OPTIONS }, pages);
    const windowed = deriveOptionCellsAcrossPages(
      { label: LABEL, options: OPTIONS },
      pages,
      pageWindowOf({ from: 1, to: 2 }, pages.length),
    );

    expect(windowed).toEqual(unwindowed);
  });

  it('AE5: a unique hit OUTSIDE the window still places, capped, with the check-the-page note', () => {
    const pages = [other, other, other, other, other, other, q, other];

    const res = deriveOptionCellsAcrossPages(
      { label: LABEL, options: OPTIONS },
      pages,
      pageWindowOf({ from: 1, to: 2 }, pages.length),
    );

    expect(res).not.toBeNull();
    expect(res!.segments.every((s) => s.page === 6)).toBe(true);
    expect(res!.confidence).toBeLessThanOrEqual(WINDOW_CONFIDENCE_CAP);
    expect(res!.notes[res!.notes.length - 1]).toBe(
      'Matched on page 7, outside the extraction window (pages 1–2) — check the page.',
    );
  });
});

describe('deriveMatchAnchorsAcrossPages through the window (U4)', () => {
  const signItems: PositionedText[] = [
    { text: 'Restricted area', x: 60, y: 700, width: 78 },
    { text: 'Biosecurity sign', x: 380, y: 700, width: 80 },
    { text: 'Permission to pass', x: 60, y: 670, width: 92 },
    { text: 'Traffic hazard sign', x: 380, y: 670, width: 92 },
  ];

  const ANCHORS = [
    { key: 'l0', side: 'l' as const, text: 'Restricted area' },
    { key: 'l1', side: 'l' as const, text: 'Permission to pass' },
    { key: 'r0', side: 'r' as const, text: 'Biosecurity sign' },
    { key: 'r1', side: 'r' as const, text: 'Traffic hazard sign' },
  ];

  const blank: TextPage = { width: 595, height: 842, items: [] };
  const signs: TextPage = { width: 595, height: 842, items: signItems };

  it('places the one in-window copy of a question two pages claim, capped and noted', () => {
    const pages = [signs, blank, blank, blank, blank, signs];

    const res = deriveMatchAnchorsAcrossPages(
      ANCHORS,
      pages,
      pageWindowOf({ from: 5, to: 6 }, pages.length),
    );

    expect(res).not.toBeNull();
    expect(res!.segments.every((s) => s.page === 5)).toBe(true);
    expect(res!.confidence).toBeLessThanOrEqual(WINDOW_CONFIDENCE_CAP);
    expect(classifyProposalTier(res)).toBe('needs-review');
    expect(res!.notes[res!.notes.length - 1]).toBe(
      'Matched on page 6; page 1 excluded by the extraction window (pages 5–6).',
    );
  });

  it('refuses two in-window claims exactly as today', () => {
    const pages = [blank, blank, blank, blank, signs, signs];

    expect(
      deriveMatchAnchorsAcrossPages(ANCHORS, pages, pageWindowOf({ from: 5, to: 6 }, pages.length)),
    ).toBeNull();
  });

  it('a window that was not needed leaves no fingerprints, and no window is the pre-change scan verbatim', () => {
    const pages = [blank, blank, signs];

    const expected = proposeMatchAnchorCells({
      page: 2,
      pageWidth: signs.width,
      pageHeight: signs.height,
      items: signs.items,
      anchors: ANCHORS,
    });
    expect(expected).not.toBeNull();
    expect(deriveMatchAnchorsAcrossPages(ANCHORS, pages)).toEqual(expected);
    expect(
      deriveMatchAnchorsAcrossPages(ANCHORS, pages, pageWindowOf({ from: 3, to: 3 }, pages.length)),
    ).toEqual(expected);
  });
});

describe('deriveAcrossPages through the window (U5/R9)', () => {
  const blank = { items: [], width: A4.width, height: A4.height };
  const withTable = { items: pageText(), width: A4.width, height: A4.height };

  it('an identical table on two pages lands in the window instead of on the first page that fits', () => {
    const pages = [blank, blank, withTable, blank, blank, withTable];

    // The contrast case first: without a window, the earlier page wins — the
    // exact first-page capture the section-move tool exists to clean up after.
    expect(deriveAcrossPages(tableField(), pages)!.segment.page).toBe(2);

    const res = deriveAcrossPages(tableField(), pages, pageWindowOf({ from: 6, to: 6 }, pages.length));

    expect(res).not.toBeNull();
    expect(res!.segment.page).toBe(5);
    expect(res!.confidence).toBeLessThanOrEqual(WINDOW_CONFIDENCE_CAP);
    expect(classifyProposalTier(res)).toBe('needs-review');
    expect(res!.notes[res!.notes.length - 1]).toBe(
      'Matched on page 6; page 3 excluded by the extraction window (page 6).',
    );
  });

  it('two in-window candidates do NOT refuse — the existing tiebreak picks, capped because a page was excluded', () => {
    // The table path never refused on ambiguity and does not start to (R9):
    // pages 5 and 6 are both in the stamped {5,6} window, page 3 is excluded.
    const pages = [blank, blank, withTable, blank, withTable, withTable];

    const res = deriveAcrossPages(tableField(), pages, pageWindowOf({ from: 5, to: 6 }, pages.length));

    expect(res).not.toBeNull();
    // The existing tiebreak (earlier page on a full tie) runs over the
    // in-window survivors only.
    expect(res!.segment.page).toBe(4);
    expect(res!.confidence).toBeLessThanOrEqual(WINDOW_CONFIDENCE_CAP);
    expect(res!.notes[res!.notes.length - 1]).toBe(
      'Matched on page 5; page 3 excluded by the extraction window (pages 5–6).',
    );
  });

  it('no in-window candidate: the existing best-pick runs over everything, capped with the outside note', () => {
    const pages = [blank, blank, withTable, blank, blank, blank];

    const res = deriveAcrossPages(tableField(), pages, pageWindowOf({ from: 5, to: 6 }, pages.length));

    expect(res).not.toBeNull();
    expect(res!.segment.page).toBe(2);
    expect(res!.confidence).toBeLessThanOrEqual(WINDOW_CONFIDENCE_CAP);
    expect(res!.notes[res!.notes.length - 1]).toBe(
      'Matched on page 3, outside the extraction window (pages 5–6) — check the page.',
    );
  });

  it('no window is byte-identical to the pre-change pick, and equals the untouched per-page derivation', () => {
    const pages = [blank, blank, withTable, blank, blank, withTable];

    // The across-pages combiner adds nothing to deriveForField's own pick.
    const expected = deriveForField(tableField(), 2, withTable.items, A4.width, A4.height);
    expect(expected).not.toBeNull();
    expect(deriveAcrossPages(tableField(), pages)).toEqual(expected);
    expect(deriveAcrossPages(tableField(), pages, null)).toEqual(expected);
  });

  it('every candidate in-window means the window changed nothing — deep-equal to the unwindowed pick', () => {
    const pages = [blank, blank, withTable, withTable];

    const unwindowed = deriveAcrossPages(tableField(), pages);
    const windowed = deriveAcrossPages(
      tableField(),
      pages,
      pageWindowOf({ from: 3, to: 4 }, pages.length),
    );

    expect(windowed).toEqual(unwindowed);
    expect(windowed!.confidence).toBe(1); // untouched, still auto-confirmable
  });

  it('an ordinal field without a window keeps the pre-change path, null included', () => {
    // No fixture in the suite can make a per-page ordinal pick succeed (the
    // rightmost-cluster rule collapses side-by-side groups into one proposal,
    // so stacked look-alikes refuse — the ADMN regression above). What must
    // hold is that a window neither invents a pick where the unwindowed path
    // refused everywhere, nor disturbs the refusal.
    const field = tableField({ groupOrdinal: { index: 0, count: 3 }, fixedRows: undefined });
    const pages = [blank, withTable];

    expect(deriveAcrossPages(field, pages)).toBeNull();
    expect(deriveAcrossPages(field, pages, pageWindowOf({ from: 1, to: 2 }, pages.length))).toBeNull();
  });
});
