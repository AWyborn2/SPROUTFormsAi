import { describe, expect, it } from 'vitest';
import {
  DISPLAY_IDENTIFIER_LABELS,
  DISPLAY_IDENTIFIERS,
  TAXONOMY_TIERS,
  taxonomyAvailableForTier,
  type DisplayIdentifier,
} from './taxonomy.js';

describe('taxonomy tier gate (R13, R14)', () => {
  it('carries a taxonomy at Business and Enterprise', () => {
    expect(taxonomyAvailableForTier('business')).toBe(true);
    expect(taxonomyAvailableForTier('enterprise')).toBe(true);
  });

  it('carries none below Business', () => {
    expect(taxonomyAvailableForTier('individual')).toBe(false);
    expect(taxonomyAvailableForTier('team')).toBe(false);
  });

  it('treats an unknown tier as unentitled rather than guessing', () => {
    expect(taxonomyAvailableForTier('')).toBe(false);
    expect(taxonomyAvailableForTier('platinum')).toBe(false);
  });

  it('gates on exactly the two tiers that hold candidate seats', () => {
    expect([...TAXONOMY_TIERS].sort()).toEqual(['business', 'enterprise']);
  });
});

describe('display identifier choice (R40)', () => {
  it('offers exactly the two workforce numbers', () => {
    expect(DISPLAY_IDENTIFIERS).toEqual(['employee_number', 'swipe_card_number']);
  });

  it('labels both', () => {
    for (const id of DISPLAY_IDENTIFIERS) {
      expect(DISPLAY_IDENTIFIER_LABELS[id as DisplayIdentifier]).toBeTruthy();
    }
  });
});
