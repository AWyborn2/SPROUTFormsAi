import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_EXPANSION_BLOCK,
  PER_SEAT_LIST_PRICE,
  SEAT_BLOCK_DISCOUNTS,
  SEAT_BLOCK_SIZES,
  blocksForOverflow,
  seatsInBlocks,
} from './seat-blocks.js';

describe('the block catalogue', () => {
  it('sells three sizes, and a larger one costs less per seat', () => {
    // AE39: 500 bought as one block carries a discount ten blocks of 50 do not.
    expect(SEAT_BLOCK_SIZES).toEqual([50, 100, 500]);
    expect(SEAT_BLOCK_DISCOUNTS[50]).toBe(0);
    expect(SEAT_BLOCK_DISCOUNTS[100]).toBe(0.15);
    expect(SEAT_BLOCK_DISCOUNTS[500]).toBe(0.25);
  });

  it('leaves the per-seat list price unset rather than inventing one', () => {
    // R85. The discounts are ratios against a price nobody has set.
    expect(PER_SEAT_LIST_PRICE).toBeNull();
  });

  it('expands automatically at the smallest size', () => {
    // KTD27: the least an organisation is committed to by a charge it did not ask for.
    expect(AUTOMATIC_EXPANSION_BLOCK).toBe(50);
  });
});

describe('blocksForOverflow', () => {
  it('buys one block for an overflow of a single seat', () => {
    // Blocks are indivisible — the organisation ends up with more than it needed.
    expect(blocksForOverflow(1)).toEqual([{ size: 50, count: 1, seats: 50, discount: 0 }]);
  });

  it('buys exactly one block for an overflow that fills it', () => {
    expect(blocksForOverflow(50)).toEqual([{ size: 50, count: 1, seats: 50, discount: 0 }]);
  });

  it('buys six blocks for the 260-seat overflow the contract works through', () => {
    // AE53: 360 candidate rows against an included allocation of 100.
    const purchases = blocksForOverflow(260);
    expect(purchases).toEqual([{ size: 50, count: 6, seats: 300, discount: 0 }]);
    expect(seatsInBlocks(purchases)).toBeGreaterThanOrEqual(260);
  });

  it('buys nothing for a zero or negative overflow', () => {
    // A caller rendering "blocks to be bought" shows nothing, not "0 blocks".
    expect(blocksForOverflow(0)).toEqual([]);
    expect(blocksForOverflow(-5)).toEqual([]);
  });

  it('always covers the overflow it was given', () => {
    for (const overflow of [1, 7, 49, 50, 51, 99, 100, 260, 999]) {
      expect(seatsInBlocks(blocksForOverflow(overflow))).toBeGreaterThanOrEqual(overflow);
    }
  });

  it('never over-buys by a whole block', () => {
    for (const overflow of [1, 7, 49, 50, 51, 99, 100, 260, 999]) {
      const seats = seatsInBlocks(blocksForOverflow(overflow));
      expect(seats - overflow).toBeLessThan(AUTOMATIC_EXPANSION_BLOCK);
    }
  });
});
