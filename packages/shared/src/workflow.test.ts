/**
 * Who may see and write each field, and what opens when.
 *
 * These pin the rules the customer stated, in their words:
 *
 *   · the candidate fills nothing in the practical parts
 *   · assessor-owned fields are VISIBLE but read-only to the candidate — they
 *     are entitled to see the standard they are being held to
 *   · locked sections are hidden from the candidate entirely
 *   · a supervisor may countersign, so nothing may assume exactly two roles
 *   · "gating will mandate everything" — a dependency is enforced, not advice
 *
 * The one that most needs a test is the quiet one: a candidate must never be
 * able to write a field the assessor owns, and the cascade that decides it runs
 * through two levels of configuration.
 */
import { describe, expect, it } from 'vitest';
import type { AssessmentToolManifest } from './assessment.js';
import {
  assessorMarkBoxIds,
  autoSourcesFor,
  canWrite,
  derivedWorkflow,
  effectiveAccess,
  orderedSections,
  validateWorkflow,
  valueSource,
  workflowOf,
  type AssessmentWorkflow,
  type WorkflowSection,
} from './workflow.js';
import type { FormField } from './form-field.js';

const field = (id: string): FormField => ({
  id,
  type: 'text',
  label: id,
  required: false,
  source: 'imported',
});

const FIELDS = ['q1', 'q2', 'crit1', 'crit2', 'decl-sig', 'hours'].map(field);

const MANIFEST: AssessmentToolManifest = {
  parts: [
    { key: 'p1-theory', ordinal: 1, label: 'Part 1 — Theory', kind: 'theory', pathways: ['new'], startFieldId: 'q1' },
    { key: 'p2-prac', ordinal: 2, label: 'Part 2 — Practical', kind: 'practical', pathways: ['new'], startFieldId: 'crit1' },
  ],
};

const section = (over: Partial<WorkflowSection> & Pick<WorkflowSection, 'key' | 'ordinal'>): WorkflowSection => ({
  label: over.key,
  access: {},
  ...over,
});

describe('effectiveAccess — the section/field cascade', () => {
  const practical = section({
    key: 'prac',
    ordinal: 2,
    partKey: 'p2-prac',
    // The customer's rule: the candidate fills nothing here, but sees it.
    access: { candidate: 'view', assessor: 'fill' },
  });

  it('a field with no override follows its section', () => {
    expect(effectiveAccess(practical, 'crit1', 'candidate')).toBe('view');
    expect(effectiveAccess(practical, 'crit1', 'assessor')).toBe('fill');
  });

  it('an explicit override wins', () => {
    const withNote = { ...practical, fieldAccess: { crit2: { candidate: 'hidden' as const } } };

    expect(effectiveAccess(withNote, 'crit2', 'candidate')).toBe('hidden');
    // …and only for the role it names.
    expect(effectiveAccess(withNote, 'crit2', 'assessor')).toBe('fill');
  });

  it('an explicit "inherit" is the same as no override', () => {
    /*
      Stored explicitly rather than represented by absence: an author who later
      changes the section expects inheriting fields to move with it, and a field
      that had been silently defaulted could not be told from one deliberately
      pinned to the same value.
    */
    const inheriting = { ...practical, fieldAccess: { crit1: { candidate: 'inherit' as const } } };

    expect(effectiveAccess(inheriting, 'crit1', 'candidate')).toBe('view');
  });

  it('a role the section says nothing about is hidden', () => {
    // Not "fill by omission". A role nobody granted anything gets nothing.
    expect(effectiveAccess(practical, 'crit1', 'supervisor')).toBe('hidden');
  });
});

