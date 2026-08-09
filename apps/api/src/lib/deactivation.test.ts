import { describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';
import { competencyCurrency, countsAsHeld } from '@formai/shared';

const notifyMock = vi.hoisted(() => ({ notifyPoolOfInvalidatedCase: vi.fn() }));
vi.mock('./pool-notify.js', () => ({
  notifyPoolOfInvalidatedCase: notifyMock.notifyPoolOfInvalidatedCase,
}));

const { deactivateMember, reactivateMember } = await import('./deactivation.js');

const TENANT = { userId: 'admin-1', orgId: 'org-1', role: 'admin' as const };
const MEMBER = { id: 'm-2', userId: 'u-2', orgId: 'org-1', role: 'candidate' };

/**
 * A db double over the reads and writes the two transitions make.
 *
 * Every write is recorded as `{ table, values }` in order, because what these
 * rules forbid is as important as what they do: several assertions below are
 * that NOTHING touched the competency tables. A double that swallowed writes
 * would let a deactivation that quietly revoked somebody's tickets pass.
 */
function fakeDb(opts: {
  user?: unknown;
  openInvites?: unknown[];
  acceptedInvites?: unknown[];
  openCases?: unknown[];
}) {
  const writes: Array<{ table: unknown; values: unknown }> = [];
  const inserts: Array<{ table: unknown; values: unknown }> = [];

  const query = {
    users: { findFirst: vi.fn(async () => opts.user) },
    /*
      Two DIFFERENT invite predicates exist — open ones on the way out (R65),
      accepted ones on the way back (R76) — but each transition issues only one
      of them, so a fixture names whichever applies and the double cannot
      confuse them. Keying on call order instead would silently hand the
      reactivation path the deactivation path's answer.
    */
    invites: { findMany: vi.fn(async () => opts.openInvites ?? opts.acceptedInvites ?? []) },
    assessmentCases: { findMany: vi.fn(async () => opts.openCases ?? []) },
  };

  const surface = {
    query,
    update: (table: unknown) => ({
      set: (values: unknown) => {
        writes.push({ table, values });
        return { where: async () => undefined };
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        inserts.push({ table, values });
      },
    }),
    delete: () => {
      throw new Error('nothing in this path deletes (R63)');
    },
  };

  const db = {
    ...surface,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(surface),
  } as unknown as Db;

  return { db, writes, inserts };
}

describe('deactivateMember', () => {
  it('suspends the membership and deletes nothing (R62, R63)', async () => {
    const { db, writes, inserts } = fakeDb({ user: { id: 'u-2', name: 'Dale', email: 'dale@x.io' } });

    const out = await deactivateMember(db, TENANT, MEMBER);

    expect(writes).toContainEqual({ table: schema.memberships, values: { status: 'suspended' } });
    // `delete` throws, so reaching here at all proves nothing was removed.
    expect(out).toMatchObject({ invitationsClosed: 0, casesInvalidated: 0 });
    expect(inserts.some((i) => i.table === schema.auditLogEntries)).toBe(true);
  });

  it('closes an invitation they never accepted (R65, R75)', async () => {
    /*
      An invitation does not lapse with time — it stays open until accepted. One
      held by somebody who has gone would therefore stand open indefinitely, and
      accepting it would walk them straight back in through a door deactivation
      was supposed to have shut.
    */
    const { db, writes } = fakeDb({
      user: { id: 'u-2', name: 'Dale', email: 'dale@x.io' },
      openInvites: [{ id: 'inv-1' }, { id: 'inv-2' }],
    });

    const out = await deactivateMember(db, TENANT, MEMBER);

    expect(out.invitationsClosed).toBe(2);
    const closed = writes.filter((w) => w.table === schema.invites);
    expect(closed).toHaveLength(2);
    // Expired, not deleted — the record of having invited them survives.
    expect(closed[0]?.values).toHaveProperty('expiresAt');
  });

  it('invalidates a case in flight and tells the pool who can pick it up (R71, R73)', async () => {
    notifyMock.notifyPoolOfInvalidatedCase.mockClear().mockResolvedValue({ notifiedUserIds: ['a-1'] });
    const { db, writes } = fakeDb({
      user: { id: 'u-2', name: 'Dale Rivers', email: 'dale@x.io' },
      openCases: [{ id: 'c-1', toolId: 't-1', locationId: 'loc-1', assessorUserId: null }],
    });

    const out = await deactivateMember(db, TENANT, MEMBER);

    expect(out.casesInvalidated).toBe(1);
    const cased = writes.find((w) => w.table === schema.assessmentCases);
    /*
      `invalidated`, not `closed` — a closed case reads as one that finished,
      and a returner starts a fresh case rather than resuming this one (R74), so
      the two must stay distinguishable in the history. It is still TERMINAL
      though, which is what `closedAt` says: nobody will work it again.
    */
    expect(cased?.values).toMatchObject({ state: 'invalidated' });
    expect((cased?.values as { closedAt?: Date }).closedAt).toBeInstanceOf(Date);
    expect(notifyMock.notifyPoolOfInvalidatedCase).toHaveBeenCalledWith(
      db,
      'org-1',
      expect.objectContaining({ toolId: 't-1', locationId: 'loc-1', candidateName: 'Dale Rivers' }),
    );
  });

  it('completes even when the notice cannot be sent', async () => {
    // A notification nobody could deliver must not roll back a deactivation an
    // administrator has already decided on.
    notifyMock.notifyPoolOfInvalidatedCase.mockClear().mockRejectedValue(new Error('smtp down'));
    const { db, writes } = fakeDb({
      user: { id: 'u-2', name: 'Dale', email: 'dale@x.io' },
      openCases: [{ id: 'c-1', toolId: 't-1', locationId: null, assessorUserId: 'a-9' }],
    });

    await expect(deactivateMember(db, TENANT, MEMBER)).resolves.toMatchObject({ casesInvalidated: 1 });
    expect(writes).toContainEqual({ table: schema.memberships, values: { status: 'suspended' } });
  });

  it('releases the seat back to the pool the access level drew on (R77)', async () => {
    const staff = fakeDb({ user: { id: 'u-3', name: 'Ada', email: 'ada@x.io' } });
    await expect(
      deactivateMember(staff.db, TENANT, { ...MEMBER, role: 'assessor' }),
    ).resolves.toMatchObject({ seatReleased: 'staff' });

    const candidate = fakeDb({ user: { id: 'u-2', name: 'Dale', email: 'dale@x.io' } });
    await expect(deactivateMember(candidate.db, TENANT, MEMBER)).resolves.toMatchObject({
      seatReleased: 'candidate',
    });
  });

  it('revokes nothing — not a competency, not a document (R66, R63)', async () => {
    notifyMock.notifyPoolOfInvalidatedCase.mockClear().mockResolvedValue({ notifiedUserIds: [] });
    const { db, writes } = fakeDb({
      user: { id: 'u-2', name: 'Dale', email: 'dale@x.io' },
      openInvites: [{ id: 'inv-1' }],
      openCases: [{ id: 'c-1', toolId: 't-1', locationId: 'loc-1', assessorUserId: null }],
    });

    await deactivateMember(db, TENANT, MEMBER);

    /*
      Leaving is not a judgement about competence. Revocation is. Conflating the
      two would mean a returning worker had to be reassessed on tickets that
      never stopped being valid — and would misreport their history as revoked
      rather than merely lapsed.
    */
    const touched = writes.map((w) => w.table);
    expect(touched).not.toContain(schema.competencyHolders);
    expect(touched).not.toContain(schema.competencyDocuments);
    expect(touched).not.toContain(schema.memberProfiles);
  });
});

describe('reactivateMember', () => {
  it('leaves the status write to the caller and touches no other table (R68, R69)', async () => {
    // The membership status flip is the route's, inside its seat-lock
    // transaction — see routes/team.ts. So reactivateMember itself writes to no
    // table (in particular never the competency tables: it revokes nothing,
    // R66) and only records the audit.
    const { db, writes, inserts } = fakeDb({
      user: { id: 'u-2', name: 'Dale', email: 'dale@x.io', passwordHash: 'hash' },
    });

    const out = await reactivateMember(db, TENANT, MEMBER);

    expect(writes).toEqual([]);
    expect(out).toMatchObject({ seatConsumed: 'candidate', needsFreshInvitation: false });
    expect(inserts.some((i) => i.table === schema.auditLogEntries)).toBe(true);
  });

  it('asks for a fresh invitation only where they never accepted one (R76)', async () => {
    // Deactivation closed the invitation they were holding (R65), so there is
    // nothing left for them to accept — they need inviting again.
    const never = fakeDb({ user: { id: 'u-2', name: 'Dale', email: 'dale@x.io', passwordHash: null } });
    await expect(reactivateMember(never.db, TENANT, MEMBER)).resolves.toMatchObject({
      needsFreshInvitation: true,
    });

    // Somebody who completed a signup keeps working credentials.
    const did = fakeDb({
      user: { id: 'u-2', name: 'Dale', email: 'dale@x.io', passwordHash: null },
      acceptedInvites: [{ id: 'inv-1' }],
    });
    await expect(reactivateMember(did.db, TENANT, MEMBER)).resolves.toMatchObject({
      needsFreshInvitation: false,
    });
  });
});

describe('the clock keeps running through an absence (R69, R70)', () => {
  /*
    These assert a NON-event, and they belong here rather than beside the expiry
    module because the claim is about deactivation: currency is DERIVED from
    dates rather than ticked, so an absence needs no handling at all. If some
    later change paused or restarted a clock on the way out, these are what
    would notice.
  */
  const GRANTED = new Date('2025-01-10T00:00:00Z');
  const VALIDITY = { validForMonths: 12, gracePeriodDays: 30 };

  it('a competency still inside its date is valid the moment they return (R69)', () => {
    const backAfterSixMonths = new Date('2025-07-10T00:00:00Z');
    const currency = competencyCurrency({ grantedAt: GRANTED }, VALIDITY, backAfterSixMonths);
    expect(currency).toEqual({ status: 'held', revoked: false });
    expect(countsAsHeld(currency)).toBe(true);
  });

  it('one that lapsed while they were away reads EXPIRED, never revoked (R66, R70)', () => {
    const backAfterTwoYears = new Date('2027-01-10T00:00:00Z');
    const currency = competencyCurrency({ grantedAt: GRANTED }, VALIDITY, backAfterTwoYears);
    expect(currency).toEqual({ status: 'expired', revoked: false });
    expect(countsAsHeld(currency)).toBe(false);
  });

  it('a grace period that elapsed during the absence is simply over (R70)', () => {
    // Inside the 30 days, still counts — the absence bought no extension.
    const dayTwenty = new Date('2026-01-30T00:00:00Z');
    expect(competencyCurrency({ grantedAt: GRANTED }, VALIDITY, dayTwenty).status).toBe('grace');
    // Past it, expired — the clock did not pause for them either.
    const dayForty = new Date('2026-02-19T00:00:00Z');
    expect(competencyCurrency({ grantedAt: GRANTED }, VALIDITY, dayForty).status).toBe('expired');
  });
});
