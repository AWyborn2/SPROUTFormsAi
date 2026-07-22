/**
 * Field geometry resolution (U2, R1-R4).
 *
 * Lives in apps/api because packages/shared has no test runner — the same
 * arrangement as answer-set.test.ts and visibility.test.ts.
 *
 * The rule every case here pins: geometry that cannot be trusted resolves to
 * NOTHING, never to a best guess. A field with no geometry exports as data,
 * which is a visibly incomplete PDF. A field with wrong geometry exports a
 * confident mark in the wrong cell of a competency record, which reads as a
 * statement about whether an operator was assessed as safe. The second failure
 * is far worse than the first, so every resolver here degrades toward silence.
 */
import { describe, expect, it } from 'vitest';
import { resolveGeometry, geometrySegments, bandFor } from '@formai/shared';
import type { FieldGeometry, FormField, SourcePosition } from '@formai/shared';

function field(patch: Partial<FormField> = {}): FormField {
  return {
    id: 'f1',
    type: 'repeating_group',
    label: 'Operational requirements',
    required: false,
    source: 'imported',
    ...patch,
  };
}

/** The dozer's page-7 observation table, measured from the real document. */
function dozerGeometry(): FieldGeometry {
  return {
    segments: [
      {
        page: 6,
        x: 34,
        y: 300,
        width: 528,
        height: 340,
        pageWidth: 595,
        pageHeight: 842,
        columnBands: [
          { key: 'item', start: 34, end: 500 },
          { key: 'tick', start: 500, end: 511 },
          { key: 'cross', start: 511, end: 536 },
          { key: 'na', start: 536, end: 562 },
        ],
        rowBands: [
          { key: 'r0', start: 620, end: 640 },
          { key: 'r1', start: 600, end: 620 },
        ],
      },
    ],
  };
}

describe('resolveGeometry — segments', () => {
  it('returns the segments of well-formed geometry', () => {
    const out = resolveGeometry(field({ geometry: dozerGeometry() }), 18);

    expect(out.segments).toHaveLength(1);
    expect(out.dropped).toEqual([]);
    expect(out.segments[0]?.page).toBe(6);
  });

  it('resolves a field with no geometry to nothing, without error', () => {
    const out = resolveGeometry(field(), 18);

    expect(out.segments).toEqual([]);
    expect(out.dropped).toEqual([]);
  });

  it('drops a segment naming a page beyond the document', () => {
    const g = dozerGeometry();
    g.segments[0]!.page = 40;

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.segments).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('page-out-of-range');
  });

  it('drops a segment with a negative page index', () => {
    const g = dozerGeometry();
    g.segments[0]!.page = -1;

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.dropped[0]?.reason).toBe('page-out-of-range');
  });

  it('drops a segment whose box has no area', () => {
    const g = dozerGeometry();
    g.segments[0]!.width = 0;

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.dropped[0]?.reason).toBe('invalid-box');
  });

  it('keeps every valid segment of a table that spans two pages', () => {
    const g = dozerGeometry();
    g.segments.push({ ...g.segments[0]!, page: 7 });

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.segments.map((s) => s.page)).toEqual([6, 7]);
  });

  it('drops only the bad segment of a multi-segment table, keeping the good one', () => {
    const g = dozerGeometry();
    g.segments.push({ ...g.segments[0]!, page: 99 });

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.segments.map((s) => s.page)).toEqual([6]);
    expect(out.dropped).toHaveLength(1);
  });

  it('resolves without a page count when the document length is unknown', () => {
    const out = resolveGeometry(field({ geometry: dozerGeometry() }));

    expect(out.segments).toHaveLength(1);
  });
});

