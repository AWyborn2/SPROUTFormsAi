import { describe, expect, it } from 'vitest';
import type { Db } from '@formai/db';
import type { ValidProfileRow } from '@formai/shared';
import { previewImportCost, resolveRows } from './member-create.js';

/**
 * A db double over the reads the resolver and the preview make. The API suite
 * has no live database, so each lib test shapes its own fixture.
 *
 * `resolveRows` narrows by the addresses it was given and `previewImportCost`
 * counts active memberships, so the double models both rather than returning
 * every row regardless — a fixture that ignored the predicate would let a
 * "costs one seat" assertion pass against a query that counted the whole org.
 */
function fakeDb(opts: {
  users?: Array<{ id: string; email: string }>;
  memberships?: Array<{ id: string; userId: string; orgId: string; role: string; status: string }>;
  seatLimit?: number | null;
  candidateSeatLimit?: number | null;
}) {
  const users = opts.users ?? [];
  const memberships = opts.memberships ?? [];
  const counted: Array<'candidate' | 'staff'> = [];

  const db = {
    query: {
      users: { findMany: async () => users },
      memberships: { findMany: async () => memberships.filter((m) => m.orgId === ORG) },
    },
    select: () => ({
      from: () => ({
        where: async (...args: unknown[]) => {
          /*
            `checkSeatAvailability` counts active memberships in one pool. The
            double cannot read drizzle's predicate, so it counts both pools and
            the caller's order decides which — candidate first, then staff,
            matching how the preview asks.
          */
          const pool = counted.length === 0 ? 'candidate' : 'staff';
          counted.push(pool);
          void args;
          const n = memberships.filter(
            (m) =>
              m.orgId === ORG &&
              m.status === 'active' &&
              (pool === 'candidate' ? m.role === 'candidate' : m.role !== 'candidate'),
          ).length;
          return [{ count: n }];
        },
      }),
    }),
  } as unknown as Db;
  return db;
}

const ORG = 'org-1';

const ORG_ROW = { id: ORG, planTier: 'business', seatLimit: 15, candidateSeatLimit: 100 };

/** A validated row, defaulting to a brand-new Candidate. */
function row(over: Partial<ValidProfileRow> = {}): ValidProfileRow {
  return {
    rowNumber: 2,
    name: 'Jane Smith',
    email: 'jane@example.com',
    role: 'candidate',
    locationIds: ['loc-1'],
    departmentIds: ['dept-1'],
    roleIds: ['jr-1'],
    employeeNumber: '',
    swipeCardNumber: '',
    ...over,
  };
}

describe('resolveRows — the three branches', () => {
  it('creates everything for an address naming nobody', async () => {
    const resolved = await resolveRows(fakeDb({}), ORG, [row()]);
    expect(resolved[0]).toMatchObject({ disposition: 'create', userId: null, membershipId: null, pool: 'candidate' });
  });

  it('adds a membership for a person who holds none here', async () => {
    // R91/R19: no second profile for an address already known — they gain a
    // membership of THIS organisation.
    const resolved = await resolveRows(
      fakeDb({ users: [{ id: 'u-1', email: 'jane@example.com' }] }),
      ORG,
      [row()],
    );
    expect(resolved[0]).toMatchObject({ disposition: 'add_membership', userId: 'u-1', pool: 'candidate' });
  });

  it('reactivates a deactivated membership rather than leaving them inactive', async () => {
    // AE58 / R19: a row asserting somebody is part of the workforce being
    // imported is an assertion that they are back. Costs a seat like any other
    // reactivation (R78).
    const resolved = await resolveRows(
      fakeDb({
        users: [{ id: 'u-1', email: 'jane@example.com' }],
        memberships: [{ id: 'm-1', userId: 'u-1', orgId: ORG, role: 'candidate', status: 'suspended' }],
      }),
      ORG,
      [row()],
    );
    expect(resolved[0]).toMatchObject({ disposition: 'reactivate', membershipId: 'm-1', pool: 'candidate' });
  });

  it('merges onto an already-active membership and costs nothing', async () => {
    const resolved = await resolveRows(
      fakeDb({
        users: [{ id: 'u-1', email: 'jane@example.com' }],
        memberships: [{ id: 'm-1', userId: 'u-1', orgId: ORG, role: 'admin', status: 'active' }],
      }),
      ORG,
      [row()],
    );
    expect(resolved[0]).toMatchObject({ disposition: 'merge', membershipId: 'm-1', pool: null });
  });

  it('matches an address case-insensitively', async () => {
    const resolved = await resolveRows(
      fakeDb({ users: [{ id: 'u-1', email: 'jane@example.com' }] }),
      ORG,
      [row({ email: 'Jane@Example.COM' })],
    );
    expect(resolved[0]!.disposition).toBe('add_membership');
  });

  it('counts the same address twice in one file as one seat, not two', async () => {
    // After the first row lands there IS an active membership, so the second is
    // a merge. Counting it again would over-state the bill.
    const resolved = await resolveRows(fakeDb({}), ORG, [row(), row({ rowNumber: 3 })]);
    expect(resolved.map((r) => r.disposition)).toEqual(['create', 'merge']);
    expect(resolved.filter((r) => r.pool !== null)).toHaveLength(1);
  });

  it('draws a Candidate row from the candidate pool and any other from the staff pool', async () => {
    const resolved = await resolveRows(fakeDb({}), ORG, [
      row({ email: 'a@x.io', role: 'candidate' }),
      row({ email: 'b@x.io', role: 'assessor' }),
      row({ email: 'c@x.io', role: 'admin' }),
    ]);
    expect(resolved.map((r) => r.pool)).toEqual(['candidate', 'staff', 'staff']);
  });

  it('ignores a membership of a DIFFERENT organisation', async () => {
    // R1: one membership per person per organisation, and neither reaches the
    // other's. A person active elsewhere is new here.
    const resolved = await resolveRows(
      fakeDb({
        users: [{ id: 'u-1', email: 'jane@example.com' }],
        memberships: [{ id: 'm-9', userId: 'u-1', orgId: 'org-2', role: 'admin', status: 'active' }],
      }),
      ORG,
      [row()],
    );
    expect(resolved[0]!.disposition).toBe('add_membership');
  });
});

