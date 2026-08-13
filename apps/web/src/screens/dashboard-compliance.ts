import type { AssessmentCaseRow } from '../lib/data/assessments.js';
import type { ComplianceReport, WorkingListItem } from '../lib/data/types.js';

/**
 * The dashboard compliance tile's four numbers (R10, R13).
 *
 * Kept apart from the component so the counting rules test without rendering:
 * the expiry buckets count MEMBERS, not gaps — one person with three expiring
 * tickets is one person to book — while the same person may legitimately
 * appear in both the expiring and expired numbers (two different tickets, two
 * different urgencies).
 *
 * Returns null until every input has arrived: the tile is absent, not zeroed,
 * while loading or on error (gated surfaces disappear).
 */
export interface ComplianceTileCounts {
  expiringMembers: number;
  expiredMembers: number;
  awaitingSignOff: number;
  workingListSize: number;
}

export function complianceTileCounts(
  report: ComplianceReport | undefined,
  cases: AssessmentCaseRow[] | undefined,
  workingList: WorkingListItem[] | undefined,
): ComplianceTileCounts | null {
  if (!report || !cases || !workingList) return null;
  return {
    expiringMembers: new Set(report.expiring.map((g) => g.userId)).size,
    expiredMembers: new Set(report.expired.map((g) => g.userId)).size,
    awaitingSignOff: cases.filter((c) => c.state === 'awaiting_sign_off').length,
    workingListSize: workingList.length,
  };
}
