import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

const admin = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
const builder = { userId: 'u2', orgId: 'org-1', role: 'builder' as const };
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

function returningResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

// ── WHERE-aware filtering for `competency_requirements` reads ────────────────
// The scope routes (U4) address ONE scope's rows per query — role, location,
// department, or the all-null org shape (KTD1) — and the load-bearing facts
// (scope-local fingerprints, KTD7 commutation, the AE4 subtraction) live in
// those clauses. A mock returning every seeded row to every query would let
// an org save read role rows and still pass. Same machinery as
// standing.test.ts: eq/inArray terms by bound value, `is null` by column.
const SKIP_KEYS = new Set(['table', 'config', 'encoder', 'decoder', 'session', 'dialect', 'default']);

function stringValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (!node || depth > 10 || typeof node !== 'object') return out;
  const rec = node as Record<string, unknown>;
  if (typeof rec.value === 'string') out.push(rec.value);
  for (const [k, v] of Object.entries(rec)) {
    if (SKIP_KEYS.has(k)) continue;
    if (Array.isArray(v)) v.forEach((n) => stringValues(n, out, depth + 1));
    else stringValues(v, out, depth + 1);
  }
  return out;
}

function whereTerms(
  node: unknown,
  acc: { all: string[]; anyOf: string[][] } = { all: [], anyOf: [] },
  depth = 0,
): { all: string[]; anyOf: string[][] } {
  if (!node || depth > 12 || typeof node !== 'object') return acc;
  const rec = node as Record<string, unknown>;
  const chunks = rec.queryChunks;
  if (Array.isArray(chunks)) {
    const text = chunks
      .map((c) => {
        const v = (c as { value?: unknown } | null)?.value;
        return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
      })
      .join('');
    if (text.includes(' in ')) {
      const group = stringValues(chunks);
      if (group.length) acc.anyOf.push(group);
      return acc;
    }
    for (const c of chunks) whereTerms(c, acc, depth + 1);
    return acc;
  }
  if (typeof rec.value === 'string') acc.all.push(rec.value);
  for (const [k, v] of Object.entries(rec)) {
    if (SKIP_KEYS.has(k)) continue;
    whereTerms(v, acc, depth + 1);
  }
  return acc;
}

function nullColumns(node: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (!node || depth > 12 || typeof node !== 'object') return out;
  const rec = node as Record<string, unknown>;
  const chunks = rec.queryChunks;
  if (Array.isArray(chunks)) {
    for (let i = 0; i < chunks.length; i++) {
      const v = (chunks[i] as { value?: unknown } | null)?.value;
      const text = Array.isArray(v) ? v.filter((s) => typeof s === 'string').join('') : '';
      if (text.includes('is null')) {
        const col = chunks[i - 1] as { name?: unknown } | null;
        if (col && typeof col.name === 'string') out.add(col.name);
      } else {
        nullColumns(chunks[i], out, depth + 1);
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (SKIP_KEYS.has(k)) continue;
    if (Array.isArray(v)) v.forEach((n) => nullColumns(n, out, depth + 1));
    else nullColumns(v, out, depth + 1);
  }
  return out;
}

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function matchesWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (!where) return true;
  const { all, anyOf } = whereTerms(where);
  const present = new Set(Object.values(row).filter((v) => typeof v === 'string'));
  if (![...new Set(all)].every((w) => present.has(w))) return false;
  if (!anyOf.every((group) => group.some((w) => present.has(w)))) return false;
  for (const colName of nullColumns(where)) {
    if (row[camel(colName)] != null) return false;
  }
  return true;
}

function fakeDb(opts: {
  planTier?: string;
  locationsFindFirst?: unknown;
  locationsFindMany?: unknown[];
  departmentsFindFirst?: unknown;
  departmentsFindMany?: unknown[];
  jobRolesFindFirst?: unknown;
  /** The Department's Roles, for the tightening surface (U17). */
  jobRolesFindMany?: unknown[];
  /** Retirement review holder rows by axis (U18). */
  heldDepartments?: unknown[];
  /** The membership_roles row the tightening resolve re-checks as still held (U17). */
  membershipRolesFindFirst?: unknown;
  /** Rows the case-insensitive active-name clash SELECT returns. */
  nameClashRows?: unknown[];
  inserted?: unknown;
  updated?: unknown;
  /*
    Reads the requirement-change compute (U12) makes. Defaulting them all to
    empty makes the change a no-op — zero holders, so all effect counters are 0 —
    which is all the endpoint-wiring tests here need; the counting itself is unit
    tested in requirement-change.test.ts. A single-holder apply test overrides a
    few of these to prove a case is inserted.
  */
  currentRequirements?: unknown[];
  /** Direct role→competency links (U3, KTD2) — the requirement store the PUT owns. */
  roleLinks?: unknown[];
  holders?: unknown[];
  memberships?: unknown[];
  tools?: unknown[];
  templates?: unknown[];
  heldLocations?: unknown[];
  openCases?: unknown[];
  competencyHolders?: unknown[];
  competencies?: unknown[];
  /** Names for the tightening-review surface (U17). */
  usersFindMany?: unknown[];
}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();
  const deleteWhere = vi.fn();
  const db = {
    query: {
      organizations: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'org-1', planTier: opts.planTier ?? 'business' }),
      },
      locations: {
        findFirst: vi.fn().mockResolvedValue(opts.locationsFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.locationsFindMany ?? []),
      },
      departments: {
        findFirst: vi.fn().mockResolvedValue(opts.departmentsFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.departmentsFindMany ?? []),
      },
      jobRoles: {
        findFirst: vi.fn().mockResolvedValue(opts.jobRolesFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.jobRolesFindMany ?? []),
      },
      users: {
        findFirst: vi.fn().mockResolvedValue({ name: 'Ada' }),
        findMany: vi.fn().mockResolvedValue(opts.usersFindMany ?? []),
      },
      // The requirement-change compute (U11/U12) reads these. Empty by default.
      membershipRoles: {
        findFirst: vi.fn().mockResolvedValue(opts.membershipRolesFindFirst),
        findMany: vi.fn().mockResolvedValue(opts.holders ?? []),
      },
      roleRequiredAssessments: { findMany: vi.fn().mockResolvedValue(opts.currentRequirements ?? []) },
      // WHERE-honouring (U4): each scope's queries see ONLY their own rows —
      // seed rows with explicit scope columns. `mockResolvedValueOnce` still
      // overrides per-call where a test sequences reads by hand.
      competencyRequirements: {
        findMany: vi.fn(async (args?: { where?: unknown }) =>
          (opts.roleLinks ?? []).filter((r) => matchesWhere(r as Record<string, unknown>, args?.where)),
        ),
      },
      memberships: {
        findFirst: vi.fn(async () => (opts.memberships ?? [])[0]),
        findMany: vi.fn().mockResolvedValue(opts.memberships ?? []),
      },
      assessmentTools: { findMany: vi.fn().mockResolvedValue(opts.tools ?? []) },
      formTemplates: { findMany: vi.fn().mockResolvedValue(opts.templates ?? []) },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.heldLocations ?? []) },
      membershipDepartments: { findMany: vi.fn().mockResolvedValue(opts.heldDepartments ?? []) },
      assessmentCases: { findMany: vi.fn().mockResolvedValue(opts.openCases ?? []) },
      competencyHolders: { findMany: vi.fn().mockResolvedValue(opts.competencyHolders ?? []) },
      competencies: { findMany: vi.fn().mockResolvedValue(opts.competencies ?? []) },
    },
    select: vi.fn(() => ({
      from: () => ({ where: () => Promise.resolve(opts.nameClashRows ?? []) }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        return returningResult([opts.inserted]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: () => returningResult([opts.updated]) };
      },
    })),
    delete: vi.fn((table: unknown) => ({
      where: (w: unknown) => {
        deleteWhere(table, w);
        return Promise.resolve(undefined);
      },
    })),
    // The U12 apply writes inside a transaction; run the callback against the
    // same spies so the assertions see its delete/insert/update.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  } as unknown as Db;
  return { db, insertValues, updateSet, deleteWhere };
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

describe('POST /taxonomy/locations', () => {
  it('lets an Admin on Business create a Location', async () => {
    const { db } = fakeDb({
      inserted: { id: 'loc-1', name: 'Raw Materials', status: 'active', createdAt: new Date() },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ name: 'Raw Materials' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: 'Raw Materials', status: 'active' });
    server.close();
  });

  it('refuses a Builder (R12)', async () => {
    const { db } = fakeDb({});
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(builder) },
      body: JSON.stringify({ name: 'Raw Materials' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
    server.close();
  });

  it('refuses a Team-tier organisation on the plan gate (R13, R14)', async () => {
    const { db } = fakeDb({ planTier: 'team' });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ name: 'Raw Materials' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'feature_not_available' });
    server.close();
  });

  it('refuses a second active Location whose name differs only in case', async () => {
    const { db } = fakeDb({ nameClashRows: [{ id: 'loc-existing' }] });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ name: 'raw materials' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'duplicate_name' });
    server.close();
  });
});

