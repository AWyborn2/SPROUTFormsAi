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

/**
 * The limit governing `role` for this org.
 *
 * Resolution order matches the pre-existing staff-seat rule: the explicit
 * per-org column first, then the tier config. A null column means INHERIT (rows
 * written before the column existed read back null), not unlimited — unlimited
 * is the tier config itself resolving to null.
 */
function limitFor(
  org: { planTier: string; seatLimit: number | null; candidateSeatLimit: number | null },
  role: Role,
): { limit: number | null; pool: 'staff' | 'candidate' } {
  const tier = PLAN_CONFIG[org.planTier as PlanTier];
  if (role === 'candidate') {
    return { limit: org.candidateSeatLimit ?? tier?.candidateSeatLimit ?? null, pool: 'candidate' };
  }
  return { limit: org.seatLimit ?? tier?.seatLimit ?? null, pool: 'staff' };
}

/**
 * Whether one more membership of `role` fits in this org.
 *
 * A non-finite or absent limit means unlimited and short-circuits the count —
 * enforcement is skipped ONLY when the tier genuinely configures no cap, never
 * as a fallback for a lookup that failed.
 */
export async function checkSeatAvailability(
  db: Db,
  org: {
    id: string;
    planTier: string;
    seatLimit: number | null;
    candidateSeatLimit: number | null;
  },
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
