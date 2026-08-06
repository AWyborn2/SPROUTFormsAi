// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WorkingListItem } from '../../lib/data/types.js';

const list: { data: WorkingListItem[] | undefined; isLoading: boolean; isError: boolean } = {
  data: undefined,
  isLoading: false,
  isError: false,
};
const approve = vi.fn();
const decline = vi.fn();

vi.mock('../../lib/data/hooks.js', () => ({
  useWorkingList: () => list,
  useApproveTrainingRequest: () => ({ mutate: approve, isPending: false }),
  useDeclineTrainingRequest: () => ({ mutate: decline, isPending: false }),
}));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

const { WorkingListScreen } = await import('./WorkingListScreen.js');

afterEach(() => {
  vi.clearAllMocks();
  list.data = undefined;
  list.isLoading = false;
  list.isError = false;
});

describe('WorkingListScreen (U19)', () => {
  it('says nothing is waiting when the list is empty', () => {
    list.data = [];
    render(<WorkingListScreen />);
    expect(screen.getByText(/Nothing is waiting on you/)).toBeDefined();
  });

  it('renders items from every source on one list', () => {
    list.data = [
      { kind: 'overdue_case', id: 'c1', subject: 'Overdue case: Heights', createdAt: '2026-07-01' },
      { kind: 'retirement_review', id: 'l1', subject: 'Retired Location still held: Old Site', createdAt: null },
      { kind: 'training_request', id: 'tr1', subject: 'Training request: First Aid', createdAt: '2026-08-01' },
    ];
    render(<WorkingListScreen />);
    expect(screen.getByText('Overdue case: Heights')).toBeDefined();
    expect(screen.getByText('Retired Location still held: Old Site')).toBeDefined();
    expect(screen.getByText('Training request: First Aid')).toBeDefined();
  });

  it('approves a training request from the list (R94)', () => {
    list.data = [{ kind: 'training_request', id: 'tr1', subject: 'Training request: First Aid', createdAt: '2026-08-01' }];
    render(<WorkingListScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledWith('tr1', expect.anything());
  });

  it('offers no approve/decline on a non-request item', () => {
    list.data = [{ kind: 'overdue_case', id: 'c1', subject: 'Overdue case: Heights', createdAt: '2026-07-01' }];
    render(<WorkingListScreen />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
