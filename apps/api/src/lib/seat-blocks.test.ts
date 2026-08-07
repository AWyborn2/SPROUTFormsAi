import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN_CONFIG, schema, type Db } from '@formai/db';
import {
  AUTOMATIC_EXPANSION_BLOCK,
  PER_SEAT_LIST_PRICE,
  SEAT_BLOCK_DISCOUNTS,
  SEAT_BLOCK_SIZES,
} from '@formai/shared';
import { expandCandidateSeats, recordExpansion, seatOrExpand } from './seat-blocks.js';
import type { SeatCheck, SeatOrg } from './seats.js';

const ORG = 'org-1';
const TENANT = { userId: 'u-admin', orgId: ORG, role: 'admin' as const };

/** Records every UPDATE and INSERT, so "wrote nothing" is assertable. */
function fakeDb() {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const db = {
    query: { users: { findFirst: vi.fn().mockResolvedValue({ id: 'u-admin', name: 'Ada' }) } },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { where: async () => undefined };
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
      },
    }),
  };
  return { db: db as unknown as Db, updates, inserts };
}

const org = (over: Partial<SeatOrg> = {}): SeatOrg => ({
  id: ORG,
  planTier: 'business',
  seatLimit: 15,
  candidateSeatLimit: 100,
  ...over,
});

const check = (over: Partial<SeatCheck> = {}): SeatCheck => ({
  ok: false,
  limit: 100,
  used: 100,
  pool: 'candidate',
  ...over,
});

