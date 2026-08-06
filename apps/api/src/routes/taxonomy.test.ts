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

function fakeDb(opts: {
  planTier?: string;
  locationsFindFirst?: unknown;
  locationsFindMany?: unknown[];
  departmentsFindFirst?: unknown;
  jobRolesFindFirst?: unknown;
  /** The Department's Roles, for the tightening surface (U17). */
  jobRolesFindMany?: unknown[];
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
        findMany: vi.fn().mockResolvedValue([]),
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
      memberships: {
        findFirst: vi.fn(async () => (opts.memberships ?? [])[0]),
        findMany: vi.fn().mockResolvedValue(opts.memberships ?? []),
      },
      assessmentTools: { findMany: vi.fn().mockResolvedValue(opts.tools ?? []) },
      formTemplates: { findMany: vi.fn().mockResolvedValue(opts.templates ?? []) },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.heldLocations ?? []) },
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

describe('Role required assessments (U10)', () => {
  // Tool ids are validated as UUIDs in the PUT body.
  const TOOL_A = '00000000-0000-4000-8000-0000000000a1';
  const TOOL_B = '00000000-0000-4000-8000-0000000000a2';
  const TOOL_X = '00000000-0000-4000-8000-0000000000a3';
  const activeRole = (over: Record<string, unknown> = {}) => ({
    id: 'role-1',
    orgId: 'org-1',
    name: 'Dozer Operator',
    status: 'active',
    requirementsConfigured: false,
    ...over,
  });

  it('reads a configured Role back with its tools (R43)', async () => {
    const { db } = fakeDb({
      jobRolesFindFirst: activeRole({ requirementsConfigured: true }),
      nameClashRows: [{ toolId: TOOL_A }, { toolId: TOOL_B }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, toolIds: [TOOL_A, TOOL_B] });
    server.close();
  });

  it('reads unconfigured as distinct from configured-then-emptied (R49, R50)', async () => {
    // Never configured — no flag, no rows.
    const a = fakeDb({ jobRolesFindFirst: activeRole({ requirementsConfigured: false }), nameClashRows: [] });
    mockDbValue = a.db;
    let app = startApp();
    let res = await fetch(`${app.base}/taxonomy/roles/role-1/required-assessments`, {
      headers: authHeader(admin),
    });
    expect(await res.json()).toEqual({ configured: false, toolIds: [] });
    app.server.close();

    // Configured then emptied — the flag stands even with no rows.
    const b = fakeDb({ jobRolesFindFirst: activeRole({ requirementsConfigured: true }), nameClashRows: [] });
    mockDbValue = b.db;
    app = startApp();
    res = await fetch(`${app.base}/taxonomy/roles/role-1/required-assessments`, {
      headers: authHeader(admin),
    });
    expect(await res.json()).toEqual({ configured: true, toolIds: [] });
    app.server.close();
  });

  it('sets the list, replaces existing rows, and flags the Role configured (R43)', async () => {
    const { db, insertValues, deleteWhere, updateSet } = fakeDb({
      jobRolesFindFirst: activeRole({ requirementsConfigured: false }),
      nameClashRows: [{ id: TOOL_A }, { id: TOOL_B }], // both tools belong to the org
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ toolIds: [TOOL_A, TOOL_B] }),
    });
    expect(res.status).toBe(200);
    // The apply response now nests U12's effects alongside the U10 base shape.
    expect(await res.json()).toMatchObject({ configured: true, toolIds: [TOOL_A, TOOL_B] });
    expect(deleteWhere).toHaveBeenCalledWith(schema.roleRequiredAssessments, expect.anything());
    expect(insertValues).toHaveBeenCalledWith(
      schema.roleRequiredAssessments,
      expect.arrayContaining([expect.objectContaining({ roleId: 'role-1', toolId: TOOL_A })]),
    );
    expect(updateSet).toHaveBeenCalledWith(
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
      body: JSON.stringify({ toolIds: [TOOL_A] }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'role_retired' });
    server.close();
  });

  it('refuses a Builder (R12)', async () => {
    const { db } = fakeDb({ jobRolesFindFirst: activeRole() });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(builder) },
      body: JSON.stringify({ toolIds: [] }),
    });
    expect(res.status).toBe(403);
    server.close();
  });

  it('refuses a tool that is not the organisation’s (400)', async () => {
    const { db } = fakeDb({
      jobRolesFindFirst: activeRole(),
      nameClashRows: [], // the requested tool is not found in the org
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ toolIds: [TOOL_X] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'tool_not_found' });
    server.close();
  });
});

