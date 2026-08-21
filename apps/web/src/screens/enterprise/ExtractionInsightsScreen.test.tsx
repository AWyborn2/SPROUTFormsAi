// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CorrectionCandidates, PlacementInsights } from '../../lib/data/types.js';

let result: { data?: CorrectionCandidates; isLoading: boolean; isError: boolean };
let placementResult: { data?: PlacementInsights; isLoading: boolean; isError: boolean };

vi.mock('../../lib/data/hooks.js', () => ({
  useCorrectionCandidates: () => result,
  usePlacementInsights: () => placementResult,
}));

const { ExtractionInsightsScreen } = await import('./ExtractionInsightsScreen.js');

const EMPTY_PLACEMENT: PlacementInsights = { metrics: [], shapes: [], trend: [] };

beforeEach(() => {
  result = { isLoading: false, isError: false, data: { minCount: 3, candidates: [] } };
  placementResult = { isLoading: false, isError: false, data: EMPTY_PLACEMENT };
});

afterEach(() => vi.clearAllMocks());

describe('ExtractionInsightsScreen', () => {
  it('lists each candidate with its count, shape and suggestion', () => {
    result = {
      isLoading: false,
      isError: false,
      data: {
        minCount: 3,
        candidates: [
          {
            documentType: 'assessment',
            shape: 'retype:radio→textarea',
            count: 7,
            sampleCaptureIds: ['cap-1', 'cap-2'],
            suggestion: 'Open questions read as multiple-choice. Reinforce rule 18.',
          },
        ],
      },
    };
    render(<ExtractionInsightsScreen />);

    expect(screen.getByText('retype:radio→textarea')).toBeTruthy();
    expect(screen.getByText('×7')).toBeTruthy();
    expect(screen.getByText(/Reinforce rule 18/)).toBeTruthy();
    expect(screen.getByText(/2 examples/)).toBeTruthy();
  });

  it('shows an empty state when nothing recurs yet', () => {
    result = { isLoading: false, isError: false, data: { minCount: 3, candidates: [] } };
    render(<ExtractionInsightsScreen />);
    expect(screen.getByText(/No recurring correction patterns yet/)).toBeTruthy();
  });

  it('tells a non-admin the surface is admin-only when the read is forbidden', () => {
    result = { isLoading: false, isError: true };
    placementResult = { isLoading: false, isError: true };
    render(<ExtractionInsightsScreen />);
    expect(screen.getAllByText(/available to admins only/).length).toBeGreaterThan(0);
  });
});

describe('ExtractionInsightsScreen — the placement section (U8)', () => {
  it('renders the metric strip and the recurring shapes from the hook', () => {
    placementResult = {
      isLoading: false,
      isError: false,
      data: {
        metrics: [
          {
            documentType: 'assessment',
            sessions: 4,
            proposalsAttempted: 300,
            autoConfirmed: 180,
            acceptedAsIs: 55,
            adjusted: 15,
            rejected: 5,
            noMatch: 60,
            manualDraws: 5,
            retargets: 30,
            hitRate: 0.6,
            needsReviewRate: 0.2,
            noMatchRate: 0.2,
            adjustmentRate: 15 / 235,
            byMethod: [{ method: 'table', attempted: 100, autoConfirmed: 50, hitRate: 0.5 }],
          },
        ],
        shapes: [
          {
            documentType: 'assessment',
            shape: 'adjusted:column-band:>4pt',
            count: 12,
            suggestion: 'Look at the column derivation in proposeTableSegments.',
          },
        ],
        trend: [],
      },
    };
    render(<ExtractionInsightsScreen />);

    // The metric strip: hit rate 60%, no-match 20%, with the session count.
    expect(screen.getByText('60%')).toBeTruthy();
    expect(screen.getByText(/4 sessions · 300 proposals/)).toBeTruthy();
    // The shapes table, in the extraction card's grammar.
    expect(screen.getByText('adjusted:column-band:>4pt')).toBeTruthy();
    expect(screen.getByText('×12')).toBeTruthy();
    expect(screen.getByText(/proposeTableSegments/)).toBeTruthy();
    // The human-gated contract is stated on the card itself.
    expect(screen.getByText(/Nothing here changes the engine/)).toBeTruthy();
  });

  it('shows the placement empty state when nothing is recorded yet', () => {
    placementResult = { isLoading: false, isError: false, data: EMPTY_PLACEMENT };
    render(<ExtractionInsightsScreen />);
    expect(screen.getByText(/No placement sessions recorded yet/)).toBeTruthy();
  });

  it('shows the admin-only message when the placement read is forbidden', () => {
    placementResult = { isLoading: false, isError: true };
    render(<ExtractionInsightsScreen />);
    expect(screen.getAllByText(/available to admins only/).length).toBeGreaterThan(0);
  });
});
