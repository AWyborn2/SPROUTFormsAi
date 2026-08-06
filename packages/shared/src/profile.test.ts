import { describe, expect, it } from 'vitest';
import {
  PROFILE_ETHNICITIES,
  PROFILE_FIELDS,
  PROFILE_GENDERS,
  PROFILE_STARTER_TYPES,
  candidateEditableFieldKeys,
  canEditProfileField,
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

describe('one list rather than two', () => {
  it('shares its demographic value sets with the intake form', () => {
    // The intake reads these same lists, so a value valid on the form is valid
    // on the profile and a seeded answer needs no translation.
    expect(PROFILE_GENDERS).toBe(CHC_GENDERS);
    expect(PROFILE_ETHNICITIES).toBe(CHC_ETHNICITIES);
    expect(PROFILE_STARTER_TYPES).toBe(CHC_STARTER_TYPES);
  });
});
