/**
 * `markPlacement` is the single source of truth for where a mark lands inside a
 * grid cell (KTD1). Both the round-trip exporter and the review preview consume
 * it, so these fix the documented geometry — a change here changes both surfaces
 * at once, which is exactly the property that keeps the preview honest (R3/AE3).
 */
import { describe, expect, it } from 'vitest';
import type { GeometryBand } from './form-field.js';
import {
  MARK_INSET,
  MARK_SIZE_CEIL,
  MARK_SIZE_FLOOR,
  markPlacement,
} from './geometry.js';

const band = (key: string, start: number, end: number): GeometryBand => ({ key, start, end });

describe('markPlacement', () => {
  it('insets the mark from the cell origin and sizes it from the row height', () => {
    // Row 20pt tall: size = 20 - 3 = 17, clamped to the 9 ceiling.
    const place = markPlacement(band('r0', 400, 420), band('ok', 240, 290));

    expect(place.x).toBe(240 + MARK_INSET);
    expect(place.y).toBe(400 + MARK_INSET);
    expect(place.size).toBe(MARK_SIZE_CEIL);
  });

  it('takes the un-clamped row-derived size inside the band', () => {
    // Row 10pt tall: size = 10 - 3 = 7, between the floor (4) and ceiling (9).
    expect(markPlacement(band('r0', 100, 110), band('c', 0, 40)).size).toBe(7);
  });

  it('clamps a tall row down to the ceiling', () => {
    expect(markPlacement(band('r0', 0, 100), band('c', 0, 40)).size).toBe(MARK_SIZE_CEIL);
  });

  it('clamps a short row up to the floor', () => {
    // Row 5pt tall: size = 5 - 3 = 2, below the floor (4).
    expect(markPlacement(band('r0', 0, 5), band('c', 0, 40)).size).toBe(MARK_SIZE_FLOOR);
  });

  it('clamps a degenerate zero-height row to the floor, never a non-finite size', () => {
    const place = markPlacement(band('r0', 400, 400), band('c', 240, 290));

    expect(place.size).toBe(MARK_SIZE_FLOOR);
    expect(Number.isFinite(place.size)).toBe(true);
  });

  it('reads x from the column band and y from the row band — never crossing axes', () => {
    const place = markPlacement(band('r0', 12, 34), band('c', 500, 560));

    expect(place.x).toBe(500 + MARK_INSET);
    expect(place.y).toBe(12 + MARK_INSET);
  });
});
