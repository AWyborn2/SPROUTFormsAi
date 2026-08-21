import { EXPIRY_WARNING_DAYS } from '@formai/shared';
import type {
  TrainingMatrixCell,
  TrainingMatrixCompetency,
  TrainingMatrixMember,
} from '../../lib/data/types.js';

/**
 * The training matrix's derivation rules (U5), kept apart from the screen so
 * they test without rendering — the `dashboard-compliance.ts` pattern.
 *
 * Everything here reads the ONE payload `GET /training-matrix` serves:
 * `members[i].cells[j]` aligned to `competencies[j]`. The server resolves each
 * cell's standing and dated status; this module only decides how a cell READS
 * at the selected expiring window, and rolls the grid up into the numbers the
 * screen shows.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The expiring-window choices. Derived against the assessor planning horizon
 * rather than hard-coded so the options can never outrun what the server
 * itself flags: a cell only arrives `expiring` inside
 * `EXPIRY_WARNING_DAYS.assessor`, so an option beyond it would be a filter
 * that can match nothing extra.
 */
export const WINDOW_OPTIONS: readonly number[] = [30, 60, 90].filter(
  (d) => d <= EXPIRY_WARNING_DAYS.assessor,
);
export const DEFAULT_WINDOW = 60;

/** Rows rendered per "Show more" click — chunking instead of a virtualisation dep. */
export const ROW_CHUNK = 100;

/** Whole days until `expiresAt`, rounded up — "45d" means within 45 days. */
export function daysUntil(expiresAt: string, now: Date): number {
  return Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS);
}

/**
 * How one cell displays at the selected window.
 *
 * `expiring` carries its day count (clamped at 0 for a grace cell already past
 * its date — "0d" reads as "now", which is what grace means to a planner). A
 * lapsing cell OUTSIDE the window renders as plain `held`: the whole point of
 * the window select is choosing how far ahead the wall of warnings looks.
 */
export type CellDisplay =
  | { kind: 'none' }
  | { kind: 'gap' }
  | { kind: 'recommended' }
  | { kind: 'held' }
  | { kind: 'expiring'; days: number }
  | { kind: 'lapsed' };

/** Whether the cell's dated status still counts as held (revocation checked by callers). */
function statusCounts(cell: TrainingMatrixCell): boolean {
  return (
    cell.status === 'held' ||
    cell.status === 'undated' ||
    cell.status === 'expiring' ||
    cell.status === 'grace'
  );
}

export function cellDisplay(
  cell: TrainingMatrixCell | null,
  windowDays: number,
  now: Date,
): CellDisplay {
  if (!cell) return { kind: 'none' };

  // Nothing (counting) held: a revoked grant reads exactly like no grant.
  if (cell.status === undefined || cell.revoked) {
    if (cell.standing === 'required') return { kind: 'gap' };
    if (cell.standing === 'recommended') return { kind: 'recommended' };
    return { kind: 'none' };
  }

  if (cell.status === 'expired') return { kind: 'lapsed' };

  if (cell.status === 'expiring' || cell.status === 'grace') {
    // Day count only when the date sits inside the selected window; a lapsing
    // ticket with more runway than the planner asked about reads as held.
    if (cell.expiresAt) {
      const days = daysUntil(cell.expiresAt, now);
      if (days <= windowDays) return { kind: 'expiring', days: Math.max(0, days) };
    }
    return { kind: 'held' };
  }

  // 'held' | 'undated'
  return { kind: 'held' };
}

/**
 * One member's compliance %, over REQUIRED cells only. A held / undated /
 * expiring / grace status counts (same states `countsAsHeld` admits); a
 * revoked grant or a bare gap does not. Nobody required to hold anything is
 * 100% compliant — there is nothing to fail.
 */
