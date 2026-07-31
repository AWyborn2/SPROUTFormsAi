/**
 * When a held competency stops counting.
 *
 * The rules these pin are the training authority's, not the code's:
 *
 *   · expired behaves like missing — it warns, it never blocks
 *   · grace STILL COUNTS, flagged, and its window is per competency
 *   · expiry is DERIVED from the grant date, so setting a validity applies to
 *     every existing grant of that qualification at once
 *   · the warning window differs by audience: 90 days for an assessor, 30 for
 *     a candidate looking at their own record
 *
 * The last of those is the one most likely to be "simplified" later by someone
 * who thinks two constants are one constant duplicated.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPIRY_WARNING_DAYS,
  competencyStatus,
  countsAsHeld,
  describeValidity,
  expiryNote,
  expiryOf,
} from './competency-expiry.js';

const at = (iso: string) => new Date(iso);
/** ATO - Track Dozer: three years, as the document states. */
const TRACK_DOZER = { validForMonths: 36 };
const GRANTED = at('2026-01-15T00:00:00Z');

describe('expiryOf', () => {
  it('adds the validity to the grant date, calendrically', () => {
    // The 15th to the 15th — a person reading "valid for three years" expects
    // the same day of the month, not 1095 days later.
    expect(expiryOf({ grantedAt: GRANTED }, TRACK_DOZER)?.toISOString().slice(0, 10)).toBe(
      '2029-01-15',
    );
  });

  it('never expires when the competency has no validity period', () => {
    /*
      This is the whole migration story. No competency carries a validity yet,
      so nothing expires the day this ships — each qualification starts
      expiring the moment an admin gives it one.
    */
    expect(expiryOf({ grantedAt: GRANTED }, {})).toBeNull();
    expect(expiryOf({ grantedAt: GRANTED }, { validForMonths: null })).toBeNull();
    expect(expiryOf({ grantedAt: GRANTED }, { validForMonths: 0 })).toBeNull();
  });

  it('lets an explicit date override the derived one', () => {
    // For a date imported from the training system that does not match the
    // formula — a short-issued ticket, or one extended by hand.
    const out = expiryOf({ grantedAt: GRANTED, expiresAt: at('2027-06-30T00:00:00Z') }, TRACK_DOZER);

    expect(out?.toISOString().slice(0, 10)).toBe('2027-06-30');
  });
});

describe('competencyStatus', () => {
  it('is held well before the date', () => {
    expect(competencyStatus({ grantedAt: GRANTED }, TRACK_DOZER, at('2027-01-01'))).toBe('held');
  });

  it('is held forever when the qualification has no validity', () => {
    expect(competencyStatus({ grantedAt: GRANTED }, {}, at('2099-01-01'))).toBe('held');
  });

  it('warns an assessor 90 days out and a candidate 30', () => {
    /*
      Two windows on purpose. An assessor is planning someone else's
      reassessment and needs the runway; a candidate is being prompted to act,
      and a warning visible for a third of a year stops reading as urgent.
    */
    const sixtyDaysOut = at('2028-11-16T00:00:00Z'); // ~60 days before 2029-01-15

    expect(competencyStatus({ grantedAt: GRANTED }, TRACK_DOZER, sixtyDaysOut, 'assessor')).toBe(
      'expiring',
    );
    expect(competencyStatus({ grantedAt: GRANTED }, TRACK_DOZER, sixtyDaysOut, 'candidate')).toBe(
      'held',
    );
  });

  it('defaults to the assessor window', () => {
    const sixtyDaysOut = at('2028-11-16T00:00:00Z');

    expect(competencyStatus({ grantedAt: GRANTED }, TRACK_DOZER, sixtyDaysOut)).toBe('expiring');
  });

  it('is expired the day after the date, with no grace', () => {
    expect(competencyStatus({ grantedAt: GRANTED }, TRACK_DOZER, at('2029-01-16'))).toBe('expired');
  });

  it('is in grace within the competency’s own window', () => {
    const withGrace = { ...TRACK_DOZER, gracePeriodDays: 30 };

    expect(competencyStatus({ grantedAt: GRANTED }, withGrace, at('2029-02-01'))).toBe('grace');
  });

  it('falls out of grace once the window closes', () => {
    const withGrace = { ...TRACK_DOZER, gracePeriodDays: 30 };

    expect(competencyStatus({ grantedAt: GRANTED }, withGrace, at('2029-03-01'))).toBe('expired');
  });

  it('gives each competency its own grace, not a shared constant', () => {
    // Set per qualification by an admin — a long-grace ticket and a
    // no-grace ticket on the same date land in different states.
    const day = at('2029-02-01');

    expect(competencyStatus({ grantedAt: GRANTED }, { ...TRACK_DOZER, gracePeriodDays: 90 }, day)).toBe('grace');
    expect(competencyStatus({ grantedAt: GRANTED }, { ...TRACK_DOZER, gracePeriodDays: 0 }, day)).toBe('expired');
  });

  it('lets revocation beat every date', () => {
    // A deliberate act — an overturned appeal, an admin decision — outranks a
    // date that would otherwise say the ticket is fine.
    const revoked = { grantedAt: GRANTED, revokedAt: at('2026-06-01') };

    expect(competencyStatus(revoked, TRACK_DOZER, at('2027-01-01'))).toBe('revoked');
    expect(competencyStatus(revoked, {}, at('2027-01-01'))).toBe('revoked');
  });
});

