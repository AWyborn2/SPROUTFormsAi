// @vitest-environment jsdom
/**
 * Taking the placement step's geometry back into the builder draft.
 *
 * THIS IS WHAT MAKES A PLACEMENT SURVIVE THE REST OF THE WIZARD. The publish
 * step validates `checkPublish(draft.fields, …)` and writes THAT to the version,
 * so geometry the placement editor saved onto the version but never handed back
 * is overwritten at publish — with the boxes visible on screen the whole time,
 * which is exactly what made the loss invisible.
 *
 * The merge is BY ID rather than a replacement, because the editor is handed
 * the fields minus the ones the author excluded. Its list is a subset, and
 * assigning it wholesale would delete every excluded question from the draft —
 * ids the manifest and the answer keys still reference.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedField, FormField } from '@formai/shared';

const post = vi.fn();
vi.mock('../../../lib/data/api-client.js', () => ({
  apiClient: { post: (...args: unknown[]) => post(...args) },
  ApiError: class extends Error {},
}));

const { useBuilderDraftState } = await import('./use-builder-draft.js');

function ex(over: Partial<ExtractedField> & { id: string }): ExtractedField {
  return { label: over.id, type: 'text', confidence: 0.9, ...over };
}

const PAPER = [
  ex({ id: 'q1', label: 'Question one' }),
  ex({ id: 'q2', label: 'Question two' }),
  ex({ id: 'q3', label: 'Question three' }),
];

async function draft() {
  post.mockReset();
  post.mockResolvedValueOnce({ assetId: 'a' }).mockResolvedValueOnce({
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'assessment.pdf',
    pageCount: 3,
    fields: PAPER,
    designNotes: [],
  });
  const { result } = renderHook(() => useBuilderDraftState());
  await act(async () => {
    await result.current.ingest(new File(['x'], 'assessment.pdf', { type: 'application/pdf' }));
  });
  return result;
}

/** The same field, carrying one placed box. */
function placed(f: FormField): FormField {
  return {
    ...f,
    geometry: {
      segments: [{ page: 0, x: 10, y: 10, width: 20, height: 8, pageWidth: 595, pageHeight: 842 }],
    },
  };
}

beforeEach(() => {
  post.mockReset();
});

describe('setPlacedFields', () => {
  it('brings the geometry into the draft’s own field list', async () => {
    const result = await draft();
    const q1 = result.current.fields.find((f) => f.id === 'q1')!;
    expect(q1.geometry).toBeUndefined();

    act(() => result.current.setPlacedFields([placed(q1)]));

    expect(
      result.current.fields.find((f) => f.id === 'q1')!.geometry?.segments,
    ).toHaveLength(1);
  });

  it('KEEPS FIELDS THE EDITOR WAS NEVER GIVEN', async () => {
    /*
      The placement editor receives the fields minus the excluded ones, so what
      comes back is a subset. Replacing the list with it would delete the
      author's excluded questions — whose ids the manifest and the answer keys
      still name, so the loss would surface as a publish-time validation failure
      about a field nobody could see.
    */
    const result = await draft();
    const q1 = result.current.fields.find((f) => f.id === 'q1')!;

    act(() => result.current.setPlacedFields([placed(q1)]));

    expect(result.current.fields.map((f) => f.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('leaves the fields it does not mention exactly as they were', async () => {
    const result = await draft();
    const before = result.current.fields.find((f) => f.id === 'q2')!;

    act(() =>
      result.current.setPlacedFields([placed(result.current.fields.find((f) => f.id === 'q1')!)]),
    );

    expect(result.current.fields.find((f) => f.id === 'q2')).toEqual(before);
  });

  it('keeps the draft’s order rather than the editor’s', async () => {
    // The editor groups its list by printed heading; the draft's order is what
    // the structure and the manifest are built against.
    const result = await draft();
    const all = result.current.fields;

    act(() => result.current.setPlacedFields([...all].reverse().map(placed)));

    expect(result.current.fields.map((f) => f.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('ignores a field id the draft has never heard of', async () => {
    // Defensive: a stale editor payload must not be able to append a field the
    // structure cannot place and the manifest does not reference.
    const result = await draft();

    act(() =>
      result.current.setPlacedFields([
        placed({ id: 'ghost', label: 'Ghost', type: 'text', required: false, source: 'imported' }),
      ]),
    );

    expect(result.current.fields.map((f) => f.id)).toEqual(['q1', 'q2', 'q3']);
  });
});
