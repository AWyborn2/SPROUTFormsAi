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
    query: { membershipRoles: { findMany: vi.fn().mockResolvedValue([]) } },
  };
  return {
    query: {
      organizations: { findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: 'business' }) },
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(ADMIN_PERMS) },
      memberships: { findFirst: vi.fn().mockResolvedValue(opts.membership) },
      departments: { findMany: vi.fn().mockResolvedValue(opts.departments ?? []) },
      jobRoles: { findMany: vi.fn().mockResolvedValue(opts.roles ?? []) },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.heldLocations ?? []) },
      membershipDepartments: { findMany: vi.fn().mockResolvedValue(opts.heldDepartments ?? []) },
      membershipRoles: { findMany: vi.fn().mockResolvedValue(opts.heldRoles ?? []) },
      users: { findFirst: vi.fn().mockResolvedValue({ name: 'Ada' }) },
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
