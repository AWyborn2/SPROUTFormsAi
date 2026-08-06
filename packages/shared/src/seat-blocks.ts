/**
 * Additional candidate seats, sold in blocks (R84, R85, R86).
 *
 * PURE: no database, no clock, no pricing lookup. Two consumers read it and must
 * agree — the cost preview an import states before it spends anything (U28), and
 * the expansion that actually adds seats at the allocation boundary (U37). A
 * preview computed by different arithmetic from the expansion is a preview that
 * can be wrong about the charge it quoted.
 *
 * NOT A BILLING SURFACE. Metering, invoicing and collecting payment belong
 * elsewhere; this module says how many seats a block carries and what discount
 * its size earns, which is what R84 fixes.
 */

/** The three sizes sold, smallest first (R84). */
export const SEAT_BLOCK_SIZES = [50, 100, 500] as const;
export type SeatBlockSize = (typeof SEAT_BLOCK_SIZES)[number];

/**
 * The discount each size earns against the per-seat list price (R84).
 *
 * A larger block costs less per seat, so an organisation that knows it is
 * growing is rewarded for committing up front.
 */
export const SEAT_BLOCK_DISCOUNTS: Record<SeatBlockSize, number> = {
  50: 0,
  100: 0.15,
  500: 0.25,
};

/**
 * The size an automatic overflow adds (KTD27).
 *
 * The smallest R84 sells. It is the least the action needs and the least an
 * organisation is committed to by a charge it did not ask for — R86 expands
 * without asking outside an import run, so the default must be the one that
 * commits them least. Whether the size is instead pre-selected per organisation
 * is an open question in the parked billing cluster, and answering it moves this
 * constant rather than the mechanism.
 */
export const AUTOMATIC_EXPANSION_BLOCK: SeatBlockSize = 50;

/**
 * The per-seat list price is UNSET (R85).
 *
 * Deliberately not a number. The discounts above are ratios against a price the
 * product owner has not set, so anything computing a currency amount here would
 * be inventing one. A caller that needs money asks the billing surface.
 */
export const PER_SEAT_LIST_PRICE: null = null;

export interface SeatBlockPurchase {
  size: SeatBlockSize;
  count: number;
  /** Seats this line adds — `size * count`. */
  seats: number;
  /** Ratio off the per-seat list price for this size (R84). */
  discount: number;
}

/**
 * How many blocks an overflow of `seats` buys, at the automatic size.
 *
 * Blocks are indivisible, so an overflow of one seat still buys a whole block —
 * the organisation ends up with more seats than it needed, which is what a block
 * is. Returns an empty list for a non-positive overflow rather than a zero-count
 * line, so a caller rendering "blocks to be bought" shows nothing rather than
 * "0 blocks".
 */
export function blocksForOverflow(seats: number): SeatBlockPurchase[] {
  if (!Number.isFinite(seats) || seats <= 0) return [];
  const size = AUTOMATIC_EXPANSION_BLOCK;
  const count = Math.ceil(seats / size);
  return [{ size, count, seats: size * count, discount: SEAT_BLOCK_DISCOUNTS[size] }];
}

/** Total seats a set of purchases adds. */
export function seatsInBlocks(purchases: readonly SeatBlockPurchase[]): number {
  return purchases.reduce((total, p) => total + p.seats, 0);
}
