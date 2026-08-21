import { describe, expect, it } from 'vitest';
import type { PlacementEvent, PlacementOutcomes } from '@formai/shared';
import {
  aggregatePlacementRows,
  isoWeekOf,
  placementSuggestionFor,
  type PlacementOutcomeRow,
} from './placement-insights.js';

/** A row whose tallies and payload agree — the invariant the write route enforces. */
function row(opts: {
  documentType?: string | null;
  createdAt?: string;
  events?: PlacementEvent[];
  tallies?: Partial<Pick<PlacementOutcomeRow, 'proposalsAttempted' | 'autoConfirmed' | 'acceptedAsIs' | 'adjusted' | 'rejected' | 'noMatch' | 'manualDraws' | 'retargets'>>;
}): PlacementOutcomeRow {
  const outcomes: PlacementOutcomes = {
    context: 'standalone',
    fieldCount: 10,
    events: opts.events ?? [],
  };
  return {
    documentType: opts.documentType === undefined ? 'assessment' : opts.documentType,
    createdAt: opts.createdAt ?? '2026-08-18T10:00:00Z',
    outcomes,
    proposalsAttempted: 0,
    autoConfirmed: 0,
    acceptedAsIs: 0,
    adjusted: 0,
    rejected: 0,
    noMatch: 0,
    manualDraws: 0,
    retargets: 0,
    ...opts.tallies,
  };
}

describe('isoWeekOf', () => {
  it('names the ISO week, Monday-led, year of the Thursday', () => {
    expect(isoWeekOf('2026-08-18T10:00:00Z')).toBe('2026-W34'); // a Tuesday
    expect(isoWeekOf('2026-08-24T10:00:00Z')).toBe('2026-W35'); // the next Monday
    // January 1st 2027 is a Friday — it belongs to 2026's last week.
    expect(isoWeekOf('2027-01-01T10:00:00Z')).toBe('2026-W53');
  });
});

