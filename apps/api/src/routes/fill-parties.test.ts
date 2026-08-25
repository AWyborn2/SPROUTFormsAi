/**
 * Which workflow parties a caller fills a part AS — the decision behind
 * labelled supervisor/SME sign-off.
 *
 * The property that matters for a competency record: a candidate is only ever
 * the candidate (they can never acquire a staff signature), and a supervisor's
 * or SME's box is reachable by on-case staff ONLY when the org allows labelled
 * sign-off. With it off, staff resolve to the assessor alone, so those boxes
 * are left to nobody rather than signed by the wrong party.
 */
import { describe, expect, it } from 'vitest';
import { fillParties } from './assessments.js';

describe('fillParties', () => {
  it('a candidate is only ever the candidate', () => {
    expect(fillParties({ party: 'candidate', selfAssessing: false, labelled: true })).toEqual([
      'candidate',
    ]);
    expect(fillParties({ party: 'candidate', selfAssessing: false, labelled: false })).toEqual([
      'candidate',
    ]);
  });

  it('on-case staff hold the assessor plus labelled supervisor and SME', () => {
    expect(fillParties({ party: 'assessor', selfAssessing: false, labelled: true })).toEqual([
      'assessor',
      'supervisor',
      'sme',
    ]);
  });

  it('with labelled sign-off off, staff are the assessor alone — no proxy signing', () => {
    expect(fillParties({ party: 'assessor', selfAssessing: false, labelled: false })).toEqual([
      'assessor',
    ]);
  });

  it('a self-assessor is the candidate and staff at once, folding in labelled roles', () => {
    expect(fillParties({ party: 'candidate', selfAssessing: true, labelled: true })).toEqual([
      'candidate',
      'assessor',
      'supervisor',
      'sme',
    ]);
    // Self-assessing but labelled off: candidate + assessor only.
    expect(fillParties({ party: 'candidate', selfAssessing: true, labelled: false })).toEqual([
      'candidate',
      'assessor',
    ]);
  });
});
