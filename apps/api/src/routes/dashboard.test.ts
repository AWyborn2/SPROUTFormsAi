import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

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

/**
 * Collects the bound parameter values out of a drizzle SQL condition tree
 * (`and(eq(...), inArray(...))` etc.). Lets the tests assert org-scoping and
 * the exact status set behind each count without coupling to SQL text.
 */
function boundParams(cond: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const rec = node as { queryChunks?: unknown[]; value?: unknown; constructor?: { name?: string } };
    if (Array.isArray(rec.queryChunks)) {
      rec.queryChunks.forEach(walk);
      return;
    }
    if (rec.constructor?.name === 'Param' && 'value' in rec) {
      if (Array.isArray(rec.value)) out.push(...(rec.value as unknown[]));
      else out.push(rec.value);
    }
  };
  walk(cond);
  return out;
}

function fakeDb(opts: {
  activeForms?: number;
  submissionsTotal?: number;
  pendingReview?: number;
  auditRows?: unknown[];
}) {
  const whereCalls: Array<{ table: unknown; params: unknown[] }> = [];
  const auditFindMany = vi.fn().mockResolvedValue(opts.auditRows ?? []);

  const db = {
    query: {
      auditLogEntries: {
        findMany: auditFindMany,
      },
    },
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((cond: unknown) => {
          const params = boundParams(cond);
          whereCalls.push({ table, params });
          if (table === schema.formTemplates) {
            return Promise.resolve([{ count: opts.activeForms ?? 0 }]);
          }
          // submissions: the pending-review count carries status params on
          // top of the orgId; the total count is orgId-only.
          const isPendingQuery = params.length > 1;
          return Promise.resolve([
            { count: isPendingQuery ? (opts.pendingReview ?? 0) : (opts.submissionsTotal ?? 0) },
          ]);
        }),
      })),
    })),
  } as unknown as Db;

  return { db, whereCalls, auditFindMany };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /dashboard', () => {
  it('401s with no session cookie', async () => {
    mockDbValue = fakeDb({}).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/dashboard`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('503s when the DB is unconfigured', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/dashboard`, { headers: authHeader() });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('returns org-scoped counts and recent audit activity', async () => {
    const auditRow = {
      id: 'a1',
      actorName: 'Ash Wyborn',
      action: 'Published form',
      target: 'Vendor onboarding',
      category: 'forms',
      icon: 'rocket',
      createdAt: new Date('2026-07-01T00:00:00Z'),
    };
    const { db, whereCalls, auditFindMany } = fakeDb({
      activeForms: 4,
      submissionsTotal: 527,
      pendingReview: 3,
      auditRows: [auditRow],
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/dashboard`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        activeForms: 4,
        submissionsTotal: 527,
        pendingReview: 3,
        recentActivity: [
          {
            id: 'a1',
            actorName: 'Ash Wyborn',
            action: 'Published form',
            target: 'Vendor onboarding',
            category: 'forms',
            icon: 'rocket',
            createdAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      });

      // Org-scoping: every count query binds the caller's orgId — a
      // second org's rows can never satisfy these conditions.
      expect(whereCalls).toHaveLength(3);
      for (const call of whereCalls) {
        expect(call.params).toContain('org-1');
        expect(call.params).not.toContain('org-2');
      }

      // Recent activity is org-scoped and capped at 8 rows, newest first.
      expect(auditFindMany).toHaveBeenCalledTimes(1);
      const findManyArgs = auditFindMany.mock.calls[0]?.[0] as { where?: unknown; limit?: number };
      expect(findManyArgs.limit).toBe(8);
      expect(boundParams(findManyArgs.where)).toContain('org-1');
    } finally {
      server.close();
    }
  });

  it('counts only published templates as active forms', async () => {
    const { db, whereCalls } = fakeDb({ activeForms: 2 });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/dashboard`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const formsCall = whereCalls.find((c) => c.table === schema.formTemplates);
      expect(formsCall?.params).toEqual(['org-1', 'published']);
    } finally {
      server.close();
    }
  });

  it('counts exactly submitted/review/pending as pending review — decided statuses excluded', async () => {
    const { db, whereCalls } = fakeDb({ pendingReview: 3 });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/dashboard`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const pendingCall = whereCalls.find(
        (c) => c.table === schema.submissions && c.params.length > 1,
      );
      expect(pendingCall?.params).toEqual(['org-1', 'submitted', 'review', 'pending']);
    } finally {
      server.close();
    }
  });

  it('returns zeros and an empty activity list for an empty org', async () => {
    mockDbValue = fakeDb({}).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/dashboard`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        activeForms: 0,
        submissionsTotal: 0,
        pendingReview: 0,
        recentActivity: [],
      });
    } finally {
      server.close();
    }
  });
});
