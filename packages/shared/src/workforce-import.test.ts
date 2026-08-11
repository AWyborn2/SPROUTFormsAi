/**
 * The import validator is the ONE path into the product that does not go through
 * a screen, so it is the one place a rule can break silently and at volume. Per
 * the execution note there is one test per rejection reason, plus the parse and
 * the deliberate non-rejection of a known address (R148/R149).
 */
import { describe, expect, it } from 'vitest';
import {
  WORKFORCE_IMPORT_TEMPLATE,
  parseWorkforceCsv,
  validateWorkforceImport,
  type ImportContext,
} from './workforce-import.js';
import type { PlacementContext } from './placement.js';

const LOC = 'loc-raw';
const DEPT = 'dep-ops';
const ROLE_DOZER = 'role-dozer';
const ROLE_GRADER = 'role-grader';
const COMP = 'comp-dozer';
/** In the register, awarded by no tool — what R167's amendment admits. */
const COMP_UNAWARDED = 'comp-hr-licence';

/** Ops offers Dozer + Grader and allows a single Role; Raw Materials is the one Location. */
function makeCtx(over: Partial<ImportContext> = {}): ImportContext {
  const placement: PlacementContext = {
    departments: [{ id: DEPT, allowsMultipleRoles: false }],
    roles: [
      { id: ROLE_DOZER, departmentId: DEPT },
      { id: ROLE_GRADER, departmentId: DEPT },
    ],
  };
  return {
    locationsByName: new Map([['raw materials', LOC]]),
    departmentsByName: new Map([['operations', DEPT]]),
    rolesByDeptAndName: new Map([
      [`${DEPT}|dozer operator`, ROLE_DOZER],
      [`${DEPT}|grader operator`, ROLE_GRADER],
    ]),
    // The REGISTER, not the awarded subset (R167, amended). The second entry
    // stands for the migration case: a competency an Admin created by hand that
    // no assessment tool awards yet.
    competenciesByName: new Map([
      ['ato - track dozer', COMP],
      ['hr truck licence', COMP_UNAWARDED],
    ]),
    placement,
    candidateSeatsAllowed: true,
    dateFormat: 'dmy',
    ...over,
  };
}

/** Build a file from several profile lines, each a partial override of the valid row. */
function profileFileOf(rows: Array<Partial<Record<string, string>>>): string {
  const line = (cells: Partial<Record<string, string>>) => {
    const c = {
      name: 'Ada Assessor',
      email: 'ada@example.com',
      access_level: 'Assessor',
      locations: 'Raw Materials',
      departments: 'Operations',
      roles: 'Dozer Operator',
      employee_number: '',
      swipe_card_number: '',
      ...cells,
    };
    return `${c.name},${c.email},${c.access_level},${c.locations},${c.departments},${c.roles},${c.employee_number},${c.swipe_card_number}`;
  };
  return [
    '#profiles',
    'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number',
    ...rows.map(line),
  ].join('\n');
}

/** Build a one-profile file from a partial profile line, defaulting to a valid row. */
function profileFile(cells: Partial<Record<string, string>> = {}): string {
  const c = {
    name: 'Ada Assessor',
    email: 'ada@example.com',
    access_level: 'Assessor',
    locations: 'Raw Materials',
    departments: 'Operations',
    roles: 'Dozer Operator',
    employee_number: 'E1',
    swipe_card_number: '',
    ...cells,
  };
  return [
    '#profiles',
    'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number',
    `${c.name},${c.email},${c.access_level},${c.locations},${c.departments},${c.roles},${c.employee_number},${c.swipe_card_number}`,
  ].join('\n');
}

function validateFile(text: string, ctx = makeCtx()) {
  return validateWorkforceImport(parseWorkforceCsv(text), ctx);
}
const reasons = (text: string, ctx = makeCtx()) => validateFile(text, ctx).rejected.map((r) => r.reason);

