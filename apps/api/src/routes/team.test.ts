import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

const adminTenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
const viewerTenant = { userId: 'u2', orgId: 'org-1', role: 'viewer' as const };
let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

/** Invite-email delivery is mocked at the module boundary — defaults to "sent". */
const emailMocks = vi.hoisted(() => ({ sendInviteEmail: vi.fn() }));
vi.mock('../email/resend.js', () => ({
  sendInviteEmail: emailMocks.sendInviteEmail,
}));

const { createApp } = await import('../app.js');
({ sealSession } = await import('../auth/workos.js'));

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader(tenant: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(tenant)}` };
}

const ADMIN_PERMS = { orgId: 'org-1', role: 'admin', matrix: { team: { manage: true }, forms: {}, submissions: {}, billing: {}, audit: {} } };
const VIEWER_PERMS = { orgId: 'org-1', role: 'viewer', matrix: { team: { manage: false }, forms: {}, submissions: {}, billing: {}, audit: {} } };

function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown[]> };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

function fakeDb(opts: {
  rolePermissionsFindFirst?: unknown;
  rolePermissionsFindMany?: unknown[];
  membershipsFindFirst?: unknown;
  membershipsFindMany?: unknown[];
  usersFindFirst?: unknown;
  usersFindMany?: unknown[];
  organizationsFindFirst?: unknown;
  invitesFindFirst?: unknown;
  invitesFindMany?: unknown[];
  /** Profiles backing the live display-identifier read (R24). Default: none. */
  memberProfilesFindMany?: unknown[];
  /** The competency-counts inputs (oversight round). All default empty. */
  membershipRolesFindMany?: unknown[];
  roleRequiredAssessmentsFindMany?: unknown[];
  /** Direct Role → competency links (KTD1) — the dual read's second half. */
  competencyRequirementsFindMany?: unknown[];
  assessmentToolsFindMany?: unknown[];
  competencyHoldersFindMany?: unknown[];
  competenciesFindMany?: unknown[];
  /** Cases in flight that deactivation invalidates (R71). */
  openCases?: unknown[];
  /** Throw from the `invites` insert — the pending-invite unique violation. */
  inviteInsertError?: unknown;
  insertedCompetency?: unknown;
  /** Resolved by the seat-limit `db.select({ count }).from(memberships).where(...)` query. */
  activeSeatCount?: number;
  /**
   * The org row the in-transaction `SELECT ... FOR UPDATE` returns. Defaults to
   * `organizationsFindFirst` — override only to make the locked read differ
   * from the unlocked one.
   */
  lockedOrg?: unknown;
}) {
  const updateSet = vi.fn();
  const deleteWhere = vi.fn();
  const insertValues = vi.fn();
  const forUpdate = vi.fn();
  /** Every statement in order, tagged with the surface that issued it. */
  const ops: Array<{ on: 'root' | 'tx'; op: 'lock' | 'count' | 'update'; table?: unknown }> = [];
  const lockedOrg = 'lockedOrg' in opts ? opts.lockedOrg : opts.organizationsFindFirst;

  const query = {
    rolePermissions: {
      findFirst: vi.fn().mockResolvedValue(opts.rolePermissionsFindFirst),
      findMany: vi.fn().mockResolvedValue(opts.rolePermissionsFindMany ?? []),
    },
    memberships: {
      /*
        TWO different lookups reach this, and they ask about different people.
        `requireTenant` revalidates the CALLER's own membership before the route
        runs (R65); the route then looks up the member being acted ON. This
        fixture carries only the latter, so the caller's lookup is modelled as a
        miss — which is what a predicate-honouring database would return, and
        which the middleware treats as "nothing known, carry on".

        Without this the middleware would read the target's row as if it were the
        caller's, and a test acting on a suspended member would 401 the admin
        doing the acting.
      */
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(opts.membershipsFindFirst),
      findMany: vi.fn().mockResolvedValue(opts.membershipsFindMany ?? []),
    },
    users: {
      findFirst: vi.fn().mockResolvedValue(opts.usersFindFirst),
      findMany: vi.fn().mockResolvedValue(opts.usersFindMany ?? []),
    },
    organizations: {
      findFirst: vi.fn().mockResolvedValue(opts.organizationsFindFirst),
    },
    invites: {
      findFirst: vi.fn().mockResolvedValue(opts.invitesFindFirst),
      findMany: vi.fn().mockResolvedValue(opts.invitesFindMany ?? []),
    },
    /*
      The member list resolves each person's display identifier live from their
      profile (R24, R61). Defaults to none, which is the ordinary state before a
      workforce is entered — the list then shows the name it always did.
    */
    memberProfiles: {
      findMany: vi.fn().mockResolvedValue(opts.memberProfilesFindMany ?? []),
    },
    /*
      Deactivation closes an outstanding invitation (R65) and invalidates a case
      in flight (R71). Both default to none, which is the ordinary case for a
      member who accepted long ago and holds no open assessment.
    */
    assessmentCases: {
      findMany: vi.fn().mockResolvedValue(opts.openCases ?? []),
    },
    // The counts read: standing resolver inputs plus grants. Empty by default,
    // which computes zero counts for every active member.
    membershipRoles: { findMany: vi.fn().mockResolvedValue(opts.membershipRolesFindMany ?? []) },
    roleRequiredAssessments: {
      findMany: vi.fn().mockResolvedValue(opts.roleRequiredAssessmentsFindMany ?? []),
    },
    // The dual read's direct half (KTD1). Empty keeps these fixtures on the
    // legacy derivation the counts were written against.
    competencyRequirements: {
      findMany: vi.fn().mockResolvedValue(opts.competencyRequirementsFindMany ?? []),
    },
    assessmentTools: { findMany: vi.fn().mockResolvedValue(opts.assessmentToolsFindMany ?? []) },
    competencyHolders: {
      findMany: vi.fn().mockResolvedValue(opts.competencyHoldersFindMany ?? []),
    },
    competencies: { findMany: vi.fn().mockResolvedValue(opts.competenciesFindMany ?? []) },
  };

  const makeSurface = (on: 'root' | 'tx') => ({
    query,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: () => {
          const isOrg = table === schema.organizations;
          const rows = isOrg ? (lockedOrg ? [lockedOrg] : []) : [{ count: opts.activeSeatCount ?? 0 }];
          // A thenable rather than a Promise, so the mock can tell an awaited
          // count apart from a `.for('update')` lock on the same builder.
          return {
            then: (resolve: (r: unknown[]) => void) => {
              ops.push({ on, op: 'count', table });
              resolve(rows);
            },
            for: (mode: string) => {
              forUpdate(mode);
              ops.push({ on, op: 'lock', table });
              return Promise.resolve(rows);
            },
          };
        },
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        if (table === schema.users) return insertResult([{ id: 'u-new', ...(v as object) }]);
        if (table === schema.memberships) return insertResult([{ id: 'm-new', ...(v as object) }]);
        if (table === schema.invites) {
          if (opts.inviteInsertError) throw opts.inviteInsertError;
          return insertResult([{ id: 'inv-new', acceptedAt: null, ...(v as object) }]);
        }
        return insertResult([opts.insertedCompetency]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        ops.push({ on, op: 'update', table });
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    })),
    delete: vi.fn((table: unknown) => ({
      where: (w: unknown) => {
        deleteWhere(table, w);
        return Promise.resolve(undefined);
      },
    })),
  });

  const tx = makeSurface('tx');
  const transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  const db = { ...makeSurface('root'), transaction } as unknown as Db;

  return { db, updateSet, deleteWhere, insertValues, forUpdate, ops, transaction };
}

beforeEach(() => {
  emailMocks.sendInviteEmail.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /team/members', () => {
  it('lists members joined with user name/email', async () => {
    mockDbValue = fakeDb({
      membershipsFindMany: [{ id: 'm1', userId: 'u1', role: 'admin', status: 'active' }],
      usersFindMany: [{ id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' }],
      // Counts require the tier that carries profiles (same gate as the record).
      organizationsFindFirst: { id: 'org-1', planTier: 'enterprise' },
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      expect(res.status).toBe(200);
      const body = await res.json();
      // `identifier` is null until a profile carrying one exists (R24) — the
      // list keeps working through the state every org is in before its
      // workforce is entered.
      expect(body).toEqual([
        {
          id: 'm1',
          userId: 'u1',
          name: 'Ash Wyborn',
          identifier: null,
          email: 'ash@x.io',
          role: 'admin',
          status: 'active',
          // Zeros, not null: the admin caller may read counts; this member
          // simply holds nothing yet.
          counts: { requiredCurrent: 0, requiredAttention: 0, optionalLapsed: 0 },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it('shows each member by the identifier the organisation chose, falling back per person (R24)', async () => {
    // AE22: three members share the name Chris Taylor. One holds an employee
    // number, one holds only a swipe card, the third holds neither.
    mockDbValue = fakeDb({
      organizationsFindFirst: { id: 'org-1', displayIdentifier: 'employee_number' },
      membershipsFindMany: [
        { id: 'm1', userId: 'u1', role: 'candidate', status: 'active' },
        { id: 'm2', userId: 'u2', role: 'assessor', status: 'active' },
        { id: 'm3', userId: 'u3', role: 'admin', status: 'active' },
      ],
      usersFindMany: [
        { id: 'u1', name: 'Chris Taylor', email: 'c1@x.io' },
        { id: 'u2', name: 'Chris Taylor', email: 'c2@x.io' },
        { id: 'u3', name: 'Chris Taylor', email: 'c3@x.io' },
      ],
      memberProfilesFindMany: [
        { membershipId: 'm1', firstName: 'Chris', lastName: 'Taylor', employeeNumber: 'E100', swipeCardNumber: null },
        { membershipId: 'm2', firstName: 'Chris', lastName: 'Taylor', employeeNumber: null, swipeCardNumber: 'S900' },
        { membershipId: 'm3', firstName: 'Chris', lastName: 'Taylor', employeeNumber: null, swipeCardNumber: null },
      ],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ userId: string; name: string; identifier: string | null }>;
      // The chosen number; the other one where only it is held; the name alone
      // where neither is — and every member, whatever access level they carry.
      expect(body.map((r) => [r.userId, r.identifier])).toEqual([
        ['u1', 'E100'],
        ['u2', 'S900'],
        ['u3', null],
      ]);
      expect(new Set(body.map((r) => r.name))).toEqual(new Set(['Chris Taylor']));
    } finally {
      server.close();
    }
  });

  /*
    `id` is the MEMBERSHIP id. Everything that records something against a
    person — an assessment case, a competency grant — keys on the USER id, and
    this response resolved it internally and then dropped it. The result was
    that opening the first assessment case required querying the database by
    hand: the product asked for an id it never showed anyone.
  */
  it('exposes the user id, distinct from the membership id', async () => {
    mockDbValue = fakeDb({
      membershipsFindMany: [{ id: 'm1', userId: 'u1', role: 'candidate', status: 'active' }],
      usersFindMany: [{ id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' }],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      const [row] = (await res.json()) as { id: string; userId: string | null }[];
      expect(row!.userId).toBe('u1');
      expect(row!.userId).not.toBe(row!.id);
    } finally {
      server.close();
    }
  });

  it('gives a pending invite a null user id rather than its invite id', async () => {
    // Falling back to `id` here would hand a caller an id from a different
    // table that still parses as a UUID — the exact confusion this splits.
    mockDbValue = fakeDb({
      membershipsFindMany: [],
      usersFindMany: [],
      invitesFindMany: [{ id: 'inv-1', email: 'sam.lee@x.io', role: 'builder', acceptedAt: null }],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      const [row] = (await res.json()) as { id: string; userId: string | null }[];
      expect(row!.userId).toBeNull();
    } finally {
      server.close();
    }
  });

  it('lists pending invites alongside real members, keyed by the invite id', async () => {
    mockDbValue = fakeDb({
      membershipsFindMany: [{ id: 'm1', userId: 'u1', role: 'admin', status: 'active' }],
      usersFindMany: [{ id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' }],
      invitesFindMany: [{ id: 'inv-1', email: 'sam.lee@x.io', role: 'builder', acceptedAt: null }],
      organizationsFindFirst: { id: 'org-1', planTier: 'enterprise' },
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      expect(res.status).toBe(200);
      // The invitee has no user row yet — the name is derived from the address
      // the inviter typed, and `status` is what marks them as not-yet-joined.
      expect(await res.json()).toEqual([
        {
          id: 'm1',
          userId: 'u1',
          name: 'Ash Wyborn',
          identifier: null,
          email: 'ash@x.io',
          role: 'admin',
          status: 'active',
          counts: { requiredCurrent: 0, requiredAttention: 0, optionalLapsed: 0 },
        },
        // A pending invite has nobody to hold anything — counts stay null.
        { id: 'inv-1', userId: null, name: 'Sam Lee', identifier: null, email: 'sam.lee@x.io', role: 'builder', status: 'invited', counts: null },
      ]);
    } finally {
      server.close();
    }
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000);

  /** One member whose Role requires a tool awarding the given competency ids. */
  function countsFixture(over: Parameters<typeof fakeDb>[0] = {}) {
    return fakeDb({
      membershipsFindMany: [{ id: 'm1', userId: 'u9', role: 'candidate', status: 'active' }],
      usersFindMany: [{ id: 'u9', name: 'Bo Worker', email: 'bo@x.io' }],
      membershipRolesFindMany: [{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }],
      roleRequiredAssessmentsFindMany: [{ orgId: 'org-1', roleId: 'r1', toolId: 't1' }],
      assessmentToolsFindMany: [
        { id: 't1', orgId: 'org-1', awardedCompetencyIds: ['c-ok', 'c-exp'] },
      ],
      organizationsFindFirst: { id: 'org-1', planTier: 'enterprise' },
      ...over,
    });
  }

  it('computes required-vs-optional counts per member in one batched read (AE1, R1, R2)', async () => {
    // 2 required (1 current, 1 expired) + 1 optional fully expired.
    mockDbValue = countsFixture({
      competencyHoldersFindMany: [
        { userId: 'u9', competencyId: 'c-ok', grantedAt: daysAgo(100), expiresAt: daysAhead(400), revokedAt: null },
        { userId: 'u9', competencyId: 'c-exp', grantedAt: daysAgo(400), expiresAt: daysAgo(10), revokedAt: null },
        { userId: 'u9', competencyId: 'c-opt', grantedAt: daysAgo(400), expiresAt: daysAgo(10), revokedAt: null },
      ],
      competenciesFindMany: [
        { id: 'c-ok', orgId: 'org-1', name: 'Dozer' },
        { id: 'c-exp', orgId: 'org-1', name: 'Heights' },
        { id: 'c-opt', orgId: 'org-1', name: 'First Aid' },
      ],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      const [row] = (await res.json()) as Array<{ counts: unknown }>;
      // The lapsed optional never colours the flag — it stays its own number.
      expect(row!.counts).toEqual({ requiredCurrent: 1, requiredAttention: 1, optionalLapsed: 1 });
    } finally {
      server.close();
    }
  });

  it('counts an expiring required competency as current AND needing attention (KTD5)', async () => {
    mockDbValue = countsFixture({
      assessmentToolsFindMany: [{ id: 't1', orgId: 'org-1', awardedCompetencyIds: ['c-soon'] }],
      competencyHoldersFindMany: [
        { userId: 'u9', competencyId: 'c-soon', grantedAt: daysAgo(100), expiresAt: daysAhead(40), revokedAt: null },
      ],
      competenciesFindMany: [{ id: 'c-soon', orgId: 'org-1', name: 'Working at Heights' }],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      const [row] = (await res.json()) as Array<{ counts: unknown }>;
      expect(row!.counts).toEqual({ requiredCurrent: 1, requiredAttention: 1, optionalLapsed: 0 });
    } finally {
      server.close();
    }
  });

  it('counts a grace-period REQUIRED competency as current AND needing attention', async () => {
    // Past its date but inside grace: still counts, urgently bookable — the
    // same reading the compliance report's expiring bucket now gives it.
    mockDbValue = countsFixture({
      assessmentToolsFindMany: [{ id: 't1', orgId: 'org-1', awardedCompetencyIds: ['c-grace'] }],
      competencyHoldersFindMany: [
        { userId: 'u9', competencyId: 'c-grace', grantedAt: daysAgo(400), expiresAt: daysAgo(5), revokedAt: null },
      ],
      competenciesFindMany: [
        { id: 'c-grace', orgId: 'org-1', name: 'Working at Heights', gracePeriodDays: 90 },
      ],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      const [row] = (await res.json()) as Array<{ counts: unknown }>;
      expect(row!.counts).toEqual({ requiredCurrent: 1, requiredAttention: 1, optionalLapsed: 0 });
    } finally {
      server.close();
    }
  });

  it('does not flag a renewed required competency — the best grant decides', async () => {
    // The superseded grant stays for history; only the renewal's currency counts.
    mockDbValue = countsFixture({
      assessmentToolsFindMany: [{ id: 't1', orgId: 'org-1', awardedCompetencyIds: ['c-ok'] }],
      competencyHoldersFindMany: [
        { userId: 'u9', competencyId: 'c-ok', grantedAt: daysAgo(1200), expiresAt: daysAgo(100), revokedAt: null },
        { userId: 'u9', competencyId: 'c-ok', grantedAt: daysAgo(50), expiresAt: daysAhead(1000), revokedAt: null },
      ],
      competenciesFindMany: [{ id: 'c-ok', orgId: 'org-1', name: 'Dozer' }],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      const [row] = (await res.json()) as Array<{ counts: unknown }>;
      expect(row!.counts).toEqual({ requiredCurrent: 1, requiredAttention: 0, optionalLapsed: 0 });
    } finally {
      server.close();
    }
  });

  it('serves counts to an assessor — the widest default reader of the field', async () => {
    const assessorTenant = { userId: 'u5', orgId: 'org-1', role: 'assessor' as const };
    mockDbValue = countsFixture().db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(assessorTenant) });
      expect(res.status).toBe(200);
      const [row] = (await res.json()) as Array<{ counts: unknown }>;
      expect(row!.counts).toEqual({ requiredCurrent: 0, requiredAttention: 0, optionalLapsed: 0 });
    } finally {
      server.close();
    }
  });

  it('nulls counts for an org below the assessments tier — the roster must not outleak the record', async () => {
    // Every dedicated competency surface refuses this org; the roster field
    // carries the same tier gate, and only the counts disappear — the roster
    // itself still serves.
    mockDbValue = countsFixture({
      organizationsFindFirst: { id: 'org-1', planTier: 'free' },
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      expect(res.status).toBe(200);
      const [row] = (await res.json()) as Array<{ counts: unknown }>;
      expect(row!.counts).toBeNull();
    } finally {
      server.close();
    }
  });

  it('does not count a grace-period optional as lapsed — grace still counts as current', async () => {
    mockDbValue = countsFixture({
      assessmentToolsFindMany: [{ id: 't1', orgId: 'org-1', awardedCompetencyIds: [] }],
      competencyHoldersFindMany: [
        { userId: 'u9', competencyId: 'c-opt', grantedAt: daysAgo(400), expiresAt: daysAgo(5), revokedAt: null },
      ],
      competenciesFindMany: [
        { id: 'c-opt', orgId: 'org-1', name: 'First Aid', gracePeriodDays: 90 },
      ],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      const [row] = (await res.json()) as Array<{ counts: unknown }>;
      expect(row!.counts).toEqual({ requiredCurrent: 0, requiredAttention: 0, optionalLapsed: 0 });
    } finally {
      server.close();
    }
  });

  it('nulls counts for a caller whose view_competencies scope is not org-wide (R4)', async () => {
    // Builder holds team.view but not profiles.view_competencies — the roster
    // renders, the counts column does not.
    const builderTenant = { userId: 'u3', orgId: 'org-1', role: 'builder' as const };
    mockDbValue = countsFixture().db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(builderTenant) });
      expect(res.status).toBe(200);
      const [row] = (await res.json()) as Array<{ counts: unknown }>;
      expect(row!.counts).toBeNull();
    } finally {
      server.close();
    }
  });

  it('nulls counts on a non-active member row rather than flagging somebody who left', async () => {
    mockDbValue = countsFixture({
      membershipsFindMany: [
        { id: 'm1', userId: 'u9', role: 'candidate', status: 'active' },
        { id: 'm2', userId: 'u10', role: 'candidate', status: 'suspended' },
      ],
      usersFindMany: [
        { id: 'u9', name: 'Bo Worker', email: 'bo@x.io' },
        { id: 'u10', name: 'Gone Worker', email: 'gone@x.io' },
      ],
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      const rows = (await res.json()) as Array<{ id: string; counts: unknown }>;
      expect(rows.find((r) => r.id === 'm1')!.counts).toEqual({ requiredCurrent: 0, requiredAttention: 0, optionalLapsed: 0 });
      expect(rows.find((r) => r.id === 'm2')!.counts).toBeNull();
    } finally {
      server.close();
    }
  });

  it('403s the roster for a role without team.view — the list is every member’s name and address', async () => {
    mockDbValue = fakeDb({}).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(viewerTenant) });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('POST /team/members', () => {
  it('403s for a caller whose role lacks team.manage, writing no rows', async () => {
    const { db, insertValues } = fakeDb({ rolePermissionsFindFirst: VIEWER_PERMS });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(viewerTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@x.io', role: 'builder' }),
      });
      expect(res.status).toBe(403);
      expect(insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('400s for an invalid email or role', async () => {
    mockDbValue = fakeDb({ rolePermissionsFindFirst: ADMIN_PERMS }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email', role: 'builder' }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('creates a tokened invite — no user row, no membership — for a never-seen email', async () => {
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      usersFindMany: [],
      usersFindFirst: { id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'Sam.Lee@x.io', role: 'builder' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        id: 'inv-new',
        name: 'Sam Lee',
        email: 'sam.lee@x.io',
        role: 'builder',
        status: 'invited',
        emailSent: true,
      });
      // The acceptance link comes back so an admin can hand it over directly or
      // print it as a QR — the invite's whole credential, which is why only a
      // team manager reaches this route.
      expect(body.acceptPath).toMatch(/^\/invite\/.+/);

      const inviteInsert = insertValues.mock.calls.find(([table]) => table === schema.invites);
      expect(inviteInsert?.[1]).toMatchObject({ orgId: 'org-1', email: 'sam.lee@x.io', role: 'builder' });
      // Nothing exists for the invitee to be until they accept: no identity
      // row, and above all no membership granting the role in advance.
      expect(insertValues.mock.calls.find(([table]) => table === schema.users)).toBeUndefined();
      expect(insertValues.mock.calls.find(([table]) => table === schema.memberships)).toBeUndefined();
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({ action: 'Invited member', target: 'sam.lee@x.io' });
    } finally {
      server.close();
    }
  });

  it('mints an unguessable token per invite', async () => {
    const tokens = new Set<string>();
    for (const email of ['a@x.io', 'b@x.io']) {
      const { db, insertValues } = fakeDb({ rolePermissionsFindFirst: ADMIN_PERMS, usersFindMany: [] });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        await fetch(`${base}/team/members`, {
          method: 'POST',
          headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
          body: JSON.stringify({ email, role: 'viewer' }),
        });
        const inviteInsert = insertValues.mock.calls.find(([table]) => table === schema.invites);
        tokens.add((inviteInsert?.[1] as { token: string }).token);
      } finally {
        server.close();
      }
    }
    expect(tokens.size).toBe(2);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it('does NOT attach the invite to an existing user who happens to share the address', async () => {
    // `users.email` is not a verified claim under Replit Auth, so an address
    // match must not grant anything — the invite stays a token to be accepted.
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      usersFindMany: [{ id: 'u9', replitUserId: 'replit_9', name: 'Priya Nair', email: 'priya@x.io' }],
      membershipsFindFirst: undefined,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'priya@x.io', role: 'reviewer' }),
      });
      expect(res.status).toBe(201);
      expect(insertValues.mock.calls.find(([table]) => table === schema.memberships)).toBeUndefined();
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)?.[1]).toMatchObject({
        email: 'priya@x.io',
        role: 'reviewer',
      });
    } finally {
      server.close();
    }
  });

  it('409s when the address already belongs to a member of this org', async () => {
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      usersFindMany: [{ id: 'u9', replitUserId: 'replit_9', name: 'Priya Nair', email: 'priya@x.io' }],
      membershipsFindFirst: { id: 'm1', userId: 'u9', orgId: 'org-1', role: 'viewer', status: 'active' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'priya@x.io', role: 'viewer' }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('already_member');
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeUndefined();
      expect(emailMocks.sendInviteEmail).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('409s when a pending invite for that address already exists (unique index)', async () => {
    const { db } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      usersFindMany: [],
      inviteInsertError: Object.assign(new Error('duplicate key'), { code: '23505' }),
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sam@x.io', role: 'viewer' }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('already_invited');
      expect(emailMocks.sendInviteEmail).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('ISSUES a staff invitation on a full staff pool, warning rather than refusing (U37, R79, R80)', async () => {
    /*
      This used to 403. A pending invitation reserves nothing — issuing one costs
      no seat and an organisation may hold far more outstanding invitations than
      it has free seats — so refusing here blocked an action that charges
      nothing, on a count it did not change.

      The staff seat is still finite and acceptance will still refuse, so the
      check survives as a WARNING: the Admin learns the pool is full without
      being stopped from inviting somebody they intend to make room for.
    */
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      organizationsFindFirst: { id: 'org-1', name: 'Solo Co', planTier: 'individual', seatLimit: 1 },
      activeSeatCount: 1,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sam@x.io', role: 'builder' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        seatWarning?: { error: string; seatLimit: number; seatUsed: number };
      };
      expect(body.seatWarning).toMatchObject({
        error: 'seat_limit_reached',
        seatLimit: 1,
        seatUsed: 1,
      });
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeDefined();
    } finally {
      server.close();
    }
  });

  /**
   * Candidates are metered on their own allowance. The property that matters is
   * that the two pools are INDEPENDENT: a site whose trainers fill the staff
   * seats must still be able to enrol operators, and vice versa (U5, R27).
   */
  it('lets a staff-full org still enrol a candidate', async () => {
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      organizationsFindFirst: {
        id: 'org-1',
        name: 'Mine Co',
        planTier: 'business',
        seatLimit: 15,
        candidateSeatLimit: 200,
      },
      // Counts the candidate pool, which is empty even though staff is full.
      activeSeatCount: 0,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'operator@x.io', role: 'candidate' }),
      });
      expect(res.status).toBe(201);
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('issues a candidate invitation on a full candidate pool, with NO warning (R80)', async () => {
    // No warning, because unlike the staff pool there is nothing to warn about:
    // acceptance expands rather than refusing (R86), so the invitation will be
    // honoured. Saying "full" here would be telling the Admin about a boundary
    // that is not going to stop anybody.
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      organizationsFindFirst: {
        id: 'org-1',
        name: 'Mine Co',
        planTier: 'business',
        seatLimit: 15,
        candidateSeatLimit: 200,
      },
      activeSeatCount: 200,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'operator@x.io', role: 'candidate' }),
      });
      expect(res.status).toBe(201);
      expect((await res.json()) as Record<string, unknown>).not.toHaveProperty('seatWarning');
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('does not cap candidates on enterprise, where the allowance is unlimited', async () => {
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      organizationsFindFirst: {
        id: 'org-1',
        name: 'Mine Co',
        planTier: 'enterprise',
        seatLimit: 100,
        candidateSeatLimit: null,
      },
      activeSeatCount: 5000,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'operator@x.io', role: 'candidate' }),
      });
      expect(res.status).toBe(201);
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('warns via the plan-tier fallback when org.seatLimit is null', async () => {
    // Legacy org row: seatLimit was never backfilled — the team tier's
    // configured limit (5) is what the warning must report, which is the
    // resolution order the binding check at acceptance also uses.
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      organizationsFindFirst: { id: 'org-1', name: 'Legacy Co', planTier: 'team', seatLimit: null },
      activeSeatCount: 5,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sam@x.io', role: 'builder' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { seatWarning?: { seatLimit: number; seatUsed: number } };
      expect(body.seatWarning).toMatchObject({ seatLimit: 5, seatUsed: 5 });
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('warns when seatLimit is absent from the org row entirely', async () => {
    // `N >= undefined` is false, so a missing column must not read as unlimited
    // — the tier's own limit is still the answer.
    const { db } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      organizationsFindFirst: { id: 'org-1', name: 'Legacy Co', planTier: 'individual' },
      activeSeatCount: 1,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sam@x.io', role: 'builder' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { seatWarning?: { seatLimit: number } };
      expect(body.seatWarning).toMatchObject({ seatLimit: 1 });
    } finally {
      server.close();
    }
  });

  it('201s under the plan-tier fallback limit when org.seatLimit is null and seats remain', async () => {
    const { db } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      organizationsFindFirst: { id: 'org-1', name: 'Legacy Co', planTier: 'team', seatLimit: null },
      activeSeatCount: 2,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sam@x.io', role: 'builder' }),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { status: string }).status).toBe('invited');
    } finally {
      server.close();
    }
  });

  it('201s regardless of seat count when neither the org nor its tier defines a limit', async () => {
    const { db } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      // Tier unknown to PLAN_CONFIG → genuinely no configured cap → unlimited.
      organizationsFindFirst: { id: 'org-1', name: 'Big Co', planTier: 'enterprise-unlimited', seatLimit: null },
      activeSeatCount: 500,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sam@x.io', role: 'builder' }),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { status: string }).status).toBe('invited');
    } finally {
      server.close();
    }
  });

  it('sends the invite email with the tenant org name and inviter after the rows commit', async () => {
    const { db } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      usersFindMany: [],
      usersFindFirst: { id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' },
      organizationsFindFirst: { id: 'org-1', name: 'Meridian Operations', planTier: 'team', seatLimit: 5 },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sam@x.io', role: 'builder' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { emailSent: boolean };
      expect(body.emailSent).toBe(true);
      expect(emailMocks.sendInviteEmail).toHaveBeenCalledWith({
        to: 'sam@x.io',
        orgName: 'Meridian Operations',
        inviterName: 'Ash Wyborn',
        // Carries the minted token — the mail is the only place it's handed out.
        acceptUrl: expect.stringContaining('/invite/'),
      });
    } finally {
      server.close();
    }
  });

  it('still 201s with emailSent:false when the email send throws — rows already persisted', async () => {
    emailMocks.sendInviteEmail.mockRejectedValue(new Error('resend outage'));
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      usersFindMany: [],
      organizationsFindFirst: { id: 'org-1', name: 'Meridian Operations', planTier: 'team', seatLimit: 5 },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, {
        method: 'POST',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sam@x.io', role: 'builder' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { emailSent: boolean; status: string };
      expect(body.emailSent).toBe(false);
      expect(body.status).toBe('invited');
      // The invite is committed before the send is attempted, so an outage
      // costs delivery, not the invite.
      const inviteInsert = insertValues.mock.calls.find(([table]) => table === schema.invites);
      expect(inviteInsert?.[1]).toMatchObject({ orgId: 'org-1', role: 'builder', email: 'sam@x.io' });
    } finally {
      server.close();
    }
  });
});

describe('PATCH /team/members/:id', () => {
  it('403s for a caller whose role lacks team.manage', async () => {
    mockDbValue = fakeDb({ rolePermissionsFindFirst: VIEWER_PERMS }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m1`, {
        method: 'PATCH',
        headers: { ...authHeader(viewerTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'builder' }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('changes the role and records an audit entry when it actually changes', async () => {
    const { db, updateSet, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'viewer', status: 'active' },
      usersFindFirst: { id: 'u2', name: 'Priya Nair', email: 'priya@x.io' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m1`, {
        method: 'PATCH',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'builder' }),
      });
      expect(res.status).toBe(200);
      const membershipUpdate = updateSet.mock.calls.find(([table]) => table === schema.memberships);
      expect(membershipUpdate?.[1]).toEqual({ role: 'builder' });
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({ action: 'Changed role', target: 'Priya Nair: viewer → builder' });
    } finally {
      server.close();
    }
  });

  it('404s for a membership outside the caller org', async () => {
    mockDbValue = fakeDb({ rolePermissionsFindFirst: ADMIN_PERMS, membershipsFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/missing`, {
        method: 'PATCH',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'builder' }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('re-roles a pending invite so the change survives to acceptance', async () => {
    const { db, updateSet } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: undefined,
      invitesFindFirst: { id: 'inv-1', orgId: 'org-1', email: 'sam@x.io', role: 'viewer', acceptedAt: null },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/inv-1`, {
        method: 'PATCH',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'builder' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: 'inv-1', role: 'builder', status: 'invited' });
      expect(updateSet.mock.calls.find(([table]) => table === schema.invites)?.[1]).toEqual({ role: 'builder' });
    } finally {
      server.close();
    }
  });

  /**
   * A role change is the third way a seat gets consumed, alongside invite
   * creation and acceptance — and the only one where the person already exists.
   *
   * What makes it different is that it only costs anything when it CROSSES
   * pools. Getting that wrong in the safe-looking direction is its own bug: a
   * full staff pool refusing viewer → builder would block ordinary admin work
   * over a seat nobody is taking.
   */
  describe('seat limits', () => {
    const FULL_STAFF_ORG = {
      id: 'org-1',
      name: 'Meridian Operations',
      planTier: 'team',
      seatLimit: 5,
      candidateSeatLimit: 200,
    };

    function patchRole(base: string, id: string, role: string) {
      return fetch(`${base}/team/members/${id}`, {
        method: 'PATCH',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
    }

    it('refuses a candidate → staff promotion when the staff pool is full', async () => {
      const { db, updateSet } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'candidate', status: 'active' },
        usersFindFirst: { id: 'u2', name: 'Dale Rivers', email: 'dale@x.io' },
        organizationsFindFirst: FULL_STAFF_ORG,
        activeSeatCount: 5,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await patchRole(base, 'm1', 'assessor');
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          error: 'seat_limit_reached',
          seatLimit: 5,
          seatUsed: 5,
        });
        expect(updateSet.mock.calls.find(([table]) => table === schema.memberships)).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('allows a same-pool change even when that pool is full, without counting at all', async () => {
      const { db, updateSet, ops } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'viewer', status: 'active' },
        usersFindFirst: { id: 'u2', name: 'Priya Nair', email: 'priya@x.io' },
        organizationsFindFirst: FULL_STAFF_ORG,
        activeSeatCount: 5,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        // viewer and builder are both staff: this member is already counted,
        // so the full pool has nothing to say about it.
        expect((await patchRole(base, 'm1', 'builder')).status).toBe(200);
        expect(updateSet.mock.calls.find(([table]) => table === schema.memberships)?.[1]).toEqual({
          role: 'builder',
        });
        expect(ops.some((o) => o.op === 'count' || o.op === 'lock')).toBe(false);
      } finally {
        server.close();
      }
    });

    it('allows a staff → candidate demotion that frees a staff seat', async () => {
      const { db, updateSet } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'builder', status: 'active' },
        usersFindFirst: { id: 'u2', name: 'Priya Nair', email: 'priya@x.io' },
        // Staff is full, but the candidate pool is what this change joins.
        organizationsFindFirst: FULL_STAFF_ORG,
        activeSeatCount: 5,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        expect((await patchRole(base, 'm1', 'candidate')).status).toBe(200);
        expect(updateSet.mock.calls.find(([table]) => table === schema.memberships)?.[1]).toEqual({
          role: 'candidate',
        });
      } finally {
        server.close();
      }
    });

    it('EXPANDS rather than refusing the same demotion on a full candidate pool (AE35, R81, R86)', async () => {
      /*
        This used to 403. R81 says the change goes through: moving somebody to
        Candidate takes a candidate seat and releases a staff one, and refusing
        it would stop work on a site to settle a billing question.

        Both writes are asserted — the raised limit and the role — because an
        expansion that did not also complete the action would have charged the
        organisation for nothing.
      */
      const { db, updateSet, insertValues, ops } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'builder', status: 'active' },
        usersFindFirst: { id: 'u2', name: 'Priya Nair', email: 'priya@x.io' },
        organizationsFindFirst: { ...FULL_STAFF_ORG, seatLimit: 50, candidateSeatLimit: 3 },
        activeSeatCount: 3,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        expect((await patchRole(base, 'm1', 'candidate')).status).toBe(200);
        expect(updateSet).toHaveBeenCalledWith(schema.organizations, { candidateSeatLimit: 53 });
        expect(updateSet).toHaveBeenCalledWith(schema.memberships, { role: 'candidate' });

        // The block is bought under the SAME lock the count was taken under —
        // otherwise two admins promoting two people at once buy one block each
        // for one seat.
        const seatOps = ops.filter((o) => o.op === 'lock' || (o.op === 'update' && o.table === schema.organizations));
        expect(seatOps.map((o) => `${o.on}:${o.op}`)).toEqual(['tx:lock', 'tx:update']);

        const audit = insertValues.mock.calls.find(
          ([table, v]) => table === schema.auditLogEntries && (v as { category?: string }).category === 'billing',
        );
        expect(audit?.[1]).toMatchObject({ action: 'Added candidate seat block' });
      } finally {
        server.close();
      }
    });

    it('still REFUSES a promotion into a full staff pool, naming that pool (R80)', async () => {
      // No rule has been written for expanding the staff pool — R84 and R86 are
      // written entirely in candidate terms — so it keeps refusing rather than
      // charging against a rule nobody wrote.
      const { db, updateSet } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'candidate', status: 'active' },
        usersFindFirst: { id: 'u2', name: 'Dale Rivers', email: 'dale@x.io' },
        organizationsFindFirst: FULL_STAFF_ORG,
        activeSeatCount: 5,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await patchRole(base, 'm1', 'assessor');
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'seat_limit_reached' });
        expect(updateSet.mock.calls.find(([table]) => table === schema.memberships)).toBeUndefined();
        expect(updateSet.mock.calls.find(([table]) => table === schema.organizations)).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('does not gate a suspended member, who is in neither pool', async () => {
      const { db, updateSet, ops } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'candidate', status: 'suspended' },
        usersFindFirst: { id: 'u2', name: 'Dale Rivers', email: 'dale@x.io' },
        organizationsFindFirst: FULL_STAFF_ORG,
        activeSeatCount: 5,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        // The count is of ACTIVE rows, so this change moves no total.
        expect((await patchRole(base, 'm1', 'assessor')).status).toBe(200);
        expect(updateSet.mock.calls.find(([table]) => table === schema.memberships)?.[1]).toEqual({
          role: 'assessor',
        });
        expect(ops.some((o) => o.op === 'count' || o.op === 'lock')).toBe(false);
      } finally {
        server.close();
      }
    });

    it('locks the org row, then counts, then updates — all on the one transaction', async () => {
      const { db, forUpdate, ops, transaction } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'candidate', status: 'active' },
        usersFindFirst: { id: 'u2', name: 'Dale Rivers', email: 'dale@x.io' },
        organizationsFindFirst: FULL_STAFF_ORG,
        activeSeatCount: 4, // the last free staff seat
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        expect((await patchRole(base, 'm1', 'assessor')).status).toBe(200);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(forUpdate).toHaveBeenCalledWith('update');

        // Two admins promoting two candidates at once would otherwise both
        // pass a count neither of them had changed yet.
        const seatOps = ops.filter(
          (o) => o.op === 'lock' || o.op === 'count' || (o.op === 'update' && o.table === schema.memberships),
        );
        expect(seatOps.map((o) => `${o.on}:${o.op}`)).toEqual(['tx:lock', 'tx:count', 'tx:update']);
      } finally {
        server.close();
      }
    });

    it('re-roles a PENDING invite into a full pool without any seat check (U37, R80)', async () => {
      /*
        This check existed to stop "create a viewer invite, then PATCH it to
        candidate" walking around the creation-time check. Both are gone, and
        for the same reason: a pending invitation reserves nothing, so neither
        was guarding a seat. Nothing is bypassed, because the seat is settled at
        acceptance under the row lock — where a full candidate pool expands and a
        full staff pool refuses.
      */
      const { db, updateSet } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: undefined,
        invitesFindFirst: { id: 'inv-1', orgId: 'org-1', email: 'sam@x.io', role: 'viewer', acceptedAt: null },
        organizationsFindFirst: { ...FULL_STAFF_ORG, candidateSeatLimit: 3 },
        activeSeatCount: 3,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        expect((await patchRole(base, 'inv-1', 'candidate')).status).toBe(200);
        expect(updateSet).toHaveBeenCalledWith(schema.invites, { role: 'candidate' });
        // No block was bought either — nothing here consumed a seat to pay for.
        expect(updateSet.mock.calls.find(([table]) => table === schema.organizations)).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('expands a NULL candidate limit to 250 on Business, not to 50 (R86)', async () => {
      /*
        `candidate_seat_limit` is nullable and a null INHERITS from the tier
        rather than meaning unlimited. Writing a bare block size onto it would
        take this organisation from two hundred seats to fifty — a refusal for
        every candidate past the fiftieth, caused by the very write meant to add
        room. End-to-end here as well as in the unit test, because the resolution
        happens on the row the LOCK returned rather than the one the route read.
      */
      const { db, updateSet } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'builder', status: 'active' },
        usersFindFirst: { id: 'u2', name: 'Priya Nair', email: 'priya@x.io' },
        organizationsFindFirst: {
          id: 'org-1',
          name: 'Mine Co',
          planTier: 'business',
          seatLimit: 50,
          candidateSeatLimit: null,
        },
        activeSeatCount: 200,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        expect((await patchRole(base, 'm1', 'candidate')).status).toBe(200);
        expect(updateSet).toHaveBeenCalledWith(schema.organizations, { candidateSeatLimit: 250 });
      } finally {
        server.close();
      }
    });

    it('enrols nobody and buys no block on a tier allocated no candidate seats (AE38, R83)', async () => {
      // That plan does not enrol candidates at all, so there is no allocation to
      // expand INTO — selling a block would be selling a feature the plan does
      // not include. It refuses, and the refusal is the correct answer.
      const { db, updateSet } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'builder', status: 'active' },
        usersFindFirst: { id: 'u2', name: 'Priya Nair', email: 'priya@x.io' },
        organizationsFindFirst: {
          id: 'org-1',
          name: 'Solo Co',
          planTier: 'individual',
          seatLimit: 1,
          candidateSeatLimit: null,
        },
        activeSeatCount: 0,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await patchRole(base, 'm1', 'candidate');
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'candidate_limit_reached', seatLimit: 0 });
        expect(updateSet.mock.calls.find(([table]) => table === schema.organizations)).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('re-roles a pending STAFF invite into a full staff pool too (R80)', async () => {
      const { db, updateSet } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: undefined,
        invitesFindFirst: { id: 'inv-1', orgId: 'org-1', email: 'sam@x.io', role: 'candidate', acceptedAt: null },
        organizationsFindFirst: FULL_STAFF_ORG,
        activeSeatCount: 5,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        expect((await patchRole(base, 'inv-1', 'assessor')).status).toBe(200);
        expect(updateSet).toHaveBeenCalledWith(schema.invites, { role: 'assessor' });
      } finally {
        server.close();
      }
    });

    it('leaves a same-pool invite re-role alone when the staff pool is full', async () => {
      const { db, updateSet } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: undefined,
        invitesFindFirst: { id: 'inv-1', orgId: 'org-1', email: 'sam@x.io', role: 'viewer', acceptedAt: null },
        organizationsFindFirst: FULL_STAFF_ORG,
        activeSeatCount: 5,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        // Creating this invite already cleared the staff pool; nothing about
        // viewer → builder asks for a second seat.
        expect((await patchRole(base, 'inv-1', 'builder')).status).toBe(200);
        expect(updateSet.mock.calls.find(([table]) => table === schema.invites)?.[1]).toEqual({
          role: 'builder',
        });
      } finally {
        server.close();
      }
    });
  });
});

describe('DELETE /team/members/:id', () => {
  it('403s for a caller whose role lacks team.manage', async () => {
    mockDbValue = fakeDb({ rolePermissionsFindFirst: VIEWER_PERMS }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m1`, { method: 'DELETE', headers: authHeader(viewerTenant) });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('blocks removing the last remaining owner', async () => {
    mockDbValue = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm1', userId: 'u1', orgId: 'org-1', role: 'owner', status: 'active' },
      membershipsFindMany: [{ id: 'm1', userId: 'u1', orgId: 'org-1', role: 'owner', status: 'active' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m1`, { method: 'DELETE', headers: authHeader(adminTenant) });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('cannot_remove_last_owner');
    } finally {
      server.close();
    }
  });

  it('blocks deactivating the last ACTIVE owner even when a suspended owner exists (R65)', async () => {
    // A suspended owner cannot sign in, so the guard counts only active owners.
    // The fixture models a predicate-honouring database applying the new
    // status='active' filter: the org holds two owners, but only the active one
    // (m-b) comes back. Deactivating it would strand the org with no owner who
    // can act — under the old status-blind query both owners returned and the
    // removal was wrongly allowed.
    mockDbValue = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm-b', userId: 'u-b', orgId: 'org-1', role: 'owner', status: 'active' },
      membershipsFindMany: [{ id: 'm-b', userId: 'u-b', orgId: 'org-1', role: 'owner', status: 'active' }],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m-b`, { method: 'DELETE', headers: authHeader(adminTenant) });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('cannot_remove_last_owner');
    } finally {
      server.close();
    }
  });

  it('DEACTIVATES a non-owner member rather than deleting them (R62, R63)', async () => {
    /*
      This route used to `DELETE` the membership row, which took the person's
      placement with it on cascade and left the competency evidence that
      certified them pointing at a membership that no longer existed. R62 makes
      leaving a deactivation and R63 retains every record indefinitely — which
      is the whole reason a returning worker keeps competencies still in date.
    */
    const { db, deleteWhere, updateSet, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'viewer', status: 'active' },
      usersFindFirst: { id: 'u2', name: 'Tom Reyes', email: 'tom@x.io' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m2`, { method: 'DELETE', headers: authHeader(adminTenant) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ seatReleased: 'staff' });
      // The membership moves to suspended; nothing is deleted.
      expect(updateSet).toHaveBeenCalledWith(schema.memberships, { status: 'suspended' });
      expect(deleteWhere).not.toHaveBeenCalled();
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({ action: 'Deactivated member' });
    } finally {
      server.close();
    }
  });

  it('releases the CANDIDATE seat where the membership carried that level (R77)', async () => {
    const { db } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'candidate', status: 'active' },
      usersFindFirst: { id: 'u2', name: 'Dale Rivers', email: 'dale@x.io' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m2`, { method: 'DELETE', headers: authHeader(adminTenant) });
      expect(await res.json()).toMatchObject({ seatReleased: 'candidate' });
    } finally {
      server.close();
    }
  });

  it('reactivates a candidate with NO free seat, buying a block (AE36, R78, R86)', async () => {
    /*
      A returning worker turned away at the allocation boundary would stop work
      on a site to settle a billing question. R78 takes the seat, R86 buys it.
    */
    const { db, updateSet, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'candidate', status: 'suspended' },
      usersFindFirst: { id: 'u2', name: 'Dale Rivers', email: 'dale@x.io', passwordHash: 'x' },
      organizationsFindFirst: {
        id: 'org-1',
        name: 'Mine Co',
        planTier: 'business',
        seatLimit: 15,
        candidateSeatLimit: 3,
      },
      activeSeatCount: 3,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m2/reactivate`, {
        method: 'POST',
        headers: authHeader(adminTenant),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ seatConsumed: 'candidate', seatsAdded: 50 });
      expect(updateSet).toHaveBeenCalledWith(schema.organizations, { candidateSeatLimit: 53 });
      expect(updateSet).toHaveBeenCalledWith(schema.memberships, { status: 'active' });

      const audit = insertValues.mock.calls.find(
        ([table, v]) => table === schema.auditLogEntries && (v as { category?: string }).category === 'billing',
      );
      expect(String(audit?.[1].target)).toContain('member reactivated');
    } finally {
      server.close();
    }
  });

  it('refuses to reactivate into a full STAFF pool, changing nothing (R80)', async () => {
    const { db, updateSet } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'assessor', status: 'suspended' },
      usersFindFirst: { id: 'u2', name: 'Dale Rivers', email: 'dale@x.io' },
      organizationsFindFirst: { id: 'org-1', name: 'Meridian', planTier: 'team', seatLimit: 5, candidateSeatLimit: 200 },
      activeSeatCount: 5,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m2/reactivate`, {
        method: 'POST',
        headers: authHeader(adminTenant),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'seat_limit_reached' });
      // Neither the status nor the limit moved — a refused reactivation leaves
      // the member exactly as deactivation left them.
      expect(updateSet.mock.calls.find(([table]) => table === schema.memberships)).toBeUndefined();
      expect(updateSet.mock.calls.find(([table]) => table === schema.organizations)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('reactivates a returner, and is idempotent on somebody already active (R68)', async () => {
    const { db, updateSet } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'candidate', status: 'suspended' },
      usersFindFirst: { id: 'u2', name: 'Dale Rivers', email: 'dale@x.io', passwordHash: 'x' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m2/reactivate`, {
        method: 'POST',
        headers: authHeader(adminTenant),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ seatConsumed: 'candidate', needsFreshInvitation: false });
      expect(updateSet).toHaveBeenCalledWith(schema.memberships, { status: 'active' });
    } finally {
      server.close();
    }

    const already = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'viewer', status: 'active' },
    });
    mockDbValue = already.db;
    const two = startApp();
    try {
      // A retried click is not a mistake.
      const res = await fetch(`${two.base}/team/members/m2/reactivate`, {
        method: 'POST',
        headers: authHeader(adminTenant),
      });
      expect(res.status).toBe(200);
    } finally {
      two.server.close();
    }
  });

  it('revokes a pending invite, deleting the row its token resolves through', async () => {
    const { db, deleteWhere, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: undefined,
      invitesFindFirst: { id: 'inv-1', orgId: 'org-1', email: 'sam@x.io', role: 'viewer', acceptedAt: null },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/inv-1`, { method: 'DELETE', headers: authHeader(adminTenant) });
      expect(res.status).toBe(204);
      // The row IS the credential: deleting it is what kills a link that has
      // already left the building.
      expect(deleteWhere.mock.calls.some(([table]) => table === schema.invites)).toBe(true);
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({ action: 'Revoked invite', target: 'sam@x.io' });
    } finally {
      server.close();
    }
  });
});

describe('GET /team/permissions', () => {
  it('returns every access level, defaulting the ones the org never customised (R28)', async () => {
    // Only two rows stored; the response still carries all seven levels, with
    // the rest resolved to their product defaults — so Assessor and Candidate
    // show the capabilities they hold rather than reading as all-off.
    mockDbValue = fakeDb({
      rolePermissionsFindMany: [
        { role: 'owner', matrix: { forms: { view: true } } },
        { role: 'viewer', matrix: { forms: { view: true } } },
      ],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/permissions`, { headers: authHeader(adminTenant) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, { assessments?: Record<string, unknown> }>;
      expect(Object.keys(body).sort()).toEqual(
        ['admin', 'assessor', 'builder', 'candidate', 'owner', 'reviewer', 'viewer'],
      );
      // The defaulted Assessor row carries its real assessment grants (R29, R30).
      expect(body.assessor?.assessments).toMatchObject({ view: true, create: true });
      // Candidate's own-scoped grant survives the round-trip (R31).
      expect(body.candidate?.assessments).toMatchObject({ view: 'own', edit: 'own' });
    } finally {
      server.close();
    }
  });
});

describe('PATCH /team/permissions', () => {
  it('403s for a caller whose role lacks team.manage', async () => {
    mockDbValue = fakeDb({ rolePermissionsFindFirst: VIEWER_PERMS }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/permissions`, {
        method: 'PATCH',
        headers: { ...authHeader(viewerTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'builder', category: 'forms', action: 'delete', allowed: true }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('updates one role/category/action without a no-op for Owner', async () => {
    const builderRow = { id: 'rp-builder', orgId: 'org-1', role: 'builder', matrix: { forms: { view: true, delete: false } } };
    const { db, updateSet } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      rolePermissionsFindMany: [builderRow],
    });
    // First findFirst call resolves the caller's own admin perms; the route
    // re-queries findFirst again for the target role's row — sequence both.
    (db.query.rolePermissions.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ADMIN_PERMS)
      .mockResolvedValueOnce(builderRow);
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/permissions`, {
        method: 'PATCH',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'builder', category: 'forms', action: 'delete', allowed: true }),
      });
      expect(res.status).toBe(200);
      const permsUpdate = updateSet.mock.calls.find(([table]) => table === schema.rolePermissions);
      expect(permsUpdate?.[1]).toEqual({ matrix: { forms: { view: true, delete: true } } });
    } finally {
      server.close();
    }
  });

  it('upserts a level with no stored row rather than silently no-opping (R29)', async () => {
    // Assessor and Candidate are the levels most likely to have no stored row —
    // the old `if (row)` with no else wrote nothing and returned 200 unchanged.
    const { db, insertValues } = fakeDb({ rolePermissionsFindMany: [] });
    (db.query.rolePermissions.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ADMIN_PERMS) // caller's own perms
      .mockResolvedValueOnce(undefined); // target 'assessor' has no stored row
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/permissions`, {
        method: 'PATCH',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'assessor', category: 'assessments', action: 'delete', allowed: true }),
      });
      expect(res.status).toBe(200);
      const insert = insertValues.mock.calls.find(([table]) => table === schema.rolePermissions);
      expect(insert).toBeDefined();
      const values = insert![1] as { role: string; matrix: Record<string, Record<string, unknown>> };
      expect(values.role).toBe('assessor');
      expect(values.matrix.assessments!.delete).toBe(true);
      // The default's other grants ride along, so the insert is a full matrix.
      expect(values.matrix.assessments!.view).toBe(true);
    } finally {
      server.close();
    }
  });

  it('refuses to toggle a scoped grant even on a defaulted level (R31)', async () => {
    const { db } = fakeDb({ rolePermissionsFindMany: [] });
    (db.query.rolePermissions.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ADMIN_PERMS) // caller
      .mockResolvedValueOnce(undefined); // candidate has no row → default carries 'own'
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/permissions`, {
        method: 'PATCH',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'candidate', category: 'assessments', action: 'view' }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('scoped_permission');
    } finally {
      server.close();
    }
  });

  it('flips the current value server-side when "allowed" is omitted', async () => {
    const builderRow = { id: 'rp-builder', orgId: 'org-1', role: 'builder', matrix: { forms: { view: true, delete: false } } };
    const { db, updateSet } = fakeDb({ rolePermissionsFindFirst: ADMIN_PERMS });
    (db.query.rolePermissions.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ADMIN_PERMS)
      .mockResolvedValueOnce(builderRow);
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/permissions`, {
        method: 'PATCH',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'builder', category: 'forms', action: 'delete' }),
      });
      expect(res.status).toBe(200);
      const permsUpdate = updateSet.mock.calls.find(([table]) => table === schema.rolePermissions);
      expect(permsUpdate?.[1]).toEqual({ matrix: { forms: { view: true, delete: true } } });
    } finally {
      server.close();
    }
  });

  it('no-ops for role "owner" (locked matrix)', async () => {
    const { db, updateSet } = fakeDb({ rolePermissionsFindFirst: ADMIN_PERMS });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/permissions`, {
        method: 'PATCH',
        headers: { ...authHeader(adminTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'owner', category: 'forms', action: 'delete', allowed: false }),
      });
      expect(res.status).toBe(200);
      expect(updateSet.mock.calls.find(([table]) => table === schema.rolePermissions)).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
