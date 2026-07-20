import { describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';
import { provisionTenant } from './tenant-provisioning.js';

class UniqueViolation extends Error {
  code = '23505';
}

function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

function insertRejects(err: unknown) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockRejectedValue(err);
  return awaitable;
}

function mockDb(opts: {
  existingUser?: { id: string; name: string; email: string };
  existingMemberships?: { orgId: string; role: string }[];
  newUserId?: string;
  newOrgId?: string;
  userInsertConflict?: boolean;
  orgInsertConflict?: boolean;
  racedUser?: { id: string; name: string; email: string };
}) {
  const insertValues = vi.fn();
  const insert = vi.fn((table: unknown) => ({
    values: (v: unknown) => {
      insertValues(table, v);
      if (table === schema.users) {
        if (opts.userInsertConflict) return insertRejects(new UniqueViolation('duplicate'));
        return insertResult([{ id: opts.newUserId ?? 'u-new', ...(v as object) }]);
      }
      if (table === schema.organizations) {
        if (opts.orgInsertConflict) return insertRejects(new UniqueViolation('duplicate'));
        return insertResult([{ id: opts.newOrgId ?? 'o-new', ...(v as object) }]);
      }
      return insertResult([]);
    },
  }));

  const userFindFirst = vi.fn().mockResolvedValue(opts.existingUser);
  if (opts.racedUser) {
    userFindFirst.mockResolvedValueOnce(undefined).mockResolvedValue(opts.racedUser);
  }

  const db = {
    query: {
      users: { findFirst: userFindFirst },
      memberships: {
        findFirst: vi.fn().mockResolvedValue(opts.existingMemberships?.[0]),
        findMany: vi.fn().mockResolvedValue(opts.existingMemberships ?? []),
      },
      organizations: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
    insert,
  } as unknown as Db;

  return { db, insert, insertValues };
}

const profile = {
  email: 'ash@example.com',
  name: 'Ash Wyborn',
};

describe('provisionTenant', () => {
  it('creates a new user, org (role owner), membership, and seeded role_permissions on first sign-in', async () => {
    const { db, insert, insertValues } = mockDb({ newUserId: 'u1', newOrgId: 'o1' });

    const tenant = await provisionTenant(db, profile);

    expect(tenant).toEqual({ userId: 'u1', orgId: 'o1', role: 'owner' });
    expect(insert).toHaveBeenCalledWith(schema.users);
    expect(insert).toHaveBeenCalledWith(schema.organizations);
    expect(insert).toHaveBeenCalledWith(schema.memberships);
    expect(insert).toHaveBeenCalledWith(schema.rolePermissions);

    const membershipCall = insertValues.mock.calls.find(([table]) => table === schema.memberships);
    expect(membershipCall?.[1]).toMatchObject({ userId: 'u1', orgId: 'o1', role: 'owner' });

    const permsCall = insertValues.mock.calls.find(([table]) => table === schema.rolePermissions);
    expect(permsCall?.[1]).toHaveLength(5);
  });

  it('reuses the sole existing membership without creating a new org for a returning user', async () => {
    const { db, insert } = mockDb({
      existingUser: { id: 'u1', name: profile.name, email: profile.email },
      existingMemberships: [{ orgId: 'o1', role: 'admin' }],
    });

    const tenant = await provisionTenant(db, profile);

    expect(tenant).toEqual({ userId: 'u1', orgId: 'o1', role: 'admin' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('creates an org for an existing user with no membership yet, without re-creating the user', async () => {
    const { db, insert } = mockDb({
      existingUser: { id: 'u1', name: profile.name, email: profile.email },
      newOrgId: 'o2',
    });

    const tenant = await provisionTenant(db, profile);

    expect(tenant).toEqual({ userId: 'u1', orgId: 'o2', role: 'owner' });
    expect(insert).not.toHaveBeenCalledWith(schema.users);
    expect(insert).toHaveBeenCalledWith(schema.organizations);
  });

  it('recovers from a concurrent user-insert race by reusing the winning row', async () => {
    const racedUser = {
      id: 'u-winner',
      name: profile.name,
      email: profile.email,
    };
    const { db } = mockDb({ userInsertConflict: true, racedUser, newOrgId: 'o1' });

    const tenant = await provisionTenant(db, profile);

    expect(tenant).toEqual({ userId: 'u-winner', orgId: 'o1', role: 'owner' });
  });
});