describe('parseWorkforceCsv', () => {
  it('has a profile section and a competency section, and a filled copy parses', () => {
    expect(WORKFORCE_IMPORT_TEMPLATE).toContain('#profiles');
    expect(WORKFORCE_IMPORT_TEMPLATE).toContain('#competencies');

    const filled = [
      '#profiles',
      'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number',
      'Ada Assessor,ada@example.com,Assessor,Raw Materials,Operations,Dozer Operator,E1,',
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      'ada@example.com,ATO - Track Dozer,2023-01-15,,CERT-9',
    ].join('\n');
    const parsed = parseWorkforceCsv(filled);
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]).toMatchObject({ name: 'Ada Assessor', email: 'ada@example.com' });
    expect(parsed.competencies).toHaveLength(1);
    expect(parsed.competencies[0]).toMatchObject({ competency: 'ATO - Track Dozer', grantDate: '2023-01-15' });
  });

  it('reads the competency section by its HEADER, so a file from the previous template still works', () => {
    /*
      `expiry_date` was added between `grant_date` and `evidence`. Read
      positionally, a file filled from the OLD four-column template puts its
      evidence string where expiry now sits — which then fails to parse as a
      date and rejects a good line. The header is what disambiguates.
    */
    const oldFormat = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,evidence',
      'ada@example.com,ATO - Track Dozer,2023-01-15,CERT-9',
    ].join('\n');
    const parsed = parseWorkforceCsv(oldFormat);
    expect(parsed.competencies[0]).toMatchObject({
      grantDate: '2023-01-15',
      // Landed as evidence, NOT as an expiry date it would have choked on.
      expiryDate: '',
      evidence: 'CERT-9',
    });
    // And it validates rather than rejecting as bad_expiry_date.
    expect(reasons(oldFormat)).toEqual([]);
  });

  it('reads columns by name even when a spreadsheet reordered them', () => {
    const reordered = [
      profileFile(),
      '#competencies',
      'email,competency,evidence,expiry_date,grant_date',
      'ada@example.com,ATO - Track Dozer,CERT-9,2027-06-30,2021-06-30',
    ].join('\n');
    expect(parseWorkforceCsv(reordered).competencies[0]).toMatchObject({
      grantDate: '2021-06-30',
      expiryDate: '2027-06-30',
      evidence: 'CERT-9',
    });
  });

  it('splits multi-value cells and honours quoted commas', () => {
    const parsed = parseWorkforceCsv(
      profileFile({ roles: 'Dozer Operator', name: '"Worker, Senior"' }),
    );
    expect(parsed.profiles[0]!.name).toBe('Worker, Senior');
    expect(parsed.profiles[0]!.roles).toEqual(['Dozer Operator']);
  });
});

describe('validateWorkforceImport — a valid row', () => {
  it('validates a row carrying only the required set (R151)', () => {
    const { validProfiles, rejected } = validateFile(profileFile());
    expect(rejected).toEqual([]);
    expect(validProfiles).toHaveLength(1);
    expect(validProfiles[0]).toMatchObject({ role: 'assessor', locationIds: [LOC], roleIds: [ROLE_DOZER] });
  });
});

