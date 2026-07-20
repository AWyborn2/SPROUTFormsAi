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
}) {
  const updateSet = vi.fn();
  const deleteWhere = vi.fn();
  const insertValues = vi.fn();

  const db = {
    query: {
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
    },
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

  return { db, updateSet, deleteWhere, insertValues };
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
      expect(body).toEqual([{ id: 'm1', name: 'Ash Wyborn', email: 'ash@x.io', role: 'admin', status: 'active' }]);
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
        { id: 'm1', name: 'Ash Wyborn', email: 'ash@x.io', role: 'admin', status: 'active' },
        { id: 'inv-1', name: 'Sam Lee', email: 'sam.lee@x.io', role: 'builder', status: 'invited' },
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
      expect(await res.json()).toEqual({ id: 'inv-new', name: 'Sam Lee', email: 'sam.lee@x.io', role: 'builder', status: 'invited', emailSent: true });

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

  it('sends the invite email with the tenant org name and inviter after the rows commit', async () => {
    const { db } = fakeDb({
      rolePermissionsFindFirst: ADMIN_PERMS,
      usersFindMany: [],
      usersFindFirst: { id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' },
      organizationsFindFirst: { id: 'org-1', name: 'Meridian Operations' },
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
      organizationsFindFirst: { id: 'org-1', name: 'Meridian Operations' },
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
  it('returns the full org matrix keyed by role', async () => {
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['owner', 'viewer']);
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
