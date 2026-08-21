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
  missingDeclarationFields,
  profilePrefillValues,
  unplacedMarkDestinations,
  validateManifest,
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

  it('a MIXED part: the written question’s cell is assessor-fill / candidate-view; the keyed cell is auto', () => {
    /*
      The written-model-answers shape: a keyed choice question (its cell the
      machine's, locked `auto` for everyone) beside an unkeyed written question
      whose declared cell the ASSESSOR ticks and the candidate may only see.
    */
    const mixed: FormField[] = [
      header('h-mix', 'Mixed Theory'),
      { ...field('qk', 'checkbox_group'), answerKey: ['a'], outcomeTarget: { fieldId: 'qk-out' } },
      field('qk-out', 'check_cross'),
      { ...field('qw', 'textarea'), modelAnswer: 'the guide', outcomeTarget: { fieldId: 'qw-out' } },
      field('qw-out', 'check_cross'),
    ];
    const m: AssessmentToolManifest = {
      parts: [
        { key: 'mix', ordinal: 1, label: 'Mixed', kind: 'theory', pathways: ['new'], startFieldId: 'qk' },
      ],
    };

    const section = workflowFromFields(mixed, m).sections.find((s) => s.partKey === 'mix')!;

    // The written cell: the assessor's pen, the candidate's eyes only.
    expect(canWrite(section, 'qw-out', 'assessor')).toBe(true);
    expect(canWrite(section, 'qw-out', 'candidate')).toBe(false);
    expect(section.fieldAccess).toEqual({ 'qw-out': { candidate: 'view' } });
    // The keyed cell is marking's to write — nobody types it.
    expect(canWrite(section, 'qk-out', 'assessor')).toBe(false);
    expect(canWrite(section, 'qk-out', 'candidate')).toBe(false);
  });

  it('an ALL-KEYED part emits no fieldAccess key at all — the pre-model-answer shape, byte-identical', () => {
    const section = rebuilt.sections.find((s) => s.partKey === 'p_theory')!;

    expect('fieldAccess' in section).toBe(false);
  });

  it('skips headers with no fields beneath them', () => {
    const withEmpties: FormField[] = [
      header('h-details', 'Candidate Details'),
      field('name'),
      header('h-empty1', 'Empty Section A'),
      header('h-empty2', 'Empty Section B'),
      header('h-theory', 'Theory'),
      { ...field('q1', 'checkbox_group'), answerKey: ['a'], outcomeTarget: { fieldId: 'q1-out' } },
      field('q1-out', 'check_cross'),
    ];
    const w = workflowFromFields(withEmpties, manifest);

    expect(w.sections.map((s) => s.label)).toEqual([
      'Candidate Details',
      'Theory',
    ]);
    expect(w.sections[0]!.ordinal).toBe(1);
    expect(w.sections[1]!.ordinal).toBe(2);
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

describe('manifest.fieldDefaults validation', () => {
  it('refuses a default naming a field the version lacks', () => {
    /*
      Checked in validateManifest with the other pointer checks: a default onto
      a ghost id would be carried forever and applied to nothing, and the
      author who mistyped it would never learn why the preset does not show.
    */
    const manifest: AssessmentToolManifest = {
      parts: [
        { key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'], startFieldId: 'a' },
      ],
      fieldDefaults: { ghost: 'x' },
    };
    const problems = validateManifest(manifest, [field('a')]);

    expect(problems.some((p) => p.includes('Default answer names field "ghost"'))).toBe(true);
  });
});

describe('unplacedMarkDestinations', () => {
  /*
    The exporter skips a field with no geometry SILENTLY — the right failure on
    the page, and an invisible one everywhere else. Thirty ✓/✗ cells can carry
    thirty computed verdicts that print nowhere, and nothing says so. This is
    the audit that says so, with the exporter's own resolver deciding what
    "placed" means.
  */
  const box = { page: 0, x: 40, y: 60, width: 20, height: 14, pageWidth: 600, pageHeight: 800 };
  const placed = (id: string, type: FormField['type'] = 'check_cross'): FormField => ({
    ...field(id, type),
    geometry: { segments: [box] },
  });
  const keyed = (id: string, target: string): FormField => ({
    ...placed(id, 'checkbox_group'),
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: target },
  });
  const manifest: AssessmentToolManifest = {
    parts: [
      { key: 'p1', ordinal: 1, label: 'Theory', kind: 'theory', pathways: ['new'], startFieldId: 'q' },
    ],
  };

  it('names the ✓/✗ box a question would mark into but nobody placed', () => {
    const warnings = unplacedMarkDestinations(manifest, [keyed('q', 'q-out'), field('q-out', 'check_cross')]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('✓/✗ box');
    expect(warnings[0]).toContain('prints nowhere');
  });

  it('is silent when the box is placed', () => {
    expect(unplacedMarkDestinations(manifest, [keyed('q', 'q-out'), placed('q-out')])).toEqual([]);
  });

  it('treats a legacy sourcePosition as placed — the exporter draws it', () => {
    const legacy: FormField = { ...field('q-out', 'check_cross'), sourcePosition: box };

    expect(unplacedMarkDestinations(manifest, [keyed('q', 'q-out'), legacy])).toEqual([]);
  });

  it('reports a shared unplaced cell once, not once per question', () => {
    const warnings = unplacedMarkDestinations(manifest, [
      keyed('q', 'shared-out'),
      keyed('q2', 'shared-out'),
      field('shared-out', 'check_cross'),
    ]);

    expect(warnings).toHaveLength(1);
  });

  it('says nothing about a ghost id — that is validateManifest’s problem', () => {
    expect(unplacedMarkDestinations(manifest, [keyed('q', 'ghost')])).toEqual([]);
  });

  it('covers the manifest’s own destinations — verdicts, sign-off, prerequisites', () => {
    const withMarks: AssessmentToolManifest = {
      parts: [
        {
          ...manifest.parts[0]!,
          outcomeSatisfactory: { fieldId: 'v-yes', value: true },
          outcomeNotSatisfactory: { fieldId: 'v-no', value: true },
        },
      ],
      signOff: { overallSatisfactory: { fieldId: 'competent', value: true } },
      prerequisiteChecks: [{ fieldId: 'prereq', competencyId: 'c1' }],
      profilePrefill: { company: 'company_name' },
    };
    const fields = [
      keyed('q', 'q-out'),
      placed('q-out'),
      field('v-yes', 'check_cross'),
      placed('v-no'),
      field('competent', 'check_cross'),
      field('prereq', 'check_cross'),
      placed('company', 'text'),
    ];

    const warnings = unplacedMarkDestinations(withMarks, fields);

    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => w.includes('Satisfactory verdict'))).toBe(true);
    expect(warnings.some((w) => w.includes('Candidate Competent'))).toBe(true);
    expect(warnings.some((w) => w.includes('prerequisite'))).toBe(true);
  });
});

describe('missingDeclarationFields', () => {
  /*
    A declaration completes at hand-in with nobody judging it, so hand-in is
    the only gate — and "signed" must mean the required boxes actually hold
    something, or an empty tap on Submit auto-completes an attestation nobody
    made.
  */
  const manifest: AssessmentToolManifest = {
    parts: [
      {
        key: 'pd',
        ordinal: 1,
        label: 'Candidate declaration',
        kind: 'declaration',
        pathways: ['new'],
        startFieldId: 'h-decl',
      },
    ],
  };
  const fields: FormField[] = [
    { id: 'h-decl', type: 'section_header', label: 'Candidate declaration', required: false, source: 'imported' },
    { ...field('sig', 'signature', 'Candidate signature'), required: true },
    field('date', 'date', 'Date'),
  ];

  it('names the required boxes still empty', () => {
    expect(missingDeclarationFields(fields, manifest, 'pd', {})).toEqual([
      { id: 'sig', label: 'Candidate signature' },
    ]);
  });

  it('is satisfied once the signature holds a drawing', () => {
    expect(
      missingDeclarationFields(fields, manifest, 'pd', { sig: 'data:image/png;base64,iVBOR' }),
    ).toEqual([]);
  });

  it('treats whitespace as unsigned', () => {
    expect(missingDeclarationFields(fields, manifest, 'pd', { sig: '   ' })).toHaveLength(1);
  });

  it('never demands a box a condition hides', () => {
    const gated: FormField[] = [
      ...fields,
      {
        ...field('extra', 'text', 'Union rep name'),
        required: true,
        visibleWhen: { fieldId: 'date', op: 'equals', value: 'union' },
      },
    ];

    const missing = missingDeclarationFields(gated, manifest, 'pd', {
      sig: 'data:image/png;base64,iVBOR',
    });

    // 'extra' is hidden — its emptiness is not the candidate's to fix.
    expect(missing).toEqual([]);
  });
});