describe('Requirement change preview & apply (U12)', () => {
  const TOOL_A = '00000000-0000-4000-8000-0000000000a1';
  const TOOL_B = '00000000-0000-4000-8000-0000000000a2';
  const activeRole = (over: Record<string, unknown> = {}) => ({
    id: 'role-1',
    orgId: 'org-1',
    name: 'Dozer Operator',
    status: 'active',
    requirementsConfigured: true,
    ...over,
  });
  const previewReq = (
    base: string,
    toolIds: string[],
    session: { userId: string; orgId: string; role: string } = admin,
  ) =>
    fetch(`${base}/taxonomy/roles/role-1/required-assessments/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(session) },
      body: JSON.stringify({ toolIds }),
    });

  it('previews the effects shape and writes nothing (R84, R86)', async () => {
    const { db, insertValues, updateSet, deleteWhere } = fakeDb({
      jobRolesFindFirst: activeRole(),
      nameClashRows: [{ id: TOOL_A }], // TOOL_A validates as the org's
      currentRequirements: [], // adding TOOL_A
      holders: [], // no holders → all counters 0, but the six fields are present
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await previewReq(base, [TOOL_A]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effects: Record<string, unknown> };
    expect(body.effects).toEqual({
      addedToolIds: [TOOL_A],
      removedToolIds: [],
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

  it('refuses a preview by a Builder, on a retired Role, and for a foreign tool', async () => {
    // Builder → 403 (before any load).
    let f = fakeDb({ jobRolesFindFirst: activeRole() });
    mockDbValue = f.db;
    let app = startApp();
    expect((await previewReq(app.base, [TOOL_A], builder)).status).toBe(403);
    app.server.close();

    // Retired Role → 409 (a preview an apply would refuse must refuse too).
    f = fakeDb({ jobRolesFindFirst: activeRole({ status: 'retired' }) });
    mockDbValue = f.db;
    app = startApp();
    expect((await previewReq(app.base, [TOOL_A]).then((r) => r.status))).toBe(409);
    app.server.close();

    // A tool not in the org → 400.
    f = fakeDb({ jobRolesFindFirst: activeRole(), nameClashRows: [] });
    mockDbValue = f.db;
    app = startApp();
    const res = await previewReq(app.base, [TOOL_A]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'tool_not_found' });
    app.server.close();
  });

  it('applies an addition: writes the requirement, inserts the holder’s case, returns effects (R82, R83, R87)', async () => {
    const { db, insertValues } = fakeDb({
      jobRolesFindFirst: activeRole(),
      nameClashRows: [{ id: TOOL_A }],
      currentRequirements: [], // adding TOOL_A
      holders: [{ membershipId: 'm1', roleId: 'role-1', withdrawnAt: null }],
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1' }],
      tools: [
        {
          id: TOOL_A,
          orgId: 'org-1',
          templateId: 'tpl-1',
          awardedCompetencyIds: ['cX'],
          manifest: { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] },
          locationPartKeys: {},
          assessorStreamCompetencyIds: {},
        },
      ],
      templates: [{ id: 'tpl-1', orgId: 'org-1', currentVersionId: 'v1' }],
      heldLocations: [{ membershipId: 'm1', locationId: 'loc1', position: 0 }],
      openCases: [],
      competencyHolders: [], // holds nothing → the one holder is left unmet
      competencies: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ toolIds: [TOOL_A] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effects: { affected: number; created: number } };
    expect(body.effects.affected).toBe(1);
    expect(body.effects.created).toBe(1);
    // The requirement row AND the holder's case are both written.
    expect(insertValues).toHaveBeenCalledWith(schema.roleRequiredAssessments, expect.anything());
    expect(insertValues).toHaveBeenCalledWith(schema.assessmentCases, expect.objectContaining({ toolId: TOOL_A }));
    server.close();
  });

  it('applies a removal without cancelling in-flight cases (R55)', async () => {
    const { db, insertValues, updateSet, deleteWhere } = fakeDb({
      jobRolesFindFirst: activeRole(),
      nameClashRows: [{ id: TOOL_A }], // desired {A}; current {A,B} → drop B
      currentRequirements: [
        { orgId: 'org-1', roleId: 'role-1', toolId: TOOL_A },
        { orgId: 'org-1', roleId: 'role-1', toolId: TOOL_B },
      ],
      holders: [{ membershipId: 'm1', roleId: 'role-1', withdrawnAt: null }],
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1' }],
      openCases: [], // no in-flight to count in this wiring test
      competencyHolders: [],
      competencies: [],
      tools: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/taxonomy/roles/role-1/required-assessments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ toolIds: [TOOL_A] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effects: { removedToolIds: string[]; created: number } };
    expect(body.effects.removedToolIds).toEqual([TOOL_B]);
    expect(body.effects.created).toBe(0);
    // The requirement list is rewritten, but NO assessment case is created,
    // deleted or updated — a removal never touches a case (R55).
    expect(deleteWhere).toHaveBeenCalledWith(schema.roleRequiredAssessments, expect.anything());
    expect(insertValues).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    expect(deleteWhere).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    expect(updateSet).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
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
