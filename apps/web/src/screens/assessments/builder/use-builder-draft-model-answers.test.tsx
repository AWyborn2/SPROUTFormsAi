// @vitest-environment jsdom
/**
 * `keyOps.setModelAnswer` — the written question's key row, THROUGH THE HOOK.
 *
 * A written (`text`/`textarea`) question has no options, so its draft key is a
 * row of a different shape: `answerKey: []` plus `modelAnswer` prose. The rules
 * it must obey are the SAME rules `setKey` already enforces for choice keys,
 * because they protect the same claims:
 *
 *   · empty means ABSENT — an empty guide row would report a question as
 *     guided that guides nobody, the empty-key failure over again;
 *   · a changed answer loses its attestation — "the training authority
 *     confirmed THIS answer" does not survive the answer changing;
 *   · a verdict field holds no key of either kind — `setAssessorVerdict`'s
 *     clearing sweep covers model rows exactly as it covers keys.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedField } from '@formai/shared';
import { useBuilderDraftState } from './use-builder-draft.js';

const post = vi.fn();
vi.mock('../../../lib/data/api-client.js', () => ({
  apiClient: { post: (...args: unknown[]) => post(...args) },
  ApiError: class extends Error {},
}));

function ex(over: Partial<ExtractedField> & { id: string }): ExtractedField {
  return { label: over.id, type: 'textarea', confidence: 0.9, ...over };
}

async function draftOf(fields: ExtractedField[]) {
  post.mockReset();
  post.mockResolvedValueOnce({ assetId: 'asset-1' }).mockResolvedValueOnce({
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'tip-head.pdf',
    pageCount: 2,
    fields,
    designNotes: [],
  });
  const { result } = renderHook(() => useBuilderDraftState());
  await act(async () => {
    await result.current.ingest(new File(['x'], 'tip-head.pdf', { type: 'application/pdf' }));
  });
  return result;
}

beforeEach(() => post.mockReset());

describe('keyOps.setModelAnswer', () => {
  it('round-trips: writes a row with an EMPTY answerKey and the prose', async () => {
    const result = await draftOf([ex({ id: 'w1' })]);

    act(() => result.current.keyOps.setModelAnswer('w1', 'Nobody inside the exclusion zone.'));

    expect(result.current.keys).toEqual([
      {
        fieldId: 'w1',
        answerKey: [],
        modelAnswer: 'Nobody inside the exclusion zone.',
        source: 'manual',
      },
    ]);
  });

  it('REMOVES THE ROW on empty text, and on whitespace', async () => {
    // An all-space guide would count as "guided" everywhere the row's
    // presence is read, while guiding nobody.
    const result = await draftOf([ex({ id: 'w1' })]);

    act(() => result.current.keyOps.setModelAnswer('w1', 'Something'));
    expect(result.current.keys).toHaveLength(1);

    act(() => result.current.keyOps.setModelAnswer('w1', ''));
    expect(result.current.keys).toHaveLength(0);

    act(() => result.current.keyOps.setModelAnswer('w1', 'Something'));
    act(() => result.current.keyOps.setModelAnswer('w1', '   '));
    expect(result.current.keys).toHaveLength(0);
  });

  it('EDITING THE TEXT DROPS THE ATTESTATION, exactly as setKey does', async () => {
    const result = await draftOf([ex({ id: 'w1' })]);

    act(() => result.current.keyOps.setModelAnswer('w1', 'First wording'));
    act(() => result.current.keyOps.setVerified('w1', true, 'Training authority'));
    expect(result.current.keys[0]?.verifiedBy).toBe('Training authority');

    act(() => result.current.keyOps.setModelAnswer('w1', 'Second wording'));
    expect(result.current.keys[0]?.modelAnswer).toBe('Second wording');
    expect(result.current.keys[0]?.verifiedBy).toBeUndefined();
    expect(result.current.keys[0]?.verifiedAt).toBeUndefined();
  });

  it('keeps the attestation when the identical text is re-set', async () => {
    // Re-saving the same prose is not a change of answer, and dropping the
    // attestation for it would train an author to ignore the flag.
    const result = await draftOf([ex({ id: 'w1' })]);

    act(() => result.current.keyOps.setModelAnswer('w1', 'The wording'));
    act(() => result.current.keyOps.setVerified('w1', true, 'Training authority'));
    act(() => result.current.keyOps.setModelAnswer('w1', 'The wording'));

    expect(result.current.keys[0]?.verifiedBy).toBe('Training authority');
  });

  it('setAssessorVerdict CLEARS a written question’s model key', async () => {
    // The same sweep that clears a choice key: a verdict field holds no
    // marking configuration of either kind.
    const result = await draftOf([ex({ id: 'w1' })]);

    act(() => result.current.keyOps.setModelAnswer('w1', 'A model answer'));
    expect(result.current.keys).toHaveLength(1);

    act(() => result.current.keyOps.setAssessorVerdict('w1', true));
    expect(result.current.keys).toHaveLength(0);
    // The field-level copy goes too — a revision-seeded field carries the
    // published modelAnswer verbatim, and a verdict must not republish it.
    expect(result.current.fields.find((f) => f.id === 'w1')?.modelAnswer).toBeUndefined();
  });
});
