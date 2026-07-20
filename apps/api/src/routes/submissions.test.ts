import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

const tenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
const viewerTenant = { userId: 'u2', orgId: 'org-1', role: 'viewer' as const };
let sealSession: (t: typeof tenant | typeof viewerTenant) => string;

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

function authHeader(t: typeof tenant | typeof viewerTenant = tenant) {
  return { cookie: `fai_session=${sealSession(t)}` };
}

/**
 * The matrix has no `submissions.approve` action, so the PATCH route gates on
 * `submissions.delete` — the only mutating submissions action in the default
 * matrix (true for owner/admin, false for everyone else).
 */
const APPROVER_PERMS = {
  orgId: 'org-1',
  role: 'admin',
  matrix: { forms: {}, submissions: { view: true, export: true, delete: true }, team: {}, billing: {}, audit: {} },
};
const VIEWER_PERMS = {
  orgId: 'org-1',
  role: 'viewer',
  matrix: { forms: {}, submissions: { view: true, export: false, delete: false }, team: {}, billing: {}, audit: {} },
};

function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

function fakeDb(opts: {
  formTemplatesFindFirst?: unknown;
  formTemplatesFindMany?: unknown[];
  formTemplateVersionsFindFirst?: unknown;
  submissionsFindFirst?: unknown;
  submissionsFindMany?: unknown[];
  rolePermissionsFindFirst?: unknown;
  usersFindFirst?: unknown;
  insertedSubmission?: unknown;
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
      },
      submissions: {
        findFirst: vi.fn().mockResolvedValue(opts.submissionsFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.submissionsFindMany ?? []),
      },
      rolePermissions: {
        findFirst: vi.fn().mockResolvedValue(opts.rolePermissionsFindFirst),
      },
      users: {
        findFirst: vi.fn().mockResolvedValue(opts.usersFindFirst),
      },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        if (table === schema.submissions) return insertResult([opts.insertedSubmission]);
        return insertResult([]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    })),
  } as unknown as Db;

  return { db, insertValues, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /submissions', () => {
  it('401s with no session cookie', async () => {
    mockDbValue = fakeDb({}).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('lists submissions scoped to the caller org with the joined form name', async () => {
    const row = {
      id: 's1',
      orgId: 'org-1',
      templateId: 't1',
      submitterName: 'Tom Reyes',
      submitterEmail: 'tom@contractor.io',
      status: 'submitted',
      flag: '',
      createdAt: new Date('2026-07-01T00:00:00Z'),
    };
    mockDbValue = fakeDb({
      submissionsFindMany: [row],
      formTemplatesFindMany: [{ id: 't1', name: 'Vendor onboarding' }],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([
        {
          id: 's1',
          formId: 't1',
          form: 'Vendor onboarding',
          who: 'Tom Reyes',
          email: 'tom@contractor.io',
          status: 'submitted',
          flag: '',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ]);
    } finally {
      server.close();
    }
  });
});

describe('GET /submissions/:id', () => {
  it('404s for a nonexistent or cross-tenant id', async () => {
    mockDbValue = fakeDb({ submissionsFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions/missing`, { headers: authHeader() });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('returns the submission detail including captured values', async () => {
    const row = {
      id: 's1',
      templateId: 't1',
      templateVersionId: 'v1',
      submitterName: 'Tom Reyes',
      submitterEmail: 'tom@contractor.io',
      values: { abn: '12 345 678 901' },
      status: 'submitted',
      flag: '',
      createdAt: new Date('2026-07-01T00:00:00Z'),
    };
    mockDbValue = fakeDb({
      submissionsFindFirst: row,
      formTemplatesFindFirst: { id: 't1', name: 'Vendor onboarding' },
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions/s1`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        id: 's1',
        form: 'Vendor onboarding',
        templateVersionId: 'v1',
        values: { abn: '12 345 678 901' },
        // No pinned version row resolvable → export handles are explicit empties.
        sourcePdfAssetId: null,
        fields: [],
      });
    } finally {
      server.close();
    }
  });

  it('exposes the pinned version’s sourcePdfAssetId and fields (round-trip export handles)', async () => {
    const row = {
      id: 's1',
      templateId: 't1',
      templateVersionId: 'v1',
      submitterName: 'Tom Reyes',
      submitterEmail: 'tom@contractor.io',
      values: { abn: '12 345 678 901' },
      status: 'submitted',
      flag: '',
      createdAt: new Date('2026-07-01T00:00:00Z'),
    };
    const positionedField = {
      id: 'abn',
      type: 'text',
      label: 'ABN',
      required: true,
      source: 'imported',
      sourcePosition: { page: 0, x: 72, y: 640, width: 180, height: 18, pageWidth: 595, pageHeight: 842 },
    };
    mockDbValue = fakeDb({
      submissionsFindFirst: row,
      formTemplatesFindFirst: { id: 't1', name: 'Vendor onboarding' },
      formTemplateVersionsFindFirst: {
        id: 'v1',
        templateId: 't1',
        sourcePdfAssetId: 'asset-9',
        fields: [positionedField],
      },
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions/s1`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        id: 's1',
        templateVersionId: 'v1',
        sourcePdfAssetId: 'asset-9',
        fields: [positionedField],
      });
    } finally {
      server.close();
    }
  });
});

describe('POST /submissions', () => {
  it('records a submission pinned to the template’s current version', async () => {
    const template = { id: 't1', name: 'Vendor onboarding', currentVersionId: 'v-current' };
    const { db, insertValues } = fakeDb({
      formTemplatesFindFirst: template,
      insertedSubmission: {
        id: 's-new',
        templateId: 't1',
        submitterName: 'Tom Reyes',
        submitterEmail: 'tom@contractor.io',
        status: 'submitted',
        flag: '',
        createdAt: new Date('2026-07-01T00:00:00Z'),
      },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({
          templateId: 't1',
          submitterName: 'Tom Reyes',
          submitterEmail: 'tom@contractor.io',
          values: { abn: '12 345 678 901' },
        }),
      });
      expect(res.status).toBe(201);
      const submissionInsert = insertValues.mock.calls.find(([table]) => table === schema.submissions);
      expect(submissionInsert?.[1]).toMatchObject({ templateVersionId: 'v-current', orgId: 'org-1' });
    } finally {
      server.close();
    }
  });

  it('404s when the template does not exist in the caller org', async () => {
    mockDbValue = fakeDb({ formTemplatesFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: '00000000-0000-0000-0000-000000000000', values: {} }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('422s when the template has no published version yet', async () => {
    mockDbValue = fakeDb({
      formTemplatesFindFirst: { id: 't1', name: 'Draft form', currentVersionId: null },
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: 't1', values: {} }),
      });
      expect(res.status).toBe(422);
    } finally {
      server.close();
    }
  });

  it('400s (and writes nothing) on malformed values — nested objects are not SubmissionValues', async () => {
    const { db, insertValues } = fakeDb({
      formTemplatesFindFirst: { id: 't1', name: 'Vendor onboarding', currentVersionId: 'v-current' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: 't1', values: { abn: { nested: 'object' } } }),
      });
      expect(res.status).toBe(400);
      expect(insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('400s on an invalid body (missing values)', async () => {
    mockDbValue = fakeDb({}).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: 't1' }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /submissions/:id', () => {
  const row = {
    id: 's1',
    orgId: 'org-1',
    templateId: 't1',
    submitterName: 'Tom Reyes',
    submitterEmail: 'tom@contractor.io',
    status: 'submitted',
    flag: '',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };

  it('approves a submission for an authorized role, updating the row and recording an audit entry', async () => {
    const { db, updateSet, insertValues } = fakeDb({
      rolePermissionsFindFirst: APPROVER_PERMS,
      submissionsFindFirst: row,
      formTemplatesFindFirst: { id: 't1', name: 'Vendor onboarding' },
      usersFindFirst: { id: 'u1', name: 'Ash Wyborn' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions/s1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id: 's1', form: 'Vendor onboarding', status: 'approved' });

      const submissionUpdate = updateSet.mock.calls.find(([table]) => table === schema.submissions);
      expect(submissionUpdate?.[1]).toEqual({ status: 'approved' });

      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({
        action: 'Approved submission',
        category: 'submissions',
        icon: 'check-circle-2',
      });
    } finally {
      server.close();
    }
  });

  it('rejects a submission and records the reject audit entry', async () => {
    const { db, updateSet, insertValues } = fakeDb({
      rolePermissionsFindFirst: APPROVER_PERMS,
      submissionsFindFirst: row,
      formTemplatesFindFirst: { id: 't1', name: 'Vendor onboarding' },
      usersFindFirst: { id: 'u1', name: 'Ash Wyborn' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions/s1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id: 's1', status: 'rejected' });

      const submissionUpdate = updateSet.mock.calls.find(([table]) => table === schema.submissions);
      expect(submissionUpdate?.[1]).toEqual({ status: 'rejected' });

      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({
        action: 'Rejected submission',
        category: 'submissions',
        icon: 'x-circle',
      });
    } finally {
      server.close();
    }
  });

  it('403s (and writes nothing) for a role without submissions.delete', async () => {
    const { db, updateSet, insertValues } = fakeDb({
      rolePermissionsFindFirst: VIEWER_PERMS,
      submissionsFindFirst: row,
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions/s1`, {
        method: 'PATCH',
        headers: { ...authHeader(viewerTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      expect(res.status).toBe(403);
      expect(updateSet).not.toHaveBeenCalled();
      expect(insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('400s on a status outside approved/rejected', async () => {
    mockDbValue = fakeDb({ rolePermissionsFindFirst: APPROVER_PERMS, submissionsFindFirst: row }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions/s1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('404s for a nonexistent or cross-tenant id', async () => {
    mockDbValue = fakeDb({ rolePermissionsFindFirst: APPROVER_PERMS, submissionsFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/submissions/missing`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
