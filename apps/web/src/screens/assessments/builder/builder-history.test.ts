// @vitest-environment jsdom
/**
 * Undo/redo across the builder's editable state.
 *
 * The properties pinned here are the ones that make history trustworthy:
 * ingest is a BASELINE (undo never carries an author back to the empty builder
 * before their document), rapid edits coalesce into one step, spaced edits are
 * separate steps, and a fresh edit invalidates redo — the branch the author
 * abandoned must not be reachable after they typed over it.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const PAPER = [
  ex({ id: 'h1', type: 'section_header', label: 'PART 1' }),
  ex({ id: 'q1', label: 'Question one' }),
  ex({ id: 'q2', label: 'Question two' }),
];

let now = 1_000_000;

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

/** A later, separate step — outside the coalescing window. */
function tick() {
  now += 5_000;
}

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('builder undo/redo', () => {
  it('starts with nothing to undo — ingest is the floor, not a step', async () => {
    const result = await draft();

    expect(result.current.history.canUndo).toBe(false);
    expect(result.current.history.canRedo).toBe(false);
  });

  it('undoes an edit and redoes it', async () => {
    const result = await draft();
    tick();

    act(() => result.current.fieldOps.rename('q1', 'Renamed'));
    expect(result.current.fields.find((f) => f.id === 'q1')?.label).toBe('Renamed');
    expect(result.current.history.canUndo).toBe(true);

    act(() => result.current.history.undo());
    expect(result.current.fields.find((f) => f.id === 'q1')?.label).toBe('Question one');
    expect(result.current.history.canRedo).toBe(true);

    act(() => result.current.history.redo());
    expect(result.current.fields.find((f) => f.id === 'q1')?.label).toBe('Renamed');
  });

  it('coalesces rapid edits into one step', async () => {
    const result = await draft();
    tick();

    // Typed letter by letter — same burst, one step.
    act(() => result.current.fieldOps.rename('q1', 'R'));
    act(() => result.current.fieldOps.rename('q1', 'Re'));
    act(() => result.current.fieldOps.rename('q1', 'Renamed'));

    act(() => result.current.history.undo());
    expect(result.current.fields.find((f) => f.id === 'q1')?.label).toBe('Question one');
    expect(result.current.history.canUndo).toBe(false);
  });

  it('keeps spaced edits as separate steps', async () => {
    const result = await draft();
    tick();

    act(() => result.current.fieldOps.rename('q1', 'First'));
    tick();
    act(() => result.current.fieldOps.rename('q2', 'Second'));

    act(() => result.current.history.undo());
    expect(result.current.fields.find((f) => f.id === 'q2')?.label).toBe('Question two');
    expect(result.current.fields.find((f) => f.id === 'q1')?.label).toBe('First');

    act(() => result.current.history.undo());
    expect(result.current.fields.find((f) => f.id === 'q1')?.label).toBe('Question one');
  });

  it('a fresh edit after undo clears the redo branch', async () => {
    const result = await draft();
    tick();

    act(() => result.current.fieldOps.rename('q1', 'Abandoned'));
    act(() => result.current.history.undo());
    tick();
    act(() => result.current.fieldOps.rename('q1', 'Kept'));

    expect(result.current.history.canRedo).toBe(false);
    expect(result.current.fields.find((f) => f.id === 'q1')?.label).toBe('Kept');
  });

  it('travels over structure, keys and exclusions together', async () => {
    const result = await draft();
    tick();

    // One op that writes fields AND keys AND structure — deleting a field —
    // must undo as one step, restoring every slice it touched.
    act(() => result.current.keyOps.setKey('q1', ['a']));
    tick();
    act(() => result.current.fieldOps.remove('q1'));
    expect(result.current.fields.some((f) => f.id === 'q1')).toBe(false);
    expect(result.current.keys.some((k) => k.fieldId === 'q1')).toBe(false);

    act(() => result.current.history.undo());
    expect(result.current.fields.some((f) => f.id === 'q1')).toBe(true);
    expect(result.current.keys.find((k) => k.fieldId === 'q1')?.answerKey).toEqual(['a']);
  });

  it('setup answers are undoable too — every step of the wizard, not just fields', async () => {
    const result = await draft();
    tick();

    const before = result.current.setup.theoryRendering;
    act(() => result.current.setSetup({ theoryRendering: 'one_per_screen' }));
    expect(result.current.setup.theoryRendering).toBe('one_per_screen');

    act(() => result.current.history.undo());
    expect(result.current.setup.theoryRendering).toBe(before);
  });
});
