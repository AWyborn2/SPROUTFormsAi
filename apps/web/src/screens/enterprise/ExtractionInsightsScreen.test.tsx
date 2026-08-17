// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CorrectionCandidates } from '../../lib/data/types.js';

let result: { data?: CorrectionCandidates; isLoading: boolean; isError: boolean };

vi.mock('../../lib/data/hooks.js', () => ({
  useCorrectionCandidates: () => result,
}));

const { ExtractionInsightsScreen } = await import('./ExtractionInsightsScreen.js');

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
    render(<ExtractionInsightsScreen />);
    expect(screen.getByText(/available to admins only/)).toBeTruthy();
  });
});
