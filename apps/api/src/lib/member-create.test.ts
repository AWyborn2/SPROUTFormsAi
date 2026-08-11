import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import type { ValidProfileRow } from '@formai/shared';

// landImportRow orchestrates two collaborators whose internals (username
// issuance, placement validation+write) have their own tests; mock them so these
// tests exercise the landing logic — branch selection, the profile upsert, and
// the placement-refusal path — rather than re-modelling those.
vi.mock('./username.js', () => ({
  insertUserWithUsername: vi.fn(async (_db: unknown, u: { name: string; email: string }) => ({ id: 'u-new', email: u.email })),
}));
vi.mock('./membership-placement.js', () => ({
  writePlacement: vi.fn(async () => ({ ok: true as const })),
}));

const { insertUserWithUsername } = await import('./username.js');
const { writePlacement } = await import('./membership-placement.js');
import { landImportRow, previewImportCost, resolveRows, type ResolvedRow } from './member-create.js';

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
/** Landing a row may spend money (R86), so it names the Admin who triggered it. */
const TENANT = { userId: 'u-admin', orgId: ORG, role: 'admin' as const };

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
    middleName: '',
    dateOfBirth: '',
    gender: '',
    ethnicity: '',
    addressStreet: '',
    suburb: '',
    postcode: '',
    mobile: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
    starterType: '',
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
    // The first row does the work; the second is a DUPLICATE — it costs nothing
    // and lands nothing, distinct from a merge so it is never diffed against ids
    // the first occurrence has not produced yet.
    const resolved = await resolveRows(fakeDb({}), ORG, [row(), row({ rowNumber: 3 })]);
    expect(resolved.map((r) => r.disposition)).toEqual(['create', 'duplicate']);
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

  it('quotes BLOCKS for candidate overflow now that expansion exists (R84, R86)', async () => {
    /*
      R86 makes the run proceed only once the Admin confirms, and the preview is
      what that confirmation is given against — so the quote has to match what
      the run will actually do. Before U37 this promised refusals and the run
      delivered them; U37 landed the expansion, so the same overflow is now a
      purchase and  buys it.

      Five seats over buys ONE block of fifty: blocks are indivisible, and it is
      the smallest size sold (KTD27).
    */
    const rows = Array.from({ length: 105 }, (_, i) => row({ email: `c${i}@x.io` }));
    const preview = await previewImportCost(fakeDb({}), ORG_ROW, rows);
    expect(preview.candidate.overflow).toBe(5);
    expect(preview.blocks).toEqual([{ size: 50, count: 1, seats: 50, discount: 0 }]);
    // Nothing is refused for want of a candidate seat any more.
    expect(preview.refusedForSeats).toBe(0);
  });

  it('still counts STAFF overflow as refused, because that pool never expands', async () => {
    // KTD27: R84 and R86 are written entirely in candidate-seat terms, so there
    // is no staff rule to implement and the flag above does not reach it.
    const rows = Array.from({ length: 20 }, (_, i) => row({ email: `a${i}@x.io`, role: 'assessor' }));
    const preview = await previewImportCost(fakeDb({}), ORG_ROW, rows);
    expect(preview.staff.overflow).toBe(5);
    expect(preview.refusedForSeats).toBeGreaterThanOrEqual(5);
  });
});

/**
 * A transaction-capable db double for landImportRow. Models only what the
 * landing touches directly — the seat lock + count select, the membership
 * insert/update, and the member_profiles upsert — plus the reads
 * differencesAgainst makes. writePlacement and insertUserWithUsername are mocked
 * above, so their own reads/writes never reach this double.
 */
function landDb(opts: {
  org?: { id: string; planTier: string; seatLimit: number | null; candidateSeatLimit: number | null };
  activeCount?: number;
  mergeMembership?: { id: string; role: string } | undefined;
} = {}) {
  const org = 'org' in opts ? opts.org : { id: ORG, planTier: 'business', seatLimit: 15, candidateSeatLimit: 100 };
  const inserted: Array<{ table: string; values: unknown; via: 'returning' | 'upsert' }> = [];
  const updated: Array<Record<string, unknown>> = [];

  const reads = {
    memberships: { findFirst: async () => opts.mergeMembership },
    // recordAudit reads the actor's name; an expansion writes an entry (R86).
    users: { findFirst: async () => ({ id: TENANT.userId, name: 'Ada Admin' }) },
    membershipLocations: { findMany: async () => [] as unknown[] },
    membershipDepartments: { findMany: async () => [] as unknown[] },
    membershipRoles: { findMany: async () => [] as unknown[] },
  };

  const surface = {
    query: reads,
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          'count' in cols
            ? Promise.resolve([{ count: opts.activeCount ?? 0 }])
            : { for: async () => (org ? [org] : []) },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updated.push(v);
        },
      }),
    }),
    insert: (table: { _: { name?: string } }) => ({
      values: (v: unknown) => ({
        returning: async () => {
          inserted.push({ table: String(table), values: v, via: 'returning' });
          return [{ id: 'm-new' }];
        },
        onConflictDoUpdate: async () => {
          inserted.push({ table: String(table), values: v, via: 'upsert' });
        },
      }),
    }),
  };

  const db = {
    ...surface,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(surface),
  } as unknown as Db;
  return { db, inserted, updated };
}

