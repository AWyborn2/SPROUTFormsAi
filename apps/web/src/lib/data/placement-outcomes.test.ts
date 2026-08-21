/**
 * AE5's contract, on the sender itself: the POST can fail however it likes and
 * nothing propagates — the save that triggered it has already succeeded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlacementOutcomes } from '@formai/shared';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock('./api-client.js', () => ({ apiClient: { post: postMock } }));

const { sendPlacementOutcomes } = await import('./placement-outcomes.js');

const PAYLOAD: PlacementOutcomes = {
  documentType: 'assessment',
  context: 'builder',
  fieldCount: 3,
  events: [{ kind: 'proposed', fieldId: 'f1', method: 'table', tier: 'auto-confirm' }],
};

afterEach(() => vi.clearAllMocks());

describe('sendPlacementOutcomes', () => {
  it('posts the payload to /pdf/placements', () => {
    postMock.mockResolvedValue({ id: 'po-1' });
    sendPlacementOutcomes(PAYLOAD);
    expect(postMock).toHaveBeenCalledWith('/pdf/placements', PAYLOAD);
  });

  it('sends nothing for an empty slice', () => {
    sendPlacementOutcomes({ ...PAYLOAD, events: [] });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('swallows a rejected POST — logged, never thrown (AE5)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    postMock.mockRejectedValue(new Error('503'));

    expect(() => sendPlacementOutcomes(PAYLOAD)).not.toThrow();
    // Let the rejection settle; an unhandled rejection here would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith('failed to record placement outcomes', expect.any(Error));
    warn.mockRestore();
  });
});
