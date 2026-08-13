// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';

/*
  The hooks are mocked to capture their `enabled` option — the badge contract's
  security half is that an ineligible reader's shell never fires the fetch, and
  that is only observable at this seam.
*/
const calls = {
  queue: [] as Array<{ enabled?: boolean } | undefined>,
  working: [] as Array<{ enabled?: boolean } | undefined>,
  dash: [] as Array<{ enabled?: boolean } | undefined>,
};
const data = {
  queue: undefined as unknown[] | undefined,
  working: undefined as unknown[] | undefined,
  pendingReview: undefined as number | undefined,
};

vi.mock('../lib/data/hooks.js', () => ({
  useAssessorQueue: (o?: { enabled?: boolean }) => {
    calls.queue.push(o);
    return { data: o?.enabled ? data.queue : undefined };
  },
  useWorkingList: (o?: { enabled?: boolean }) => {
    calls.working.push(o);
    return { data: o?.enabled ? data.working : undefined };
  },
  useDashboard: (o?: { enabled?: boolean }) => {
    calls.dash.push(o);
    return { data: o?.enabled ? { pendingReview: data.pendingReview } : undefined };
  },
}));

const { badgeFor, badgeLabel, groupRollup, NavCountPill, useNavBadgeCounts } = await import(
  './nav-badges.js'
);

const ALL_KEYS = new Set(['assessment-queue', 'working-list', 'submissions']);

afterEach(() => {
  vi.clearAllMocks();
  calls.queue = [];
  calls.working = [];
  calls.dash = [];
  data.queue = undefined;
  data.working = undefined;
  data.pendingReview = undefined;
});

describe('badgeLabel (R9)', () => {
  it('says nothing at zero or unknown — a zero-count entry looks exactly as today', () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(null)).toBeNull();
    expect(badgeLabel(undefined)).toBeNull();
  });

  it('shows the number, capping at 99+', () => {
    expect(badgeLabel(5)).toBe('5');
    expect(badgeLabel(99)).toBe('99');
    expect(badgeLabel(120)).toBe('99+');
  });
});

describe('NavCountPill', () => {
  it('renders no element at zero (AE2)', () => {
    const { container } = render(<NavCountPill count={0} context="unowned cases" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the count with an accessible context, not a bare numeral', () => {
    render(<NavCountPill count={12} context="unowned cases in the assessment queue" />);
    const pill = screen.getByText('12');
    expect(pill.getAttribute('aria-label')).toBe('12 unowned cases in the assessment queue');
  });
});

describe('useNavBadgeCounts — fetch gating (R5–R7)', () => {
  it('enables each read only for the grant the API actually checks', () => {
    data.queue = [1, 2];
    data.working = [1];
    data.pendingReview = 3;
    const { result } = renderHook(() => useNavBadgeCounts(ALL_KEYS, 'admin'));
    expect(result.current).toEqual({ 'assessment-queue': 2, 'working-list': 1, submissions: 3 });
    expect(calls.queue[0]?.enabled).toBe(true);
    expect(calls.working[0]?.enabled).toBe(true);
    expect(calls.dash[0]?.enabled).toBe(true);
  });

  it('never fires the queue fetch for a builder — the API would 403 it', () => {
    // The nav's rank floor admits builders to the queue entry, but the route
    // gates on assessments.edit, which they lack.
    renderHook(() => useNavBadgeCounts(ALL_KEYS, 'builder'));
    expect(calls.queue[0]?.enabled).toBe(false);
    expect(calls.working[0]?.enabled).toBe(false);
    // Submissions rides the ungated dashboard read — still on.
    expect(calls.dash[0]?.enabled).toBe(true);
  });

  it('never fires a fetch for an entry absent from the reader nav', () => {
    renderHook(() => useNavBadgeCounts(new Set(['submissions']), 'assessor'));
    expect(calls.queue[0]?.enabled).toBe(false);
    expect(calls.working[0]?.enabled).toBe(false);
  });

  it('reports null (not zero) while a count is unknown, so no badge flashes a 0', () => {
    const { result } = renderHook(() => useNavBadgeCounts(ALL_KEYS, 'assessor'));
    expect(result.current['assessment-queue']).toBeNull();
  });
});

describe('badgeFor and groupRollup — the shell wiring (R5–R7, R9)', () => {
  const counts = { 'assessment-queue': 3, 'working-list': 2, submissions: 5 } as const;

  it('answers only for badged keys — an unbadged entry never grows a pill', () => {
    expect(badgeFor(counts, 'assessment-queue')).toBe(3);
    expect(badgeFor(counts, 'compliance')).toBeNull();
    expect(badgeFor(undefined, 'assessment-queue')).toBeNull();
  });

  it('sums a collapsed group across ONLY its badged children', () => {
    // The Training group holds compliance (unbadged), assessments (unbadged)
    // and the queue — the rollup is the queue's 3, nothing invented.
    expect(groupRollup(counts, ['compliance', 'assessments', 'assessment-queue'])).toBe(3);
    // The Settings group's only badged child is the working list.
    expect(groupRollup(counts, ['team', 'working-list', 'billing'])).toBe(2);
  });

  it('rolls unknown counts up as zero rather than poisoning the sum', () => {
    const partial = { 'assessment-queue': null, 'working-list': 4, submissions: null };
    expect(groupRollup(partial, ['assessment-queue', 'working-list'])).toBe(4);
    expect(groupRollup(undefined, ['assessment-queue'])).toBe(0);
  });
});
