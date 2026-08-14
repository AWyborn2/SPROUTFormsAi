import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

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
  /** ACTIVE Locations — the offer set `loadPlacementContext` loads (U5). */
  locations?: unknown[];
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
  /** `competency_requirements` rows — the assign-on-placement regression pin reads them. */
  requirementRows?: unknown[];
  tools?: unknown[];
  templates?: unknown[];
}) {
  const insertValues = vi.fn();
  const returningResult = (rows: unknown[]) => {
    const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
      returning: () => Promise<unknown[]>;
    };
    awaitable.returning = vi.fn().mockResolvedValue(rows);
    return awaitable;
  };
  const noop = () => Promise.resolve(undefined);
  const chainDelete = () => ({ where: () => noop() });
  const chainUpdate = () => ({ set: () => ({ where: () => noop() }) });
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
  /*
    ONE query surface for root AND transaction reads. The KTD2 resolver pins
    its dual read — and since U2 the whole scope expansion — to a transaction,
    so assign-on-placement reads placements, taxonomy values and BOTH
    requirement sources through the tx. Sharing the surface means a test can
    seed a location-scope requirement once and have the write path, the scope
    expansion and the assignment planner all see the same world.
  */
  const query = {
    organizations: { findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: 'business' }) },
    rolePermissions: { findFirst: vi.fn().mockResolvedValue(ADMIN_PERMS) },
    memberships: { findFirst: vi.fn().mockResolvedValue(opts.membership) },
    locations: { findMany: vi.fn().mockResolvedValue(opts.locations ?? []) },
    departments: { findMany: departmentsFindMany },
    jobRoles: { findMany: jobRolesFindMany },
    membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.heldLocations ?? []) },
    membershipDepartments: { findMany: vi.fn().mockResolvedValue(opts.heldDepartments ?? []) },
    membershipRoles: { findMany: vi.fn().mockResolvedValue(opts.heldRoles ?? []) },
    users: { findFirst: vi.fn().mockResolvedValue({ name: 'Ada' }) },
    // Assign-on-placement (U11) runs after a successful write; with no
    // requirements FROM EITHER SOURCE (legacy rows or direct links, KTD2) it
    // is a no-op, which is all most placement tests need — the regression pin
    // seeds `requirementRows` to prove the trigger still fires.
    roleRequiredAssessments: { findMany: vi.fn().mockResolvedValue([]) },
    competencyRequirements: { findMany: vi.fn().mockResolvedValue(opts.requirementRows ?? []) },
    assessmentTools: { findMany: vi.fn().mockResolvedValue(opts.tools ?? []) },
    formTemplates: { findMany: vi.fn().mockResolvedValue(opts.templates ?? []) },
    assessmentCases: { findMany: vi.fn().mockResolvedValue([]) },
    competencyHolders: { findMany: vi.fn().mockResolvedValue([]) },
    competencies: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const insert = (table: unknown) => ({
    values: (v: unknown) => {
      insertValues(table, v);
      return returningResult([{ id: 'row-new' }]);
    },
  });
  const tx = { delete: chainDelete, insert, update: chainUpdate, query };
  const db = {
    query,
    insert,
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<void>) => cb(tx)),
  } as unknown as Db;
  return { db, insertValues };
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
  const SITE_A = { id: 'c0000000-0000-0000-0000-000000000001', orgId: 'org-1', status: 'active' };
  const SITE_B = { id: 'c0000000-0000-0000-0000-000000000002', orgId: 'org-1', status: 'active' };

  it('refuses a placement with no Location (R21)', async () => {
    mockDbValue = fakeDb({
      membership: { id: 'm-1', orgId: 'org-1' },
      departments: [OPS],
      roles: [DOZER],
    }).db;
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
      locations: [SITE_A],
      departments: [MAINT],
      roles: [DOZER, FITTER],
    }).db;
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
      locations: [SITE_A],
      departments: [OPS],
      roles: [DOZER],
      heldLocations: [{ locationId: 'c0000000-0000-0000-0000-000000000001' }],
      heldDepartments: [{ departmentId: 'a0000000-0000-0000-0000-000000000001' }],
      heldRoles: [{ roleId: 'b0000000-0000-0000-0000-000000000001' }],
    }).db;
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
      locations: [SITE_A, SITE_B], // both sites still actively offered
      departments: [], // active taxonomy no longer offers the Department...
      roles: [], // ...nor the Role
      heldDeptTaxonomy: [RETIRED_DEPT], // but the member still holds them
      heldRoleTaxonomy: [RETIRED_ROLE],
      heldLocations: [{ locationId: 'c0000000-0000-0000-0000-000000000001' }],
      heldDepartments: [{ departmentId: RETIRED_DEPT.id }],
      heldRoles: [{ roleId: RETIRED_ROLE.id }],
    }).db;
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
    mockDbValue = fakeDb({ membership: undefined }).db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/team/members/m-x/placement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ locationIds: ['c0000000-0000-0000-0000-000000000001'], departmentIds: ['a0000000-0000-0000-0000-000000000001'], roleIds: [] }),
    });
    expect(res.status).toBe(404);
    server.close();
  });

  it('refuses placing onto a retired Location (U5) — the offer set closes the hole', async () => {
    // SITE_B is not in the active offer set (retired) and the member is not
    // already there, so nothing widens it in: the write 400s instead of
    // silently placing someone under a scope that confers nothing (U4 split).
    mockDbValue = fakeDb({
      membership: { id: 'm-1', orgId: 'org-1' },
      locations: [SITE_A],
      departments: [OPS],
      roles: [DOZER],
    }).db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/team/members/m-1/placement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({
        locationIds: [SITE_A.id, SITE_B.id],
        departmentIds: [OPS.id],
        roleIds: [DOZER.id],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_placement',
      code: 'unknown_location',
      subjectId: SITE_B.id,
    });
    server.close();
  });

  it('keeps a held retired Location through an unrelated placement edit (U5)', async () => {
    // The member is already AT SITE_B, which has since retired (not in the
    // active offer set). An Admin adds SITE_A; the held retired Location rides
    // along admitted — the mirror of the R119 role widening — rather than
    // 400ing the edit or silently dropping the placement.
    mockDbValue = fakeDb({
      membership: { id: 'm-1', orgId: 'org-1' },
      locations: [SITE_A], // SITE_B retired out of the offer set
      departments: [OPS],
      roles: [DOZER],
      heldLocations: [{ locationId: SITE_B.id }],
      heldDepartments: [{ departmentId: OPS.id }],
      heldRoles: [{ roleId: DOZER.id }],
    }).db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/team/members/m-1/placement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({
        locationIds: [SITE_B.id, SITE_A.id],
        departmentIds: [OPS.id],
        roleIds: [DOZER.id],
      }),
    });
    expect(res.status).toBe(200);
    server.close();
  });

  it('still assigns after a placement write — the U11 trigger survives the scope rework (regression)', async () => {
    // A location-scope requirement awaits at SITE_A; placing the member there
    // must create the awarding tool's case through the same
    // `assignForMembership` run every placement write has always fired (R47,
    // R51, KTD8) — the direct PUT is not allowed to become a dark write site
    // while the transfers gain their re-plan.
    const COMP = '00000000-0000-4000-8000-0000000000f1';
    const TOOL = '00000000-0000-4000-8000-0000000000a1';
    const { db, insertValues } = fakeDb({
      membership: { id: 'm-1', orgId: 'org-1', userId: 'u-9', status: 'active' },
      locations: [SITE_A],
      departments: [OPS],
      roles: [DOZER],
      heldLocations: [{ locationId: SITE_A.id, position: 0 }],
      requirementRows: [
        { id: 'req-1', orgId: 'org-1', locationId: SITE_A.id, competencyId: COMP, tier: 'required' },
      ],
      tools: [
        {
          id: TOOL,
          orgId: 'org-1',
          templateId: 'tpl-1',
          awardedCompetencyIds: [COMP],
          manifest: { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] },
          locationPartKeys: {},
          assessorStreamCompetencyIds: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      templates: [{ id: 'tpl-1', orgId: 'org-1', currentVersionId: 'v1' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/team/members/m-1/placement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader(admin) },
      body: JSON.stringify({ locationIds: [SITE_A.id], departmentIds: [], roleIds: [] }),
    });
    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledWith(
      schema.assessmentCases,
      expect.objectContaining({ toolId: TOOL, candidateUserId: 'u-9', locationId: SITE_A.id }),
    );
    server.close();
  });
});
