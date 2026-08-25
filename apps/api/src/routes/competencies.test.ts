import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';
import { DEFAULT_ROLE_PERMISSIONS, type PermissionMatrix } from '@formai/shared';

const tenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

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

/*
  Keys that hang schema metadata off a column node — walking them loops back
  through the table and blows the stack.
*/
const WHERE_SKIP_KEYS = new Set([
  'table',
  'config',
  'encoder',
  'decoder',
  'session',
  'dialect',
  'default',
]);

/**
 * Does this drizzle WHERE carry an `is null` predicate?
 *
 * The only column any competency-holder read asks that of is `revokedAt`, and
 * asking it is what "live grants only" MEANS: the DELETE dependency check, the
 * eligibility lookup and the recommended read all filter it, while the holder
 * register deliberately does not (R108 — a revoked holder stays visible,
 * marked). A fake that returned every seeded row to both would leave the
 * revoked-grant EXCLUSION — the thing that stops audit history blocking a
 * tidy-up forever — asserted by nothing.
 */
function wantsUnrevoked(node: unknown, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 12) return false;
  const rec = node as Record<string, unknown>;
  const chunks = rec.queryChunks;
  if (Array.isArray(chunks)) {
    const text = chunks
      .map((c) => {
        const v = (c as { value?: unknown } | null)?.value;
        return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
      })
      .join('');
    if (text.includes('is null')) return true;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (WHERE_SKIP_KEYS.has(k)) continue;
    if (wantsUnrevoked(v, depth + 1)) return true;
  }
  return false;
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
  usersFindMany?: unknown[];
  /** Result of the SQL aggregate syncHolderCount runs. */
  holderCount?: number;
  membershipsFindFirst?: unknown;
  /** Standing derivation (U16) reads these — membership → held Roles → required tools → awards. */
  membershipsFindMany?: unknown[];
  membershipRolesFindMany?: unknown[];
  roleRequiredAssessmentsFindMany?: unknown[];
  assessmentToolsFindMany?: unknown[];
  /** Direct Role → competency links (KTD1): the dual read's second half, and DELETE's dependency check. */
  competencyRequirementsFindMany?: unknown[];
  /** Placement rows and their taxonomy values, for the scope expansion and the U8 sources read. */
  membershipLocationsFindMany?: unknown[];
  locationsFindMany?: unknown[];
  /** Role NAME rows — the sources read captions role-scope entries from these (R5). */
  jobRolesFindMany?: unknown[];
  /** Every route is gated by requirePlanFeature('competencyGating'). */
  planTier?: string;
  /** The org's candidate self-start toggle (U7, R14). Default OFF — the stored default. */
  selfStart?: boolean;
  /** The caller's stored permission matrix; absent falls back to the role default. */
  matrix?: PermissionMatrix;
}) {
  const deleteWhere = vi.fn();
  const updateSet = vi.fn();
  const insertValues = vi.fn();

  const db = {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'org-1',
          planTier: opts.planTier ?? 'enterprise',
          candidateSelfStartRecommended: opts.selfStart ?? false,
        }),
        // The U8 sources read resolves the ORG NAME for org-scope captions.
        findMany: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Org One' }]),
      },
      rolePermissions: {
        findFirst: vi.fn().mockResolvedValue(opts.matrix ? { matrix: opts.matrix } : undefined),
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
        findMany: vi.fn().mockResolvedValue(opts.usersFindMany ?? []),
      },
      competencyHolders: {
        findFirst: vi.fn().mockResolvedValue(opts.competencyHoldersFindFirst),
        // revokedAt-AWARE, unlike a flat mock: a caller that asks for live
        // grants only gets live grants only (see `wantsUnrevoked`).
        findMany: vi.fn((args?: { where?: unknown }) => {
          const rows = (opts.competencyHoldersFindMany ?? []) as { revokedAt?: unknown }[];
          return Promise.resolve(
            wantsUnrevoked(args?.where) ? rows.filter((r) => r.revokedAt == null) : rows,
          );
        }),
      },
      memberships: {
        findFirst: vi.fn().mockResolvedValue(opts.membershipsFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.membershipsFindMany ?? []),
      },
      membershipRoles: {
        findMany: vi.fn().mockResolvedValue(opts.membershipRolesFindMany ?? []),
      },
      // Scope expansion (U2) reads the placement axes and their taxonomy
      // values too; role-shaped fixtures leave these empty, the U8 sources
      // fixtures place people so location-scope captions are real.
      membershipLocations: {
        findMany: vi.fn().mockResolvedValue(opts.membershipLocationsFindMany ?? []),
      },
      membershipDepartments: { findMany: vi.fn().mockResolvedValue([]) },
      locations: { findMany: vi.fn().mockResolvedValue(opts.locationsFindMany ?? []) },
      departments: { findMany: vi.fn().mockResolvedValue([]) },
      jobRoles: { findMany: vi.fn().mockResolvedValue(opts.jobRolesFindMany ?? []) },
      roleRequiredAssessments: {
        findMany: vi.fn().mockResolvedValue(opts.roleRequiredAssessmentsFindMany ?? []),
      },
      assessmentTools: {
        findMany: vi.fn().mockResolvedValue(opts.assessmentToolsFindMany ?? []),
      },
      competencyRequirements: {
        /*
          TIER-AWARE, unlike the other mocks: the loaders filter tier in the
          WHERE clause ('required' for the dual read, 'recommended' for its
          sibling), and a mock that returned every seeded row to both would
          let a recommended link read as required — masking exactly the R13
          regression these tests exist to catch. The tier literal is dug out
          of the query's bound params.
        */
        findMany: vi.fn((args?: { where?: unknown }) => {
          const rows = (opts.competencyRequirementsFindMany ?? []) as { tier?: string }[];
          const seen = new Set<unknown>();
          const stack: unknown[] = [args?.where];
          let tier: string | null = null;
          while (stack.length && !tier) {
            const n = stack.pop();
            if (!n || typeof n !== 'object' || seen.has(n)) continue;
            seen.add(n);
            const rec = n as Record<string, unknown>;
            if (rec.value === 'required' || rec.value === 'recommended') {
              tier = rec.value as string;
              break;
            }
            for (const v of Object.values(rec)) if (v && typeof v === 'object') stack.push(v);
          }
          const byTier = tier ? rows.filter((r) => r.tier === tier) : rows;
          /*
            SCOPE-AWARE too (U2): of the four scope reads, only the ORG one
            carries an `is null` shape (all three scope columns null, KTD1) —
            `wantsUnrevoked` is a generic is-null sniffer, reused here — and
            these role-link fixtures must not answer it, or every seeded role
            requirement would read as org-wide for every member.
          */
          return Promise.resolve(
            wantsUnrevoked(args?.where)
              ? byTier.filter(
                  (r) =>
                    (r as Record<string, unknown>).roleId == null &&
                    (r as Record<string, unknown>).locationId == null &&
                    (r as Record<string, unknown>).departmentId == null,
                )
              : byTier,
          );
        }),
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
  // The dual standing read runs inside db.transaction (KTD3); the fake hands
  // the same surface back, since these mocks have no snapshot to isolate.
  (db as { transaction?: unknown }).transaction = async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(db);

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

  it('serialises a codeless competency as an explicit null, not a dropped field', async () => {
    // A dropped key would make the client guess. `null` says "there is no code"
    // in the same word the register stores.
    mockDbValue = fakeDb({
      competenciesFindMany: [
        { id: 'c1', name: 'Contractor Endorsement Form', code: null, holders: 191 },
      ],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies`, { headers: authHeader() });
      const body = (await res.json()) as { code: string | null }[];
      expect(body[0]).toMatchObject({ name: 'Contractor Endorsement Form', code: null });
      expect(Object.keys(body[0]!)).toContain('code');
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

  it('creates a competency with no code at all', async () => {
    /*
      A NATIONALLY-RECOGNISED CODE IS NOT UNIVERSAL. A contractor endorsement
      form or an in-house equipment induction is an internal competency and has
      never had one. Requiring a code forced whoever loaded the register to
      invent an identifier in the very column people cross-reference against
      their external LMS — wrong quietly and permanently. A code is still
      strongly preferred; its absence is now sayable.
    */
    const { db, insertValues } = fakeDb({
      insertedCompetency: {
        id: 'c-new',
        name: 'Contractor Endorsement Form',
        code: null,
        holders: 0,
      },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Contractor Endorsement Form' }),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ name: 'Contractor Endorsement Form', code: null });
      expect(insertValues).toHaveBeenCalledWith(
        schema.competencies,
        expect.objectContaining({ code: null }),
      );
    } finally {
      server.close();
    }
  });

  it('stores a blank or whitespace code as NULL, never as an empty string', async () => {
    // One spelling of "no code" in the register. '' and null are two ways to
    // state the same fact, and a reader would have to know both.
    for (const sent of ['', '   ', null]) {
      const { db, insertValues } = fakeDb({
        insertedCompetency: { id: 'c-new', name: 'Bistrainer Basics', code: null, holders: 0 },
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies`, {
          method: 'POST',
          headers: { ...authHeader(), 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Bistrainer Basics', code: sent }),
        });
        expect(res.status).toBe(201);
        expect(insertValues).toHaveBeenCalledWith(
          schema.competencies,
          expect.objectContaining({ code: null }),
        );
      } finally {
        server.close();
      }
    }
  });

  it('still stores and trims a code when one is given, and still rejects a missing name', async () => {
    const { db, insertValues } = fakeDb({
      insertedCompetency: { id: 'c-new', name: 'Working at Heights', code: 'RIIWHS204E', holders: 0 },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const ok = await fetch(`${base}/competencies`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Working at Heights', code: '  RIIWHS204E  ' }),
      });
      expect(ok.status).toBe(201);
      expect(insertValues).toHaveBeenCalledWith(
        schema.competencies,
        expect.objectContaining({ code: 'RIIWHS204E' }),
      );

      // The name is still required — the code becoming optional weakens nothing
      // else about creating a competency.
      const bad = await fetch(`${base}/competencies`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'RIIWHS204E' }),
      });
      expect(bad.status).toBe(400);
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

  it('clears a code to NULL when one is sent blank, and leaves it alone when omitted', async () => {
    /*
      Both halves matter. Clearing is how a competency that was given an
      invented code — the only thing anyone could do while the column was
      required — gets corrected. Omitting must still be a no-op, or every patch
      of the validity fields would silently wipe the code.
    */
    const cleared = fakeDb({ competenciesFindFirst: EXISTING });
    mockDbValue = cleared.db;
    let app = startApp();
    try {
      const res = await fetch(`${app.base}/competencies/c1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ code: '  ' }),
      });
      expect(res.status).toBe(200);
      expect(cleared.updateSet).toHaveBeenCalledWith(schema.competencies, { code: null });
      expect(await res.json()).toMatchObject({ code: null });
    } finally {
      app.server.close();
    }

    const untouched = fakeDb({ competenciesFindFirst: EXISTING });
    mockDbValue = untouched.db;
    app = startApp();
    try {
      const res = await fetch(`${app.base}/competencies/c1`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ validForMonths: 36 }),
      });
      expect(untouched.updateSet).toHaveBeenCalledWith(schema.competencies, { validForMonths: 36 });
      expect(await res.json()).toMatchObject({ code: 'Q34666893' });
    } finally {
      app.server.close();
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

/*
  WHO MAY WRITE THE REGISTER (KTD8). These gates land in the same round that
  raises the blast radius: once Roles point at competencies directly, a rename
  relabels every requiring Role and a delete would cascade through the links.
  NOTE the gate is the access-level ROLE on the session, not the permission
  matrix — DEFAULT_ROLE_PERMISSIONS covers profile reads and is not what
  decides these 403s.
*/
describe('competency write gates (KTD8)', () => {
  const builder = { userId: 'u-builder', orgId: 'org-1', role: 'builder' as const };
  const assessor = { userId: 'u-assessor', orgId: 'org-1', role: 'assessor' as const };
  const candidateCaller = { userId: 'u-cand', orgId: 'org-1', role: 'candidate' as const };
  const as = (t: { userId: string; orgId: string; role: string }) => ({
    cookie: `fai_session=${sealSession(t)}`,
  });

  it('403s a builder creating a competency — form authorship never implied taxonomy authorship', async () => {
    const { db, insertValues } = fakeDb({});
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies`, {
        method: 'POST',
        headers: { ...as(builder), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Forklift' }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('forbidden');
      expect(insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('lets an assessor create one — the register is their working surface (201)', async () => {
    mockDbValue = fakeDb({
      insertedCompetency: { id: 'c-new', name: 'Forklift', code: null, holders: 0 },
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies`, {
        method: 'POST',
        headers: { ...as(assessor), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Forklift' }),
      });
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });

  it('403s a candidate PATCH before it reads anything', async () => {
    const { db, updateSet } = fakeDb({
      competenciesFindFirst: { id: 'c1', orgId: 'org-1', name: 'Forklift', code: null },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, {
        method: 'PATCH',
        headers: { ...as(candidateCaller), 'content-type': 'application/json' },
        body: JSON.stringify({ validForMonths: 36 }),
      });
      expect(res.status).toBe(403);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('403s a non-admin DELETE — even the assessor tier that may create (KTD8)', async () => {
    const { db, deleteWhere } = fakeDb({
      competenciesFindFirst: { id: 'c1', orgId: 'org-1', name: 'Forklift', code: null },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, {
        method: 'DELETE',
        headers: as(assessor),
      });
      expect(res.status).toBe(403);
      expect(deleteWhere).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  /*
    GRANTING AND REVOKING CARRY THE SAME GATE AS DEFINING (KTD8), and for a
    sharper reason: HOLDING is what `standingOf` reads and what closes a Role's
    required gap (R5, R10), so an ungated grant let any member self-certify
    into compliance and an ungated revoke moved someone out of it. Both sit on
    owner/admin/assessor, matching POST '/' and PATCH '/:id'.
  */
  const grantable = { id: 'c1', orgId: 'org-1', name: 'Track Dozer', code: 'Q34666893', holders: 0 };

  it('403s a candidate GRANTING a competency — self-certification into compliance', async () => {
    const { db, insertValues } = fakeDb({
      competenciesFindFirst: grantable,
      membershipsFindFirst: { id: 'm1', userId: HOLDER_ID, orgId: 'org-1' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, {
        method: 'POST',
        headers: { ...as(candidateCaller), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: HOLDER_ID }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('forbidden');
      // Refused BEFORE the write, not after it.
      expect(insertValues).not.toHaveBeenCalledWith(schema.competencyHolders, expect.anything());
    } finally {
      server.close();
    }
  });

  it('403s a builder GRANTING — the form tiers never implied register authority', async () => {
    const { db, insertValues } = fakeDb({
      competenciesFindFirst: grantable,
      membershipsFindFirst: { id: 'm1', userId: HOLDER_ID, orgId: 'org-1' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, {
        method: 'POST',
        headers: { ...as(builder), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: HOLDER_ID }),
      });
      expect(res.status).toBe(403);
      expect(insertValues).not.toHaveBeenCalledWith(schema.competencyHolders, expect.anything());
    } finally {
      server.close();
    }
  });

  it('lets an ASSESSOR grant — recording who passed is their working surface', async () => {
    const { db, insertValues } = fakeDb({
      competenciesFindFirst: grantable,
      membershipsFindFirst: { id: 'm1', userId: HOLDER_ID, orgId: 'org-1' },
      competencyHoldersFindFirst: undefined,
      holderCount: 1,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, {
        method: 'POST',
        headers: { ...as(assessor), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: HOLDER_ID }),
      });
      expect(res.status).toBe(201);
      expect(insertValues).toHaveBeenCalledWith(
        schema.competencyHolders,
        expect.objectContaining({ competencyId: 'c1', userId: HOLDER_ID }),
      );
    } finally {
      server.close();
    }
  });

  it('403s a builder REVOKING — taking a ticket away moves someone OUT of compliance', async () => {
    const { db, updateSet } = fakeDb({
      competenciesFindFirst: grantable,
      competencyHoldersFindMany: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders/${HOLDER_ID}`, {
        method: 'DELETE',
        headers: as(builder),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('forbidden');
      expect(updateSet).not.toHaveBeenCalledWith(schema.competencyHolders, expect.anything());
    } finally {
      server.close();
    }
  });

  it('lets an ASSESSOR revoke — same authority as granting', async () => {
    const { db, updateSet } = fakeDb({
      competenciesFindFirst: grantable,
      competencyHoldersFindMany: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders/${HOLDER_ID}`, {
        method: 'DELETE',
        headers: as(assessor),
      });
      expect(res.status).toBe(200);
      expect(updateSet).toHaveBeenCalledWith(
        schema.competencyHolders,
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
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

  it('409s competency_in_use, naming every dependency kind, instead of cascading (KTD8)', async () => {
    // One of each: a Role requiring it, a Role recommending it, a tool
    // awarding it, a live grant of it. The FK cascade must be unreachable
    // while any of these stand.
    const { db, deleteWhere } = fakeDb({
      competenciesFindFirst: { id: 'c1', orgId: 'org-1', name: 'Track Dozer', code: 'Q34666893' },
      competencyRequirementsFindMany: [
        { roleId: 'r1', competencyId: 'c1', tier: 'required' },
        { roleId: 'r2', competencyId: 'c1', tier: 'recommended' },
      ],
      assessmentToolsFindMany: [
        { id: 't1', orgId: 'org-1', awardedCompetencyIds: ['c1'] },
        // A tool awarding something ELSE is not a dependency of c1.
        { id: 't2', orgId: 'org-1', awardedCompetencyIds: ['c-other'] },
      ],
      competencyHoldersFindMany: [{ userId: HOLDER_ID, competencyId: 'c1', revokedAt: null }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, { method: 'DELETE', headers: authHeader() });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'competency_in_use',
        roles: 1,
        recommendedBy: 1,
        locations: 0,
        departments: 0,
        orgWide: 0,
        tools: 1,
        grants: 1,
      });
      expect(deleteWhere).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('blocks on a NON-role requirement row and reports it per scope, never as a role (KTD2, U1)', async () => {
    /*
      The requirements table now carries four scopes, and the dependency read
      is by competencyId alone — so an org-scope or location-scope requirement
      must still 409 a delete. But the payload's `roles` key is a promise about
      ROLE rows: an org-wide requirement laundered into it would send the admin
      hunting through role editors for a dependency none of them holds. Scope
      rows land in their own counts.
    */
    const { db, deleteWhere } = fakeDb({
      competenciesFindFirst: { id: 'c1', orgId: 'org-1', name: 'Track Dozer', code: 'Q34666893' },
      competencyRequirementsFindMany: [
        { roleId: null, locationId: null, departmentId: null, competencyId: 'c1', tier: 'required' },
        { roleId: null, locationId: 'loc-1', departmentId: null, competencyId: 'c1', tier: 'required' },
        { roleId: null, locationId: null, departmentId: 'dep-1', competencyId: 'c1', tier: 'recommended' },
      ],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, { method: 'DELETE', headers: authHeader() });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'competency_in_use',
        roles: 0,
        recommendedBy: 0,
        locations: 1,
        departments: 1,
        orgWide: 1,
        tools: 0,
        grants: 0,
      });
      expect(deleteWhere).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('deletes despite a REVOKED grant — audit history is not a dependency (KTD8)', async () => {
    /*
      A revoked grant confers nothing, and the dependency query says so by
      asking `revokedAt IS NULL`. If it counted, a competency granted once and
      taken away would be undeletable forever, with no exit: revoking again
      changes nothing and un-requiring is not the blocker. The only seeded row
      here is revoked, so a fake that ignored the predicate would 409 and this
      test would catch it.
    */
    const { db, deleteWhere } = fakeDb({
      competenciesFindFirst: { id: 'c1', orgId: 'org-1', name: 'Track Dozer', code: 'Q34666893' },
      competencyHoldersFindMany: [
        { userId: HOLDER_ID, competencyId: 'c1', revokedAt: new Date('2026-01-01T00:00:00Z') },
      ],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, { method: 'DELETE', headers: authHeader() });

      expect(res.status).toBe(204);
      expect(deleteWhere).toHaveBeenCalledWith(schema.competencies, expect.anything());
    } finally {
      server.close();
    }
  });

  it('deletes an orphan competency and records an audit entry', async () => {
    const { db, deleteWhere, insertValues } = fakeDb({
      competenciesFindFirst: { id: 'c1', orgId: 'org-1', name: 'Track Dozer', code: 'Q34666893' },
      // No links, no awarding tools, no live grants — nothing depends on it.
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1`, { method: 'DELETE', headers: authHeader() });

      expect(res.status).toBe(204);
      expect(deleteWhere).toHaveBeenCalledWith(schema.competencies, expect.anything());
      const audit = insertValues.mock.calls.find(
        ([, v]) => (v as { action?: string }).action === 'Deleted competency',
      );
      expect(audit?.[1]).toMatchObject({ target: 'Q34666893' });
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

  it('records a licence as a competency, carrying its class, number and expiry (R33, R34)', async () => {
    /*
      F3: the licence goes on the GRANT, not on the profile. Recorded here it
      inherits expiry dates, grace periods, revocation and a place in every
      prerequisite and compliance check for free (R35, R36) — recorded as three
      flat fields on a form answer, which is where it lives today, it inherits
      none of that and expires silently.
    */
    const f = fakeDb({
      competenciesFindFirst: { ...competency, name: 'Driver Licence' },
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
        body: JSON.stringify({
          userId: HOLDER_ID,
          licenceClass: 'HR',
          licenceNumber: 'WA1234567',
          expiresAt: '2028-06-30T00:00:00.000Z',
        }),
      });
      expect(res.status).toBe(201);
      expect(f.insertValues).toHaveBeenCalledWith(
        schema.competencyHolders,
        expect.objectContaining({
          licenceClass: 'HR',
          licenceNumber: 'WA1234567',
          expiresAt: new Date('2028-06-30T00:00:00.000Z'),
        }),
      );
    } finally {
      server.close();
    }
  });

  it('leaves the licence columns null on an ordinary competency', async () => {
    const f = fakeDb({
      competenciesFindFirst: competency,
      membershipsFindFirst: { id: 'm1', userId: HOLDER_ID, orgId: 'org-1' },
      competencyHoldersFindFirst: undefined,
      holderCount: 1,
    });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/competencies/c1/holders`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: HOLDER_ID }),
      });
      expect(f.insertValues).toHaveBeenCalledWith(
        schema.competencyHolders,
        expect.objectContaining({ licenceClass: null, licenceNumber: null }),
      );
    } finally {
      server.close();
    }
  });

  it('carries the licence class and number forward on a re-grant (R34)', async () => {
    // Renewing a ticket rarely changes either; supplying neither must not blank
    // them, the way a stale explicit expiry deliberately IS cleared.
    const f = fakeDb({
      competenciesFindFirst: competency,
      membershipsFindFirst: { id: 'm1', userId: HOLDER_ID, orgId: 'org-1' },
      competencyHoldersFindFirst: {
        id: 'h1',
        competencyId: 'c1',
        userId: HOLDER_ID,
        licenceClass: 'HR',
        licenceNumber: 'WA1234567',
      },
      holderCount: 1,
    });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/competencies/c1/holders`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: HOLDER_ID }),
      });
      expect(f.updateSet).toHaveBeenCalledWith(
        schema.competencyHolders,
        expect.objectContaining({ licenceClass: 'HR', licenceNumber: 'WA1234567' }),
      );
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

  /*
    THIS USED TO ASSERT `deleteWhere` — THE ROW WAS ERASED.

    Every other revocation in this codebase is soft: `revokeGrantsFromCase`
    sets revokedAt and keeps the row, and the schema says a hard delete would
    leave the register disagreeing with the audit log. So an appeal preserved
    the record while an admin clicking revoke destroyed it, and the audit entry
    was left pointing at a row that no longer existed.
  */
  it('revokes without erasing, and recomputes the count down to zero', async () => {
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
      // The row survives, stamped.
      expect(f.deleteWhere).not.toHaveBeenCalled();
      expect(f.updateSet).toHaveBeenCalledWith(
        schema.competencyHolders,
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
      // And it stops counting: the aggregate excludes revoked rows.
      expect(f.updateSet).toHaveBeenCalledWith(schema.competencies, { holders: 0 });
    } finally {
      server.close();
    }
  });

  it('records why, so an auditor is not left guessing', async () => {
    const f = fakeDb({ competenciesFindFirst: competency, competencyHoldersFindMany: [] });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/competencies/c1/holders/${HOLDER_ID}`, {
        method: 'DELETE',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Appeal upheld — result set aside' }),
      });

      expect(f.updateSet).toHaveBeenCalledWith(
        schema.competencyHolders,
        expect.objectContaining({ revokedReason: 'Appeal upheld — result set aside' }),
      );
    } finally {
      server.close();
    }
  });

  it('stores a reason even when the caller sends no body', async () => {
    // A DELETE with no body is the existing caller shape, and must keep
    // working — but an unexplained revocation is the one an auditor most wants
    // explained, so it still records how it happened.
    const f = fakeDb({ competenciesFindFirst: competency, competencyHoldersFindMany: [] });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders/${HOLDER_ID}`, {
        method: 'DELETE',
        headers: authHeader(),
      });

      expect(res.status).toBe(200);
      expect(f.updateSet).toHaveBeenCalledWith(
        schema.competencyHolders,
        expect.objectContaining({ revokedReason: 'Revoked by an administrator' }),
      );
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
      const [row] = (await res.json()) as {
        competencyId: string;
        name: string;
        code: string | null;
        status: string;
        current: boolean;
      }[];
      expect(row!.competencyId).toBe('c1');
      // The display name rides the row — the record screen shows names, not ids.
      expect(row!.name).toBe('ATO - Track Dozer');
      expect(row!.code).toBeNull();
      expect(row!.status).toBe('held');
      expect(row!.current).toBe(true);
    } finally {
      server.close();
    }
  });

  describe('licence numbers are gated by profiles.view_competencies (R34)', () => {
    const withLicence = {
      competencyHoldersFindMany: [
        { competencyId: 'c1', evidenceRef: 'L', grantedAt: daysAgo(10), licenceClass: 'HR', licenceNumber: 'WA1234567' },
      ],
      competenciesFindMany: [{ id: 'c1', name: 'Driver Licence', validForMonths: 36 }],
    };
    const candidateCaller = { userId: 'u-cand', orgId: 'org-1', role: 'candidate' as const };

    it('hides them from a caller reading someone else without the grant', async () => {
      mockDbValue = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate, ...withLicence }).db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, {
          headers: { cookie: `fai_session=${sealSession(candidateCaller)}` },
        });
        const [row] = (await res.json()) as { licenceNumber: string | null; licenceClass: string | null }[];
        expect(row!.licenceNumber).toBeNull();
        expect(row!.licenceClass).toBeNull();
      } finally {
        server.close();
      }
    });

    it('shows them to a caller granted view_competencies org-wide', async () => {
      mockDbValue = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, ...withLicence }).db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });
        const [row] = (await res.json()) as { licenceNumber: string | null }[];
        expect(row!.licenceNumber).toBe('WA1234567');
      } finally {
        server.close();
      }
    });

    it('shows a candidate their OWN licence even without the grant (R49)', async () => {
      const self = { userId: HOLDER_ID, orgId: 'org-1', role: 'candidate' as const };
      mockDbValue = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate, ...withLicence }).db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, {
          headers: { cookie: `fai_session=${sealSession(self)}` },
        });
        const [row] = (await res.json()) as { licenceNumber: string | null }[];
        expect(row!.licenceNumber).toBe('WA1234567');
      } finally {
        server.close();
      }
    });
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

  it('carries the grant row id as holderId, so a renewal can attach evidence (task #43)', async () => {
    // Renewing a lapsed licence files the new evidence against the HOLDING via
    // POST /competency-documents/:holderId, and nothing else on the record
    // carries that id — so the held read has to surface it.
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ id: 'holder-42', competencyId: 'c1', grantedAt: daysAgo(10) }],
      competenciesFindMany: [{ id: 'c1', name: 'Driver Licence' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });
      const [row] = (await res.json()) as { holderId: string }[];
      expect(row!.holderId).toBe('holder-42');
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

  it('reports standing beside currency — required when a held Role requires it (R108)', async () => {
    // The same held ticket reads required or optional purely by whether a held
    // Role requires the tool that awards it — standing never touches the date.
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(365) }],
      competenciesFindMany: [{ id: 'c1', name: 'ATO - Track Dozer', validForMonths: 36 }],
      membershipsFindMany: [{ id: 'm1', userId: HOLDER_ID }],
      membershipRolesFindMany: [{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }],
      roleRequiredAssessmentsFindMany: [{ roleId: 'r1', toolId: 't1' }],
      assessmentToolsFindMany: [{ id: 't1', awardedCompetencyIds: ['c1'] }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      const [row] = (await res.json()) as { status: string; current: boolean; standing: string }[];
      expect(row!.status).toBe('held');
      expect(row!.current).toBe(true);
      expect(row!.standing).toBe('required');
    } finally {
      server.close();
    }
  });

  it('reports required from a DIRECT role→competency link, no tool involved (R5, R7)', async () => {
    // The licence case: nothing awards c1 and no legacy tool requirement
    // exists — the direct link alone obliges.
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(365) }],
      competenciesFindMany: [{ id: 'c1', name: 'Driver Licence', validForMonths: 36 }],
      membershipsFindMany: [{ id: 'm1', userId: HOLDER_ID }],
      membershipRolesFindMany: [{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }],
      competencyRequirementsFindMany: [{ roleId: 'r1', competencyId: 'c1', tier: 'required' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      const [row] = (await res.json()) as { standing: string }[];
      expect(row!.standing).toBe('required');
    } finally {
      server.close();
    }
  });

  it('reads one requirement, not two, when the legacy row and its converted link coexist (KTD3)', async () => {
    // Mid-transition: both halves name c1. The union is a set, so standing
    // still reads plain 'required' — never a doubled obligation.
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(365) }],
      competenciesFindMany: [{ id: 'c1', name: 'ATO - Track Dozer', validForMonths: 36 }],
      membershipsFindMany: [{ id: 'm1', userId: HOLDER_ID }],
      membershipRolesFindMany: [{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }],
      roleRequiredAssessmentsFindMany: [{ roleId: 'r1', toolId: 't1' }],
      assessmentToolsFindMany: [{ id: 't1', awardedCompetencyIds: ['c1'] }],
      competencyRequirementsFindMany: [{ roleId: 'r1', competencyId: 'c1', tier: 'required' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      const rows = (await res.json()) as { standing: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.standing).toBe('required');
    } finally {
      server.close();
    }
  });

  it('reports a held competency a Role merely recommends as recommended, never required (R6, R12, R13)', async () => {
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(365) }],
      competenciesFindMany: [{ id: 'c1', name: 'First Aid', validForMonths: 36 }],
      membershipsFindMany: [{ id: 'm1', userId: HOLDER_ID }],
      membershipRolesFindMany: [{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }],
      competencyRequirementsFindMany: [{ roleId: 'r1', competencyId: 'c1', tier: 'recommended' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      const [row] = (await res.json()) as { standing: string }[];
      expect(row!.standing).toBe('recommended');
    } finally {
      server.close();
    }
  });

  describe('source scopes on the record (U8 — R5, AE1)', () => {
    /*
      A held competency required at the holder's LOCATION and at their ROLE:
      the record entry must name both contributing scopes, in the resolver's
      deterministic order (broadest first). Placement fixture, not derivation —
      location requirements follow membership_locations (R3).
    */
    const dualSourceFixture = {
      competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(100) }],
      competenciesFindMany: [{ id: 'c1', name: 'Site Induction', validForMonths: 36 }],
      membershipsFindMany: [{ id: 'm1', userId: HOLDER_ID }],
      membershipRolesFindMany: [{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }],
      membershipLocationsFindMany: [{ membershipId: 'm1', locationId: 'loc-1' }],
      locationsFindMany: [{ id: 'loc-1', orgId: 'org-1', name: 'Boddington', status: 'active' }],
      jobRolesFindMany: [{ id: 'r1', orgId: 'org-1', name: 'Dozer Operator', status: 'active' }],
      competencyRequirementsFindMany: [
        { roleId: 'r1', locationId: null, departmentId: null, competencyId: 'c1', tier: 'required' },
        { roleId: null, locationId: 'loc-1', departmentId: null, competencyId: 'c1', tier: 'required' },
      ],
    };

    it('names every contributing scope on an OWN-record read — no permission needed (R5)', async () => {
      const self = { userId: HOLDER_ID, orgId: 'org-1', role: 'candidate' as const };
      mockDbValue = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate, ...dualSourceFixture }).db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, {
          headers: { cookie: `fai_session=${sealSession(self)}` },
        });
        const [row] = (await res.json()) as {
          standing: string;
          sources: Array<{ scope: string; name: string }>;
        }[];
        expect(row!.standing).toBe('required');
        expect(row!.sources).toEqual([
          { scope: 'location', name: 'Boddington' },
          { scope: 'role', name: 'Dozer Operator' },
        ]);
      } finally {
        server.close();
      }
    });

    it('OMITS the field — undefined, never an empty array — from a colleague read without the grant', async () => {
      /*
        The viewer gate (U8, review-verified exposure): sources enumerate the
        subject's locations, departments and roles, so they ride the SAME
        `profiles.view_competencies === 'all'` grant that already gates licence
        fields here. Omitted rather than `[]` because an empty array would
        CLAIM "no scope requires this" — false for this fixture — while an
        absent key says only "not shown to you".
      */
      const colleague = { userId: 'u-cand', orgId: 'org-1', role: 'candidate' as const };
      mockDbValue = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate, ...dualSourceFixture }).db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, {
          headers: { cookie: `fai_session=${sealSession(colleague)}` },
        });
        const [row] = (await res.json()) as Record<string, unknown>[];
        expect(row!.standing).toBe('required'); // standing itself is not withheld
        expect('sources' in row!).toBe(false);
      } finally {
        server.close();
      }
    });

    it('shows sources to a caller granted view_competencies org-wide', async () => {
      mockDbValue = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, ...dualSourceFixture }).db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });
        const [row] = (await res.json()) as { sources: unknown }[];
        expect(row!.sources).toEqual([
          { scope: 'location', name: 'Boddington' },
          { scope: 'role', name: 'Dozer Operator' },
        ]);
      } finally {
        server.close();
      }
    });

    it('captions a RECOMMENDED entry from its recommending scope, per tier (R8, AE5)', async () => {
      // Location-scope recommended: the entry's sources come from the
      // recommended map, never the required one (the tiers stay apart, R13).
      mockDbValue = fakeDb({
        ...dualSourceFixture,
        competencyRequirementsFindMany: [
          { roleId: null, locationId: 'loc-1', departmentId: null, competencyId: 'c1', tier: 'recommended' },
        ],
      }).db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });
        const [row] = (await res.json()) as { standing: string; sources: unknown }[];
        expect(row!.standing).toBe('recommended');
        expect(row!.sources).toEqual([{ scope: 'location', name: 'Boddington' }]);
      } finally {
        server.close();
      }
    });

    it('gives an OPTIONAL entry an empty sources list — nothing names it, and that is a fact', async () => {
      mockDbValue = fakeDb({
        ...dualSourceFixture,
        competencyRequirementsFindMany: [],
      }).db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });
        const [row] = (await res.json()) as { standing: string; sources: unknown }[];
        expect(row!.standing).toBe('optional');
        expect(row!.sources).toEqual([]);
      } finally {
        server.close();
      }
    });

    it('captions an org-scope requirement with the organisation name — the web renders it "org-wide"', async () => {
      mockDbValue = fakeDb({
        ...dualSourceFixture,
        competencyRequirementsFindMany: [
          { roleId: null, locationId: null, departmentId: null, competencyId: 'c1', tier: 'required' },
        ],
      }).db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });
        const [row] = (await res.json()) as { sources: unknown }[];
        expect(row!.sources).toEqual([{ scope: 'org', name: 'Org One' }]);
      } finally {
        server.close();
      }
    });
  });

  it('reports a held ticket no Role requires as optional but still current (R91, R105)', async () => {
    // Standing optional, currency current — the two answers stay independent: an
    // optional ticket that is in date still satisfies a prerequisite on its
    // currency alone.
    mockDbValue = fakeDb({
      competencyHoldersFindMany: [{ competencyId: 'c1', grantedAt: daysAgo(365) }],
      competenciesFindMany: [{ id: 'c1', name: 'ATO - Track Dozer', validForMonths: 36 }],
      // No membership rows → no required tools → optional.
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/held/${HOLDER_ID}`, { headers: authHeader() });

      const [row] = (await res.json()) as { current: boolean; standing: string }[];
      expect(row!.standing).toBe('optional');
      expect(row!.current).toBe(true);
    } finally {
      server.close();
    }
  });
});

/*
  GET /competencies/:id/holders — the inverse lookup.

  `competencies.holders` could say "12 people hold this" but never which twelve,
  and being a stored count of grants it cannot say how many are still in date.
  So an admin could set a validity and then had no way to see who it had just
  lapsed. This route is what makes that visible, which means the ORDER is part
  of its contract: the reason to open the list is to find who needs booking.
*/
describe('GET /competencies/:id/holders', () => {
  const TRACK_DOZER = {
    id: 'c1',
    orgId: 'org-1',
    name: 'ATO - Track Dozer',
    code: 'Q34666893',
    holders: 3,
    validForMonths: 36,
    gracePeriodDays: null,
  };
  const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const PEOPLE = [
    { id: 'u-current', name: 'Ada Current', email: 'ada@example.com' },
    { id: 'u-lapsed', name: 'Bo Lapsed', email: 'bo@example.com' },
    { id: 'u-soon', name: 'Cy Soon', email: 'cy@example.com' },
  ];

  it('names each holder and says whether they are still current', async () => {
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-current', grantedAt: ago(200), evidenceRef: 'CERT-1', revokedAt: null },
      ],
      usersFindMany: PEOPLE,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      expect(res.status).toBe(200);
      const [row] = (await res.json()) as {
        userId: string;
        name: string;
        email: string;
        status: string;
        current: boolean;
        expiresAt: string;
      }[];
      expect(row!.userId).toBe('u-current');
      expect(row!.name).toBe('Ada Current');
      expect(row!.email).toBe('ada@example.com');
      expect(row!.status).toBe('held');
      expect(row!.current).toBe(true);
      expect(row!.expiresAt).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('derives the expiry from the grant date and the competency period', async () => {
    // Not just "a date" — three years on from the day this person earned it.
    // The date portion only: the derivation adds months calendrically in local
    // time, so the instant can differ by an offset while the day does not.
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-current', grantedAt: new Date('2024-01-15T00:00:00.000Z'), revokedAt: null },
      ],
      usersFindMany: PEOPLE,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const [row] = (await res.json()) as { grantedAt: string; expiresAt: string }[];
      expect(row!.grantedAt).toBe('2024-01-15T00:00:00.000Z');
      expect(row!.expiresAt.slice(0, 10)).toBe('2027-01-15');
    } finally {
      server.close();
    }
  });

  it('reads a holder with no grant date at all as its own status, not a crash (R153, reversed)', async () => {
    // A migrated grant whose source never recorded a date. It still counts —
    // the person genuinely holds it — but must not read as an ordinary `held`
    // record, and must not throw computing an expiry with nothing to derive
    // from.
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [{ userId: 'u-current', grantedAt: null, revokedAt: null }],
      usersFindMany: PEOPLE,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      expect(res.status).toBe(200);
      const [row] = (await res.json()) as {
        grantedAt: string | null;
        expiresAt: string | null;
        status: string;
        current: boolean;
      }[];
      expect(row!.grantedAt).toBeNull();
      expect(row!.expiresAt).toBeNull();
      expect(row!.status).toBe('undated');
      expect(row!.current).toBe(true);
    } finally {
      server.close();
    }
  });

  it('lets an explicit expiry resolve a holder with no grant date — not undated, an ordinary dated state', async () => {
    // The driver's-licence case: the org knows exactly when it expires even
    // though no grant date was ever recorded.
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-current', grantedAt: null, expiresAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000), revokedAt: null },
      ],
      usersFindMany: PEOPLE,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });
      const [row] = (await res.json()) as { grantedAt: string | null; status: string; current: boolean }[];
      expect(row!.grantedAt).toBeNull();
      expect(row!.status).toBe('held');
      expect(row!.current).toBe(true);
    } finally {
      server.close();
    }
  });

  it('orders dated holders ahead of undated ones within a status group', async () => {
    /*
      A competency with no validity, where individual grants carry an imported
      expiry — which is what the per-grant `expiresAt` override exists for. The
      comparator used to compare dates only when BOTH sides had one and fall
      through to the name otherwise, which is intransitive: the resulting order
      then depended on the order rows came back in rather than on the data.
    */
    const PERPETUAL = { ...TRACK_DOZER, validForMonths: null };
    mockDbValue = fakeDb({
      competenciesFindFirst: PERPETUAL,
      competencyHoldersFindMany: [
        { userId: 'u-current', grantedAt: ago(10), revokedAt: null },
        {
          userId: 'u-soon',
          grantedAt: ago(10),
          expiresAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
          revokedAt: null,
        },
        {
          userId: 'u-lapsed',
          grantedAt: ago(10),
          expiresAt: new Date(Date.now() + 200 * 24 * 60 * 60 * 1000),
          revokedAt: null,
        },
      ],
      usersFindMany: PEOPLE,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const rows = (await res.json()) as { name: string; status: string; expiresAt: string | null }[];
      // All three are 'held', so ordering is decided entirely by the tie-break.
      expect(rows.map((r) => r.status)).toEqual(['held', 'held', 'held']);
      expect(rows.map((r) => r.name)).toEqual(['Bo Lapsed', 'Cy Soon', 'Ada Current']);
      expect(rows[2]!.expiresAt).toBeNull();
    } finally {
      server.close();
    }
  });

  it('puts who needs doing something first, not who is alphabetically first', async () => {
    /*
      Ada is fine, Bo has lapsed, Cy is close. Alphabetically that is exactly
      the wrong order — the two people who need booking would sit below the one
      who does not, and on a real register they would be below two hundred.
    */
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-current', grantedAt: ago(200), revokedAt: null },
        { userId: 'u-lapsed', grantedAt: ago(5 * 365), revokedAt: null },
        { userId: 'u-soon', grantedAt: ago(3 * 365 - 40), revokedAt: null },
      ],
      usersFindMany: PEOPLE,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const rows = (await res.json()) as { name: string; status: string }[];
      expect(rows.map((r) => r.status)).toEqual(['expired', 'expiring', 'held']);
      expect(rows.map((r) => r.name)).toEqual(['Bo Lapsed', 'Cy Soon', 'Ada Current']);
    } finally {
      server.close();
    }
  });

  it('always uses the assessor window, never the candidate one', async () => {
    // Everyone reading this list is looking at other people's records to plan
    // reassessments. 40 days out is a warning here; on someone's own record it
    // would not be.
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-soon', grantedAt: ago(3 * 365 - 40), revokedAt: null },
      ],
      usersFindMany: PEOPLE,
    }).db;
    const { server, base } = startApp();
    try {
      // Even asked for as a candidate — this route has no such mode.
      const res = await fetch(`${base}/competencies/c1/holders?audience=candidate`, {
        headers: authHeader(),
      });

      const [row] = (await res.json()) as { status: string; note: string }[];
      expect(row!.status).toBe('expiring');
      expect(row!.note).toContain('expires on');
    } finally {
      server.close();
    }
  });

  it('does not invent a name when the user row is gone', async () => {
    // A grant outliving its user row means something went wrong upstream.
    // Rendering a blank cell hides it; naming it does not.
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [{ userId: 'u-vanished', grantedAt: ago(10), revokedAt: null }],
      usersFindMany: [],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const [row] = (await res.json()) as { name: string; email: null }[];
      expect(row!.name).toBe('Unknown user');
      expect(row!.email).toBeNull();
    } finally {
      server.close();
    }
  });

  it('404s for a competency outside the caller org', async () => {
    // Without the ownership check this would list another org's register from
    // an id alone.
    mockDbValue = fakeDb({ competenciesFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('returns an empty list for a competency nobody holds', async () => {
    mockDbValue = fakeDb({ competenciesFindFirst: TRACK_DOZER, competencyHoldersFindMany: [] }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('keeps a revoked grant on the register, marked and not current (R108)', async () => {
    // The grant's date says it is fine, but it was revoked — an admin auditing
    // this competency should see the holder marked revoked, not vanished.
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-current', grantedAt: ago(200), revokedAt: ago(5) },
      ],
      usersFindMany: PEOPLE,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const [row] = (await res.json()) as {
        revoked: boolean;
        current: boolean;
        status: string;
        note: string | null;
      }[];
      expect(row!.revoked).toBe(true);
      expect(row!.current).toBe(false);
      // The dated state travels beside the mark, it is not replaced by it.
      expect(row!.status).toBe('held');
      // A revoked grant's date is moot — no expiry note competes with the mark.
      expect(row!.note).toBeNull();
    } finally {
      server.close();
    }
  });

  it('sorts a revoked holder last, below even a current one', async () => {
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-lapsed', grantedAt: ago(200), revokedAt: ago(5) }, // in date, but revoked
        { userId: 'u-current', grantedAt: ago(200), revokedAt: null }, // held
        { userId: 'u-soon', grantedAt: ago(3 * 365 - 40), revokedAt: null }, // expiring
      ],
      usersFindMany: PEOPLE,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const rows = (await res.json()) as { name: string; revoked: boolean }[];
      // Expiring first (needs booking), then current, then the revoked one last.
      expect(rows.map((r) => r.name)).toEqual(['Cy Soon', 'Ada Current', 'Bo Lapsed']);
      expect(rows.map((r) => r.revoked)).toEqual([false, false, true]);
    } finally {
      server.close();
    }
  });

  it('marks a holder required when their held Role requires a tool awarding it (R108)', async () => {
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-current', grantedAt: ago(200), revokedAt: null },
      ],
      usersFindMany: PEOPLE,
      // Ada's Role requires a tool that awards this very competency.
      membershipsFindMany: [{ id: 'm-current', userId: 'u-current' }],
      membershipRolesFindMany: [{ membershipId: 'm-current', roleId: 'r1', withdrawnAt: null }],
      roleRequiredAssessmentsFindMany: [{ roleId: 'r1', toolId: 't1' }],
      assessmentToolsFindMany: [{ id: 't1', awardedCompetencyIds: ['c1'] }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const [row] = (await res.json()) as { standing: string }[];
      expect(row!.standing).toBe('required');
    } finally {
      server.close();
    }
  });

  it('marks a holder optional when no held Role requires it (R91, R108)', async () => {
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-current', grantedAt: ago(200), revokedAt: null },
      ],
      usersFindMany: PEOPLE,
      // A held Role, but its required tool awards a DIFFERENT competency.
      membershipsFindMany: [{ id: 'm-current', userId: 'u-current' }],
      membershipRolesFindMany: [{ membershipId: 'm-current', roleId: 'r1', withdrawnAt: null }],
      roleRequiredAssessmentsFindMany: [{ roleId: 'r1', toolId: 't1' }],
      assessmentToolsFindMany: [{ id: 't1', awardedCompetencyIds: ['c-other'] }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const [row] = (await res.json()) as { standing: string }[];
      expect(row!.standing).toBe('optional');
    } finally {
      server.close();
    }
  });

  it('renders BOTH source scopes for a member under a location AND a role requirement (U8, R5)', async () => {
    /*
      The plan's register test: this competency is required at the holder's
      location AND by their role, so their register row names both scopes —
      standing stays the standingOf verdict, sources say WHY it stands.
    */
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [{ userId: 'u-current', grantedAt: ago(200), revokedAt: null }],
      usersFindMany: PEOPLE,
      membershipsFindMany: [{ id: 'm-current', userId: 'u-current' }],
      membershipRolesFindMany: [{ membershipId: 'm-current', roleId: 'r1', withdrawnAt: null }],
      membershipLocationsFindMany: [{ membershipId: 'm-current', locationId: 'loc-1' }],
      locationsFindMany: [{ id: 'loc-1', orgId: 'org-1', name: 'Boddington', status: 'active' }],
      jobRolesFindMany: [{ id: 'r1', orgId: 'org-1', name: 'Dozer Operator', status: 'active' }],
      competencyRequirementsFindMany: [
        { roleId: 'r1', locationId: null, departmentId: null, competencyId: 'c1', tier: 'required' },
        { roleId: null, locationId: 'loc-1', departmentId: null, competencyId: 'c1', tier: 'required' },
      ],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const [row] = (await res.json()) as {
        standing: string;
        sources: Array<{ scope: string; name: string }>;
      }[];
      expect(row!.standing).toBe('required');
      expect(row!.sources).toEqual([
        { scope: 'location', name: 'Boddington' },
        { scope: 'role', name: 'Dozer Operator' },
      ]);
    } finally {
      server.close();
    }
  });

  it('omits register sources on a colleague’s row for a caller without the grant, keeps their own (U8)', async () => {
    /*
      The same exposure as the record read: a register row's sources enumerate
      that HOLDER's placement, so they ride the same per-holder gate the
      licence columns already use here — own row always, other rows only with
      `profiles.view_competencies === 'all'`. Omitted, never `[]`, for the
      same reason as on the record: empty would claim "nothing requires it".
    */
    const caller = { userId: 'u-current', orgId: 'org-1', role: 'candidate' as const };
    mockDbValue = fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.candidate,
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [
        { userId: 'u-current', grantedAt: ago(200), revokedAt: null },
        { userId: 'u-colleague', grantedAt: ago(300), revokedAt: null },
      ],
      usersFindMany: [
        { id: 'u-current', name: 'Ada Current', email: 'ada@x.io' },
        { id: 'u-colleague', name: 'Bo Colleague', email: 'bo@x.io' },
      ],
      membershipsFindMany: [
        { id: 'm-current', userId: 'u-current' },
        { id: 'm-colleague', userId: 'u-colleague' },
      ],
      membershipRolesFindMany: [
        { membershipId: 'm-current', roleId: 'r1', withdrawnAt: null },
        { membershipId: 'm-colleague', roleId: 'r1', withdrawnAt: null },
      ],
      jobRolesFindMany: [{ id: 'r1', orgId: 'org-1', name: 'Dozer Operator', status: 'active' }],
      competencyRequirementsFindMany: [
        { roleId: 'r1', locationId: null, departmentId: null, competencyId: 'c1', tier: 'required' },
      ],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, {
        headers: { cookie: `fai_session=${sealSession(caller)}` },
      });

      const rows = (await res.json()) as Array<Record<string, unknown> & { userId: string }>;
      const own = rows.find((r) => r.userId === 'u-current')!;
      const theirs = rows.find((r) => r.userId === 'u-colleague')!;
      expect(own.sources).toEqual([{ scope: 'role', name: 'Dozer Operator' }]);
      expect('sources' in theirs).toBe(false);
    } finally {
      server.close();
    }
  });

  it('keeps a role-only register row exactly as shipped, sources riding alongside (R11 regression)', async () => {
    // The pre-round shape — legacy tool derivation, no placement anywhere —
    // still reads required, and its source is the role that derives it.
    mockDbValue = fakeDb({
      competenciesFindFirst: TRACK_DOZER,
      competencyHoldersFindMany: [{ userId: 'u-current', grantedAt: ago(200), revokedAt: null }],
      usersFindMany: PEOPLE,
      membershipsFindMany: [{ id: 'm-current', userId: 'u-current' }],
      membershipRolesFindMany: [{ membershipId: 'm-current', roleId: 'r1', withdrawnAt: null }],
      roleRequiredAssessmentsFindMany: [{ roleId: 'r1', toolId: 't1' }],
      assessmentToolsFindMany: [{ id: 't1', awardedCompetencyIds: ['c1'] }],
      jobRolesFindMany: [{ id: 'r1', orgId: 'org-1', name: 'Dozer Operator', status: 'active' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/c1/holders`, { headers: authHeader() });

      const [row] = (await res.json()) as { standing: string; current: boolean; sources: unknown }[];
      expect(row!.standing).toBe('required');
      expect(row!.current).toBe(true);
      expect(row!.sources).toEqual([{ scope: 'role', name: 'Dozer Operator' }]);
    } finally {
      server.close();
    }
  });
});

