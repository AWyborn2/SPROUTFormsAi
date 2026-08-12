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
/**
 * A candidate's forms matrix is entirely false. They are org members, so
 * `requireTenant` admits them — the permission check is the only thing between
 * them and the answer key riding on a theory question's field.
 */
const CANDIDATE_PERMS = {
  orgId: 'org-1',
  role: 'candidate',
  matrix: { forms: { view: false, create: false, edit: false, delete: false }, submissions: {}, team: {}, billing: {}, audit: {} },
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
  formBrandsFindFirst?: unknown;
  rolePermissionsFindFirst?: unknown;
  insertedTemplate?: unknown;
  insertedVersion?: unknown;
  submissionsCountRows?: unknown[];
  versionsCountRows?: unknown[];
  assessmentCasesCountRows?: unknown[];
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
    formBrands: {
      findFirst: vi.fn().mockResolvedValue(opts.formBrandsFindFirst),
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
      from: vi.fn((table: unknown) => {
        const where = vi.fn(() => {
          if (table === schema.formTemplateVersions) {
            return whereResult(opts.versionsCountRows ?? [{ count: 0 }]);
          }
          if (table === schema.assessmentCases) {
            return whereResult(opts.assessmentCasesCountRows ?? [{ count: 0 }]);
          }
          return whereResult(opts.submissionsCountRows ?? [{ count: 0 }]);
        });
        // The cases count joins through assessmentTools; the join is keyed on
        // the FROM table, so it just hands the same builder back.
        return { where, innerJoin: vi.fn(() => ({ where })) };
      }),
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
    const version = { id: 'v1', templateId: 't1', versionLabel: 'v2', publishedBy: 'u1' };
    mockDbValue = fakeDb({
      formTemplatesFindMany: [template],
      formTemplateVersionsFindMany: [version],
      usersFindMany: [{ id: 'u1', name: 'Dana Builder', email: 'dana@example.com' }],
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
          // The library's owner filter reads the current version's publisher.
          owner: 'Dana Builder',
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

  /*
    This route hands back the version's fields verbatim, and a theory question
    carries its `answerKey` on the field. It used to run on `requireTenant`
    alone, so any org member — including the candidate sitting the assessment —
    could read every correct answer by fetching the template.
  */
  it('403s a candidate rather than handing over the answer key', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: { id: 't1', status: 'published', currentVersionId: 'v1' },
      formTemplateVersionsFindMany: [
        { id: 'v1', versionLabel: 'v1', state: 'published', fields: [{ id: 'q1', answerKey: ['a'] }], createdAt: new Date() },
      ],
      rolePermissionsFindFirst: CANDIDATE_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { headers: authHeader() });
      expect(res.status).toBe(403);
      // Read the body ONCE — it is a stream — then assert on both counts.
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: 'forbidden' });
      expect(body).not.toContain('answerKey');
    } finally {
      server.close();
    }
  });
});

