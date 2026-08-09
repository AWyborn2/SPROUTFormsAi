import { eq } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import {
  AUTOMATIC_EXPANSION_BLOCK,
  blocksForOverflow,
  seatsInBlocks,
  type SeatBlockSize,
  type TenantContext,
} from '@formai/shared';
import { limitFor, type SeatCheck, type SeatDb, type SeatOrg } from './seats.js';
import { recordAudit } from '../audit/record.js';

/**
 * Expansion at the allocation boundary (U37, R86).
 *
 * THE INVERSION THIS UNIT PERFORMS: a full candidate pool used to refuse the
 * action. It now adds a charged block and lets the action through. Nothing else
 * in this plan spends money.
 *
 * ONLY THE CANDIDATE POOL EXPANDS. R84 and R86 are written entirely in
 * candidate-seat terms, and the staff-side rules are inside the parked billing
 * cluster — so there is no staff rule to implement, and the staff pool keeps
 * refusing exactly as it does today. Inventing a staff expansion would be
 * charging an organisation on a rule nobody has written.
 *
 * THE WRITE MUST HOLD THE ROW LOCK. Expansion has to happen inside the same
 * transaction that took `lockOrgForSeats`, or two acceptances arriving together
 * each read a full pool, each expand by a block, and the organisation is charged
 * twice for one seat. `expandCandidateSeats` therefore takes the transaction
 * handle, and the one seat check that runs UNLOCKED (the pre-hash check in
 * `invites.ts`) stops refusing without writing anything — it defers to the
 * locked check a few statements later.
 */

/** What one expansion did, for the audit entry and the caller's response. */
export interface SeatExpansion {
  /** Always 'candidate' — the staff pool does not expand. */
  pool: 'candidate';
  blockSize: SeatBlockSize;
  blocksAdded: number;
  seatsAdded: number;
  /** The limit in force before, RESOLVED through column-then-tier. */
  previousLimit: number;
  newLimit: number;
}

/**
 * Add enough blocks to fit `shortfall` more candidate seats, inside the caller's
 * locked transaction.
 *
 * Returns null where no expansion is possible or needed:
 *  - an unlimited pool has no boundary to cross;
 *  - a tier allocated NO candidate seats never expands into an allocation at
 *    all (R83). That organisation does not enrol candidates, and expanding it
 *    would sell a feature its plan does not include.
 */
export async function expandCandidateSeats(
  tx: SeatDb,
  org: SeatOrg,
  shortfall = 1,
): Promise<SeatExpansion | null> {
  const { limit } = limitFor(org, 'candidate');
  if (limit == null || !Number.isFinite(limit)) return null;
  if (limit <= 0) return null; // R83

  const blocks = blocksForOverflow(shortfall);
  if (blocks.length === 0) return null;
  const seatsAdded = seatsInBlocks(blocks);

  /*
    Writes the RESOLVED limit plus the block, never a bare block size. The column
    is nullable and a null inherits from the tier, so `set({ candidateSeatLimit:
    50 })` on a Business organisation carrying null would take it from two
    hundred seats to fifty — a refusal for every candidate past the fiftieth,
    caused by the very write that was meant to add room.
  */
  const newLimit = limit + seatsAdded;
  await tx
    .update(schema.organizations)
    .set({ candidateSeatLimit: newLimit })
    .where(eq(schema.organizations.id, org.id));

  return {
    pool: 'candidate',
    blockSize: AUTOMATIC_EXPANSION_BLOCK,
    blocksAdded: blocks[0]!.count,
    seatsAdded,
    previousLimit: limit,
    newLimit,
  };
}

/**
 * Record an expansion (R86).
 *
 * Deliberately NOT inside the locked transaction. The charge is the update
 * above; an audit insert that failed must not roll back seats an organisation is
 * now relying on, and the recorder reads the actor's name, which is one more
 * statement to hold a row lock across.
 *
 * Names the pool, the block size, the resulting limit, the action that triggered
 * it and the actor — because a moved integer on the organisation row is
 * otherwise indistinguishable from an Admin editing the limit by hand.
 */
export async function recordExpansion(
  db: Db,
  tenant: TenantContext,
  expansion: SeatExpansion,
  triggeredBy: string,
): Promise<void> {
  await recordAudit(db, tenant, {
    action: 'Added candidate seat block',
    target:
      `${expansion.blocksAdded} × ${expansion.blockSize} ${expansion.pool} seats ` +
      `(${expansion.previousLimit} → ${expansion.newLimit}) — ${triggeredBy}`,
    category: 'billing',
    icon: 'credit-card',
  });
}

/**
 * The whole boundary decision in one call, for a caller holding the row lock.
 *
 * Returns the check as taken, plus the expansion if one was performed. A caller
 * refuses only when `check.ok` is false AND `expansion` is null — which is every
 * staff-pool overflow, and a candidate pool on a tier allocated none (R83).
 */
export async function seatOrExpand(
  tx: SeatDb,
  org: SeatOrg,
  check: SeatCheck,
): Promise<{ check: SeatCheck; expansion: SeatExpansion | null }> {
  if (check.ok) return { check, expansion: null };
  if (check.pool !== 'candidate') return { check, expansion: null };

  /*
    How far past the boundary this action puts them. Normally one — the check
    refused because `used === limit` — but an organisation whose limit was
    lowered beneath its current count needs enough blocks to cover the whole
    overshoot, not one block that leaves it still over.
  */
  const shortfall = check.limit == null ? 1 : Math.max(1, check.used - check.limit + 1);
  const expansion = await expandCandidateSeats(tx, org, shortfall);
  return { check, expansion };
}
