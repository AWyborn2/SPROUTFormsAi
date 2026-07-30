/**
 * Induction assessment — turning a CHC intake submission into a booking answer.
 *
 * The intake form (`chc-intake.ts`) collects everything a BBM site induction
 * needs. What it does not do is answer the questions asked at booking time:
 * is this starter actually registrable, on which Monday, and how many seats
 * does that Monday need. This module answers exactly those, so the API route
 * and the MCP tools that sit above it never re-derive them.
 *
 * Two rules carry the module.
 *
 * 1. THE DATE RULE IS BORROWED, NEVER RESTATED. Every weekday, holiday and
 *    notice question delegates to `chc-intake.ts`. That file's docstring is
 *    explicit that its surfaces must agree exactly; a third consumer that
 *    reimplemented the rule would eventually book a starter with too little
 *    notice, which is the failure the rule exists to prevent.
 *
 * 2. ASSESSMENT HAPPENS NOW, NOT AT FILL TIME. A date inside the booking window
 *    when the form was filled may be past the Thursday cutoff today. So the
 *    window check re-runs against the caller's clock and reports
 *    `date_notice_lapsed` separately from `date_invalid` — the two need
 *    different human responses (rebook vs. correct the form).
 *
 * Sensitive personal detail is deliberately segregated onto `profile.sensitive`
 * rather than spread across the profile. A booking needs a name, a mobile and
 * an email; date of birth, home address, licence number and emergency contact
 * are collected for other purposes, and the caller that wants them has to reach
 * for them explicitly.
 */

import {
  CHC_FIELD_IDS,
  CHC_ROLE_FIELD_BY_DEPARTMENT,
  bookingCutoffFor,
  holidaysCoverThrough,
  isInductionDay,
  withinBookingWindow,
} from './chc-intake.js';
import type { FormField } from './form-field.js';
import { isFileRef } from './submission.js';
import type { SubmissionValue } from './submission.js';

/** What an uploaded identity document looks like once it is a reference, not bytes. */
export interface StarterDocument {
  present: boolean;
  fileName?: string;
  contentType?: string;
}

/**
 * Personal detail the induction booking itself does not need.
 *
 * Held apart from the rest of the profile so a caller returning data to an
 * agent has to opt in rather than opt out — see the module docstring.
 */
export interface StarterSensitiveDetail {
  dob: string;
  addressStreet: string;
  suburb: string;
  postcode: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  licenceClass: string;
  licenceExpiry: string;
  licenceNumber: string;
}

/** One starter, as the booking workflow needs to see them. */
export interface StarterProfile {
  firstName: string;
  middleName: string;
  lastName: string;
  /** First and last, the form BISTrainer's registration rows expect. */
  fullName: string;
  gender: string;
  indigenous: boolean | null;
  starterType: string;
  /** ISO `YYYY-MM-DD` as answered. Not validated here — see `assessInductionReadiness`. */
  inductionDate: string;
  department: string;
  /** Always an array: Operations may hold several roles, every other department exactly one. */
  roles: string[];
  /**
   * Null when the question was never answered. Load-bearing: a starter already
   * in Beakon never sees the Additional Details section, so their contact and
   * document answers are legitimately absent rather than missing.
   */
  inBeakon: boolean | null;
  mobile: string;
  email: string;
  photo: StarterDocument;
  driversLicence: StarterDocument;
  sensitive: StarterSensitiveDetail;
}

/** Why a starter cannot be registered as they stand. */
export type InductionBlocker =
  | 'contact_missing'
  | 'identity_missing'
  | 'date_invalid'
  | 'date_notice_lapsed'
  | 'already_booked';

/** Something a human should know that does not stop the booking. */
export type InductionWarning = 'holiday_list_expired' | 'notice_overridden';

export interface InductionVerdict {
  readiness: 'ready' | 'blocked';
  blockers: InductionBlocker[];
  warnings: InductionWarning[];
}

