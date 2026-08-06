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

interface Opts {
  requests?: unknown[];
  tools?: unknown[];
  retiredLocations?: unknown[];
  locHolders?: unknown[];
  retiredDepartments?: unknown[];
  deptHolders?: unknown[];
  retiredRoles?: unknown[];
  roleHolders?: unknown[];
  memberships?: unknown[];
  pooledCases?: unknown[];
  overdueDays?: number;
  /** The owed-file source (U34, R18). */
  profiles?: unknown[];
  grants?: unknown[];
  documents?: unknown[];
  competencies?: unknown[];
  users?: unknown[];
}
function fakeDb(opts: Opts) {
  return {
    query: {
      organizations: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'org-1', planTier: 'enterprise', pooledCaseOverdueDays: opts.overdueDays ?? 14 }),
      },
      trainingRequests: { findMany: vi.fn().mockResolvedValue(opts.requests ?? []) },
      assessmentTools: { findMany: vi.fn().mockResolvedValue(opts.tools ?? []) },
      locations: { findMany: vi.fn().mockResolvedValue(opts.retiredLocations ?? []) },
      departments: { findMany: vi.fn().mockResolvedValue(opts.retiredDepartments ?? []) },
      jobRoles: { findMany: vi.fn().mockResolvedValue(opts.retiredRoles ?? []) },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.locHolders ?? []) },
      membershipDepartments: { findMany: vi.fn().mockResolvedValue(opts.deptHolders ?? []) },
      membershipRoles: { findMany: vi.fn().mockResolvedValue(opts.roleHolders ?? []) },
      /*
        BOTH call sites narrow to `status = 'active'` — the retirement review
        (a deactivated over-holder is not a review) and the owed-file source (a
        leaver's missing certificate is not an Admin's to chase). The double
        models that, because a fixture returning every row regardless would let
        either assertion pass against a query that had dropped its filter.
      */
      memberships: {
        findMany: vi
          .fn()
          .mockImplementation(async () =>
            (opts.memberships ?? []).filter((m) => (m as { status?: string }).status === undefined || (m as { status?: string }).status === 'active'),
          ),
      },
      /*
        The owed-file source (U34, R18). Empty by default — an organisation with
        no profiles yet owes nothing, and every existing case in this file runs
        in exactly that state.
      */
      memberProfiles: { findMany: vi.fn().mockResolvedValue(opts.profiles ?? []) },
      competencyHolders: { findMany: vi.fn().mockResolvedValue(opts.grants ?? []) },
      competencyDocuments: { findMany: vi.fn().mockResolvedValue(opts.documents ?? []) },
      competencies: { findMany: vi.fn().mockResolvedValue(opts.competencies ?? []) },
      users: { findMany: vi.fn().mockResolvedValue(opts.users ?? []) },
      assessmentCases: { findMany: vi.fn().mockResolvedValue(opts.pooledCases ?? []) },
    },
  } as unknown as Db;
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

const TOOL = { id: 't1', name: 'Working at Heights' };