const SEED = { firstName: 'Jane', lastName: 'Smith' };
const resolvedRow = (over: Partial<ResolvedRow> = {}): ResolvedRow => ({
  row: row(),
  disposition: 'create',
  userId: null,
  membershipId: null,
  pool: 'candidate',
  ...over,
});

describe('landImportRow', () => {
  beforeEach(() => {
    vi.mocked(writePlacement).mockResolvedValue({ ok: true });
    vi.mocked(insertUserWithUsername).mockResolvedValue({ id: 'u-new', email: 'jane@example.com' } as never);
  });

  it('does nothing for a duplicate row — the first occurrence did the work (R1)', async () => {
    const { db, inserted, updated } = landDb();
    const out = await landImportRow(db, TENANT, resolvedRow({ disposition: 'duplicate' }), SEED);
    expect(out).toEqual({ kind: 'duplicate' });
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(vi.mocked(writePlacement)).not.toHaveBeenCalled();
  });

  it('creates the person, membership and profile on a create row', async () => {
    const { db, inserted } = landDb({ activeCount: 0 });
    const out = await landImportRow(db, TENANT, resolvedRow(), SEED);
    expect(out).toMatchObject({ kind: 'created', userId: 'u-new', membershipId: 'm-new' });
    expect(vi.mocked(insertUserWithUsername)).toHaveBeenCalledOnce();
    // The profile is written through the upsert, never a bare insert.
    expect(inserted.find((i) => i.via === 'upsert')).toBeTruthy();
  });

  it('upserts the profile on a reactivate row, so an existing profile does not fail it (R63)', async () => {
    // Deactivation never deletes the profile, so a returning worker already has
    // one; a bare insert would hit member_profiles_membership_uq. The upsert path
    // is what keeps the reactivation from failing.
    const { db, inserted, updated } = landDb({ activeCount: 0 });
    const out = await landImportRow(
      db,
      TENANT,
      resolvedRow({ disposition: 'reactivate', userId: 'u-1', membershipId: 'm-1' }),
      SEED,
    );
    expect(out).toMatchObject({ kind: 'reactivated', membershipId: 'm-1' });
    expect(updated).toContainEqual({ status: 'active', role: 'candidate' });
    expect(inserted.every((i) => i.via === 'upsert')).toBe(true);
  });

  it('EXPANDS rather than refusing a candidate row at a full pool (U37, R86)', async () => {
    /*
      This used to refuse. The preview quotes blocks for candidate overflow, so
      a run that refused instead would price a file one way and deliver another
      — the exact disagreement AUTOMATIC_EXPANSION_AVAILABLE exists to prevent.
    */
    const { db, updated } = landDb({
      org: { id: ORG, planTier: 'business', seatLimit: 15, candidateSeatLimit: 1 },
      activeCount: 1,
    });
    const out = await landImportRow(db, TENANT, resolvedRow(), SEED);

    expect(out.kind).toBe('created');
    // The block was bought: the limit moved from 1 to 51, inside the same
    // transaction that held the lock the count was taken beneath.
    expect(updated.some((u) => u.candidateSeatLimit === 51)).toBe(true);
  });

  it('still refuses a STAFF row at a full pool, writing nothing (R170)', async () => {
    // KTD27: no rule has been written for expanding the staff pool, so it keeps
    // refusing rather than charging against a rule nobody wrote.
    const { db } = landDb({
      org: { id: ORG, planTier: 'business', seatLimit: 1, candidateSeatLimit: 100 },
      activeCount: 1,
    });
    const out = await landImportRow(db, TENANT, resolvedRow({ row: row({ role: 'assessor' }), pool: 'staff' }), SEED);
    expect(out).toEqual({ kind: 'refused', reason: 'seat_limit_reached', pool: 'staff' });
  });

  it('refuses a row whose placement no longer validates, rather than landing it unplaced (R119)', async () => {
    // The taxonomy retired a Role between the preview and the run: writePlacement
    // returns a refusal, and landImportRow must surface it, not commit a member
    // with no placement.
    vi.mocked(writePlacement).mockResolvedValue({ ok: false, error: { code: 'role_not_offered', subjectId: 'jr-9' } });
    const { db } = landDb({ activeCount: 0 });
    const out = await landImportRow(db, TENANT, resolvedRow(), SEED);
    expect(out).toEqual({ kind: 'refused', reason: 'placement_invalid', code: 'role_not_offered', subjectId: 'jr-9' });
  });

  it('reports differences on a merge row without writing (R19)', async () => {
    const { db, inserted, updated } = landDb({ mergeMembership: { id: 'm-1', role: 'assessor' } });
    const out = await landImportRow(
      db,
      TENANT,
      resolvedRow({ disposition: 'merge', userId: 'u-1', membershipId: 'm-1', pool: null }),
      SEED,
    );
    expect(out.kind).toBe('merged');
    if (out.kind === 'merged') {
      expect(out.differences).toContainEqual({ field: 'accessLevel', existing: 'assessor', fromFile: 'candidate' });
    }
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });
});