describe('validateWorkforceImport — one test per rejection reason', () => {
  it('missing name (R146)', () => {
    expect(reasons(profileFile({ name: '' }))).toEqual(['missing_name']);
  });
  it('missing email (R147)', () => {
    expect(reasons(profileFile({ email: '' }))).toEqual(['missing_email']);
  });
  it('missing access level (R168)', () => {
    expect(reasons(profileFile({ access_level: '' }))).toEqual(['missing_access_level']);
  });
  it('unrecognised access level (R167)', () => {
    expect(reasons(profileFile({ access_level: 'Wizard' }))).toEqual(['unknown_access_level']);
  });
  it('Candidate on a tier with no candidate seats (R167)', () => {
    const ctx = makeCtx({ candidateSeatsAllowed: false });
    expect(reasons(profileFile({ access_level: 'Candidate' }), ctx)).toEqual(['candidate_not_allowed']);
  });
  it('missing Location (R151, R168)', () => {
    expect(reasons(profileFile({ locations: '' }))).toEqual(['missing_location']);
  });
  it('a Location that does not exist or is retired (R165, R166)', () => {
    expect(reasons(profileFile({ locations: 'Nowhere' }))).toEqual(['unknown_location']);
  });
  it('a Department that does not exist or is retired (R165, R166)', () => {
    expect(reasons(profileFile({ departments: 'Ghost Dept' }))).toEqual(['unknown_department']);
  });
  it('a Role the named Department does not offer (R166)', () => {
    expect(reasons(profileFile({ roles: 'Welder' }))).toEqual(['unknown_role']);
  });
  it('more Roles than the Department allows (R166, R155)', () => {
    // Ops allows a single Role; naming two is too many.
    expect(reasons(profileFile({ roles: 'Dozer Operator;Grader Operator' }))).toEqual(['too_many_roles']);
  });
  it('a competency that is not in the organisation register (R167, amended; R169)', () => {
    // The rule the import still enforces: the register is READ, never written.
    // A name nobody created has nowhere to go but the rejection list.
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      'ada@example.com,Ticket Nobody Created,2023-01-15,,',
    ].join('\n');
    expect(reasons(file)).toEqual(['unknown_competency']);
  });
  it('a competency line whose grant date cannot be read (R167)', () => {
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      'ada@example.com,ATO - Track Dozer,not-a-date,,',
    ].join('\n');
    expect(reasons(file)).toEqual(['bad_grant_date']);
  });
  it('a competency line whose expiry date cannot be read', () => {
    // Present but unreadable is a rejection; BLANK is not — that is R153,
    // reversed, and its own describe block below.
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      'ada@example.com,ATO - Track Dozer,,not-a-date,',
    ].join('\n');
    expect(reasons(file)).toEqual(['bad_expiry_date']);
  });
  it('a competency line whose email names no profile row in the file (R170)', () => {
    // A typo naming nobody — dropping it silently would lose the grant with no
    // trace, so it is a named rejection.
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      'typo@example.com,ATO - Track Dozer,2023-01-15,,',
    ].join('\n');
    expect(reasons(file)).toEqual(['unknown_profile_email']);
  });
});

