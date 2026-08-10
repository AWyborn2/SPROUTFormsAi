/**
 * Identity fills itself: `manifest.profilePrefill` maps text fields to profile
 * attributes, and everything downstream — the fill surface, the workflow's
 * writability rules, the export — reads that one declaration.
 *
 * THE GAP THIS CLOSES. `prefill` existed as a `ValueSource` that locked a
 * field, and nothing anywhere supplied the value: the only seeding in the
 * product was `candidateNameFieldId`, one box, at export only. An author could
 * mark "Candidate's Company Name" prefill and ship a box that was locked AND
 * blank — unwritable by everyone, filled by nothing.
 */
import { describe, expect, it } from 'vitest';
import type { AssessmentToolManifest } from './assessment.js';
import type { FormField } from './form-field.js';
import {
  profilePrefillValues,
  validatePrerequisiteChecks,
  validateProfilePrefill,
} from './assessment.js';
import { canWrite, sectionForPart, workflowFromFields, workflowOf } from './workflow.js';

const field = (id: string, type: FormField['type'] = 'text', label = id): FormField => ({
  id,
  type,
  label,
  required: false,
  source: 'imported',
});

describe('profilePrefillValues', () => {
  const manifest = {
    profilePrefill: {
      name: 'candidate_name',
      company: 'company_name',
      swipe: 'swipe_card',
      emp: 'employee_number',
    },
  } as Pick<AssessmentToolManifest, 'profilePrefill'>;

  it('maps every attribute onto its field', () => {
    expect(
      profilePrefillValues(manifest, {
        candidateName: 'A. Wyborn',
        companyName: 'Charles Hull Contracting',
        swipeCard: 'SC-0431',
        employeeNumber: 'E-77',
      }),
    ).toEqual({
      name: 'A. Wyborn',
      company: 'Charles Hull Contracting',
      swipe: 'SC-0431',
      emp: 'E-77',
    });
  });

  it('skips what the profile does not hold, rather than writing empties', () => {
    /*
      Absent leaves the field EMPTY, which reads as "not on file". An empty
      string stored as an answer reads as "answered with nothing", and on an
      evidence document those must stay distinguishable.
    */
    const values = profilePrefillValues(manifest, {
      candidateName: 'A. Wyborn',
      swipeCard: '   ',
      companyName: null,
    });

    expect(values).toEqual({ name: 'A. Wyborn' });
  });

  it('is empty for a manifest with no map', () => {
    expect(profilePrefillValues({}, { candidateName: 'A' })).toEqual({});
  });
});

describe('validateProfilePrefill', () => {
  const fields = [field('name'), field('sig', 'signature'), field('tick', 'check_cross')];

  it('accepts a text-field mapping', () => {
    expect(validateProfilePrefill({ name: 'candidate_name' }, fields)).toEqual([]);
  });

  it('refuses a field not in the version', () => {
    expect(validateProfilePrefill({ ghost: 'candidate_name' }, fields)).toHaveLength(1);
  });

  it('refuses an unknown attribute', () => {
    expect(validateProfilePrefill({ name: 'shoe_size' }, fields)).toHaveLength(1);
  });

  it('refuses a signature — an attestation is never typed by a machine', () => {
    expect(validateProfilePrefill({ sig: 'candidate_name' }, fields)).toHaveLength(1);
  });

  it('refuses a check_cross — a string cannot print as a mark', () => {
    expect(validateProfilePrefill({ tick: 'swipe_card' }, fields)).toHaveLength(1);
  });
});

