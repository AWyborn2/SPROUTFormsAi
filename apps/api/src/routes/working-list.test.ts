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
  memberships?: unknown[];
  pooledCases?: unknown[];
  overdueDays?: number;
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
      departments: { findMany: vi.fn().mockResolvedValue([]) },
      jobRoles: { findMany: vi.fn().mockResolvedValue([]) },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.locHolders ?? []) },
      membershipDepartments: { findMany: vi.fn().mockResolvedValue([]) },
      membershipRoles: { findMany: vi.fn().mockResolvedValue([]) },
      memberships: { findMany: vi.fn().mockResolvedValue(opts.memberships ?? []) },
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
      expect(['training_request', 'retirement_review', 'overdue_case']).toContain(k);
    }
    server.close();
  });

  it('refuses a non-Admin', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    const res = await fetch(`${base}/working-list`, { headers: authHeader(candidate) });
    expect(res.status).toBe(403);
    server.close();
  });
});
