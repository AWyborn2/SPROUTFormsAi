import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

const ownerTenant = { userId: 'u1', orgId: 'org-1', role: 'owner' as const };
const viewerTenant = { userId: 'u1', orgId: 'org-1', role: 'viewer' as const };
let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const mockGetStorageClient = vi.fn();
vi.mock('../storage/index.js', () => ({
  getStorageClient: () => mockGetStorageClient() ?? null,
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

/**
 * `membershipsFindManyResults` feeds successive `memberships.findMany` calls in
 * order, whether issued on the root client or inside a transaction.
 * `usersFindManyResults` does the same for `users.findMany` (the placeholder
 * lookup) and defaults to "no placeholders". `failDeleteOf` makes the delete
 * of that table reject, simulating a mid-cascade DB failure. The transaction
 * mock runs the callback against a separate `tx` surface and records a
 * rollback (then rethrows) when the callback fails — mirroring drizzle's
 * `db.transaction()` semantics.
 */
function fakeDb(opts: {
  membershipsFindManyResults: unknown[][];
  usersFindManyResults?: unknown[][];
  usersFindFirst?: unknown;
  failDeleteOf?: unknown;
}) {
  const deleteWhere = vi.fn();
  const insertValues = vi.fn();
  const membershipsFindMany = vi.fn();
  for (const rows of opts.membershipsFindManyResults) membershipsFindMany.mockResolvedValueOnce(rows);
  const usersFindMany = vi.fn().mockResolvedValue([]);
  for (const rows of opts.usersFindManyResults ?? []) usersFindMany.mockResolvedValueOnce(rows);

  const query = {
    memberships: { findMany: membershipsFindMany },
    users: { findFirst: vi.fn().mockResolvedValue(opts.usersFindFirst), findMany: usersFindMany },
  };

  const makeSurface = () => ({
    query,
    delete: vi.fn((table: unknown) => ({
      where: (w: unknown) => {
        deleteWhere(table, w);
        if (opts.failDeleteOf && table === opts.failDeleteOf) {
          return Promise.reject(new Error('injected mid-cascade failure'));
        }
        return Promise.resolve(undefined);
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        return Promise.resolve(undefined);
      },
    })),
  });

  const root = makeSurface();
  const tx = makeSurface();
  const rolledBack = vi.fn();
  const transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
    try {
      return await fn(tx);
    } catch (err) {
      rolledBack();
      throw err;
    }
  });
  const db = { ...root, transaction } as unknown as Db;

  return {
    db,
    deleteWhere,
    insertValues,
    membershipsFindMany,
    usersFindMany,
    transaction,
    rolledBack,
    rootDelete: root.delete,
    txDelete: tx.delete,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
  mockGetStorageClient.mockReset();
});

describe('DELETE /account', () => {
  it('503s when the DB client is unavailable', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/account`, { method: 'DELETE', headers: authHeader(ownerTenant) });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('blocks the last owner of a surviving org from deleting their account', async () => {
    mockDbValue = fakeDb({
      membershipsFindManyResults: [
        [
          { id: 'm1', userId: 'u1', orgId: 'org-1', role: 'owner' },
          { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'viewer' },
        ],
      ],
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/account`, { method: 'DELETE', headers: authHeader(ownerTenant) });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('cannot_delete_last_owner');
    } finally {
      server.close();
    }
  });

  it('deletes the whole organization, inside a transaction, when the caller is its only member', async () => {
    const { db, deleteWhere, transaction, rootDelete } = fakeDb({
      membershipsFindManyResults: [[{ id: 'm1', userId: 'u1', orgId: 'org-1', role: 'owner' }], []],
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/account`, { method: 'DELETE', headers: authHeader(ownerTenant) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { orgDeleted: boolean };
      expect(body.orgDeleted).toBe(true);

      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('fai_session=;');

      const deletedTables = deleteWhere.mock.calls.map(([table]) => table);
      expect(deletedTables).toEqual([
        schema.submissions,
        schema.competencyRules,
        schema.competencies,
        schema.formTemplates,
        schema.auditLogEntries,
        schema.rolePermissions,
        schema.memberships,
        schema.organizations,
        schema.users,
      ]);

      // Every mutation ran on the transaction surface, none on the root client.
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(rootDelete).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('rolls back the whole cascade (and skips storage cleanup) when a mid-cascade delete fails', async () => {
    const deletePrefix = vi.fn().mockResolvedValue(undefined);
    mockGetStorageClient.mockReturnValue({ deletePrefix });

    const { db, transaction, rolledBack, rootDelete } = fakeDb({
      membershipsFindManyResults: [[{ id: 'm1', userId: 'u1', orgId: 'org-1', role: 'owner' }], []],
      failDeleteOf: schema.organizations,
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/account`, { method: 'DELETE', headers: authHeader(ownerTenant) });
      expect(res.status).toBe(500);

      // The cascade ran inside db.transaction() and the failure rolled it back —
      // nothing was deleted outside a transaction boundary.
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(rolledBack).toHaveBeenCalledTimes(1);
      expect(rootDelete).not.toHaveBeenCalled();

      // A failed deletion must not trigger storage cleanup.
      expect(deletePrefix).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('invokes storage deletePrefix with the org id after the org is deleted', async () => {
    const deletePrefix = vi.fn().mockResolvedValue(undefined);
    mockGetStorageClient.mockReturnValue({ deletePrefix });

    const { db } = fakeDb({
      membershipsFindManyResults: [[{ id: 'm1', userId: 'u1', orgId: 'org-1', role: 'owner' }], []],
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/account`, { method: 'DELETE', headers: authHeader(ownerTenant) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { orgDeleted: boolean };
      expect(body.orgDeleted).toBe(true);
      expect(deletePrefix).toHaveBeenCalledWith('org-1');
    } finally {
      server.close();
    }
  });

  it('still returns 200 {orgDeleted:true} when storage cleanup fails (deletion is committed)', async () => {
    const deletePrefix = vi.fn().mockRejectedValue(new Error('storage_delete_prefix_failed: bucket gone'));
    mockGetStorageClient.mockReturnValue({ deletePrefix });

    const { db } = fakeDb({
      membershipsFindManyResults: [[{ id: 'm1', userId: 'u1', orgId: 'org-1', role: 'owner' }], []],
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/account`, { method: 'DELETE', headers: authHeader(ownerTenant) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { orgDeleted: boolean };
      expect(body.orgDeleted).toBe(true);
      expect(deletePrefix).toHaveBeenCalledWith('org-1');
    } finally {
      server.close();
    }
  });

  // The two tests that stood here classified invite placeholders among the
  // org's members — whether one kept the org alive, whether its user row went
  // with the org. Invites are no longer `users` rows plus memberships, so
  // there is nothing to classify: a pending invite cannot appear in this
  // route's membership query at all, and the org's invites go with it via
  // `invites.orgId`'s cascade. The invariant survived; the code enforcing it
  // did not need to.

  it('leaves a surviving org and records an audit entry when a non-owner deletes their account', async () => {
    const deletePrefix = vi.fn().mockResolvedValue(undefined);
    mockGetStorageClient.mockReturnValue({ deletePrefix });

    const { db, deleteWhere, insertValues } = fakeDb({
      membershipsFindManyResults: [
        [
          { id: 'm1', userId: 'u1', orgId: 'org-1', role: 'viewer' },
          { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'owner' },
        ],
        // Caller still belongs to another org elsewhere — their user row survives.
        [{ id: 'm3', userId: 'u1', orgId: 'org-2', role: 'viewer' }],
      ],
      usersFindFirst: { id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/account`, { method: 'DELETE', headers: authHeader(viewerTenant) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { orgDeleted: boolean };
      expect(body.orgDeleted).toBe(false);

      const membershipDelete = deleteWhere.mock.calls.find(([table]) => table === schema.memberships);
      expect(membershipDelete).toBeDefined();
      expect(deleteWhere.mock.calls.some(([table]) => table === schema.organizations)).toBe(false);
      expect(deleteWhere.mock.calls.some(([table]) => table === schema.users)).toBe(false);

      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({ action: 'Deleted account', target: 'Left organization' });

      // The org survives, so its stored assets are untouched.
      expect(deletePrefix).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('allows an owner to leave a surviving org when another owner remains', async () => {
    const { db, deleteWhere } = fakeDb({
      membershipsFindManyResults: [
        [
          { id: 'm1', userId: 'u1', orgId: 'org-1', role: 'owner' },
          { id: 'm2', userId: 'u2', orgId: 'org-1', role: 'owner' },
        ],
        [],
      ],
      usersFindFirst: { id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' },
    });
    mockDbValue = db;

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/account`, { method: 'DELETE', headers: authHeader(ownerTenant) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { orgDeleted: boolean };
      expect(body.orgDeleted).toBe(false);

      // No memberships left anywhere for this user -> their global user row is deleted too.
      expect(deleteWhere.mock.calls.some(([table]) => table === schema.users)).toBe(true);
      expect(deleteWhere.mock.calls.some(([table]) => table === schema.organizations)).toBe(false);
    } finally {
      server.close();
    }
  });
});
