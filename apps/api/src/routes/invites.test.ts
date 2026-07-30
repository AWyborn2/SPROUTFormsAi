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
      users: {
        // `in` rather than `??` so a test can say "no such user" with an
        // explicit undefined — the signup path turns entirely on that answer.
        findFirst: vi
          .fn()
          .mockResolvedValue('usersFindFirst' in opts ? opts.usersFindFirst : { id: 'u1', name: 'Sam Lee' }),
      },
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

/**
 * The concierge signup path: an invited person creating their account.
 *
 * This is a PUBLIC route that mints a session, so what matters here is what it
 * refuses — a wrong address on an emailed invite, an address that already has
 * an account, and a second redemption of the same token.
 */
describe('POST /invites/:token/signup', () => {
  const QR_INVITE = { ...PENDING_INVITE, id: 'inv-qr', email: null, inviteeName: 'Dale Rivers' };
  const GOOD = { name: 'Sam Lee', email: 'Sam@x.io', password: 'correct horse battery' };

  async function signup(base: string, token: string, body: Record<string, unknown>) {
    return fetch(`${base}/invites/${token}/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('creates the account, claims the invite, grants the role and seals a session', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      invitesFindFirst: PENDING_INVITE,
      usersFindFirst: undefined, // no existing account for this address
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await signup(base, 'tok-abc', GOOD);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ orgId: 'org-invited', role: 'builder' });

      // Address is stored lowercased, and the password is never stored raw.
      const userInsert = insertValues.mock.calls.find(([t]) => t === schema.users);
      const user = userInsert?.[1] as { email: string; passwordHash: string };
      expect(user.email).toBe('sam@x.io');
      expect(user.passwordHash).not.toContain('correct horse battery');

      // The TOKEN decides the role — nothing in the body could influence it.
      const membership = insertValues.mock.calls.find(([t]) => t === schema.memberships);
      expect(membership?.[1]).toMatchObject({ orgId: 'org-invited', role: 'builder', status: 'active' });

      expect(updateSet.mock.calls.find(([t]) => t === schema.invites)?.[1]).toMatchObject({
        acceptedByUserId: expect.any(String),
      });
      expect(res.headers.get('set-cookie')).toContain('fai_session=');
    } finally {
      server.close();
    }
  });

  it('accepts any address on a QR invite, which names nobody', async () => {
    const { db } = fakeDb({ invitesFindFirst: QR_INVITE, usersFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await signup(base, 'tok-abc', { ...GOOD, email: 'dale.rivers@personal.example' });
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });

  it('refuses a different address on an emailed invite, so a forwarded email is not redeemable', async () => {
    const { db, insertValues } = fakeDb({ invitesFindFirst: PENDING_INVITE, usersFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await signup(base, 'tok-abc', { ...GOOD, email: 'someone.else@x.io' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'email_mismatch' });
      expect(insertValues.mock.calls.find(([t]) => t === schema.users)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('never overwrites an existing account — an invite is not a password reset', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      invitesFindFirst: PENDING_INVITE,
      usersFindFirst: { id: 'u-existing', email: 'sam@x.io', passwordHash: 'their-own-hash' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await signup(base, 'tok-abc', GOOD);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'account_exists' });
      // Above all: no write touched the existing identity, and no session was
      // issued for it. Otherwise any invite naming an address takes it over.
      expect(insertValues.mock.calls.find(([t]) => t === schema.users)).toBeUndefined();
      expect(updateSet.mock.calls.find(([t]) => t === schema.users)).toBeUndefined();
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      server.close();
    }
  });

  it('404s on an already-redeemed token rather than minting a second membership', async () => {
    // The invite reads as pending but the claiming UPDATE matches no row —
    // someone redeemed it in between.
    const { db, insertValues } = fakeDb({
      invitesFindFirst: PENDING_INVITE,
      usersFindFirst: undefined,
      claimResult: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await signup(base, 'tok-abc', GOOD);
      expect(res.status).toBe(404);
      expect(insertValues.mock.calls.find(([t]) => t === schema.memberships)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('rejects a short password before touching the database', async () => {
    const { db, insertValues } = fakeDb({ invitesFindFirst: PENDING_INVITE, usersFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await signup(base, 'tok-abc', { ...GOOD, password: 'short' });
      expect(res.status).toBe(400);
      expect(insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s on an unknown token without disclosing anything', async () => {
    const { db } = fakeDb({ invitesFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await signup(base, 'nope', GOOD);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'invite_not_found' });
    } finally {
      server.close();
    }
  });
});
