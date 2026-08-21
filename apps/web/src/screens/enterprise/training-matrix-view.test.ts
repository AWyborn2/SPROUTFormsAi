import { describe, expect, it } from 'vitest';
import { EXPIRY_WARNING_DAYS } from '@formai/shared';
import type {
  TrainingMatrixCell,
  TrainingMatrixCompetency,
  TrainingMatrixMember,
} from '../../lib/data/types.js';
import {
  DEFAULT_WINDOW,
  MAX_ISSUE_CHIPS,
  UNASSIGNED_GROUP,
  WINDOW_OPTIONS,
  cellDisplay,
  complianceBand,
  daysUntil,
  groupMembers,
  matrixCsvRows,
  memberCompliancePct,
  memberHasGaps,
  memberIssueChips,
  memberMatchesFilters,
  memberStatusBadge,
  type MatrixFilters,
} from './training-matrix-view.js';

const NOW = new Date('2026-08-20T00:00:00.000Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000).toISOString();

const comp = (name: string): TrainingMatrixCompetency => ({
  id: `c-${name}`,
  name,
  code: null,
  validForMonths: null,
  gracePeriodDays: null,
});

const member = (over: Partial<TrainingMatrixMember> = {}): TrainingMatrixMember => ({
  membershipId: 'm1',
  userId: 'u1',
  name: 'Bo Worker',
  role: 'candidate',
  locations: [],
  departments: [],
  roles: [],
  noLocationPlacement: false,
  cells: [],
  ...over,
});

const filters = (over: Partial<MatrixFilters> = {}): MatrixFilters => ({
  search: '',
  locationId: 'all',
  departmentId: 'all',
  chip: 'all',
  ...over,
});

// The recurring fixture: a required grant expiring in 45 days.
const expiring45: TrainingMatrixCell = {
  standing: 'required',
  status: 'expiring',
  expiresAt: inDays(45),
};

describe('WINDOW_OPTIONS', () => {
  it('never offers a window beyond the assessor planning horizon', () => {
    for (const d of WINDOW_OPTIONS) expect(d).toBeLessThanOrEqual(EXPIRY_WARNING_DAYS.assessor);
  });

  it('offers 30/60/90 with 60 as the default', () => {
    expect([...WINDOW_OPTIONS]).toEqual([30, 60, 90]);
    expect(WINDOW_OPTIONS).toContain(DEFAULT_WINDOW);
  });
});

describe('cellDisplay', () => {
  it('shows a 45-day expiry as expiring with its day count under the 60 and 90 windows', () => {
    expect(cellDisplay(expiring45, 60, NOW)).toEqual({ kind: 'expiring', days: 45 });
    expect(cellDisplay(expiring45, 90, NOW)).toEqual({ kind: 'expiring', days: 45 });
  });

  it('shows the same cell as plain held under the 30-day window', () => {
    expect(cellDisplay(expiring45, 30, NOW)).toEqual({ kind: 'held' });
  });

  it('clamps a grace cell already past its date to 0 days', () => {
    const cell: TrainingMatrixCell = {
      standing: 'required',
      status: 'grace',
      expiresAt: inDays(-3),
    };
    expect(cellDisplay(cell, 60, NOW)).toEqual({ kind: 'expiring', days: 0 });
  });

  it('reads null as none, a bare required standing as gap, a bare recommended as recommended', () => {
    expect(cellDisplay(null, 60, NOW)).toEqual({ kind: 'none' });
    expect(cellDisplay({ standing: 'required' }, 60, NOW)).toEqual({ kind: 'gap' });
    expect(cellDisplay({ standing: 'recommended' }, 60, NOW)).toEqual({ kind: 'recommended' });
  });

  it('reads a revoked grant exactly like no grant', () => {
    expect(cellDisplay({ standing: 'required', status: 'held', revoked: true }, 60, NOW)).toEqual({
      kind: 'gap',
    });
    expect(
      cellDisplay({ standing: 'recommended', status: 'held', revoked: true }, 60, NOW),
    ).toEqual({ kind: 'recommended' });
  });

  it('reads expired as lapsed and undated as held', () => {
    expect(cellDisplay({ standing: 'required', status: 'expired' }, 60, NOW)).toEqual({
      kind: 'lapsed',
    });
    expect(cellDisplay({ standing: 'optional', status: 'undated' }, 60, NOW)).toEqual({
      kind: 'held',
    });
  });
});

describe('daysUntil', () => {
  it('rounds up — a partial day left still counts as a day', () => {
    expect(daysUntil(new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString(), NOW)).toBe(1);
  });
});

describe('memberCompliancePct', () => {
  it('counts held, undated, expiring and grace as compliant; revoked and bare gaps as not', () => {
    const m = member({
      cells: [
        { standing: 'required', status: 'held' },
        { standing: 'required', status: 'undated' },
        { standing: 'required', status: 'held', revoked: true }, // revoked = gap
        { standing: 'required' }, // never held
      ],
    });
    expect(memberCompliancePct(m)).toBe(50);
  });

  it('ignores recommended and optional cells entirely', () => {
    const m = member({
      cells: [
        { standing: 'required', status: 'held' },
        { standing: 'recommended' }, // not held, but not required — no penalty
        { standing: 'optional', status: 'expired' },
        null,
      ],
    });
    expect(memberCompliancePct(m)).toBe(100);
  });

  it('reads a member with nothing required as 100% compliant', () => {
    expect(memberCompliancePct(member({ cells: [null, { standing: 'recommended' }] }))).toBe(100);
  });
});

describe('complianceBand', () => {
  it('bands at ≥95 success, ≥80 warning, else danger', () => {
    expect(complianceBand(100)).toBe('success');
    expect(complianceBand(95)).toBe('success');
    expect(complianceBand(94)).toBe('warning');
    expect(complianceBand(80)).toBe('warning');
    expect(complianceBand(79)).toBe('danger');
  });
});

describe('memberMatchesFilters', () => {
  const dozerOp = member({
    name: 'Bo Worker',
    roles: [{ id: 'r1', name: 'Dozer Operator' }],
    locations: [{ id: 'loc1', name: 'Boddington' }],
    departments: [{ id: 'dep1', name: 'Mining' }],
    cells: [{ standing: 'required' }], // a gap
  });

  it('matches the name and the role names, case-insensitively', () => {
    expect(memberMatchesFilters(dozerOp, filters({ search: 'bo work' }), 60, NOW)).toBe(true);
    expect(memberMatchesFilters(dozerOp, filters({ search: 'DOZER' }), 60, NOW)).toBe(true);
    expect(memberMatchesFilters(dozerOp, filters({ search: 'grader' }), 60, NOW)).toBe(false);
  });

  it('is conjunctive — a matching search still fails a mismatched location', () => {
    expect(
      memberMatchesFilters(dozerOp, filters({ search: 'dozer', locationId: 'loc-other' }), 60, NOW),
    ).toBe(false);
    expect(
      memberMatchesFilters(dozerOp, filters({ search: 'dozer', locationId: 'loc1' }), 60, NOW),
    ).toBe(true);
  });

  it('filters by department id', () => {
    expect(memberMatchesFilters(dozerOp, filters({ departmentId: 'dep1' }), 60, NOW)).toBe(true);
    expect(memberMatchesFilters(dozerOp, filters({ departmentId: 'dep2' }), 60, NOW)).toBe(false);
  });

  it('the gaps chip keeps only members with an unmet required cell', () => {
    const compliant = member({ cells: [{ standing: 'required', status: 'held' }] });
    expect(memberMatchesFilters(dozerOp, filters({ chip: 'gaps' }), 60, NOW)).toBe(true);
    expect(memberMatchesFilters(compliant, filters({ chip: 'gaps' }), 60, NOW)).toBe(false);
  });

  it('the expiring chip respects the selected window', () => {
    const m = member({ cells: [expiring45] });
    expect(memberMatchesFilters(m, filters({ chip: 'expiring' }), 60, NOW)).toBe(true);
    expect(memberMatchesFilters(m, filters({ chip: 'expiring' }), 30, NOW)).toBe(false);
  });
});

describe('groupMembers', () => {
  it('buckets by placement name, sends the unplaced to an always-last Unassigned, and omits empty groups', () => {
    const a = member({ membershipId: 'ma', name: 'Ada', departments: [{ id: 'd1', name: 'Mining' }] });
    const b = member({
      membershipId: 'mb',
      name: 'Ben',
      // Placed twice — appears in BOTH groups.
      departments: [
        { id: 'd1', name: 'Mining' },
        { id: 'd2', name: 'Fixed Plant' },
      ],
    });
    const c = member({ membershipId: 'mc', name: 'Cal', departments: [] });

    const groups = groupMembers([a, b, c], 'department', 60, NOW);
    expect(groups.map((g) => g.name)).toEqual(['Fixed Plant', 'Mining', UNASSIGNED_GROUP]);
    expect(groups.find((g) => g.name === 'Mining')?.memberCount).toBe(2);
    expect(groups.find((g) => g.name === UNASSIGNED_GROUP)?.members).toEqual([c]);
    // No group exists for a department nobody in the list is placed in.
    expect(groups).toHaveLength(3);
  });

  it('totals held/expiring/attention and aggregates compliance over required cells', () => {
    const a = member({
      membershipId: 'ma',
      locations: [{ id: 'l1', name: 'Boddington' }],
      cells: [{ standing: 'required', status: 'held' }, expiring45],
    });
    const b = member({
      membershipId: 'mb',
      locations: [{ id: 'l1', name: 'Boddington' }],
      cells: [{ standing: 'required' }, { standing: 'optional', status: 'expired' }],
    });
    const [g] = groupMembers([a, b], 'location', 60, NOW);
    expect(g?.name).toBe('Boddington');
    expect(g?.held).toBe(2); // held + the expiring one (it still counts)
    expect(g?.expiring).toBe(1);
    // REQUIRED-only, like memberHasGaps: b's required gap counts, b's OPTIONAL
    // lapse does not — an optional lapse is its own category, never attention.
    expect(g?.attention).toBe(1);
    // Required cells: a's two (both counting) + b's gap → 2/3.
    expect(g?.compliancePct).toBe(67);
  });
});

describe('memberStatusBadge', () => {
  it('required gaps beat expiring beat compliant', () => {
    const gapsAndExpiring = member({
      cells: [{ standing: 'required' }, expiring45, { standing: 'required', status: 'expired' }],
    });
    expect(memberStatusBadge(gapsAndExpiring, 60, NOW)).toEqual({
      label: '2 gaps',
      variant: 'danger',
    });

    const expiringOnly = member({ cells: [{ standing: 'required', status: 'held' }, expiring45] });
    expect(memberStatusBadge(expiringOnly, 60, NOW)).toEqual({
      label: '1 expiring',
      variant: 'warning',
    });

    const compliant = member({ cells: [{ standing: 'required', status: 'held' }] });
    expect(memberStatusBadge(compliant, 60, NOW)).toEqual({
      label: 'Compliant',
      variant: 'success',
    });
  });

  it('an optional lapsed grant is never a "gap" — badge agrees with the Has gaps filter', () => {
    const optionalLapse = member({
      cells: [{ standing: 'required', status: 'held' }, { standing: 'optional', status: 'expired' }],
    });
    expect(memberStatusBadge(optionalLapse, 60, NOW)).toEqual({
      label: 'Compliant',
      variant: 'success',
    });
    expect(memberHasGaps(optionalLapse)).toBe(false);
    expect(memberCompliancePct(optionalLapse)).toBe(100);
  });
});

describe('memberIssueChips', () => {
  const competencies = ['Dozer', 'Grader', 'Loader', 'Excavator', 'Truck'].map(comp);

  it('collapses 5 issues into 3 chips and a +2 overflow, danger first', () => {
    const m = member({
      cells: [
        { standing: 'required', status: 'expired' }, // lapsed
        { standing: 'required' }, // gap
        { standing: 'required', status: 'expiring', expiresAt: inDays(10) },
        { standing: 'required', status: 'expiring', expiresAt: inDays(20) },
        { standing: 'required', status: 'expiring', expiresAt: inDays(30) },
      ],
    });
    const { chips, more } = memberIssueChips(m, competencies, 60, NOW);
    expect(chips).toHaveLength(MAX_ISSUE_CHIPS);
    expect(more).toBe(2);
    // Chips shown + overflow always accounts for every issue.
    expect(chips.length + more).toBe(5);
    expect(chips[0]).toEqual({ label: 'Dozer', tone: 'danger' });
    expect(chips[1]).toEqual({ label: 'Grader', tone: 'danger' });
    expect(chips[2]).toEqual({ label: 'Loader · 10d', tone: 'warning' });
  });

  it('drops an expiring chip that falls outside the window', () => {
    const m = member({ cells: [null, null, null, null, expiring45] });
    expect(memberIssueChips(m, competencies, 30, NOW)).toEqual({ chips: [], more: 0 });
    expect(memberIssueChips(m, competencies, 60, NOW).chips).toEqual([
      { label: 'Truck · 45d', tone: 'warning' },
    ]);
  });
});

describe('matrixCsvRows', () => {
  const competencies = [comp('Dozer'), comp('Grader')];
  const ada = member({
    membershipId: 'ma',
    name: 'Ada',
    role: 'candidate',
    locations: [{ id: 'l1', name: 'Boddington' }],
    cells: [{ standing: 'required', status: 'held' }, expiring45],
  });
  const ben = member({
    membershipId: 'mb',
    name: 'Ben',
    role: 'assessor',
    locations: [{ id: 'l2', name: 'Worsley' }],
    cells: [{ standing: 'required' }, null],
  });

  it('builds Person, Role, one column per competency, then Compliance %', () => {
    const rows = matrixCsvRows(competencies, [ada], 60, NOW);
    expect(rows[0]).toEqual(['Person', 'Role', 'Dozer', 'Grader', 'Compliance %']);
    expect(rows[1]).toEqual(['Ada', 'candidate', 'Held', 'Expiring (45d)', '100']);
  });

  it('respects the current filters — a filtered-out member never reaches the file', () => {
    const visible = [ada, ben].filter((m) =>
      memberMatchesFilters(m, filters({ locationId: 'l1' }), 60, NOW),
    );
    const rows = matrixCsvRows(competencies, visible, 60, NOW);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r[0] === 'Ben')).toBe(false);
  });

  it('respects the window — the 30-day view exports the cell as plain Held', () => {
    const rows = matrixCsvRows(competencies, [ada], 30, NOW);
    expect(rows[1]?.[3]).toBe('Held');
  });
});
