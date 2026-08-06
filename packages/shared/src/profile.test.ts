import { describe, expect, it } from 'vitest';
import {
  PROFILE_ETHNICITIES,
  PROFILE_FIELDS,
  PROFILE_GENDERS,
  PROFILE_STARTER_TYPES,
  candidateEditableFieldKeys,
  canEditProfileField,
  displayIdentityOf,
  displayLabelOf,
  displayNameOf,
  emptyOptionalProfileFields,
  indigenousStatusOf,
  profileField,
  requiredProfileFieldKeys,
  sensitiveProfileFieldKeys,
  validateProfileFields,
} from './profile.js';
import { CHC_ETHNICITIES, CHC_GENDERS, CHC_STARTER_TYPES } from './chc-intake.js';

/** Every required profile-stored field, answered. The baseline each case varies. */
function completeProfile(overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Jane',
    lastName: 'Smith',
    gender: 'Female',
    ethnicity: 'Caucasian',
    dateOfBirth: '1990-04-17',
    addressStreet: '12 Mill Road',
    suburb: 'Boddington',
    postcode: '6390',
    mobile: '0400 000 000',
    emergencyContactName: 'Chris Smith',
    emergencyContactPhone: '0400 111 111',
    starterType: 'New starter',
    ...overrides,
  };
}

