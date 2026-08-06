import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@formai/db';

// The lib imports `db` for its type only and takes the database as a parameter.
vi.mock('../db.js', () => ({ db: null, getDbStatus: () => 'unconfigured' }));

// Spy on the sender: fail-soft is the sender's own contract; here we assert the
// notice is recorded whatever the send returns, and can force a failed send.
let emailResult = true;
const sendExpiry = vi.fn(async (..._args: unknown[]) => emailResult);
vi.mock('../email/resend.js', () => ({
  sendExpiryNoticeEmail: (...args: unknown[]) => sendExpiry(...args),
}));

const { sweepOrganization, sweepAllOrganizations } = await import('./sweep.js');

const NOW = new Date('2026-08-06T00:00:00Z');
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
/** A grant with an explicit expiry `days` from NOW — the override wins over the derived date, so the window is exact. */
const grantExpiringIn = (days: number) => ({ grantedAt: daysFromNow(-100), expiresAt: daysFromNow(days) });

const org = (over: Record<string, unknown> = {}) => ({ id: 'org-1', notificationLeadDays: 30, ...over });
const COMP = { id: 'c1', orgId: 'org-1', name: 'ATO - Track Dozer', validForMonths: 36, gracePeriodDays: null };
const USER = { id: 'u1', email: 'u1@example.com' };

interface DbOpts {
  orgs?: Record<string, unknown>[];
  memberships?: Record<string, unknown>[];
  membershipRoles?: Record<string, unknown>[];
  roleReqs?: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  templates?: Record<string, unknown>[];
  heldLocations?: Record<string, unknown>[];
  openCases?: Record<string, unknown>[];
  holders?: Record<string, unknown>[];
  comps?: Record<string, unknown>[];
  users?: Record<string, unknown>[];
  holdersFindMany?: () => Promise<Record<string, unknown>[]>;
}

function makeDb(opts: DbOpts) {
  const notices: Record<string, unknown>[] = [];
  const cases: Record<string, unknown>[] = [];
  const insert = vi.fn((table: unknown) => ({
    values: (v: Record<string, unknown>) => {
      if (table === schema.sentNotices) notices.push(v);
      else if (table === schema.assessmentCases) cases.push(v);
      return {
        returning: async () => [{ id: `row-${notices.length + cases.length}` }],
        onConflictDoNothing: async () => undefined,
      };
    },
  }));
  const db = {
    query: {
      organizations: { findMany: async () => opts.orgs ?? [org()] },
      memberships: { findMany: async () => opts.memberships ?? [] },
      membershipRoles: { findMany: async () => opts.membershipRoles ?? [] },
      roleRequiredAssessments: { findMany: async () => opts.roleReqs ?? [] },
      assessmentTools: { findMany: async () => opts.tools ?? [] },
      formTemplates: { findMany: async () => opts.templates ?? [] },
      membershipLocations: { findMany: async () => opts.heldLocations ?? [] },
      assessmentCases: { findMany: async () => opts.openCases ?? [] },
      competencyHolders: { findMany: opts.holdersFindMany ?? (async () => opts.holders ?? []) },
      competencies: { findMany: async () => opts.comps ?? [] },
      users: { findMany: async () => opts.users ?? [] },
      // Coarse-but-sufficient idempotence: a single-holder run inserts one row,
      // and the next run finds it and skips.
      sentNotices: { findFirst: async () => notices[0] },
    },
    insert,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, notices, cases };
}

afterEach(() => {
  emailResult = true;
  vi.clearAllMocks();
});

describe('sweepOrganization — notification pass', () => {
  it('sends ONE notice across two runs in the same window (KTD11 idempotence)', async () => {
    // The failure that matters: a second sweep before the window changes must not
    // double-notify. Run it twice against the SAME live state.
    const { db, notices } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });

    const first = await sweepOrganization(db, org() as never, NOW);
    const second = await sweepOrganization(db, org() as never, NOW);

    expect(first.noticesSent).toBe(1);
    expect(second.noticesSent).toBe(0);
    expect(notices).toHaveLength(1);
  });

  it('notifies a holder whose competency is inside the lead window (R97, R98)', async () => {
    const { db, notices } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    expect(result.noticesSent).toBe(1);
    expect(notices[0]).toMatchObject({ userId: 'u1', competencyId: 'c1' });
    expect(sendExpiry).toHaveBeenCalledOnce();
  });

  it('notifies an OPTIONAL competency’s holder too — the window does not read standing (R97)', async () => {
    // The notification pass warns any holder in the window; whether a Role
    // requires it is standing's business, not the clock's.
    const { db } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(10), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    expect(result.noticesSent).toBe(1);
  });

  it('does not notify a competency outside the window', async () => {
    const { db } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(200), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    expect(result.noticesSent).toBe(0);
  });

  it('does not notify an already-lapsed competency — that is the assignment pass’s job', async () => {
    const { db } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(-5), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    expect(result.noticesSent).toBe(0);
  });

  it("changing the lead time changes which competencies notify, with no code change (KTD12)", async () => {
    const holders = [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(45), revokedAt: null }];
    const short = await sweepOrganization(makeDb({ holders, comps: [COMP], users: [USER] }).db, org({ notificationLeadDays: 30 }) as never, NOW);
    const long = await sweepOrganization(makeDb({ holders, comps: [COMP], users: [USER] }).db, org({ notificationLeadDays: 60 }) as never, NOW);
    expect(short.noticesSent).toBe(0); // 45 days out is outside a 30-day window
    expect(long.noticesSent).toBe(1); // …but inside a 60-day one
  });

  it('records the notice even when the email sender is unconfigured (fail-soft)', async () => {
    emailResult = false; // sender reports a failed/absent send
    const { db, notices } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    // The login-served record is written regardless — it is the other route.
    expect(result.noticesSent).toBe(1);
    expect(notices).toHaveLength(1);
  });
});

describe('sweepAllOrganizations', () => {
  it('sweeps every org and isolates a failure so one bad org does not stop the rest (KTD11)', async () => {
    const holdersFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }])
      .mockRejectedValueOnce(new Error('org-2 blew up'));
    const { db } = makeDb({
      orgs: [org({ id: 'org-1' }), org({ id: 'org-2' })],
      comps: [COMP],
      users: [USER],
      holdersFindMany,
    });
    const results = await sweepAllOrganizations(db, NOW);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ orgId: 'org-1', noticesSent: 1 });
    expect(results[1]).toMatchObject({ orgId: 'org-2', failed: true });
  });

  it('sweeps a newly created org with no registration step', async () => {
    // The only source of orgs is a findMany over the table, so a new org is in
    // the next call by construction.
    const { db } = makeDb({ orgs: [org({ id: 'brand-new' })] });
    const results = await sweepAllOrganizations(db, NOW);
    expect(results.map((r) => r.orgId)).toEqual(['brand-new']);
  });
});