describe('validateWorkforceImport — deliberate non-rejections and volume', () => {
  it('records a competency in the register that NO tool awards (R167, amended)', () => {
    // The migration case. An HR truck licence is earned with a previous
    // employer and renewed at a licensing centre — no assessment tool in the
    // product will ever award it, and refusing the grant on that basis would
    // lose real qualification history rather than protect anything. The line
    // resolves against the register exactly as an awarded one does.
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      'ada@example.com,HR Truck Licence,2021-06-30,,LIC-4471',
    ].join('\n');
    const { validCompetencies, rejected } = validateFile(file);
    expect(rejected).toEqual([]);
    expect(validCompetencies).toHaveLength(1);
    expect(validCompetencies[0]).toMatchObject({
      competencyId: COMP_UNAWARDED,
      evidence: 'LIC-4471',
    });
  });

  it('does NOT reject a row whose email already belongs to someone — U24 merges it (R148, R149)', () => {
    // Uniqueness is not a rejection reason; the validator has no notion of
    // "already exists", so a known address simply validates.
    const { validProfiles, rejected } = validateFile(profileFile({ email: 'existing@example.com' }));
    expect(rejected).toEqual([]);
    expect(validProfiles).toHaveLength(1);
  });

  it('drops a competency line silently when its own profile row was rejected', () => {
    // The profile row carries that email but was rejected for a missing access
    // level; its rejection already names the fix, so the competency line beneath
    // it is dropped silently rather than flagged a second time.
    const file = [
      profileFile({ access_level: '' }),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      'ada@example.com,ATO - Track Dozer,2023-01-15,,',
    ].join('\n');
    expect(reasons(file)).toEqual(['missing_access_level']);
  });

  it('validates 293 good rows and rejects 7 naming a missing Role, each with a reason (R170)', () => {
    const good = Array.from(
      { length: 293 },
      (_, i) => `Person ${i},p${i}@example.com,Assessor,Raw Materials,Operations,Dozer Operator,,`,
    );
    const bad = Array.from(
      { length: 7 },
      (_, i) => `Bad ${i},b${i}@example.com,Assessor,Raw Materials,Operations,Welder,,`,
    );
    const file = [
      '#profiles',
      'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number',
      ...good,
      ...bad,
    ].join('\n');
    const { validProfiles, rejected } = validateFile(file);
    expect(validProfiles).toHaveLength(293);
    expect(rejected).toHaveLength(7);
    expect(new Set(rejected.map((r) => r.reason))).toEqual(new Set(['unknown_role']));
  });

  it('rejects a row naming an employee number already issued in the organisation (R7)', () => {
    const ctx = makeCtx({ heldEmployeeNumbers: new Set(['e1']) });
    expect(reasons(profileFile({ employee_number: 'E1' }), ctx)).toEqual(['duplicate_employee_number']);
  });

  it('rejects a row naming a swipe card number already issued (R7)', () => {
    const ctx = makeCtx({ heldSwipeCardNumbers: new Set(['s9']) });
    expect(reasons(profileFile({ swipe_card_number: 'S9' }), ctx)).toEqual(['duplicate_swipe_card_number']);
  });

  it('matches a held number case-insensitively, as the profile index does', () => {
    // The partial unique indexes fold case. A case-SENSITIVE check here would
    // pass a row the insert then rejects, part-way through a run.
    const ctx = makeCtx({ heldEmployeeNumbers: new Set(['e1']) });
    expect(reasons(profileFile({ employee_number: 'e1' }), ctx)).toEqual(['duplicate_employee_number']);
  });

  it('rejects the SECOND of two rows sharing a swipe card number within one file (R7)', () => {
    // The likelier mistake than a clash with a number already on record, and
    // one the database would only surface part-way through the run.
    const file = profileFileOf([
      { email: 'a@example.com', swipe_card_number: 'S9' },
      { email: 'b@example.com', swipe_card_number: 'S9' },
    ]);
    const { validProfiles, rejected } = validateFile(file);
    expect(validProfiles).toHaveLength(1);
    expect(validProfiles[0]!.email).toBe('a@example.com');
    expect(rejected.map((r) => r.reason)).toEqual(['duplicate_swipe_card_number']);
  });

  it('accepts many rows holding NO identifier at all', () => {
    // AE27 / R12: both stay optional indefinitely, so a file of people holding
    // neither is ordinary rather than a pile of collisions on the empty string.
    const file = profileFileOf([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
      { email: 'c@example.com' },
    ]);
    const { validProfiles, rejected } = validateFile(file);
    expect(validProfiles).toHaveLength(3);
    expect(rejected).toEqual([]);
  });

  it('does not treat a number held in a DIFFERENT organisation as a clash (R7)', () => {
    // Uniqueness is scoped per organisation — the context carries only this
    // organisation's numbers, so an empty set is the whole assertion.
    const ctx = makeCtx({ heldEmployeeNumbers: new Set() });
    expect(reasons(profileFile({ employee_number: 'E1' }), ctx)).toEqual([]);
  });

  it('records a valid competency line with the row’s own grant date, resolved', () => {
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      'ada@example.com,ATO - Track Dozer,2021-06-30,,CERT-9',
    ].join('\n');
    const { validCompetencies } = validateFile(file);
    expect(validCompetencies).toHaveLength(1);
    expect(validCompetencies[0]).toMatchObject({ competencyId: COMP, evidence: 'CERT-9' });
    expect(validCompetencies[0]!.grantedAt?.toISOString().slice(0, 10)).toBe('2021-06-30');
  });
});

describe('validateWorkforceImport — a blank date means UNKNOWN, not a rejection (R153, reversed)', () => {
  const fileWith = (grantDate: string, expiryDate: string) =>
    [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      `ada@example.com,ATO - Track Dozer,${grantDate},${expiryDate},CERT-9`,
    ].join('\n');

  it('accepts a blank grant date — the line is recorded, undated, not rejected', () => {
    const { validCompetencies, rejected } = validateFile(fileWith('', ''));
    expect(rejected).toEqual([]);
    expect(validCompetencies).toHaveLength(1);
    expect(validCompetencies[0]).toMatchObject({ competencyId: COMP, grantedAt: null, expiresAt: null });
  });

  it('accepts an expiry with no grant date at all — the driver’s-licence case', () => {
    // The source system tracks the expiry directly; a grant date may never
    // have been recorded, and none is required to use it.
    const { validCompetencies, rejected } = validateFile(fileWith('', '2027-06-30'));
    expect(rejected).toEqual([]);
    expect(validCompetencies[0]!.grantedAt).toBeNull();
    expect(validCompetencies[0]!.expiresAt?.toISOString().slice(0, 10)).toBe('2027-06-30');
  });

  it('accepts a grant date with no expiry — expiry derives from the competency’s validity as usual', () => {
    const { validCompetencies, rejected } = validateFile(fileWith('2021-06-30', ''));
    expect(rejected).toEqual([]);
    expect(validCompetencies[0]!.grantedAt?.toISOString().slice(0, 10)).toBe('2021-06-30');
    expect(validCompetencies[0]!.expiresAt).toBeNull();
  });

  it('accepts both dates supplied together — the explicit expiry is carried through, not derived', () => {
    const { validCompetencies } = validateFile(fileWith('2021-06-30', '2027-06-30'));
    expect(validCompetencies[0]!.grantedAt?.toISOString().slice(0, 10)).toBe('2021-06-30');
    expect(validCompetencies[0]!.expiresAt?.toISOString().slice(0, 10)).toBe('2027-06-30');
  });
});