describe('GET /competencies/recommended (U7 — R12, R14, KTD2)', () => {
  // Self-scope: the caller is the subject, so the read works for a candidate.
  const cand = { userId: HOLDER_ID, orgId: 'org-1', role: 'candidate' as const };
  const asUser = (t: { userId: string; orgId: string; role: string }) => ({
    cookie: `fai_session=${sealSession(t)}`,
  });
  const ago = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  /** One held Role recommending First Aid — the caller's own recommendation. */
  const recommendedFixture = {
    membershipsFindMany: [{ id: 'm1', userId: HOLDER_ID }],
    membershipRolesFindMany: [{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }],
    competencyRequirementsFindMany: [{ roleId: 'r1', competencyId: 'c1', tier: 'recommended' }],
    competenciesFindMany: [
      { id: 'c1', orgId: 'org-1', name: 'First Aid', code: 'HLTAID011', validForMonths: 36 },
    ],
    // The U8 sources read captions the recommending scope by NAME (R5, AE5).
    jobRolesFindMany: [{ id: 'r1', orgId: 'org-1', name: 'Crew Member', status: 'active' }],
  };
  /** What the fixture's recommendation sources resolve to on every item (U8). */
  const roleSources = [{ scope: 'role', name: 'Crew Member' }];

  it('lists an unheld recommendation with its bookable awarding tool and the toggle (KTD2, R14)', async () => {
    mockDbValue = fakeDb({
      ...recommendedFixture,
      selfStart: true,
      assessmentToolsFindMany: [
        {
          id: 't1',
          orgId: 'org-1',
          templateId: 'tpl-1',
          awardedCompetencyIds: ['c1'],
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      formTemplatesFindMany: [{ id: 'tpl-1', orgId: 'org-1', currentVersionId: 'v1' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/recommended`, { headers: asUser(cand) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        selfStartEnabled: true,
        items: [
          {
            competencyId: 'c1',
            name: 'First Aid',
            code: 'HLTAID011',
            held: false,
            requestableToolId: 't1',
            sources: roleSources,
          },
        ],
      });
    } finally {
      server.close();
    }
  });

  it('reads held from the caller’s own live grant, and null tool for evidence-only (R7)', async () => {
    // Nothing awards First Aid — there is no assessment to self-start, only
    // evidence to record; and the caller already holds it current.
    mockDbValue = fakeDb({
      ...recommendedFixture,
      competencyHoldersFindMany: [{ competencyId: 'c1', userId: HOLDER_ID, grantedAt: ago(100), revokedAt: null }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/recommended`, { headers: asUser(cand) });
      const body = (await res.json()) as { selfStartEnabled: boolean; items: Array<Record<string, unknown>> };
      expect(body.selfStartEnabled).toBe(false); // the stored default (R14)
      expect(body.items).toEqual([
        {
          competencyId: 'c1',
          name: 'First Aid',
          code: 'HLTAID011',
          held: true,
          requestableToolId: null,
          sources: roleSources,
        },
      ]);
    } finally {
      server.close();
    }
  });

  it('reads an UNPUBLISHED awarding tool as nothing to request — the KTD2 filter, not raw awards', async () => {
    mockDbValue = fakeDb({
      ...recommendedFixture,
      assessmentToolsFindMany: [
        {
          id: 't1',
          orgId: 'org-1',
          templateId: 'tpl-1',
          awardedCompetencyIds: ['c1'],
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      // No published version → the tool cannot carry a case → evidence-only.
      formTemplatesFindMany: [{ id: 'tpl-1', orgId: 'org-1', currentVersionId: null }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/recommended`, { headers: asUser(cand) });
      const body = (await res.json()) as { items: Array<{ requestableToolId: string | null }> };
      expect(body.items[0]!.requestableToolId).toBeNull();
    } finally {
      server.close();
    }
  });

  it('captions a LOCATION-scope recommendation "from" its site — the AE5 read side (R8, U8)', async () => {
    // Recommended follows PLACEMENT: the caller holds no role at all, and the
    // item still arrives, sourced to the location that recommends it.
    mockDbValue = fakeDb({
      membershipsFindMany: [{ id: 'm1', userId: HOLDER_ID }],
      membershipLocationsFindMany: [{ membershipId: 'm1', locationId: 'loc-1' }],
      locationsFindMany: [{ id: 'loc-1', orgId: 'org-1', name: 'Boddington', status: 'active' }],
      competencyRequirementsFindMany: [
        { roleId: null, locationId: 'loc-1', departmentId: null, competencyId: 'c1', tier: 'recommended' },
      ],
      competenciesFindMany: [
        { id: 'c1', orgId: 'org-1', name: 'First Aid', code: 'HLTAID011', validForMonths: 36 },
      ],
      selfStart: true,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/recommended`, { headers: asUser(cand) });
      const body = (await res.json()) as {
        items: Array<{ sources: Array<{ scope: string; name: string }> }>;
      };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.sources).toEqual([{ scope: 'location', name: 'Boddington' }]);
    } finally {
      server.close();
    }
  });

  it('drops a competency REQUIRED at one scope and recommended at another — required wins (R2)', async () => {
    /*
      TIER PRECEDENCE ACROSS SCOPES. The org requires First Aid of everyone;
      the site the caller is placed at also recommends it. Both maps of the one
      expansion name it, and reading the recommended keys raw would offer
      "request this training" for something compliance already counts as a
      REQUIRED gap and the engine has already booked. `standingOf` resolves
      required over recommended everywhere else — this route must agree.
    */
    mockDbValue = fakeDb({
      membershipsFindMany: [{ id: 'm1', userId: HOLDER_ID }],
      membershipLocationsFindMany: [{ membershipId: 'm1', locationId: 'loc-1' }],
      locationsFindMany: [{ id: 'loc-1', orgId: 'org-1', name: 'Boddington', status: 'active' }],
      competencyRequirementsFindMany: [
        { roleId: null, locationId: null, departmentId: null, competencyId: 'c1', tier: 'required' },
        { roleId: null, locationId: 'loc-1', departmentId: null, competencyId: 'c1', tier: 'recommended' },
        // A genuinely recommended-only competency, so the empty result cannot
        // be an accident of the whole read collapsing.
        { roleId: null, locationId: 'loc-1', departmentId: null, competencyId: 'c2', tier: 'recommended' },
      ],
      competenciesFindMany: [
        { id: 'c1', orgId: 'org-1', name: 'First Aid', code: 'HLTAID011', validForMonths: 36 },
        { id: 'c2', orgId: 'org-1', name: 'Site Induction', code: 'IND-01', validForMonths: null },
      ],
      selfStart: true,
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/recommended`, { headers: asUser(cand) });
      const body = (await res.json()) as { items: Array<{ competencyId: string }> };
      expect(body.items.map((i) => i.competencyId)).toEqual(['c2']);
    } finally {
      server.close();
    }
  });

  it('resolves as its own route with nothing recommended — an empty list, never a 404 (:id ordering)', async () => {
    // Pins the registration order: '/recommended' must never be swallowed as
    // a parameterised sibling's :id, even for a caller with no roles at all.
    mockDbValue = fakeDb({}).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competencies/recommended`, { headers: asUser(cand) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ selfStartEnabled: false, items: [] });
    } finally {
      server.close();
    }
  });
});