describe('canWrite', () => {
  const practical = section({
    key: 'prac',
    ordinal: 2,
    partKey: 'p2-prac',
    access: { candidate: 'view', assessor: 'fill' },
  });

  it('THE RULE THAT MATTERS — a candidate cannot write the practical checklist', () => {
    // The live hole this configuration exists to close: today the save route
    // asks who owns the case, never who owns the field.
    expect(canWrite(practical, 'crit1', 'candidate')).toBe(false);
    expect(canWrite(practical, 'crit1', 'assessor')).toBe(true);
  });

  it('refuses a prefilled field to everyone, whatever the access says', () => {
    /*
      The value comes from the case record — this is what already happens to the
      printed candidate name. Accepting a typed one would let somebody overwrite
      the name of the person being certified, with nothing to say they had.
    */
    const withPrefill = {
      ...practical,
      access: { candidate: 'fill' as const, assessor: 'fill' as const },
      fieldSource: { crit1: 'prefill' as const },
    };

    expect(effectiveAccess(withPrefill, 'crit1', 'candidate')).toBe('fill');
    expect(canWrite(withPrefill, 'crit1', 'candidate')).toBe(false);
    expect(canWrite(withPrefill, 'crit1', 'assessor')).toBe(false);
  });

  it('refuses an auto-marked field to everyone', () => {
    // Computed from marking. A typed value would be a person overruling the
    // arithmetic without the record showing an override.
    const auto = {
      ...practical,
      access: { assessor: 'fill' as const },
      fieldSource: { crit2: 'auto' as const },
    };

    expect(canWrite(auto, 'crit2', 'assessor')).toBe(false);
  });

  it('defaults a field with no stated source to entry', () => {
    expect(valueSource(practical, 'crit1')).toBe('entry');
    expect(canWrite(practical, 'crit1', 'assessor')).toBe(true);
  });
});

describe('roles are a list', () => {
  it('supports a supervisor without any type or column change', () => {
    /*
      The customer asked for "maybe a supervisor sign-off option". Nothing here
      assumes a candidate/assessor pair — a third role is a value in an array,
      which is the difference between adding one now and rebuilding for it
      later.
    */
    const logbook = section({
      key: 'log',
      ordinal: 3,
      partKey: 'p1-theory',
      access: { candidate: 'fill', assessor: 'view', supervisor: 'fill' },
    });

    expect(canWrite(logbook, 'hours', 'candidate')).toBe(true);
    expect(canWrite(logbook, 'hours', 'supervisor')).toBe(true);
    expect(canWrite(logbook, 'hours', 'assessor')).toBe(false);
  });
});

describe('derivedWorkflow — what an unconfigured tool does', () => {
  it('gives one section per part, in document order', () => {
    const derived = derivedWorkflow(MANIFEST);

    expect(derived.sections.map((s) => s.partKey)).toEqual(['p1-theory', 'p2-prac']);
    expect(derived.sections.map((s) => s.ordinal)).toEqual([1, 2]);
  });

  it('reproduces today’s behaviour exactly — everyone fills everything', () => {
    /*
      Deliberately NOT inferred from part kind. Defaulting practicals to
      assessor-only would be a better guess and it would still be a guess, and
      quietly changing who may write a safety assessment is not a thing to do on
      a default. The hole is closed by scoping writes to the attempt's own part;
      this default changes nothing until somebody configures it.
    */
    const derived = derivedWorkflow(MANIFEST);
    const practical = derived.sections.find((s) => s.partKey === 'p2-prac')!;

    expect(canWrite(practical, 'crit1', 'candidate')).toBe(true);
    expect(canWrite(practical, 'crit1', 'assessor')).toBe(true);
  });

  it('is used when the manifest carries no workflow', () => {
    expect(workflowOf(MANIFEST).sections).toHaveLength(2);
  });

  it('is not used when one is configured', () => {
    const configured: AssessmentWorkflow = {
      roles: ['candidate'],
      sections: [section({ key: 'only', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'fill' } })],
    };

    expect(workflowOf({ ...MANIFEST, workflow: configured }).sections).toHaveLength(1);
  });
});

describe('orderedSections', () => {
  it('sorts by PROCESS position, which need not match the document', () => {
    // The declaration prints first and is signed last. That is the whole point
    // of the ordinal being separate from the part's printed number.
    const workflow: AssessmentWorkflow = {
      roles: ['candidate'],
      sections: [
        section({ key: 'declaration', ordinal: 9, fieldIds: ['decl-sig'], access: { candidate: 'fill' } }),
        section({ key: 'theory', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'fill' } }),
      ],
    };

    expect(orderedSections(workflow).map((s) => s.key)).toEqual(['theory', 'declaration']);
  });
});