describe('validateWorkforceImport — grant date reads by the organisation\'s dateFormat', () => {
  const fileWithDate = (grantDate: string) =>
    [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      `ada@example.com,ATO - Track Dozer,${grantDate},,`,
    ].join('\n');

  it('reads a slash date DAY-FIRST on dmy — the ambiguous case Date.parse got wrong', () => {
    // 07/08/2027 is 7 August on dmy, NOT 8 July — the exact misread this
    // replaces `Date.parse` to close.
    const ctx = makeCtx({ dateFormat: 'dmy' });
    const { validCompetencies } = validateFile(fileWithDate('07/08/2027'), ctx);
    expect(validCompetencies[0]!.grantedAt?.toISOString().slice(0, 10)).toBe('2027-08-07');
  });

  it('reads the SAME slash date MONTH-FIRST on mdy', () => {
    const ctx = makeCtx({ dateFormat: 'mdy' });
    const { validCompetencies } = validateFile(fileWithDate('07/08/2027'), ctx);
    expect(validCompetencies[0]!.grantedAt?.toISOString().slice(0, 10)).toBe('2027-07-08');
  });

  it('reads a hyphenated numeric date the same way as a slash one', () => {
    const ctx = makeCtx({ dateFormat: 'dmy' });
    const { validCompetencies } = validateFile(fileWithDate('07-08-2027'), ctx);
    expect(validCompetencies[0]!.grantedAt?.toISOString().slice(0, 10)).toBe('2027-08-07');
  });

  it('reads an ISO date the same way regardless of dateFormat', () => {
    // The whole point of ISO: no organisation setting can change what it means.
    const dmy = validateFile(fileWithDate('2027-08-07'), makeCtx({ dateFormat: 'dmy' }));
    const mdy = validateFile(fileWithDate('2027-08-07'), makeCtx({ dateFormat: 'mdy' }));
    expect(dmy.validCompetencies[0]!.grantedAt?.toISOString().slice(0, 10)).toBe('2027-08-07');
    expect(mdy.validCompetencies[0]!.grantedAt?.toISOString().slice(0, 10)).toBe('2027-08-07');
  });

  it('reads the EXPIRY column by the same convention, not just the grant date', () => {
    // The column #180 added must not be the one place a day-first date is
    // still guessed — a licence expiry misread by four weeks is the same bug.
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,expiry_date,evidence',
      'ada@example.com,ATO - Track Dozer,,07/08/2027,',
    ].join('\n');
    const dmy = validateFile(file, makeCtx({ dateFormat: 'dmy' }));
    const mdy = validateFile(file, makeCtx({ dateFormat: 'mdy' }));
    expect(dmy.validCompetencies[0]!.expiresAt?.toISOString().slice(0, 10)).toBe('2027-08-07');
    expect(mdy.validCompetencies[0]!.expiresAt?.toISOString().slice(0, 10)).toBe('2027-07-08');
  });

  it('rejects a day beyond the month it names rather than rolling into the next month', () => {
    // 31/02/2024 must not silently become 2 or 3 March.
    expect(reasons(fileWithDate('31/02/2024'))).toEqual(['bad_grant_date']);
  });

  it('rejects a month name or free text — no longer guessed via Date.parse', () => {
    expect(reasons(fileWithDate('August 7, 2027'))).toEqual(['bad_grant_date']);
  });
});

