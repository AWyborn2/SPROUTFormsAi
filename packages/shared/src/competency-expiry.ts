/**
 * When a competency someone holds stops counting.
 *
 * A ticket is not held forever. "ATO - Track Dozer" is valid for three years,
 * and the training system this org runs on reports four states per person per
 * qualification: satisfied, about to expire, in grace, not satisfied. The
 * platform had one — a row exists or it does not — so a grant from five years
 * ago read exactly like one made this morning, and every eligibility check
 * agreed with it.
 *
 * Three decisions shape everything here, all of them the training authority's
 * rather than this module's:
 *
 * 1. EXPIRED BEHAVES LIKE MISSING: it warns, it never blocks. That is the same
 *    rule prerequisites already follow, for the same reason — an out-of-date
 *    RECORD is far more common than an unqualified person, and a wrong date
 *    must not stop a real assessment being written down.
 *
 * 2. GRACE STILL COUNTS. Within its grace period a lapsed ticket is treated as
 *    current and flagged, because that is what a grace period is for: the
 *    person is requalifying, not unqualified. The window is set per
 *    competency, not globally — different qualifications get different grace.
 *
 * 3. EXPIRY IS DERIVED, NOT FROZEN. It is computed from the grant date and the
 *    competency's validity period rather than stamped onto the row when
 *    granted. So setting a validity on a qualification applies immediately to
 *    every grant of it, however old — which is exactly what "backfill from the
 *    grant date" has to mean when no qualification has a validity yet.
 *
 * The consequence of (3) worth stating plainly: a competency with no validity
 * period NEVER expires. That is the migration story — nothing changes the day
 * this ships, and each qualification starts expiring the moment an admin gives
 * it a validity.
 */

/** How long a qualification stays valid, and how long past that it still counts. */
export interface CompetencyValidity {
  /**
   * Months from the grant date. Null or absent means it never expires — which
   * is every competency until an admin sets one.
   */
  validForMonths?: number | null;
  /**
   * Days past expiry during which the ticket still counts, flagged. Null or
   * absent means no grace: expiry is a hard date.
   */
  gracePeriodDays?: number | null;
}

/** The bits of a holder row that decide whether it still counts. */
export interface HeldCompetency {
  /**
   * When it was last GRANTED — reset by requalification, so distinct from the
   * row's creation. A re-grant is a new three years, not a touched record.
   */
  grantedAt: Date;
  /**
   * An explicit end date that overrides the derived one. For a date imported
   * from the training system that does not match the formula — a ticket issued
   * with a short validity, or one extended by hand.
   */
  expiresAt?: Date | null;
  /** Set when an appeal or an admin took it away. Beats every other state. */
  revokedAt?: Date | null;
}

/**
 * What a held competency currently is.
 *
 * `expiring` and `grace` both still COUNT — they are eligible states carrying a
 * flag. Only `expired` and `revoked` stop counting. Keeping them as distinct
 * names rather than a boolean plus a reason is deliberate: every surface that
 * reports one has to say which, and an enum makes forgetting hard.
 */
export type CompetencyStatus = 'held' | 'expiring' | 'grace' | 'expired' | 'revoked';

/** How near an expiry has to be to be worth mentioning, per audience. */
export const EXPIRY_WARNING_DAYS = {
  /**
   * Assessor-facing surfaces — opening a case, checking who may sign off. The
   * longer window because a multi-part reassessment has to be scheduled, and
   * the person seeing it is planning someone else's work.
   */
  assessor: 90,
  /**
   * A candidate looking at their own record. Shorter on purpose: it is a
   * prompt to act, not a planning horizon, and a warning visible for a third
   * of a year stops reading as urgent.
   */
  candidate: 30,
} as const;

export type ExpiryAudience = keyof typeof EXPIRY_WARNING_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When this grant runs out, or null if it never does.
 *
 * An explicit `expiresAt` wins over the derived date — that is the point of
 * having it. Otherwise the grant date plus the validity period; and with no
 * validity period there is no expiry at all.
 *
 * Months are added calendrically rather than as 30-day blocks, so a ticket
 * granted on the 15th expires on the 15th. `setMonth` overflows correctly for
 * short months (31 January + 1 month lands in March), which is the standard
 * behaviour and matches how a person reads "valid for three years".
 */
export function expiryOf(held: HeldCompetency, validity: CompetencyValidity): Date | null {
  if (held.expiresAt) return held.expiresAt;
  const months = validity.validForMonths;
  if (!months || months <= 0) return null;

  const out = new Date(held.grantedAt.getTime());
  out.setMonth(out.getMonth() + months);
  return out;
}

/**
 * The state of one held competency at a moment in time.
 *
 * `now` is a parameter rather than read from the clock so this stays pure and
 * testable — every caller passes the same instant, which also stops two fields
 * of one response disagreeing about what "today" is.
 */
export function competencyStatus(
  held: HeldCompetency,
  validity: CompetencyValidity,
  now: Date,
  audience: ExpiryAudience = 'assessor',
): CompetencyStatus {
  // Revocation is a deliberate act and outranks any date.
  if (held.revokedAt) return 'revoked';

  const expiry = expiryOf(held, validity);
  if (!expiry) return 'held';

  const msLeft = expiry.getTime() - now.getTime();
  if (msLeft > 0) {
    return msLeft <= EXPIRY_WARNING_DAYS[audience] * DAY_MS ? 'expiring' : 'held';
  }

  // Past the date. Grace is the only thing keeping it alive now.
  const graceDays = validity.gracePeriodDays ?? 0;
  const msPastExpiry = -msLeft;
  return graceDays > 0 && msPastExpiry <= graceDays * DAY_MS ? 'grace' : 'expired';
}

/**
 * Whether this status still satisfies a requirement.
 *
 * `expiring` and `grace` both do. An assessment must not be blocked by a ticket
 * that is merely close to its date, nor by one inside the window the authority
 * deliberately allows for requalifying.
 */
export function countsAsHeld(status: CompetencyStatus): boolean {
  return status === 'held' || status === 'expiring' || status === 'grace';
}

/**
 * A competency's validity, as an admin reads it in a list.
 *
 * Whole years get said as years because that is how every ticket in this
 * industry is written — "valid for 3 years", never "36 months".
 */
export function describeValidity(validity: CompetencyValidity): string {
  const months = validity.validForMonths;
  if (!months || months <= 0) return 'Never expires';

  const period =
    months % 12 === 0
      ? `${months / 12} ${months === 12 ? 'year' : 'years'}`
      : `${months} ${months === 1 ? 'month' : 'months'}`;

  const grace = validity.gracePeriodDays;
  return grace && grace > 0 ? `${period} · ${grace} day grace` : period;
}

/** Reviewer-facing wording for a status that needs saying out loud. */
export function expiryNote(
  status: CompetencyStatus,
  expiry: Date | null,
  competencyName: string,
): string | null {
  if (!expiry) return null;
  const on = expiry.toISOString().slice(0, 10);
  switch (status) {
    case 'expiring':
      return `${competencyName} expires on ${on}.`;
    case 'grace':
      return `${competencyName} expired on ${on} and is within its grace period.`;
    case 'expired':
      return `${competencyName} expired on ${on}.`;
    default:
      return null;
  }
}
