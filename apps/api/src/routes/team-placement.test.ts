import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

const admin = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
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

const ADMIN_PERMS = { orgId: 'org-1', role: 'admin', matrix: { team: { manage: true, view: true } } };

function fakeDb(opts: {
  membership?: unknown;
  departments?: unknown[];
  roles?: unknown[];
  // `admitHeldRoles` re-queries roles/departments by id AFTER the active-taxonomy
  // load. When supplied, these are returned to that SECOND query, letting a test
  // give the active taxonomy and the member's held taxonomy different answers.
  heldRoleTaxonomy?: unknown[];
  heldDeptTaxonomy?: unknown[];
  heldLocations?: unknown[];
  heldDepartments?: unknown[];
  heldRoles?: unknown[];
}) {
  const noop = () => Promise.resolve(undefined);
  const chainDelete = () => ({ where: () => noop() });
  const chainInsert = () => ({ values: () => noop() });
  const chainUpdate = () => ({ set: () => ({ where: () => noop() }) });
  const tx = {
    delete: chainDelete,
    insert: chainInsert,
    update: chainUpdate,
    query: {
      membershipRoles: { findMany: vi.fn().mockResolvedValue([]) },
      /*
        The KTD2 resolver pins its dual read to a transaction, so assign-on-
        placement now reads BOTH requirement sources through this tx surface.
        Empty on both sides keeps the assignment a no-op, as above. Since U2
        the same snapshot covers the SCOPE EXPANSION too (placement axes plus
        their taxonomy values), so those tables answer here as well — empty,
        which expands to no scope keys and keeps the no-op.
      */
      membershipLocations: { findMany: vi.fn().mockResolvedValue([]) },
      membershipDepartments: { findMany: vi.fn().mockResolvedValue([]) },
      locations: { findMany: vi.fn().mockResolvedValue([]) },
      departments: { findMany: vi.fn().mockResolvedValue([]) },
      roleRequiredAssessments: { findMany: vi.fn().mockResolvedValue([]) },
      competencyRequirements: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
  // Order is deterministic: `loadPlacementContext` fires the active query first,
  // then `admitHeldRoles` fires the by-id query second.
  const departmentsFindMany = vi.fn().mockResolvedValue(opts.departments ?? []);
  if (opts.heldDeptTaxonomy) {
    departmentsFindMany
      .mockResolvedValueOnce(opts.departments ?? [])
      .mockResolvedValueOnce(opts.heldDeptTaxonomy);
  }
  const jobRolesFindMany = vi.fn().mockResolvedValue(opts.roles ?? []);
  if (opts.heldRoleTaxonomy) {
    jobRolesFindMany
      .mockResolvedValueOnce(opts.roles ?? [])
      .mockResolvedValueOnce(opts.heldRoleTaxonomy);
  }
  return {
    query: {
      organizations: { findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: 'business' }) },
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(ADMIN_PERMS) },
      memberships: { findFirst: vi.fn().mockResolvedValue(opts.membership) },
      departments: { findMany: departmentsFindMany },
      jobRoles: { findMany: jobRolesFindMany },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.heldLocations ?? []) },
      membershipDepartments: { findMany: vi.fn().mockResolvedValue(opts.heldDepartments ?? []) },
      membershipRoles: { findMany: vi.fn().mockResolvedValue(opts.heldRoles ?? []) },
      users: { findFirst: vi.fn().mockResolvedValue({ name: 'Ada' }) },
      // Assign-on-placement (U11) runs after a successful write; with no Role
      // requirements FROM EITHER SOURCE (legacy rows or direct competency
      // links, KTD2) it is a no-op, which is all these placement tests need.
      roleRequiredAssessments: { findMany: vi.fn().mockResolvedValue([]) },
      competencyRequirements: { findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<void>) => cb(tx)),
  } as unknown as Db;
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

