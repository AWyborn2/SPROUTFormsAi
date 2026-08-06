// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AssessorQueueItem } from '../../lib/data/assessments.js';

const queue: { data: AssessorQueueItem[] | undefined; isLoading: boolean; isError: boolean } = {
  data: undefined,
  isLoading: false,
  isError: false,
};

vi.mock('../../lib/data/hooks.js', () => ({ useAssessorQueue: () => queue }));
vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const { AssessorQueueScreen } = await import('./AssessorQueueScreen.js');

const item = (over: Partial<AssessorQueueItem> = {}): AssessorQueueItem => ({
  id: 'case-1',
  toolName: 'Track Dozer',
  candidateUserId: 'cand-1',
  pathway: 'new',
  locationId: 'loc-1',
  locationName: 'Mining',
  createdAt: '',
  ageDays: 3,
  overdue: false,
  ...over,
});

afterEach(() => {
  vi.clearAllMocks();
  queue.data = undefined;
  queue.isLoading = false;
  queue.isError = false;
});

describe('AssessorQueueScreen (U13)', () => {
  it('lists a pooled case, linking to its detail', () => {
    queue.data = [item()];
    render(<AssessorQueueScreen />);
    const link = screen.getByRole('link', { name: 'Track Dozer' });
    expect(link.getAttribute('href')).toBe('/app/assessments/case-1');
    expect(screen.getByText('Mining')).toBeDefined();
  });

  it('flags an overdue case', () => {
    queue.data = [item({ overdue: true, ageDays: 30 })];
    render(<AssessorQueueScreen />);
    expect(screen.getByText('Overdue')).toBeDefined();
  });

  it('shows an empty state when nothing is waiting', () => {
    queue.data = [];
    render(<AssessorQueueScreen />);
    expect(screen.getByText(/Nothing is waiting/)).toBeDefined();
  });
});
