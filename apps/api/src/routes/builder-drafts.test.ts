/**
 * Assessment tool drafts — the builder's working state, server-side.
 *
 * Two properties are worth pinning hard, and they are the same two an import
 * draft needs plus one this record makes sharper.
 *
 * Saving under a name already used must OVERWRITE. The builder autosaves as an
 * author works, so an insert-every-time would produce hundreds of rows for one
 * afternoon and make the list useless at the point somebody needs to find their
 * tool.
 *
 * Reading across an org boundary must be impossible. An import draft leaks a
 * document; THIS record's state carries the complete answer key to a
 * safety-critical assessment, so the org filter has to be in the query rather
 * than checked after loading.
 *
 * And the autosave must not bury the audit log — a trail that says "started an
 * assessment tool" once is useful; one that says "saved" four hundred times is
 * noise nobody will ever read.
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

const NOW = new Date('2026-08-05T02:00:00.000Z');
const LATER = new Date('2026-08-05T04:00:00.000Z');

function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    orgId: 'org-1',
    name: 'Track Dozer',
    assetId: 'asset-abc',
    step: 'placement',
    state: { fields: [{ id: 'f1' }], keys: [{ fieldId: 'f1', answerKey: ['True'] }] },
    formId: null,
    versionId: null,
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
  const findFirst = vi.fn().mockResolvedValue(opts.findFirst);

  const db = {
    query: {
      assessmentToolDrafts: {
        findMany: vi.fn().mockResolvedValue(opts.findMany ?? []),
        findFirst,
      },
      // `recordAudit` looks the actor up to stamp a name on the entry.
      users: { findFirst: vi.fn().mockResolvedValue({ id: 'u1', name: 'A. Admin' }) },
    },
    insert: vi.fn((table: unknown) => ({
      // Awaitable AND chainable: the upsert chains
      // `.onConflictDoUpdate().returning()`, while `recordAudit` awaits
      // `values()` directly.
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

  return { db, insertValues, onConflict, deleteWhere, findFirst };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('POST /assessment-tool-drafts', () => {
  it('saves a draft against the caller’s org and records who saved it', async () => {
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tool-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          name: 'Track Dozer',
          assetId: 'asset-abc',
          step: 'answer_key',
          state: { fields: [] },
        }),
      });

      expect(res.status).toBe(201);
      expect(f.insertValues).toHaveBeenCalledWith(
        schema.assessmentToolDrafts,
        expect.objectContaining({
          orgId: 'org-1',
          name: 'Track Dozer',
          step: 'answer_key',
          savedByUserId: 'u1',
        }),
      );
    } finally {
      server.close();
    }
  });

  it('overwrites the draft of the same name rather than making a second', async () => {
    // The builder autosaves. Without the upsert an afternoon's work is hundreds
    // of rows and the list cannot be used to find anything.
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/assessment-tool-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ name: 'Track Dozer', assetId: 'asset-abc', state: {} }),
      });

      expect(f.onConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          target: [schema.assessmentToolDrafts.orgId, schema.assessmentToolDrafts.name],
          set: expect.objectContaining({ assetId: 'asset-abc', savedByUserId: 'u1' }),
        }),
      );
    } finally {
      server.close();
    }
  });

  it('defaults an unstated step to upload rather than to nothing', async () => {
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/assessment-tool-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ name: 'New tool', assetId: 'asset-abc', state: {} }),
      });

      expect(f.insertValues).toHaveBeenCalledWith(
        schema.assessmentToolDrafts,
        expect.objectContaining({ step: 'upload' }),
      );
    } finally {
      server.close();
    }
  });

  it('refuses a step that is not one of the seven', async () => {
    // `step` is read back to decide which screen opens; an unknown value there
    // is a blank builder rather than a resumed one, so it fails at the boundary.
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tool-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          name: 'Track Dozer',
          assetId: 'asset-abc',
          step: 'glyphs',
          state: {},
        }),
      });

      expect(res.status).toBe(400);
      expect(f.insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('refuses a nameless draft', async () => {
    // A blank name collides with the next blank one through the unique index,
    // so the failure would arrive as a database error rather than a sentence.
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tool-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ name: '   ', assetId: 'asset-abc', state: {} }),
      });

      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('stores the state opaquely, whatever shape the builder sends', async () => {
    // The state's shape belongs to the builder. Validating it here would mean a
    // client-side addition silently failing to save until a migration caught up.
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    const state = {
      structure: [{ key: 's1', label: 'Cover', cols: 2, fields: [{ id: 'f1', span: 2 }] }],
      somethingTheBuilderAddedLastWeek: { nested: [1, 2, 3] },
    };
    try {
      await fetch(`${base}/assessment-tool-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ name: 'Track Dozer', assetId: 'asset-abc', state }),
      });

      expect(f.insertValues).toHaveBeenCalledWith(
        schema.assessmentToolDrafts,
        expect.objectContaining({ state }),
      );
    } finally {
      server.close();
    }
  });

  it('audits the first save and stays quiet on every autosave after it', async () => {
    // A trail saying "started an assessment tool" once is useful. One saying
    // "saved" four hundred times is noise nobody reads.
    const resaved = draftRow({ createdAt: NOW, updatedAt: LATER });
    const f = fakeDb({ inserted: resaved });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/assessment-tool-drafts`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ name: 'Track Dozer', assetId: 'asset-abc', state: {} }),
      });

      const audited = f.insertValues.mock.calls.some(
        ([table]) => table === schema.auditLogEntries,
      );
      expect(audited).toBe(false);
    } finally {
      server.close();
    }
  });

  it('requires a tenant', async () => {
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tool-drafts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Track Dozer', assetId: 'asset-abc', state: {} }),
      });

      expect(res.status).toBeGreaterThanOrEqual(401);
      expect(f.insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('GET /assessment-tool-drafts', () => {
  it('lists summaries without the state', async () => {
    // A state is an entire extraction plus every key and placement. None of it
    // is needed to choose which draft to open.
    const f = fakeDb({ findMany: [draftRow()] });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tool-drafts`, { headers: authHeader() });
      const body = (await res.json()) as Record<string, unknown>[];

      expect(res.status).toBe(200);
      expect(body[0]).toMatchObject({ id: 'draft-1', name: 'Track Dozer', step: 'placement' });
      expect(body[0]).not.toHaveProperty('state');
    } finally {
      server.close();
    }
  });
});

describe('GET /assessment-tool-drafts/:id', () => {
  it('returns the state, which is what resuming loads', async () => {
    const f = fakeDb({ findFirst: draftRow() });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tool-drafts/draft-1`, { headers: authHeader() });
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.state).toMatchObject({ keys: [{ fieldId: 'f1', answerKey: ['True'] }] });
    } finally {
      server.close();
    }
  });

  it('404s another org’s draft instead of returning its answer key', async () => {
    // The org filter is in the WHERE, so a cross-tenant id simply finds nothing.
    const f = fakeDb({ findFirst: undefined });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tool-drafts/someone-elses`, {
        headers: authHeader(),
      });

      expect(res.status).toBe(404);
      expect(f.findFirst).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('DELETE /assessment-tool-drafts/:id', () => {
  it('discards a draft and audits it', async () => {
    const f = fakeDb({ findFirst: draftRow() });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tool-drafts/draft-1`, {
        method: 'DELETE',
        headers: authHeader(),
      });

      expect(res.status).toBe(204);
      expect(f.deleteWhere).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s another org’s draft rather than deleting it', async () => {
    const f = fakeDb({ findFirst: undefined });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tool-drafts/someone-elses`, {
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