describe('countsAsHeld', () => {
  it('counts held, expiring and grace', () => {
    // The rule that keeps a near-date or requalifying ticket from blocking an
    // assessment that is actually happening.
    expect(countsAsHeld('held')).toBe(true);
    expect(countsAsHeld('expiring')).toBe(true);
    expect(countsAsHeld('grace')).toBe(true);
  });

  it('does not count expired or revoked', () => {
    expect(countsAsHeld('expired')).toBe(false);
    expect(countsAsHeld('revoked')).toBe(false);
  });
});

describe('expiryNote', () => {
  it('says which of the three states, with the date', () => {
    const d = at('2029-01-15T00:00:00Z');

    expect(expiryNote('expiring', d, 'ATO - Track Dozer')).toContain('expires on 2029-01-15');
    expect(expiryNote('grace', d, 'ATO - Track Dozer')).toMatch(/grace period/);
    expect(expiryNote('expired', d, 'ATO - Track Dozer')).toContain('expired on 2029-01-15');
  });

  it('says nothing about a competency that is simply held', () => {
    expect(expiryNote('held', at('2029-01-15'), 'ATO - Track Dozer')).toBeNull();
    expect(expiryNote('held', null, 'ATO - Track Dozer')).toBeNull();
  });

  it('says nothing when there is no expiry to talk about', () => {
    expect(expiryNote('expired', null, 'ATO - Track Dozer')).toBeNull();
  });
});

describe('describeValidity', () => {
  it('says years, because that is how a ticket is written', () => {
    // The source document says "valid for 3 years". Showing an admin "36
    // months" beside a competency they know as a three-year ticket makes them
    // stop and check they typed the right thing.
    expect(describeValidity({ validForMonths: 36 })).toBe('3 years');
    expect(describeValidity({ validForMonths: 12 })).toBe('1 year');
  });

  it('falls back to months when it is not a whole number of years', () => {
    expect(describeValidity({ validForMonths: 18 })).toBe('18 months');
    expect(describeValidity({ validForMonths: 1 })).toBe('1 month');
  });

  it('mentions the grace period only when there is one', () => {
    expect(describeValidity({ validForMonths: 36, gracePeriodDays: 90 })).toBe('3 years · 90 day grace');
    expect(describeValidity({ validForMonths: 36, gracePeriodDays: 0 })).toBe('3 years');
  });

  it('says so plainly when nothing expires', () => {
    expect(describeValidity({})).toBe('Never expires');
    expect(describeValidity({ validForMonths: null })).toBe('Never expires');
    // A grace period with no validity is meaningless, not a partial expiry.
    expect(describeValidity({ validForMonths: null, gracePeriodDays: 30 })).toBe('Never expires');
  });
});

describe('the audience windows', () => {
  it('gives an assessor more runway than a candidate', () => {
    // Pinned as a relationship rather than two magic numbers, so a later edit
    // has to think about which one it is changing.
    expect(EXPIRY_WARNING_DAYS.assessor).toBeGreaterThan(EXPIRY_WARNING_DAYS.candidate);
  });
});
