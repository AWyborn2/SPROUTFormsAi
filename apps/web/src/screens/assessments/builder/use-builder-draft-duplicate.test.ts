// @vitest-environment jsdom
/**
 * Duplicate-section THROUGH THE HOOK — the wiring, not the pure operation.
 *
 * `duplicateSection` itself is covered in builder-fields.test.ts and was
 * correct from the start. What shipped broken was the plumbing: the
 * `structureOps` memo called `applyFieldEdit` without listing it as a
 * dependency, so `duplicate` ran against the draft AS IT STOOD AT MOUNT —
 * the second duplicate minted the same added-N ids and section key as the
 * first and silently reverted every edit made in between. On a hydrated
 * draft the captured state could even be the empty pre-hydration one.
 *
 * These tests pin the property the pure tests cannot see: each duplicate
 * reads the CURRENT draft.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssessmentToolManifest, ExtractedField, FormField } from '@formai/shared';

const post = vi.fn();
vi.mock('../../../lib/data/api-client.js', () => ({
  apiClient: { post: (...args: unknown[]) => post(...args) },
  ApiError: class extends Error {},
}));

const { useBuilderDraftState } = await import('./use-builder-draft.js');
const { seedRevisionSnapshot } = await import('./revision-seed.js');

function ex(over: Partial<ExtractedField> & { id: string }): ExtractedField {
  return { label: over.id, type: 'text', confidence: 0.9, ...over };
}

const PAPER = [
  ex({ id: 'h1', type: 'section_header', label: 'PART 2 — PRACTICAL' }),
  ex({ id: 'q1', label: 'Walkaround inspection' }),
  ex({ id: 'q2', label: 'Operate on slope' }),
];

async function ingestedDraft() {
  post.mockReset();
  post.mockResolvedValueOnce({ assetId: 'a' }).mockResolvedValueOnce({
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'scraper.pdf',
    pageCount: 3,
    fields: PAPER,
    designNotes: [],
  });
  const { result } = renderHook(() => useBuilderDraftState());
  await act(async () => {
    await result.current.ingest(new File(['x'], 'scraper.pdf', { type: 'application/pdf' }));
  });
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('duplicate through the hook', () => {
  it('a second duplicate reads the CURRENT draft — fresh ids, fresh key, edits kept', async () => {
    /*
      The Scraper flow that surfaced the bug: duplicate for Part 4, amend the
      copy, duplicate again for Part 6. With the stale closure the second
      duplicate recreated the FIRST copy — same section key, same field ids —
      and threw the amendments away.
    */
    const result = await ingestedDraft();
    const sectionKey = result.current.structure[0]!.key;

    act(() => result.current.structureOps.duplicate(sectionKey));
    act(() => result.current.fieldOps.rename('q1', 'Edited between duplicates'));
    act(() => result.current.structureOps.duplicate(sectionKey));

    // Three distinct sections: the original and two copies with their own keys.
    expect(result.current.structure).toHaveLength(3);
    expect(new Set(result.current.structure.map((s) => s.key)).size).toBe(3);

    // Every field id unique — an id shared between the copies would make any
    // by-id edit land on both sections at once.
    const ids = result.current.fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The edit made between the two duplicates survived the second one.
    expect(result.current.fields.find((f) => f.id === 'q1')!.label).toBe(
      'Edited between duplicates',
    );
  });

  it('each copy is its OWN fields — editing one never edits its twin', async () => {
    const result = await ingestedDraft();
    const sectionKey = result.current.structure[0]!.key;

    act(() => result.current.structureOps.duplicate(sectionKey));
    const copy = result.current.structure[1]!;
    const cloneId = copy.fields[0]!.id;
    expect(cloneId).not.toBe('q1');

    act(() => result.current.fieldOps.patch(cloneId, { label: 'Part 4 column' }));

    expect(result.current.fields.find((f) => f.id === cloneId)!.label).toBe('Part 4 column');
    expect(result.current.fields.find((f) => f.id === 'q1')!.label).toBe('Walkaround inspection');
  });

  it('duplicates a HYDRATED revision draft, not the empty state before it', () => {
    /*
      A revision draft hydrates in an effect after mount. A memo that captured
      the mount-time state saw NO fields and NO structure — duplicate then
      "applied" the empty draft, wiping everything on screen.
    */
    const question = (id: string): FormField => ({
      id,
      type: 'checkbox_group',
      label: id,
      required: true,
      source: 'imported',
      options: ['a', 'b'],
    });
    const manifest: AssessmentToolManifest = {
      parts: [
        { key: 'sec_p1', ordinal: 1, label: 'Part 2', kind: 'practical', pathways: ['new'], startFieldId: 'p1' },
      ],
    };
    const hydrateFrom = seedRevisionSnapshot({
      tool: { id: 'tool-1', templateId: 'form-1', name: 'Scraper', manifest },
      version: {
        id: 'v1',
        label: 'v1',
        fields: [
          { id: 'p1', type: 'section_header', label: 'Part 2', required: false, source: 'imported' },
          question('q1'),
          question('q2'),
        ],
        sourcePdfAssetId: 'asset-1',
      },
    });
    const { result } = renderHook(() => useBuilderDraftState({ hydrateFrom }));
    const before = result.current.fields.length;
    expect(before).toBeGreaterThan(0);

    act(() => result.current.structureOps.duplicate(result.current.structure[0]!.key));

    expect(result.current.structure).toHaveLength(2);
    expect(result.current.fields.length).toBeGreaterThan(before);
  });
});
