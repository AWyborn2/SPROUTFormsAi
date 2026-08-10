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
    awardedCompetenciesByName: new Map([['ato - track dozer', COMP]]),
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
      'email,competency,grant_date,evidence',
      'ada@example.com,ATO - Track Dozer,2023-01-15,CERT-9',
    ].join('\n');
    const parsed = parseWorkforceCsv(filled);
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]).toMatchObject({ name: 'Ada Assessor', email: 'ada@example.com' });
    expect(parsed.competencies).toHaveLength(1);
    expect(parsed.competencies[0]).toMatchObject({ competency: 'ATO - Track Dozer', grantDate: '2023-01-15' });
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
  it('a competency no tool in the organisation awards (R167)', () => {
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,evidence',
      'ada@example.com,Unawarded Ticket,2023-01-15,',
    ].join('\n');
    expect(reasons(file)).toEqual(['unknown_competency']);
  });
  it('a competency line whose grant date cannot be read (R167)', () => {
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,evidence',
      'ada@example.com,ATO - Track Dozer,not-a-date,',
    ].join('\n');
    expect(reasons(file)).toEqual(['bad_grant_date']);
  });
  it('a competency line whose email names no profile row in the file (R170)', () => {
    // A typo naming nobody — dropping it silently would lose the grant with no
    // trace, so it is a named rejection.
    const file = [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,evidence',
      'typo@example.com,ATO - Track Dozer,2023-01-15,',
    ].join('\n');
    expect(reasons(file)).toEqual(['unknown_profile_email']);
  });
});

describe('validateWorkforceImport — deliberate non-rejections and volume', () => {
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
      'email,competency,grant_date,evidence',
      'ada@example.com,ATO - Track Dozer,2023-01-15,',
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
      'email,competency,grant_date,evidence',
      'ada@example.com,ATO - Track Dozer,2021-06-30,CERT-9',
    ].join('\n');
    const { validCompetencies } = validateFile(file);
    expect(validCompetencies).toHaveLength(1);
    expect(validCompetencies[0]).toMatchObject({ competencyId: COMP, evidence: 'CERT-9' });
    expect(validCompetencies[0]!.grantedAt.toISOString().slice(0, 10)).toBe('2021-06-30');
  });
});

describe('validateWorkforceImport — grant date reads by the organisation\'s dateFormat', () => {
  const fileWithDate = (grantDate: string) =>
    [
      profileFile(),
      '#competencies',
      'email,competency,grant_date,evidence',
      `ada@example.com,ATO - Track Dozer,${grantDate},`,
    ].join('\n');

  it('reads a slash date DAY-FIRST on dmy — the ambiguous case Date.parse got wrong', () => {
    // 07/08/2027 is 7 August on dmy, NOT 8 July — the exact misread this
    // replaces `Date.parse` to close.
    const ctx = makeCtx({ dateFormat: 'dmy' });
    const { validCompetencies } = validateFile(fileWithDate('07/08/2027'), ctx);
    expect(validCompetencies[0]!.grantedAt.toISOString().slice(0, 10)).toBe('2027-08-07');
  });

  it('reads the SAME slash date MONTH-FIRST on mdy', () => {
    const ctx = makeCtx({ dateFormat: 'mdy' });
    const { validCompetencies } = validateFile(fileWithDate('07/08/2027'), ctx);
    expect(validCompetencies[0]!.grantedAt.toISOString().slice(0, 10)).toBe('2027-07-08');
  });

  it('reads a hyphenated numeric date the same way as a slash one', () => {
    const ctx = makeCtx({ dateFormat: 'dmy' });
    const { validCompetencies } = validateFile(fileWithDate('07-08-2027'), ctx);
    expect(validCompetencies[0]!.grantedAt.toISOString().slice(0, 10)).toBe('2027-08-07');
  });

  it('reads an ISO date the same way regardless of dateFormat', () => {
    // The whole point of ISO: no organisation setting can change what it means.
    const dmy = validateFile(fileWithDate('2027-08-07'), makeCtx({ dateFormat: 'dmy' }));
    const mdy = validateFile(fileWithDate('2027-08-07'), makeCtx({ dateFormat: 'mdy' }));
    expect(dmy.validCompetencies[0]!.grantedAt.toISOString().slice(0, 10)).toBe('2027-08-07');
    expect(mdy.validCompetencies[0]!.grantedAt.toISOString().slice(0, 10)).toBe('2027-08-07');
  });

  it('rejects a day beyond the month it names rather than rolling into the next month', () => {
    // 31/02/2024 must not silently become 2 or 3 March.
    expect(reasons(fileWithDate('31/02/2024'))).toEqual(['bad_grant_date']);
  });

  it('rejects a month name or free text — no longer guessed via Date.parse', () => {
    expect(reasons(fileWithDate('August 7, 2027'))).toEqual(['bad_grant_date']);
  });
});
