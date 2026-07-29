import { describe, expect, it } from 'vitest';
import {
  CHC_FIELD_IDS,
  bookingCutoffFor,
  chcIntakeFields,
  isInductionDay,
  isMonday,
  isPublicHoliday,
  withinBookingWindow,
  nextBookableInductionDate,
  validateInductionDate,
  visibleFields,
} from '@formai/shared';
import type { SubmissionValue } from '@formai/shared';
import {
  chcSubmissionValues,
  emptyChcIntakeState,
  validateChcIntake,
  type ChcIntakeState,
} from './chc-intake-form.js';

/**
 * A fixed "today" so the notice rule is deterministic. Monday 2026-06-08 —
 * chosen inside the 2026 holiday list's coverage, and clear of it, so the
 * ordinary arithmetic is exercised without a holiday adjacent by accident.
 */
const MONDAY_2026_06_08 = new Date('2026-06-08T09:00:00');

/** A state that passes everything, so each test can break exactly one thing. */
function validState(over: Partial<ChcIntakeState> = {}): ChcIntakeState {
  return {
    ...emptyChcIntakeState(),
    first_name: 'Rebecca',
    last_name: 'Hsu',
    gender: 'Female',
    indigenous: 'No',
    starter_type: 'New starter',
    // 2 clear weeks out, a Monday, no holiday in between.
    induction_date: '2026-06-22',
    department: 'Maintenance',
    role: ['Tyre Fitter'],
    in_beakon: 'Yes',
    ...over,
  };
}

/** The Beakon-conditional block filled in, for the `in_beakon: 'No'` path. */
function beakonNoState(over: Partial<ChcIntakeState> = {}): ChcIntakeState {
  return validState({
    in_beakon: 'No',
    mobile: '0412 345 678',
    email: 'rebecca@example.com',
    dob: '1994-03-11',
    address_street: '12 Forrest Ave',
    suburb: 'Boddington',
    postcode: '6390',
    emergency_contact_name: 'Sam Hsu',
    emergency_contact_phone: '0499 111 222',
    licence_class: 'HR',
    licence_expiry: '2030-01-01',
    licence_number: 'WA1234567',
    photo: { kind: 'file', key: 'org-1/upload-a.jpg', fileName: 'me.jpg', contentType: 'image/jpeg', size: 1024 },
    drivers_licence: { kind: 'file', key: 'org-1/upload-b.jpg', fileName: 'lic.jpg', contentType: 'image/jpeg', size: 2048 },
    ...over,
  });
}

describe('induction date rule', () => {
  it('accepts a Monday inside the booking window', () => {
    expect(validateInductionDate('2026-06-22', MONDAY_2026_06_08)).toBeNull();
  });

  it('rejects a day the site does not run inductions on', () => {
    expect(validateInductionDate('2026-06-23', MONDAY_2026_06_08)).toBe(
      'Must be a Monday (or the Tuesday after a public-holiday Monday)',
    );
    expect(isMonday('2026-06-22')).toBe(true);
    expect(isMonday('2026-06-23')).toBe(false);
  });

  it('accepts the Tuesday when the Monday is a public holiday', () => {
    // Reconciliation Day falls on Mon 1 Jun 2026, so that week's induction runs
    // on the Tuesday. Refusing it would strand every starter in that week.
    expect(isInductionDay('2026-06-02')).toBe(true);
    expect(validateInductionDate('2026-06-02', new Date('2026-05-01T09:00:00'))).toBeNull();
  });

  it('does not accept a Tuesday in an ordinary week', () => {
    expect(isInductionDay('2026-06-23')).toBe(false);
  });

  it('points a holiday Monday at the Tuesday rather than just refusing it', () => {
    expect(validateInductionDate('2026-06-01', new Date('2026-05-01T09:00:00'))).toBe(
      'That Monday is a public holiday — book the Tuesday instead',
    );
  });

  it('books right up to the Thursday before, and no further', () => {
    // The runbook is explicit that short notice is not a reason to refuse.
    expect(bookingCutoffFor('2026-06-15')).toBe('2026-06-11');

    const thursday = new Date('2026-06-11T09:00:00');
    expect(validateInductionDate('2026-06-15', thursday)).toBeNull();

    const friday = new Date('2026-06-12T09:00:00');
    expect(validateInductionDate('2026-06-15', friday)).toBe(
      'Bookings for that date closed on Thursday 11/06/2026',
    );
  });

  it('measures the cutoff from the induction day, so a Tuesday uses the prior Thursday', () => {
    // Tue 2 Jun 2026 (holiday-Monday week) — the Thursday before is 28 May.
    expect(bookingCutoffFor('2026-06-02')).toBe('2026-05-28');
    expect(withinBookingWindow('2026-06-02', new Date('2026-05-28T09:00:00'))).toBe(true);
    expect(withinBookingWindow('2026-06-02', new Date('2026-05-29T09:00:00'))).toBe(false);
  });

  it('carries every holiday the runbook lists', () => {
    // Two weekday holidays were previously missing, which quietly skewed the
    // old business-day count. The list is now the runbook's table verbatim.
    for (const iso of ['2026-01-01', '2026-01-26', '2026-03-02', '2026-04-06', '2026-04-27',
                       '2026-06-01', '2026-09-28', '2026-12-25', '2026-12-28']) {
      expect(isPublicHoliday(iso)).toBe(true);
    }
  });

  it('rejects an empty or malformed date', () => {
    expect(validateInductionDate('', MONDAY_2026_06_08)).toBe('Required');
    expect(validateInductionDate('not-a-date', MONDAY_2026_06_08)).toBe('Enter a valid date');
    expect(bookingCutoffFor('not-a-date')).toBeNull();
  });

  it('proposes a next bookable date that the rule itself accepts', () => {
    const next = nextBookableInductionDate(MONDAY_2026_06_08);
    expect(isInductionDay(next)).toBe(true);
    expect(validateInductionDate(next, MONDAY_2026_06_08)).toBeNull();
  });

  it('offers the holiday-week Tuesday when walking forward past it', () => {
    // Walking from mid-May, the run of dates must include Tue 2 Jun and never
    // Mon 1 Jun — the week is not skipped.
    const seen: string[] = [];
    let cursor = new Date('2026-05-11T09:00:00');
    for (let i = 0; i < 5; i++) {
      const iso = nextBookableInductionDate(cursor);
      seen.push(iso);
      cursor = new Date(`${iso}T09:00:00`);
    }
    expect(seen).toContain('2026-06-02');
    expect(seen).not.toContain('2026-06-01');
  });
});

