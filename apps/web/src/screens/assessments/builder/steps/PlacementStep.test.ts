/**
 * Reconciling the placement version with what the author has since included.
 *
 * THE DEAD END THIS UNDOES. The draft version is created once, from the fields
 * minus the excluded ones. Go back to the upload step afterwards, re-tick a
 * question, and nothing reaches the version — the field never appears in the
 * placement list and can never be given a box. No error, no route back short of
 * rebuilding the whole tool.
 *
 * On the Mine Site SME paper that is how an author loses the two boxes the
 * entire workflow turns on: "More coaching and/or training required?" and
 * "Candidate Competent / not yet Competent" read as marking furniture at the
 * upload step, get unticked, and only become unreachable four steps later —
 * with the answer keys, the matching pairs and every placed box as the price of
 * going back.
 */
import { describe, expect, it } from 'vitest';
import type { FormField, PageBox } from '@formai/shared';
import { reconciledVersionFields } from './PlacementStep.js';

const field = (id: string, extra: Partial<FormField> = {}): FormField => ({
  id,
  type: 'text',
  label: id,
  required: false,
  source: 'imported',
  ...extra,
});

const box = (x: number): PageBox => ({
  page: 0,
  x,
  y: 700,
  width: 9,
  height: 9,
  pageWidth: 595,
  pageHeight: 842,
});

describe('reconciledVersionFields', () => {
  it('writes nothing when the version already carries every included field', () => {
    // The overwhelmingly common case, and it must be null rather than an equal
    // list — the effect saves whenever this returns something, so an unchanged
    // list would write on every render.
    const onVersion = [field('a'), field('b')];

    expect(reconciledVersionFields(onVersion, [field('a'), field('b')])).toBeNull();
  });

  it('appends a field the author re-included after the version was made', () => {
    const onVersion = [field('a')];

    const next = reconciledVersionFields(onVersion, [field('a'), field('coaching')]);

    expect(next?.map((f) => f.id)).toEqual(['a', 'coaching']);
  });

  it('keeps the version’s copy of a field, not the builder’s', () => {
    /*
      THE GEOMETRY IS ON THE VERSION. The placement editor writes boxes there,
      and the builder's own copy of the same field is the pre-placement one.
      Taking the builder's copy would blank every box already drawn — the exact
      damage this reconcile exists to avoid, delivered by the fix instead of the
      bug.
    */
    const placed = field('a', { geometry: { segments: [box(196)] } });

    const next = reconciledVersionFields([placed], [field('a'), field('result')]);

    expect(next?.[0]?.geometry?.segments).toHaveLength(1);
    expect(next?.[1]?.id).toBe('result');
  });

  it('never removes a field the author excluded after placing it', () => {
    /*
      Add only. Excluding a question after drawing its box must not destroy the
      box: publish decides what ships, and the author can re-include it. A
      deleted box is not recoverable; an unused one is.
    */
    const onVersion = [field('a', { geometry: { segments: [box(196)] } }), field('b')];

    expect(reconciledVersionFields(onVersion, [field('b')])).toBeNull();
  });

  it('appends several at once, in the author’s order', () => {
    const next = reconciledVersionFields(
      [field('a')],
      [field('a'), field('coaching'), field('result')],
    );

    expect(next?.map((f) => f.id)).toEqual(['a', 'coaching', 'result']);
  });

  it('converges — reconciling its own output asks for nothing further', () => {
    // The effect re-runs when the refetched version arrives. If that pass found
    // work again the screen would write forever.
    const included = [field('a'), field('coaching')];
    const first = reconciledVersionFields([field('a')], included);

    expect(first).not.toBeNull();
    expect(reconciledVersionFields(first!, included)).toBeNull();
  });

  it('handles an empty version', () => {
    expect(reconciledVersionFields([], [field('a')])?.map((f) => f.id)).toEqual(['a']);
  });
});