/*
  The three routes below carried no permission check at all until the answer-key
  audit. Grouped together because they are one class of defect, not three: every
  OTHER route in forms.ts gates, so these read as omissions rather than intent.
*/
describe('forms routes fail closed', () => {
  it('403s a candidate listing templates', async () => {
    mockDbValue = fakeDb({ rolePermissionsFindFirst: CANDIDATE_PERMS }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms`, { headers: authHeader() });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('403s a viewer creating a template — view does not imply create', async () => {
    mockDbValue = fakeDb({ rolePermissionsFindFirst: VIEWER_PERMS }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Snuck in', sourceType: 'built_from_scratch', fields: [] }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    } finally {
      server.close();
    }
  });

  it('403s a candidate publishing a template outright', async () => {
    // The create body accepts `publish: true`, so an ungated POST was not just
    // a draft — it put a live form in the org under someone else's name.
    const { db, insertValues } = fakeDb({ rolePermissionsFindFirst: CANDIDATE_PERMS });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Live', sourceType: 'built_from_scratch', fields: [], publish: true }),
      });
      expect(res.status).toBe(403);
      expect(insertValues).not.toHaveBeenCalled();
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

describe('PATCH /forms/:id/voice-input', () => {
  const published = { id: 't1', name: 'Vendor onboarding', status: 'published', currentVersionId: 'v1', updatedAt: new Date('2026-07-01T00:00:00Z') };

  function patch(base: string, body: unknown, headers = authHeader()) {
    return fetch(`${base}/forms/t1/voice-input`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('pins the override and echoes it back', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: published,
      rolePermissionsFindFirst: EDITOR_PERMS,
      usersFindFirst: { id: 'u1', name: 'Ash' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patch(base, { voiceInput: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 't1', voiceInput: false });
      const templateUpdate = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdate?.[1]).toMatchObject({ voiceInput: false });
    } finally {
      server.close();
    }
  });

  it('null returns the form to the workspace default', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: published,
      rolePermissionsFindFirst: EDITOR_PERMS,
      usersFindFirst: { id: 'u1', name: 'Ash' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patch(base, { voiceInput: null });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 't1', voiceInput: null });
      const templateUpdate = updateSet.mock.calls.find(([table]) => table === schema.formTemplates);
      expect(templateUpdate?.[1]).toMatchObject({ voiceInput: null });
    } finally {
      server.close();
    }
  });

  it('403s a role without forms.edit, and writes nothing', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: published,
      rolePermissionsFindFirst: VIEWER_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      expect((await patch(base, { voiceInput: false })).status).toBe(403);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("404s another org's form", async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: undefined,
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      expect((await patch(base, { voiceInput: true })).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('400s a non-boolean override', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: published,
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      expect((await patch(base, { voiceInput: 'sometimes' })).status).toBe(400);
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
      /*
        The audit names WHICH KIND was deleted, now that a published form can
        be. "Deleted form" on its own no longer tells a reader whether
        something live was removed or a half-finished import was tidied away.
      */
      expect(auditInsert?.[1]).toMatchObject({ action: 'Deleted draft form', target: 'Old draft', category: 'forms' });
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

  /*
    STATUS NO LONGER DECIDES THIS, and these two tests used to say it did.

    Refusing anything that was not a draft was stricter than the danger
    warrants and had no way out: a published form could only be archived, and
    an archived form offers only Restore — so a form published once could never
    be removed, and a workspace doing repeated end-to-end runs accumulated test
    forms permanently. What makes a form undeletable is its RECORDS, which the
    two refusals below cover.
  */
  it('DELETES A PUBLISHED FORM THAT HAS NO RECORDS', async () => {
    const { db, deleteWhere } = fakeDb({
      formTemplatesFindFirst: { ...draft, status: 'published' },
      rolePermissionsFindFirst: EDITOR_PERMS,
      usersFindFirst: { id: 'u1', name: 'Ash' },
      submissionsCountRows: [{ count: 0 }],
      assessmentCasesCountRows: [{ count: 0 }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(204);
      expect(deleteWhere.mock.calls.map(([table]) => table)).toContain(schema.formTemplates);
    } finally {
      server.close();
    }
  });

  it('records a PUBLISHED deletion distinctly in the audit log', async () => {
    // "Deleted form" on its own would not tell a reader whether something live
    // was removed or a half-finished import was tidied away.
    const { db, insertValues } = fakeDb({
      formTemplatesFindFirst: { ...draft, name: 'Live form', status: 'published' },
      rolePermissionsFindFirst: EDITOR_PERMS,
      usersFindFirst: { id: 'u1', name: 'Ash' },
      submissionsCountRows: [{ count: 0 }],
      assessmentCasesCountRows: [{ count: 0 }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      const audit = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(audit?.[1]).toMatchObject({ action: 'Deleted form', target: 'Live form' });
    } finally {
      server.close();
    }
  });

  it('deletes an archived form too, which had no exit at all before', async () => {
    const { db, deleteWhere } = fakeDb({
      formTemplatesFindFirst: { ...draft, status: 'archived' },
      rolePermissionsFindFirst: EDITOR_PERMS,
      usersFindFirst: { id: 'u1', name: 'Ash' },
      submissionsCountRows: [{ count: 0 }],
      assessmentCasesCountRows: [{ count: 0 }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(204);
      expect(deleteWhere.mock.calls.map(([table]) => table)).toContain(schema.formTemplates);
    } finally {
      server.close();
    }
  });

  it('409s form_has_assessment_cases — a case is a competency record', async () => {
    /*
      `assessmentTools.templateId` cascades from the template, so deleting it
      would take the tool — and `assessmentCases.toolId` is ON DELETE RESTRICT,
      which would abort the whole statement with a foreign-key error. This
      names the reason instead, and the database still backstops it.
    */
    const { db, deleteWhere } = fakeDb({
      formTemplatesFindFirst: { ...draft, status: 'published' },
      rolePermissionsFindFirst: EDITOR_PERMS,
      submissionsCountRows: [{ count: 0 }],
      assessmentCasesCountRows: [{ count: 2 }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/t1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'form_has_assessment_cases' });
      expect(deleteWhere).not.toHaveBeenCalled();
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

/**
 * Reading and editing ONE version's fields.
 *
 * These exist so geometry can be placed on an already-published form without
 * re-importing it. Re-importing re-extracts, which re-assigns every field id —
 * and an assessment tool's manifest, answer keys and outcome targets are all
 * keyed to those ids. Copying a published version into a draft keeps the ids,
 * so only the placement changes.
 *
 * The load-bearing rule is that a PUBLISHED version is frozen (see the schema
 * comment on `fields`). Submissions pin to a version; rewriting one rewrites
 * what past records render against.
 */
describe('GET /forms/:id/versions/:versionId', () => {
  const TEMPLATE = { id: 'f1', orgId: 'org-1', name: 'Track Dozer', currentVersionId: 'v2' };
  const DRAFT = {
    id: 'v3',
    templateId: 'f1',
    versionLabel: 'v3',
    state: 'draft',
    fields: [{ id: 'ai_1', type: 'text', label: 'Name', required: false, source: 'imported' }],
    container: { kind: 'card' },
    sourcePdfAssetId: 'org-1/dozer.pdf',
  };

  it('serves that version’s own fields, not the current one’s', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: DRAFT,
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/f1/versions/v3`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.id).toBe('v3');
      expect(body.state).toBe('draft');
      expect(body.fields).toHaveLength(1);
      // The editor needs the source PDF to draw against — without it there is
      // nothing to place boxes on.
      expect(body.sourcePdfAssetId).toBe('org-1/dozer.pdf');
    } finally {
      server.close();
    }
  });

  it('404s for a version belonging to another template', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: { ...DRAFT, templateId: 'other-form' },
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/f1/versions/v3`, { headers: authHeader() });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('404s when the template is in another org', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: undefined,
      rolePermissionsFindFirst: EDITOR_PERMS,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/forms/f1/versions/v3`, { headers: authHeader() });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /forms/:id/versions/:versionId', () => {
  const TEMPLATE = { id: 'f1', orgId: 'org-1', name: 'Track Dozer', currentVersionId: 'v2' };
  const FIELDS = [
    {
      id: 'ai_137',
      type: 'checkbox_group',
      label: 'Correct & controlled steering techniques',
      required: false,
      source: 'imported',
      options: ['tick', 'na'],
      geometry: {
        segments: [
          { page: 6, x: 500, y: 620, width: 12, height: 14, pageWidth: 595, pageHeight: 842, optionKey: 'tick' },
        ],
      },
    },
  ];

  function patch(base: string, versionId: string, body: unknown) {
    return fetch(`${base}/forms/f1/versions/${versionId}`, {
      method: 'PATCH',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('saves geometry onto a draft version', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: { id: 'v3', templateId: 'f1', state: 'draft', fields: [] },
      rolePermissionsFindFirst: EDITOR_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patch(base, 'v3', { fields: FIELDS });
      expect(res.status).toBe(200);

      const write = updateSet.mock.calls.find(([t]) => t === schema.formTemplateVersions);
      const saved = write?.[1] as { fields: typeof FIELDS };
      expect(saved.fields[0]!.geometry.segments).toHaveLength(1);
      expect(saved.fields[0]!.geometry.segments[0]!.optionKey).toBe('tick');
    } finally {
      server.close();
    }
  });

  it('refuses to rewrite a PUBLISHED version', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: { id: 'v2', templateId: 'f1', state: 'published', fields: [] },
      rolePermissionsFindFirst: EDITOR_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patch(base, 'v2', { fields: FIELDS });
      // A published version is frozen: submissions pin to it, so rewriting one
      // rewrites what already-signed records render against.
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('version_published');
      expect(updateSet.mock.calls.find(([t]) => t === schema.formTemplateVersions)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('refuses a caller who cannot edit forms', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: { id: 'v3', templateId: 'f1', state: 'draft', fields: [] },
      rolePermissionsFindFirst: VIEWER_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patch(base, 'v3', { fields: FIELDS });
      expect(res.status).toBe(403);
      expect(updateSet.mock.calls.find(([t]) => t === schema.formTemplateVersions)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('404s for a version belonging to another template', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: { id: 'v3', templateId: 'other-form', state: 'draft', fields: [] },
      rolePermissionsFindFirst: EDITOR_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      expect((await patch(base, 'v3', { fields: FIELDS })).status).toBe(404);
      expect(updateSet.mock.calls.find(([t]) => t === schema.formTemplateVersions)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('rejects a body with no fields array', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: { id: 'v3', templateId: 'f1', state: 'draft', fields: [] },
      rolePermissionsFindFirst: EDITOR_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      expect((await patch(base, 'v3', {})).status).toBe(400);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

/**
 * PATCH /forms/:id/brand — which client's brand a form is presented in.
 *
 * The whole reason this is a route rather than another key on the theme body
 * is the org check on the brand id: it is a foreign key the caller supplies,
 * and `on delete set null` makes the column forgiving without making it open.
 */
describe('PATCH /forms/:id/brand', () => {
  const TEMPLATE = { id: 'f1', orgId: 'org-1', name: 'Track Dozer', currentVersionId: 'v2' };

  async function patchBrand(base: string, body: unknown) {
    return fetch(`${base}/forms/f1/brand`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
  }

  const BRAND_ID = '22222222-2222-4222-8222-222222222222';

  it('assigns a brand that belongs to the org', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formBrandsFindFirst: { id: BRAND_ID, name: 'BBM' },
      rolePermissionsFindFirst: EDITOR_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchBrand(base, { brandId: BRAND_ID });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'f1', brandId: BRAND_ID });
      expect(updateSet.mock.calls.find(([t]) => t === schema.formTemplates)?.[1]).toMatchObject({
        brandId: BRAND_ID,
      });
    } finally {
      server.close();
    }
  });

  it('REFUSES A BRAND FROM ANOTHER ORG, and writes nothing', async () => {
    /*
      THE TEST THIS ROUTE EXISTS FOR. The brand lookup is org-scoped, so another
      org's id finds no row. Without this check a caller could point their own
      form at someone else's brand and read that company's client colours and
      logo straight off their own fill page.

      It answers 404, the same as an id that never existed — a distinct status
      would confirm that some other company uses the product.
    */
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formBrandsFindFirst: undefined,
      rolePermissionsFindFirst: EDITOR_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchBrand(base, { brandId: '11111111-1111-4111-8111-111111111111' });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'brand_not_found' });
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('clears the brand on null, without looking one up', async () => {
    // Unassigned returns the form to the org's theme. That is the fallback for
    // a form nobody has assigned, not a claim that the form is ours.
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      rolePermissionsFindFirst: EDITOR_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchBrand(base, { brandId: null });
      expect(res.status).toBe(200);
      expect(updateSet.mock.calls.find(([t]) => t === schema.formTemplates)?.[1]).toMatchObject({
        brandId: null,
      });
    } finally {
      server.close();
    }
  });

  it('404s for a form belonging to another org', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: undefined,
      rolePermissionsFindFirst: EDITOR_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      expect((await patchBrand(base, { brandId: null })).status).toBe(404);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('refuses a Viewer', async () => {
    const { db, updateSet } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      rolePermissionsFindFirst: VIEWER_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      expect((await patchBrand(base, { brandId: null })).status).toBe(403);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('rejects a brandId that is not a uuid', async () => {
    const { db } = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      rolePermissionsFindFirst: EDITOR_PERMS,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      expect((await patchBrand(base, { brandId: 'not-a-uuid' })).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