describe('GET /working-list (U19, R95)', () => {
  it('surfaces a pending training request', async () => {
    mockDbValue = fakeDb({
      requests: [{ id: 'tr-1', toolId: 't1', state: 'pending', createdAt: daysAgo(2) }],
      tools: [TOOL],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ kind: string; subject: string }>;
    expect(body.map((i) => i.kind)).toContain('training_request');
    server.close();
  });

  it('surfaces a retirement review for a retired value still held', async () => {
    mockDbValue = fakeDb({
      retiredLocations: [{ id: 'loc-x', orgId: 'org-1', name: 'Old Site', status: 'retired' }],
      locHolders: [{ membershipId: 'm1', locationId: 'loc-x' }],
      memberships: [{ id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active' }],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
    const body = (await res.json()) as Array<{ kind: string; subject: string }>;
    expect(body.some((i) => i.kind === 'retirement_review')).toBe(true);
    server.close();
  });

  it('surfaces a retirement review for a retired Department still held', async () => {
    mockDbValue = fakeDb({
      retiredDepartments: [{ id: 'dep-x', orgId: 'org-1', name: 'Old Dept', status: 'retired' }],
      deptHolders: [{ membershipId: 'm1', departmentId: 'dep-x' }],
      memberships: [{ id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active' }],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
    const body = (await res.json()) as Array<{ kind: string; subject: string }>;
    expect(body.some((i) => i.kind === 'retirement_review' && /Department/.test(i.subject))).toBe(true);
    server.close();
  });

  it('surfaces a retirement review for a retired Role still held', async () => {
    mockDbValue = fakeDb({
      retiredRoles: [{ id: 'role-x', orgId: 'org-1', name: 'Old Role', status: 'retired' }],
      roleHolders: [{ membershipId: 'm1', roleId: 'role-x', withdrawnAt: null }],
      memberships: [{ id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active' }],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
    const body = (await res.json()) as Array<{ kind: string; subject: string }>;
    expect(body.some((i) => i.kind === 'retirement_review' && /Role/.test(i.subject))).toBe(true);
    server.close();
  });

  it('excludes a retired value held only by a non-active member', async () => {
    // The member holding the retired Location is not active, so nobody active
    // still holds it → no review item.
    mockDbValue = fakeDb({
      retiredLocations: [{ id: 'loc-x', orgId: 'org-1', name: 'Old Site', status: 'retired' }],
      locHolders: [{ membershipId: 'm1', locationId: 'loc-x' }],
      memberships: [], // the active-membership load returns nobody
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
    const body = (await res.json()) as Array<{ kind: string }>;
    expect(body.some((i) => i.kind === 'retirement_review')).toBe(false);
    server.close();
  });

  it('surfaces a pooled case past the overdue threshold but not one inside it (R63)', async () => {
    mockDbValue = fakeDb({
      overdueDays: 14,
      tools: [TOOL],
      pooledCases: [
        { id: 'old', orgId: 'org-1', toolId: 't1', state: 'open', assessorUserId: null, createdAt: daysAgo(30) },
        { id: 'fresh', orgId: 'org-1', toolId: 't1', state: 'open', assessorUserId: null, createdAt: daysAgo(3) },
      ],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
    const body = (await res.json()) as Array<{ kind: string; id: string }>;
    const overdue = body.filter((i) => i.kind === 'overdue_case');
    expect(overdue.map((i) => i.id)).toEqual(['old']);
    server.close();
  });

  it('puts every present source on one list', async () => {
    mockDbValue = fakeDb({
      requests: [{ id: 'tr-1', toolId: 't1', state: 'pending', createdAt: daysAgo(1) }],
      tools: [TOOL],
      retiredLocations: [{ id: 'loc-x', orgId: 'org-1', name: 'Old Site', status: 'retired' }],
      locHolders: [{ membershipId: 'm1', locationId: 'loc-x' }],
      memberships: [{ id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active' }],
      pooledCases: [{ id: 'old', orgId: 'org-1', toolId: 't1', state: 'open', assessorUserId: null, createdAt: daysAgo(30) }],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
    const kinds = new Set(((await res.json()) as Array<{ kind: string }>).map((i) => i.kind));
    expect(kinds).toEqual(new Set(['training_request', 'retirement_review', 'overdue_case']));
    server.close();
  });

  it('responds with an empty list when no source has anything — absent sources do not break it', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    server.close();
  });

  it('carries no compliance fact — only working-list kinds appear (R95, R101)', async () => {
    mockDbValue = fakeDb({
      requests: [{ id: 'tr-1', toolId: 't1', state: 'pending', createdAt: daysAgo(1) }],
      tools: [TOOL],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
    const kinds = ((await res.json()) as Array<{ kind: string }>).map((i) => i.kind);
    for (const k of kinds) {
      expect(['training_request', 'retirement_review', 'overdue_case', 'owed_file']).toContain(k);
    }
    server.close();
  });

  describe('the owed-file source (U34, R18)', () => {
    const MEMBER = { id: 'm-1', orgId: 'org-1', userId: 'u-1', status: 'active' };
    const USERS = [{ id: 'u-1', name: 'Jane Smith' }];
    const COMPETENCIES = [{ id: 'c-1', orgId: 'org-1', name: 'Track Dozer' }];

    it('lists a profile owing its picture, and stops once one is supplied', async () => {
      mockDbValue = fakeDb({
        memberships: [MEMBER],
        users: USERS,
        profiles: [{ membershipId: 'm-1', profilePictureKey: null, createdAt: daysAgo(3) }],
      });
      const { server, base } = startApp();
      let res = await fetch(`${base}/working-list`, { headers: authHeader(admin) });
      let items = (await res.json()) as Array<{ kind: string; subject: string }>;
      expect(items.filter((i) => i.kind === 'owed_file')).toHaveLength(1);
      expect(items[0]!.subject).toContain('Jane Smith');
      server.close();

      mockDbValue = fakeDb({
        memberships: [MEMBER],
        users: USERS,
        profiles: [{ membershipId: 'm-1', profilePictureKey: 'org-1/upload-x.jpg', createdAt: daysAgo(3) }],
      });
      const two = startApp();
      res = await fetch(`${two.base}/working-list`, { headers: authHeader(admin) });
      items = (await res.json()) as Array<{ kind: string; subject: string }>;
      expect(items.filter((i) => i.kind === 'owed_file')).toHaveLength(0);
      two.server.close();
    });

    it('lists a competency with no held document, and stops once one is attached', async () => {
      const grant = { id: 'h-1', orgId: 'org-1', userId: 'u-1', competencyId: 'c-1', importedAt: null, revokedAt: null, grantedAt: daysAgo(2) };
      mockDbValue = fakeDb({ memberships: [MEMBER], users: USERS, competencies: COMPETENCIES, grants: [grant] });
      const { server, base } = startApp();
      let items = (await (await fetch(`${base}/working-list`, { headers: authHeader(admin) })).json()) as Array<{ kind: string; subject: string }>;
      expect(items.filter((i) => i.kind === 'owed_file')).toHaveLength(1);
      expect(items[0]!.subject).toContain('Track Dozer');
      server.close();

      mockDbValue = fakeDb({
        memberships: [MEMBER],
        users: USERS,
        competencies: COMPETENCIES,
        grants: [grant],
        documents: [{ id: 'd-1', competencyHolderId: 'h-1', state: 'held' }],
      });
      const two = startApp();
      items = (await (await fetch(`${two.base}/working-list`, { headers: authHeader(admin) })).json()) as Array<{ kind: string; subject: string }>;
      expect(items.filter((i) => i.kind === 'owed_file')).toHaveLength(0);
      two.server.close();
    });

    it('owes nothing against a competency a bulk import loaded (AE27, R19)', async () => {
      /*
        The waiver is READ from the grant's import mark, not inferred: a customer
        bringing in a decade of tickets has no scans of them. A competency
        recorded on the same person afterwards owes its own, so the concession
        never becomes the standard — the next case asserts that half.
      */
      mockDbValue = fakeDb({
        memberships: [MEMBER],
        users: USERS,
        competencies: COMPETENCIES,
        grants: [{ id: 'h-1', orgId: 'org-1', userId: 'u-1', competencyId: 'c-1', importedAt: daysAgo(10), revokedAt: null, grantedAt: daysAgo(400) }],
      });
      const { server, base } = startApp();
      const items = (await (await fetch(`${base}/working-list`, { headers: authHeader(admin) })).json()) as Array<{ kind: string }>;
      expect(items.filter((i) => i.kind === 'owed_file')).toHaveLength(0);
      server.close();
    });

    it('owes a certificate against one recorded on that same person afterwards (R19)', async () => {
      mockDbValue = fakeDb({
        memberships: [MEMBER],
        users: USERS,
        competencies: COMPETENCIES,
        grants: [
          { id: 'h-imported', orgId: 'org-1', userId: 'u-1', competencyId: 'c-1', importedAt: daysAgo(10), revokedAt: null, grantedAt: daysAgo(400) },
          { id: 'h-later', orgId: 'org-1', userId: 'u-1', competencyId: 'c-1', importedAt: null, revokedAt: null, grantedAt: daysAgo(1) },
        ],
      });
      const { server, base } = startApp();
      const items = (await (await fetch(`${base}/working-list`, { headers: authHeader(admin) })).json()) as Array<{ kind: string; id: string }>;
      const owed = items.filter((i) => i.kind === 'owed_file');
      expect(owed).toHaveLength(1);
      expect(owed[0]!.id).toBe('h-later');
      server.close();
    });

    it('does not chase a file for somebody who is no longer an active member', async () => {
      mockDbValue = fakeDb({
        memberships: [{ ...MEMBER, status: 'suspended' }],
        users: USERS,
        competencies: COMPETENCIES,
        grants: [{ id: 'h-1', orgId: 'org-1', userId: 'u-1', competencyId: 'c-1', importedAt: null, revokedAt: null, grantedAt: daysAgo(2) }],
      });
      const { server, base } = startApp();
      const items = (await (await fetch(`${base}/working-list`, { headers: authHeader(admin) })).json()) as Array<{ kind: string }>;
      expect(items.filter((i) => i.kind === 'owed_file')).toHaveLength(0);
      server.close();
    });
  });

  it('refuses a non-Admin', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(candidate) });
    expect(res.status).toBe(403);
    server.close();
  });
});
