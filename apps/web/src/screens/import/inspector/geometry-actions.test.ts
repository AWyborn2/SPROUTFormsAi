/**
 * Geometry panel decisions (U4, R7/R8/R9).
 *
 * The fixtures are the same measured page-7 header the derivation is tested
 * against, for the same reason: this code decides what a reviewer is allowed to
 * confirm, and evenly-spaced synthetic input would not exercise a single real
 * irregularity.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import type { PositionedText } from '../../../lib/pdf-geometry.js';
import {
  NUDGE_POINTS,
  SNAP_RANGE,
  columnHandles,
  deriveAcrossPages,
  deriveForField,
  panelState,
  snapEdge,
  snapTargets,
  unsupportedReason,
} from './geometry-actions.js';

const A4 = { width: 595, height: 842 };

function tableField(patch: Partial<FormField> = {}): FormField {
  return {
    id: 'f1',
    type: 'repeating_group',
    label: 'Operational requirements',
    required: false,
    source: 'imported',
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'tick', label: '✓', type: 'boolean_yes_no' },
      { key: 'cross', label: '×', type: 'boolean_yes_no' },
      { key: 'na', label: 'N/A', type: 'boolean_yes_no' },
    ],
    ...patch,
  };
}

/** Two occurrences of the measured page-7 table, so headers corroborate. */
function pageText(): PositionedText[] {
  const table = (dy: number, rows: number): PositionedText[] => [
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
  return [...table(0, 4), ...table(200, 2)];
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
    // to this field. Row count is the strongest available signal.
    const field = tableField({ fixedRows: ['a', 'b'] });

    const proposal = deriveForField(field, 6, pageText(), A4.width, A4.height);

    expect(proposal?.segment.rowBands).toHaveLength(2);
  });

  it('falls back to the most confident proposal when row count is unknowable', () => {
    const proposal = deriveForField(tableField(), 6, pageText(), A4.width, A4.height);

    expect(proposal?.confidence).toBe(1);
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
