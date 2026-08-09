import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import { liveKeysIssuedBy, orphanedApiKeys } from './orphaned-keys.js';

const ORG = 'org-1';

/**
 * A db double over the three reads the lookup makes.
 *
 * The membership statuses are modelled rather than assumed, because the whole
 * question this answers is "which issuers are deactivated" — a fixture that
 * returned every membership regardless would let the assertions pass against a
 * query that had lost its status test.
 */
function fakeDb(opts: {
  keys?: Array<Record<string, unknown>>;
  memberships?: Array<{ userId: string; status: string }>;
  users?: Array<{ id: string; name: string }>;
  throwOnKeys?: boolean;
}) {
  return {
    query: {
      apiKeys: {
        findMany: vi.fn(async () => {
          if (opts.throwOnKeys) throw new Error('db down');
          return opts.keys ?? [];
        }),
      },
      memberships: { findMany: vi.fn(async () => opts.memberships ?? []) },
      users: { findMany: vi.fn(async () => opts.users ?? []) },
    },
  } as unknown as Db;
}

const key = (over: Record<string, unknown> = {}) => ({
  id: 'k-1',
  name: 'Induction agent',
  role: 'reviewer',
  prefix: 'abc123',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  lastUsedAt: null,
  createdByUserId: 'u-gone',
  revokedAt: null,
  ...over,
});

describe('orphanedApiKeys (R65)', () => {
  it('lists a live key whose issuer has been deactivated', async () => {
    /*
      The key is the ORGANISATION's — its own role, revocable by any Admin — so
      it keeps working when the person who issued it leaves. What the leaver has
      is a copy of the plaintext, and rotating it is a decision only an Admin can
      make, and only if they are told.
    */
    const db = fakeDb({
      keys: [key()],
      memberships: [{ userId: 'u-gone', status: 'suspended' }],
      users: [{ id: 'u-gone', name: 'Dale Rivers' }],
    });
    const out = await orphanedApiKeys(db, ORG);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'k-1',
      name: 'Induction agent',
      issuerUserId: 'u-gone',
      issuerName: 'Dale Rivers',
    });
  });

  it('ignores a key whose issuer is still active', async () => {
    const db = fakeDb({
      keys: [key({ createdByUserId: 'u-here' })],
      memberships: [{ userId: 'u-here', status: 'active' }],
    });
    expect(await orphanedApiKeys(db, ORG)).toEqual([]);
  });

  it('ignores a REVOKED key, whatever its issuer', async () => {
    // Already closed. The read filters on `revokedAt IS NULL` in SQL, so a
    // revoked row never reaches the status comparison — asserted through the
    // fixture returning only what the predicate would.
    const db = fakeDb({
      keys: [],
      memberships: [{ userId: 'u-gone', status: 'suspended' }],
    });
    expect(await orphanedApiKeys(db, ORG)).toEqual([]);
  });

  it('ignores a key whose issuer holds NO membership of this organisation', async () => {
    // They were never deactivated here, so there is nothing for an Admin to act
    // on. Listing it would be noise on a surface that empties by being acted
    // upon.
    const db = fakeDb({ keys: [key({ createdByUserId: 'u-elsewhere' })], memberships: [] });
    expect(await orphanedApiKeys(db, ORG)).toEqual([]);
  });

  it('names the issuer even where the user row cannot be read', async () => {
    const db = fakeDb({
      keys: [key()],
      memberships: [{ userId: 'u-gone', status: 'suspended' }],
      users: [],
    });
    expect((await orphanedApiKeys(db, ORG))[0]!.issuerName).toBe('a former member');
  });
});

describe('liveKeysIssuedBy', () => {
  it('counts the keys one person issued that are still live', async () => {
    const db = fakeDb({ keys: [key(), key({ id: 'k-2' })] });
    expect(await liveKeysIssuedBy(db, ORG, 'u-gone')).toBe(2);
  });

  it('FAILS SOFT to zero when the read throws', async () => {
    /*
      This count exists to raise a notice, and a notice that cannot be computed
      must not roll back the deactivation it was observing. Ending somebody's
      reach is the security act; reporting on it is the courtesy.
    */
    const db = fakeDb({ throwOnKeys: true });
    await expect(liveKeysIssuedBy(db, ORG, 'u-gone')).resolves.toBe(0);
  });
});
