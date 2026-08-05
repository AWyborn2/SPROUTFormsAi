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
  /** Rows the case-insensitive active-name clash SELECT returns. */
  nameClashRows?: unknown[];
  inserted?: unknown;
  updated?: unknown;
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
        findMany: vi.fn().mockResolvedValue([]),
      },
      users: { findFirst: vi.fn().mockResolvedValue({ name: 'Ada' }) },
      // Assign-on-requirement-change (U11) reads the Role's holders; none in these
      // unit tests, so the assignment side effect is a no-op here.
      membershipRoles: { findMany: vi.fn().mockResolvedValue([]) },
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
    expect(await res.json()).toEqual({ configured: true, toolIds: [TOOL_A, TOOL_B] });
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