export function memberCompliancePct(member: TrainingMatrixMember): number {
  let required = 0;
  let held = 0;
  for (const cell of member.cells) {
    if (!cell || cell.standing !== 'required') continue;
    required += 1;
    if (cell.status !== undefined && !cell.revoked && statusCounts(cell)) held += 1;
  }
  return required === 0 ? 100 : Math.round((held / required) * 100);
}

export type ComplianceBand = 'success' | 'warning' | 'danger';

/** ≥95 green, ≥80 amber, else red — the prototype's bands. */
export function complianceBand(pct: number): ComplianceBand {
  if (pct >= 95) return 'success';
  if (pct >= 80) return 'warning';
  return 'danger';
}

/** The filter row's state, applied conjunctively. */
export interface MatrixFilters {
  /** Free text over the member's name and role names, case-insensitive. */
  search: string;
  /** A location id, or 'all'. */
  locationId: string;
  /** A department id, or 'all'. */
  departmentId: string;
  chip: 'all' | 'gaps' | 'expiring';
}

/** Whether any REQUIRED cell is unmet — no counting grant, revoked, or lapsed. */
export function memberHasGaps(member: TrainingMatrixMember): boolean {
  return member.cells.some(
    (cell) =>
      cell !== null &&
      cell.standing === 'required' &&
      (cell.status === undefined || cell.revoked === true || !statusCounts(cell)),
  );
}

/** Whether any held cell is expiring (or in grace) inside the window. */
export function memberHasExpiring(
  member: TrainingMatrixMember,
  windowDays: number,
  now: Date,
): boolean {
  return member.cells.some((cell) => cellDisplay(cell, windowDays, now).kind === 'expiring');
}

