import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

const admin = { userId: 'admin-1', orgId: 'org-1', role: 'admin' as const };
const candidate = { userId: 'cand-1', orgId: 'org-1', role: 'candidate' as const };
let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { createApp } = await import('../app.js');
({ sealSession } = await import('../auth/workos.js'));

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}
function authHeader(t: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(t)}` };
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000);

const COMP = 'comp-required';
const COMP_OPT = 'comp-optional';
const grant = (competencyId: string, over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  competencyId,
  grantedAt: daysAgo(400),
  expiresAt: null,
  revokedAt: null,
  ...over,
});

/** A member whose Role requires a tool that awards COMP — so COMP is required for u1. */
function fakeDb(opts: {
  holders?: unknown[];
  competencies?: unknown[];
  memberships?: unknown[];
  /** Profiles backing the unreachable read (R99). Default: none marked. */
  profiles?: unknown[];
  /** Overrides the default user row — pass `passwordHash` to give somebody a login. */
  users?: unknown[];
}) {
  return {
    query: {
      organizations: { findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: 'enterprise' }) },
      memberships: {
        findMany: vi.fn().mockResolvedValue(
          opts.memberships ?? [{ id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active' }],
        ),
      },
      membershipRoles: { findMany: vi.fn().mockResolvedValue([{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }]) },
      roleRequiredAssessments: { findMany: vi.fn().mockResolvedValue([{ orgId: 'org-1', roleId: 'r1', toolId: 't1' }]) },
      assessmentTools: { findMany: vi.fn().mockResolvedValue([{ id: 't1', orgId: 'org-1', awardedCompetencyIds: [COMP] }]) },
      /*
        No `passwordHash` by default — an invited person who never completed
        their signup. That is the case where the mark alone decides, so the
        fixture starts there and the login case sets one explicitly.
      */
      users: { findMany: vi.fn().mockResolvedValue(opts.users ?? [{ id: 'u1', name: 'Bo Worker' }]) },
      memberProfiles: { findMany: vi.fn().mockResolvedValue(opts.profiles ?? []) },
      competencies: {
        findMany: vi.fn().mockResolvedValue(
          opts.competencies ?? [
            { id: COMP, orgId: 'org-1', name: 'Track Dozer', validForMonths: 36 },
            { id: COMP_OPT, orgId: 'org-1', name: 'First Aid', validForMonths: 36 },
          ],
        ),
      },
      competencyHolders: { findMany: vi.fn().mockResolvedValue(opts.holders ?? []) },
    },
  } as unknown as Db;
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

describe('GET /compliance (U20)', () => {
  it('reports a required competency that has expired under expired (R101, R102)', async () => {
    mockDbValue = fakeDb({ holders: [grant(COMP, { expiresAt: daysAgo(10) })] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      expired: Array<{ competencyId: string }>;
      neverHeld: unknown[];
    };
    expect(body.expired.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.neverHeld).toEqual([]);
    server.close();
  });

  it('reports a required competency inside the 90-day window under expiring, still compliant (AE3)', async () => {
    /*
      `countsAsHeld` treats an expiring grant as current, so before the expiring
      bucket existed this person appeared nowhere until they tipped into
      `expired` — the dashboard tile exists to book them BEFORE that.
    */
    mockDbValue = fakeDb({ holders: [grant(COMP, { expiresAt: daysAhead(40) })] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      expiring: Array<{ competencyId: string }>;
      neverHeld: unknown[];
    };
    expect(body.expiring.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.expired).toEqual([]);
    expect(body.neverHeld).toEqual([]);
    server.close();
  });

  it('lists a grace-period grant under expiring — past its date is the LAST person to hide', async () => {
    /*
      Grace still counts as held (no expired entry), but the person is already
      past their date — the booking surface must show them. Before this, grace
      landed in NO bucket: countsAsHeld swallowed it before expired, and the
      strict === 'expiring' test excluded it, while the Team roster
      simultaneously flagged the same person as needing attention.
    */
    mockDbValue = fakeDb({
      holders: [grant(COMP, { expiresAt: daysAgo(5) })],
      competencies: [
        { id: COMP, orgId: 'org-1', name: 'Track Dozer', validForMonths: 36, gracePeriodDays: 90 },
        { id: COMP_OPT, orgId: 'org-1', name: 'First Aid', validForMonths: 36 },
      ],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      expiring: Array<{ competencyId: string }>;
    };
    expect(body.expiring.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.expired).toEqual([]);
    server.close();
  });

  it('does not flag a renewed competency — the best grant decides, not the superseded one', async () => {
    // The old grant expired; the renewal is current for years. History keeps
    // the old row, and reading grants one by one would book this person anyway.
    mockDbValue = fakeDb({
      holders: [
        grant(COMP, { expiresAt: daysAgo(30) }),
        grant(COMP, { expiresAt: daysAhead(1000) }),
      ],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as { expired: unknown[]; expiring: unknown[] };
    expect(body.expiring).toEqual([]);
    expect(body.expired).toEqual([]);
    server.close();
  });

  it('ignores a revoked grant when computing expiring (R107)', async () => {
    mockDbValue = fakeDb({
      holders: [grant(COMP, { expiresAt: daysAhead(40), revokedAt: daysAgo(1) })],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expiring: unknown[];
      neverHeld: Array<{ competencyId: string }>;
    };
    expect(body.expiring).toEqual([]);
    // A revoked grant confers nothing, so the requirement reads as never held.
    expect(body.neverHeld.map((g) => g.competencyId)).toEqual([COMP]);
    server.close();
  });

  it('keeps an expiring OPTIONAL competency out of every bucket (R102)', async () => {
    mockDbValue = fakeDb({
      holders: [grant(COMP, { expiresAt: daysAhead(400) }), grant(COMP_OPT, { expiresAt: daysAhead(40) })],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expiring: unknown[];
      optionalLapses: unknown[];
    };
    expect(body.expiring).toEqual([]);
    expect(body.optionalLapses).toEqual([]);
    server.close();
  });

  it('reports a required competency never held under never held, separate from expired (R103)', async () => {
    mockDbValue = fakeDb({ holders: [] }); // holds nothing
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      neverHeld: Array<{ competencyId: string }>;
    };
    expect(body.neverHeld.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.expired).toEqual([]);
    server.close();
  });

  it('reports an optional lapse separately — not under expired (R102)', async () => {
    // Required COMP is held current; the OPTIONAL comp has lapsed.
    mockDbValue = fakeDb({
      holders: [
        grant(COMP, { expiresAt: daysAhead(200) }), // required, current → compliant
        grant(COMP_OPT, { expiresAt: daysAgo(10) }), // optional, lapsed
      ],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      neverHeld: unknown[];
      optionalLapses: Array<{ competencyId: string }>;
    };
    expect(body.expired).toEqual([]);
    expect(body.neverHeld).toEqual([]);
    expect(body.optionalLapses.map((g) => g.competencyId)).toEqual([COMP_OPT]);
    server.close();
  });

  it('counts a revoked required competency as not held (R107)', async () => {
    // A grant in date but revoked → not current, and not a date lapse → never held.
    mockDbValue = fakeDb({ holders: [grant(COMP, { expiresAt: daysAhead(200), revokedAt: daysAgo(1) })] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      neverHeld: Array<{ competencyId: string }>;
    };
    expect(body.neverHeld.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.expired).toEqual([]);
    server.close();
  });

  it('does not report a person whose required competency is current', async () => {
    mockDbValue = fakeDb({ holders: [grant(COMP, { expiresAt: daysAhead(200) })] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as { expired: unknown[]; neverHeld: unknown[] };
    expect(body.expired).toEqual([]);
    expect(body.neverHeld).toEqual([]);
    server.close();
  });

  it('responds with empty sections for an org with no active members', async () => {
    mockDbValue = fakeDb({ memberships: [] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    expect(await res.json()).toEqual({ expired: [], expiring: [], neverHeld: [], optionalLapses: [], unreachable: [] });
    server.close();
  });

  it('refuses a non-Admin', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(candidate) });
    expect(res.status).toBe(403);
    server.close();
  });

  describe('the unreachable list (U36, R98, R99)', () => {
    /** Current on the required competency, so no gap competes with the mark. */
    const CURRENT = [grant(COMP, { expiresAt: daysAhead(200) })];
    const marked = { membershipId: 'm1', emailUnreachableAt: daysAgo(2) };

    it('reports a marked address with no login', async () => {
      mockDbValue = fakeDb({ holders: CURRENT, profiles: [marked] });
      const { server, base } = startApp();
      const body = (await (
        await fetch(`${base}/compliance`, { headers: authHeader(admin) })
      ).json()) as { unreachable: Array<{ userId: string; name: string; membershipId: string }> };
      expect(body.unreachable).toEqual([{ userId: 'u1', name: 'Bo Worker', membershipId: 'm1' }]);
      server.close();
    });

    it('does NOT report a marked address where the person holds a login (R98)', async () => {
      /*
        Reachable means EITHER route works. The sweep serves its notice on the
        person's own record whatever the email did, so somebody who signs in has
        been notified — counting them here would report a failure that did not
        occur. They are still on the working list, which asks the different
        question of whether anyone needs chasing.
      */
      mockDbValue = fakeDb({
        holders: CURRENT,
        profiles: [marked],
        users: [{ id: 'u1', name: 'Bo Worker', passwordHash: 'hash' }],
      });
      const { server, base } = startApp();
      const body = (await (
        await fetch(`${base}/compliance`, { headers: authHeader(admin) })
      ).json()) as { unreachable: unknown[] };
      expect(body.unreachable).toEqual([]);
      server.close();
    });

    it('does not report an unmarked address, login or not', async () => {
      mockDbValue = fakeDb({
        holders: CURRENT,
        profiles: [{ membershipId: 'm1', emailUnreachableAt: null }],
      });
      const { server, base } = startApp();
      const body = (await (
        await fetch(`${base}/compliance`, { headers: authHeader(admin) })
      ).json()) as { unreachable: unknown[] };
      expect(body.unreachable).toEqual([]);
      server.close();
    });

    it('is the only entry, with no competency gap beside it (AE56, R99)', async () => {
      // The other half of R16's overlap: this member is the single item on the
      // working list AND the single entry here, and nothing compliance
      // reporting counts about a competency reaches the working list.
      mockDbValue = fakeDb({ holders: CURRENT, profiles: [marked] });
      const { server, base } = startApp();
      const body = (await (
        await fetch(`${base}/compliance`, { headers: authHeader(admin) })
      ).json()) as {
        expired: unknown[];
        neverHeld: unknown[];
        optionalLapses: unknown[];
        unreachable: unknown[];
      };
      expect(body.expired).toEqual([]);
      expect(body.neverHeld).toEqual([]);
      expect(body.optionalLapses).toEqual([]);
      expect(body.unreachable).toHaveLength(1);
      server.close();
    });
  });
});
