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

/** `.values(...)` result that is awaitable and exposes `.returning()`. */
function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

/** `.where(...)` result awaitable directly (a plain select) or via `.groupBy(...)`. */
function whereResult(directRows: unknown[], groupedRows: unknown[] = directRows) {
  const awaitable = Promise.resolve(directRows) as Promise<unknown[]> & {
    groupBy: () => Promise<unknown[]>;
  };
  awaitable.groupBy = vi.fn().mockResolvedValue(groupedRows);
  return awaitable;
}

function fakeDb(opts: {
  formTemplatesFindFirst?: unknown;
  formTemplatesFindMany?: unknown[];
  formTemplateVersionsFindFirst?: unknown;
  formTemplateVersionsFindMany?: unknown[];
  usersFindMany?: unknown[];
  insertedTemplate?: unknown;
  insertedVersion?: unknown;
  submissionsCountRows?: unknown[];
  versionsCountRows?: unknown[];
}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();

  const db = {
    query: {
      formTemplates: {
        findFirst: vi.fn().mockResolvedValue(opts.formTemplatesFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.formTemplatesFindMany ?? []),
      },
      formTemplateVersions: {
        findFirst: vi.fn().mockResolvedValue(opts.formTemplateVersionsFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.formTemplateVersionsFindMany ?? []),
      },
      users: {
        findMany: vi.fn().mockResolvedValue(opts.usersFindMany ?? []),
      },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        if (table === schema.formTemplates) return insertResult([opts.insertedTemplate]);
        if (table === schema.formTemplateVersions) return insertResult([opts.insertedVersion]);
        return insertResult([]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === schema.formTemplateVersions) {
            return whereResult(opts.versionsCountRows ?? [{ count: 0 }]);
          }
          return whereResult(opts.submissionsCountRows ?? [{ count: 0 }]);
        }),
      })),
    })),
  } as unknown as Db;

  return { db, insertValues, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /forms', () => {
  it('503s when the DB is unconfigured', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms`, { headers: authHeader() });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('401s with no session cookie', async () => {
    mockDbValue = fakeDb({}).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('lists templates scoped to the caller org, with joined version label and submission count', async () => {
    const template = {
      id: 't1',
      orgId: 'org-1',
      name: 'Vendor onboarding',
      dept: 'Ops',
      sourceType: 'built_from_scratch',
      status: 'published',
      currentVersionId: 'v1',
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    };
    const version = { id: 'v1', templateId: 't1', versionLabel: 'v2' };
    mockDbValue = fakeDb({
      formTemplatesFindMany: [template],
      formTemplateVersionsFindMany: [version],
      submissionsCountRows: [{ templateId: 't1', count: 4 }],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([
        {
          id: 't1',
          name: 'Vendor onboarding',
          dept: 'Ops',
          sourceType: 'built_from_scratch',
          status: 'published',
          currentVersionId: 'v1',
          currentVersionLabel: 'v2',
          submissionsCount: 4,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      ]);
    } finally {
      server.close();
    }
  });
});

describe('POST /forms', () => {
  it('creates a template and its first draft version', async () => {
    const now = new Date();
    mockDbValue = fakeDb({
      insertedTemplate: { id: 't-new', name: 'New form', dept: null, sourceType: 'built_from_scratch' },
      insertedVersion: { id: 'v-new', versionLabel: 'v1' },
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New form', sourceType: 'built_from_scratch', fields: [] }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        id: 't-new',
        status: 'draft',
        currentVersionId: 'v-new',
        currentVersionLabel: 'v1',
        submissionsCount: 0,
      });
      void now;
    } finally {
      server.close();
    }
  });

  it('persists sourcePdfAssetId on the created version row', async () => {
    const { db, insertValues } = fakeDb({
      insertedTemplate: { id: 't-new', name: 'Site checklist', dept: null, sourceType: 'pdf_import' },
      insertedVersion: { id: 'v-new', versionLabel: 'v1' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Site checklist',
          sourceType: 'pdf_import',
          fields: [],
          sourcePdfAssetId: 'asset-abc123',
          publish: true,
        }),
      });
      expect(res.status).toBe(201);
      const versionInsertCall = insertValues.mock.calls.find(([table]) => table === schema.formTemplateVersions);
      expect(versionInsertCall?.[1]).toMatchObject({ sourcePdfAssetId: 'asset-abc123', state: 'published' });
    } finally {
      server.close();
    }
  });

  it('400s on an invalid body', async () => {
    mockDbValue = fakeDb({}).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ sourceType: 'built_from_scratch', fields: [] }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe('GET /forms/:id', () => {
  it('404s for a nonexistent or cross-tenant id', async () => {
    mockDbValue = fakeDb({ formTemplatesFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/missing`, { headers: authHeader() });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('returns the template detail with resolved current-version fields and publisher names', async () => {
    const template = {
      id: 't1',
      name: 'Vendor onboarding',
      dept: 'Ops',
      sourceType: 'built_from_scratch',
      status: 'published',
      currentVersionId: 'v2',
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    };
    const versions = [
      {
        id: 'v2',
        versionLabel: 'v2',
        state: 'published',
        fields: [{ id: 'f1' }],
        container: { maxWidth: 600 },
        publishedAt: new Date('2026-07-01T00:00:00Z'),
        publishedBy: 'u1',
        createdAt: new Date('2026-07-01T00:00:00Z'),
      },
      {
        id: 'v1',
        versionLabel: 'v1',
        state: 'published',
        fields: [],
        container: { maxWidth: 600 },
        publishedAt: new Date('2026-06-01T00:00:00Z'),
        publishedBy: 'u1',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ];
    mockDbValue = fakeDb({
      formTemplatesFindFirst: template,
      formTemplateVersionsFindMany: versions,
      usersFindMany: [{ id: 'u1', name: 'Ash Wyborn' }],
      submissionsCountRows: [{ count: 7 }],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        currentVersionLabel: string;
        fields: unknown[];
        submissionsCount: number;
        versions: unknown[];
      };
      expect(body.currentVersionLabel).toBe('v2');
      expect(body.fields).toEqual([{ id: 'f1' }]);
      expect(body.submissionsCount).toBe(7);
      expect(body.versions).toHaveLength(2);
      expect(body.versions[0]).toMatchObject({ id: 'v2', publishedByName: 'Ash Wyborn' });
    } finally {
      server.close();
    }
  });
});