describe('the field inventory', () => {
  it('creates a profile carrying every required field and no optional one', () => {
    expect(validateProfileFields(completeProfile())).toEqual({ ok: true });
  });

  it('refuses a profile missing a required field, naming the field', () => {
    const result = validateProfileFields(completeProfile({ dateOfBirth: '' }));
    expect(result).toEqual({ ok: false, failures: [{ key: 'dateOfBirth', reason: 'missing' }] });
  });

  it('treats whitespace as missing rather than as an answer', () => {
    const result = validateProfileFields(completeProfile({ firstName: '   ' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failures).toContainEqual({ key: 'firstName', reason: 'missing' });
  });

  it('creates a profile with no middle name and no induction date, and reports neither as outstanding', () => {
    // AE49: a worker hired today with none of the four optional fields.
    const values = completeProfile();
    expect(validateProfileFields(values)).toEqual({ ok: true });
    expect(requiredProfileFieldKeys()).not.toContain('middleName');
    expect(requiredProfileFieldKeys()).not.toContain('inductionDate');
  });

  it('reports the optional fields a landed row left empty, and no required one', () => {
    // R19: an import row that lands incomplete is flagged naming what it left empty.
    const empty = emptyOptionalProfileFields(completeProfile());
    expect(empty).toContain('middleName');
    expect(empty).toContain('inductionDate');
    expect(empty).not.toContain('dateOfBirth');
  });

  it('refuses a value outside a closed option set', () => {
    const result = validateProfileFields(completeProfile({ gender: 'Other' }));
    expect(result).toEqual({ ok: false, failures: [{ key: 'gender', reason: 'not_an_option', value: 'Other' }] });
  });

  it('validates only what this record stores, leaving the email and the placement to their own writers', () => {
    // The email is on `users` and the placement on the membership; validating
    // them here would be a second implementation of a rule that already has one.
    expect(validateProfileFields(completeProfile())).toEqual({ ok: true });
    expect(profileField('email')?.storedOn).toBe('user');
    expect(profileField('location')?.storedOn).toBe('membership');
    expect(requiredProfileFieldKeys('profile')).not.toContain('email');
  });
});

describe('a declined demographic answer', () => {
  it('counts Undisclosed and Unknown as answered, so neither required field is outstanding', () => {
    // AE4: a worker who would rather not state their gender or ethnicity.
    const result = validateProfileFields(completeProfile({ gender: 'Undisclosed', ethnicity: 'Unknown' }));
    expect(result).toEqual({ ok: true });
  });

  it('offers a decline value on both fields that require one', () => {
    expect(PROFILE_GENDERS).toContain('Undisclosed');
    expect(PROFILE_ETHNICITIES).toContain('Unknown');
  });
});

describe('Indigenous status, derived', () => {
  it('reads Aboriginal and Torres Strait Islander as Indigenous', () => {
    expect(indigenousStatusOf('Aboriginal')).toBe('indigenous');
    expect(indigenousStatusOf('Torres Strait Islander')).toBe('indigenous');
  });

  it('reads any other stated ethnicity as not Indigenous', () => {
    expect(indigenousStatusOf('Caucasian')).toBe('not_indigenous');
    expect(indigenousStatusOf('Chinese')).toBe('not_indigenous');
    expect(indigenousStatusOf('Others')).toBe('not_indigenous');
  });

  it('reads Unknown and an absent ethnicity as not stated, never as not Indigenous', () => {
    // R15: not stated must never be reported as a fact about the person.
    expect(indigenousStatusOf('Unknown')).toBe('not_stated');
    expect(indigenousStatusOf('')).toBe('not_stated');
    expect(indigenousStatusOf(null)).toBe('not_stated');
    expect(indigenousStatusOf(undefined)).toBe('not_stated');
  });

  it('is entered by nobody and stored nowhere', () => {
    const field = profileField('indigenousStatus');
    expect(field?.presence).toBe('derived');
    expect(field?.storedOn).toBe('derived');
    expect(field?.editableBy).toEqual([]);
  });
});

describe('the display name', () => {
  it('is the first and last name', () => {
    expect(displayNameOf({ firstName: 'Jane', lastName: 'Smith' })).toBe('Jane Smith');
  });

  it('excludes the middle name even when one is held', () => {
    // R3: the middle name does not help on a screen and takes no part.
    const withMiddle = { firstName: 'Jane', middleName: 'Alexandra', lastName: 'Smith' };
    expect(displayNameOf(withMiddle)).toBe('Jane Smith');
    expect(displayNameOf(withMiddle)).not.toContain('Alexandra');
  });

  it('is derived rather than stored', () => {
    expect(profileField('displayName')?.storedOn).toBe('derived');
  });
});

describe('sensitivity marks', () => {
  it('marks ethnicity, Indigenous status, date of birth and the address sensitive', () => {
    const sensitive = sensitiveProfileFieldKeys();
    expect(sensitive).toEqual(
      expect.arrayContaining(['ethnicity', 'indigenousStatus', 'dateOfBirth', 'addressStreet', 'suburb', 'postcode']),
    );
  });

  it('marks the emergency contact NOT sensitive, departing from the induction pattern', () => {
    // The induction redaction withholds both; a next-of-kin contact is what an
    // organisation needs to reach in the moment it matters.
    const sensitive = sensitiveProfileFieldKeys();
    expect(sensitive).not.toContain('emergencyContactName');
    expect(sensitive).not.toContain('emergencyContactPhone');
  });
});

describe("the candidate's writable set", () => {
  it('is their own mobile, address and emergency contact, and nothing else', () => {
    expect(candidateEditableFieldKeys().sort()).toEqual(
      ['addressStreet', 'emergencyContactName', 'emergencyContactPhone', 'mobile', 'postcode', 'suburb'].sort(),
    );
  });

  it('does not admit the candidate to the identifiers or the email', () => {
    // R53: the identifiers are the organisation's to issue and correct.
    // R16: the email is Admin's, which is why sign-in hangs off a username.
    expect(canEditProfileField('email', 'candidate')).toBe(false);
    expect(canEditProfileField('mobile', 'candidate')).toBe(true);
    expect(canEditProfileField('dateOfBirth', 'candidate')).toBe(false);
  });
});

describe('one record for every member', () => {
  it('carries the same inventory whatever access level the member holds', () => {
    // The inventory is not parameterised by access level: an assessor's and an
    // administrator's record is this one. Only `editableBy` names a candidate.
    const keys = PROFILE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(PROFILE_FIELDS.every((f) => f.editableBy.every((e) => e === 'admin' || e === 'candidate'))).toBe(true);
  });
});

describe('the display identity', () => {
  const CHRIS = { firstName: 'Chris', lastName: 'Taylor' };

  it('shows the name and the number the organisation chose', () => {
    const identity = displayIdentityOf({ ...CHRIS, employeeNumber: 'E100', swipeCardNumber: 'S900' }, 'employee_number');
    expect(identity).toEqual({
      displayName: 'Chris Taylor',
      identifier: 'E100',
      identifierKind: 'employee_number',
      fellBack: false,
    });
  });

  it('falls back to the number the member does hold rather than showing nothing', () => {
    // AE22: three members share a name; one holds only the swipe card number.
    const identity = displayIdentityOf({ ...CHRIS, employeeNumber: null, swipeCardNumber: 'S900' }, 'employee_number');
    expect(identity.identifier).toBe('S900');
    expect(identity.identifierKind).toBe('swipe_card_number');
    expect(identity.fellBack).toBe(true);
  });

  it('shows the name alone where the member holds neither', () => {
    const identity = displayIdentityOf({ ...CHRIS, employeeNumber: null, swipeCardNumber: null }, 'employee_number');
    expect(identity).toEqual({
      displayName: 'Chris Taylor',
      identifier: null,
      identifierKind: null,
      fellBack: false,
    });
  });

  it('treats a blank string as absent, not as an identifier', () => {
    const identity = displayIdentityOf({ ...CHRIS, employeeNumber: '   ', swipeCardNumber: 'S900' }, 'employee_number');
    expect(identity.identifier).toBe('S900');
  });

  it('follows the organisation setting when it names the swipe card number', () => {
    // AE23: the same member, shown by swipe card rather than employee number.
    const identity = displayIdentityOf({ ...CHRIS, employeeNumber: 'E100', swipeCardNumber: 'S900' }, 'swipe_card_number');
    expect(identity.identifier).toBe('S900');
    expect(identity.fellBack).toBe(false);
  });

  it('changes what a member is shown by when the setting changes, with no write to the profile', () => {
    const profile = { ...CHRIS, employeeNumber: 'E100', swipeCardNumber: 'S900' };
    expect(displayIdentityOf(profile, 'employee_number').identifier).toBe('E100');
    expect(displayIdentityOf(profile, 'swipe_card_number').identifier).toBe('S900');
    expect(profile).toEqual({ ...CHRIS, employeeNumber: 'E100', swipeCardNumber: 'S900' });
  });

  it('never puts the middle name on the display', () => {
    const identity = displayIdentityOf(
      { firstName: 'Chris', middleName: 'Alexandra', lastName: 'Taylor', employeeNumber: 'E100' } as never,
      'employee_number',
    );
    expect(identity.displayName).toBe('Chris Taylor');
  });

  it('renders a one-line label with and without an identifier', () => {
    expect(displayLabelOf({ ...CHRIS, employeeNumber: 'E100' }, 'employee_number')).toBe('Chris Taylor (E100)');
    expect(displayLabelOf(CHRIS, 'employee_number')).toBe('Chris Taylor');
  });

  it('leaves both identifiers optional, so neither absence is an outstanding field', () => {
    // R12/R24: a member holding neither is not on a follow-up list for it.
    expect(requiredProfileFieldKeys()).not.toContain('employeeNumber');
    expect(requiredProfileFieldKeys()).not.toContain('swipeCardNumber');
    expect(validateProfileFields(completeProfile())).toEqual({ ok: true });
  });

  it('keeps both identifiers out of the candidate writable set', () => {
    // AE2 / R53: the organisation issues and corrects them.
    expect(canEditProfileField('employeeNumber', 'candidate')).toBe(false);
    expect(canEditProfileField('swipeCardNumber', 'candidate')).toBe(false);
    expect(canEditProfileField('employeeNumber', 'admin')).toBe(true);
  });
});

describe('one list rather than two', () => {
  it('shares its demographic value sets with the intake form', () => {
    // The intake reads these same lists, so a value valid on the form is valid
    // on the profile and a seeded answer needs no translation.
    expect(PROFILE_GENDERS).toBe(CHC_GENDERS);
    expect(PROFILE_ETHNICITIES).toBe(CHC_ETHNICITIES);
    expect(PROFILE_STARTER_TYPES).toBe(CHC_STARTER_TYPES);
  });
});
