import { and, count, eq, ne } from 'drizzle-orm';
import { PLAN_CONFIG, schema, type Db, type PlanTier } from '@formai/db';
import type { Role } from '@formai/shared';

/**
 * Seat accounting for one org.
 *
 * TWO INDEPENDENT POOLS. Candidates are metered separately from staff because
 * the two scale differently: a site with 15 trainers may assess several hundred
 * operators, so charging candidates against the staff limit would exhaust every
 * tier at a single site.
 *
 * Shared by the two places a membership can be created — invite creation
 * (`team.ts`) and invite acceptance (`invites.ts`). They MUST agree: if only one
 * split the pools, an invite that passed creation would be refused on
 * acceptance, stranding the person holding the link.
 *
 * ADVISORY vs BINDING. Invite creation checks so the dialog can say no early,
 * but a pending invite deliberately reserves nothing — an org can hold far more
 * outstanding invites than it has free seats. That makes ACCEPTANCE the only
 * thing actually holding the count down, so acceptance pairs the count with
 * `lockOrgForSeats` inside a transaction. Everywhere else the check is a
 * courtesy; there it is the limit.
 */

export interface SeatCheck {
  /** Whether another membership of this role fits. */
  ok: boolean;
  /** The effective limit applied, or null when the pool is unlimited. */
  limit: number | null;
  /** Active memberships already in that pool. */
  used: number;
  /** Which pool was consulted. */
  pool: 'staff' | 'candidate';
}

/** The org columns the seat rules read. */
export interface SeatOrg {
  id: string;
  planTier: string;
  seatLimit: number | null;
  candidateSeatLimit: number | null;
}

/**
 * The root client OR an open transaction.
 *
 * The count has to be runnable on the caller's transaction handle. Taken on the
 * root client it would sit in its own auto-commit snapshot, separate from the
 * INSERT it is supposed to be guarding — which is the whole race
 * `lockOrgForSeats` exists to close.
 */
export type SeatDb = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Which pool a role draws on. Exported so a role CHANGE can ask whether it
 * crosses between them — that, not the role itself, is what consumes a seat.
 */
export function poolFor(role: Role): 'staff' | 'candidate' {
  return role === 'candidate' ? 'candidate' : 'staff';
}

/**
 * The limit governing `role` for this org.
 *
 * Resolution order matches the pre-existing staff-seat rule: the explicit
 * per-org column first, then the tier config. A null column means INHERIT (rows
 * written before the column existed read back null), not unlimited — unlimited
 * is the tier config itself resolving to null.
 *
 * EXPORTED because expansion (U37) must resolve by exactly this order before it
 * writes. `candidate_seat_limit` is nullable and a null inherits, so writing a
 * bare block size onto a null would drop a Business organisation from two
 * hundred seats to fifty and lock out enrolment.
 */
export function limitFor(
  org: { planTier: string; seatLimit: number | null; candidateSeatLimit: number | null },
  role: Role,
): { limit: number | null; pool: 'staff' | 'candidate' } {
  const tier = PLAN_CONFIG[org.planTier as PlanTier];
  const pool = poolFor(role);
  if (pool === 'candidate') {
    return { limit: org.candidateSeatLimit ?? tier?.candidateSeatLimit ?? null, pool };
  }
  return { limit: org.seatLimit ?? tier?.seatLimit ?? null, pool };
}

/**
 * Whether one more membership of `role` fits in this org.
 *
 * A non-finite or absent limit means unlimited and short-circuits the count —
 * enforcement is skipped ONLY when the tier genuinely configures no cap, never
 * as a fallback for a lookup that failed.
 */
export async function checkSeatAvailability(
  db: SeatDb,
  org: SeatOrg,
  role: Role,
): Promise<SeatCheck> {
  const { limit, pool } = limitFor(org, role);

  if (limit == null || !Number.isFinite(limit)) {
    return { ok: true, limit: null, used: 0, pool };
  }

  const [result] = await db
    .select({ count: count() })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.orgId, org.id),
        eq(schema.memberships.status, 'active'),
        pool === 'candidate'
          ? eq(schema.memberships.role, 'candidate')
          : ne(schema.memberships.role, 'candidate'),
      ),
    );

  const used = result?.count ?? 0;
  return { ok: used < limit, limit, used, pool };
}

/**
 * Take an exclusive lock on the org row, returning the columns the seat rules
 * read — or null when there is no such org.
 *
 * This is what turns a seat check from advisory into binding. `checkSeatAvailability`
 * on its own is a COUNT, and a COUNT plus a later INSERT is two statements with
 * a gap between them: two acceptances arriving together both read
 * `used = limit - 1`, both pass, and both insert, putting the org a seat over
 * its limit. Nothing downstream catches that — `memberships_user_org_uq` only
 * stops one USER joining twice, it knows nothing about the pool total.
 *
 * `SELECT ... FOR UPDATE` serialises every caller doing this against the same
 * org, so the second one blocks here until the first has committed and then
 * counts a total that includes it. Under READ COMMITTED each statement takes a
 * fresh snapshot, so the count after the lock does see the committed insert —
 * no SERIALIZABLE retry loop needed.
 *
 * TWO RULES, both load-bearing:
 *  - MUST be called inside a transaction. The lock is released at COMMIT, so on
 *    the auto-committing root client it is gone before the INSERT it was meant
 *    to cover ever runs.
 *  - MUST come before the count. Locking afterwards leaves the same gap it was
 *    supposed to close.
 *
 * Cost is one briefly-held row lock per acceptance, which also blocks concurrent
 * UPDATEs of that organizations row (a rename, a branding change) for the few
 * statements the transaction lasts. Locks on different orgs never interact.
 */
export async function lockOrgForSeats(db: SeatDb, orgId: string): Promise<SeatOrg | null> {
  const [org] = await db
    .select({
      id: schema.organizations.id,
      planTier: schema.organizations.planTier,
      seatLimit: schema.organizations.seatLimit,
      candidateSeatLimit: schema.organizations.candidateSeatLimit,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .for('update');
  return org ?? null;
}

/** The refusal body both call sites return when a pool is full. */
export function seatLimitError(check: SeatCheck, planTier: string) {
  const noun = check.pool === 'candidate' ? 'candidate' : 'seat';
  return {
    error: check.pool === 'candidate' ? 'candidate_limit_reached' : 'seat_limit_reached',
    message: `Your ${planTier} plan allows ${check.limit} ${noun}${check.limit === 1 ? '' : 's'}. Remove a ${noun === 'seat' ? 'member' : 'candidate'} or upgrade your plan to add more.`,
    seatLimit: check.limit,
    seatUsed: check.used,
  };
}
