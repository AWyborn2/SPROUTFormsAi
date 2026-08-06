// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComplianceReport } from '../../lib/data/types.js';

const report: { data: ComplianceReport | undefined; isLoading: boolean; isError: boolean } = {
  data: undefined,
  isLoading: false,
  isError: false,
};

vi.mock('../../lib/data/hooks.js', () => ({
  useComplianceReport: () => report,
}));

const { ComplianceScreen } = await import('./ComplianceScreen.js');

afterEach(() => {
  vi.clearAllMocks();
  report.data = undefined;
});

describe('ComplianceScreen (U20)', () => {
  it('lists an expired required competency under expired, and a never-held one separately (R103)', () => {
    report.data = {
      expired: [{ userId: 'u1', name: 'Bo Worker', competencyId: 'c1', competencyName: 'Track Dozer' }],
      neverHeld: [{ userId: 'u2', name: 'Cy Trainee', competencyId: 'c2', competencyName: 'First Aid' }],
      optionalLapses: [],
      unreachable: [],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('Required competencies expired')).toBeDefined();
    expect(screen.getByText('Bo Worker')).toBeDefined();
    expect(screen.getByText('Required competencies never held')).toBeDefined();
    expect(screen.getByText('Cy Trainee')).toBeDefined();
  });

  it('shows an optional lapse as informational, not a failure (R102)', () => {
    report.data = {
      expired: [],
      neverHeld: [],
      optionalLapses: [{ userId: 'u1', name: 'Bo Worker', competencyId: 'c9', competencyName: 'Voluntary Ticket' }],
      unreachable: [],
    };
    render(<ComplianceScreen />);
    expect(screen.getByText('Optional lapses')).toBeDefined();
    expect(screen.getByText('Voluntary Ticket')).toBeDefined();
  });
});
