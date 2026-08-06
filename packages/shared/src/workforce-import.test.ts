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
    ...over,
  };
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
});

describe('validateWorkforceImport — deliberate non-rejections and volume', () => {
  it('does NOT reject a row whose email already belongs to someone — U24 merges it (R148, R149)', () => {
    // Uniqueness is not a rejection reason; the validator has no notion of
    // "already exists", so a known address simply validates.
    const { validProfiles, rejected } = validateFile(profileFile({ email: 'existing@example.com' }));
    expect(rejected).toEqual([]);
    expect(validProfiles).toHaveLength(1);
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
