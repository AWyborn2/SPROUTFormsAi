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

/** Version create/publish, archive, and restore gate on `forms.edit`; hard delete on `forms.delete`. */
const EDITOR_PERMS = {
  orgId: 'org-1',
  role: 'admin',
  matrix: { forms: { view: true, create: true, edit: true, delete: true }, submissions: {}, team: {}, billing: {}, audit: {} },
};
const VIEWER_PERMS = {
  orgId: 'org-1',
  role: 'viewer',
  matrix: { forms: { view: true, create: false, edit: false, delete: false }, submissions: {}, team: {}, billing: {}, audit: {} },
};

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
  usersFindFirst?: unknown;
  rolePermissionsFindFirst?: unknown;
  insertedTemplate?: unknown;
  insertedVersion?: unknown;
  submissionsCountRows?: unknown[];
  versionsCountRows?: unknown[];
}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();
  const deleteWhere = vi.fn();

  const makeInsert = () =>
    vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        if (table === schema.formTemplates) return insertResult([opts.insertedTemplate]);
        if (table === schema.formTemplateVersions) return insertResult([opts.insertedVersion]);
        return insertResult([]);
      },
    }));
  const makeDelete = () =>
    vi.fn((table: unknown) => ({
      where: vi.fn((cond: unknown) => {
        deleteWhere(table, cond);
        return Promise.resolve(undefined);
      }),
    }));

  const query = {
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
      findFirst: vi.fn().mockResolvedValue(opts.usersFindFirst),
    },
    rolePermissions: {
      findFirst: vi.fn().mockResolvedValue(opts.rolePermissionsFindFirst),
    },
  };

  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = { query, insert: makeInsert(), delete: makeDelete() };
    return fn(tx);
  });

  const db = {
    query,
    insert: makeInsert(),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    })),
    delete: makeDelete(),
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
    transaction,
  } as unknown as Db;

  return { db, insertValues, updateSet, deleteWhere, transaction };
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
      rolePermissionsFindFirst: EDITOR_PERMS,
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
      rolePermissionsFindFirst: EDITOR_PERMS,
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

  it('carries sourcePdfAssetId forward from the previous current version on republish', async () => {
    const template = { id: 't1', status: 'published', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };
    const { db, insertValues } = fakeDb({
      formTemplatesFindFirst: template,
      rolePermissionsFindFirst: EDITOR_PERMS,
      // The previous current version holds the round-trip export handle.
      formTemplateVersionsFindFirst: { id: 'v1', templateId: 't1', sourcePdfAssetId: 'asset-9' },
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
      const versionInsertCall = insertValues.mock.calls.find(([table]) => table === schema.formTemplateVersions);
      expect(versionInsertCall?.[1]).toMatchObject({ sourcePdfAssetId: 'asset-9' });
    } finally {
      server.close();
    }
  });

  it('does not invent a sourcePdfAssetId when the previous version had none', async () => {
    const template = { id: 't1', status: 'published', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };
    const { db, insertValues } = fakeDb({
      formTemplatesFindFirst: template,
      rolePermissionsFindFirst: EDITOR_PERMS,
      formTemplateVersionsFindFirst: { id: 'v1', templateId: 't1', sourcePdfAssetId: null },
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
      const versionInsertCall = insertValues.mock.calls.find(([table]) => table === schema.formTemplateVersions);
      expect(versionInsertCall?.[1]).toMatchObject({ sourcePdfAssetId: null });
    } finally {
      server.close();
    }
  });

  it('404s when the template does not exist in the caller org', async () => {
    mockDbValue = fakeDb({ formTemplatesFindFirst: undefined, rolePermissionsFindFirst: EDITOR_PERMS }).db;
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

  it('403s a role without forms.edit — version create can publish, so both publish doors gate alike', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: { id: 't1', status: 'published', currentVersionId: 'v1' },
      rolePermissionsFindFirst: VIEWER_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fields: [], publish: true }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    } finally {
      server.close();
    }
  });

  it('body sourcePdfAssetId overrides the inherited one — re-extract carries the NEW pdf', async () => {
    const template = { id: 't1', status: 'published', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };
    const { db, insertValues } = fakeDb({
      formTemplatesFindFirst: template,
      rolePermissionsFindFirst: EDITOR_PERMS,
      formTemplateVersionsFindFirst: { id: 'v1', templateId: 't1', sourcePdfAssetId: 'asset-old' },
      insertedVersion: { id: 'v-new', versionLabel: 'v2' },
      versionsCountRows: [{ count: 1 }],
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fields: [], sourcePdfAssetId: 'asset-new' }),
      });
      expect(res.status).toBe(201);
      const versionInsertCall = insertValues.mock.calls.find(([table]) => table === schema.formTemplateVersions);
      expect(versionInsertCall?.[1]).toMatchObject({ sourcePdfAssetId: 'asset-new', state: 'draft' });
    } finally {
      server.close();
    }
  });

  it('inherits the previous current version container when the body sends none', async () => {
    const template = { id: 't1', status: 'published', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };
    const customContainer = { maxWidth: 720, padding: 30, radius: 8, borderWidth: 2, borderColor: '#000', background: '#fff', shadow: 'none' };
    const { db, insertValues } = fakeDb({
      formTemplatesFindFirst: template,
      rolePermissionsFindFirst: EDITOR_PERMS,
      formTemplateVersionsFindFirst: { id: 'v1', templateId: 't1', sourcePdfAssetId: null, container: customContainer },
      insertedVersion: { id: 'v-new', versionLabel: 'v2' },
      versionsCountRows: [{ count: 1 }],
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fields: [] }),
      });
      expect(res.status).toBe(201);
      const versionInsertCall = insertValues.mock.calls.find(([table]) => table === schema.formTemplateVersions);
      expect(versionInsertCall?.[1]).toMatchObject({ container: customContainer });
    } finally {
      server.close();
    }
  });
});

