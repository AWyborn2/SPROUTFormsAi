import { describe, expect, it } from 'vitest';
import { CHC_FIELD_IDS, chcIntakeFields } from './chc-intake.js';
import type { FormField } from './form-field.js';
import type { SubmissionValue } from './submission.js';
import {
  assessInductionReadiness,
  buildInductionCohorts,
  readStarterProfile,
  type AssessedStarter,
} from './induction.js';

/** Tuesday. Chosen so the next Monday (16 Mar) is exactly on the notice line. */
const TUESDAY = new Date('2026-03-10T09:00:00');
/** Thursday 12 Mar — the cutoff day itself for Monday 16 Mar, so still bookable. */
const CUTOFF_DAY = new Date('2026-03-12T09:00:00');
/** Friday 13 Mar — one day past that cutoff. */
const PAST_CUTOFF = new Date('2026-03-13T09:00:00');

const VALID_MONDAY = '2026-03-16';
const LATER_MONDAY = '2026-03-23';
const HOLIDAY_MONDAY = '2026-06-01'; // Western Australia Day
const WEDNESDAY = '2026-03-18';
const BEYOND_HOLIDAY_LIST = '2027-01-04'; // past the last listed holiday

const fields = chcIntakeFields();

function fileRef(fileName: string, contentType: string): SubmissionValue {
  return { kind: 'file', key: `org-1/upload-${fileName}`, fileName, contentType, size: 1024 };
}

/** A starter already in Beakon — the Additional Details section is hidden, so it holds no contact or document answers. */
function inBeakonValues(overrides: Record<string, SubmissionValue> = {}) {
  return {
    [CHC_FIELD_IDS.firstName]: 'Rowan',
    [CHC_FIELD_IDS.lastName]: 'Fletcher',
    [CHC_FIELD_IDS.gender]: 'Undisclosed',
    [CHC_FIELD_IDS.indigenous]: false,
    [CHC_FIELD_IDS.starterType]: 'New starter',
    [CHC_FIELD_IDS.inductionDate]: VALID_MONDAY,
    [CHC_FIELD_IDS.department]: 'Maintenance',
    [CHC_FIELD_IDS.roleMaintenance]: 'Tyre Fitter',
    [CHC_FIELD_IDS.inBeakon]: true,
    ...overrides,
  };
}

/** A starter not in Beakon — every Additional Details answer is collected. */
function fullValues(overrides: Record<string, SubmissionValue> = {}) {
  return {
    [CHC_FIELD_IDS.firstName]: 'Marlee',
    [CHC_FIELD_IDS.middleName]: 'Jean',
    [CHC_FIELD_IDS.lastName]: 'Okonkwo',
    [CHC_FIELD_IDS.gender]: 'Female',
    [CHC_FIELD_IDS.indigenous]: true,
    [CHC_FIELD_IDS.starterType]: 'New starter',
    [CHC_FIELD_IDS.inductionDate]: VALID_MONDAY,
    [CHC_FIELD_IDS.department]: 'Operations',
    [CHC_FIELD_IDS.roleOperations]: ['Dozer Operator', 'Grader Operator'],
    [CHC_FIELD_IDS.inBeakon]: false,
    [CHC_FIELD_IDS.mobile]: '0412 345 678',
    [CHC_FIELD_IDS.email]: 'marlee@example.com',
    [CHC_FIELD_IDS.dob]: '1994-02-11',
    [CHC_FIELD_IDS.addressStreet]: '14 Marradong Rd',
    [CHC_FIELD_IDS.suburb]: 'Boddington',
    [CHC_FIELD_IDS.postcode]: '6390',
    [CHC_FIELD_IDS.emergencyContactName]: 'Sam Okonkwo',
    [CHC_FIELD_IDS.emergencyContactPhone]: '0498 765 432',
    [CHC_FIELD_IDS.licenceClass]: 'HR',
    [CHC_FIELD_IDS.licenceExpiry]: '2030-06-30',
    [CHC_FIELD_IDS.licenceNumber]: 'WA-1234567',
    [CHC_FIELD_IDS.photo]: fileRef('marlee.jpg', 'image/jpeg'),
    [CHC_FIELD_IDS.driversLicence]: fileRef('licence.pdf', 'application/pdf'),
    ...overrides,
  };
}

function assess(
  values: Record<string, SubmissionValue>,
  options: { today?: Date; alreadyBooked?: boolean; allowLateNotice?: boolean } = {},
) {
  const profile = readStarterProfile(fields, values);
  if (!profile) throw new Error('expected a CHC-shaped submission');
  return assessInductionReadiness(profile, { today: options.today ?? TUESDAY, ...options });
}