describe('expandCandidateSeats', () => {
  it('adds ONE block of fifty for an overflow of one (R84, R86)', async () => {
    // Blocks are indivisible: one seat short still buys a whole block, and it
    // buys the SMALLEST one sold — the least the organisation is committed to
    // by a charge it did not ask for.
    const { db, updates } = fakeDb();
    const out = await expandCandidateSeats(db, org(), 1);

    expect(out).toMatchObject({
      pool: 'candidate',
      blockSize: 50,
      blocksAdded: 1,
      seatsAdded: 50,
      previousLimit: 100,
      newLimit: 150,
    });
    expect(updates).toEqual([
      { table: schema.organizations, values: { candidateSeatLimit: 150 } },
    ]);
  });

  it('resolves a NULL limit through the tier before adding, not onto zero (R86)', async () => {
    /*
      The failure this prevents: `candidate_seat_limit` is nullable and a null
      INHERITS from the tier rather than meaning unlimited. Writing a bare block
      size onto it would take a Business organisation from two hundred seats to
      fifty — a refusal for every candidate past the fiftieth, caused by the very
      write that was supposed to add room.
    */
    expect(PLAN_CONFIG.business.candidateSeatLimit).toBe(200);
    const { db, updates } = fakeDb();
    const out = await expandCandidateSeats(db, org({ candidateSeatLimit: null }), 1);

    expect(out).toMatchObject({ previousLimit: 200, newLimit: 250 });
    expect(updates[0]!.values).toEqual({ candidateSeatLimit: 250 });
  });

  it('buys enough blocks to cover the whole overshoot, not just one', async () => {
    // An organisation whose limit was lowered beneath its count needs covering
    // to the far side; one block that leaves it still over is not an expansion.
    const { db } = fakeDb();
    const out = await expandCandidateSeats(db, org({ candidateSeatLimit: 100 }), 60);
    expect(out).toMatchObject({ blocksAdded: 2, seatsAdded: 100, newLimit: 200 });
  });

  it('does NOT expand a tier allocated no candidate seats (R83)', async () => {
    // That plan does not enrol candidates at all. Expanding it would sell a
    // feature the plan does not include, on an action that should simply not
    // happen — which is why this returns null rather than a block of fifty.
    expect(PLAN_CONFIG.individual.candidateSeatLimit).toBe(0);
    const { db, updates } = fakeDb();
    const out = await expandCandidateSeats(db, org({ planTier: 'individual', candidateSeatLimit: null }), 1);

    expect(out).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('does not expand an unlimited pool — there is no boundary to cross', async () => {
    expect(PLAN_CONFIG.enterprise.candidateSeatLimit).toBeNull();
    const { db, updates } = fakeDb();
    const out = await expandCandidateSeats(db, org({ planTier: 'enterprise', candidateSeatLimit: null }), 1);
    expect(out).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('expands an EXPLICIT finite allocation on the unlimited tier (R82)', async () => {
    /*
      R82's Enterprise arm cannot fire on the shipped configuration, which
      resolves Enterprise to unlimited — the contract states 500 and the code
      says null, a divergence parked with the billing work and deliberately NOT
      reconciled here. The mechanism is proved against an explicit per-org limit
      instead, which the column already supports.
    */
    const { db, updates } = fakeDb();
    const out = await expandCandidateSeats(db, org({ planTier: 'enterprise', candidateSeatLimit: 500 }), 1);
    expect(out).toMatchObject({ previousLimit: 500, newLimit: 550 });
    expect(updates).toHaveLength(1);
  });
});

describe('seatOrExpand', () => {
  it('writes nothing when the seat already fits', async () => {
    const { db, updates } = fakeDb();
    const out = await seatOrExpand(db, org(), check({ ok: true, used: 3 }));
    expect(out.expansion).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('REFUSES rather than expanding a full staff pool (R80)', async () => {
    /*
      R84 and R86 are written entirely in candidate-seat terms, and the
      staff-side rules sit in the parked billing cluster. There is no staff rule
      to implement, so inventing one would be charging an organisation against a
      rule nobody has written. The caller refuses when the check failed and no
      expansion came back.
    */
    const { db, updates } = fakeDb();
    const out = await seatOrExpand(db, org(), check({ pool: 'staff', limit: 15, used: 15 }));

    expect(out.expansion).toBeNull();
    expect(out.check.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('expands a full candidate pool', async () => {
    const { db, updates } = fakeDb();
    const out = await seatOrExpand(db, org(), check());
    expect(out.expansion).toMatchObject({ seatsAdded: 50, newLimit: 150 });
    expect(updates).toHaveLength(1);
  });
});

describe('recordExpansion (R86)', () => {
  it('names the pool, the block, the resulting limit, the trigger and the actor', async () => {
    /*
      Without this the only trace is a moved integer on the organisation row,
      which is indistinguishable from an Admin editing the limit by hand — and
      this one costs money the organisation did not ask to spend.
    */
    const { db, inserts } = fakeDb();
    const expansion = await expandCandidateSeats(db, org(), 1);
    await recordExpansion(db, TENANT, expansion!, 'invitation accepted');

    const entry = inserts.find((i) => i.table === schema.auditLogEntries)!.values;
    expect(entry).toMatchObject({
      action: 'Added candidate seat block',
      category: 'billing',
      actorId: 'u-admin',
      actorName: 'Ada',
      orgId: ORG,
    });
    const target = String(entry.target);
    expect(target).toContain('candidate');
    expect(target).toContain('50');
    expect(target).toContain('100 → 150');
    expect(target).toContain('invitation accepted');
  });
});

describe('block pricing (R84, R85)', () => {
  it('discounts a larger block, so 500 as one block beats ten blocks of fifty', () => {
    expect(SEAT_BLOCK_DISCOUNTS[50]).toBe(0);
    expect(SEAT_BLOCK_DISCOUNTS[100]).toBe(0.15);
    expect(SEAT_BLOCK_DISCOUNTS[500]).toBe(0.25);

    // Priced against an arbitrary unit, since the list price is unset — the
    // ORDERING is what R84 fixes, not any currency amount.
    const unit = 1;
    const oneBlockOf500 = 500 * unit * (1 - SEAT_BLOCK_DISCOUNTS[500]);
    const tenBlocksOf50 = 10 * 50 * unit * (1 - SEAT_BLOCK_DISCOUNTS[50]);
    expect(oneBlockOf500).toBeLessThan(tenBlocksOf50);
  });

  it('invents no per-seat price (R85)', () => {
    // Deliberately null. The discounts are ratios against a price the product
    // owner has not set; anything computing a currency amount here would be
    // making one up.
    expect(PER_SEAT_LIST_PRICE).toBeNull();
    expect(SEAT_BLOCK_SIZES).toEqual([50, 100, 500]);
    expect(AUTOMATIC_EXPANSION_BLOCK).toBe(50);
  });
});

describe('the parked configuration divergence', () => {
  it('leaves packages/db/src/plans.ts reading Business 200 and Enterprise unlimited', () => {
    /*
      The contract states 100 and 500; the code says 200 and unlimited. The
      CONTRACT is the target and the code is the starting point — reconciling
      them is parked with separate billing work, and this unit must not
      "correct" either one. That reversal has already happened once and had to
      be undone, so it is pinned here rather than left to memory.
    */
    expect(PLAN_CONFIG.business.candidateSeatLimit).toBe(200);
    expect(PLAN_CONFIG.enterprise.candidateSeatLimit).toBeNull();

    const plans = fs.readFileSync(
      path.join(fileURLToPath(new URL('../../../../packages/db/src/', import.meta.url)), 'plans.ts'),
      'utf8',
    );
    expect(plans).toContain('candidateSeatLimit: 200');
  });
});