describe('validateWorkflow', () => {
  const ok = (over: Partial<AssessmentWorkflow> = {}): AssessmentWorkflow => ({
    roles: ['candidate', 'assessor'],
    sections: [
      section({ key: 'theory', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'fill' } }),
      section({ key: 'prac', ordinal: 2, partKey: 'p2-prac', access: { assessor: 'fill' } }),
    ],
    ...over,
  });

  it('accepts a well-formed workflow', () => {
    expect(validateWorkflow(ok(), MANIFEST, FIELDS)).toEqual({ problems: [], warnings: [] });
  });

  it('refuses a section covering a part the tool does not have', () => {
    const bad = ok({
      sections: [section({ key: 's', ordinal: 1, partKey: 'p9-ghost', access: { candidate: 'fill' } })],
    });

    expect(validateWorkflow(bad, MANIFEST, FIELDS).problems.some((p) => p.includes('p9-ghost'))).toBe(true);
  });

  it('refuses a section naming a field that is not in this version', () => {
    // Ownership is stored as field ids and drifts against template versions.
    const bad = ok({
      sections: [section({ key: 's', ordinal: 1, fieldIds: ['gone'], access: { candidate: 'fill' } })],
    });

    expect(validateWorkflow(bad, MANIFEST, FIELDS).problems.some((p) => p.includes('gone'))).toBe(true);
  });

  it('refuses one field claimed by two sections', () => {
    // Both cannot be right about who writes it, and the answer would otherwise
    // depend on which section happened to be resolved first.
    const bad = ok({
      sections: [
        section({ key: 'a', ordinal: 1, fieldIds: ['decl-sig'], access: { candidate: 'fill' } }),
        section({ key: 'b', ordinal: 2, fieldIds: ['decl-sig'], access: { assessor: 'fill' } }),
      ],
    });

    expect(validateWorkflow(bad, MANIFEST, FIELDS).problems.some((p) => p.includes('decl-sig'))).toBe(true);
  });

  it('refuses a section covering nothing at all', () => {
    const bad = ok({ sections: [section({ key: 'empty', ordinal: 1, access: { candidate: 'fill' } })] });

    expect(validateWorkflow(bad, MANIFEST, FIELDS).problems.some((p) => p.includes('contains nothing'))).toBe(true);
  });

  it('refuses access granted to a role the workflow does not use', () => {
    const bad = ok({
      roles: ['candidate'],
      sections: [section({ key: 's', ordinal: 1, partKey: 'p1-theory', access: { supervisor: 'fill' } })],
    });

    expect(validateWorkflow(bad, MANIFEST, FIELDS).problems.some((p) => p.includes('supervisor'))).toBe(true);
  });

  it('refuses a dependency on a section that does not exist', () => {
    const bad = ok({
      sections: [section({ key: 's', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'fill' }, requires: ['nope'] })],
    });

    expect(validateWorkflow(bad, MANIFEST, FIELDS).problems.some((p) => p.includes('nope'))).toBe(true);
  });

  it('refuses a dependency loop, which would block both sections forever', () => {
    /*
      Gating mandates everything, so a loop is not a curiosity — it is two
      sections permanently closed with nothing on screen to say why.
    */
    const bad = ok({
      sections: [
        section({ key: 'a', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'fill' }, requires: ['b'] }),
        section({ key: 'b', ordinal: 2, partKey: 'p2-prac', access: { assessor: 'fill' }, requires: ['a'] }),
      ],
    });

    expect(validateWorkflow(bad, MANIFEST, FIELDS).problems.some((p) => p.includes('loop'))).toBe(true);
  });

  it('refuses a section that requires itself', () => {
    const bad = ok({
      sections: [section({ key: 'a', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'fill' }, requires: ['a'] })],
    });

    expect(validateWorkflow(bad, MANIFEST, FIELDS).problems.some((p) => p.includes('requires itself'))).toBe(true);
  });

  it('allows a dependency that points at an EARLIER-numbered section', () => {
    // Order and dependency are separate facts. A section may sit later than
    // something it does not depend on, and depend on something not adjacent.
    const fine = ok({
      sections: [
        section({ key: 'theory', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'fill' } }),
        section({ key: 'prac', ordinal: 2, partKey: 'p2-prac', access: { assessor: 'fill' }, requires: ['theory'] }),
      ],
    });

    expect(validateWorkflow(fine, MANIFEST, FIELDS).problems).toEqual([]);
  });

  it('WARNS rather than refusing when nobody fills a section', () => {
    // An unfinished configuration an author is entitled to save and return to —
    // but it can never be completed, so it must not pass silently.
    const unfinished = ok({
      sections: [
        section({ key: 'theory', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'view' } }),
        section({ key: 'prac', ordinal: 2, partKey: 'p2-prac', access: { assessor: 'fill' } }),
      ],
    });
    const result = validateWorkflow(unfinished, MANIFEST, FIELDS);

    expect(result.problems).toEqual([]);
    expect(result.warnings.some((w) => w.includes('Nobody fills'))).toBe(true);
  });

  it('WARNS when a part is covered by no section', () => {
    // The cover page's problem, surfaced in the builder instead of discovered
    // at export.
    const partial = ok({
      sections: [section({ key: 'theory', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'fill' } })],
    });
    const result = validateWorkflow(partial, MANIFEST, FIELDS);

    expect(result.problems).toEqual([]);
    expect(result.warnings.some((w) => w.includes('Part 2 — Practical'))).toBe(true);
  });

  it('refuses duplicate keys and duplicate process positions', () => {
    const bad = ok({
      sections: [
        section({ key: 'same', ordinal: 1, partKey: 'p1-theory', access: { candidate: 'fill' } }),
        section({ key: 'same', ordinal: 1, partKey: 'p2-prac', access: { assessor: 'fill' } }),
      ],
    });
    const { problems } = validateWorkflow(bad, MANIFEST, FIELDS);

    expect(problems.some((p) => p.includes('Duplicate section key'))).toBe(true);
    expect(problems.some((p) => p.includes('Duplicate process position'))).toBe(true);
  });

  it('the derived default is always valid', () => {
    // The migration proof: every existing tool gets this, so it must never
    // produce a problem that would block a save.
    expect(validateWorkflow(derivedWorkflow(MANIFEST), MANIFEST, FIELDS).problems).toEqual([]);
  });
});

