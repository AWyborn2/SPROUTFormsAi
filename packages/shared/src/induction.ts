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
  chcIntakeFields,
  isIndigenousEthnicity,
  bookingCutoffFor,
  holidaysCoverThrough,
  isInductionDay,
  resolveChcIntakeFields,
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
  /** As answered, in BISTrainer's own vocabulary — what its profile field wants. */
  ethnicity: string;
  /**
   * Derived from `ethnicity`, or read from the retired yes/no question on
   * submissions that predate it. Null when neither says — an unanswered
   * question and 'Unknown' are both genuinely "not stated", and reporting
   * either as `false` would invent a fact about a person.
   */
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
  /**
   * Canonical field ids for questions this submission's template version does
   * not ask at all, so an empty answer above can be read for what it is.
   *
   * "The form never asked" and "the starter left it blank" are different facts
   * with different remedies — the second can be chased up, the first cannot —
   * and an empty string tells them apart for nobody. A registration built from
   * a blank that was never collected records something about a person that was
   * never stated, which is the failure this list exists to prevent.
   */
  notCollected: string[];
}

/** Why a starter cannot be registered as they stand. */
export type InductionBlocker =
  | 'contact_missing'
  | 'identity_missing'
  | 'date_invalid'
  | 'date_notice_lapsed'
  | 'already_booked';

/** Something a human should know that does not stop the booking. */
export type InductionWarning = 'holiday_list_expired' | 'notice_overridden' | 'intake_incomplete';

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

/**
 * Field ids that must all be present for a template to be an intake form.
 *
 * `in_beakon` used to be in this set and had to come out: the form dropped that
 * question when every detail became mandatory, and a required id the template
 * no longer carries makes `readStarterProfile` return null for every new
 * submission — which the routes skip SILENTLY, so the whole intake would have
 * disappeared from the MCP with nothing logged anywhere. `department` replaces
 * it: mandatory on the form, and specific enough alongside an induction date
 * that no unrelated template matches by accident.
 *
 * Membership is tested against `resolveChcIntakeFields`, not raw ids, so a
 * `department` question re-created in the builder still satisfies the shape.
 * Same failure as `in_beakon`, reached from the other direction — and the same
 * reason it must not be able to happen quietly.
 */
