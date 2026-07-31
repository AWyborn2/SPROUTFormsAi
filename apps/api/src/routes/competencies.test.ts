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
  /** Result of the SQL aggregate syncHolderCount runs. */
  holderCount?: number;
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
    select: vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve([{ count: opts.holderCount ?? 0 }]),
      }),
    })),
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
    // 'team', not 'business': competency gating moved down to Business when
    // multi-part assessments shipped, because assessor eligibility depends on
    // it and assessments start at Business.
    mockDbValue = fakeDb({ planTier: 'team' }).db;
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

  it('stores a validity period when one is given', async () => {
    const { db, insertValues } = fakeDb({
      insertedCompetency: { id: 'c-new', name: 'ATO - Track Dozer', code: 'Q34666893', holders: 0 },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'ATO - Track Dozer',
          code: 'Q34666893',
          validForMonths: 36,
          gracePeriodDays: 30,
        }),
      });

      expect(res.status).toBe(201);
      expect(insertValues).toHaveBeenCalledWith(
        schema.competencies,
        expect.objectContaining({ validForMonths: 36, gracePeriodDays: 30 }),
      );
    } finally {
      server.close();
    }
  });

  it('leaves a competency perpetual when no validity is given', async () => {
    // NOT zero, NOT "expires today" — a competency nobody has stated a validity
    // for has to keep behaving exactly as it did before expiry existed.
    const { db, insertValues } = fakeDb({
      insertedCompetency: { id: 'c-new', name: 'Site Induction', code: 'SI', holders: 0 },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/competencies`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Site Induction', code: 'SI' }),
      });

      expect(insertValues).toHaveBeenCalledWith(
        schema.competencies,
        expect.objectContaining({ validForMonths: null, gracePeriodDays: null }),
      );
    } finally {
      server.close();
    }
  });
});

describe('PATCH /competencies/:id', () => {
  const EXISTING = {
    id: 'c1',
    orgId: 'org-1',
    name: 'ATO - Track Dozer',
    code: 'Q34666893',
    holders: 12,
    validForMonths: null,
    gracePeriodDays: null,
  };

  it('sets how long a qualification stays valid', async () => {
    const { db, updateSet } = fakeDb({ competenciesFindFirst: EXISTING });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ validForMonths: 36 }),
      });

      expect(res.status).toBe(200);
      expect(updateSet).toHaveBeenCalledWith(schema.competencies, { validForMonths: 36 });
      const body = (await res.json()) as { validForMonths: number; name: string };
      expect(body.validForMonths).toBe(36);
      expect(body.name).toBe('ATO - Track Dozer');
    } finally {
      server.close();
    }
  });

  it('only writes the columns that were sent', async () => {
    // A partial patch that also carried name/code/grace would blank whatever the
    // caller left out — this route is reached from a settings form that shows
    // one field at a time.
    const { db, updateSet } = fakeDb({ competenciesFindFirst: EXISTING });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/competencies/c1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ gracePeriodDays: 90 }),
      });

      expect(updateSet).toHaveBeenCalledWith(schema.competencies, { gracePeriodDays: 90 });
    } finally {
      server.close();
    }
  });

  it('accepts an explicit null to make a qualification perpetual again', async () => {
    // Distinct from omitting the field. Null is the only way to say "this stops
    // expiring", and it has to survive the send-only-what-changed filter.
    const { db, updateSet } = fakeDb({
      competenciesFindFirst: { ...EXISTING, validForMonths: 36 },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ validForMonths: null }),
      });

      expect(updateSet).toHaveBeenCalledWith(schema.competencies, { validForMonths: null });
      const body = (await res.json()) as { validForMonths: number | null };
      expect(body.validForMonths).toBeNull();
    } finally {
      server.close();
    }
  });

  it('rejects a nonsensical validity', async () => {
    const { db, updateSet } = fakeDb({ competenciesFindFirst: EXISTING });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ validForMonths: 0 }),
      });

      expect(res.status).toBe(400);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s for a competency outside the caller org', async () => {
    const { db, updateSet } = fakeDb({ competenciesFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ validForMonths: 36 }),
      });

      expect(res.status).toBe(404);
      expect(updateSet).not.toHaveBeenCalled();
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
      holderCount: 1,
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
      holderCount: 1,
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

  /*
    THIS USED TO ASSERT A BARE {competencyId, evidenceRef} PAIR.

    Holding a row and being currently qualified stopped being the same question
    once qualifications gained a validity period — and this lookup is what
    prerequisite warnings and assessor eligibility both read. It now reports a
    STATUS per competency; a caller that only wants "do they have it" reads
    `current`, which covers held, expiring and grace.
  */
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  it('lists what a user holds, with its status', async () => {
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [
        { competencyId: 'c1', evidenceRef: 'CERT-9', grantedAt: daysAgo(365) },
      ],
      competenciesFindMany: [{ id: 'c1', name: 'ATO - Track Dozer', validForMonths: 36 }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      expect(res.status).toBe(200);
      const [row] = (await res.json()) as { competencyId: string; status: string; current: boolean }[];
      expect(row!.competencyId).toBe('c1');
      expect(row!.status).toBe('held');
      expect(row!.current).toBe(true);
    } finally {
      server.close();
    }
  });

  it('reports a lapsed ticket as expired, and NOT current', async () => {
    // Five years on a three-year ticket. Before this it read exactly like one
    // earned this morning, and satisfied every prerequisite check.
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(5 * 365) }],
      competenciesFindMany: [{ id: 'c1', name: 'ATO - Track Dozer', validForMonths: 36 }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      const [row] = (await res.json()) as { status: string; current: boolean; note: string }[];
      expect(row!.status).toBe('expired');
      expect(row!.current).toBe(false);
      expect(row!.note).toContain('expired on');
    } finally {
      server.close();
    }
  });

  it('counts a ticket inside its grace period as still current', async () => {
    // Grace is set per competency by an admin, and within it the person is
    // requalifying rather than unqualified.
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(3 * 365 + 20) }],
      competenciesFindMany: [
        { id: 'c1', name: 'ATO - Track Dozer', validForMonths: 36, gracePeriodDays: 90 },
      ],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      const [row] = (await res.json()) as { status: string; current: boolean }[];
      expect(row!.status).toBe('grace');
      expect(row!.current).toBe(true);
    } finally {
      server.close();
    }
  });

  it('never expires a qualification with no validity set', async () => {
    /*
      The migration story. No competency carries a validity yet, so nothing
      lapses the day this ships — a qualification starts expiring only when an
      admin gives it one.
    */
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(10 * 365) }],
      competenciesFindMany: [{ id: 'c1', name: 'Site Induction' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      const [row] = (await res.json()) as { status: string; current: boolean; expiresAt: null }[];
      expect(row!.status).toBe('held');
      expect(row!.current).toBe(true);
      expect(row!.expiresAt).toBeNull();
    } finally {
      server.close();
    }
  });

  /*
    WHO IS ASKING CHANGES WHEN THE WARNING STARTS.

    An assessor planning next quarter's work needs to know a ticket lapses
    inside 90 days, or they roster someone onto a job they will not be qualified
    for by the time it runs. A person looking at their own record 90 days out
    just sees an alarm they can do nothing about for two months, so their window
    is 30. The three tests below differ only in who is asking.
  */
  const FORTY_DAYS_LEFT = {
    competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(3 * 365 - 40) }],
    competenciesFindMany: [{ id: 'c1', name: 'ATO - Track Dozer', validForMonths: 36 }],
  };

  it('warns an assessor 40 days out', async () => {
    mockDbValue = fakeDb(FORTY_DAYS_LEFT).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      const [row] = (await res.json()) as { status: string; note: string }[];
      expect(row!.status).toBe('expiring');
      expect(row!.note).toContain('expires on');
    } finally {
      server.close();
    }
  });

  it('does not warn a candidate at the same 40 days out', async () => {
    mockDbValue = fakeDb(FORTY_DAYS_LEFT).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}?audience=candidate`, {
        headers: authHeader(),
      });

      const [row] = (await res.json()) as { status: string; current: boolean; note: null }[];
      expect(row!.status).toBe('held');
      expect(row!.current).toBe(true);
      expect(row!.note).toBeNull();
    } finally {
      server.close();
    }
  });

  it('treats someone reading their own record as the candidate', async () => {
    // No query parameter. Reading your own record IS the candidate case, and a
    // surface that forgot to say so would otherwise get the assessor window.
    mockDbValue = fakeDb(FORTY_DAYS_LEFT).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${tenant.userId}`, {
        headers: authHeader(),
      });

      const [row] = (await res.json()) as { status: string }[];
      expect(row!.status).toBe('held');
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