describe('POST /forms/:id/versions', () => {
  it('forks a new draft version without moving currentVersionId off the still-live published one', async () => {
    const template = { id: 't1', status: 'published', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: template,
      insertedVersion: { id: 'v-new', versionLabel: 'v2' },
      versionsCountRows: [{ count: 1 }],
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fields: [{ id: 'f2' }] }),
      });
      expect(res.status).toBe(201);
      const templateUpdateCall = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdateCall?.[1]).not.toHaveProperty('currentVersionId');
      expect(templateUpdateCall?.[1]).not.toHaveProperty('status');
    } finally {
      server.close();
    }
  });

  it('publishing a forked version moves currentVersionId to it and marks the template published', async () => {
    const template = { id: 't1', status: 'published', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: template,
      insertedVersion: { id: 'v-new', versionLabel: 'v2' },
      versionsCountRows: [{ count: 1 }],
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fields: [{ id: 'f2' }], publish: true }),
      });
      expect(res.status).toBe(201);
      const templateUpdateCall = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdateCall?.[1]).toMatchObject({ currentVersionId: 'v-new', status: 'published' });
    } finally {
      server.close();
    }
  });

  it('404s when the template does not exist in the caller org', async () => {
    mockDbValue = fakeDb({ formTemplatesFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/missing/versions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fields: [] }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
