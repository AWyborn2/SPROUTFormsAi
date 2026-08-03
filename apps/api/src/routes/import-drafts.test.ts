/**
 * Named import drafts — a half-mapped form that outlives the browser.
 *
 * The wizard autosaves locally, which covers an interruption. These routes
 * cover what a browser copy cannot: a laptop that dies, a form one person
 * starts and another finishes, a mapping parked while the paper document goes
 * through a revision.
 *
 * Two things are worth pinning hard. Saving under a name already used must
 * OVERWRITE, or a reviewer saving "Track Dozer" each afternoon ends up with
 * seven and the list is useless at the point it matters. And a draft carries a
 * whole extracted document, so reading one across an org boundary is not a
 * cosmetic leak.
 */
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
  return { cookie: `fai_session=${sealSession(tenant)}`, 'content-type': 'application/json' };
}

const NOW = new Date('2026-08-03T02:00:00.000Z');

function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    orgId: 'org-1',
    name: 'Track Dozer',
    assetId: 'asset-abc',
    snapshot: { version: 1, fields: [{ id: 'f1' }] },
    savedByUserId: 'u1',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function fakeDb(opts: { findMany?: unknown[]; findFirst?: unknown; inserted?: unknown } = {}) {
  const onConflict = vi.fn();
  const insertValues = vi.fn();
  const deleteWhere = vi.fn();

  const db = {
    query: {
      importDrafts: {
        findMany: vi.fn().mockResolvedValue(opts.findMany ?? []),
        findFirst: vi.fn().mockResolvedValue(opts.findFirst),
      },
      // `recordAudit` looks the actor up to stamp a name on the entry, so every
      // write route here goes through it. Omitting this table made the routes
      // 500 on their audit line rather than on anything they do themselves.
      users: {
        findFirst: vi.fn().mockResolvedValue({ id: 'u1', name: 'A. Admin' }),
      },
    },
    insert: vi.fn((table: unknown) => ({
      /*
        `values()` has to be BOTH awaitable and chainable. The draft upsert
        chains `.onConflictDoUpdate().returning()`, while `recordAudit` — which
        every write here calls — awaits `values()` directly. A fake that
        modelled only the chain made every route 500 on its audit line, which is
        a fake failing rather than a route failing.
      */
      values: (v: unknown) => {
        insertValues(table, v);
        const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
          onConflictDoUpdate: (spec: unknown) => { returning: () => Promise<unknown[]> };
          returning: () => Promise<unknown[]>;
        };
        awaitable.onConflictDoUpdate = (spec: unknown) => {
          onConflict(spec);
          return { returning: () => Promise.resolve([opts.inserted ?? draftRow()]) };
        };
        awaitable.returning = () => Promise.resolve([opts.inserted ?? draftRow()]);
        return awaitable;
      },
    })),
    delete: vi.fn(() => ({
      where: (w: unknown) => {
        deleteWhere(w);
        return Promise.resolve(undefined);
      },
    })),
  } as unknown as Db;

  return { db, insertValues, onConflict, deleteWhere };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('POST /import-drafts', () => {
  it('saves a draft and records who saved it', async () => {
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/import-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          name: 'Track Dozer',
          assetId: 'asset-abc',
          snapshot: { version: 1, fields: [] },
        }),
      });

      expect(res.status).toBe(201);
      expect(f.insertValues).toHaveBeenCalledWith(
        schema.importDrafts,
        expect.objectContaining({ orgId: 'org-1', name: 'Track Dozer', savedByUserId: 'u1' }),
      );
    } finally {
      server.close();
    }
  });

  it('overwrites the draft of the same name rather than making a second', async () => {
    /*
      What "save" means everywhere else. Without the upsert a reviewer saving
      "Track Dozer" each afternoon accumulates seven of them, and the list is
      useless at exactly the point they need to find their work.
    */
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/import-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ name: 'Track Dozer', assetId: 'asset-abc', snapshot: {} }),
      });

      expect(f.onConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          target: [schema.importDrafts.orgId, schema.importDrafts.name],
          set: expect.objectContaining({ assetId: 'asset-abc', savedByUserId: 'u1' }),
        }),
      );
    } finally {
      server.close();
    }
  });

  it('refuses a nameless draft', async () => {
    // A blank name would collide with the next blank one through the unique
    // index, so the failure would arrive as a database error rather than a
    // sentence — and an unnamed draft is unfindable anyway.
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/import-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ name: '   ', assetId: 'asset-abc', snapshot: {} }),
      });

      expect(res.status).toBe(400);
      expect(f.insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('refuses a body with no snapshot', async () => {
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/import-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ name: 'Track Dozer', assetId: 'asset-abc' }),
      });

      expect(res.status).toBe(400);
      expect(f.insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('GET /import-drafts', () => {
  it('lists drafts WITHOUT their snapshots', async () => {
    /*
      A snapshot is an entire extraction plus every placement box — megabytes.
      Sending ten of them to render a list nobody has chosen from yet would make
      opening the list slower than the work it saves.
    */
    mockDbValue = fakeDb({ findMany: [draftRow(), draftRow({ id: 'draft-2', name: 'Pre-start' })] }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/import-drafts`, { headers: authHeader() });

      expect(res.status).toBe(200);
      const rows = (await res.json()) as Record<string, unknown>[];
      expect(rows.map((r) => r.name)).toEqual(['Track Dozer', 'Pre-start']);
      expect(rows.every((r) => !('snapshot' in r))).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('GET /import-drafts/:id', () => {
  it('returns the snapshot, which is what resuming loads', async () => {
    mockDbValue = fakeDb({ findFirst: draftRow() }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/import-drafts/draft-1`, { headers: authHeader() });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { snapshot: { version: number } };
      expect(body.snapshot.version).toBe(1);
    } finally {
      server.close();
    }
  });

  it('404s for a draft belonging to another org', async () => {
    // The org is in the WHERE rather than checked after loading. Without it any
    // org could read another's mapping — and a snapshot is the whole document.
    mockDbValue = fakeDb({ findFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/import-drafts/draft-1`, { headers: authHeader() });

      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('DELETE /import-drafts/:id', () => {
  it('discards a draft', async () => {
    const f = fakeDb({ findFirst: draftRow() });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/import-drafts/draft-1`, {
        method: 'DELETE',
        headers: authHeader(),
      });

      expect(res.status).toBe(204);
      expect(f.deleteWhere).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('will not delete another org’s draft', async () => {
    const f = fakeDb({ findFirst: undefined });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/import-drafts/draft-1`, {
        method: 'DELETE',
        headers: authHeader(),
      });

      expect(res.status).toBe(404);
      expect(f.deleteWhere).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('authentication', () => {
  it('refuses an unauthenticated caller', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/import-drafts`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
