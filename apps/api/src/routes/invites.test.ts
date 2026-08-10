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
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
    onConflictDoNothing: () => Promise<undefined>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  awaitable.onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  return awaitable;
}

/** One org shape for the seat tests. Staff pool of 2, candidate pool of 3. */
const SMALL_ORG = {
  id: 'org-invited',
  name: 'Meridian Operations',
  planTier: 'team',
  seatLimit: 2,
  candidateSeatLimit: 3,
};

/**
 * `organizationsFindFirst` answers the UNLOCKED reads; `lockedOrg` answers the
 * `SELECT ... FOR UPDATE` inside the transaction and defaults to it. `seatsUsed`
 * is the membership count, and `txSeatsUsed` overrides it for the transaction
 * alone — the pair is how a test models a pool that filled up in the gap
 * between the advisory read and the lock.
 *
 * `ops` logs every statement in order, tagged with the surface that issued it
 * ('root' or 'tx'), so a test can assert the lock, the count and the membership
 * INSERT were genuinely one transaction rather than three loose statements.
 */
function fakeDb(opts: {
  invitesFindFirst?: unknown;
  membershipsFindFirst?: unknown;
  organizationsFindFirst?: unknown;
  usersFindFirst?: unknown;
  lockedOrg?: unknown;
  seatsUsed?: number;
  txSeatsUsed?: number;
  /** Rows the invite-claiming UPDATE returns — `[]` models losing the race. */
  claimResult?: unknown[];
}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();
  const forUpdate = vi.fn();
  const ops: Array<{ on: 'root' | 'tx'; op: 'lock' | 'count' | 'insert' | 'update'; table?: unknown }> = [];
  const lockedOrg = 'lockedOrg' in opts ? opts.lockedOrg : opts.organizationsFindFirst;

  const query = {
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
  };

  const makeSurface = (on: 'root' | 'tx') => ({
    query,
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          const used = (on === 'tx' ? opts.txSeatsUsed ?? opts.seatsUsed : opts.seatsUsed) ?? 0;
          const rows =
            table === schema.organizations ? (lockedOrg ? [lockedOrg] : []) : [{ count: used }];
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
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        ops.push({ on, op: 'insert', table });
        return insertResult([{ id: 'new', ...(v as object) }]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        ops.push({ on, op: 'update', table });
        return { where: () => ({ returning: () => Promise.resolve(opts.claimResult ?? [PENDING_INVITE]) }) };
      },
    })),
  });

  const tx = makeSurface('tx') as Record<string, unknown>;
  // insertUserWithUsername runs each attempt in its own savepoint (a nested
  // transaction), so the tx surface must offer one — running the callback
  // against itself, so the insert still records on the tx.
  tx.transaction = async (fn: (t: unknown) => Promise<unknown>) => fn(tx);
  const transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  const db = { ...makeSurface('root'), transaction } as unknown as Db;

  return { db, insertValues, updateSet, forUpdate, ops, transaction };
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

  /**
   * Acceptance is the only thing holding the seat count down: a pending invite
   * reserves nothing, so an org can hold far more outstanding invites than it
   * has free seats, and a site induction hands out bulk QR codes that get
   * redeemed within seconds of each other.
   *
   * What these cover is that the count and the membership INSERT are ONE step
   * behind a row lock. Two acceptances reading `used = limit - 1` separately
   * would both pass and both join, and nothing downstream would notice —
   * `memberships_user_org_uq` only stops one user joining twice.
   */
  describe('seat limits', () => {
    it('refuses when the staff pool is already full, leaving the token unspent', async () => {
      const { db, insertValues, updateSet } = fakeDb({
        invitesFindFirst: PENDING_INVITE,
        membershipsFindFirst: undefined,
        lockedOrg: SMALL_ORG,
        seatsUsed: 2,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/invites/tok-abc/accept`, {
          method: 'POST',
          headers: authHeader(memberTenant),
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          error: 'seat_limit_reached',
          seatLimit: 2,
          seatUsed: 2,
        });
        expect(insertValues.mock.calls.find(([t]) => t === schema.memberships)).toBeUndefined();
        // Not consumed: the holder can still redeem it once a seat frees.
        expect(updateSet.mock.calls.find(([t]) => t === schema.invites)).toBeUndefined();
        expect(res.headers.get('set-cookie')).toBeNull();
      } finally {
        server.close();
      }
    });

    it('locks the org row, then counts, then inserts — all on the one transaction', async () => {
      const { db, forUpdate, ops, transaction } = fakeDb({
        invitesFindFirst: PENDING_INVITE,
        membershipsFindFirst: undefined,
        lockedOrg: SMALL_ORG,
        seatsUsed: 1, // the last free seat
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/invites/tok-abc/accept`, {
          method: 'POST',
          headers: authHeader(memberTenant),
        });
        expect(res.status).toBe(200);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(forUpdate).toHaveBeenCalledWith('update');

        // The order is the fix. A lock that came after the count, or a count
        // taken on the root client, would leave exactly the gap this closes.
        const seatOps = ops.filter(
          (o) => o.op === 'lock' || o.op === 'count' || (o.op === 'insert' && o.table === schema.memberships),
        );
        expect(seatOps.map((o) => `${o.on}:${o.op}`)).toEqual(['tx:lock', 'tx:count', 'tx:insert']);
      } finally {
        server.close();
      }
    });

    it('EXPANDS the candidate pool at acceptance rather than stranding the holder (U37, R80, R86)', async () => {
      /*
        This used to 403. Somebody standing at a site induction with a QR code
        in their hand is not the person to settle a billing question with, and
        the invitation was issued precisely so they could join — so a full
        candidate pool buys a block and lets them in.

        The write happens under the lock this count was taken beneath, which is
        what stops two acceptances arriving together buying a block each for one
        seat.
      */
      const { db, updateSet, insertValues, ops } = fakeDb({
        invitesFindFirst: { ...PENDING_INVITE, role: 'candidate' },
        membershipsFindFirst: undefined,
        lockedOrg: SMALL_ORG,
        seatsUsed: 3,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/invites/tok-abc/accept`, {
          method: 'POST',
          headers: authHeader(memberTenant),
        });
        expect(res.status).toBe(200);
        expect(updateSet).toHaveBeenCalledWith(schema.organizations, { candidateSeatLimit: 53 });
        expect(insertValues.mock.calls.find(([table]) => table === schema.memberships)).toBeDefined();

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

    it('still refuses acceptance into a full STAFF pool, which does not expand (R80)', async () => {
      const { db, insertValues, updateSet } = fakeDb({
        invitesFindFirst: { ...PENDING_INVITE, role: 'assessor' },
        membershipsFindFirst: undefined,
        lockedOrg: SMALL_ORG,
        seatsUsed: 2,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/invites/tok-abc/accept`, {
          method: 'POST',
          headers: authHeader(memberTenant),
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'seat_limit_reached', seatLimit: 2 });
        expect(insertValues.mock.calls.find(([table]) => table === schema.memberships)).toBeUndefined();
        expect(updateSet.mock.calls.find(([table]) => table === schema.organizations)).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('skips the count entirely on an unlimited pool', async () => {
      const { db, ops } = fakeDb({
        invitesFindFirst: { ...PENDING_INVITE, role: 'candidate' },
        membershipsFindFirst: undefined,
        // Enterprise: candidateSeatLimit null means unlimited, not "inherit".
        lockedOrg: { ...SMALL_ORG, planTier: 'enterprise', candidateSeatLimit: null },
        seatsUsed: 900,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/invites/tok-abc/accept`, {
          method: 'POST',
          headers: authHeader(memberTenant),
        });
        expect(res.status).toBe(200);
        expect(ops.some((o) => o.op === 'count' && o.table === schema.memberships)).toBe(false);
      } finally {
        server.close();
      }
    });
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

  it('gets past the pre-hash check on a full candidate pool, and expands under the lock (R80, R86)', async () => {
    /*
      TWO claims, and the first is the one that used to fail. The unlocked
      pre-hash check ran BEFORE bcrypt and refused a full pool outright, so an
      accepting candidate never reached the locked check that could have
      expanded for them. It now defers on the candidate pool entirely.

      The second: it performs no expansion ITSELF. Writing a charged block from
      an unlocked check is exactly the double-charge the lock exists to prevent,
      so the single organizations UPDATE here is the locked one.
    */
    const { db, updateSet, insertValues, ops } = fakeDb({
      invitesFindFirst: { ...PENDING_INVITE, role: 'candidate' },
      usersFindFirst: undefined,
      lockedOrg: SMALL_ORG,
      organizationsFindFirst: SMALL_ORG,
      seatsUsed: 3,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await signup(base, 'tok-abc', GOOD);
      expect(res.status).toBe(201);

      const orgUpdates = updateSet.mock.calls.filter(([table]) => table === schema.organizations);
      expect(orgUpdates).toHaveLength(1);
      expect(orgUpdates[0]![1]).toEqual({ candidateSeatLimit: 53 });
      expect(insertValues.mock.calls.find(([t]) => t === schema.memberships)).toBeDefined();

      // The block was bought on the transaction, after the lock.
      const seatOps = ops.filter((o) => o.op === 'lock' || (o.op === 'update' && o.table === schema.organizations));
      expect(seatOps.map((o) => `${o.on}:${o.op}`)).toEqual(['tx:lock', 'tx:update']);
    } finally {
      server.close();
    }
  });

  it('still refuses a full STAFF pool before spending the hash (R80)', async () => {
    // The staff pool does not expand, so the pre-hash refusal still saves a
    // deliberately-slow KDF on a request the locked check would refuse anyway.
    const { db, insertValues } = fakeDb({
      invitesFindFirst: { ...PENDING_INVITE, role: 'assessor' },
      usersFindFirst: undefined,
      organizationsFindFirst: SMALL_ORG,
      lockedOrg: SMALL_ORG,
      seatsUsed: 2,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await signup(base, 'tok-abc', GOOD);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'seat_limit_reached' });
      expect(insertValues.mock.calls.find(([t]) => t === schema.users)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('buys NO second block while the first still has room', async () => {
    /*
      One block covers the next fifty acceptances. Expanding again on each of
      them would charge an organisation fifty times for fifty seats it had
      already bought once — which is why the check reads the limit the LOCK
      returns rather than any value read earlier.
    */
    const { db, updateSet } = fakeDb({
      invitesFindFirst: { ...PENDING_INVITE, role: 'candidate' },
      usersFindFirst: undefined,
      lockedOrg: { ...SMALL_ORG, candidateSeatLimit: 53 },
      organizationsFindFirst: { ...SMALL_ORG, candidateSeatLimit: 53 },
      seatsUsed: 4,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      expect((await signup(base, 'tok-abc', GOOD)).status).toBe(201);
      expect(updateSet.mock.calls.find(([table]) => table === schema.organizations)).toBeUndefined();
    } finally {
      server.close();
    }
  });
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

  /**
   * The same race as `/accept`, with an account creation in the middle of it.
   * This path checks seats TWICE on purpose: once unlocked so a doomed request
   * is refused before a bcrypt hash is spent on it, then again under the lock,
   * which is the one that actually binds.
   */
  describe('seat limits', () => {
    it('refuses a full org before opening a transaction at all', async () => {
      const { db, insertValues, transaction } = fakeDb({
        invitesFindFirst: PENDING_INVITE,
        usersFindFirst: undefined,
        organizationsFindFirst: SMALL_ORG,
        seatsUsed: 2,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await signup(base, 'tok-abc', GOOD);
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'seat_limit_reached' });
        // Cheap refusal: no hash, no transaction, no account.
        expect(transaction).not.toHaveBeenCalled();
        expect(insertValues.mock.calls.find(([t]) => t === schema.users)).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('still refuses when the pool fills between the unlocked read and the lock', async () => {
      const { db, insertValues, updateSet } = fakeDb({
        invitesFindFirst: PENDING_INVITE,
        usersFindFirst: undefined,
        organizationsFindFirst: SMALL_ORG,
        seatsUsed: 1, // the advisory read saw the last free seat...
        txSeatsUsed: 2, // ...and someone took it before the lock was granted
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await signup(base, 'tok-abc', GOOD);
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'seat_limit_reached', seatUsed: 2 });

        // Nothing was written. An orphaned users row would be worse than no
        // row: the retry, once a seat frees, hits `account_exists` — and this
        // route will not touch an existing account, so the invite becomes
        // permanently unredeemable by the person holding it.
        expect(insertValues.mock.calls.find(([t]) => t === schema.users)).toBeUndefined();
        expect(insertValues.mock.calls.find(([t]) => t === schema.memberships)).toBeUndefined();
        expect(updateSet.mock.calls.find(([t]) => t === schema.invites)).toBeUndefined();
        expect(res.headers.get('set-cookie')).toBeNull();
      } finally {
        server.close();
      }
    });

    it('creates the account, claims the invite and joins the org on one transaction', async () => {
      const { db, ops, transaction } = fakeDb({
        invitesFindFirst: PENDING_INVITE,
        usersFindFirst: undefined,
        organizationsFindFirst: SMALL_ORG,
        seatsUsed: 1,
      });
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        expect((await signup(base, 'tok-abc', GOOD)).status).toBe(201);
        expect(transaction).toHaveBeenCalledTimes(1);

        // Everything that would have to be undone together ran inside it. The
        // audit entry is the one deliberate exception, as on `/accept`.
        const rootWrites = ops.filter((o) => (o.op === 'insert' || o.op === 'update') && o.on === 'root');
        expect(rootWrites.map((o) => o.table)).toEqual([schema.auditLogEntries]);
      } finally {
        server.close();
      }
    });
  });
});
