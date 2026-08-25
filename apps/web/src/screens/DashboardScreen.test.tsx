// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComplianceReport, RecommendedCompetencies } from '../lib/data/types.js';

/*
  The compliance tile's render gate (role + plan feature) and its two render
  sites (populated dashboard and forms-empty dashboard) are the seam these
  tests pin — the pure counting helper has its own suite.
*/
const state = {
  role: 'owner' as string,
  features: { assessments: true } as Record<string, boolean> | null,
  forms: [] as unknown[],
  dash: undefined as unknown,
  compliance: { data: undefined as ComplianceReport | undefined, isError: false },
  cases: { data: undefined as unknown[] | undefined, isError: false },
  working: { data: undefined as unknown[] | undefined, isError: false },
  fetches: [] as string[],
  /** The candidate's recommended read (U7). Empty keeps the card absent. */
  recommended: undefined as RecommendedCompetencies | undefined,
};
const requestTraining = vi.fn();

vi.mock('../lib/data/hooks.js', () => ({
  useSession: () => ({
    data: { role: state.role, features: state.features, userName: 'Ash Wyborn', userId: 'u1' },
  }),
  useForms: () => ({ data: state.forms }),
  useDashboard: () => ({ data: state.dash }),
  useComplianceReport: (o?: { enabled?: boolean }) => {
    if (o?.enabled) state.fetches.push('compliance');
    return o?.enabled ? state.compliance : { data: undefined, isError: false };
  },
  useAssessmentCases: (o?: { enabled?: boolean }) => {
    if (o?.enabled) state.fetches.push('cases');
    return o?.enabled ? state.cases : { data: undefined, isError: false };
  },
  useWorkingList: (o?: { enabled?: boolean }) => {
    if (o?.enabled) state.fetches.push('working');
    return o?.enabled ? state.working : { data: undefined, isError: false };
  },
  useAssessorQueue: () => ({ data: undefined }),
  useHeldCompetencies: () => ({ data: [] }),
  useMyRecommended: () => ({ data: state.recommended }),
  useRequestTraining: () => ({ mutate: requestTraining, isPending: false }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/onboarding.js', () => ({ useOnboarding: () => ({ orgName: 'CHC' }) }));
// The recommended card toasts on request outcomes; the provider is app chrome
// these component tests do not mount.
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast: vi.fn() }) };
});

const { DashboardScreen } = await import('./DashboardScreen.js');

const REPORT: ComplianceReport = {
  expired: [
    { userId: 'u2', name: 'Bo', competencyId: 'c1', competencyName: 'Dozer', hasAwardingAssessment: true },
  ],
  expiring: [],
  neverHeld: [],
  optionalLapses: [],
  unreachable: [],
};

function populatedWorkspace() {
  state.forms = [{ id: 'f1' }];
  state.dash = { activeForms: 1, submissionsTotal: 2, pendingReview: 0, activity: [] };
}

afterEach(() => {
  vi.clearAllMocks();
  state.role = 'owner';
  state.features = { assessments: true };
  state.forms = [];
  state.dash = undefined;
  state.compliance = { data: undefined, isError: false };
  state.cases = { data: undefined, isError: false };
  state.working = { data: undefined, isError: false };
  state.fetches = [];
  state.recommended = undefined;
});

describe('DashboardScreen — compliance tile gating (R10, R12)', () => {
  it('renders the tile for an owner on the assessments tier, in the populated dashboard', () => {
    populatedWorkspace();
    state.compliance = { data: REPORT, isError: false };
    state.cases = { data: [], isError: false };
    state.working = { data: [], isError: false };
    render(<DashboardScreen />);
    expect(screen.getByText('Workforce compliance')).toBeDefined();
    expect(screen.getByText('Required expired')).toBeDefined();
  });

  it('renders the tile above the forms-empty state — no forms is not no workforce (AE4 inverse)', () => {
    state.compliance = { data: REPORT, isError: false };
    state.cases = { data: [], isError: false };
    state.working = { data: [], isError: false };
    render(<DashboardScreen />);
    expect(screen.getByText('Workforce compliance')).toBeDefined();
    // The empty-state welcome still renders below it.
    expect(screen.getByText(/Welcome to CHC/)).toBeDefined();
  });

  it('renders no tile and fires no gated fetch below admin (R12)', () => {
    state.role = 'builder';
    populatedWorkspace();
    render(<DashboardScreen />);
    expect(screen.queryByText('Workforce compliance')).toBeNull();
    expect(state.fetches).toEqual([]);
  });

  it('renders no tile without the assessments feature — absent, not empty (AE4)', () => {
    state.features = { assessments: false };
    populatedWorkspace();
    render(<DashboardScreen />);
    expect(screen.queryByText('Workforce compliance')).toBeNull();
    expect(state.fetches).toEqual([]);
  });

  it('names a failed load instead of vanishing like an ineligible reader', () => {
    populatedWorkspace();
    state.working = { data: undefined, isError: true };
    state.compliance = { data: REPORT, isError: false };
    state.cases = { data: [], isError: false };
    render(<DashboardScreen />);
    expect(screen.getByText(/compliance numbers couldn/i)).toBeDefined();
  });
});

describe('DashboardScreen — the candidate’s recommended card (U7, R12, R14, AE5)', () => {
  const RECOMMENDED: RecommendedCompetencies = {
    selfStartEnabled: false,
    items: [
      { competencyId: 'c1', name: 'First Aid', code: 'HLTAID011', held: false, requestableToolId: 't1' },
      { competencyId: 'c2', name: 'Working at Heights', code: null, held: true, requestableToolId: 't2' },
    ],
  };

  it('lists only UNHELD recommendations, with no start action while self-start is OFF (AE5)', () => {
    state.role = 'candidate';
    state.recommended = RECOMMENDED;
    render(<DashboardScreen />);
    expect(screen.getByText('Recommended for your roles')).toBeDefined();
    expect(screen.getByText('First Aid')).toBeDefined();
    // Held rows need nothing — they already show on the record.
    expect(screen.queryByText('Working at Heights')).toBeNull();
    // The recommendation is VISIBLE, the action is not (toggle OFF).
    expect(screen.queryByRole('button', { name: 'Request this training' })).toBeNull();
  });

  it('exposes "Request this training" with the toggle ON, posting the existing { toolId } body (R14)', () => {
    state.role = 'candidate';
    state.recommended = { ...RECOMMENDED, selfStartEnabled: true };
    render(<DashboardScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Request this training' }));
    expect(requestTraining).toHaveBeenCalledWith('t1', expect.anything());
  });

  it('offers no request for an evidence-only recommendation even with the toggle ON (R7)', () => {
    state.role = 'candidate';
    state.recommended = {
      selfStartEnabled: true,
      items: [
        { competencyId: 'c3', name: 'Driver Licence', code: null, held: false, requestableToolId: null },
      ],
    };
    render(<DashboardScreen />);
    expect(screen.getByText('Driver Licence')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Request this training' })).toBeNull();
    expect(screen.getByText(/Evidence-based/)).toBeDefined();
  });

  it('renders no card at all when everything recommended is held', () => {
    state.role = 'candidate';
    state.recommended = {
      selfStartEnabled: true,
      items: [
        { competencyId: 'c2', name: 'Working at Heights', code: null, held: true, requestableToolId: 't2' },
      ],
    };
    render(<DashboardScreen />);
    expect(screen.queryByText('Recommended for your roles')).toBeNull();
  });
});