describe('resolveGeometry — bands', () => {
  it('drops a segment whose column bands overlap', () => {
    const g = dozerGeometry();
    g.segments[0]!.columnBands = [
      { key: 'tick', start: 500, end: 520 },
      { key: 'cross', start: 511, end: 536 },
    ];

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.segments).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('overlapping-bands');
  });

  it('drops a segment carrying a zero-width band', () => {
    const g = dozerGeometry();
    g.segments[0]!.columnBands = [{ key: 'tick', start: 500, end: 500 }];

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.dropped[0]?.reason).toBe('empty-band');
  });

  it('drops a segment carrying an inverted band', () => {
    const g = dozerGeometry();
    g.segments[0]!.columnBands = [{ key: 'tick', start: 536, end: 500 }];

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.dropped[0]?.reason).toBe('empty-band');
  });

  it('accepts bands that do not cover the full box width', () => {
    // The printed table has gutters, and the label column is often wider than
    // the sum of the option columns. Requiring full coverage would reject every
    // real table in the library.
    const g = dozerGeometry();
    g.segments[0]!.columnBands = [
      { key: 'tick', start: 500, end: 511 },
      { key: 'na', start: 536, end: 562 },
    ];

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.segments).toHaveLength(1);
    expect(out.dropped).toEqual([]);
  });

  it('accepts a segment with no bands at all — a scalar field', () => {
    const g: FieldGeometry = {
      segments: [
        { page: 0, x: 101, y: 352, width: 135, height: 16, pageWidth: 595, pageHeight: 420 },
      ],
    };

    const out = resolveGeometry(field({ type: 'text', geometry: g }), 1);

    expect(out.segments).toHaveLength(1);
  });

  it('detects overlap regardless of band declaration order', () => {
    const g = dozerGeometry();
    g.segments[0]!.columnBands = [
      { key: 'cross', start: 511, end: 536 },
      { key: 'tick', start: 500, end: 520 },
    ];

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.dropped[0]?.reason).toBe('overlapping-bands');
  });

  it('treats touching bands as adjacent, not overlapping', () => {
    const g = dozerGeometry();
    g.segments[0]!.columnBands = [
      { key: 'tick', start: 500, end: 511 },
      { key: 'cross', start: 511, end: 536 },
    ];

    const out = resolveGeometry(field({ geometry: g }), 18);

    expect(out.segments).toHaveLength(1);
  });
});

describe('geometrySegments — legacy sourcePosition bridge (R4)', () => {
  const legacy: SourcePosition = {
    page: 2,
    x: 120,
    y: 300,
    width: 200,
    height: 18,
    pageWidth: 900,
    pageHeight: 500,
  };

  it('resolves a legacy-only field to one segment on its real page', () => {
    const out = geometrySegments(field({ type: 'text', sourcePosition: legacy }), 4);

    expect(out).toHaveLength(1);
    expect(out[0]?.page).toBe(2);
    expect(out[0]?.x).toBe(120);
    expect(out[0]?.pageWidth).toBe(900);
  });

  it('carries no bands for a legacy position — there are none to invent', () => {
    const out = geometrySegments(field({ type: 'text', sourcePosition: legacy }), 4);

    expect(out[0]?.columnBands).toBeUndefined();
    expect(out[0]?.rowBands).toBeUndefined();
  });

  it('prefers explicit geometry when a field carries both', () => {
    const out = geometrySegments(
      field({ geometry: dozerGeometry(), sourcePosition: legacy }),
      18,
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.page).toBe(6);
  });

  it('falls back to the legacy position when explicit geometry is entirely invalid', () => {
    const g = dozerGeometry();
    g.segments[0]!.page = 99;

    const out = geometrySegments(field({ geometry: g, sourcePosition: legacy }), 18);

    expect(out).toHaveLength(1);
    expect(out[0]?.page).toBe(2);
  });

  it('resolves a field with neither to no segments', () => {
    expect(geometrySegments(field({ type: 'text' }), 4)).toEqual([]);
  });

  it('drops a legacy position naming a page beyond the document', () => {
    const out = geometrySegments(field({ type: 'text', sourcePosition: { ...legacy, page: 9 } }), 4);

    expect(out).toEqual([]);
  });
});

describe('bandFor', () => {
  it('returns the band owning a column key', () => {
    const seg = resolveGeometry(field({ geometry: dozerGeometry() }), 18).segments[0]!;

    expect(bandFor(seg, 'cross')).toEqual({ key: 'cross', start: 511, end: 536 });
  });

  it('returns undefined for a column the table has no band for', () => {
    const seg = resolveGeometry(field({ geometry: dozerGeometry() }), 18).segments[0]!;

    expect(bandFor(seg, 'comments')).toBeUndefined();
  });

  it('returns undefined on a segment carrying no bands', () => {
    const seg = {
      page: 0,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      pageWidth: 595,
      pageHeight: 842,
    };

    expect(bandFor(seg, 'tick')).toBeUndefined();
  });
});
