/**
 * Password reset — the split that keeps assessment evidence meaningful.
 *
 * An admin can ISSUE a reset but never completes one. If they could set a
 * candidate's password they could sign in as that candidate, and since the same
 * admins mark the assessments those candidates sit, a signed "satisfactory"
 * would stop proving the candidate was ever there. These tests pin both halves:
 * the issuing route hands back a token and no secret, and the redeeming route
 * is single-use and grants no session.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

const adminTenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
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

const ADMIN_PERMS = { permissions: { team: { manage: true } } };
const NEW_PASSWORD = 'a whole new passphrase';
const LIVE_RESET = {
  id: 'pr-1',
  userId: 'u-candidate',
  orgId: 'org-1',
  token: 'tok-reset',
  issuedByUserId: 'u1',
  expiresAt: new Date(Date.now() + 60_000),
  usedAt: null,
};

function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

function fakeDb(opts: {
  passwordResetsFindFirst?: unknown;
  membershipsFindFirst?: unknown;
  usersFindFirst?: unknown;
  rolePermissionsFindFirst?: unknown;
  /** Rows the burn UPDATE returns — `[]` models losing the single-use race. */
  burnResult?: unknown[];
}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();

  const db = {
    query: {
      passwordResets: { findFirst: vi.fn().mockResolvedValue(opts.passwordResetsFindFirst) },
      memberships: { findFirst: vi.fn().mockResolvedValue(opts.membershipsFindFirst) },
      users: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            'usersFindFirst' in opts ? opts.usersFindFirst : { id: 'u-candidate', name: 'Dale Rivers' },
          ),
      },
      rolePermissions: {
        findFirst: vi.fn().mockResolvedValue(opts.rolePermissionsFindFirst ?? ADMIN_PERMS),
      },
      organizations: { findFirst: vi.fn().mockResolvedValue({ id: 'org-1', name: 'Meridian' }) },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        return insertResult([{ id: 'pr-new', ...(v as object) }]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return {
          where: () => {
            const done = Promise.resolve(undefined) as Promise<undefined> & {
              returning: () => Promise<unknown[]>;
            };
            done.returning = () =>
              Promise.resolve(
                table === schema.passwordResets ? (opts.burnResult ?? [LIVE_RESET]) : [{ id: 'x' }],
              );
            return done;
          },
        };
      },
    })),
  } as unknown as Db;

  return { db, insertValues, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('POST /team/members/:id/password-reset', () => {
  it('issues a link and never returns or sets a password', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      membershipsFindFirst: { id: 'm-1', userId: 'u-candidate', orgId: 'org-1', role: 'candidate' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m-1/password-reset`, {
        method: 'POST',
        headers: { cookie: `fai_session=${sealSession(adminTenant)}` },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resetPath).toMatch(/^\/reset-password\/.+/);

      // The whole point: the admin gets a token to hand over, and no route
      // here writes a password on the candidate's behalf.
      expect(updateSet.mock.calls.find(([t]) => t === schema.users)).toBeUndefined();

      const reset = insertValues.mock.calls.find(([t]) => t === schema.passwordResets);
      expect(reset?.[1]).toMatchObject({ userId: 'u-candidate', orgId: 'org-1', issuedByUserId: 'u1' });
    } finally {
      server.close();
    }
  });

  it('404s for a membership in another org, so an admin cannot reach outside their tenant', async () => {
    // The route looks the membership up scoped by orgId; a foreign one misses.
    const { db, insertValues } = fakeDb({ membershipsFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m-elsewhere/password-reset`, {
        method: 'POST',
        headers: { cookie: `fai_session=${sealSession(adminTenant)}` },
      });
      expect(res.status).toBe(404);
      expect(insertValues.mock.calls.find(([t]) => t === schema.passwordResets)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('refuses a caller without team management', async () => {
    const { db, insertValues } = fakeDb({
      membershipsFindFirst: { id: 'm-1', userId: 'u-candidate', orgId: 'org-1' },
      rolePermissionsFindFirst: { permissions: { team: { manage: false } } },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/members/m-1/password-reset`, {
        method: 'POST',
        headers: { cookie: `fai_session=${sealSession({ ...adminTenant, role: 'candidate' })}` },
      });
      expect(res.status).toBe(403);
      expect(insertValues.mock.calls.find(([t]) => t === schema.passwordResets)).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe('GET /reset-password/:token', () => {
  it('confirms a live link with a name and nothing identifying', async () => {
    const { db } = fakeDb({ passwordResetsFindFirst: LIVE_RESET });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // No cookie — someone locked out has no session.
      const res = await fetch(`${base}/reset-password/tok-reset`);
      expect(res.status).toBe(200);
      // A printed slip could be found by anyone, so this must not become a
      // lookup for who works where: name only, no email and no org.
      expect(await res.json()).toEqual({ name: 'Dale Rivers' });
    } finally {
      server.close();
    }
  });

  it('404s on an unknown, used, or expired token alike', async () => {
    const { db } = fakeDb({ passwordResetsFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/reset-password/nope`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('POST /reset-password/:token', () => {
  async function complete(base: string, token: string, password: string) {
    return fetch(`${base}/reset-password/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  }

  it('sets the hashed password, burns the token, and issues NO session', async () => {
    const { db, updateSet } = fakeDb({ passwordResetsFindFirst: LIVE_RESET });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await complete(base, 'tok-reset', NEW_PASSWORD);
      expect(res.status).toBe(200);

      const userUpdate = updateSet.mock.calls.find(([t]) => t === schema.users);
      const patch = userUpdate?.[1] as { passwordHash: string };
      expect(patch.passwordHash).not.toContain(NEW_PASSWORD);

      expect(updateSet.mock.calls.find(([t]) => t === schema.passwordResets)?.[1]).toMatchObject({
        usedAt: expect.any(Date),
      });

      // Possession of a printed slip must not become a live session on whatever
      // device scanned it.
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      server.close();
    }
  });

  it('changes nothing when the token loses the single-use race', async () => {
    const { db, updateSet } = fakeDb({ passwordResetsFindFirst: LIVE_RESET, burnResult: [] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await complete(base, 'tok-reset', NEW_PASSWORD);
      expect(res.status).toBe(404);
      // A token that failed to burn must never go on to change a password.
      expect(updateSet.mock.calls.find(([t]) => t === schema.users)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('rejects a short password before touching the token', async () => {
    const { db, updateSet } = fakeDb({ passwordResetsFindFirst: LIVE_RESET });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await complete(base, 'tok-reset', 'short');
      expect(res.status).toBe(400);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s on an unknown token without touching any user', async () => {
    const { db, updateSet } = fakeDb({ passwordResetsFindFirst: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await complete(base, 'nope', NEW_PASSWORD);
      expect(res.status).toBe(404);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