describe('readStarterProfile', () => {
  it('promotes the booking fields a registration needs', () => {
    const profile = readStarterProfile(fields, fullValues())!;
    expect(profile.firstName).toBe('Marlee');
    expect(profile.lastName).toBe('Okonkwo');
    expect(profile.fullName).toBe('Marlee Okonkwo');
    expect(profile.mobile).toBe('0412 345 678');
    expect(profile.email).toBe('marlee@example.com');
    expect(profile.inductionDate).toBe(VALID_MONDAY);
    expect(profile.department).toBe('Operations');
    expect(profile.roles).toEqual(['Dozer Operator', 'Grader Operator']);
    expect(profile.inBeakon).toBe(false);
  });

  it('resolves the role field for a single-role department', () => {
    const profile = readStarterProfile(fields, inBeakonValues())!;
    expect(profile.roles).toEqual(['Tyre Fitter']);
  });

  it('reports documents as presence and metadata, never as bytes or a key', () => {
    const profile = readStarterProfile(fields, fullValues())!;
    expect(profile.photo).toEqual({ present: true, fileName: 'marlee.jpg', contentType: 'image/jpeg' });
    expect(profile.driversLicence.present).toBe(true);
    expect(JSON.stringify(profile)).not.toContain('upload-');
  });

  it('keeps sensitive personal detail off the top-level profile', () => {
    const profile = readStarterProfile(fields, fullValues())!;
    const topLevel = { ...profile } as Record<string, unknown>;
    delete topLevel.sensitive;
    const serialized = JSON.stringify(topLevel);
    expect(serialized).not.toContain('1994-02-11');
    expect(serialized).not.toContain('Marradong');
    expect(serialized).not.toContain('WA-1234567');
    expect(serialized).not.toContain('0498 765 432');
    expect(profile.sensitive.dob).toBe('1994-02-11');
    expect(profile.sensitive.licenceNumber).toBe('WA-1234567');
  });

  it('returns null for a submission that is not CHC-shaped', () => {
    const otherFields: FormField[] = [
      { id: 'q1', type: 'text', label: 'Anything', required: false, source: 'built' },
    ];
    expect(readStarterProfile(otherFields, { q1: 'hello' })).toBeNull();
  });
});