/** A starter plus their verdict, which is what cohorts are built from. */
export interface AssessedStarter extends InductionVerdict {
  submissionId: string;
  profile: StarterProfile;
}

/** Every starter sharing one induction date, with the seat count that implies. */
export interface InductionCohort {
  date: string;
  /** Seats to book — ready starters only. A blocked starter must not hold a seat. */
  seats: number;
  readyCount: number;
  blockedCount: number;
  /** Everyone requesting this date, blocked ones included, so the gap is visible. */
  starters: AssessedStarter[];
}

/** Field ids that must all be present for a template to be an intake form. */
const REQUIRED_SHAPE = [
  CHC_FIELD_IDS.firstName,
  CHC_FIELD_IDS.lastName,
  CHC_FIELD_IDS.inductionDate,
  CHC_FIELD_IDS.inBeakon,
] as const;

/**
 * The ISO `YYYY-MM-DD` shape every induction date is stored and compared in.
 *
 * Exported because the API route validates query parameters against the same
 * shape: two copies of this pattern is two chances to accept a date this
 * module will silently treat as unusable.
 */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE_PATTERN.test(value);
}

function text(values: Record<string, SubmissionValue>, id: string): string {
  const value = values[id];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function tribool(values: Record<string, SubmissionValue>, id: string): boolean | null {
  const value = values[id];
  if (typeof value === 'boolean') return value;
  // `boolean_yes_no` normalises to the strings 'true'/'false' on some surfaces
  // (see `scalarAnswer` in visibility.ts), so both encodings arrive here.
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function document(values: Record<string, SubmissionValue>, id: string): StarterDocument {
  const value = values[id];
  if (!isFileRef(value)) return { present: false };
  // The storage key is deliberately not carried through: it is only useful to
  // an authenticated fetch, and this profile is built to be handed onward.
  return { present: true, fileName: value.fileName, contentType: value.contentType };
}

/**
 * Reads a CHC intake submission into a starter profile, or null when the
 * submission is not one.
 *
 * Shape is decided from the TEMPLATE's fields rather than the answers: an
 * optional answer may legitimately be absent, but the field ids the form is
 * built from are always there. A non-intake form returns null so the caller can
 * skip the row rather than assemble a profile out of unrelated answers.
 */
export function readStarterProfile(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
): StarterProfile | null {
  const ids = new Set(fields.map((f) => f.id));
  if (!REQUIRED_SHAPE.every((id) => ids.has(id))) return null;

  const department = text(values, CHC_FIELD_IDS.department);
  const roleFieldId = CHC_ROLE_FIELD_BY_DEPARTMENT[department];
  const roleValue = roleFieldId ? values[roleFieldId] : undefined;
  const roles = Array.isArray(roleValue)
    ? roleValue.filter((r): r is string => typeof r === 'string')
    : typeof roleValue === 'string' && roleValue
      ? [roleValue]
      : [];

  const firstName = text(values, CHC_FIELD_IDS.firstName);
  const lastName = text(values, CHC_FIELD_IDS.lastName);

  return {
    firstName,
    middleName: text(values, CHC_FIELD_IDS.middleName),
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    gender: text(values, CHC_FIELD_IDS.gender),
    indigenous: tribool(values, CHC_FIELD_IDS.indigenous),
    starterType: text(values, CHC_FIELD_IDS.starterType),
    inductionDate: text(values, CHC_FIELD_IDS.inductionDate),
    department,
    roles,
    inBeakon: tribool(values, CHC_FIELD_IDS.inBeakon),
    mobile: text(values, CHC_FIELD_IDS.mobile),
    email: text(values, CHC_FIELD_IDS.email),
    photo: document(values, CHC_FIELD_IDS.photo),
    driversLicence: document(values, CHC_FIELD_IDS.driversLicence),
    sensitive: {
      dob: text(values, CHC_FIELD_IDS.dob),
      addressStreet: text(values, CHC_FIELD_IDS.addressStreet),
      suburb: text(values, CHC_FIELD_IDS.suburb),
      postcode: text(values, CHC_FIELD_IDS.postcode),
      emergencyContactName: text(values, CHC_FIELD_IDS.emergencyContactName),
      emergencyContactPhone: text(values, CHC_FIELD_IDS.emergencyContactPhone),
      licenceClass: text(values, CHC_FIELD_IDS.licenceClass),
      licenceExpiry: text(values, CHC_FIELD_IDS.licenceExpiry),
      licenceNumber: text(values, CHC_FIELD_IDS.licenceNumber),
    },
  };
}

/**
 * Whether this starter can be registered as they stand, and if not, why.
 *
 * Contact and document checks apply only when the starter is NOT already in
 * Beakon. For an in-Beakon starter the form never showed those fields — their
 * details come from the BISTrainer account the registration typeahead resolves
 * — so demanding them here would block every transfer for a reason the form
 * cannot fix. An unanswered Beakon question is treated as "not in Beakon",
 * which errs toward asking for detail rather than assuming it exists elsewhere.
 *
 * `allowLateNotice` is the operator's override of the Thursday cutoff, and it
 * is deliberately narrow. A booking made after the cutoff misses the Friday
 * swipe-card run, which the site can agree to work around. A day the site does
 * not run an induction on is a different thing entirely — no amount of
 * authority makes one appear — so the override moves `date_notice_lapsed` from
 * blocker to `notice_overridden` warning and leaves `date_invalid` exactly
 * where it is. The warning is never dropped: the point is that the exception
 * stays visible to whoever reads the record later.
 */
export function assessInductionReadiness(
  profile: StarterProfile,
  options: { today?: Date; alreadyBooked?: boolean; allowLateNotice?: boolean } = {},
): InductionVerdict {
  const today = options.today ?? new Date();
  const blockers: InductionBlocker[] = [];
  const warnings: InductionWarning[] = [];

  if (profile.inBeakon !== true) {
    if (!profile.mobile || !profile.email) blockers.push('contact_missing');
    if (!profile.photo.present || !profile.driversLicence.present) blockers.push('identity_missing');
  }

  const iso = profile.inductionDate;
  if (!isIsoDate(iso) || !isInductionDay(iso)) {
    blockers.push('date_invalid');
  } else if (!withinBookingWindow(iso, today)) {
    if (options.allowLateNotice) warnings.push('notice_overridden');
    else blockers.push('date_notice_lapsed');
  }

  // Past the last listed holiday the notice count silently treats holidays as
  // working days, so the date can only be reported as provisional.
  if (isIsoDate(iso) && iso > holidaysCoverThrough()) warnings.push('holiday_list_expired');

  if (options.alreadyBooked) blockers.push('already_booked');

  return { readiness: blockers.length === 0 ? 'ready' : 'blocked', blockers, warnings };
}

/**
 * Groups assessed starters into one cohort per induction date.
 *
 * Seats count READY starters only. Blocked starters stay listed on their
 * cohort — the person doing the booking needs to see that two of the five
 * requests for a Monday cannot go ahead, not just that three can. A starter
 * with no usable date has no cohort to belong to and is left out entirely.
 */
export function buildInductionCohorts(starters: AssessedStarter[]): InductionCohort[] {
  const byDate = new Map<string, AssessedStarter[]>();
  for (const starter of starters) {
    const date = starter.profile.inductionDate;
    if (!isIsoDate(date)) continue;
    const bucket = byDate.get(date);
    if (bucket) bucket.push(starter);
    else byDate.set(date, [starter]);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, cohortStarters]) => {
      const readyCount = cohortStarters.filter((s) => s.readiness === 'ready').length;
      return {
        date,
        seats: readyCount,
        readyCount,
        blockedCount: cohortStarters.length - readyCount,
        starters: cohortStarters,
      };
    });
}