const REQUIRED_SHAPE = [
  CHC_FIELD_IDS.firstName,
  CHC_FIELD_IDS.lastName,
  CHC_FIELD_IDS.inductionDate,
  CHC_FIELD_IDS.department,
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

function text(values: Record<string, SubmissionValue>, id: string | undefined): string {
  const value = id === undefined ? undefined : values[id];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function tribool(values: Record<string, SubmissionValue>, id: string | undefined): boolean | null {
  const value = id === undefined ? undefined : values[id];
  if (typeof value === 'boolean') return value;
  // `boolean_yes_no` normalises to the strings 'true'/'false' on some surfaces
  // (see `scalarAnswer` in visibility.ts), so both encodings arrive here.
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function document(values: Record<string, SubmissionValue>, id: string | undefined): StarterDocument {
  const value = id === undefined ? undefined : values[id];
  if (!isFileRef(value)) return { present: false };
  // The storage key is deliberately not carried through: it is only useful to
  // an authenticated fetch, and this profile is built to be handed onward.
  return { present: true, fileName: value.fileName, contentType: value.contentType };
}

/**
 * The questions whose absence from a template version is worth reporting.
 *
 * Read off the form definition rather than hand-listed, so a question added to
 * the intake is covered the day it lands. A second list here would be one more
 * place to forget, and forgetting is what this whole list exists to catch.
 *
 * Two exclusions. Section headers carry no answer. Role fields are conditional
 * — three of the four are absent by design on any given submission — so the one
 * that applies is added back below, once the department says which that is.
 *
 * The retired pair (`indigenous`, `in_beakon`) is absent for free: the current
 * form does not ask them, so they are not in `chcIntakeFields()` to begin with.
 * Listing them would put a permanent complaint on every submission since.
 */
const ROLE_QUESTIONS = new Set(Object.values(CHC_ROLE_FIELD_BY_DEPARTMENT));
const REPORTED_QUESTIONS: readonly string[] = chcIntakeFields()
  .filter((f) => f.type !== 'section_header' && !ROLE_QUESTIONS.has(f.id))
  .map((f) => f.id);

/**
 * Reads a CHC intake submission into a starter profile, or null when the
 * submission is not one.
 *
 * Shape is decided from the TEMPLATE's fields rather than the answers: an
 * optional answer may legitimately be absent, but the field ids the form is
 * built from are always there. A non-intake form returns null so the caller can
 * skip the row rather than assemble a profile out of unrelated answers.
 *
 * Every id goes through `resolveChcIntakeFields` rather than being read
 * straight off `values`. The intake is an EDITABLE template, so a question an
 * administrator re-created in the builder carries a generated id, and reading
 * by preset id alone reported its answer as blank. `department` is the sharpest
 * case, being both resolvable and part of REQUIRED_SHAPE: re-created, it used
 * to fail detection outright, and the routes skip an undetected submission
 * SILENTLY — so the starter left every induction surface without a word.
 */
export function readStarterProfile(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
): StarterProfile | null {
  const at = resolveChcIntakeFields(fields);
  if (!REQUIRED_SHAPE.every((id) => at.has(id))) return null;

  const department = text(values, at.get(CHC_FIELD_IDS.department));
  const roleQuestion = CHC_ROLE_FIELD_BY_DEPARTMENT[department];
  const roleFieldId = roleQuestion ? at.get(roleQuestion) : undefined;
  const roleValue = roleFieldId ? values[roleFieldId] : undefined;
  const roles = Array.isArray(roleValue)
    ? roleValue.filter((r): r is string => typeof r === 'string')
    : typeof roleValue === 'string' && roleValue
      ? [roleValue]
      : [];

  const firstName = text(values, at.get(CHC_FIELD_IDS.firstName));
  const lastName = text(values, at.get(CHC_FIELD_IDS.lastName));
  const ethnicity = text(values, at.get(CHC_FIELD_IDS.ethnicity));

  // The role question counts only once a department has named which one applies
  // — before that, "no role field" is the form working as designed.
  const expected = department
    ? [...REPORTED_QUESTIONS, CHC_ROLE_FIELD_BY_DEPARTMENT[department]].filter(
        (id): id is string => !!id,
      )
    : REPORTED_QUESTIONS;

  return {
    firstName,
    middleName: text(values, at.get(CHC_FIELD_IDS.middleName)),
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    gender: text(values, at.get(CHC_FIELD_IDS.gender)),
    ethnicity,
    // The two RETIRED questions read straight off `values`, never through the
    // resolver. No current template declares them, so resolving would find
    // nothing and report every pre-#80 submission as unanswered — which is the
    // fallback's whole purpose defeated. Their ids were never reassigned, so
    // the raw key is unambiguous.
    indigenous: ethnicity
      ? isIndigenousEthnicity(ethnicity)
      : tribool(values, CHC_FIELD_IDS.indigenous),
    starterType: text(values, at.get(CHC_FIELD_IDS.starterType)),
    inductionDate: text(values, at.get(CHC_FIELD_IDS.inductionDate)),
    department,
    roles,
    inBeakon: tribool(values, CHC_FIELD_IDS.inBeakon),
    mobile: text(values, at.get(CHC_FIELD_IDS.mobile)),
    email: text(values, at.get(CHC_FIELD_IDS.email)),
    photo: document(values, at.get(CHC_FIELD_IDS.photo)),
    driversLicence: document(values, at.get(CHC_FIELD_IDS.driversLicence)),
    sensitive: {
      dob: text(values, at.get(CHC_FIELD_IDS.dob)),
      addressStreet: text(values, at.get(CHC_FIELD_IDS.addressStreet)),
      suburb: text(values, at.get(CHC_FIELD_IDS.suburb)),
      postcode: text(values, at.get(CHC_FIELD_IDS.postcode)),
      emergencyContactName: text(values, at.get(CHC_FIELD_IDS.emergencyContactName)),
      emergencyContactPhone: text(values, at.get(CHC_FIELD_IDS.emergencyContactPhone)),
      licenceClass: text(values, at.get(CHC_FIELD_IDS.licenceClass)),
      licenceExpiry: text(values, at.get(CHC_FIELD_IDS.licenceExpiry)),
      licenceNumber: text(values, at.get(CHC_FIELD_IDS.licenceNumber)),
    },
    notCollected: expected.filter((id) => !at.has(id)),
  };
}

/**
 * Whether this starter can be registered as they stand, and if not, why.
 *
 * Contact and document checks apply to every starter the current form produces,
 * because it now collects those details unconditionally. The `inBeakon` test
 * survives for one reason: submissions raised before that question was retired
 * legitimately have no contact or document answers, because the form hid those
 * fields from anyone already in Beakon. Demanding them retrospectively would
 * block old transfers for a reason nobody can now fix.
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

  // A warning rather than a blocker, because the two are different jobs: a SEAT
  // can be booked for someone whose form never asked their ethnicity, but the
  // REGISTRATION that follows cannot be built from an answer nobody gave. What
  // stopped this being visible is that the gap arrived as an empty string, so
  // the profile read as complete — see `StarterProfile.notCollected`.
  if (profile.notCollected.length > 0) warnings.push('intake_incomplete');

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
