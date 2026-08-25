/**
 * The recorder is the placement loop's risky seam — the session semantics
 * (upsert-on-re-propose, drain-once, the prior-refusal guard) live here, pure,
 * so they are tested without React. `GeometryEditorScreen.test.tsx` then only
 * checks that the wiring routes through it.
 */
import { describe, expect, it } from 'vitest';
import { tallyPlacementOutcomes } from '@formai/shared';
import { createPlacementRecorder } from './placement-recorder.js';

describe('placement recorder — proposals', () => {
  it('upserts a re-proposed field to its latest tier (KTD4)', () => {
    const r = createPlacementRecorder();
    r.proposed('f1', 'option-cells', 'needs-review');
    // A page-scoped Scan re-run lands a clean match this time.
    r.proposed('f1', 'option-cells', 'auto-confirm');

    const events = r.drain();
    const proposals = events.filter((e) => e.kind === 'proposed');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ fieldId: 'f1', tier: 'auto-confirm' });
  });

  it('stamps the remembered method onto accepts and rejects', () => {
    const r = createPlacementRecorder();
    r.proposed('f1', 'table', 'needs-review');
    r.accepted('f1', 'confirm');
    r.proposed('f2', 'match-anchor', 'needs-review');
    r.rejected('f2');

    const events = r.drain();
    expect(events.find((e) => e.kind === 'accepted')).toMatchObject({ method: 'table', via: 'confirm' });
    expect(events.find((e) => e.kind === 'rejected')).toMatchObject({ method: 'match-anchor' });
  });

  it('drops an accept or reject for a field that was never proposed — not engine feedback', () => {
    const r = createPlacementRecorder();
    r.accepted('ghost', 'confirm');
    r.rejected('ghost');
    expect(r.drain()).toEqual([]);
  });
});

describe('placement recorder — adjustment bucketing', () => {
  it('buckets raw point deltas at the 2pt/4pt boundaries', () => {
    const r = createPlacementRecorder();
    r.previewAdjusted('f1', 'column-band', 2);
    r.previewAdjusted('f2', 'column-band', -3.5);
    r.placedAdjusted('f3', 'box-moved', 10);

    const events = r.drain();
    expect(events).toContainEqual({ kind: 'adjusted', fieldId: 'f1', adjustment: 'column-band', bucket: '≤2pt', phase: 'preview' });
    expect(events).toContainEqual({ kind: 'adjusted', fieldId: 'f2', adjustment: 'column-band', bucket: '≤4pt', phase: 'preview' });
    expect(events).toContainEqual({ kind: 'adjusted', fieldId: 'f3', adjustment: 'box-moved', bucket: '>4pt', phase: 'placed' });
  });

  it('records one finding per (field, kind, bucket, phase), not one per gesture', () => {
    const r = createPlacementRecorder();
    // A drag emits a stream of edge moves; ten 1pt nudges are one finding.
    for (let i = 0; i < 10; i += 1) r.placedAdjusted('f1', 'box-moved', 1);
    expect(r.drain().filter((e) => e.kind === 'adjusted')).toHaveLength(1);
  });

  it('ignores a zero or non-finite delta — nothing moved', () => {
    const r = createPlacementRecorder();
    r.placedAdjusted('f1', 'box-moved', 0);
    r.placedAdjusted('f1', 'row-band', Number.NaN);
    expect(r.drain()).toEqual([]);
  });
});

describe('placement recorder — the prior-refusal guard on manual draws', () => {
  it('ignores a hand draw on a never-proposed field', () => {
    const r = createPlacementRecorder();
    r.manualDraw('f1', 'scalar');
    expect(r.drain()).toEqual([]);
  });

  it('counts a hand draw after a no-match refusal, once per field', () => {
    const r = createPlacementRecorder();
    r.proposed('f1', 'option-cells', 'no-match');
    // Six option cells drawn one gesture at a time — one finding.
    for (let i = 0; i < 6; i += 1) r.manualDraw('f1', 'option');

    const draws = r.drain().filter((e) => e.kind === 'manual-draw');
    expect(draws).toEqual([{ kind: 'manual-draw', fieldId: 'f1', fieldTypeClass: 'option' }]);
  });

  it('counts a hand draw after a rejection', () => {
    const r = createPlacementRecorder();
    r.proposed('f1', 'table', 'needs-review');
    r.rejected('f1');
    r.manualDraw('f1', 'table');
    const events = r.drain();
    expect(events.filter((e) => e.kind === 'manual-draw')).toHaveLength(1);
  });

  it('ignores a hand draw on a field whose proposal was accepted, not refused', () => {
    const r = createPlacementRecorder();
    r.proposed('f1', 'option-cells', 'needs-review');
    r.accepted('f1', 'confirm');
    r.manualDraw('f1', 'option');
    expect(r.drain().filter((e) => e.kind === 'manual-draw')).toEqual([]);
  });
});

describe('placement recorder — retargets', () => {
  it('buckets the page delta and records one event per field', () => {
    const r = createPlacementRecorder();
    r.retargeted(['f1', 'f2'], 3);
    const events = r.drain();
    expect(events).toEqual([
      { kind: 'retargeted', fieldId: 'f1', pageDeltaBucket: '+2..4' },
      { kind: 'retargeted', fieldId: 'f2', pageDeltaBucket: '+2..4' },
    ]);
  });

  it('ignores a zero-delta move — the boxes are already on that page', () => {
    const r = createPlacementRecorder();
    r.retargeted(['f1'], 0);
    expect(r.drain()).toEqual([]);
  });
});

describe('placement recorder — drain', () => {
  it('empties on drain: the second drain returns nothing (R4 send-once)', () => {
    const r = createPlacementRecorder();
    r.proposed('f1', 'option-cells', 'auto-confirm');
    r.accepted('f1', 'auto');
    expect(r.drain()).toHaveLength(2);
    expect(r.drain()).toEqual([]);
  });

  it('keeps the method memory across drains, so a post-save confirm still carries it', () => {
    const r = createPlacementRecorder();
    r.proposed('f1', 'table', 'needs-review');
    r.drain(); // first save — the parked proposal's derivation already sent

    r.accepted('f1', 'confirm'); // confirmed after the save
    expect(r.drain()).toEqual([{ kind: 'accepted', fieldId: 'f1', method: 'table', via: 'confirm' }]);
  });

  it('round-trips a session through tallyPlacementOutcomes to the expected counters', () => {
    const r = createPlacementRecorder();
    r.proposed('a1', 'option-cells', 'auto-confirm');
    r.accepted('a1', 'auto');
    r.proposed('r1', 'table', 'needs-review');
    r.previewAdjusted('r1', 'column-band', 6);
    r.accepted('r1', 'confirm');
    r.proposed('r2', 'option-cells', 'needs-review');
    r.rejected('r2');
    r.manualDraw('r2', 'option');
    r.proposed('n1', 'match-anchor', 'no-match');
    r.retargeted(['a1'], 2);

    expect(tallyPlacementOutcomes(r.drain())).toEqual({
      proposalsAttempted: 4,
      autoConfirmed: 1,
      acceptedAsIs: 1,
      adjusted: 1,
      rejected: 1,
      noMatch: 1,
      manualDraws: 1,
      retargets: 1,
    });
  });
});