describe('assessInductionReadiness', () => {
  it('passes a complete in-Beakon starter on a valid Monday', () => {
    const verdict = assess(inBeakonValues());
    expect(verdict.readiness).toBe('ready');
    expect(verdict.blockers).toEqual([]);
  });

  it('passes a complete not-in-Beakon starter with both documents', () => {
    expect(assess(fullValues()).readiness).toBe('ready');
  });

  it('blocks a not-in-Beakon starter missing the licence image', () => {
    const verdict = assess(fullValues({ [CHC_FIELD_IDS.driversLicence]: null }));
    expect(verdict.readiness).toBe('blocked');
    expect(verdict.blockers).toContain('identity_missing');
  });

  it('does not demand documents from an in-Beakon starter', () => {
    const verdict = assess(inBeakonValues());
    expect(verdict.blockers).not.toContain('identity_missing');
    expect(verdict.blockers).not.toContain('contact_missing');
  });

  it('blocks on a missing mobile, a missing email, and reports both as one blocker', () => {
    expect(assess(fullValues({ [CHC_FIELD_IDS.mobile]: '' })).blockers).toContain('contact_missing');
    expect(assess(fullValues({ [CHC_FIELD_IDS.email]: '' })).blockers).toContain('contact_missing');
    const both = assess(fullValues({ [CHC_FIELD_IDS.mobile]: '', [CHC_FIELD_IDS.email]: '' }));
    expect(both.blockers.filter((b) => b === 'contact_missing')).toHaveLength(1);
  });

  it('blocks a date that is not a Monday', () => {
    const verdict = assess(fullValues({ [CHC_FIELD_IDS.inductionDate]: WEDNESDAY }));
    expect(verdict.blockers).toContain('date_invalid');
  });

  it('blocks a Monday that is a public holiday', () => {
    const verdict = assess(fullValues({ [CHC_FIELD_IDS.inductionDate]: HOLIDAY_MONDAY }));
    expect(verdict.blockers).toContain('date_invalid');
  });

  it('still accepts a booking made on the Thursday cutoff itself', () => {
    // The runbook is explicit that short notice is not a reason to refuse —
    // Thursday for the following Monday is an ordinary, in-window booking.
    const verdict = assess(fullValues(), { today: CUTOFF_DAY });
    expect(verdict.readiness).toBe('ready');
    expect(verdict.blockers).toEqual([]);
  });

  it('distinguishes a lapsed notice window from an invalid date', () => {
    const verdict = assess(fullValues(), { today: PAST_CUTOFF });
    expect(verdict.blockers).toContain('date_notice_lapsed');
    expect(verdict.blockers).not.toContain('date_invalid');
  });

  it('warns when the date is past the public-holiday list without blocking', () => {
    const verdict = assess(fullValues({ [CHC_FIELD_IDS.inductionDate]: BEYOND_HOLIDAY_LIST }));
    expect(verdict.readiness).toBe('ready');
    expect(verdict.warnings).toContain('holiday_list_expired');
  });

  it('blocks a starter already covered by a booking', () => {
    const verdict = assess(fullValues(), { alreadyBooked: true });
    expect(verdict.readiness).toBe('blocked');
    expect(verdict.blockers).toContain('already_booked');
  });

  it('lets an operator override short notice, keeping it visible as a warning', () => {
    const blocked = assess(fullValues(), { today: PAST_CUTOFF });
    expect(blocked.readiness).toBe('blocked');
    expect(blocked.blockers).toContain('date_notice_lapsed');

    const overridden = assess(fullValues(), { today: PAST_CUTOFF, allowLateNotice: true });
    expect(overridden.readiness).toBe('ready');
    expect(overridden.blockers).not.toContain('date_notice_lapsed');
    // The exception stays legible to whoever reads the record later.
    expect(overridden.warnings).toContain('notice_overridden');
  });

  it('does not let the override manufacture an induction day that does not exist', () => {
    // Short notice is lead time the site can absorb. A Wednesday, or a Monday
    // that is a public holiday, is a day no induction runs at all.
    for (const date of [WEDNESDAY, HOLIDAY_MONDAY]) {
      const verdict = assess(fullValues({ [CHC_FIELD_IDS.inductionDate]: date }), {
        allowLateNotice: true,
      });
      expect(verdict.readiness).toBe('blocked');
      expect(verdict.blockers).toContain('date_invalid');
      expect(verdict.warnings).not.toContain('notice_overridden');
    }
  });

  it('does not warn about an override that was never needed', () => {
    const verdict = assess(fullValues(), { allowLateNotice: true });
    expect(verdict.readiness).toBe('ready');
    expect(verdict.warnings).not.toContain('notice_overridden');
  });

  it('leaves every other blocker standing when notice is overridden', () => {
    const verdict = assess(fullValues({ [CHC_FIELD_IDS.mobile]: '' }), {
      today: PAST_CUTOFF,
      allowLateNotice: true,
    });
    expect(verdict.readiness).toBe('blocked');
    expect(verdict.blockers).toContain('contact_missing');
    expect(verdict.warnings).toContain('notice_overridden');
  });
});

describe('buildInductionCohorts', () => {
  function assessed(id: string, values: Record<string, SubmissionValue>, alreadyBooked = false): AssessedStarter {
    const profile = readStarterProfile(fields, values)!;
    return {
      submissionId: id,
      profile,
      ...assessInductionReadiness(profile, { today: TUESDAY, alreadyBooked }),
    };
  }

  it('groups by induction date, counting only ready starters as seats', () => {
    const cohorts = buildInductionCohorts([
      assessed('a', fullValues()),
      assessed('b', fullValues({ [CHC_FIELD_IDS.driversLicence]: null })),
      assessed('c', inBeakonValues({ [CHC_FIELD_IDS.inductionDate]: LATER_MONDAY })),
    ]);

    expect(cohorts).toHaveLength(2);
    const first = cohorts[0]!;
    expect(first.date).toBe(VALID_MONDAY);
    expect(first.seats).toBe(1);
    expect(first.readyCount).toBe(1);
    expect(first.blockedCount).toBe(1);
    expect(first.starters.map((s) => s.submissionId)).toEqual(['a', 'b']);
  });

  it('returns cohorts in ascending date order', () => {
    const cohorts = buildInductionCohorts([
      assessed('late', inBeakonValues({ [CHC_FIELD_IDS.inductionDate]: LATER_MONDAY })),
      assessed('early', inBeakonValues()),
    ]);
    expect(cohorts.map((c) => c.date)).toEqual([VALID_MONDAY, LATER_MONDAY]);
  });

  it('excludes starters with no usable induction date', () => {
    const cohorts = buildInductionCohorts([
      assessed('dateless', fullValues({ [CHC_FIELD_IDS.inductionDate]: '' })),
      assessed('dated', fullValues()),
    ]);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.starters.map((s) => s.submissionId)).toEqual(['dated']);
  });
});