/*
  The profile fields on an import row (R19, R154).

  These exist because the gap they cover was a REAL defect rather than a
  hypothetical one: `member_profiles` held ten NOT NULL columns the import had
  no column to fill, so every row would have failed its insert against a real
  database — and no test caught it, because the suites that cover the run mock
  the lander away and the doubles beneath it enforce no constraints.
*/
describe('validateWorkforceImport — the profile fields an import row carries', () => {
  const withProfileColumns = (cells: string) =>
    [
      '#profiles',
      'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number,' +
        'middle_name,date_of_birth,gender,ethnicity,address_street,suburb,postcode,mobile,' +
        'emergency_contact_name,emergency_contact_phone,starter_type',
      `Ada Assessor,ada@example.com,Assessor,Raw Materials,Operations,Dozer Operator,,,${cells}`,
      '',
    ].join('\n');

  it('carries every supplied field through onto the validated row', () => {
    const result = validateFile(
      withProfileColumns(
        'Mary,14/02/1990,Female,Prefer not to say,12 Example St,Baldivis,6171,0412345678,' +
          'Kim Assessor,0498765432,New starter',
      ),
    );
    expect(result.rejected).toEqual([]);
    expect(result.validProfiles[0]).toMatchObject({
      middleName: 'Mary',
      dateOfBirth: '1990-02-14',
      gender: 'Female',
      ethnicity: 'Prefer not to say',
      addressStreet: '12 Example St',
      suburb: 'Baldivis',
      postcode: '6171',
      mobile: '0412345678',
      emergencyContactName: 'Kim Assessor',
      emergencyContactPhone: '0498765432',
      starterType: 'New starter',
    });
  });

  it('lands a row that supplies none of them, rather than rejecting the person', () => {
    const result = validateFile(withProfileColumns(',,,,,,,,,,'));
    expect(result.rejected).toEqual([]);
    expect(result.validProfiles).toHaveLength(1);
    expect(result.validProfiles[0]).toMatchObject({ email: 'ada@example.com', gender: '', mobile: '' });
  });

  /*
    The date of birth resolves the organisation's day/month order HERE, so what
    travels on is unambiguous. 02/03 is the 2nd of March to an Australian
    organisation and the 3rd of February to an American one, and a date of
    birth that moves by a month is a failed identity check against a licence.
  */
  it('reads the date of birth by the organisation dateFormat', () => {
    const dmy = validateFile(withProfileColumns(',02/03/1990,,,,,,,,,'), makeCtx({ dateFormat: 'dmy' }));
    const mdy = validateFile(withProfileColumns(',02/03/1990,,,,,,,,,'), makeCtx({ dateFormat: 'mdy' }));
    expect(dmy.validProfiles[0]!.dateOfBirth).toBe('1990-03-02');
    expect(mdy.validProfiles[0]!.dateOfBirth).toBe('1990-02-03');
  });

  it('rejects a date of birth that is present but unreadable, rather than dropping it', () => {
    const result = validateFile(withProfileColumns(',not-a-date,,,,,,,,,'));
    expect(result.rejected.map((r) => r.reason)).toEqual(['bad_date_of_birth']);
    expect(result.validProfiles).toEqual([]);
  });

  /*
    BACKWARD COMPATIBILITY, and the reason the profiles section reads by header
    rather than by position. Every file built from the eight-column template —
    including one already prepared for a migration — must keep parsing as it
    did, with the added columns reading as absent rather than shifting the
    meaning of the cells that ARE there.
  */
  it('parses a file built from the older eight-column template unchanged', () => {
    const old = [
      '#profiles',
      'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number',
      'Ada Assessor,ada@example.com,Assessor,Raw Materials,Operations,Dozer Operator,E-1,S-1',
      '',
    ].join('\n');
    const result = validateFile(old);
    expect(result.rejected).toEqual([]);
    expect(result.validProfiles[0]).toMatchObject({
      email: 'ada@example.com',
      employeeNumber: 'E-1',
      swipeCardNumber: 'S-1',
      dateOfBirth: '',
      gender: '',
    });
  });

  it('parses a headerless profiles section as the older eight columns', () => {
    const headerless = [
      '#profiles',
      'Ada Assessor,ada@example.com,Assessor,Raw Materials,Operations,Dozer Operator,E-9,S-9',
      '',
    ].join('\n');
    const result = validateFile(headerless);
    expect(result.rejected).toEqual([]);
    expect(result.validProfiles[0]).toMatchObject({ employeeNumber: 'E-9', swipeCardNumber: 'S-9' });
  });
});
