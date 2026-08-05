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
      findFirst: vi.fn().mockResolvedValue(opts.membershipsFindFirst),
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
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([
        { id: 'm1', userId: 'u1', name: 'Ash Wyborn', email: 'ash@x.io', role: 'admin', status: 'active' },
      ]);
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
    }).db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members`, { headers: authHeader(adminTenant) });
      expect(res.status).toBe(200);
      // The invitee has no user row yet — the name is derived from the address
      // the inviter typed, and `status` is what marks them as not-yet-joined.
      expect(await res.json()).toEqual([
        { id: 'm1', userId: 'u1', name: 'Ash Wyborn', email: 'ash@x.io', role: 'admin', status: 'active' },
        { id: 'inv-1', userId: null, name: 'Sam Lee', email: 'sam.lee@x.io', role: 'builder', status: 'invited' },
      ]);
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

  it('403s with seat_limit_reached when active seats already fill the org seatLimit', async () => {
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
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; seatLimit: number; seatUsed: number };
      expect(body.error).toBe('seat_limit_reached');
      expect(body.seatLimit).toBe(1);
      expect(body.seatUsed).toBe(1);
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeUndefined();
      expect(emailMocks.sendInviteEmail).not.toHaveBeenCalled();
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

  it('403s with candidate_limit_reached, distinct from the staff seat error', async () => {
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
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; seatLimit: number };
      expect(body.error).toBe('candidate_limit_reached');
      expect(body.seatLimit).toBe(200);
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeUndefined();
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

  it('403s with seat_limit_reached via the plan-tier fallback when org.seatLimit is null', async () => {
    const { db, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      // Legacy org row: seatLimit was never backfilled — the team tier's
      // configured limit (5) must still be enforced.
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
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; seatLimit: number; seatUsed: number };
      expect(body.error).toBe('seat_limit_reached');
      expect(body.seatLimit).toBe(5);
      expect(body.seatUsed).toBe(5);
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeUndefined();
      expect(emailMocks.sendInviteEmail).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('403s with seat_limit_reached when seatLimit is absent from the org row entirely', async () => {
    // `N >= undefined` is false, so a missing column must not bypass enforcement.
    const { db, insertValues } = fakeDb({
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
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; seatLimit: number };
      expect(body.error).toBe('seat_limit_reached');
      expect(body.seatLimit).toBe(1);
      expect(insertValues.mock.calls.find(([table]) => table === schema.invites)).toBeUndefined();
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

    it('refuses the same demotion when it is the CANDIDATE pool that is full', async () => {
      const { db, updateSet } = fakeDb({
        rolePermissionsFindFirst: ADMIN_PERMS,
        membershipsFindFirst: { id: 'm1', userId: 'u2', orgId: 'org-1', role: 'builder', status: 'active' },
        usersFindFirst: { id: 'u2', name: 'Priya Nair', email: 'priya@x.io' },
        organizationsFindFirst: { ...FULL_STAFF_ORG, seatLimit: 50, candidateSeatLimit: 3 },
        activeSeatCount: 3,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await patchRole(base, 'm1', 'candidate');
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'candidate_limit_reached', seatLimit: 3 });
        expect(updateSet.mock.calls.find(([table]) => table === schema.memberships)).toBeUndefined();
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

    it('refuses re-roling a PENDING invite into a full pool, closing the creation-check bypass', async () => {
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
        // Otherwise: create a viewer invite, PATCH it to candidate, and the
        // candidate limit checked at creation never applies.
        const res = await patchRole(base, 'inv-1', 'candidate');
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'candidate_limit_reached' });
        expect(updateSet.mock.calls.find(([table]) => table === schema.invites)).toBeUndefined();
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

  it('removes a non-owner member and records an audit entry', async () => {
    const { db, deleteWhere, insertValues } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      membershipsFindFirst: { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'viewer', status: 'active' },
      usersFindFirst: { id: 'u2', name: 'Tom Reyes', email: 'tom@x.io' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m2`, { method: 'DELETE', headers: authHeader(adminTenant) });
      expect(res.status).toBe(204);
      expect(deleteWhere).toHaveBeenCalled();
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({ action: 'Removed member', target: 'tom@x.io' });
    } finally {
      server.close();
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
