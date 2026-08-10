import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

const person = { userId: 'u1', orgId: 'org-1', role: 'candidate' as const };
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

function fakeDb(opts: { notices?: unknown[]; competencies?: unknown[]; documentNotices?: unknown[] }) {
  return {
    query: {
      organizations: { findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: 'enterprise' }) },
      sentNotices: { findMany: vi.fn().mockResolvedValue(opts.notices ?? []) },
      competencies: { findMany: vi.fn().mockResolvedValue(opts.competencies ?? []) },
      /*
        The outcome of a replacement the caller supplied (R52), read on the same
        own-scope surface as their expiry notices — a person should not have to
        know which kind of notice they are looking for. Empty by default.
      */
      documentNotices: { findMany: vi.fn().mockResolvedValue(opts.documentNotices ?? []) },
    },
  } as unknown as Db;
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

describe('GET /notices — own-scope delivery route (U21, R98)', () => {
  it('returns the caller’s own notices with the competency named', async () => {
    mockDbValue = fakeDb({
      notices: [
        { id: 'n1', competencyId: 'c1', expiresOn: '2026-09-01', sentAt: new Date('2026-08-06T00:00:00Z') },
      ],
      competencies: [{ id: 'c1', name: 'ATO - Track Dozer' }],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/notices`, { headers: authHeader(person) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ competencyName: string; expiresOn: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ competencyName: 'ATO - Track Dozer', expiresOn: '2026-09-01' });
    server.close();
  });

  it('returns an empty list when the person has no notices', async () => {
    mockDbValue = fakeDb({ notices: [] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/notices`, { headers: authHeader(person) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    server.close();
  });

  it('requires a session', async () => {
    mockDbValue = fakeDb({ notices: [] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/notices`);
    expect(res.status).toBe(401);
    server.close();
  });
});