describe('POST /forms/:id/versions/:versionId/publish', () => {
  const template = { id: 't1', name: 'Vendor onboarding', status: 'published', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };

  it('publishes a draft version: state flips, currentVersionId moves, template published', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: template,
      rolePermissionsFindFirst: EDITOR_PERMS,
      formTemplateVersionsFindFirst: { id: 'v2', templateId: 't1', versionLabel: 'v2', state: 'draft' },
      usersFindFirst: { id: 'u1', name: 'Ash' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions/v2/publish`, {
        method: 'POST',
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      const versionUpdate = updateSet.mock.calls.find(([table]) => table === schema.formTemplateVersions);
      expect(versionUpdate?.[1]).toMatchObject({ state: 'published', publishedBy: 'u1' });
      const templateUpdate = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdate?.[1]).toMatchObject({ currentVersionId: 'v2', status: 'published' });
    } finally {
      server.close();
    }
  });

  it('publishing on an archived template restores it to published (restore-on-publish)', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: { ...template, status: 'archived' },
      rolePermissionsFindFirst: EDITOR_PERMS,
      formTemplateVersionsFindFirst: { id: 'v2', templateId: 't1', versionLabel: 'v2', state: 'draft' },
      usersFindFirst: { id: 'u1', name: 'Ash' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions/v2/publish`, {
        method: 'POST',
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      const templateUpdate = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdate?.[1]).toMatchObject({ status: 'published' });
    } finally {
      server.close();
    }
  });

  it('409s when the version is already published', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: template,
      rolePermissionsFindFirst: EDITOR_PERMS,
      formTemplateVersionsFindFirst: { id: 'v1', templateId: 't1', versionLabel: 'v1', state: 'published' },
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions/v1/publish`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'version_already_published' });
    } finally {
      server.close();
    }
  });

  it('404s when the version belongs to another template or does not exist', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: template,
      rolePermissionsFindFirst: EDITOR_PERMS,
      formTemplateVersionsFindFirst: undefined,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions/other/publish`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('403s a role without forms.edit', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: template,
      rolePermissionsFindFirst: VIEWER_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/versions/v2/publish`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('POST /forms/:id/archive and /restore', () => {
  const published = { id: 't1', name: 'Vendor onboarding', status: 'published', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };

  it('archives a published form: status-only flip, currentVersionId untouched', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: published,
      rolePermissionsFindFirst: EDITOR_PERMS,
      usersFindFirst: { id: 'u1', name: 'Ash' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/archive`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(200);
      const templateUpdate = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdate?.[1]).toMatchObject({ status: 'archived' });
      expect(templateUpdate?.[1]).not.toHaveProperty('currentVersionId');
    } finally {
      server.close();
    }
  });

  it('archives a draft form too (a draft with fills is undeletable — archive is its exit)', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: { ...published, status: 'draft' },
      rolePermissionsFindFirst: EDITOR_PERMS,
      usersFindFirst: { id: 'u1', name: 'Ash' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/archive`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(200);
      const templateUpdate = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdate?.[1]).toMatchObject({ status: 'archived' });
    } finally {
      server.close();
    }
  });

  it('409s archiving an already-archived form', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: { ...published, status: 'archived' },
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/archive`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'form_archived' });
    } finally {
      server.close();
    }
  });

  it('restore returns to published when the current version is published', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: { ...published, status: 'archived' },
      rolePermissionsFindFirst: EDITOR_PERMS,
      formTemplateVersionsFindFirst: { id: 'v1', templateId: 't1', state: 'published' },
      usersFindFirst: { id: 'u1', name: 'Ash' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/restore`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(200);
      const templateUpdate = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdate?.[1]).toMatchObject({ status: 'published' });
    } finally {
      server.close();
    }
  });

  it('restore returns to draft when the form was never published', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: { ...published, status: 'archived' },
      rolePermissionsFindFirst: EDITOR_PERMS,
      formTemplateVersionsFindFirst: { id: 'v1', templateId: 't1', state: 'draft' },
      usersFindFirst: { id: 'u1', name: 'Ash' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/restore`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(200);
      const templateUpdate = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdate?.[1]).toMatchObject({ status: 'draft' });
    } finally {
      server.close();
    }
  });

  it('409s restoring a form that is not archived', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: published,
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/restore`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'form_not_archived' });
    } finally {
      server.close();
    }
  });

  it('403s archive for a role without forms.edit', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: published,
      rolePermissionsFindFirst: VIEWER_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1/archive`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('404s for another tenant\'s form id', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: undefined,
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/foreign/archive`, { method: 'POST', headers: authHeader() });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('DELETE /forms/:id', () => {
  const draft = { id: 't1', name: 'Old draft', status: 'draft', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };

  it('deletes a draft with no submissions: 204, delete and audit inside one transaction', async () => {
    const { db, deleteWhere, insertValues, transaction } = fakeDb({
      formTemplatesFindFirst: draft,
      rolePermissionsFindFirst: EDITOR_PERMS,
      usersFindFirst: { id: 'u1', name: 'Ash' },
      submissionsCountRows: [{ count: 0 }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(204);
      expect(transaction).toHaveBeenCalledTimes(1);
      const deletedTables = deleteWhere.mock.calls.map(([table]) => table);
      expect(deletedTables).toContain(schema.formTemplates);
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({ action: 'Deleted form', target: 'Old draft', category: 'forms' });
    } finally {
      server.close();
    }
  });

  it('409s form_has_submissions for a draft with fills — drafts CAN have authed submissions', async () => {
    const { db, deleteWhere } = fakeDb({
      formTemplatesFindFirst: draft,
      rolePermissionsFindFirst: EDITOR_PERMS,
      submissionsCountRows: [{ count: 3 }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'form_has_submissions' });
      expect(deleteWhere).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('409s form_not_draft for a published form', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: { ...draft, status: 'published' },
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'form_not_draft' });
    } finally {
      server.close();
    }
  });

  it('409s form_not_draft for an archived form', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: { ...draft, status: 'archived' },
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(409);
    } finally {
      server.close();
    }
  });

  it('403s a role without forms.delete', async () => {
    const builderPerms = {
      orgId: 'org-1',
      role: 'builder',
      matrix: { forms: { view: true, create: true, edit: true, delete: false }, submissions: {}, team: {}, billing: {}, audit: {} },
    };
    mockDbValue = fakeDb({
      formTemplatesFindFirst: draft,
      rolePermissionsFindFirst: builderPerms,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    } finally {
      server.close();
    }
  });

  it('404s for another tenant\'s or unknown form id', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: undefined,
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/foreign`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('503s when the DB is unconfigured', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });
});
