// @vitest-environment jsdom
/**
 * The live problem list is computed against the PUBLISH-TIME fields.
 *
 * The trap pinned here: draft answer keys live beside the fields until
 * `resolvePublishFields` merges them on at publish, and KEYING a question is
 * what proposes it as mandatory. Validating the bare field list therefore
 * reported every keyed mandatory question as "no answer key" — thirty-one
 * problems that appeared because the author had just done the right thing,
 * and stayed on screen after they returned to earlier steps.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedField } from '@formai/shared';

const post = vi.fn();
vi.mock('../../../lib/data/api-client.js', () => ({
  apiClient: { post: (...args: unknown[]) => post(...args) },
  ApiError: class extends Error {},
}));

const { useBuilderDraftState } = await import('./use-builder-draft.js');

function ex(over: Partial<ExtractedField> & { id: string }): ExtractedField {
  return { label: over.id, type: 'text', confidence: 0.9, ...over };
}

/** One PART with one keyable question and the ✓/✗ box printed beside it. */
const PAPER = [
  ex({ id: 'h1', type: 'section_header', label: 'PART 1 — THEORY' }),
  ex({ id: 'q1', type: 'radio', label: 'Q1', options: ['a', 'b'] }),
  ex({ id: 'q1-out', type: 'check_cross', label: 'Outcome' }),
];

async function draft() {
  post.mockReset();
  post.mockResolvedValueOnce({ assetId: 'a' }).mockResolvedValueOnce({
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'assessment.pdf',
    pageCount: 2,
    fields: PAPER,
    designNotes: [],
  });
  const { result } = renderHook(() => useBuilderDraftState());
  await act(async () => {
    await result.current.ingest(new File(['x'], 'assessment.pdf', { type: 'application/pdf' }));
  });
  return result;
}

beforeEach(() => {
  post.mockReset();
});

describe('manifestProblems sees the draft answer keys', () => {
  it('keying a mandatory question does not report that same question as unkeyed', async () => {
    const result = await draft();

    act(() => result.current.keyOps.setKey('q1', ['a']));

    // Keying q1 is what makes it mandatory — and the key must be visible to
    // the validator through the same merge publish performs.
    expect(result.current.parts[0]?.mandatoryFieldIds).toContain('q1');
    expect(result.current.manifestProblems.filter((p) => p.includes('answer key'))).toEqual([]);
  });

  it('still reports a mandatory question the author has NOT keyed', async () => {
    const result = await draft();
    act(() => result.current.keyOps.setKey('q1', ['a']));

    // Force a second mandatory id with no key via a part override — the
    // honest problem must survive the merge.
    act(() =>
      result.current.partOps.update(result.current.parts[0]!.key, {
        mandatoryFieldIds: ['q1', 'q1-out'],
      }),
    );

    expect(
      result.current.manifestProblems.some((p) => p.includes('q1-out') && p.includes('answer key')),
    ).toBe(true);
  });
});
