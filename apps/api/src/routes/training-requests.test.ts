import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

const admin = { userId: 'admin-1', orgId: 'org-1', role: 'admin' as const };
const candidate = { userId: 'cand-1', orgId: 'org-1', role: 'candidate' as const };
const assessor = { userId: 'assess-1', orgId: 'org-1', role: 'assessor' as const };
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
function authHeader(t: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(t)}` };
}

const TOOL = '00000000-0000-4000-8000-0000000000a1';
const COMP = 'comp-x';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/*
  Does a WHERE carry an `is null` predicate? Of the four requirement scope
  reads (U2), only the ORG one does (all three scope columns null, KTD1) —
  how the competencyRequirements fake below tells it apart, so role-link
  fixtures never leak into it as org-wide rows. Depth-limited and schema-key-
  skipping, matching the other route fakes' where-walkers.
*/
const WHERE_SKIP = new Set(['table', 'config', 'encoder', 'decoder', 'session', 'dialect', 'default']);
function hasIsNull(node: unknown, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 12) return false;
  const rec = node as Record<string, unknown>;
  const chunks = rec.queryChunks;
  if (Array.isArray(chunks)) {
    for (const c of chunks) {
      const v = (c as { value?: unknown } | null)?.value;
      if (Array.isArray(v) && v.some((s) => typeof s === 'string' && s.includes('is null'))) return true;
      if (hasIsNull(c, depth + 1)) return true;
    }
    return false;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (WHERE_SKIP.has(k)) continue;
    if (hasIsNull(v, depth + 1)) return true;
  }
  return false;
}

function fakeDb(opts: {
  planTier?: string;
  /** The org's self-start toggle (R14, KTD6). Default OFF — the stored default. */
  selfStart?: boolean;
  tool?: Record<string, unknown>;
  existingRequest?: unknown;
  requests?: unknown[];
  membership?: unknown;
  templates?: unknown[];
  heldLocations?: unknown[];
  /** Location VALUE rows — active ones make a placement confer requirements (U2/U8). */
  locations?: unknown[];
  openCases?: unknown[];
  competencyHolders?: unknown[];
  competencies?: unknown[];
  /** The caller's memberships, for the KTD6 standing read (heldRolesByUser). */
  memberships?: unknown[];
  /** The caller's held Roles — what the relevance check derives from (KTD6). */
  membershipRoles?: unknown[];
  /** Legacy Role → tool requirements: the dual read's first half (KTD3). */
  roleRequirements?: unknown[];
  /** Direct Role → competency links: the dual read's second half (KTD1). */
  roleLinks?: unknown[];
  insertedRequest?: unknown;
  insertedCase?: unknown;
  updatedRequest?: unknown;
}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();
  const db = {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'org-1',
          planTier: opts.planTier ?? 'business',
          candidateSelfStartRecommended: opts.selfStart ?? false,
        }),
      },
      assessmentTools: {
        findFirst: vi.fn().mockResolvedValue(opts.tool),
        findMany: vi.fn().mockResolvedValue(opts.tool ? [opts.tool] : []),
      },
      trainingRequests: {
        findFirst: vi.fn().mockResolvedValue(opts.existingRequest),
        findMany: vi.fn().mockResolvedValue(opts.requests ?? []),
      },
      memberships: {
        findFirst: vi.fn().mockResolvedValue(opts.membership),
        findMany: vi.fn().mockResolvedValue(opts.memberships ?? []),
      },
      users: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-1', name: 'Ada Admin' }) },
      formTemplates: { findMany: vi.fn().mockResolvedValue(opts.templates ?? []) },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.heldLocations ?? []) },
      membershipRoles: { findMany: vi.fn().mockResolvedValue(opts.membershipRoles ?? []) },
      // Scope expansion (U2) reads the department axis and the taxonomy value
      // tables too; these fixtures stay role-shaped, so all default empty.
      // (heldLocations feeds the CASE-location read; with no `locations` rows
      // the expansion treats them as inactive, which keeps these role-only
      // relevance fixtures exactly as they were.)
      membershipDepartments: { findMany: vi.fn().mockResolvedValue([]) },
      locations: { findMany: vi.fn().mockResolvedValue(opts.locations ?? []) },
      departments: { findMany: vi.fn().mockResolvedValue([]) },
      roleRequiredAssessments: { findMany: vi.fn().mockResolvedValue(opts.roleRequirements ?? []) },
      competencyRequirements: {
        /*
          TIER-AWARE, same as the competencies-route fake: the standing loaders
          filter tier in the WHERE clause ('required' for the dual read,
          'recommended' for its sibling), and a mock returning every seeded row
          to both would let a recommended link read as required — masking
          exactly the R13/KTD6 regression these tests pin (a recommended tool
          becoming requestable with the toggle OFF).
        */
        findMany: vi.fn((args?: { where?: unknown }) => {
          const rows = (opts.roleLinks ?? []) as { tier?: string }[];
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
          // SCOPE-AWARE too (U2): only the ORG read carries an `is null`
          // shape (KTD1's all-null org row), and these role-link fixtures
          // must not answer it as org-wide rows.
          return Promise.resolve(
            hasIsNull(args?.where)
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
      assessmentCases: { findMany: vi.fn().mockResolvedValue(opts.openCases ?? []) },
      competencyHolders: { findMany: vi.fn().mockResolvedValue(opts.competencyHolders ?? []) },
      competencies: { findMany: vi.fn().mockResolvedValue(opts.competencies ?? []) },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        return {
          returning: vi
            .fn()
            .mockResolvedValue([
              table === schema.trainingRequests ? opts.insertedRequest : opts.insertedCase,
            ]),
        };
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: () => ({ returning: vi.fn().mockResolvedValue([opts.updatedRequest]) }) };
      },
    })),
  } as unknown as Db;
  // The dual standing read runs inside db.transaction (KTD3); the fake hands
  // the same surface back, since these mocks have no snapshot to isolate.
  (db as { transaction?: unknown }).transaction = async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(db);
  return { db, insertValues, updateSet };
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

const orgTool = { id: TOOL, orgId: 'org-1', name: 'Working at Heights', awardedCompetencyIds: [COMP] };

/*
  A candidate whose held Role REQUIRES the competency the tool awards — the
  role-relevant footing every candidate 201 now stands on (KTD6): the open
  catalogue closed, so a candidate request must fill a gap of their own.
*/
const relevantCandidate = {
  memberships: [{ id: 'm-cand', userId: candidate.userId, orgId: 'org-1' }],
  membershipRoles: [{ membershipId: 'm-cand', roleId: 'r1', withdrawnAt: null }],
  roleLinks: [{ roleId: 'r1', competencyId: COMP, tier: 'required' as const }],
};

describe('POST /training-requests (U22, R37, R94)', () => {
  it('records a member’s request for a tool (R94)', async () => {
    const { db, insertValues } = fakeDb({
      tool: orgTool,
      ...relevantCandidate,
      existingRequest: undefined,
      insertedRequest: { id: 'tr-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(candidate) },
      body: JSON.stringify({ toolId: TOOL }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ userId: candidate.userId, toolId: TOOL, state: 'pending' });
    // The subject written is the caller — never someone else (R37).
    expect(insertValues).toHaveBeenCalledWith(
      schema.trainingRequests,
      expect.objectContaining({ userId: candidate.userId, toolId: TOOL }),
    );
    server.close();
  });

  it('succeeds for a Candidate — the matrix grants nothing outside their own record (R37)', async () => {
    const { db } = fakeDb({
      tool: orgTool,
      ...relevantCandidate,
      insertedRequest: { id: 'tr-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(candidate) },
      body: JSON.stringify({ toolId: TOOL }),
    });
    expect(res.status).toBe(201);
    server.close();
  });

  it('is idempotent while one is still pending — no duplicate on the working list', async () => {
    const existing = { id: 'tr-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() };
    const { db, insertValues } = fakeDb({ tool: orgTool, ...relevantCandidate, existingRequest: existing });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(candidate) },
      body: JSON.stringify({ toolId: TOOL }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'tr-1', state: 'pending' });
    expect(insertValues).not.toHaveBeenCalled();
    server.close();
  });

  it('404s for a tool outside the caller org', async () => {
    const { db } = fakeDb({ tool: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(candidate) },
      body: JSON.stringify({ toolId: TOOL }),
    });
    expect(res.status).toBe(404);
    server.close();
  });
});

describe('POST /training-requests — the candidate-relevance check (U7, KTD6, R14, AE5)', () => {
  const post = (base: string, session: { userId: string; orgId: string; role: string }) =>
    fetch(`${base}/training-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(session) },
      body: JSON.stringify({ toolId: TOOL }),
    });
  const inserted = {
    id: 'tr-1',
    userId: candidate.userId,
    toolId: TOOL,
    state: 'pending',
    createdAt: new Date(),
  };

  it('201s a required-gap request with the toggle OFF — the toggle hides nothing required (AE5)', async () => {
    // The R94 voluntary flow survives for required work: self-start scoping is
    // about the RECOMMENDED tier only.
    const { db } = fakeDb({ tool: orgTool, ...relevantCandidate, selfStart: false, insertedRequest: inserted });
    mockDbValue = db;
    const { server, base } = startApp();
    expect((await post(base, candidate)).status).toBe(201);
    server.close();
  });

  it('403s tool_not_relevant for a tool outside the candidate’s roles, even with the toggle ON (KTD6)', async () => {
    // The open-catalogue abuse: a candidate self-requesting a tool none of
    // their roles require OR recommend (the assessor skill set case).
    const { db, insertValues } = fakeDb({
      tool: orgTool,
      selfStart: true,
      memberships: [{ id: 'm-cand', userId: candidate.userId, orgId: 'org-1' }],
      membershipRoles: [{ membershipId: 'm-cand', roleId: 'r1', withdrawnAt: null }],
      roleLinks: [], // their role names nothing this tool awards
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await post(base, candidate);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'tool_not_relevant' });
    expect(insertValues).not.toHaveBeenCalled();
    server.close();
  });

  it('201s a recommended-relevant request while the toggle is ON (R14, AE5)', async () => {
    const { db } = fakeDb({
      tool: orgTool,
      selfStart: true,
      memberships: [{ id: 'm-cand', userId: candidate.userId, orgId: 'org-1' }],
      membershipRoles: [{ membershipId: 'm-cand', roleId: 'r1', withdrawnAt: null }],
      roleLinks: [{ roleId: 'r1', competencyId: COMP, tier: 'recommended' }],
      insertedRequest: inserted,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    expect((await post(base, candidate)).status).toBe(201);
    server.close();
  });

  it('403s the same recommended-relevant request while the toggle is OFF (R14, AE5)', async () => {
    // Toggle OFF, the candidate's relevant set is required-only (KTD6): the
    // recommendation is visible on their record, but there is no self-start.
    const { db, insertValues } = fakeDb({
      tool: orgTool,
      selfStart: false,
      memberships: [{ id: 'm-cand', userId: candidate.userId, orgId: 'org-1' }],
      membershipRoles: [{ membershipId: 'm-cand', roleId: 'r1', withdrawnAt: null }],
      roleLinks: [{ roleId: 'r1', competencyId: COMP, tier: 'recommended' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await post(base, candidate);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'tool_not_relevant' });
    expect(insertValues).not.toHaveBeenCalled();
    server.close();
  });

  it('leaves an ALLOWLISTED tier untouched — an assessor may request anything (KTD6)', async () => {
    // owner/admin/assessor are the three unrestricted tiers; their requests
    // keep the original open-request semantics, and assignment stays the New
    // Case flow.
    const { db } = fakeDb({
      tool: orgTool,
      insertedRequest: { ...inserted, userId: assessor.userId },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    expect((await post(base, assessor)).status).toBe(201);
    server.close();
  });

  /*
    THE GATE IS AN ALLOWLIST, NOT A CANDIDATE CHECK. Keyed on
    `role === 'candidate'` it failed OPEN for every other non-privileged tier:
    a builder — whose authority is form authorship — kept the whole open
    catalogue and could self-request the assessor skill set, the exact abuse
    KTD6 exists to close. These two pin both directions on the builder tier, so
    the allowlist cannot quietly narrow back to one role.
  */
  const builder = { userId: 'build-1', orgId: 'org-1', role: 'builder' as const };

  it('403s a BUILDER requesting a tool none of their roles name (KTD6 fails safe)', async () => {
    const { db, insertValues } = fakeDb({
      tool: orgTool,
      selfStart: true,
      memberships: [{ id: 'm-build', userId: builder.userId, orgId: 'org-1' }],
      membershipRoles: [{ membershipId: 'm-build', roleId: 'r1', withdrawnAt: null }],
      roleLinks: [], // their role names nothing this tool awards
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await post(base, builder);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'tool_not_relevant' });
    expect(insertValues).not.toHaveBeenCalled();
    server.close();
  });

  it('201s a BUILDER whose own role requires the competency — scoped, not blocked', async () => {
    const { db } = fakeDb({
      tool: orgTool,
      memberships: [{ id: 'm-build', userId: builder.userId, orgId: 'org-1' }],
      membershipRoles: [{ membershipId: 'm-build', roleId: 'r1', withdrawnAt: null }],
      roleLinks: [{ roleId: 'r1', competencyId: COMP, tier: 'required' }],
      insertedRequest: { ...inserted, userId: builder.userId },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    expect((await post(base, builder)).status).toBe(201);
    server.close();
  });

  /*
    MULTI-SCOPE RE-PINS (U8, R11). The relevance check itself is UNCHANGED —
    it reads the same unioned standing sets as every other surface — so these
    pin that a recommendation or requirement arriving from a NON-role scope
    behaves exactly as the role-scope cases above: the scope that names a
    competency is invisible to the toggle logic.
  */
  const placedCandidate = {
    memberships: [{ id: 'm-cand', userId: candidate.userId, orgId: 'org-1' }],
    heldLocations: [{ membershipId: 'm-cand', locationId: 'loc-1', position: 0 }],
    locations: [{ id: 'loc-1', orgId: 'org-1', name: 'Location A', status: 'active' }],
  };

  it('201s a LOCATION-scope recommended request while the toggle is ON — no role held at all (R8, AE5)', async () => {
    const { db } = fakeDb({
      tool: orgTool,
      selfStart: true,
      ...placedCandidate,
      roleLinks: [
        { roleId: null, locationId: 'loc-1', departmentId: null, competencyId: COMP, tier: 'recommended' },
      ],
      insertedRequest: inserted,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    expect((await post(base, candidate)).status).toBe(201);
    server.close();
  });

  it('403s the same LOCATION-scope recommendation while the toggle is OFF (R14, AE5)', async () => {
    const { db, insertValues } = fakeDb({
      tool: orgTool,
      selfStart: false,
      ...placedCandidate,
      roleLinks: [
        { roleId: null, locationId: 'loc-1', departmentId: null, competencyId: COMP, tier: 'recommended' },
      ],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await post(base, candidate);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'tool_not_relevant' });
    expect(insertValues).not.toHaveBeenCalled();
    server.close();
  });

  it('201s an ORG-scope required gap with the toggle OFF — required hides behind nothing (R2, AE5)', async () => {
    const { db } = fakeDb({
      tool: orgTool,
      selfStart: false,
      memberships: [{ id: 'm-cand', userId: candidate.userId, orgId: 'org-1' }],
      roleLinks: [
        { roleId: null, locationId: null, departmentId: null, competencyId: COMP, tier: 'required' },
      ],
      insertedRequest: inserted,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    expect((await post(base, candidate)).status).toBe(201);
    server.close();
  });
});

describe('GET /training-requests (U22)', () => {
  it('lists pending requests for an Admin', async () => {
    const { db } = fakeDb({
      requests: [{ id: 'tr-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(1);
    server.close();
  });

  it('refuses a non-Admin the org-wide list', async () => {
    const { db } = fakeDb({});
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, { headers: authHeader(candidate) });
    expect(res.status).toBe(403);
    server.close();
  });
});

describe('POST /training-requests/:id/approve (U22, R94, R96)', () => {
  const pending = { id: 'tr-1', orgId: 'org-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() };
  const assignableTool = {
    id: TOOL,
    orgId: 'org-1',
    name: 'Working at Heights',
    templateId: 'tpl-1',
    awardedCompetencyIds: [COMP],
    manifest: { parts: [{ key: 'p1' }] },
    locationPartKeys: {},
    assessorStreamCompetencyIds: {},
  };

  it('assigns the tool through the ordinary assignment path (R94)', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      existingRequest: pending,
      tool: assignableTool,
      membership: { id: 'm-1', userId: candidate.userId, orgId: 'org-1' },
      templates: [{ id: 'tpl-1', currentVersionId: 'ver-1' }],
      heldLocations: [{ locationId: 'loc-1' }],
      openCases: [],
      competencyHolders: [], // holds nothing → the awarded competency is unmet → a case is created
      insertedCase: { id: 'case-1' },
      updatedRequest: { ...pending, state: 'approved' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/approve`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'approved', createdCaseIds: ['case-1'] });
    // A case was created through the assignment path…
    expect(insertValues).toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    // …and the request is marked approved.
    expect(updateSet).toHaveBeenCalledWith(
      schema.trainingRequests,
      expect.objectContaining({ state: 'approved' }),
    );
    server.close();
  });

  it('creates no case when the person already holds the competency current (R45)', async () => {
    const { db, insertValues } = fakeDb({
      existingRequest: pending,
      tool: assignableTool,
      membership: { id: 'm-1', userId: candidate.userId, orgId: 'org-1' },
      templates: [{ id: 'tpl-1', currentVersionId: 'ver-1' }],
      heldLocations: [{ locationId: 'loc-1' }],
      openCases: [],
      competencyHolders: [{ competencyId: COMP, userId: candidate.userId, grantedAt: daysAgo(30), revokedAt: null }],
      competencies: [{ id: COMP, validForMonths: 36 }],
      updatedRequest: { ...pending, state: 'approved' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/approve`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'approved', createdCaseIds: [] });
    expect(insertValues).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    server.close();
  });

  it('refuses a non-Admin', async () => {
    const { db } = fakeDb({ existingRequest: pending });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/approve`, {
      method: 'POST',
      headers: authHeader(candidate),
    });
    expect(res.status).toBe(403);
    server.close();
  });

  it('409s a request already decided', async () => {
    const { db } = fakeDb({ existingRequest: { ...pending, state: 'approved' } });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/approve`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(409);
    server.close();
  });
});

describe('POST /training-requests/:id/decline (U22)', () => {
  const pending = { id: 'tr-1', orgId: 'org-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() };

  it('declines without assigning anything (Admin)', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      existingRequest: pending,
      updatedRequest: { ...pending, state: 'declined' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/decline`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'declined' });
    expect(updateSet).toHaveBeenCalledWith(
      schema.trainingRequests,
      expect.objectContaining({ state: 'declined' }),
    );
    expect(insertValues).not.toHaveBeenCalled();
    server.close();
  });
});
