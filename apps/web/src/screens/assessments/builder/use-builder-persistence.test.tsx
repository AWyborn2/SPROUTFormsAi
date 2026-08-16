// @vitest-environment jsdom
/**
 * Autosave and the save signal (`useBuilderAutosave`).
 *
 * The behaviours here are the ones an anxious author's "did it save?" turns on:
 * a debounced write with the right payload, a status that walks
 * unsaved → saved, no redundant write when nothing changed, and — the one that
 * looks exactly like a lost afternoon — a pending edit FLUSHED when the builder
 * unmounts rather than cancelled with the debounce timer.
 *
 * `useSaveBuilderDraft` is mocked flat so the test drives the mutation directly;
 * the wire itself is store.test.ts's subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AUTOSAVE_DELAY_MS, useBuilderAutosave } from './use-builder-persistence.js';
import { emptySnapshot, type BuilderSnapshot } from './builder-draft-state.js';

const mutateAsync = vi.fn();
const mutation = { isPending: false, data: undefined as { id: string; updatedAt: string } | undefined };

vi.mock('../../../lib/data/hooks.js', () => ({
  useSaveBuilderDraft: () => ({ mutateAsync, isPending: mutation.isPending, data: mutation.data }),
  // Only useBuilderResume reads this; autosave never does. Kept so the module
  // resolves under the mock.
  useBuilderDraft: () => ({ data: undefined, isPending: false, isSuccess: false, isError: false }),
}));

/** A saveable snapshot — `assetId` is what `isSaveable` gates on. A fresh call
 *  is a fresh reference, which is exactly what "an edit landed" looks like. */
function snap(over: Partial<BuilderSnapshot> = {}): BuilderSnapshot {
  return { ...emptySnapshot(), assetId: 'asset-1', fileName: 'Scraper', ...over };
}

beforeEach(() => {
  vi.useFakeTimers();
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ id: 'draft-1', updatedAt: '2026-08-14T02:03:04.000Z' });
  mutation.isPending = false;
  mutation.data = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useBuilderAutosave', () => {
  it('debounces one write and carries the snapshot payload', async () => {
    const s = snap({ fileName: 'Scraper' });
    renderHook(() => useBuilderAutosave(s, 'generate', true));

    // Nothing before the delay elapses.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    });
    expect(mutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Scraper', assetId: 'asset-1', step: 'generate' }),
    );
  });

  it('does not write before resuming has settled', async () => {
    renderHook(() => useBuilderAutosave(snap(), 'units', false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('does not write a snapshot with nothing to save', async () => {
    const bare = { ...emptySnapshot() }; // no assetId
    renderHook(() => useBuilderAutosave(bare, 'upload', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('walks unsaved → saving → saved', async () => {
    const s = snap();
    const { result, rerender } = renderHook(() => useBuilderAutosave(s, 'generate', true));

    // An edit is pending the debounce.
    expect(result.current.status).toBe('unsaved');

    // While the mutation is in flight the mock reports it pending.
    mutation.isPending = true;
    rerender();
    expect(result.current.status).toBe('saving');

    // It lands: pending clears, the write resolves, the baseline advances.
    mutation.isPending = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(result.current.status).toBe('saved');
    expect(result.current.savedDraftId).toBe('draft-1');
  });

  it('re-arms to unsaved when a fresh edit follows a save', async () => {
    let s = snap();
    const { result, rerender } = renderHook(() => useBuilderAutosave(s, 'generate', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(result.current.status).toBe('saved');

    // A new snapshot reference is a new edit.
    s = snap({ fileName: 'Scraper edited' });
    rerender();
    expect(result.current.status).toBe('unsaved');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('saved');
  });

  it('does not re-post an unchanged snapshot after it has saved', async () => {
    const s = snap();
    const { rerender } = renderHook(() => useBuilderAutosave(s, 'generate', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    // Same reference, a plain re-render (e.g. navigating a step) writes nothing.
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending edit on unmount instead of dropping it', async () => {
    const s = snap();
    const { unmount } = renderHook(() => useBuilderAutosave(s, 'generate', true));

    // Leave before the debounce fires — the timer alone would cancel the write.
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'asset-1' }));
  });

  it('opens a resumed draft already saved, with no write on mount', async () => {
    const s = snap();
    const { result } = renderHook(() => useBuilderAutosave(s, 'units', true, 'draft-1'));

    // A resume's first saveable snapshot IS the server's — it is the baseline.
    expect(result.current.status).toBe('saved');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    });
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
