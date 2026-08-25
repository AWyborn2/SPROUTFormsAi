import { describe, expect, it } from 'vitest';
import {
  magnitudeBucketOf,
  pageDeltaBucketOf,
  tallyPlacementOutcomes,
  type PlacementEvent,
} from './placement-outcomes.js';

describe('magnitudeBucketOf', () => {
  it('buckets at the 2pt/4pt boundaries, inclusive on the low side', () => {
    expect(magnitudeBucketOf(0.5)).toBe('≤2pt');
    expect(magnitudeBucketOf(2)).toBe('≤2pt');
    expect(magnitudeBucketOf(2.1)).toBe('≤4pt');
    expect(magnitudeBucketOf(4)).toBe('≤4pt');
    expect(magnitudeBucketOf(4.1)).toBe('>4pt');
    expect(magnitudeBucketOf(30)).toBe('>4pt');
  });

  it('discards direction — a band dragged left buckets like one dragged right', () => {
    expect(magnitudeBucketOf(-3)).toBe(magnitudeBucketOf(3));
  });
});

describe('pageDeltaBucketOf', () => {
  it('buckets forward and backward deltas symmetrically', () => {
    expect(pageDeltaBucketOf(1)).toBe('+1');
    expect(pageDeltaBucketOf(3)).toBe('+2..4');
    expect(pageDeltaBucketOf(4)).toBe('+2..4');
    expect(pageDeltaBucketOf(5)).toBe('+5+');
    expect(pageDeltaBucketOf(-1)).toBe('-1');
    expect(pageDeltaBucketOf(-4)).toBe('-2..4');
    expect(pageDeltaBucketOf(-9)).toBe('-5+');
  });

  it('returns null for zero — a move to the same page is not a move', () => {
    expect(pageDeltaBucketOf(0)).toBeNull();
  });
});

describe('tallyPlacementOutcomes', () => {
  const proposed = (
    fieldId: string,
    tier: 'auto-confirm' | 'needs-review' | 'no-match',
    method: 'match-anchor' | 'option-cells' | 'table' = 'option-cells',
  ): PlacementEvent => ({ kind: 'proposed', fieldId, method, tier });

  it('returns an all-zero tally for an empty stream', () => {
    expect(tallyPlacementOutcomes([])).toEqual({
      proposalsAttempted: 0,
      autoConfirmed: 0,
      acceptedAsIs: 0,
      adjusted: 0,
      rejected: 0,
      noMatch: 0,
      manualDraws: 0,
      retargets: 0,
    });
  });

  it('counts a field proposed twice as ONE attempt at its LATEST tier (KTD4)', () => {
    // needs-review from the whole-document pass, then auto-confirm after a
    // page-scoped Scan re-run — one attempt, tiered by the later derive.
    const tally = tallyPlacementOutcomes([
      proposed('f1', 'needs-review'),
      proposed('f1', 'auto-confirm'),
    ]);
    expect(tally.proposalsAttempted).toBe(1);
    expect(tally.autoConfirmed).toBe(1);
  });

  it('counts an adjusted-then-accepted field in BOTH adjusted and acceptedAsIs', () => {
    const tally = tallyPlacementOutcomes([
      proposed('f1', 'needs-review'),
      { kind: 'adjusted', fieldId: 'f1', adjustment: 'column-band', bucket: '>4pt', phase: 'preview' },
      { kind: 'accepted', fieldId: 'f1', method: 'option-cells', via: 'confirm' },
    ]);
    expect(tally.adjusted).toBe(1);
    expect(tally.acceptedAsIs).toBe(1);
  });

  it('does not count an auto-accept in acceptedAsIs — its tier already carries it', () => {
    const tally = tallyPlacementOutcomes([
      proposed('f1', 'auto-confirm'),
      { kind: 'accepted', fieldId: 'f1', method: 'option-cells', via: 'auto' },
    ]);
    expect(tally.autoConfirmed).toBe(1);
    expect(tally.acceptedAsIs).toBe(0);
  });

  it('counts a rejected field that was later hand-drawn as one rejection and one manual draw', () => {
    const tally = tallyPlacementOutcomes([
      proposed('f1', 'needs-review'),
      { kind: 'rejected', fieldId: 'f1', method: 'option-cells' },
      { kind: 'manual-draw', fieldId: 'f1', fieldTypeClass: 'option' },
    ]);
    expect(tally.rejected).toBe(1);
    expect(tally.manualDraws).toBe(1);
  });

  it('counts once-per-field counters by field, not by event', () => {
    const tally = tallyPlacementOutcomes([
      proposed('f1', 'needs-review', 'table'),
      { kind: 'adjusted', fieldId: 'f1', adjustment: 'column-band', bucket: '≤2pt', phase: 'preview' },
      { kind: 'adjusted', fieldId: 'f1', adjustment: 'row-band', bucket: '>4pt', phase: 'preview' },
      proposed('f2', 'no-match'),
      { kind: 'manual-draw', fieldId: 'f2', fieldTypeClass: 'scalar' },
      { kind: 'manual-draw', fieldId: 'f2', fieldTypeClass: 'scalar' },
    ]);
    expect(tally.adjusted).toBe(1);
    expect(tally.manualDraws).toBe(1);
    expect(tally.noMatch).toBe(1);
    expect(tally.proposalsAttempted).toBe(2);
  });

  it('counts every retarget event — one per field moved, per move', () => {
    const tally = tallyPlacementOutcomes([
      { kind: 'retargeted', fieldId: 'f1', pageDeltaBucket: '+2..4' },
      { kind: 'retargeted', fieldId: 'f2', pageDeltaBucket: '+2..4' },
      { kind: 'retargeted', fieldId: 'f1', pageDeltaBucket: '-1' },
    ]);
    expect(tally.retargets).toBe(3);
  });

  it('reproduces AE1 arithmetic across a mixed session', () => {
    // 2 auto-confirm, 3 needs-review (1 accepted as-is, 1 adjusted-then-
    // accepted, 1 rejected then hand-drawn), 1 no-match. The tallies must
    // partition the review queue and feed KTD4's rates.
    const events: PlacementEvent[] = [
      proposed('a1', 'auto-confirm'),
      { kind: 'accepted', fieldId: 'a1', method: 'option-cells', via: 'auto' },
      proposed('a2', 'auto-confirm', 'table'),
      { kind: 'accepted', fieldId: 'a2', method: 'table', via: 'auto' },
      proposed('r1', 'needs-review'),
      { kind: 'accepted', fieldId: 'r1', method: 'option-cells', via: 'confirm-all' },
      proposed('r2', 'needs-review', 'table'),
      { kind: 'adjusted', fieldId: 'r2', adjustment: 'column-band', bucket: '>4pt', phase: 'preview' },
      { kind: 'accepted', fieldId: 'r2', method: 'table', via: 'confirm' },
      proposed('r3', 'needs-review'),
      { kind: 'rejected', fieldId: 'r3', method: 'option-cells' },
      { kind: 'manual-draw', fieldId: 'r3', fieldTypeClass: 'option' },
      proposed('n1', 'no-match', 'match-anchor'),
    ];
    expect(tallyPlacementOutcomes(events)).toEqual({
      proposalsAttempted: 6,
      autoConfirmed: 2,
      acceptedAsIs: 2,
      adjusted: 1,
      rejected: 1,
      noMatch: 1,
      manualDraws: 1,
      retargets: 0,
    });
  });
});