describe('a mapped field inside a part is locked for everyone', () => {
  /*
    The mapping alone is the declaration. `derivedWorkflow` reads it into
    `fieldSource` as `prefill`, and `canWrite` refuses every non-`entry` field —
    so mapping a field is what locks it, with no second switch an author could
    forget.
  */
  const fields = [field('anchor'), field('swipe', 'text', 'Employee Swipe card Number')];
  const manifest: AssessmentToolManifest = {
    parts: [
      { key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'], startFieldId: 'anchor' },
    ],
    profilePrefill: { swipe: 'swipe_card' },
  };

  it('refuses candidate and assessor alike', () => {
    const section = sectionForPart(workflowOf(manifest, fields), 'p1')!;

    expect(canWrite(section, 'swipe', 'candidate')).toBe(false);
    expect(canWrite(section, 'swipe', 'assessor')).toBe(false);
  });

  it('leaves the unmapped neighbour writable', () => {
    const section = sectionForPart(workflowOf(manifest, fields), 'p1')!;

    expect(canWrite(section, 'anchor', 'candidate')).toBe(true);
  });
});

describe('workflowFromFields', () => {
  /*
    The rebuild path for tools published BEFORE the builder emitted workflows:
    the published fields still carry the author's grouping, because the
    structure editor writes a section_header per section and orders the fields
    beneath it.
  */
  const header = (id: string, label: string): FormField => ({
    id,
    type: 'section_header',
    label,
    required: false,
    source: 'built',
  });
  const published: FormField[] = [
    header('h-details', 'Candidate Details'),
    field('name'),
    field('swipe'),
    header('h-theory', 'Theory'),
    { ...field('q1', 'checkbox_group'), answerKey: ['a'], outcomeTarget: { fieldId: 'q1-out' } },
    field('q1-out', 'check_cross'),
    header('h-prereq', 'Prerequisites'),
    field('prereq', 'check_cross'),
  ];
  const manifest: AssessmentToolManifest = {
    parts: [
      { key: 'p_theory', ordinal: 1, label: 'Theory', kind: 'theory', pathways: ['new'], startFieldId: 'q1' },
    ],
    profilePrefill: { name: 'candidate_name', swipe: 'swipe_card' },
  };
  const rebuilt = workflowFromFields(published, manifest);

  it('reconstructs one section per printed header, in order', () => {
    expect(rebuilt.sections.map((s) => s.label)).toEqual([
      'Candidate Details',
      'Theory',
      'Prerequisites',
    ]);
  });

  it('ties the section containing a part anchor to that part', () => {
    const theory = rebuilt.sections.find((s) => s.label === 'Theory')!;

    expect(theory.partKey).toBe('p_theory');
    // And the outcome cell comes out locked — a stored workflow bypasses the
    // derived default, so the rebuild must lock it itself.
    expect(canWrite(theory, 'q1-out', 'candidate')).toBe(false);
  });

  it('gives cover sections their fields and locks the mapped ones', () => {
    const details = rebuilt.sections.find((s) => s.label === 'Candidate Details')!;

    expect(details.fieldIds).toEqual(['name', 'swipe']);
    expect(canWrite(details, 'name', 'candidate')).toBe(false);
  });

  it('puts fields before any header into a Front page section', () => {
    const w = workflowFromFields([field('loose'), ...published], manifest);

    expect(w.sections[0]!.label).toBe('Front page');
    expect(w.sections[0]!.fieldIds).toEqual(['loose']);
  });
});

describe('validatePrerequisiteChecks', () => {
  /*
    A prerequisite maps a printed ✓/✗ box to a competency in the register.
    The box must exist and must be able to CARRY a verdict — mapping a text
    field would print the register's answer as nothing at all.
  */
  const fields = [field('prereq', 'check_cross'), field('name'), field('yn', 'boolean_yes_no')];

  it('accepts a check_cross and a boolean_yes_no', () => {
    expect(
      validatePrerequisiteChecks(
        [
          { fieldId: 'prereq', competencyId: 'c1' },
          { fieldId: 'yn', competencyId: 'c2' },
        ],
        fields,
      ),
    ).toEqual([]);
  });

  it('refuses a field not in the version', () => {
    expect(validatePrerequisiteChecks([{ fieldId: 'ghost', competencyId: 'c1' }], fields)).toHaveLength(1);
  });

  it('refuses a text field — the verdict needs a box to land in', () => {
    expect(validatePrerequisiteChecks([{ fieldId: 'name', competencyId: 'c1' }], fields)).toHaveLength(1);
  });

  it('refuses a check with no competency', () => {
    expect(validatePrerequisiteChecks([{ fieldId: 'prereq', competencyId: '' }], fields)).toHaveLength(1);
  });

  it('refuses two checks on one box — one box answers one claim', () => {
    expect(
      validatePrerequisiteChecks(
        [
          { fieldId: 'prereq', competencyId: 'c1' },
          { fieldId: 'prereq', competencyId: 'c2' },
        ],
        fields,
      ),
    ).toHaveLength(1);
  });
});
