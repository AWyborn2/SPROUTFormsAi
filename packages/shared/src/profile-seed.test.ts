import { describe, expect, it } from 'vitest';
import type { StarterProfile } from './induction.js';
import { PROFILE_ETHNICITIES, PROFILE_GENDERS, requiredProfileFieldKeys } from './profile.js';
import { dispositionForSubmission, seedProfileFromStarter } from './profile-seed.js';

const EMPTY_DOC = { supplied: false } as unknown as StarterProfile['photo'];

function starter(over: Partial<StarterProfile> = {}): StarterProfile {
  return {
    firstName: 'Jane',
    middleName: 'Alexandra',
    lastName: 'Smith',
    fullName: 'Jane Smith',
    gender: PROFILE_GENDERS[0]!,
    ethnicity: PROFILE_ETHNICITIES[0]!,
    indigenous: null,
    starterType: 'New starter',
    inductionDate: '2026-08-10',
    department: 'Operations',
    roles: ['Dozer Operator'],
    inBeakon: null,
    mobile: '0400 000 000',
    email: 'jane@x.io',
    photo: EMPTY_DOC,
    driversLicence: EMPTY_DOC,
    sensitive: {
      dob: '1990-04-17',
      addressStreet: '12 Mill Road',
      suburb: 'Boddington',
      postcode: '6390',
      emergencyContactName: 'Chris Smith',
      emergencyContactPhone: '0400 111 111',
      licenceClass: 'HR',
      licenceExpiry: '2028-01-01',
      licenceNumber: 'L123',
    },
    ...over,
  } as StarterProfile;
}

describe('seedProfileFromStarter (R87, R88)', () => {
  it('maps the submission onto the inventory keys', () => {
    const seed = seedProfileFromStarter(starter());
    expect(seed.fields).toMatchObject({
      firstName: 'Jane',
      middleName: 'Alexandra',
      lastName: 'Smith',
      dateOfBirth: '1990-04-17',
      addressStreet: '12 Mill Road',
      suburb: 'Boddington',
      postcode: '6390',
      mobile: '0400 000 000',
      emergencyContactName: 'Chris Smith',
      emergencyContactPhone: '0400 111 111',
      starterType: 'New starter',
      inductionDate: '2026-08-10',
    });
    expect(seed.department).toBe('Operations');
    expect(seed.roles).toEqual(['Dozer Operator']);
  });

  it('fills every required profile-stored field a submission can answer', () => {
    /*
      The point of seeding is that an Admin does not type the record again. If a
      required field the intake DOES collect were left out of the mapping, the
      seeded record would refuse to save and the whole flow would be worse than
      typing it — so this asserts the coverage rather than any one key.
    */
    const seed = seedProfileFromStarter(starter());
    const required = requiredProfileFieldKeys('profile');
    for (const key of required) {
      expect(Object.keys(seed.fields)).toContain(key);
    }
  });

  it('DERIVES Indigenous status rather than mapping it (R15)', () => {
    // A mapped copy could disagree with the derivation every other reader uses.
    const aboriginal = seedProfileFromStarter(starter({ ethnicity: 'Aboriginal' }));
    expect(aboriginal.indigenousStatus).toBe('indigenous');
    expect(aboriginal.fields).not.toHaveProperty('indigenousStatus');
  });

  it('carries NO document, because the bytes were never kept (R91)', () => {
    // A submission holds only a marker that a file was supplied. Attaching one
    // would record evidence nobody actually holds.
    const seed = seedProfileFromStarter(starter());
    expect(seed.fields).not.toHaveProperty('profilePictureKey');
    expect(JSON.stringify(seed)).not.toContain('driversLicence');
  });

  it('carries no employee or swipe card number — the organisation issues those (R53)', () => {
    const seed = seedProfileFromStarter(starter());
    expect(seed.fields).not.toHaveProperty('employeeNumber');
    expect(seed.fields).not.toHaveProperty('swipeCardNumber');
  });

  it('DROPS a blank answer rather than writing an empty string', () => {
    /*
      "The form never asked" and "they left it blank" both arrive empty here.
      Writing either as '' would turn an unanswered required field into an
      answered-with-nothing one, which no longer lists for follow-up — the
      record would look complete and be wrong.
    */
    const seed = seedProfileFromStarter(
      starter({ middleName: '   ', sensitive: { ...starter().sensitive, postcode: '' } }),
    );
    expect(seed.fields).not.toHaveProperty('middleName');
    expect(seed.fields).not.toHaveProperty('postcode');
  });
});

describe('values the current lists do not offer (R94)', () => {
  it('reports a historical value as a SUGGESTION rather than writing it', () => {
    /*
      Reaches only a historical submission: one raised since the organisation's
      lists exist can carry only values those lists hold. For an older one the
      answer is a suggestion and an Admin picks from the current lists — which
      is why this is reported rather than silently written or silently dropped.
    */
    const seed = seedProfileFromStarter(starter({ gender: 'Bloke' }));
    expect(seed.unmatched).toContainEqual({ key: 'gender', value: 'Bloke' });
    // Still present, so the Admin can see what was answered.
    expect(seed.fields.gender).toBe('Bloke');
  });

  it('reports a Department and a Role the organisation no longer offers', () => {
    const seed = seedProfileFromStarter(starter({ department: 'Smelting', roles: ['Pot Tender'] }), {
      departments: ['Operations', 'Maintenance'],
      roles: ['Dozer Operator'],
    });
    expect(seed.unmatched).toContainEqual({ key: 'department', value: 'Smelting' });
    expect(seed.unmatched).toContainEqual({ key: 'roles', value: 'Pot Tender' });
  });

  it('skips the check entirely when no lists are supplied', () => {
    // An absent list is not evidence that a value is wrong. Reporting every
    // value as unmatched would make the whole signal useless.
    const seed = seedProfileFromStarter(starter({ department: 'Smelting' }));
    expect(seed.unmatched).toEqual([]);
  });

  it('reports nothing where every value is on the current lists', () => {
    const seed = seedProfileFromStarter(starter(), {
      departments: ['Operations'],
      roles: ['Dozer Operator'],
    });
    expect(seed.unmatched).toEqual([]);
  });

  it('does not check an OPEN field against a list it does not have', () => {
    // Reporting a mobile number as unmatched would be nonsense — only the
    // fields the inventory marks as closed have a list to fail against.
    const seed = seedProfileFromStarter(starter({ mobile: 'anything at all' }));
    expect(seed.unmatched.map((u) => u.key)).not.toContain('mobile');
  });
});

describe('dispositionForSubmission (R89, R90)', () => {
  it('creates where nobody holds the address', () => {
    expect(dispositionForSubmission({ hasMembership: false })).toBe('create');
  });

  it('NEVER creates a second record for somebody who already has one (R89)', () => {
    // The whole point of the check. Two records for one person is the failure
    // this rule exists to prevent, and it is unrecoverable without a merge.
    expect(dispositionForSubmission({ hasMembership: true, membershipStatus: 'active' })).toBe(
      'existing_record',
    );
  });

  it('routes a deactivated person to an Admin to reactivate rather than doing it (R90)', () => {
    // Reactivation takes a seat and may buy a block (R78, R86), so it is not a
    // decision to take automatically off the back of a form submission.
    expect(dispositionForSubmission({ hasMembership: true, membershipStatus: 'suspended' })).toBe(
      'deactivated',
    );
  });
});
