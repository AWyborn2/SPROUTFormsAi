import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { createApp } = await import('../app.js');
const { sealSession } = await import('../auth/replit-auth.js');
const { hashApiKey } = await import('../auth/api-key.js');

const OWNER = { userId: 'u-owner', orgId: 'org-1', role: 'owner' as const };
const ADMIN = { userId: 'u-admin', orgId: 'org-1', role: 'admin' as const };
const VIEWER = { userId: 'u-viewer', orgId: 'org-1', role: 'viewer' as const };

const EXISTING_KEY = {
  id: 'key-1',
  orgId: 'org-1',
  name: 'Induction agent',
  role: 'reviewer' as const,
  prefix: 'abc123',
  hash: 'stored-hash-value',
  createdByUserId: 'u-owner',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  lastUsedAt: new Date('2026-07-20T00:00:00Z'),
  revokedAt: null as Date | null,
};

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader(tenant: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(tenant)}`, 'content-type': 'application/json' };
}

function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

function fakeDb(opts: { keyFindFirst?: unknown; keyFindMany?: unknown[] } = {}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();

  const db = {
    query: {
      apiKeys: {
        findFirst: vi.fn().mockResolvedValue(opts.keyFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.keyFindMany ?? []),
      },
      // Unset so `hasPermission` falls back to the shipped default matrix.
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      users: { findFirst: vi.fn().mockResolvedValue({ id: 'u-owner', name: 'Ash Wyborn' }) },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        insertValues(table, v);
        return insertResult([
          {
            id: 'key-new',
            createdAt: new Date('2026-07-29T00:00:00Z'),
            lastUsedAt: null,
            revokedAt: null,
            ...v,
          },
        ]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: () => Promise.resolve() };
      },
    })),
  } as unknown as Db;

  return { db, insertValues, updateSet };
}

function auditRows(insertValues: ReturnType<typeof vi.fn>) {
  return insertValues.mock.calls
    .filter(([table]) => table === schema.auditLogEntries)
    .map(([, values]) => values as Record<string, unknown>);
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('POST /api-keys', () => {
  it('returns the plaintext exactly once and stores only its hash', async () => {
    const { db, insertValues } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys`, {
        method: 'POST',
        headers: authHeader(OWNER),
        body: JSON.stringify({ name: 'Induction agent' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { key: string; prefix: string; role: string };
      expect(body.key.startsWith(`fai_${body.prefix}_`)).toBe(true);
      // Reviewer is the documented default: reads and exports, no admin grant.
      expect(body.role).toBe('reviewer');

      const [, stored] = insertValues.mock.calls.find(([table]) => table === schema.apiKeys)!;
      const row = stored as Record<string, unknown>;
      expect(row.hash).toBe(hashApiKey(body.key));
      expect(row.hash).not.toBe(body.key);
      expect(JSON.stringify(row)).not.toContain(body.key);
      expect(row.createdByUserId).toBe(OWNER.userId);
    } finally {
      server.close();
    }
  });

  it('writes a security audit row naming the key', async () => {
    const { db, insertValues } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/api-keys`, {
        method: 'POST',
        headers: authHeader(OWNER),
        body: JSON.stringify({ name: 'Induction agent' }),
      });
      const audits = auditRows(insertValues);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.category).toBe('security');
      expect(audits[0]!.action).toBe('Created API key');
      expect(String(audits[0]!.target)).toContain('Induction agent');
    } finally {
      server.close();
    }
  });

  it('refuses a viewer and writes nothing', async () => {
    const { db, insertValues } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys`, {
        method: 'POST',
        headers: authHeader(VIEWER),
        body: JSON.stringify({ name: 'Sneaky' }),
      });
      expect(res.status).toBe(403);
      expect(insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('refuses an admin minting an owner key', async () => {
    const { db, insertValues } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys`, {
        method: 'POST',
        headers: authHeader(ADMIN),
        body: JSON.stringify({ name: 'Escalation', role: 'owner' }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'role_exceeds_issuer' });
      expect(insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('lets an admin mint a role at or below its own', async () => {
    const { db } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys`, {
        method: 'POST',
        headers: authHeader(ADMIN),
        body: JSON.stringify({ name: 'Reader', role: 'viewer' }),
      });
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });

  it('rejects a candidate key and a nameless key', async () => {
    const { db } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const candidate = await fetch(`${base}/api-keys`, {
        method: 'POST',
        headers: authHeader(OWNER),
        body: JSON.stringify({ name: 'Scoped', role: 'candidate' }),
      });
      expect(candidate.status).toBe(400);

      const nameless = await fetch(`${base}/api-keys`, {
        method: 'POST',
        headers: authHeader(OWNER),
        body: JSON.stringify({ name: '' }),
      });
      expect(nameless.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('401s without a session', async () => {
    const { db } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Anon' }),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });
});

describe('GET /api-keys', () => {
  it('lists keys without their plaintext or hash', async () => {
    const { db } = fakeDb({ keyFindMany: [EXISTING_KEY] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys`, { headers: authHeader(OWNER) });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('abc123');
      expect(body).not.toContain('stored-hash-value');
      expect(JSON.parse(body)).toEqual([
        {
          id: 'key-1',
          name: 'Induction agent',
          role: 'reviewer',
          prefix: 'abc123',
          createdAt: '2026-07-01T00:00:00.000Z',
          lastUsedAt: '2026-07-20T00:00:00.000Z',
          revokedAt: null,
        },
      ]);
    } finally {
      server.close();
    }
  });
});

describe('DELETE /api-keys/:id', () => {
  it('revokes a key in the caller org and audits it', async () => {
    const { db, updateSet, insertValues } = fakeDb({ keyFindFirst: EXISTING_KEY });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys/key-1`, {
        method: 'DELETE',
        headers: authHeader(OWNER),
      });
      expect(res.status).toBe(200);
      expect(updateSet).toHaveBeenCalledWith(schema.apiKeys, { revokedAt: expect.any(Date) });
      const audits = auditRows(insertValues);
      expect(audits[0]!.action).toBe('Revoked API key');
      expect(audits[0]!.category).toBe('security');
    } finally {
      server.close();
    }
  });

  it('404s for a key in another org and writes nothing', async () => {
    // The org filter is in the WHERE clause, so a foreign key simply is not found.
    const { db, updateSet } = fakeDb({ keyFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys/key-elsewhere`, {
        method: 'DELETE',
        headers: authHeader(OWNER),
      });
      expect(res.status).toBe(404);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('is idempotent — revoking an already-revoked key writes nothing further', async () => {
    const revoked = { ...EXISTING_KEY, revokedAt: new Date('2026-07-25T00:00:00Z') };
    const { db, updateSet, insertValues } = fakeDb({ keyFindFirst: revoked });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys/key-1`, {
        method: 'DELETE',
        headers: authHeader(OWNER),
      });
      expect(res.status).toBe(200);
      expect(updateSet).not.toHaveBeenCalled();
      expect(auditRows(insertValues)).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('refuses a viewer', async () => {
    const { db, updateSet } = fakeDb({ keyFindFirst: EXISTING_KEY });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/api-keys/key-1`, {
        method: 'DELETE',
        headers: authHeader(VIEWER),
      });
      expect(res.status).toBe(403);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