export function memberMatchesFilters(
  member: TrainingMatrixMember,
  filters: MatrixFilters,
  windowDays: number,
  now: Date,
): boolean {
  const q = filters.search.trim().toLowerCase();
  if (q) {
    const haystack = [member.name, member.role, ...member.roles.map((r) => r.name)]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (filters.locationId !== 'all' && !member.locations.some((l) => l.id === filters.locationId)) {
    return false;
  }
  if (
    filters.departmentId !== 'all' &&
    !member.departments.some((d) => d.id === filters.departmentId)
  ) {
    return false;
  }
  if (filters.chip === 'gaps' && !memberHasGaps(member)) return false;
  if (filters.chip === 'expiring' && !memberHasExpiring(member, windowDays, now)) return false;
  return true;
}

export type GroupAxis = 'department' | 'location' | 'role';

/** The always-last bucket for members with no placement on the grouping axis. */
export const UNASSIGNED_GROUP = 'Unassigned';

export interface MatrixGroup {
  name: string;
  members: TrainingMatrixMember[];
  memberCount: number;
  /** Cell totals across the group — held includes expiring/grace (they still count). */
  held: number;
  expiring: number;
  /** Gaps + lapses — the cells someone has to act on. */
  attention: number;
  /** Aggregate over the group's required cells (100 when it requires nothing). */
  compliancePct: number;
}

function placementNames(member: TrainingMatrixMember, axis: GroupAxis): string[] {
  const list =
    axis === 'department' ? member.departments : axis === 'location' ? member.locations : member.roles;
  return list.map((p) => p.name);
}

/**
 * The grouped view's cards: members bucketed by placement NAME on the axis (a
 * member placed twice appears in both groups — that is what "who is at
 * Boddington" means), name-sorted, with the unplaced in an always-last
 * "Unassigned" bucket. Groups nobody is in simply do not exist — buckets are
 * grown from members, never from the taxonomy.
 */
export function groupMembers(
  members: readonly TrainingMatrixMember[],
  axis: GroupAxis,
  windowDays: number,
  now: Date,
): MatrixGroup[] {
  const buckets = new Map<string, TrainingMatrixMember[]>();
  for (const member of members) {
    const names = placementNames(member, axis);
    const targets = names.length > 0 ? names : [UNASSIGNED_GROUP];
    for (const name of targets) {
      const bucket = buckets.get(name);
      if (bucket) bucket.push(member);
      else buckets.set(name, [member]);
    }
  }

  const groups: MatrixGroup[] = [];
  for (const [name, bucket] of buckets) {
    let held = 0;
    let expiring = 0;
    let attention = 0;
    let required = 0;
    let requiredHeld = 0;
    for (const member of bucket) {
      for (const cell of member.cells) {
        const display = cellDisplay(cell, windowDays, now);
        if (display.kind === 'held') held += 1;
        else if (display.kind === 'expiring') {
          held += 1; // still counts — the flag is urgency, not absence
          expiring += 1;
        } else if (display.kind === 'gap' || display.kind === 'lapsed') attention += 1;
        if (cell?.standing === 'required') {
          required += 1;
          if (cell.status !== undefined && !cell.revoked && statusCounts(cell)) requiredHeld += 1;
        }
      }
    }
    groups.push({
      name,
      members: bucket,
      memberCount: bucket.length,
      held,
      expiring,
      attention,
      compliancePct: required === 0 ? 100 : Math.round((requiredHeld / required) * 100),
    });
  }

  groups.sort((a, b) => {
    if (a.name === UNASSIGNED_GROUP) return 1;
    if (b.name === UNASSIGNED_GROUP) return -1;
    return a.name.localeCompare(b.name);
  });
  return groups;
}

/** How many issue chips a member row shows before collapsing to "+N more". */
export const MAX_ISSUE_CHIPS = 3;

export interface IssueChip {
  label: string;
  tone: 'danger' | 'warning';
}

/**
 * A member's issue chips: lapses and gaps first (danger — they need action
 * now), then expiring-in-window with day counts (warning — they need booking),
 * capped at MAX_ISSUE_CHIPS with the overflow counted, never dropped.
 */
export function memberIssueChips(
  member: TrainingMatrixMember,
  competencies: readonly TrainingMatrixCompetency[],
  windowDays: number,
  now: Date,
): { chips: IssueChip[]; more: number } {
  const danger: IssueChip[] = [];
  const warning: IssueChip[] = [];
  member.cells.forEach((cell, i) => {
    const name = competencies[i]?.name ?? '';
    const display = cellDisplay(cell, windowDays, now);
    if (display.kind === 'lapsed' || display.kind === 'gap') {
      danger.push({ label: name, tone: 'danger' });
    } else if (display.kind === 'expiring') {
      warning.push({ label: `${name} · ${display.days}d`, tone: 'warning' });
    }
  });
  const all = [...danger, ...warning];
  return { chips: all.slice(0, MAX_ISSUE_CHIPS), more: Math.max(0, all.length - MAX_ISSUE_CHIPS) };
}

/** A cell's state as the CSV says it. Empty for a not-required, nothing-held cell. */
export function cellStateText(display: CellDisplay): string {
  switch (display.kind) {
    case 'held':
      return 'Held';
    case 'expiring':
      return `Expiring (${display.days}d)`;
    case 'lapsed':
      return 'Lapsed';
    case 'gap':
      return 'Gap';
    case 'recommended':
      return 'Recommended';
    case 'none':
      return '';
  }
}

/**
 * CSV rows for the CURRENT view — the caller passes the already-filtered
 * member list, so what downloads is exactly what the grid shows. Header:
 * Person, Role, one column per competency, Compliance %.
 */
export function matrixCsvRows(
  competencies: readonly TrainingMatrixCompetency[],
  members: readonly TrainingMatrixMember[],
  windowDays: number,
  now: Date,
): string[][] {
  const header = ['Person', 'Role', ...competencies.map((c) => c.name), 'Compliance %'];
  const rows = members.map((m) => [
    m.name,
    m.role,
    ...m.cells.map((cell) => cellStateText(cellDisplay(cell, windowDays, now))),
    String(memberCompliancePct(m)),
  ]);
  return [header, ...rows];
}
