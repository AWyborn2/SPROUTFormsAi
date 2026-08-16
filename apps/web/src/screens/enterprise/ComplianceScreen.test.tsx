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
      expired: [{ userId: 'u1', name: 'Bo Worker', competencyId: 'c1', competencyName: 'Track Dozer', hasAwardingAssessment: true }],
      neverHeld: [{ userId: 'u2', name: 'Cy Trainee', competencyId: 'c2', competencyName: 'First Aid', hasAwardingAssessment: true }],
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
      optionalLapses: [{ userId: 'u1', name: 'Bo Worker', competencyId: 'c9', competencyName: 'Voluntary Ticket', hasAwardingAssessment: true }],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('Optional lapses')).toBeDefined();
    expect(screen.getByText('Voluntary Ticket')).toBeDefined();
  });

  it('lists expiring required competencies as their own bookable-runway section', () => {
    report.data = {
      ...EMPTY,
      expiring: [{ userId: 'u3', name: 'Ada Fitter', competencyId: 'c3', competencyName: 'Working at Heights', hasAwardingAssessment: true }],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('Required competencies expiring or in grace')).toBeDefined();
    expect(screen.getByText('Ada Fitter')).toBeDefined();
  });

  it('narrows to one section on ?status= and offers the way back', () => {
    searchParams = new URLSearchParams({ status: 'expiring' });
    report.data = {
      ...EMPTY,
      expiring: [{ userId: 'u3', name: 'Ada Fitter', competencyId: 'c3', competencyName: 'Working at Heights', hasAwardingAssessment: true }],
      expired: [{ userId: 'u1', name: 'Bo Worker', competencyId: 'c1', competencyName: 'Track Dozer', hasAwardingAssessment: true }],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('Required competencies expiring or in grace')).toBeDefined();
    // The other sections are hidden, not rendered-and-empty.
    expect(screen.queryByText('Required competencies expired')).toBeNull();
    expect(screen.queryByText('Optional lapses')).toBeNull();

    fireEvent.click(screen.getByText('Show full report'));
    // The exact call matters: clearing the wrong param or dropping `replace`
    // would leave the narrow view sticky or pollute browser history.
    expect(setSearchParams).toHaveBeenCalledWith({}, { replace: true });
  });

  it('leads the expiry sections with the PEOPLE count the dashboard tile shows', () => {
    // Ada holds two lapsing tickets, Bo one: the tile says 2, so this header
    // must not silently say 3 — it says both numbers.
    report.data = {
      ...EMPTY,
      expiring: [
        { userId: 'u1', name: 'Ada Fitter', competencyId: 'c1', competencyName: 'Heights', hasAwardingAssessment: true },
        { userId: 'u1', name: 'Ada Fitter', competencyId: 'c2', competencyName: 'Dozer', hasAwardingAssessment: true },
        { userId: 'u2', name: 'Bo Worker', competencyId: 'c1', competencyName: 'Heights', hasAwardingAssessment: true },
      ],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('2 people · 3 tickets')).toBeDefined();
  });

  it('words an evidence-only gap as evidence to record, not an assessment to book (U8, R7, AE1)', () => {
    // The Dozer ATO gap is bookable; the driver's licence gap is not — no
    // assessment awards it, so its row must not send an admin hunting for a
    // booking that cannot exist. An imported grant is the remedy (R11).
    report.data = {
      ...EMPTY,
      neverHeld: [
        { userId: 'u1', name: 'Bo Worker', competencyId: 'c1', competencyName: 'Track Dozer', hasAwardingAssessment: true },
        { userId: 'u1', name: 'Bo Worker', competencyId: 'c2', competencyName: 'Driver Licence', hasAwardingAssessment: false },
      ],
    };
    render(<ComplianceScreen />);
    // Exactly one evidence marker — the bookable row carries none.
    expect(screen.getAllByText(/record evidence/i)).toHaveLength(1);
    expect(screen.getByText('Driver Licence')).toBeDefined();
  });

  it('names each gap’s source scopes in the shared comma-join spelling (U8, R5, AE1)', () => {
    report.data = {
      ...EMPTY,
      neverHeld: [
        {
          userId: 'u1',
          name: 'Bo Worker',
          competencyId: 'c1',
          competencyName: 'Site Induction',
          hasAwardingAssessment: true,
          sources: [
            { scope: 'location', name: 'Boddington' },
            { scope: 'role', name: 'Dozer Operator' },
          ],
          noLocationPlacement: false,
        },
        // AE6's shape: an org-scope requirement reads "org-wide", never the
        // organisation's own name.
        {
          userId: 'u1',
          name: 'Bo Worker',
          competencyId: 'c2',
          competencyName: 'First Aid',
          hasAwardingAssessment: true,
          sources: [{ scope: 'org', name: 'Org One' }],
          noLocationPlacement: false,
        },
      ],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('from Boddington and Dozer Operator')).toBeDefined();
    expect(screen.getByText('org-wide')).toBeDefined();
    expect(screen.queryByText(/Org One/)).toBeNull();
  });

  it('marks an UNPLACED member’s bookable gap "cannot be scheduled" (U8, KTD4)', () => {
    report.data = {
      ...EMPTY,
      neverHeld: [
        // Bookable but nowhere to assess — the marker names the fix.
        {
          userId: 'u1',
          name: 'Bo Unplaced',
          competencyId: 'c1',
          competencyName: 'Track Dozer',
          hasAwardingAssessment: true,
          sources: [],
          noLocationPlacement: true,
        },
        // Placed: no marker.
        {
          userId: 'u2',
          name: 'Ada Placed',
          competencyId: 'c1',
          competencyName: 'Track Dozer',
          hasAwardingAssessment: true,
          sources: [],
          noLocationPlacement: false,
        },
        // Unplaced but EVIDENCE-ONLY: the remedy is recording evidence,
        // placed or not, so the scheduling marker would only mislead.
        {
          userId: 'u3',
          name: 'Cy Licence',
          competencyId: 'c2',
          competencyName: 'Driver Licence',
          hasAwardingAssessment: false,
          sources: [],
          noLocationPlacement: true,
        },
      ],
    };
    render(<ComplianceScreen />);
    expect(screen.getAllByText('Cannot be scheduled — no location placement')).toHaveLength(1);
    expect(screen.getAllByText(/record evidence/i)).toHaveLength(1);
  });

  it('ignores an unknown status param rather than rendering a blank page', () => {
    searchParams = new URLSearchParams({ status: 'bogus' });
    report.data = EMPTY;
    render(<ComplianceScreen />);
    expect(screen.getByText('Required competencies expired')).toBeDefined();
    expect(screen.getByText('Optional lapses')).toBeDefined();
  });
});
