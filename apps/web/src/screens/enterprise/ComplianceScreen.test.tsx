// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComplianceReport } from '../../lib/data/types.js';

const report: { data: ComplianceReport | undefined; isLoading: boolean; isError: boolean } = {
  data: undefined,
  isLoading: false,
  isError: false,
};

vi.mock('../../lib/data/hooks.js', () => ({
  useComplianceReport: () => report,
}));

/*
  The `?status=` focus rides real router state; the mock lets each case set the
  param and assert the narrowing without a full router tree.
*/
let searchParams = new URLSearchParams();
const setSearchParams = vi.fn((next: URLSearchParams | Record<string, string>) => {
  searchParams = next instanceof URLSearchParams ? next : new URLSearchParams(next);
});
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [searchParams, setSearchParams] as const,
}));

const { ComplianceScreen } = await import('./ComplianceScreen.js');

const EMPTY: ComplianceReport = {
  expired: [],
  expiring: [],
  neverHeld: [],
  optionalLapses: [],
  unreachable: [],
};

afterEach(() => {
  vi.clearAllMocks();
  report.data = undefined;
  searchParams = new URLSearchParams();
});

describe('ComplianceScreen (U20)', () => {
  it('lists an expired required competency under expired, and a never-held one separately (R103)', () => {
    report.data = {
      ...EMPTY,
      expired: [{ userId: 'u1', name: 'Bo Worker', competencyId: 'c1', competencyName: 'Track Dozer' }],
      neverHeld: [{ userId: 'u2', name: 'Cy Trainee', competencyId: 'c2', competencyName: 'First Aid' }],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('Required competencies expired')).toBeDefined();
    expect(screen.getByText('Bo Worker')).toBeDefined();
    expect(screen.getByText('Required competencies never held')).toBeDefined();
    expect(screen.getByText('Cy Trainee')).toBeDefined();
  });

  it('shows an optional lapse as informational, not a failure (R102)', () => {
    report.data = {
      ...EMPTY,
      optionalLapses: [{ userId: 'u1', name: 'Bo Worker', competencyId: 'c9', competencyName: 'Voluntary Ticket' }],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('Optional lapses')).toBeDefined();
    expect(screen.getByText('Voluntary Ticket')).toBeDefined();
  });

  it('lists expiring required competencies as their own bookable-runway section', () => {
    report.data = {
      ...EMPTY,
      expiring: [{ userId: 'u3', name: 'Ada Fitter', competencyId: 'c3', competencyName: 'Working at Heights' }],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('Required competencies expiring soon')).toBeDefined();
    expect(screen.getByText('Ada Fitter')).toBeDefined();
  });

  it('narrows to one section on ?status= and offers the way back', () => {
    searchParams = new URLSearchParams({ status: 'expiring' });
    report.data = {
      ...EMPTY,
      expiring: [{ userId: 'u3', name: 'Ada Fitter', competencyId: 'c3', competencyName: 'Working at Heights' }],
      expired: [{ userId: 'u1', name: 'Bo Worker', competencyId: 'c1', competencyName: 'Track Dozer' }],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('Required competencies expiring soon')).toBeDefined();
    // The other sections are hidden, not rendered-and-empty.
    expect(screen.queryByText('Required competencies expired')).toBeNull();
    expect(screen.queryByText('Optional lapses')).toBeNull();

    fireEvent.click(screen.getByText('Show full report'));
    expect(setSearchParams).toHaveBeenCalled();
  });

  it('ignores an unknown status param rather than rendering a blank page', () => {
    searchParams = new URLSearchParams({ status: 'bogus' });
    report.data = EMPTY;
    render(<ComplianceScreen />);
    expect(screen.getByText('Required competencies expired')).toBeDefined();
    expect(screen.getByText('Optional lapses')).toBeDefined();
  });
});
