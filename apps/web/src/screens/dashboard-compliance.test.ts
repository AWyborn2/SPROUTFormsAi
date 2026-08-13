import { describe, expect, it } from 'vitest';
import { complianceTileCounts } from './dashboard-compliance.js';
import type { AssessmentCaseRow } from '../lib/data/assessments.js';
import type { ComplianceGap, ComplianceReport, WorkingListItem } from '../lib/data/types.js';

const gap = (userId: string, competencyId = 'c1'): ComplianceGap => ({
  userId,
  name: 'Bo Worker',
  competencyId,
  competencyName: 'Track Dozer',
});

const report = (over: Partial<ComplianceReport> = {}): ComplianceReport => ({
  expired: [],
  expiring: [],
  neverHeld: [],
  optionalLapses: [],
  unreachable: [],
  ...over,
});

const kase = (state: AssessmentCaseRow['state']): AssessmentCaseRow =>
  ({ id: 'k1', toolName: 'Dozer', candidateUserId: 'u1', candidateName: 'Bo', pathway: 'experienced', state, assessorUserId: null, createdAt: '2026-08-01' }) as AssessmentCaseRow;

const item = (): WorkingListItem =>
  ({ kind: 'owed_file', id: 'w1', subject: 'Picture owed', createdAt: '2026-08-01' }) as WorkingListItem;

describe('complianceTileCounts (R10, R13)', () => {
  it('counts MEMBERS in the expiry buckets, not gaps (AE3)', () => {
    // One person with two expiring tickets is one person to book.
    const counts = complianceTileCounts(
      report({ expiring: [gap('u1', 'c1'), gap('u1', 'c2'), gap('u2', 'c1')] }),
      [],
      [],
    );
    expect(counts?.expiringMembers).toBe(2);
  });

  it('lets the same member count in expiring AND expired independently', () => {
    // Two different tickets, two different urgencies — neither hides the other.
    const counts = complianceTileCounts(
      report({ expiring: [gap('u1', 'c1')], expired: [gap('u1', 'c2')] }),
      [],
      [],
    );
    expect(counts?.expiringMembers).toBe(1);
    expect(counts?.expiredMembers).toBe(1);
  });

  it('counts only awaiting_sign_off cases, not open ones', () => {
    const counts = complianceTileCounts(report(), [kase('open'), kase('awaiting_sign_off')], []);
    expect(counts?.awaitingSignOff).toBe(1);
  });

  it('reports the working list size verbatim', () => {
    const counts = complianceTileCounts(report(), [], [item(), item()]);
    expect(counts?.workingListSize).toBe(2);
  });

  it('returns null until every input arrives — the tile is absent, never zeroed (R12)', () => {
    expect(complianceTileCounts(undefined, [], [])).toBeNull();
    expect(complianceTileCounts(report(), undefined, [])).toBeNull();
    expect(complianceTileCounts(report(), [], undefined)).toBeNull();
  });
});