describe('aggregatePlacementRows — the hit-rate metric (KTD4)', () => {
  it('computes the AE1 rates from the denormalised tallies', () => {
    // The AE1 paper, scaled: 180 auto-confirm, 60 needs-review (40 as-is, 15
    // adjusted-then-confirmed, 5 rejected + hand-drawn), 60 no-match.
    const { metrics } = aggregatePlacementRows([
      row({
        tallies: {
          proposalsAttempted: 300,
          autoConfirmed: 180,
          acceptedAsIs: 55,
          adjusted: 15,
          rejected: 5,
          noMatch: 60,
          manualDraws: 5,
        },
      }),
    ]);

    expect(metrics).toHaveLength(1);
    const m = metrics[0]!;
    expect(m.documentType).toBe('assessment');
    expect(m.hitRate).toBeCloseTo(0.6);
    expect(m.noMatchRate).toBeCloseTo(0.2);
    expect(m.needsReviewRate).toBeCloseTo(0.2);
    // 15 adjusted over 235 placed via a proposal (180 auto + 55 accepted).
    expect(m.adjustmentRate).toBeCloseTo(15 / 235);
    expect(m.sessions).toBe(1);
  });

  it('sums tallies across sessions per type and buckets a null type as unspecified', () => {
    const { metrics } = aggregatePlacementRows([
      row({ tallies: { proposalsAttempted: 10, autoConfirmed: 5 } }),
      row({ tallies: { proposalsAttempted: 10, autoConfirmed: 7 } }),
      row({ documentType: null, tallies: { proposalsAttempted: 4, autoConfirmed: 1 } }),
    ]);

    const assessment = metrics.find((m) => m.documentType === 'assessment');
    expect(assessment).toMatchObject({ sessions: 2, proposalsAttempted: 20, autoConfirmed: 12 });
    expect(assessment!.hitRate).toBeCloseTo(0.6);
    expect(metrics.find((m) => m.documentType === 'unspecified')).toMatchObject({
      sessions: 1,
      proposalsAttempted: 4,
    });
  });

  it('folds the per-method hit rate from the jsonb events', () => {
    const events: PlacementEvent[] = [
      { kind: 'proposed', fieldId: 'f1', method: 'table', tier: 'auto-confirm' },
      { kind: 'proposed', fieldId: 'f2', method: 'table', tier: 'needs-review' },
      { kind: 'proposed', fieldId: 'f3', method: 'option-cells', tier: 'auto-confirm' },
    ];
    const { metrics } = aggregatePlacementRows([
      row({ events, tallies: { proposalsAttempted: 3, autoConfirmed: 2 } }),
    ]);

    const byMethod = metrics[0]!.byMethod;
    expect(byMethod.find((m) => m.method === 'table')).toMatchObject({
      attempted: 2,
      autoConfirmed: 1,
      hitRate: 0.5,
    });
    expect(byMethod.find((m) => m.method === 'option-cells')).toMatchObject({
      attempted: 1,
      autoConfirmed: 1,
      hitRate: 1,
    });
  });

  it('clusters shapes by content-free key, most frequent first, carrying no field text', () => {
    const adjusted = (fieldId: string): PlacementEvent => ({
      kind: 'adjusted',
      fieldId,
      adjustment: 'column-band',
      bucket: '>4pt',
      phase: 'preview',
    });
    const { shapes } = aggregatePlacementRows([
      row({ events: [adjusted('f1'), adjusted('f2')] }),
      row({ events: [adjusted('f3'), { kind: 'retargeted', fieldId: 'f4', pageDeltaBucket: '+2..4' }] }),
    ]);

    expect(shapes[0]).toMatchObject({
      documentType: 'assessment',
      shape: 'adjusted:column-band:>4pt',
      count: 3,
    });
    expect(shapes.find((s) => s.shape === 'retargeted-page:+2..4')?.count).toBe(1);
    for (const s of shapes) {
      expect(s.shape).not.toMatch(/f[1-4]/);
    }
  });

  it('buckets the trend by ISO week across a month of rows', () => {
    const { trend } = aggregatePlacementRows([
      row({ createdAt: '2026-08-04T09:00:00Z', tallies: { proposalsAttempted: 10, autoConfirmed: 4, acceptedAsIs: 2, adjusted: 3 } }),
      row({ createdAt: '2026-08-06T09:00:00Z', tallies: { proposalsAttempted: 10, autoConfirmed: 6, acceptedAsIs: 0, adjusted: 0 } }),
      row({ createdAt: '2026-08-27T09:00:00Z', tallies: { proposalsAttempted: 10, autoConfirmed: 8, acceptedAsIs: 1, adjusted: 1 } }),
    ]);

    expect(trend.map((t) => t.week)).toEqual(['2026-W32', '2026-W35']);
    expect(trend[0]).toMatchObject({ sessions: 2, proposalsAttempted: 20, autoConfirmed: 10 });
    expect(trend[0]!.hitRate).toBeCloseTo(0.5);
    // 3 adjusted over 12 placed via a proposal that week (10 auto + 2 accepted).
    expect(trend[0]!.adjustmentRate).toBeCloseTo(3 / 12);
    expect(trend[1]!.hitRate).toBeCloseTo(0.8);
  });

  it('returns empty aggregates, not NaN rates, for no rows', () => {
    expect(aggregatePlacementRows([])).toEqual({ metrics: [], shapes: [], trend: [] });
  });
});

describe('placementSuggestionFor', () => {
  it('points a column-band cluster at the column derivation, whatever the bucket', () => {
    expect(placementSuggestionFor('adjusted:column-band:>4pt')).toContain('proposeTableSegments');
    expect(placementSuggestionFor('adjusted:column-band:≤2pt')).toContain('proposeTableSegments');
  });

  it('points a retarget cluster at page targeting / sourcePages', () => {
    expect(placementSuggestionFor('retargeted-page:+2..4')).toContain('sourcePages');
  });

  it('points an option-cells refusal at marker-glyph matching', () => {
    expect(placementSuggestionFor('no-match:option-cells')).toContain('proposeFieldOptionCells');
  });

  it('falls back to the generic reviewed-PR prompt for an unmapped shape', () => {
    expect(placementSuggestionFor('accepted:table:confirm')).toContain('reviewed PR');
  });
});
