import { describe, expect, it } from 'vitest';
import {
  CHC_FIELD_IDS,
  CHC_MIN_NOTICE_BUSINESS_DAYS,
  businessDaysUntil,
  chcIntakeFields,
  isMonday,
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
  it('accepts a Monday with enough clear notice', () => {
    expect(validateInductionDate('2026-06-22', MONDAY_2026_06_08)).toBeNull();
  });

  it('rejects any day that is not a Monday', () => {
    // 2026-06-23 is the Tuesday after — far enough out that only the weekday fails.
    expect(validateInductionDate('2026-06-23', MONDAY_2026_06_08)).toBe('Must be a Monday');
    expect(isMonday('2026-06-22')).toBe(true);
    expect(isMonday('2026-06-23')).toBe(false);
  });

  it('reports the weekday problem BEFORE the notice problem', () => {
    // A Tuesday that is also too soon: being told "must be a Monday" first is
    // what stops someone hunting for a date four days out that still fails.
    expect(validateInductionDate('2026-06-09', MONDAY_2026_06_08)).toBe('Must be a Monday');
  });

  it('rejects a Monday inside the notice window', () => {
    // 2026-06-15 is the very next Monday — 4 clear business days would be
    // Thu 11th, so a Monday one week out is exactly on the boundary.
    expect(businessDaysUntil('2026-06-15', MONDAY_2026_06_08)).toBe(5);
    expect(validateInductionDate('2026-06-15', MONDAY_2026_06_08)).toBeNull();

    // From Thursday, the following Monday is only 2 clear business days away.
    const thursday = new Date('2026-06-11T09:00:00');
    expect(businessDaysUntil('2026-06-15', thursday)).toBe(2);
    expect(validateInductionDate('2026-06-15', thursday)).toBe(
      `Must be at least ${CHC_MIN_NOTICE_BUSINESS_DAYS} business days from today`,
    );
  });

  it('excludes weekends from the business-day count', () => {
    // Mon 8th → Fri 12th is 4 working days; the weekend adds nothing.
    expect(businessDaysUntil('2026-06-12', MONDAY_2026_06_08)).toBe(4);
    expect(businessDaysUntil('2026-06-14', MONDAY_2026_06_08)).toBe(4);
  });

  it('excludes listed public holidays from the count', () => {
    // WA Day is Mon 2026-06-01. Counting from Thu 2026-05-28, the Monday is a
    // holiday, so the days to Wed 3rd are Fri, Tue, Wed — three, not four.
    const thursday = new Date('2026-05-28T09:00:00');
    expect(businessDaysUntil('2026-06-03', thursday)).toBe(3);
  });

  it('refuses a Monday that is itself a public holiday', () => {
    expect(validateInductionDate('2026-06-01', new Date('2026-05-01T09:00:00'))).toBe(
      'That Monday is a public holiday — choose another',
    );
  });

  it('treats the request day itself as not counting', () => {
    // Same-day is zero clear business days, however early in the morning it is.
    expect(businessDaysUntil('2026-06-08', MONDAY_2026_06_08)).toBe(0);
  });

  it('counts a past date as zero rather than going negative', () => {
    expect(businessDaysUntil('2026-05-01', MONDAY_2026_06_08)).toBe(0);
  });

  it('rejects an empty or malformed date', () => {
    expect(validateInductionDate('', MONDAY_2026_06_08)).toBe('Required');
    expect(validateInductionDate('not-a-date', MONDAY_2026_06_08)).toBe('Enter a valid date');
  });

  it('proposes a next bookable date that the rule itself accepts', () => {
    const next = nextBookableInductionDate(MONDAY_2026_06_08);
    expect(isMonday(next)).toBe(true);
    expect(validateInductionDate(next, MONDAY_2026_06_08)).toBeNull();
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