describe('PUT /team/members/:id/placement', () => {
  const OPS = { id: 'a0000000-0000-0000-0000-000000000001', orgId: 'org-1', allowsMultipleRoles: true, status: 'active' };
  const MAINT = { id: 'a0000000-0000-0000-0000-000000000002', orgId: 'org-1', allowsMultipleRoles: false, status: 'active' };
  const DOZER = { id: 'b0000000-0000-0000-0000-000000000001', orgId: 'org-1', departmentId: 'a0000000-0000-0000-0000-000000000001', status: 'active' };
  const FITTER = { id: 'b0000000-0000-0000-0000-000000000002', orgId: 'org-1', departmentId: 'a0000000-0000-0000-0000-000000000002', status: 'active' };

  it('refuses a placement with no Location (R21)', async () => {
    mockDbValue = fakeDb({
      membership: { id: 'm-1', orgId: 'org-1' },
      departments: [OPS],
      roles: [DOZER],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/team/members/m-1/placement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ locationIds: [], departmentIds: ['a0000000-0000-0000-0000-000000000001'], roleIds: ['b0000000-0000-0000-0000-000000000001'] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_placement', code: 'no_location' });
    server.close();
  });

  it('refuses a Role the placed Department does not offer (R5)', async () => {
    mockDbValue = fakeDb({
      membership: { id: 'm-1', orgId: 'org-1' },
      departments: [MAINT],
      roles: [DOZER, FITTER],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/team/members/m-1/placement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ locationIds: ['c0000000-0000-0000-0000-000000000001'], departmentIds: ['a0000000-0000-0000-0000-000000000002'], roleIds: ['b0000000-0000-0000-0000-000000000001'] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'role_not_offered', subjectId: 'b0000000-0000-0000-0000-000000000001' });
    server.close();
  });

  it('writes a valid placement and returns it', async () => {
    mockDbValue = fakeDb({
      membership: { id: 'm-1', orgId: 'org-1' },
      departments: [OPS],
      roles: [DOZER],
      heldLocations: [{ locationId: 'c0000000-0000-0000-0000-000000000001' }],
      heldDepartments: [{ departmentId: 'a0000000-0000-0000-0000-000000000001' }],
      heldRoles: [{ roleId: 'b0000000-0000-0000-0000-000000000001' }],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/team/members/m-1/placement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ locationIds: ['c0000000-0000-0000-0000-000000000001'], departmentIds: ['a0000000-0000-0000-0000-000000000001'], roleIds: ['b0000000-0000-0000-0000-000000000001'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      locationIds: ['c0000000-0000-0000-0000-000000000001'],
      departmentIds: ['a0000000-0000-0000-0000-000000000001'],
      roleIds: ['b0000000-0000-0000-0000-000000000001'],
    });
    server.close();
  });

  it('keeps a retired-but-held Role when an Admin edits the placement (R119)', async () => {
    // The member holds a Role (and its Department) that has since been retired.
    // Retirement withdraws nobody (R119): the Role stays on the record, barred
    // only for NEW placements. So the active taxonomy no longer offers either,
    // yet an edit that re-lists them must validate against active taxonomy
    // WIDENED with what the member still holds — not be rejected as unknown_role.
    const RETIRED_DEPT = { id: 'a0000000-0000-0000-0000-0000000000ff', orgId: 'org-1', allowsMultipleRoles: false, status: 'retired' };
    const RETIRED_ROLE = { id: 'b0000000-0000-0000-0000-0000000000ff', orgId: 'org-1', departmentId: RETIRED_DEPT.id, status: 'retired' };
    mockDbValue = fakeDb({
      membership: { id: 'm-1', orgId: 'org-1' },
      departments: [], // active taxonomy no longer offers the Department...
      roles: [], // ...nor the Role
      heldDeptTaxonomy: [RETIRED_DEPT], // but the member still holds them
      heldRoleTaxonomy: [RETIRED_ROLE],
      heldLocations: [{ locationId: 'c0000000-0000-0000-0000-000000000001' }],
      heldDepartments: [{ departmentId: RETIRED_DEPT.id }],
      heldRoles: [{ roleId: RETIRED_ROLE.id }],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/team/members/m-1/placement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      // The Admin adds a second Location; the held retired Role/Department ride along.
      body: JSON.stringify({
        locationIds: ['c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002'],
        departmentIds: [RETIRED_DEPT.id],
        roleIds: [RETIRED_ROLE.id],
      }),
    });
    expect(res.status).toBe(200);
    // Listed in the write, so reconciled (reinstated/kept) — never withdrawn.
    expect(await res.json()).toMatchObject({ roleIds: [RETIRED_ROLE.id] });
    server.close();
  });

  it('404s a membership in another organisation (R2)', async () => {
    mockDbValue = fakeDb({ membership: undefined });
    const { server, base } = startApp();
    const res = await fetch(`${base}/team/members/m-x/placement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ locationIds: ['c0000000-0000-0000-0000-000000000001'], departmentIds: ['a0000000-0000-0000-0000-000000000001'], roleIds: [] }),
    });
    expect(res.status).toBe(404);
    server.close();
  });
});