describe('validateChcIntake', () => {
  it('passes a complete Beakon-yes submission', () => {
    expect(validateChcIntake(validState(), MONDAY_2026_06_08)).toEqual({});
  });

  it('passes a complete Beakon-no submission', () => {
    expect(validateChcIntake(beakonNoState(), MONDAY_2026_06_08)).toEqual({});
  });

  it('does not require the Beakon block when the starter IS in Beakon', () => {
    // The whole conditional section is empty here and that is correct — the
    // same rule the platform applies to a hidden required field.
    const errors = validateChcIntake(validState({ in_beakon: 'Yes' }), MONDAY_2026_06_08);
    expect(errors.mobile).toBeUndefined();
    expect(errors.photo).toBeUndefined();
    expect(errors.drivers_licence).toBeUndefined();
  });

  it('requires the Beakon block when the starter is NOT in Beakon', () => {
    const errors = validateChcIntake(validState({ in_beakon: 'No' }), MONDAY_2026_06_08);
    expect(errors.mobile).toBe('Required');
    expect(errors.photo).toBe('Required');
    expect(errors.drivers_licence).toBe('Required');
  });

  it('distinguishes an unanswered Yes/No from an answered No', () => {
    const errors = validateChcIntake(validState({ indigenous: '' }), MONDAY_2026_06_08);
    expect(errors.indigenous).toBe('Please select');
    expect(validateChcIntake(validState({ indigenous: 'No' }), MONDAY_2026_06_08).indigenous)
      .toBeUndefined();
  });

  it('rejects a role that the chosen department does not offer', () => {
    // The stale-selection case: pick Operations, tick a role, switch to Admin.
    const errors = validateChcIntake(
      validState({ department: 'Admin', role: ['Haul Truck Operator'] }),
      MONDAY_2026_06_08,
    );
    expect(errors.role).toBe('Select a role for the chosen department');
  });

  it('allows more than one role for Operations only', () => {
    const ops = validateChcIntake(
      validState({ department: 'Operations', role: ['Dozer Operator', 'Grader Operator'] }),
      MONDAY_2026_06_08,
    );
    expect(ops.role).toBeUndefined();
  });

  it('rejects an expired licence', () => {
    const errors = validateChcIntake(
      beakonNoState({ licence_expiry: '2026-01-01' }),
      MONDAY_2026_06_08,
    );
    expect(errors.licence_expiry).toBe('Licence has expired');
  });

  it('rejects a date of birth that is not in the past', () => {
    const errors = validateChcIntake(beakonNoState({ dob: '2026-06-08' }), MONDAY_2026_06_08);
    expect(errors.dob).toBe('Date of birth must be in the past');
  });

  it('rejects a malformed postcode, phone, and email', () => {
    const errors = validateChcIntake(
      beakonNoState({ postcode: '63', mobile: 'call me', email: 'nope' }),
      MONDAY_2026_06_08,
    );
    expect(errors.postcode).toBe('Enter a 4-digit postcode');
    expect(errors.mobile).toBe('Enter a valid phone number');
    expect(errors.email).toBe('Enter a valid email address');
  });
});