describe('PATCH /taxonomy/locations/:id', () => {
  it('retires an in-use Location immediately (R114, R115)', async () => {
    const { db, updateSet } = fakeDb({
      locationsFindFirst: { id: 'loc-1', orgId: 'org-1', name: 'Raw Materials', status: 'active' },
      updated: { id: 'loc-1', name: 'Raw Materials', status: 'retired', createdAt: new Date() },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/loc-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ status: 'retired' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'retired' });
    expect(updateSet).toHaveBeenCalledWith(schema.locations, expect.objectContaining({ status: 'retired' }));
    server.close();
  });

  it('404s a Location in another organisation (R2)', async () => {
    const { db } = fakeDb({ locationsFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/loc-x`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ name: 'Elsewhere' }),
    });
    expect(res.status).toBe(404);
    server.close();
  });
});

describe('POST /taxonomy/departments/:departmentId/roles', () => {
  it('creates a Role within its Department (R5)', async () => {
    const { db, insertValues } = fakeDb({
      departmentsFindFirst: { id: 'dep-1', orgId: 'org-1', name: 'Operations' },
      inserted: { id: 'role-1', departmentId: 'dep-1', name: 'Dozer Operator', status: 'active', createdAt: new Date() },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/dep-1/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ name: 'Dozer Operator' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ departmentId: 'dep-1', name: 'Dozer Operator' });
    expect(insertValues).toHaveBeenCalledWith(
      schema.jobRoles,
      expect.objectContaining({ departmentId: 'dep-1', name: 'Dozer Operator' }),
    );
    server.close();
  });

  it('404s when the Department is not the organisation`s', async () => {
    const { db } = fakeDb({ departmentsFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/dep-x/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ name: 'Dozer Operator' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'department_not_found' });
    server.close();
  });
});

describe('Role requirements in competency terms (U3 — R5, R6, R50, KTD9)', () => {
  // Competency and tool ids are validated as UUIDs in the bodies.
  const COMP_A = '00000000-0000-4000-8000-0000000000f1';
  const COMP_B = '00000000-0000-4000-8000-0000000000f2';
  const COMP_X = '00000000-0000-4000-8000-0000000000f3';
  const TOOL_L = '00000000-0000-4000-8000-0000000000a1';
  const activeRole = (over: Record<string, unknown> = {}) => ({
    id: 'role-1',
    orgId: 'org-1',
    name: 'Dozer Operator',
    status: 'active',
    requirementsConfigured: false,
    ...over,
  });
  const link = (competencyId: string, tier: 'required' | 'recommended') => ({
    id: `link-${competencyId}`,
    orgId: 'org-1',
    roleId: 'role-1',
    competencyId,
    tier,
  });
  const orgComps = [
    { id: COMP_A, orgId: 'org-1', name: 'ATO - Track Dozer' },
    { id: COMP_B, orgId: 'org-1', name: 'First Aid' },
  ];
  /** GET the current state — the fingerprint every write must echo (KTD9). */
  async function getState(base: string) {
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      headers: authHeader(admin),
    });
    return (await res.json()) as {
      configured: boolean;
      required: string[];
      recommended: string[];
      awaitingLink: string[];
      fingerprint: string;
    };
  }

  it('reads links by tier plus legacy rows as awaitingLink, with a fingerprint (R5, R6, R15)', async () => {
    const { db } = fakeDb({
      jobRolesFindFirst: activeRole({ requirementsConfigured: true }),
      roleLinks: [link(COMP_A, 'required'), link(COMP_B, 'recommended')],
      currentRequirements: [{ orgId: 'org-1', roleId: 'role-1', toolId: TOOL_L }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const body = await getState(base);
    expect(body.configured).toBe(true);
    expect(body.required).toEqual([COMP_A]);
    expect(body.recommended).toEqual([COMP_B]);
    expect(body.awaitingLink).toEqual([TOOL_L]);
    expect(typeof body.fingerprint).toBe('string');
    expect(body.fingerprint.length).toBeGreaterThan(0);
    server.close();
  });

  it('reads unconfigured as distinct from configured-then-emptied (R49, R50)', async () => {
    // Never configured — no flag, no rows.
    const a = fakeDb({ jobRolesFindFirst: activeRole({ requirementsConfigured: false }) });
    mockDbValue = a.db;
    let app = startApp();
    let body = await getState(app.base);
    expect(body.configured).toBe(false);
    expect(body.required).toEqual([]);
    app.server.close();

    // Configured then emptied — the flag stands even with no rows.
    const b = fakeDb({ jobRolesFindFirst: activeRole({ requirementsConfigured: true }) });
    mockDbValue = b.db;
    app = startApp();
    body = await getState(app.base);
    expect(body.configured).toBe(true);
    expect(body.required).toEqual([]);
    app.server.close();
  });

  it('sets both tiers, replaces the link rows only, and flags the Role configured (R5, R6, KTD9)', async () => {
    const { db, insertValues, deleteWhere, updateSet } = fakeDb({
      jobRolesFindFirst: activeRole({ requirementsConfigured: false }),
      competencies: orgComps,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const { fingerprint } = await getState(base);
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [COMP_B], fingerprint }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: true,
      required: [COMP_A],
      recommended: [COMP_B],
    });
    // The links table is replaced; the LEGACY table is never touched by a PUT
    // (KTD9 — legacy rows exit via conversion or the explicit remove only).
    expect(deleteWhere).toHaveBeenCalledWith(schema.competencyRequirements, expect.anything());
    expect(deleteWhere).not.toHaveBeenCalledWith(schema.roleRequiredAssessments, expect.anything());
    expect(insertValues).toHaveBeenCalledWith(
      schema.competencyRequirements,
      expect.arrayContaining([
        expect.objectContaining({ roleId: 'role-1', competencyId: COMP_A, tier: 'required' }),
        expect.objectContaining({ roleId: 'role-1', competencyId: COMP_B, tier: 'recommended' }),
      ]),
    );
    expect(updateSet).toHaveBeenCalledWith(
      schema.jobRoles,
      expect.objectContaining({ requirementsConfigured: true }),
    );
    server.close();
  });

  it('409s a STALE fingerprint and leaves the converted link standing (KTD9 race)', async () => {
    // The race the fingerprint exists to close: the editor GETs (no links),
    // a backfill conversion lands a link, then the editor PUTs with the old
    // fingerprint. The PUT must 409 — its replace-write would silently erase
    // the conversion — and write NOTHING.
    const { db, deleteWhere, insertValues } = fakeDb({
      jobRolesFindFirst: activeRole(),
      competencies: orgComps,
    });
    const linksFindMany = (db as unknown as {
      query: { competencyRequirements: { findMany: ReturnType<typeof vi.fn> } };
    }).query.competencyRequirements.findMany;
    linksFindMany.mockResolvedValueOnce([]); // the GET sees no links…
    linksFindMany.mockResolvedValue([link(COMP_B, 'required')]); // …then the conversion lands
    mockDbValue = db;
    const { server, base } = startApp();
    const { fingerprint } = await getState(base);
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [], fingerprint }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'requirements_changed' });
    // The converted link survives: nothing was deleted or inserted.
    expect(deleteWhere).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalledWith(schema.competencyRequirements, expect.anything());
    server.close();
  });

  it('400s when a competency appears in BOTH tiers (tiers_overlap)', async () => {
    const { db, deleteWhere } = fakeDb({ jobRolesFindFirst: activeRole(), competencies: orgComps });
    mockDbValue = db;
    const { server, base } = startApp();
    const { fingerprint } = await getState(base);
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [COMP_A], fingerprint }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'tiers_overlap' });
    expect(deleteWhere).not.toHaveBeenCalled();
    server.close();
  });

  it('400s a competency that is not the organisation’s (mirrors the old tool check)', async () => {
    const { db } = fakeDb({
      jobRolesFindFirst: activeRole(),
      competencies: orgComps, // COMP_X is not among them
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const { fingerprint } = await getState(base);
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_X], recommended: [], fingerprint }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'competency_not_found' });
    server.close();
  });

  it('leaves an unconfigured Role UNCONFIGURED on a recommended-only save (KTD9)', async () => {
    // Recommending is not deciding what the Role demands: R50's distinction
    // is about the required set, so an empty required tier flips nothing.
    const { db, updateSet, insertValues } = fakeDb({
      jobRolesFindFirst: activeRole({ requirementsConfigured: false }),
      competencies: orgComps,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const { fingerprint } = await getState(base);
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [], recommended: [COMP_B], fingerprint }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false, recommended: [COMP_B] });
    // The recommended row IS written; the configured flag is NOT.
    expect(insertValues).toHaveBeenCalledWith(
      schema.competencyRequirements,
      expect.arrayContaining([expect.objectContaining({ competencyId: COMP_B, tier: 'recommended' })]),
    );
    expect(updateSet).not.toHaveBeenCalledWith(
      schema.jobRoles,
      expect.objectContaining({ requirementsConfigured: true }),
    );
    server.close();
  });

  it('refuses editing a retired Role (R121)', async () => {
    const { db } = fakeDb({ jobRolesFindFirst: activeRole({ status: 'retired', requirementsConfigured: true }) });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [], fingerprint: 'x' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'role_retired' });
    server.close();
  });

  it('refuses a Builder (R12 — the admin gate survives the rework)', async () => {
    const { db } = fakeDb({ jobRolesFindFirst: activeRole() });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(builder) },
      body: JSON.stringify({ required: [], recommended: [], fingerprint: 'x' }),
    });
    expect(res.status).toBe(403);
    server.close();
  });

  it('removes an awaitingLink legacy row through the fingerprint-guarded DELETE (KTD9)', async () => {
    const { db, deleteWhere } = fakeDb({
      jobRolesFindFirst: activeRole({ requirementsConfigured: true }),
      currentRequirements: [{ orgId: 'org-1', roleId: 'role-1', toolId: TOOL_L }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const { fingerprint, awaitingLink } = await getState(base);
    expect(awaitingLink).toEqual([TOOL_L]);
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments/${TOOL_L}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ fingerprint }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { awaitingLink: string[]; effects: { created: number } };
    expect(body.awaitingLink).toEqual([]);
    expect(body.effects.created).toBe(0); // a removal never creates (R85)
    expect(deleteWhere).toHaveBeenCalledWith(schema.roleRequiredAssessments, expect.anything());
    server.close();
  });

  it('409s a stale DELETE and 404s a toolId that is not an awaitingLink row', async () => {
    const { db, deleteWhere } = fakeDb({
      jobRolesFindFirst: activeRole(),
      currentRequirements: [{ orgId: 'org-1', roleId: 'role-1', toolId: TOOL_L }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const stale = await fetch(`${base}/taxonomy/roles/role-1/required-assessments/${TOOL_L}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ fingerprint: 'stale' }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'requirements_changed' });

    const { fingerprint } = await getState(base);
    const missing = await fetch(
      `${base}/taxonomy/roles/role-1/required-assessments/00000000-0000-4000-8000-0000000000a9`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...authHeader(admin) },
        body: JSON.stringify({ fingerprint }),
      },
    );
    expect(missing.status).toBe(404);
    expect(deleteWhere).not.toHaveBeenCalled();
    server.close();
  });
});

describe('Requirement change preview & apply in competency terms (U12/U3)', () => {
  const COMP_A = '00000000-0000-4000-8000-0000000000f1';
  const COMP_B = '00000000-0000-4000-8000-0000000000f2';
  const TOOL_A = '00000000-0000-4000-8000-0000000000a1';
  const activeRole = (over: Record<string, unknown> = {}) => ({
    id: 'role-1',
    orgId: 'org-1',
    name: 'Dozer Operator',
    status: 'active',
    requirementsConfigured: true,
    ...over,
  });
  const orgComps = [
    { id: COMP_A, orgId: 'org-1', name: 'ATO - Track Dozer' },
    { id: COMP_B, orgId: 'org-1', name: 'First Aid' },
  ];
  const previewReq = (
    base: string,
    body: Record<string, unknown>,
    session: { userId: string; orgId: string; role: string } = admin,
  ) =>
    fetch(`${base}/taxonomy/roles/role-1/required-assessments/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(session) },
      body: JSON.stringify({ required: [], recommended: [], ...body }),
    });

  it('previews the effects shape and writes nothing (R84, R86)', async () => {
    const { db, insertValues, updateSet, deleteWhere } = fakeDb({
      jobRolesFindFirst: activeRole(),
      competencies: orgComps,
      roleLinks: [], // adding COMP_A
      holders: [], // no holders → all counters 0, but the six fields are present
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await previewReq(base, { required: [COMP_A] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effects: Record<string, unknown> };
    expect(body.effects).toEqual({
      addedCompetencyIds: [COMP_A],
      removedCompetencyIds: [],
      affected: 0,
      created: 0,
      inFlightContinuing: 0,
      competenciesDemoting: 0,
    });
    // A preview is a read — nothing is written (R86: abandon changes nothing).
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
    server.close();
  });

  it('refuses a preview by a Builder, on a retired Role, and for a foreign competency', async () => {
    // Builder → 403 (before any load).
    let f = fakeDb({ jobRolesFindFirst: activeRole() });
    mockDbValue = f.db;
    let app = startApp();
    expect((await previewReq(app.base, { required: [COMP_A] }, builder)).status).toBe(403);
    app.server.close();

    // Retired Role → 409 (a preview an apply would refuse must refuse too).
    f = fakeDb({ jobRolesFindFirst: activeRole({ status: 'retired' }) });
    mockDbValue = f.db;
    app = startApp();
    expect(await previewReq(app.base, { required: [COMP_A] }).then((r) => r.status)).toBe(409);
    app.server.close();

    // A competency not in the org → 400.
    f = fakeDb({ jobRolesFindFirst: activeRole(), competencies: [] });
    mockDbValue = f.db;
    app = startApp();
    const res = await previewReq(app.base, { required: [COMP_A] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'competency_not_found' });
    app.server.close();
  });

  it('applies an addition: writes the link, inserts the holder’s case for the AWARDING tool, returns effects (R82, R83, R9)', async () => {
    const { db, insertValues } = fakeDb({
      jobRolesFindFirst: activeRole(),
      competencies: orgComps,
      roleLinks: [], // adding COMP_A
      holders: [{ membershipId: 'm1', roleId: 'role-1', withdrawnAt: null }],
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1' }],
      tools: [
        {
          id: TOOL_A,
          orgId: 'org-1',
          templateId: 'tpl-1',
          awardedCompetencyIds: [COMP_A], // the KTD2 resolution target
          manifest: { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] },
          locationPartKeys: {},
          assessorStreamCompetencyIds: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      templates: [{ id: 'tpl-1', orgId: 'org-1', currentVersionId: 'v1' }],
      heldLocations: [{ membershipId: 'm1', locationId: 'loc1', position: 0 }],
      openCases: [],
      competencyHolders: [], // holds nothing → the one holder is left unmet
    });
    mockDbValue = db;
    const { server, base } = startApp();
    // GET first — the PUT must echo the live fingerprint (KTD9).
    const state = (await (
      await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [], fingerprint: state.fingerprint }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effects: { affected: number; created: number } };
    expect(body.effects.affected).toBe(1);
    expect(body.effects.created).toBe(1);
    // The link row AND the holder's case (for the resolved tool) are written.
    expect(insertValues).toHaveBeenCalledWith(
      schema.competencyRequirements,
      expect.arrayContaining([expect.objectContaining({ competencyId: COMP_A, tier: 'required' })]),
    );
    expect(insertValues).toHaveBeenCalledWith(schema.assessmentCases, expect.objectContaining({ toolId: TOOL_A }));
    server.close();
  });

  it('plans NO case for a licence-type competency no assessment awards (R7, R9)', async () => {
    const { db, insertValues } = fakeDb({
      jobRolesFindFirst: activeRole(),
      competencies: orgComps,
      roleLinks: [],
      holders: [{ membershipId: 'm1', roleId: 'role-1', withdrawnAt: null }],
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1' }],
      tools: [], // nothing awards COMP_A — evidence-only
      heldLocations: [{ membershipId: 'm1', locationId: 'loc1', position: 0 }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const state = (await (
      await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [], fingerprint: state.fingerprint }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effects: { affected: number; created: number } };
    expect(body.effects.affected).toBe(1);
    expect(body.effects.created).toBe(0); // required standing grows; nothing is bookable
    expect(insertValues).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    server.close();
  });

  it('applies a removal without cancelling in-flight cases (R55)', async () => {
    const { db, insertValues, updateSet, deleteWhere } = fakeDb({
      jobRolesFindFirst: activeRole(),
      competencies: orgComps,
      // desired {A}; current {A,B} → drop B
      roleLinks: [
        { id: 'l-a', orgId: 'org-1', roleId: 'role-1', competencyId: COMP_A, tier: 'required' },
        { id: 'l-b', orgId: 'org-1', roleId: 'role-1', competencyId: COMP_B, tier: 'required' },
      ],
      holders: [{ membershipId: 'm1', roleId: 'role-1', withdrawnAt: null }],
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1' }],
      openCases: [], // no in-flight to count in this wiring test
      tools: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const state = (await (
      await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [], fingerprint: state.fingerprint }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effects: { removedCompetencyIds: string[]; created: number } };
    expect(body.effects.removedCompetencyIds).toEqual([COMP_B]);
    expect(body.effects.created).toBe(0);
    // The links are rewritten, but NO assessment case is created, deleted or
    // updated — a removal never touches a case (R55).
    expect(deleteWhere).toHaveBeenCalledWith(schema.competencyRequirements, expect.anything());
    expect(insertValues).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    expect(deleteWhere).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    expect(updateSet).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    server.close();
  });

  it('previews an awaitingLink removal through the same preview POST (KTD9, KTD10)', async () => {
    const { db, insertValues, deleteWhere } = fakeDb({
      jobRolesFindFirst: activeRole(),
      competencies: orgComps,
      currentRequirements: [{ orgId: 'org-1', roleId: 'role-1', toolId: TOOL_A }],
      holders: [{ membershipId: 'm1', roleId: 'role-1', withdrawnAt: null }],
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1' }],
      // The unlinked tool has a live case — it continues, and the preview says so.
      openCases: [{ id: 'case-1', orgId: 'org-1', candidateUserId: 'u1', toolId: TOOL_A, state: 'open' }],
      tools: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await previewReq(base, { removeLegacyToolIds: [TOOL_A] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effects: { inFlightContinuing: number; created: number } };
    expect(body.effects.inFlightContinuing).toBe(1);
    expect(body.effects.created).toBe(0);
    // Still a preview: nothing written.
    expect(insertValues).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
    server.close();
  });
});

describe('Scope-addressed requirements (U4 — KTD5, KTD6, KTD7)', () => {
  const COMP_A = '00000000-0000-4000-8000-0000000000f1';
  const COMP_B = '00000000-0000-4000-8000-0000000000f2';
  const TOOL_A = '00000000-0000-4000-8000-0000000000a1';
  const LOC = '00000000-0000-4000-8000-00000000c001';
  const DEP = '00000000-0000-4000-8000-00000000b001';
  const orgComps = [
    { id: COMP_A, orgId: 'org-1', name: 'First Aid' },
    { id: COMP_B, orgId: 'org-1', name: 'Site Induction' },
  ];
  /** Rows with EXPLICIT scope columns, so the WHERE-honouring fake separates scopes (KTD1). */
  const orgRow = (competencyId: string, tier = 'required') => ({
    id: `link-org-${competencyId}`, orgId: 'org-1', roleId: null, locationId: null, departmentId: null, competencyId, tier,
  });
  const roleRow = (competencyId: string, tier = 'required') => ({
    id: `link-role-${competencyId}`, orgId: 'org-1', roleId: 'role-1', locationId: null, departmentId: null, competencyId, tier,
  });
  const locRow = (competencyId: string, tier = 'required') => ({
    id: `link-loc-${competencyId}`, orgId: 'org-1', roleId: null, locationId: LOC, departmentId: null, competencyId, tier,
  });

  it('org GET returns only org-scope rows, with neither configured nor awaitingLink (KTD6)', async () => {
    const { db } = fakeDb({ roleLinks: [orgRow(COMP_A), roleRow(COMP_B)] });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/requirements/org`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.required).toEqual([COMP_A]); // the role row never bleeds in
    expect(body.recommended).toEqual([]);
    expect(typeof body.fingerprint).toBe('string');
    expect('configured' in body).toBe(false); // role-only fields stay role-only
    expect('awaitingLink' in body).toBe(false);
    server.close();
  });

  it('org PUT writes all-null scope rows, applies exactly the previewed cases, and audits under the organisation (AE3, R6)', async () => {
    const { db, insertValues } = fakeDb({
      roleLinks: [],
      competencies: orgComps,
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1', status: 'active' }],
      heldLocations: [{ membershipId: 'm1', locationId: 'loc1', position: 0 }],
      tools: [
        {
          id: TOOL_A, orgId: 'org-1', templateId: 'tpl-1', awardedCompetencyIds: [COMP_A],
          manifest: { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] },
          locationPartKeys: {}, assessorStreamCompetencyIds: {}, createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      templates: [{ id: 'tpl-1', orgId: 'org-1', currentVersionId: 'v1' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const state = (await (
      await fetch(`${base}/taxonomy/requirements/org`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    const res = await fetch(`${base}/taxonomy/requirements/org`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [], fingerprint: state.fingerprint }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { effects: { affected: number; created: number } };
    expect(body.effects.affected).toBe(1); // every active membership (AE3)
    expect(body.effects.created).toBe(1);
    expect('configured' in body).toBe(false);
    // The link row lands with NO scope column — the all-null org shape (KTD1).
    const linkCall = insertValues.mock.calls.find(([table]) => table === schema.competencyRequirements);
    expect(linkCall).toBeDefined();
    const [linkRow] = linkCall![1] as Record<string, unknown>[];
    expect(linkRow).toMatchObject({ orgId: 'org-1', competencyId: COMP_A, tier: 'required' });
    expect(linkRow!.roleId).toBeUndefined();
    expect(linkRow!.locationId).toBeUndefined();
    expect(linkRow!.departmentId).toBeUndefined();
    // Apply == preview: exactly the counted case was inserted (KTD10 at org reach).
    expect(insertValues).toHaveBeenCalledWith(schema.assessmentCases, expect.objectContaining({ toolId: TOOL_A }));
    // The audit row names the act; the target is the organisation's own name.
    expect(insertValues).toHaveBeenCalledWith(
      schema.auditLogEntries,
      expect.objectContaining({ action: 'Set organisation required competencies' }),
    );
    server.close();
  });

  it('location PUT writes locationId rows and audits under the location name', async () => {
    const { db, insertValues } = fakeDb({
      locationsFindFirst: { id: LOC, orgId: 'org-1', name: 'Boddington', status: 'active' },
      roleLinks: [],
      competencies: orgComps,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const state = (await (
      await fetch(`${base}/taxonomy/requirements/location/${LOC}`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    const res = await fetch(`${base}/taxonomy/requirements/location/${LOC}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_B], recommended: [], fingerprint: state.fingerprint }),
    });
    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledWith(
      schema.competencyRequirements,
      expect.arrayContaining([
        expect.objectContaining({ orgId: 'org-1', locationId: LOC, competencyId: COMP_B, tier: 'required' }),
      ]),
    );
    expect(insertValues).toHaveBeenCalledWith(
      schema.auditLogEntries,
      expect.objectContaining({ action: 'Set location required competencies', target: 'Boddington' }),
    );
    server.close();
  });

  it('department PUT and role delegate PUT each audit under their own scope (U4 audit-per-scope)', async () => {
    // Department scope.
    const dept = fakeDb({
      departmentsFindFirst: { id: DEP, orgId: 'org-1', name: 'Operations', status: 'active', allowsMultipleRoles: false },
      roleLinks: [],
      competencies: orgComps,
    });
    mockDbValue = dept.db;
    let app = startApp();
    let state = (await (
      await fetch(`${app.base}/taxonomy/requirements/department/${DEP}`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    let res = await fetch(`${app.base}/taxonomy/requirements/department/${DEP}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [], fingerprint: state.fingerprint }),
    });
    expect(res.status).toBe(200);
    expect(dept.insertValues).toHaveBeenCalledWith(
      schema.auditLogEntries,
      expect.objectContaining({ action: 'Set department required competencies', target: 'Operations' }),
    );
    app.server.close();

    // Role scope, through the NEW address — same handler as the delegate.
    const role = fakeDb({
      jobRolesFindFirst: { id: 'role-1', orgId: 'org-1', name: 'Dozer Operator', status: 'active', requirementsConfigured: true },
      roleLinks: [],
      competencies: orgComps,
    });
    mockDbValue = role.db;
    app = startApp();
    state = (await (
      await fetch(`${app.base}/taxonomy/requirements/role/role-1`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    res = await fetch(`${app.base}/taxonomy/requirements/role/role-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [], fingerprint: state.fingerprint }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect('configured' in body).toBe(true); // the role shape survives the new address
    expect('awaitingLink' in body).toBe(true);
    expect(role.insertValues).toHaveBeenCalledWith(
      schema.auditLogEntries,
      expect.objectContaining({ action: 'Set role required competencies', target: 'Dozer Operator' }),
    );
    app.server.close();
  });

  it('409s scope_retired on writes at a retired location, while the GET still reads (the split, write half)', async () => {
    const { db, deleteWhere } = fakeDb({
      locationsFindFirst: { id: LOC, orgId: 'org-1', name: 'Old Site', status: 'retired' },
      roleLinks: [locRow(COMP_B)],
      competencies: orgComps,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    // Read works — a retired value's list is still inspectable.
    const get = await fetch(`${base}/taxonomy/requirements/location/${LOC}`, { headers: authHeader(admin) });
    expect(get.status).toBe(200);
    const { fingerprint } = (await get.json()) as { fingerprint: string };
    // Preview and PUT both refuse: a preview an apply would 409 must 409 too.
    const preview = await fetch(`${base}/taxonomy/requirements/location/${LOC}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [], recommended: [] }),
    });
    expect(preview.status).toBe(409);
    expect(await preview.json()).toMatchObject({ error: 'scope_retired' });
    const put = await fetch(`${base}/taxonomy/requirements/location/${LOC}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [], recommended: [], fingerprint }),
    });
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ error: 'scope_retired' });
    expect(deleteWhere).not.toHaveBeenCalled();
    server.close();
  });

  it('keeps fingerprints scope-local: an org row neither enters nor invalidates the role editor (KTD7 commute)', async () => {
    // Same role rows, two worlds — one with an org-scope row landed beside
    // them. The role fingerprint must not move, or every org save would 409
    // every open role editor.
    const without = fakeDb({
      jobRolesFindFirst: { id: 'role-1', orgId: 'org-1', name: 'Dozer', status: 'active', requirementsConfigured: true },
      roleLinks: [roleRow(COMP_B)],
    });
    mockDbValue = without.db;
    let app = startApp();
    const before = (await (
      await fetch(`${app.base}/taxonomy/roles/role-1/required-assessments`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    app.server.close();

    const withOrg = fakeDb({
      jobRolesFindFirst: { id: 'role-1', orgId: 'org-1', name: 'Dozer', status: 'active', requirementsConfigured: true },
      roleLinks: [roleRow(COMP_B), orgRow(COMP_A)],
      competencies: orgComps,
    });
    mockDbValue = withOrg.db;
    app = startApp();
    const after = (await (
      await fetch(`${app.base}/taxonomy/roles/role-1/required-assessments`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    expect(after.fingerprint).toBe(before.fingerprint); // scope-local hash (KTD7)

    // And the role editor's stale-looking-but-actually-fresh echo still saves:
    // the org row that landed in between is not this scope's state.
    const put = await fetch(`${app.base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_B], recommended: [], fingerprint: before.fingerprint }),
    });
    expect(put.status).toBe(200);
    app.server.close();
  });

  it('409s a stale fingerprint at org scope — the race guard holds per scope', async () => {
    const { db, deleteWhere } = fakeDb({ roleLinks: [], competencies: orgComps });
    const linksFindMany = (db as unknown as {
      query: { competencyRequirements: { findMany: ReturnType<typeof vi.fn> } };
    }).query.competencyRequirements.findMany;
    linksFindMany.mockResolvedValueOnce([]); // the GET sees no org rows…
    linksFindMany.mockResolvedValue([orgRow(COMP_B)]); // …then another admin's save lands
    mockDbValue = db;
    const { server, base } = startApp();
    const { fingerprint } = (await (
      await fetch(`${base}/taxonomy/requirements/org`, { headers: authHeader(admin) })
    ).json()) as { fingerprint: string };
    const res = await fetch(`${base}/taxonomy/requirements/org`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [COMP_A], recommended: [], fingerprint }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'requirements_changed' });
    expect(deleteWhere).not.toHaveBeenCalled();
    server.close();
  });

  it('400s removeLegacyToolIds outside role scope and 404s an unknown scope segment (KTD6)', async () => {
    const { db } = fakeDb({
      locationsFindFirst: { id: LOC, orgId: 'org-1', name: 'Boddington', status: 'active' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const preview = await fetch(`${base}/taxonomy/requirements/location/${LOC}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ required: [], recommended: [], removeLegacyToolIds: [TOOL_A] }),
    });
    expect(preview.status).toBe(400); // legacy rows are role machinery only
    const unknown = await fetch(`${base}/taxonomy/requirements/team/${LOC}`, {
      headers: authHeader(admin),
    });
    expect(unknown.status).toBe(404);
    server.close();
  });

  it('refuses a Builder on the scope routes (R12 — the gate survives the generalisation)', async () => {
    const { db } = fakeDb({});
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/requirements/org`, { headers: authHeader(builder) });
    expect(res.status).toBe(403);
    server.close();
  });
});

describe('PATCH /taxonomy/settings (R24, R25, R40)', () => {
  it('persists the display-identifier choice', async () => {
    const { db, updateSet } = fakeDb({
      updated: {
        allowMultipleLocations: true,
        allowMultipleDepartments: false,
        displayIdentifier: 'swipe_card_number',
      },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ allowMultipleLocations: true, displayIdentifier: 'swipe_card_number' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      allowMultipleLocations: true,
      displayIdentifier: 'swipe_card_number',
    });
    expect(updateSet).toHaveBeenCalledWith(
      schema.organizations,
      expect.objectContaining({ displayIdentifier: 'swipe_card_number' }),
    );
    server.close();
  });

  it('persists the date-format choice, and defaults to dmy when unset', async () => {
    const { db, updateSet } = fakeDb({ updated: { dateFormat: 'mdy' } });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ dateFormat: 'mdy' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dateFormat: 'mdy' });
    expect(updateSet).toHaveBeenCalledWith(
      schema.organizations,
      expect.objectContaining({ dateFormat: 'mdy' }),
    );
    server.close();
  });

  it('refuses a value outside the enum rather than writing it through', async () => {
    const { db, updateSet } = fakeDb({});
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ dateFormat: 'ymd' }),
    });
    expect(res.status).toBe(400);
    expect(updateSet).not.toHaveBeenCalled();
    server.close();
  });
});

// ── U17: Role withdrawal and demotion ────────────────────────────────────────

describe('POST /taxonomy/roles/:id/stop-offering (U17, R52)', () => {
  const ROLE = '00000000-0000-4000-8000-0000000000b1';
  const activeRole = (over: Record<string, unknown> = {}) => ({
    id: ROLE,
    orgId: 'org-1',
    name: 'Dozer Operator',
    departmentId: 'dep-1',
    status: 'active',
    requirementsConfigured: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });

  it('retires the Role and withdraws it from every holder, no choice', async () => {
    const { db, updateSet, deleteWhere } = fakeDb({
      jobRolesFindFirst: activeRole(),
      updated: activeRole({ status: 'retired' }),
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/${ROLE}/stop-offering`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'retired' });
    // The Role's status flips…
    expect(updateSet).toHaveBeenCalledWith(schema.jobRoles, { status: 'retired' });
    // …and every current holder is withdrawn, marked not deleted (R52, scenario 3, 4).
    expect(updateSet).toHaveBeenCalledWith(
      schema.membershipRoles,
      expect.objectContaining({ withdrawnAt: expect.any(Date) }),
    );
    expect(deleteWhere).not.toHaveBeenCalled();
    server.close();
  });

  it('touches no assessment case — a case in flight runs to completion (R54, scenario 13)', async () => {
    const { db, insertValues } = fakeDb({
      jobRolesFindFirst: activeRole(),
      updated: activeRole({ status: 'retired' }),
    });
    mockDbValue = db;
    const { server, base } = startApp();
    await fetch(`${base}/taxonomy/roles/${ROLE}/stop-offering`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    // No assessment case is created or altered — a case in flight runs on (R54).
    // (An audit row is still written, so we scope the assertion to cases.)
    expect(insertValues).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    server.close();
  });

  it('refuses a Builder (R12)', async () => {
    const { db } = fakeDb({ jobRolesFindFirst: activeRole() });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/${ROLE}/stop-offering`, {
      method: 'POST',
      headers: authHeader(builder),
    });
    expect(res.status).toBe(403);
    server.close();
  });

  it('404s for a Role outside the caller org', async () => {
    const { db } = fakeDb({ jobRolesFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/${ROLE}/stop-offering`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(404);
    server.close();
  });
});

describe('Department tightening (U17, R110–R113)', () => {
  const DEPT = '00000000-0000-4000-8000-0000000000c1';
  const ROLE_A = '00000000-0000-4000-8000-0000000000a1';
  const ROLE_B = '00000000-0000-4000-8000-0000000000a2';
  const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
  const USER = '00000000-0000-4000-8000-0000000000f1';
  const deptRoles = [
    { id: ROLE_A, orgId: 'org-1', name: 'Dozer', departmentId: DEPT, status: 'active' },
    { id: ROLE_B, orgId: 'org-1', name: 'Grader', departmentId: DEPT, status: 'active' },
  ];

  it('surfaces a person holding more than one of the Department’s Roles (R112)', async () => {
    const { db } = fakeDb({
      departmentsFindFirst: { id: DEPT, orgId: 'org-1', name: 'Ops', allowsMultipleRoles: false },
      jobRolesFindMany: deptRoles,
      holders: [
        { membershipId: MEMBERSHIP, roleId: ROLE_A, withdrawnAt: null },
        { membershipId: MEMBERSHIP, roleId: ROLE_B, withdrawnAt: null },
      ],
      memberships: [{ id: MEMBERSHIP, userId: USER }],
      usersFindMany: [{ id: USER, name: 'Bo Multi' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEPT}/tightening-review`, {
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ membershipId: string; name: string; heldRoles: { id: string }[] }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.membershipId).toBe(MEMBERSHIP);
    expect(body[0]!.name).toBe('Bo Multi');
    expect(body[0]!.heldRoles.map((r) => r.id).sort()).toEqual([ROLE_A, ROLE_B].sort());
    server.close();
  });

  it('surfaces nobody who holds only one Role of the Department', async () => {
    const { db } = fakeDb({
      departmentsFindFirst: { id: DEPT, orgId: 'org-1', name: 'Ops', allowsMultipleRoles: false },
      jobRolesFindMany: deptRoles,
      holders: [{ membershipId: MEMBERSHIP, roleId: ROLE_A, withdrawnAt: null }],
      memberships: [{ id: MEMBERSHIP, userId: USER }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEPT}/tightening-review`, {
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    server.close();
  });

  it('resolves one person: withdraws the unchosen Role, keeps the survivor (R113)', async () => {
    const { db, updateSet, deleteWhere } = fakeDb({
      departmentsFindFirst: { id: DEPT, orgId: 'org-1', name: 'Ops', allowsMultipleRoles: false },
      jobRolesFindMany: deptRoles,
      // An active member of this org — the target must be one (R128).
      memberships: [{ id: MEMBERSHIP, orgId: 'org-1', status: 'active' }],
      // The chosen Role is re-checked as still held before anything is withdrawn.
      membershipRolesFindFirst: { id: 'mr-a', membershipId: MEMBERSHIP, roleId: ROLE_A, withdrawnAt: null },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEPT}/tightening/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ membershipId: MEMBERSHIP, survivingRoleId: ROLE_A }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, survivingRoleId: ROLE_A });
    // The other Role is withdrawn, marked not deleted (R113).
    expect(updateSet).toHaveBeenCalledWith(
      schema.membershipRoles,
      expect.objectContaining({ withdrawnAt: expect.any(Date) }),
    );
    expect(deleteWhere).not.toHaveBeenCalled();
    server.close();
  });

  it('refuses a surviving Role that is not in the Department (400)', async () => {
    const { db } = fakeDb({
      departmentsFindFirst: { id: DEPT, orgId: 'org-1', name: 'Ops', allowsMultipleRoles: false },
      jobRolesFindMany: deptRoles,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEPT}/tightening/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({
        membershipId: MEMBERSHIP,
        survivingRoleId: '00000000-0000-4000-8000-0000000000a9',
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'role_not_in_department' });
    server.close();
  });

  it('refuses a surviving Role the person does not currently hold (409)', async () => {
    const { db, updateSet } = fakeDb({
      departmentsFindFirst: { id: DEPT, orgId: 'org-1', name: 'Ops', allowsMultipleRoles: false },
      jobRolesFindMany: deptRoles,
      memberships: [{ id: MEMBERSHIP, orgId: 'org-1', status: 'active' }],
      membershipRolesFindFirst: undefined, // not held
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEPT}/tightening/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ membershipId: MEMBERSHIP, survivingRoleId: ROLE_A }),
    });
    expect(res.status).toBe(409);
    // Nothing withdrawn when the choice is refused.
    expect(updateSet).not.toHaveBeenCalled();
    server.close();
  });

  it('refuses to resolve a membership that is not an active member of the org (404, R128)', async () => {
    const { db, updateSet } = fakeDb({
      departmentsFindFirst: { id: DEPT, orgId: 'org-1', name: 'Ops', allowsMultipleRoles: false },
      jobRolesFindMany: deptRoles,
      memberships: [], // deactivated / foreign → not an active target
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEPT}/tightening/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ membershipId: MEMBERSHIP, survivingRoleId: ROLE_A }),
    });
    expect(res.status).toBe(404);
    expect(updateSet).not.toHaveBeenCalled();
    server.close();
  });

  it('excludes an over-holder whose membership is not active from the review (R128)', async () => {
    // Two held Roles, but the active-membership load returns nobody (they were
    // deactivated), so the review drops them rather than surfacing dead work.
    const { db } = fakeDb({
      departmentsFindFirst: { id: DEPT, orgId: 'org-1', name: 'Ops', allowsMultipleRoles: false },
      jobRolesFindMany: deptRoles,
      holders: [
        { membershipId: MEMBERSHIP, roleId: ROLE_A, withdrawnAt: null },
        { membershipId: MEMBERSHIP, roleId: ROLE_B, withdrawnAt: null },
      ],
      memberships: [], // active-membership load returns nobody
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEPT}/tightening-review`, {
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    server.close();
  });

  it('refuses a Builder on both tightening routes (R12)', async () => {
    const { db } = fakeDb({
      departmentsFindFirst: { id: DEPT, orgId: 'org-1', name: 'Ops', allowsMultipleRoles: false },
      jobRolesFindMany: deptRoles,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const review = await fetch(`${base}/taxonomy/departments/${DEPT}/tightening-review`, {
      headers: authHeader(builder),
    });
    expect(review.status).toBe(403);
    const resolve = await fetch(`${base}/taxonomy/departments/${DEPT}/tightening/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(builder) },
      body: JSON.stringify({ membershipId: MEMBERSHIP, survivingRoleId: ROLE_A }),
    });
    expect(resolve.status).toBe(403);
    server.close();
  });
});

// ── U18: Retirement review and remediation ───────────────────────────────────

describe('GET /taxonomy/retirement-review (U18, R116, R123, R128)', () => {
  const LOC_X = '00000000-0000-4000-8000-00000000c001';
  const ROLE_X = '00000000-0000-4000-8000-00000000d001';
  const M1 = '00000000-0000-4000-8000-00000000e001';
  const U1 = '00000000-0000-4000-8000-00000000f001';

  it('lists the active people still holding a retired value (R116)', async () => {
    const { db } = fakeDb({
      locationsFindMany: [{ id: LOC_X, orgId: 'org-1', name: 'Old Site', status: 'retired' }],
      heldLocations: [{ membershipId: M1, locationId: LOC_X }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      usersFindMany: [{ id: U1, name: 'Bo Holder' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/retirement-review`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      locations: Array<{ id: string; name: string; holders: Array<{ name: string }> }>;
      departments: unknown[];
      roles: unknown[];
    };
    expect(body.locations).toHaveLength(1);
    expect(body.locations[0]!.id).toBe(LOC_X);
    expect(body.locations[0]!.holders.map((h) => h.name)).toEqual(['Bo Holder']);
    expect(body.roles).toEqual([]);
    server.close();
  });

  it('lists a retired Role still held, carrying its Department (R116)', async () => {
    const { db } = fakeDb({
      jobRolesFindMany: [
        { id: ROLE_X, orgId: 'org-1', name: 'Old Role', departmentId: 'dep-9', status: 'retired' },
      ],
      holders: [{ membershipId: M1, roleId: ROLE_X, withdrawnAt: null }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      usersFindMany: [{ id: U1, name: 'Ada Role' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/retirement-review`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      locations: unknown[];
      roles: Array<{ id: string; departmentId: string; holders: Array<{ name: string }> }>;
    };
    expect(body.locations).toEqual([]);
    expect(body.roles).toHaveLength(1);
    expect(body.roles[0]!.id).toBe(ROLE_X);
    expect(body.roles[0]!.departmentId).toBe('dep-9');
    expect(body.roles[0]!.holders.map((h) => h.name)).toEqual(['Ada Role']);
    server.close();
  });

  it('lists a retired Department still held (R116)', async () => {
    const DEP_X = '00000000-0000-4000-8000-00000000b001';
    const { db } = fakeDb({
      departmentsFindMany: [{ id: DEP_X, orgId: 'org-1', name: 'Old Dept', status: 'retired' }],
      heldDepartments: [{ membershipId: M1, departmentId: DEP_X }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      usersFindMany: [{ id: U1, name: 'Ada Dept' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/retirement-review`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      departments: Array<{ id: string; holders: Array<{ name: string }> }>;
    };
    expect(body.departments).toHaveLength(1);
    expect(body.departments[0]!.id).toBe(DEP_X);
    expect(body.departments[0]!.holders.map((h) => h.name)).toEqual(['Ada Dept']);
    server.close();
  });

  it('omits a retired value nobody holds — the review is empty then (R123)', async () => {
    const { db } = fakeDb({
      locationsFindMany: [{ id: LOC_X, orgId: 'org-1', name: 'Old Site', status: 'retired' }],
      jobRolesFindMany: [{ id: ROLE_X, orgId: 'org-1', name: 'Old Role', status: 'retired' }],
      heldLocations: [],
      holders: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/retirement-review`, { headers: authHeader(admin) });
    const body = (await res.json()) as { locations: unknown[]; roles: unknown[] };
    expect(body.locations).toEqual([]);
    expect(body.roles).toEqual([]);
    server.close();
  });

  it('refuses a Builder (R12)', async () => {
    const { db } = fakeDb({});
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/retirement-review`, { headers: authHeader(builder) });
    expect(res.status).toBe(403);
    server.close();
  });
});

describe('Location transfer (U18, R132-R134)', () => {
  const LOC_X = '00000000-0000-4000-8000-00000000c001';
  const LOC_Y = '00000000-0000-4000-8000-00000000c002';
  const M1 = '00000000-0000-4000-8000-00000000e001';
  const U1 = '00000000-0000-4000-8000-00000000f001';
  const CASE1 = '00000000-0000-4000-8000-000000009001';
  const setup = () => ({
    locationsFindFirst: { id: LOC_X, orgId: 'org-1', name: 'Old Site', status: 'retired' },
    heldLocations: [{ membershipId: M1, locationId: LOC_X }],
    memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
    openCases: [{ id: CASE1, orgId: 'org-1', candidateUserId: U1, locationId: LOC_X, state: 'open' }],
  });

  it('previews the people moved and the in-flight cases touched (R132)', async () => {
    const { db } = fakeDb(setup());
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/${LOC_X}/transfer/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementLocationId: LOC_Y }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ peopleMoved: 1, inFlightCases: 1 });
    server.close();
  });

  it('carry leaves every in-flight case on its original Location (R133, R134)', async () => {
    const { db, updateSet } = fakeDb(setup());
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/${LOC_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementLocationId: LOC_Y, caseOutcome: 'carry' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ peopleMoved: 1, casesCarried: 1, casesRewritten: 0 });
    expect(updateSet).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    server.close();
  });

  it('rewrite moves every in-flight case to the replacement Location (R133, R134)', async () => {
    const { db, updateSet } = fakeDb(setup());
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/${LOC_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementLocationId: LOC_Y, caseOutcome: 'rewrite' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ peopleMoved: 1, casesRewritten: 1 });
    expect(updateSet).toHaveBeenCalledWith(schema.assessmentCases, { locationId: LOC_Y });
    server.close();
  });

  it('refuses transferring a Location to itself', async () => {
    const { db } = fakeDb(setup());
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/${LOC_X}/transfer/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementLocationId: LOC_X }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'same_location' });
    server.close();
  });
});

describe('Role transfer (U18, R135)', () => {
  const ROLE_X = '00000000-0000-4000-8000-00000000d001';
  const ROLE_Y = '00000000-0000-4000-8000-00000000d002';
  const M1 = '00000000-0000-4000-8000-00000000e001';
  const U1 = '00000000-0000-4000-8000-00000000f001';

  it('withdraws the retired Role, gives the replacement, and touches no case (R135)', async () => {
    const { db, updateSet, insertValues } = fakeDb({
      jobRolesFindFirst: { id: ROLE_X, orgId: 'org-1', name: 'Old Role', departmentId: 'dep-1', status: 'retired', createdAt: new Date() },
      holders: [{ id: 'mr-x', membershipId: M1, roleId: ROLE_X, withdrawnAt: null }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/${ROLE_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementRoleId: ROLE_Y }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ peopleMoved: 1 });
    expect(updateSet).toHaveBeenCalledWith(
      schema.membershipRoles,
      expect.objectContaining({ withdrawnAt: expect.any(Date) }),
    );
    expect(updateSet).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    expect(insertValues).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    server.close();
  });

  it('refuses transferring a Role to itself', async () => {
    const { db } = fakeDb({
      jobRolesFindFirst: { id: ROLE_X, orgId: 'org-1', name: 'Old Role', departmentId: 'dep-1', status: 'retired', createdAt: new Date() },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/${ROLE_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementRoleId: ROLE_X }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'same_role' });
    server.close();
  });
});

describe('Department transfer (U18, R135)', () => {
  const DEP_X = '00000000-0000-4000-8000-00000000b001';
  const DEP_Y = '00000000-0000-4000-8000-00000000b002';
  const ROLE_A = '00000000-0000-4000-8000-00000000d001';
  const M1 = '00000000-0000-4000-8000-00000000e001';
  const U1 = '00000000-0000-4000-8000-00000000f001';

  it('repoints the placement, withdraws the Department’s Roles, and touches no case (R135)', async () => {
    const { db, updateSet, insertValues } = fakeDb({
      departmentsFindFirst: { id: DEP_X, orgId: 'org-1', name: 'Old Dept', status: 'retired', createdAt: new Date() },
      heldDepartments: [{ id: 'md-x', membershipId: M1, departmentId: DEP_X }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      // The retired Department's Roles — withdrawn on the way out.
      jobRolesFindMany: [{ id: ROLE_A, orgId: 'org-1', departmentId: DEP_X, status: 'active' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEP_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementDepartmentId: DEP_Y }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ peopleMoved: 1 });
    // Placement repointed to the replacement Department.
    expect(updateSet).toHaveBeenCalledWith(schema.membershipDepartments, { departmentId: DEP_Y });
    // The Department's held Role withdrawn (marked, not deleted).
    expect(updateSet).toHaveBeenCalledWith(
      schema.membershipRoles,
      expect.objectContaining({ withdrawnAt: expect.any(Date) }),
    );
    // No case is touched.
    expect(updateSet).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    expect(insertValues).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    server.close();
  });

  it('drops the retired row when the person already holds the replacement Department', async () => {
    const { db, updateSet, deleteWhere } = fakeDb({
      departmentsFindFirst: { id: DEP_X, orgId: 'org-1', name: 'Old Dept', status: 'retired', createdAt: new Date() },
      heldDepartments: [
        { id: 'md-x', membershipId: M1, departmentId: DEP_X },
        { id: 'md-y', membershipId: M1, departmentId: DEP_Y },
      ],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEP_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementDepartmentId: DEP_Y }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ peopleMoved: 1 });
    // Already holds DEP_Y → drop the DEP_X row rather than repoint into a clash.
    expect(deleteWhere).toHaveBeenCalledWith(schema.membershipDepartments, expect.anything());
    expect(updateSet).not.toHaveBeenCalledWith(
      schema.membershipDepartments,
      expect.objectContaining({ departmentId: DEP_Y }),
    );
    server.close();
  });

  it('refuses transferring a Department to itself', async () => {
    const { db } = fakeDb({
      departmentsFindFirst: { id: DEP_X, orgId: 'org-1', name: 'Old Dept', status: 'retired', createdAt: new Date() },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEP_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementDepartmentId: DEP_X }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'same_department' });
    server.close();
  });

  it('refuses a Builder (R12)', async () => {
    const { db } = fakeDb({});
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEP_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(builder) },
      body: JSON.stringify({ replacementDepartmentId: DEP_Y }),
    });
    expect(res.status).toBe(403);
    server.close();
  });
});

// ── U5: placement writes re-plan; retirement carries its requirement fallout ─

describe('Placement writes re-plan (U5 — KTD8, R7, AE2)', () => {
  const LOC_X = '00000000-0000-4000-8000-00000000c001';
  const LOC_Y = '00000000-0000-4000-8000-00000000c002';
  const DEP_X = '00000000-0000-4000-8000-00000000b001';
  const DEP_Y = '00000000-0000-4000-8000-00000000b002';
  const ROLE_X = '00000000-0000-4000-8000-00000000d001';
  const ROLE_Y = '00000000-0000-4000-8000-00000000d002';
  const M1 = '00000000-0000-4000-8000-00000000e001';
  const U1 = '00000000-0000-4000-8000-00000000f001';
  const COMP = '00000000-0000-4000-8000-0000000000f1';
  const TOOL = '00000000-0000-4000-8000-0000000000a1';
  /** A published tool awarding COMP — what makes a requirement bookable. */
  const bookable = {
    tools: [
      {
        id: TOOL, orgId: 'org-1', templateId: 'tpl-1', awardedCompetencyIds: [COMP],
        manifest: { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] },
        locationPartKeys: {}, assessorStreamCompetencyIds: {}, createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ],
    templates: [{ id: 'tpl-1', orgId: 'org-1', currentVersionId: 'v1' }],
  };

  it('AE2: a location transfer immediately plans the newly-required case', async () => {
    // LOC_Y requires COMP. The fake has no live store, so the post-transfer
    // world is seeded directly: the member's placement row already reads
    // LOC_Y (the transfer's own holder read ignores the WHERE either way).
    const { db, insertValues } = fakeDb({
      locationsFindFirst: { id: LOC_X, orgId: 'org-1', name: 'Old Site', status: 'retired' },
      locationsFindMany: [{ id: LOC_Y, orgId: 'org-1', name: 'New Site', status: 'active' }],
      heldLocations: [{ membershipId: M1, locationId: LOC_Y, position: 0 }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      roleLinks: [
        { id: 'req-y', orgId: 'org-1', roleId: null, locationId: LOC_Y, departmentId: null, competencyId: COMP, tier: 'required' },
      ],
      ...bookable,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/${LOC_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementLocationId: LOC_Y, caseOutcome: 'carry' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ peopleMoved: 1 });
    // The newly-required bookable competency got its case WITHOUT any admin
    // touching a requirements screen (AE2) — the transfer re-planned.
    expect(insertValues).toHaveBeenCalledWith(
      schema.assessmentCases,
      expect.objectContaining({ toolId: TOOL, candidateUserId: U1 }),
    );
    server.close();
  });

  it('a role transfer plans the REPLACEMENT role’s newly-required case (the third dark write site)', async () => {
    const { db, insertValues } = fakeDb({
      jobRolesFindFirst: { id: ROLE_X, orgId: 'org-1', name: 'Old Role', departmentId: DEP_X, status: 'retired', createdAt: new Date() },
      // Post-transfer holding: the member now carries ROLE_Y (the transfer's
      // own holder read ignores the WHERE, so one row serves both reads).
      holders: [{ id: 'mr-y', membershipId: M1, roleId: ROLE_Y, withdrawnAt: null }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      heldLocations: [{ membershipId: M1, locationId: LOC_Y, position: 0 }],
      locationsFindMany: [{ id: LOC_Y, orgId: 'org-1', name: 'Site', status: 'active' }],
      roleLinks: [
        { id: 'req-role-y', orgId: 'org-1', roleId: ROLE_Y, locationId: null, departmentId: null, competencyId: COMP, tier: 'required' },
      ],
      ...bookable,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/${ROLE_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementRoleId: ROLE_Y }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ peopleMoved: 1 });
    expect(insertValues).toHaveBeenCalledWith(
      schema.assessmentCases,
      expect.objectContaining({ toolId: TOOL, candidateUserId: U1 }),
    );
    server.close();
  });

  it('a department transfer re-plans, and still withdraws the left department’s roles (regression)', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      departmentsFindFirst: { id: DEP_X, orgId: 'org-1', name: 'Old Dept', status: 'retired', createdAt: new Date() },
      heldDepartments: [{ id: 'md-y', membershipId: M1, departmentId: DEP_Y }],
      departmentsFindMany: [{ id: DEP_Y, orgId: 'org-1', name: 'New Dept', status: 'active' }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      heldLocations: [{ membershipId: M1, locationId: LOC_Y, position: 0 }],
      locationsFindMany: [{ id: LOC_Y, orgId: 'org-1', name: 'Site', status: 'active' }],
      // The retired Department's Role — withdrawn on the way out (R113).
      jobRolesFindMany: [{ id: ROLE_X, orgId: 'org-1', departmentId: DEP_X, status: 'active' }],
      holders: [{ id: 'mr-x', membershipId: M1, roleId: ROLE_X, withdrawnAt: null }],
      roleLinks: [
        { id: 'req-dep-y', orgId: 'org-1', roleId: null, locationId: null, departmentId: DEP_Y, competencyId: COMP, tier: 'required' },
      ],
      ...bookable,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/departments/${DEP_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementDepartmentId: DEP_Y }),
    });
    expect(res.status).toBe(200);
    // Existing behaviour holds: the left Department's Role is withdrawn…
    expect(updateSet).toHaveBeenCalledWith(
      schema.membershipRoles,
      expect.objectContaining({ withdrawnAt: expect.any(Date) }),
    );
    // …and the NEW behaviour rides beside it: the replacement Department's
    // requirement is planned immediately.
    expect(insertValues).toHaveBeenCalledWith(
      schema.assessmentCases,
      expect.objectContaining({ toolId: TOOL, candidateUserId: U1 }),
    );
    server.close();
  });

  it('a failed re-plan for one member never aborts the transfer (fail-soft pin)', async () => {
    const { db } = fakeDb({
      locationsFindFirst: { id: LOC_X, orgId: 'org-1', name: 'Old Site', status: 'retired' },
      heldLocations: [{ membershipId: M1, locationId: LOC_X }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
    });
    // The re-plan's requirement read blows up — the workforce-import posture
    // says the committed transfer stays committed and the sweep catches up.
    (db as unknown as {
      query: { competencyRequirements: { findMany: ReturnType<typeof vi.fn> } };
    }).query.competencyRequirements.findMany.mockRejectedValue(new Error('boom'));
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/${LOC_X}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ replacementLocationId: LOC_Y, caseOutcome: 'carry' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ peopleMoved: 1 });
    server.close();
  });

  it('a location status flip re-plans everyone placed there (KTD8 — retirement is not a dark write)', async () => {
    // Returning a Location to ACTIVE restores its requirements: the flip must
    // plan the restored cases itself, not leave them to the next sweep.
    const { db, insertValues } = fakeDb({
      locationsFindFirst: { id: LOC_Y, orgId: 'org-1', name: 'Site', status: 'retired' },
      updated: { id: LOC_Y, name: 'Site', status: 'active', createdAt: new Date() },
      heldLocations: [{ membershipId: M1, locationId: LOC_Y, position: 0 }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      locationsFindMany: [{ id: LOC_Y, orgId: 'org-1', name: 'Site', status: 'active' }],
      roleLinks: [
        { id: 'req-y', orgId: 'org-1', roleId: null, locationId: LOC_Y, departmentId: null, competencyId: COMP, tier: 'required' },
      ],
      ...bookable,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/${LOC_Y}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledWith(
      schema.assessmentCases,
      expect.objectContaining({ toolId: TOOL, candidateUserId: U1 }),
    );
    server.close();
  });

  it('a rename-only PATCH re-plans nobody (the flip guard)', async () => {
    const { db, insertValues } = fakeDb({
      locationsFindFirst: { id: LOC_Y, orgId: 'org-1', name: 'Site', status: 'active' },
      updated: { id: LOC_Y, name: 'Renamed', status: 'active', createdAt: new Date() },
      heldLocations: [{ membershipId: M1, locationId: LOC_Y, position: 0 }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      locationsFindMany: [{ id: LOC_Y, orgId: 'org-1', name: 'Site', status: 'active' }],
      roleLinks: [
        { id: 'req-y', orgId: 'org-1', roleId: null, locationId: LOC_Y, departmentId: null, competencyId: COMP, tier: 'required' },
      ],
      ...bookable,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/locations/${LOC_Y}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect(insertValues).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    server.close();
  });

  it('the retirement review reports "N required competencies stop applying" per retired location/department', async () => {
    const { db } = fakeDb({
      locationsFindMany: [{ id: LOC_X, orgId: 'org-1', name: 'Old Site', status: 'retired' }],
      departmentsFindMany: [{ id: DEP_X, orgId: 'org-1', name: 'Old Dept', status: 'retired' }],
      heldLocations: [{ membershipId: M1, locationId: LOC_X }],
      heldDepartments: [{ membershipId: M1, departmentId: DEP_X }],
      memberships: [{ id: M1, userId: U1, orgId: 'org-1', status: 'active' }],
      usersFindMany: [{ id: U1, name: 'Bo Holder' }],
      roleLinks: [
        { id: 'r1', orgId: 'org-1', roleId: null, locationId: LOC_X, departmentId: null, competencyId: COMP, tier: 'required' },
        { id: 'r2', orgId: 'org-1', roleId: null, locationId: LOC_X, departmentId: null, competencyId: '00000000-0000-4000-8000-0000000000f2', tier: 'required' },
        // Recommended never counts — it was never enforced, so nothing "stops".
        { id: 'r3', orgId: 'org-1', roleId: null, locationId: LOC_X, departmentId: null, competencyId: '00000000-0000-4000-8000-0000000000f3', tier: 'recommended' },
      ],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/retirement-review`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      locations: Array<{ id: string; requiredCompetenciesStopped: number; holders: unknown[] }>;
      departments: Array<{ id: string; requiredCompetenciesStopped: number }>;
      roles: Array<Record<string, unknown>>;
    };
    expect(body.locations[0]!.requiredCompetenciesStopped).toBe(2); // required tier only
    expect(body.locations[0]!.holders).toHaveLength(1); // the M in "…to M placed people"
    expect(body.departments[0]!.requiredCompetenciesStopped).toBe(0);
    server.close();
  });
});
