import { afterEach, describe, expect, it, vi } from 'vitest';

// The helper imports `db` for its type only and takes the database as a
// parameter, so a null module db is all this needs.
vi.mock('../db.js', () => ({ db: null, getDbStatus: () => 'unconfigured' }));

// Spy on the sender rather than reach real email infrastructure. Fail-soft is
// the sender's own contract (tested in resend); here we assert WHO is reached.
const sentTo: string[] = [];
vi.mock('../email/resend.js', () => ({
  sendPooledCaseNoticeEmail: vi.fn(async (input: { to: string }) => {
    sentTo.push(input.to);
    return true;
  }),
}));

const { notifyPoolOfInvalidatedCase } = await import('./pool-notify.js');

const ORG = 'org-1';
const NOW = new Date('2026-08-06T00:00:00Z');

function makeDb(rows: {
  tool?: Record<string, unknown>;
  holders?: Record<string, unknown>[];
  competencies?: Record<string, unknown>[];
  users?: Record<string, unknown>[];
}) {
  return {
    query: {
      assessmentTools: { findFirst: async () => rows.tool },
      competencyHolders: { findMany: async () => rows.holders ?? [] },
      competencies: { findMany: async () => rows.competencies ?? [] },
      users: { findMany: async () => rows.users ?? [] },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const TOOL = {
  id: 't1',
  orgId: ORG,
  name: 'Track Dozer',
  assessorCompetencyIds: ['c-always'],
  assessorStreamCompetencyIds: {},
};
/** 'c-always' is a three-year ticket, so currency turns on the grant date. */
const COMPS = [{ id: 'c-always', validForMonths: 36, gracePeriodDays: null }];
const USERS = [
  { id: 'u-current', email: 'current@example.com' },
  { id: 'u-expired', email: 'expired@example.com' },
  { id: 'named', email: 'named@example.com' },
];
const grantAt = (iso: string) => ({ grantedAt: new Date(iso), expiresAt: null, revokedAt: null });

afterEach(() => {
  sentTo.length = 0;
  vi.clearAllMocks();
});

describe('notifyPoolOfInvalidatedCase', () => {
  it('notifies every assessor who holds the required competency CURRENT (R130)', async () => {
    const db = makeDb({
      tool: TOOL,
      competencies: COMPS,
      holders: [
        { userId: 'u-current', competencyId: 'c-always', ...grantAt('2026-01-01') }, // current
        { userId: 'u-expired', competencyId: 'c-always', ...grantAt('2020-01-01') }, // lapsed
      ],
      users: USERS,
    });

    const { notifiedUserIds } = await notifyPoolOfInvalidatedCase(
      db,
      ORG,
      { toolId: 't1', locationId: null, candidateName: 'Bo Candidate', namedAssessorUserId: null },
      NOW,
    );

    expect(notifiedUserIds).toEqual(['u-current']);
    expect(sentTo).toEqual(['current@example.com']);
  });

  it('notifies the named assessor too, whatever their competencies (R130)', async () => {
    const db = makeDb({
      tool: TOOL,
      competencies: COMPS,
      holders: [{ userId: 'u-current', competencyId: 'c-always', ...grantAt('2026-01-01') }],
      users: USERS,
    });

    const { notifiedUserIds } = await notifyPoolOfInvalidatedCase(
      db,
      ORG,
      { toolId: 't1', locationId: null, candidateName: 'Bo', namedAssessorUserId: 'named' },
      NOW,
    );

    expect(notifiedUserIds.sort()).toEqual(['named', 'u-current']);
  });

  it('requires ALL competencies when a Location adds a stream requirement (R64)', async () => {
    const streamTool = {
      ...TOOL,
      assessorStreamCompetencyIds: { 'loc-1': ['c-stream'] },
    };
    const db = makeDb({
      tool: streamTool,
      competencies: [...COMPS, { id: 'c-stream', validForMonths: 36, gracePeriodDays: null }],
      holders: [
        // Holds only the always-required one → NOT eligible at loc-1.
        { userId: 'u-current', competencyId: 'c-always', ...grantAt('2026-01-01') },
        // Holds both → eligible.
        { userId: 'u-both', competencyId: 'c-always', ...grantAt('2026-01-01') },
        { userId: 'u-both', competencyId: 'c-stream', ...grantAt('2026-01-01') },
      ],
      users: [...USERS, { id: 'u-both', email: 'both@example.com' }],
    });

    const { notifiedUserIds } = await notifyPoolOfInvalidatedCase(
      db,
      ORG,
      { toolId: 't1', locationId: 'loc-1', candidateName: 'Bo', namedAssessorUserId: null },
      NOW,
    );

    expect(notifiedUserIds).toEqual(['u-both']);
  });

  it('reaches nobody when no one is eligible and no assessor was named', async () => {
    const db = makeDb({
      tool: TOOL,
      competencies: COMPS,
      holders: [{ userId: 'u-expired', competencyId: 'c-always', ...grantAt('2020-01-01') }],
      users: USERS,
    });

    const { notifiedUserIds } = await notifyPoolOfInvalidatedCase(
      db,
      ORG,
      { toolId: 't1', locationId: null, candidateName: 'Bo', namedAssessorUserId: null },
      NOW,
    );

    expect(notifiedUserIds).toEqual([]);
    expect(sentTo).toEqual([]);
  });

  it('excludes a revoked grant even in date — the query filters it (R107)', async () => {
    // The route filters revokedAt in the query; here the holders list already
    // reflects that (a revoked grant is simply absent), so nobody qualifies.
    const db = makeDb({
      tool: TOOL,
      competencies: COMPS,
      holders: [], // the one holder's grant was revoked, so it is not returned
      users: USERS,
    });

    const { notifiedUserIds } = await notifyPoolOfInvalidatedCase(
      db,
      ORG,
      { toolId: 't1', locationId: null, candidateName: 'Bo', namedAssessorUserId: null },
      NOW,
    );

    expect(notifiedUserIds).toEqual([]);
  });
});