/**
 * A DERIVED CELL IS NOBODY'S TO FILL.
 *
 * The unconfigured default gave candidate and assessor `fill` on every field of
 * a part — and a part's fields include the ✓/✗ OUTCOME CELLS. A published
 * assessment therefore showed the candidate "Outcome for Q5: [Satisfactory]
 * [Not satisfactory]" as two live buttons and let them press one. A person
 * could mark their own competency assessment, on the surface built to stop
 * exactly that.
 *
 * `auto` was already the mechanism for it — `canWrite` refuses a non-`entry`
 * field for every role — and the default simply never set it.
 */
describe('derivedWorkflow — a derived cell is nobody’s to fill', () => {
  const outcomeFields: FormField[] = [
    field('q1'),
    field('q1-out'),
    field('crit1'),
    field('verdict'),
  ];
  // KEYED, as every published target is on the tools that predate written
  // model answers: the auto-lock now turns on the key, because marking's loop
  // does — an unkeyed question's declared cell is the assessor's to tick, and
  // has its own suite below.
  const withOutcome: FormField[] = outcomeFields.map((f) =>
    f.id === 'q1' ? { ...f, answerKey: ['a'], outcomeTarget: { fieldId: 'q1-out' } } : f,
  );

  const marked: AssessmentToolManifest = {
    ...MANIFEST,
    parts: [
      { ...MANIFEST.parts[0]!, outcomeSatisfactory: { fieldId: 'verdict', value: true } },
      MANIFEST.parts[1]!,
    ],
    signOff: { overallSatisfactory: { fieldId: 'competent', value: true } },
  };

  const sectionOf = (workflow: ReturnType<typeof derivedWorkflow>, key: string) =>
    workflow.sections.find((s) => s.partKey === key)!;

  it('REFUSES A CANDIDATE THE ✓/✗ CELL OF THEIR OWN QUESTION', () => {
    const s = sectionOf(derivedWorkflow(marked, withOutcome), 'p1-theory');

    expect(canWrite(s, 'q1-out', 'candidate')).toBe(false);
    // The question itself is still theirs to answer.
    expect(canWrite(s, 'q1', 'candidate')).toBe(true);
  });

  it('refuses the ASSESSOR too, because marking overwrites it either way', () => {
    // A typed outcome was never going to survive `markTheory`; refusing the
    // keystroke loses nothing and stops the value looking authored.
    const s = sectionOf(derivedWorkflow(marked, withOutcome), 'p1-theory');

    expect(canWrite(s, 'q1-out', 'assessor')).toBe(false);
  });

  it('refuses the part’s own verdict box', () => {
    const s = sectionOf(derivedWorkflow(marked, withOutcome), 'p1-theory');

    expect(canWrite(s, 'verdict', 'candidate')).toBe(false);
  });

  it('REFUSES THE FRONT-PAGE CERTIFICATION TO A CANDIDATE', () => {
    // Pressing "Candidate Competent" on the fill surface would be certifying
    // yourself.
    const s = sectionOf(derivedWorkflow(marked, withOutcome), 'p1-theory');

    expect(canWrite(s, 'competent', 'candidate')).toBe(false);
  });

  it('scopes a cell to the part it is printed in', () => {
    // Part 2 declares no marks, so nothing of its own is locked.
    const s = sectionOf(derivedWorkflow(marked, withOutcome), 'p2-prac');

    expect(canWrite(s, 'crit1', 'candidate')).toBe(true);
  });

  it('LEAVES A TOOL THAT DECLARES NONE OF THIS EXACTLY AS IT WAS', () => {
    // The property that makes this safe as a default: an existing tool with no
    // outcome targets and no declared marks behaves byte-identically.
    const before = derivedWorkflow(MANIFEST);
    const after = derivedWorkflow(MANIFEST, FIELDS);

    expect(after).toEqual(before);
    expect(canWrite(sectionOf(after, 'p1-theory'), 'q1', 'candidate')).toBe(true);
  });

  it('cannot lock a cell it was never given the fields to see', () => {
    /*
      Honest about the limit. `outcomeTarget` lives on the QUESTION, so a caller
      that passes no fields gets the old behaviour for those cells — which is
      why every fill and save path now passes them.
    */
    const s = sectionOf(derivedWorkflow(marked), 'p1-theory');

    expect(canWrite(s, 'q1-out', 'candidate')).toBe(true);
    // The manifest-declared ones are locked regardless.
    expect(canWrite(s, 'verdict', 'candidate')).toBe(false);
  });
});

