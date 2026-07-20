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

function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown[]> };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

function fakeDb(opts: {
  competenciesFindFirst?: unknown;
  competenciesFindMany?: unknown[];
  competencyRulesFindFirst?: unknown;
  competencyRulesFindMany?: unknown[];
  formTemplatesFindFirst?: unknown;
  formTemplatesFindMany?: unknown[];
  insertedCompetency?: unknown;
  insertedRule?: unknown;
}) {
  const deleteWhere = vi.fn();
  const updateSet = vi.fn();
  const insertValues = vi.fn();

  const db = {
    query: {
      competencies: {
        findFirst: vi.fn().mockResolvedValue(opts.competenciesFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.competenciesFindMany ?? []),
      },
      competencyRules: {
        findFirst: vi.fn().mockResolvedValue(opts.competencyRulesFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.competencyRulesFindMany ?? []),
      },
      formTemplates: {
        findFirst: vi.fn().mockResolvedValue(opts.formTemplatesFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.formTemplatesFindMany ?? []),
      },
      users: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        if (table === schema.competencyRules) return insertResult([opts.insertedRule]);
        return insertResult([opts.insertedCompetency]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    })),
    delete: vi.fn((table: unknown) => ({
      where: (w: unknown) => {
        deleteWhere(table, w);
        return Promise.resolve(undefined);
      },
    })),
  } as unknown as Db;

  return { db, deleteWhere, updateSet, insertValues };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /competencies', () => {
  it('lists org-scoped competencies', async () => {
    mockDbValue = fakeDb({
      competenciesFindMany: [{ id: 'c1', name: 'First Aid', code: 'HLTAID011', holders: 52 }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([{ id: 'c1', name: 'First Aid', code: 'HLTAID011', holders: 52 }]);
    } finally {
      server.close();
    }
  });
});

describe('POST /competencies', () => {
  it('creates a competency', async () => {
    mockDbValue = fakeDb({ insertedCompetency: { id: 'c-new', name: 'Forklift', code: 'TLI', holders: 0 } }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Forklift', code: 'TLI' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({ id: 'c-new', name: 'Forklift', code: 'TLI', holders: 0 });
    } finally {
      server.close();
    }
  });
});

describe('DELETE /competencies/:id', () => {
  it('404s for a competency outside the caller org', async () => {
    mockDbValue = fakeDb({ competenciesFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/missing`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('GET /competency-rules', () => {
  it('lists rules with joined form and competency names', async () => {
    mockDbValue = fakeDb({
      competencyRulesFindMany: [
        { id: 'r1', templateId: 't1', sectionRef: 'Roof access', competencyId: 'c1', enabled: true },
      ],
      formTemplatesFindMany: [{ id: 't1', name: 'Site inspection' }],
      competenciesFindMany: [{ id: 'c1', name: 'Working at Heights' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-rules`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([
        {
          id: 'r1',
          templateId: 't1',
          form: 'Site inspection',
          sectionRef: 'Roof access',
          competencyId: 'c1',
          competency: 'Working at Heights',
          enabled: true,
        },
      ]);
    } finally {
      server.close();
    }
  });
});

describe('POST /competency-rules', () => {
  it('creates a rule and records an audit entry', async () => {
    const { db, insertValues } = fakeDb({
      formTemplatesFindFirst: { id: 't1', name: 'Site inspection' },
      competenciesFindFirst: { id: 'c1', name: 'Working at Heights' },
      insertedRule: { id: 'r-new', templateId: 't1', sectionRef: 'Roof access', competencyId: 'c1', enabled: true },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-rules`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: 't1', competencyId: 'c1', sectionRef: 'Roof access' }),
      });
      expect(res.status).toBe(201);
      const auditInsert = insertValues.mock.calls.find(([, v]) => (v as { action?: string }).action === 'Added gating rule');
      expect(auditInsert?.[1]).toMatchObject({ target: 'Working at Heights → Roof access' });
    } finally {
      server.close();
    }
  });

  it('400s on a blank sectionRef', async () => {
    mockDbValue = fakeDb({}).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-rules`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: 't1', competencyId: 'c1', sectionRef: '' }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('404s when the template does not belong to the caller org', async () => {
    mockDbValue = fakeDb({ formTemplatesFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-rules`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: 't1', competencyId: 'c1', sectionRef: 'Roof access' }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /competency-rules/:id', () => {
  it('toggles enabled', async () => {
    const { db, updateSet } = fakeDb({
      competencyRulesFindFirst: { id: 'r1', templateId: 't1', sectionRef: 'Roof access', competencyId: 'c1', enabled: true },
      formTemplatesFindFirst: { id: 't1', name: 'Site inspection' },
      competenciesFindFirst: { id: 'c1', name: 'Working at Heights' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-rules/r1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled: boolean };
      expect(body.enabled).toBe(false);
      expect(updateSet).toHaveBeenCalledWith(expect.anything(), { enabled: false });
    } finally {
      server.close();
    }
  });

  it('flips the current value server-side when "enabled" is omitted', async () => {
    const { db, updateSet } = fakeDb({
      competencyRulesFindFirst: { id: 'r1', templateId: 't1', sectionRef: 'Roof access', competencyId: 'c1', enabled: true },
      formTemplatesFindFirst: { id: 't1', name: 'Site inspection' },
      competenciesFindFirst: { id: 'c1', name: 'Working at Heights' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-rules/r1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled: boolean };
      expect(body.enabled).toBe(false);
      expect(updateSet).toHaveBeenCalledWith(expect.anything(), { enabled: false });
    } finally {
      server.close();
    }
  });
});

describe('DELETE /competency-rules/:id', () => {
  it('removes a rule scoped to the caller org', async () => {
    const { db, deleteWhere } = fakeDb({
      competencyRulesFindFirst: { id: 'r1', templateId: 't1', sectionRef: 'Roof access', competencyId: 'c1', enabled: true },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-rules/r1`, { method: 'DELETE', headers: authHeader() });
      expect(res.status).toBe(204);
      expect(deleteWhere).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
