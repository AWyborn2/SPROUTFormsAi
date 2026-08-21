import type { PlacementOutcomes } from '@formai/shared';
import { apiClient } from './api-client.js';

/**
 * Send one placement session-slice after a successful Save placement,
 * FIRE-AND-FORGET — the placement analogue of `sendImportCorrections`.
 *
 * Called from the save button's success handler, and ONLY from there: Save is
 * this surface's commit gate, so an abandoned session sends nothing. The POST
 * is never awaited by the caller and a rejection is swallowed — saving must
 * not wait on, or fail for, the training signal. An empty slice sends nothing:
 * unlike the corrections diff (where zero corrections is itself signal), a
 * placement save with no recorded outcomes says nothing about the engine.
 */
export function sendPlacementOutcomes(payload: PlacementOutcomes): void {
  if (payload.events.length === 0) return;
  void apiClient.post('/pdf/placements', payload).catch((err: unknown) => {
    // Telemetry, not operational state — never surfaced to the reviewer.
    console.warn('failed to record placement outcomes', err);
  });
}
