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
  competencyHoldersFindFirst?: unknown;
  competencyHoldersFindMany?: unknown[];
  membershipsFindFirst?: unknown;
  /** Every route is gated by requirePlanFeature('competencyGating'). */
  planTier?: string;
}) {
  const deleteWhere = vi.fn();
  const updateSet = vi.fn();
  const insertValues = vi.fn();

  const db = {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: opts.planTier ?? 'enterprise' }),
      },
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
      competencyHolders: {
        findFirst: vi.fn().mockResolvedValue(opts.competencyHoldersFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.competencyHoldersFindMany ?? []),
      },
      memberships: {
        findFirst: vi.fn().mockResolvedValue(opts.membershipsFindFirst),
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
  it('403s with feature_not_available when the org plan lacks competencyGating', async () => {
    mockDbValue = fakeDb({ planTier: 'business' }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies`, { headers: authHeader() });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; feature: string };
      expect(body.error).toBe('feature_not_available');
      expect(body.feature).toBe('competencyGating');
    } finally {
      server.close();
    }
  });

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

/**
 * `competencies.holders` is a denormalised count that predates the join table.
 * These pin the invariant that makes it trustworthy: it is always RECOMPUTED
 * from the join, never incremented, so an idempotent grant or a cascade-deleted
 * user cannot drift it (U3, R26/R28).
 */
/** Real UUIDs — the grant route validates userId as one. */
const HOLDER_ID = '00000000-0000-4000-8000-000000000002';
const OUTSIDER_ID = '00000000-0000-4000-8000-0000000000ff';

describe('competency holders', () => {
  const competency = { id: 'c1', orgId: 'org-1', name: 'Track Dozer', code: 'Q34666893', holders: 0 };

  it('grants a competency and recomputes the count from the join', async () => {
    const f = fakeDb({
      competenciesFindFirst: competency,
      membershipsFindFirst: { id: 'm1', userId: HOLDER_ID, orgId: 'org-1' },
      competencyHoldersFindFirst: undefined,
      competencyHoldersFindMany: [{ id: 'h1' }],
    });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: HOLDER_ID }),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ competencyId: 'c1', holders: 1 });
      expect(f.insertValues).toHaveBeenCalledWith(
        schema.competencyHolders,
        expect.objectContaining({ competencyId: 'c1', userId: HOLDER_ID, orgId: 'org-1' }),
      );
      expect(f.updateSet).toHaveBeenCalledWith(schema.competencies, { holders: 1 });
    } finally {
      server.close();
    }
  });

  it('is idempotent — re-granting inserts nothing and still reports the count', async () => {
    const f = fakeDb({
      competenciesFindFirst: competency,
      membershipsFindFirst: { id: 'm1', userId: HOLDER_ID, orgId: 'org-1' },
      competencyHoldersFindFirst: { id: 'h1', competencyId: 'c1', userId: HOLDER_ID },
      competencyHoldersFindMany: [{ id: 'h1' }],
    });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: HOLDER_ID }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ competencyId: 'c1', holders: 1 });
      expect(f.insertValues).not.toHaveBeenCalledWith(schema.competencyHolders, expect.anything());
    } finally {
      server.close();
    }
  });

  it('refuses to record a grant against someone outside the org', async () => {
    mockDbValue = fakeDb({
      competenciesFindFirst: competency,
      membershipsFindFirst: undefined,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: OUTSIDER_ID }),
      });

      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('user_not_in_org');
    } finally {
      server.close();
    }
  });

  it('404s for a competency belonging to another org', async () => {
    mockDbValue = fakeDb({ competenciesFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/other/holders`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: HOLDER_ID }),
      });

      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('recomputes the count down to zero on revoke', async () => {
    const f = fakeDb({
      competenciesFindFirst: competency,
      competencyHoldersFindMany: [],
    });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders/${HOLDER_ID}`, {
        method: 'DELETE',
        headers: authHeader(),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ competencyId: 'c1', holders: 0 });
      expect(f.deleteWhere).toHaveBeenCalledWith(schema.competencyHolders, expect.anything());
      expect(f.updateSet).toHaveBeenCalledWith(schema.competencies, { holders: 0 });
    } finally {
      server.close();
    }
  });

  it('lists what a user holds, scoped to the caller org', async () => {
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ competencyId: 'c1', evidenceRef: 'CERT-9' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ competencyId: 'c1', evidenceRef: 'CERT-9' }]);
    } finally {
      server.close();
    }
  });

  it('returns nothing for a user with no grants in this org', async () => {
    mockDbValue = fakeDb({ competencyHoldersFindMany: [] }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${OUTSIDER_ID}`, { headers: authHeader() });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      server.close();
    }
  });
});
