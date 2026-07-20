import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

const tenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
let sealSession: (t: typeof tenant) => string;

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

function authHeader() {
  return { cookie: `fai_session=${sealSession(tenant)}` };
}

function fakeDb(rows: unknown[]) {
  return {
    query: {
      auditLogEntries: {
        findMany: vi.fn().mockResolvedValue(rows),
      },
    },
  } as unknown as Db;
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /audit', () => {
  it('401s with no session cookie', async () => {
    mockDbValue = fakeDb([]);
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/audit`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('503s when the DB is unconfigured', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/audit`, { headers: authHeader() });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('returns rows newest-first, scoped to the caller org', async () => {
    const row = {
      id: 'a1',
      actorName: 'Ash Wyborn',
      action: 'Invited member',
      target: 'tom@x.io',
      category: 'team',
      icon: 'user-plus',
      createdAt: new Date('2026-07-01T00:00:00Z'),
    };
    mockDbValue = fakeDb([row]);

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/audit`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([
        {
          id: 'a1',
          actorName: 'Ash Wyborn',
          action: 'Invited member',
          target: 'tom@x.io',
          category: 'team',
          icon: 'user-plus',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ]);
    } finally {
      server.close();
    }
  });
});