/**
 * THE KEYED/UNKEYED LOCK SPLIT. "If marking will write it, nobody types it"
 * stays literally true — and marking only writes KEYED questions' cells. An
 * unkeyed written question's declared ✓/✗ box is one marking will never touch:
 * locking it `auto` made it a box nobody could fill (not the machine — no key;
 * not a person — `canWrite` refuses non-`entry`), a permanently blank cell on
 * an evidence document. It is the ASSESSOR'S to tick after judging the answer
 * against the model answer, and the candidate may see but never press it.
 */
describe('the keyed/unkeyed lock split — written questions’ cells belong to the assessor', () => {
  const writtenQ = (id: string): FormField => ({
    ...field(id),
    type: 'textarea',
    modelAnswer: `Model answer for ${id}`,
    outcomeTarget: { fieldId: `${id}-out` },
  });
  const keyedQ = (id: string): FormField => ({
    ...field(id),
    type: 'radio',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: `${id}-out` },
  });

  // A mixed part in miniature: one written (unkeyed, targeted), one keyed.
  const mixed: FormField[] = [
    writtenQ('w1'),
    { ...field('w1-out'), type: 'check_cross' },
    keyedQ('k1'),
    { ...field('k1-out'), type: 'check_cross' },
  ];
  const manifest: AssessmentToolManifest = {
    parts: [
      { key: 'p1', ordinal: 1, label: 'Part 1', kind: 'theory', pathways: ['new'], startFieldId: 'w1' },
    ],
  };
  const part = manifest.parts[0]!;

  it('autoSourcesFor locks the keyed cell and leaves the unkeyed one to a person', () => {
    const sources = autoSourcesFor(manifest, part, mixed);

    expect(sources['k1-out']).toBe('auto');
    expect(sources['w1-out']).toBeUndefined();
  });

  it('assessorMarkBoxIds names exactly the unkeyed questions’ targets', () => {
    expect(assessorMarkBoxIds(manifest, part, mixed)).toEqual(['w1-out']);
  });

  it('deduplicates a shared target — two written questions marking into one table', () => {
    const shared: FormField[] = [
      { ...writtenQ('w1'), outcomeTarget: { fieldId: 'table', rowKey: 'q1', columnKey: 'result' } },
      { ...writtenQ('w2'), outcomeTarget: { fieldId: 'table', rowKey: 'q2', columnKey: 'result' } },
      { ...field('table'), type: 'repeating_group' },
    ];

    expect(assessorMarkBoxIds(manifest, part, shared)).toEqual(['table']);
  });

  it('THE ASSESSOR MAY TICK THE WRITTEN QUESTION’S BOX; THE CANDIDATE MAY ONLY SEE IT', () => {
    const s = derivedWorkflow(manifest, mixed).sections[0]!;

    expect(canWrite(s, 'w1-out', 'assessor')).toBe(true);
    expect(canWrite(s, 'w1-out', 'candidate')).toBe(false);
    // Seen, not hidden: the candidate is entitled to see the standard being
    // applied to them — view and hidden are different answers on purpose.
    expect(effectiveAccess(s, 'w1-out', 'candidate')).toBe('view');
    // The question itself stays the candidate's to answer.
    expect(canWrite(s, 'w1', 'candidate')).toBe(true);
  });

  it('the keyed neighbour’s cell stays locked for everyone', () => {
    const s = derivedWorkflow(manifest, mixed).sections[0]!;

    expect(canWrite(s, 'k1-out', 'candidate')).toBe(false);
    expect(canWrite(s, 'k1-out', 'assessor')).toBe(false);
  });

  it('A TOOL WITH NO UNKEYED TARGETS EMITS THE EXACT WORKFLOW IT ALWAYS DID', () => {
    /*
      The regression pin that makes the split safe to ship: every tool
      published before written model answers keys every target, so its derived
      workflow must not change by a byte — no `fieldAccess` key appearing, no
      reordered sources. Deep-equal against the hand-written pre-change shape.
    */
    const allKeyed: FormField[] = [
      keyedQ('k1'),
      { ...field('k1-out'), type: 'check_cross' },
      keyedQ('k2'),
      { ...field('k2-out'), type: 'check_cross' },
    ];
    const keyedManifest: AssessmentToolManifest = {
      parts: [
        { key: 'p1', ordinal: 1, label: 'Part 1', kind: 'theory', pathways: ['new'], startFieldId: 'k1' },
      ],
    };

    expect(derivedWorkflow(keyedManifest, allKeyed)).toEqual({
      roles: ['candidate', 'assessor'],
      sections: [
        {
          key: 'p1',
          ordinal: 1,
          label: 'Part 1',
          partKey: 'p1',
          access: { candidate: 'fill', assessor: 'fill' },
          fieldSource: { 'k1-out': 'auto', 'k2-out': 'auto' },
        },
      ],
    });
    expect('fieldAccess' in derivedWorkflow(keyedManifest, allKeyed).sections[0]!).toBe(false);
  });
});
