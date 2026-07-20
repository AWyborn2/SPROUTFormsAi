import { describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';
import { recordAudit } from './record.js';

function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

function fakeDb(opts: { user?: { id: string; name: string } }) {
  const insertValues = vi.fn();
  const db = {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue(opts.user),
      },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        return insertResult([]);
      },
    })),
  } as unknown as Db;
  return { db, insertValues };
}

const tenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };

describe('recordAudit', () => {
  it('inserts a row with actorId/actorName resolved from the tenant context', async () => {
    const { db, insertValues } = fakeDb({ user: { id: 'u1', name: 'Ash Wyborn' } });

    await recordAudit(db, tenant, { action: 'Invited member', target: 'tom@x.io', category: 'team' });

    expect(insertValues).toHaveBeenCalledWith(
      schema.auditLogEntries,
      expect.objectContaining({
        orgId: 'org-1',
        actorId: 'u1',
        actorName: 'Ash Wyborn',
        action: 'Invited member',
        target: 'tom@x.io',
        category: 'team',
        icon: 'activity',
      }),
    );
  });

  it('falls back to "System" when the actor user row is missing', async () => {
    const { db, insertValues } = fakeDb({ user: undefined });

    await recordAudit(db, tenant, { action: 'Removed member', category: 'team', icon: 'user-minus' });

    const call = insertValues.mock.calls[0];
    expect(call?.[1]).toMatchObject({ actorName: 'System', icon: 'user-minus', target: '' });
  });
});