describe('chcSubmissionValues', () => {
  it('maps onto the template field ids', () => {
    const values = chcSubmissionValues(validState());
    expect(values[CHC_FIELD_IDS.firstName]).toBe('Rebecca');
    expect(values[CHC_FIELD_IDS.lastName]).toBe('Hsu');
    expect(values[CHC_FIELD_IDS.department]).toBe('Maintenance');
    // Yes/No answers become the booleans `boolean_yes_no` stores.
    expect(values[CHC_FIELD_IDS.indigenous]).toBe(false);
    expect(values[CHC_FIELD_IDS.inBeakon]).toBe(true);
  });

  it('answers only the chosen department’s role field', () => {
    const values = chcSubmissionValues(validState({ department: 'Admin', role: ['General Office'] }));
    expect(values[CHC_FIELD_IDS.roleAdmin]).toBe('General Office');
    expect(CHC_FIELD_IDS.roleOperations in values).toBe(false);
    expect(CHC_FIELD_IDS.roleMaintenance in values).toBe(false);
    expect(CHC_FIELD_IDS.roleOffSiteSupport in values).toBe(false);
  });

  it('sends Operations roles as an array and single-role departments as a string', () => {
    const ops = chcSubmissionValues(
      validState({ department: 'Operations', role: ['Dozer Operator', 'Grader Operator'] }),
    );
    expect(ops[CHC_FIELD_IDS.roleOperations]).toEqual(['Dozer Operator', 'Grader Operator']);

    const admin = chcSubmissionValues(validState({ department: 'Admin', role: ['General Office'] }));
    expect(typeof admin[CHC_FIELD_IDS.roleAdmin]).toBe('string');
  });

  it('omits the Beakon block entirely when it was never shown', () => {
    const values = chcSubmissionValues(validState({ in_beakon: 'Yes' }));
    expect(CHC_FIELD_IDS.mobile in values).toBe(false);
    expect(CHC_FIELD_IDS.photo in values).toBe(false);
  });

  it('carries file refs through as objects, not filenames', () => {
    const values = chcSubmissionValues(beakonNoState());
    expect(values[CHC_FIELD_IDS.photo]).toMatchObject({
      kind: 'file',
      key: 'org-1/upload-a.jpg',
    });
  });
});

describe('the screen and the template agree', () => {
  const fields = chcIntakeFields();

  it('every submitted value targets a real template field', () => {
    const ids = new Set(fields.map((f) => f.id));
    for (const state of [validState(), beakonNoState()]) {
      for (const key of Object.keys(chcSubmissionValues(state))) {
        expect(ids.has(key), `${key} is not a field in the template`).toBe(true);
      }
    }
  });

  it('the template hides the Additional Details section when in Beakon', () => {
    const values = chcSubmissionValues(validState({ in_beakon: 'Yes' })) as Record<
      string,
      SubmissionValue
    >;
    const visibleIds = new Set(visibleFields(fields, values).map((f) => f.id));
    expect(visibleIds.has(CHC_FIELD_IDS.mobile)).toBe(false);
    expect(visibleIds.has(CHC_FIELD_IDS.photo)).toBe(false);
    // The question that drives it stays visible.
    expect(visibleIds.has(CHC_FIELD_IDS.inBeakon)).toBe(true);
  });

  it('the template reveals the Additional Details section when NOT in Beakon', () => {
    const values = chcSubmissionValues(beakonNoState()) as Record<string, SubmissionValue>;
    const visibleIds = new Set(visibleFields(fields, values).map((f) => f.id));
    expect(visibleIds.has(CHC_FIELD_IDS.mobile)).toBe(true);
    expect(visibleIds.has(CHC_FIELD_IDS.photo)).toBe(true);
    expect(visibleIds.has(CHC_FIELD_IDS.driversLicence)).toBe(true);
  });

  it('shows only the chosen department’s role field', () => {
    const values = chcSubmissionValues(
      validState({ department: 'Operations', role: ['Dozer Operator'] }),
    ) as Record<string, SubmissionValue>;
    const visibleIds = new Set(visibleFields(fields, values).map((f) => f.id));
    expect(visibleIds.has(CHC_FIELD_IDS.roleOperations)).toBe(true);
    expect(visibleIds.has(CHC_FIELD_IDS.roleMaintenance)).toBe(false);
    expect(visibleIds.has(CHC_FIELD_IDS.roleAdmin)).toBe(false);
    expect(visibleIds.has(CHC_FIELD_IDS.roleOffSiteSupport)).toBe(false);
  });

  it('every field id in the template is unique', () => {
    const ids = fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every visibility condition points at a field that exists', () => {
    const ids = new Set(fields.map((f) => f.id));
    for (const f of fields) {
      if (f.visibleWhen) expect(ids.has(f.visibleWhen.fieldId)).toBe(true);
    }
  });
});
