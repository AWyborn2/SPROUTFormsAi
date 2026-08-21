import { describe, expect, it } from 'vitest';
import {
  ACCEPT_VIAS,
  ADJUSTMENT_KINDS,
  DERIVATION_METHODS,
  MAGNITUDE_BUCKETS,
  PAGE_DELTA_BUCKETS,
  PLACEMENT_FIELD_CLASSES,
  PLACEMENT_PROPOSAL_TIERS,
  type PlacementEvent,
} from './placement-outcomes.js';
import { placementShapeOf, tallyPlacementShapes } from './placement-shapes.js';

describe('placementShapeOf — content-free keys', () => {
  it('keys a proposal by method and tier', () => {
    expect(
      placementShapeOf({ kind: 'proposed', fieldId: 'f1', method: 'table', tier: 'needs-review' }),
    ).toBe('proposal:table:needs-review');
    expect(
      placementShapeOf({ kind: 'proposed', fieldId: 'f1', method: 'option-cells', tier: 'auto-confirm' }),
    ).toBe('proposal:option-cells:auto-confirm');
  });

  it('keys a refusal as its own family, per method', () => {
    expect(
      placementShapeOf({ kind: 'proposed', fieldId: 'f1', method: 'option-cells', tier: 'no-match' }),
    ).toBe('no-match:option-cells');
  });

  it('keys an accept by method and via', () => {
    expect(
      placementShapeOf({ kind: 'accepted', fieldId: 'f1', method: 'table', via: 'confirm-all' }),
    ).toBe('accepted:table:confirm-all');
  });

  it('keys an adjustment by kind and magnitude bucket', () => {
    expect(
      placementShapeOf({
        kind: 'adjusted',
        fieldId: 'f1',
        adjustment: 'column-band',
        bucket: '>4pt',
        phase: 'preview',
      }),
    ).toBe('adjusted:column-band:>4pt');
  });

  it('keys a rejection by method, a manual draw by field class, a retarget by delta bucket', () => {
    expect(placementShapeOf({ kind: 'rejected', fieldId: 'f1', method: 'match-anchor' })).toBe(
      'rejected:match-anchor',
    );
    expect(
      placementShapeOf({ kind: 'manual-draw', fieldId: 'f1', fieldTypeClass: 'option' }),
    ).toBe('manual-draw:option');
    expect(
      placementShapeOf({ kind: 'retargeted', fieldId: 'f1', pageDeltaBucket: '+2..4' }),
    ).toBe('retargeted-page:+2..4');
  });

  it('gives two events that differ only in fieldId the SAME shape', () => {
    const a: PlacementEvent = { kind: 'adjusted', fieldId: 'field-abc', adjustment: 'row-band', bucket: '≤2pt', phase: 'placed' };
    const b: PlacementEvent = { kind: 'adjusted', fieldId: 'field-xyz', adjustment: 'row-band', bucket: '≤2pt', phase: 'placed' };
    expect(placementShapeOf(a)).toBe(placementShapeOf(b));
  });

  it('never leaks a field id into any key, across the whole event vocabulary', () => {
    // A generated corpus over every kind × every enum value, each carrying a
    // deliberately distinctive field id — no key may contain it.
    const fieldId = 'LEAKY-FIELD-ID-9f3c';
    const corpus: PlacementEvent[] = [
      ...DERIVATION_METHODS.flatMap((method) =>
        PLACEMENT_PROPOSAL_TIERS.map(
          (tier): PlacementEvent => ({ kind: 'proposed', fieldId, method, tier }),
        ),
      ),
      ...DERIVATION_METHODS.flatMap((method) =>
        ACCEPT_VIAS.map((via): PlacementEvent => ({ kind: 'accepted', fieldId, method, via })),
      ),
      ...ADJUSTMENT_KINDS.flatMap((adjustment) =>
        MAGNITUDE_BUCKETS.map(
          (bucket): PlacementEvent => ({ kind: 'adjusted', fieldId, adjustment, bucket, phase: 'preview' }),
        ),
      ),
      ...DERIVATION_METHODS.map((method): PlacementEvent => ({ kind: 'rejected', fieldId, method })),
      ...PLACEMENT_FIELD_CLASSES.map(
        (fieldTypeClass): PlacementEvent => ({ kind: 'manual-draw', fieldId, fieldTypeClass }),
      ),
      ...PAGE_DELTA_BUCKETS.map(
        (pageDeltaBucket): PlacementEvent => ({ kind: 'retargeted', fieldId, pageDeltaBucket }),
      ),
    ];
    for (const event of corpus) {
      expect(placementShapeOf(event)).not.toContain(fieldId);
    }
  });

  it('produces a stable documented key for every event kind', () => {
    // The vocabulary itself, pinned: renaming a key silently re-clusters every
    // stored row, so a change here must be deliberate.
    const samples: [PlacementEvent, string][] = [
      [{ kind: 'proposed', fieldId: 'f', method: 'match-anchor', tier: 'needs-review' }, 'proposal:match-anchor:needs-review'],
      [{ kind: 'proposed', fieldId: 'f', method: 'table', tier: 'no-match' }, 'no-match:table'],
      [{ kind: 'accepted', fieldId: 'f', method: 'option-cells', via: 'auto' }, 'accepted:option-cells:auto'],
      [{ kind: 'adjusted', fieldId: 'f', adjustment: 'box-moved', bucket: '≤4pt', phase: 'placed' }, 'adjusted:box-moved:≤4pt'],
      [{ kind: 'rejected', fieldId: 'f', method: 'table' }, 'rejected:table'],
      [{ kind: 'manual-draw', fieldId: 'f', fieldTypeClass: 'row' }, 'manual-draw:row'],
      [{ kind: 'retargeted', fieldId: 'f', pageDeltaBucket: '-5+' }, 'retargeted-page:-5+'],
    ];
    for (const [event, key] of samples) {
      expect(placementShapeOf(event)).toBe(key);
    }
  });
});

describe('tallyPlacementShapes', () => {
  it('counts each distinct shape across a batch', () => {
    const events: PlacementEvent[] = [
      { kind: 'adjusted', fieldId: 'f1', adjustment: 'column-band', bucket: '>4pt', phase: 'preview' },
      { kind: 'adjusted', fieldId: 'f2', adjustment: 'column-band', bucket: '>4pt', phase: 'placed' },
      { kind: 'retargeted', fieldId: 'f3', pageDeltaBucket: '+2..4' },
    ];
    const tally = tallyPlacementShapes(events);
    expect(tally.get('adjusted:column-band:>4pt')).toBe(2);
    expect(tally.get('retargeted-page:+2..4')).toBe(1);
  });
});