describe('previewImportCost — seats, not rows', () => {
  it('reports the two pools separately for a mixed file', async () => {
    // R19 lets every row name its own level, so one figure would cover only
    // part of what the file spends.
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row({ email: `c${i}@x.io`, role: 'candidate' })),
      ...Array.from({ length: 2 }, (_, i) => row({ email: `a${i}@x.io`, role: 'assessor' })),
    ];
    const preview = await previewImportCost(fakeDb({}), ORG_ROW, rows);
    expect(preview.candidate.needed).toBe(3);
    expect(preview.staff.needed).toBe(2);
  });

  it('works the contract’s four-hundred-row example', async () => {
    // AE53: 360 Candidate rows and 40 Assessor rows against an included
    // candidate allocation of 100 — 260 over, not 300, and the 40 staff rows
    // draw on their own pool.
    const rows = [
      ...Array.from({ length: 360 }, (_, i) => row({ email: `c${i}@x.io`, role: 'candidate' })),
      ...Array.from({ length: 40 }, (_, i) => row({ email: `a${i}@x.io`, role: 'assessor' })),
    ];
    const preview = await previewImportCost(fakeDb({}), ORG_ROW, rows);
    expect(preview.candidate).toMatchObject({ needed: 360, covered: 100, overflow: 260 });
    expect(preview.staff.needed).toBe(40);
  });

  it('previews zero on both pools for a file whose rows all match active memberships', async () => {
    // The file R86 exists for: a customer whose assessors already hold logins.
    // A count of ROWS would over-state this bill by the whole file.
    const rows = [row({ email: 'a@x.io' }), row({ email: 'b@x.io' })];
    const preview = await previewImportCost(
      fakeDb({
        users: [
          { id: 'u-a', email: 'a@x.io' },
          { id: 'u-b', email: 'b@x.io' },
        ],
        memberships: [
          { id: 'm-a', userId: 'u-a', orgId: ORG, role: 'candidate', status: 'active' },
          { id: 'm-b', userId: 'u-b', orgId: ORG, role: 'candidate', status: 'active' },
        ],
      }),
      ORG_ROW,
      rows,
    );
    expect(preview.candidate.needed).toBe(0);
    expect(preview.staff.needed).toBe(0);
  });

  it('previews one seat for a row matching a deactivated membership', async () => {
    const preview = await previewImportCost(
      fakeDb({
        users: [{ id: 'u-1', email: 'jane@example.com' }],
        memberships: [{ id: 'm-1', userId: 'u-1', orgId: ORG, role: 'candidate', status: 'suspended' }],
      }),
      ORG_ROW,
      [row()],
    );
    expect(preview.candidate.needed).toBe(1);
  });

  it('counts an address repeated in one file once', async () => {
    const preview = await previewImportCost(fakeDb({}), ORG_ROW, [row(), row({ rowNumber: 3 })]);
    expect(preview.candidate.needed).toBe(1);
  });

  it('subtracts seats the organisation has already taken', async () => {
    const preview = await previewImportCost(
      fakeDb({
        memberships: Array.from({ length: 98 }, (_, i) => ({
          id: `m-${i}`,
          userId: `u-${i}`,
          orgId: ORG,
          role: 'candidate',
          status: 'active',
        })),
      }),
      ORG_ROW,
      Array.from({ length: 5 }, (_, i) => row({ email: `n${i}@x.io` })),
    );
    // 100 allocated, 98 taken → 2 free, 5 needed, 3 over.
    expect(preview.candidate).toMatchObject({ needed: 5, available: 2, covered: 2, overflow: 3 });
  });

  it('treats an unlimited pool as covering everything and overflowing nothing', async () => {
    const preview = await previewImportCost(
      fakeDb({}),
      { ...ORG_ROW, planTier: 'enterprise', candidateSeatLimit: null },
      [row()],
    );
    expect(preview.candidate.available).toBeNull();
    expect(preview.candidate.overflow).toBe(0);
  });

  it('promises refusals rather than blocks while automatic expansion does not exist', async () => {
    /*
      R86 makes the run proceed only once the Admin confirms, and the preview is
      what that confirmation is given against. Quoting blocks the run cannot buy
      would have them authorise a purchase and receive rejections instead. U37
      flips this and the same preview then quotes blocks.
    */
    const rows = Array.from({ length: 105 }, (_, i) => row({ email: `c${i}@x.io` }));
    const preview = await previewImportCost(fakeDb({}), ORG_ROW, rows);
    expect(preview.candidate.overflow).toBe(5);
    expect(preview.blocks).toEqual([]);
    expect(preview.refusedForSeats).toBe(5);
  });

  it('always counts staff overflow as refused, because the staff pool never expands', async () => {
    // KTD27: R86 and R84 are written entirely in candidate-seat terms.
    const rows = Array.from({ length: 20 }, (_, i) => row({ email: `a${i}@x.io`, role: 'assessor' }));
    const preview = await previewImportCost(fakeDb({}), ORG_ROW, rows);
    expect(preview.staff.overflow).toBe(5);
    expect(preview.refusedForSeats).toBeGreaterThanOrEqual(5);
  });
});
