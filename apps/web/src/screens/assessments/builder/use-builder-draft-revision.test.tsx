// @vitest-environment jsdom
/**
 * Revision-mode state transitions (KTD2/KTD7) - jsdom, because renderHook
 * mounts a component.
 */
import { describe, expect, it } from 'vitest';
// â”€â”€ revision mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import { act, renderHook } from '@testing-library/react';
import type { AssessmentToolManifest, FormField } from '@formai/shared';
import { useBuilderDraftState } from './use-builder-draft.js';
import { seedRevisionSnapshot } from './revision-seed.js';

const revHeader = (id: string, label: string): FormField => ({
  id,
  type: 'section_header',
  label,
  required: false,
  source: 'imported',
});

const placedQuestion = (id: string): FormField => ({
  id,
  type: 'checkbox_group',
  label: id,
  required: true,
  source: 'imported',
  options: ['a', 'b'],
  answerKey: ['a'],
  geometry: {
    segments: [{ page: 1, x: 5, y: 5, width: 30, height: 10, pageWidth: 595, pageHeight: 842 }],
  },
});

const REV_MANIFEST: AssessmentToolManifest = {
  parts: [
    {
      key: 'sec_p1',
      ordinal: 1,
      label: 'Part 1',
      kind: 'theory',
      pathways: ['new'],
      startFieldId: 'p1',
    },
  ],
};

function revisionHydrate() {
  return seedRevisionSnapshot({
    tool: { id: 'tool-1', templateId: 'form-1', name: 'Dozer', manifest: REV_MANIFEST },
    version: {
      id: 'v1',
      label: 'v1',
      fields: [revHeader('p1', 'Part 1'), placedQuestion('q1'), placedQuestion('q2')],
      sourcePdfAssetId: 'asset-original',
    },
  });
}

describe('revision mode', () => {
  it('KTD7: hydrates a seeded revision to ready with no extraction', () => {
    const { result } = renderHook(() => useBuilderDraftState({ hydrateFrom: revisionHydrate() }));

    expect(result.current.phase).toBe('ready');
    expect(result.current.hasDocument).toBe(true);
    expect(result.current.extraction).toBeNull();
    expect(result.current.revisionOfToolId).toBe('tool-1');
    expect(result.current.fields.map((f) => f.id)).toEqual(['p1', 'q1', 'q2']);
  });

  it('KTD2: replacing the PDF stashes every box and bares the fields', () => {
    const { result } = renderHook(() => useBuilderDraftState({ hydrateFrom: revisionHydrate() }));

    act(() => result.current.replacePdf('asset-new', 'Rev3.pdf'));

    expect(result.current.pdfReplaced).toBe(true);
    expect(result.current.assetId).toBe('asset-new');
    expect(Object.keys(result.current.carriedGeometry).sort()).toEqual(['q1', 'q2']);
    for (const f of result.current.fields) expect(f.geometry).toBeUndefined();
  });

  it('a double replacement keeps the ORIGINAL carried set', () => {
    const { result } = renderHook(() => useBuilderDraftState({ hydrateFrom: revisionHydrate() }));

    act(() => result.current.replacePdf('asset-new', 'Rev3.pdf'));
    const stashed = result.current.carriedGeometry['q1'];
    act(() => result.current.replacePdf('asset-newer', 'Rev3b.pdf'));

    expect(result.current.assetId).toBe('asset-newer');
    expect(result.current.carriedGeometry['q1']).toEqual(stashed);
    expect(Object.keys(result.current.carriedGeometry).sort()).toEqual(['q1', 'q2']);
  });

  it('revert restores the original PDF and the geometry as confirmed', () => {
    const { result } = renderHook(() => useBuilderDraftState({ hydrateFrom: revisionHydrate() }));
    const before = revisionHydrate().fields.find((f) => f.id === 'q1')!.geometry;

    act(() => result.current.replacePdf('asset-new', 'Rev3.pdf'));
    act(() => result.current.revertPdf());

    expect(result.current.pdfReplaced).toBe(false);
    expect(result.current.assetId).toBe('asset-original');
    expect(result.current.carriedGeometry).toEqual({});
    expect(result.current.fields.find((f) => f.id === 'q1')?.geometry).toEqual(before);
  });

  it('confirmCarried moves exactly the named boxes onto the fields', () => {
    const { result } = renderHook(() => useBuilderDraftState({ hydrateFrom: revisionHydrate() }));

    act(() => result.current.replacePdf('asset-new', 'Rev3.pdf'));
    act(() => result.current.confirmCarried(['q1']));

    expect(result.current.fields.find((f) => f.id === 'q1')?.geometry).toBeDefined();
    expect(result.current.fields.find((f) => f.id === 'q2')?.geometry).toBeUndefined();
    expect(Object.keys(result.current.carriedGeometry)).toEqual(['q2']);
  });
});
