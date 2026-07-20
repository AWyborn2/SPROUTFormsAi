import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

const memberTenant = { userId: 'u1', orgId: 'org-own', role: 'owner' as const };
let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { createApp } = await import('../app.js');
({ sealSession } = await import('../auth/replit-auth.js'));

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader(tenant: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(tenant)}` };
}

const PENDING_INVITE = {
  id: 'inv-1',
  orgId: 'org-invited',
  email: 'sam@x.io',
  role: 'builder' as const,
  token: 'tok-abc',
  expiresAt: null,
  acceptedAt: null,
  acceptedByUserId: null,
};

function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown[]> };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

function fakeDb(opts: {
  invitesFindFirst?: unknown;
  membershipsFindFirst?: unknown;
  organizationsFindFirst?: unknown;
  usersFindFirst?: unknown;
  /** Rows the invite-claiming UPDATE returns — `[]` models losing the race. */
  claimResult?: unknown[];
  membershipInsertError?: unknown;
}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();

  const db = {
    query: {
      invites: { findFirst: vi.fn().mockResolvedValue(opts.invitesFindFirst) },
      memberships: { findFirst: vi.fn().mockResolvedValue(opts.membershipsFindFirst) },
      organizations: { findFirst: vi.fn().mockResolvedValue(opts.organizationsFindFirst) },
      users: { findFirst: vi.fn().mockResolvedValue(opts.usersFindFirst ?? { id: 'u1', name: 'Sam Lee' }) },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        if (table === schema.memberships && opts.membershipInsertError) throw opts.membershipInsertError;
        return insertResult([{ id: 'new', ...(v as object) }]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: () => ({ returning: () => Promise.resolve(opts.claimResult ?? [PENDING_INVITE]) }) };
      },
    })),
  } as unknown as Db;

  return { db, insertValues, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /invites/:token', () => {
  it('describes the invite to an unauthenticated visitor without leaking org internals', async () => {
    mockDbValue = fakeDb({
      invitesFindFirst: PENDING_INVITE,
      organizationsFindFirst: { id: 'org-invited', name: 'Meridian Operations' },
    }).db;
    const { server, base } = startApp();
    try {
      // No cookie: the landing screen has to render before anyone signs in.
      const res = await fetch(`${base}/invites/tok-abc`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ orgName: 'Meridian Operations', role: 'builder', email: 'sam@x.io' });
      // Nothing about the org beyond its name — no id, no members, no forms.
      expect(JSON.stringify(body)).not.toContain('org-invited');
    } finally {
      server.close();
    }
  });

  it('404s for an unknown token', async () => {
    mockDbValue = fakeDb({ invitesFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/invites/nope`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('POST /invites/:token/accept', () => {
  it('401s without a session — the token alone does not join anyone', async () => {
    mockDbValue = fakeDb({ invitesFindFirst: PENDING_INVITE }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/invites/tok-abc/accept`, { method: 'POST' });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('binds the membership to the authenticated caller and re-seals their session onto the org', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      invitesFindFirst: PENDING_INVITE,
      membershipsFindFirst: undefined,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/invites/tok-abc/accept`, {
        method: 'POST',
        headers: authHeader(memberTenant),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ orgId: 'org-invited', role: 'builder' });

      // Bound to whoever held the session, NOT to anything derived from
      // invite.email — that address named a mailbox, never an identity.
      const membershipInsert = insertValues.mock.calls.find(([table]) => table === schema.memberships);
      expect(membershipInsert?.[1]).toMatchObject({
        userId: 'u1',
        orgId: 'org-invited',
        role: 'builder',
        status: 'active',
      });
      expect(updateSet.mock.calls.find(([table]) => table === schema.invites)?.[1]).toMatchObject({
        acceptedByUserId: 'u1',
      });
      // Without the re-seal the caller stays in their old org and acceptance
      // looks like it did nothing.
      expect(res.headers.get('set-cookie')).toContain('fai_session=');
    } finally {
      server.close();
    }
  });

  it('404s on replay: a token that has already been accepted is spent', async () => {
    mockDbValue = fakeDb({ invitesFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/invites/tok-abc/accept`, {
        method: 'POST',
        headers: authHeader(memberTenant),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('404s when a concurrent accept won the claim, writing no membership', async () => {
    const { db, insertValues } = fakeDb({
      invitesFindFirst: PENDING_INVITE,
      membershipsFindFirst: undefined,
      // The conditional UPDATE matched nothing: someone else claimed it first.
      claimResult: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/invites/tok-abc/accept`, {
        method: 'POST',
        headers: authHeader(memberTenant),
      });
      expect(res.status).toBe(404);
      expect(insertValues.mock.calls.find(([table]) => table === schema.memberships)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('409s when the caller already belongs to the invited org, leaving the invite pending', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      invitesFindFirst: PENDING_INVITE,
      membershipsFindFirst: { id: 'm1', userId: 'u1', orgId: 'org-invited', role: 'viewer' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/invites/tok-abc/accept`, {
        method: 'POST',
        headers: authHeader(memberTenant),
      });
      expect(res.status).toBe(409);
      expect(insertValues.mock.calls.find(([table]) => table === schema.memberships)).toBeUndefined();
      // Not consumed — the invite is still there to be accepted by its holder.
      expect(updateSet.mock.calls.find(([table]) => table === schema.invites)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('records an audit entry in the invited org, not the caller\'s previous one', async () => {
    const { db, insertValues } = fakeDb({
      invitesFindFirst: PENDING_INVITE,
      membershipsFindFirst: undefined,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/invites/tok-abc/accept`, { method: 'POST', headers: authHeader(memberTenant) });
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({
        orgId: 'org-invited',
        action: 'Accepted invite',
        target: 'sam@x.io',
      });
    } finally {
      server.close();
    }
  });
});
