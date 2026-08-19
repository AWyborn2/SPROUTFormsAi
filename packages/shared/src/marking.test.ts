/**
 * The exact-set-match rule and the mandatory-section gate are the two things a
 * candidate's competence turns on, so both directions of every boundary are
 * pinned here: subset wrong, superset wrong, exact right, blank wrong.
 *
 * Covers AE1 (multi-answer marking) and AE2 (the 100% mandatory-section rule).
 */
import { describe, expect, it } from 'vitest';
import type { AssessmentPart, AssessmentToolManifest } from './assessment.js';
import type { FormField } from './form-field.js';
import type { RepeatingRowValue, SubmissionValue } from './submission.js';
import {
  deriveChecklistOutcome,
  incorrectQuestionsNote,
  isSelfMarking,
  markTheory,
  stripMarkingSecrets,
} from './marking.js';

const header = (id: string, over: Partial<FormField> = {}): FormField => ({
  id,
  type: 'section_header',
  label: id,
  required: false,
  source: 'imported',
  ...over,
});

const outcome = (id: string): FormField => ({
  id,
  type: 'check_cross',
  label: id,
  required: false,
  source: 'imported',
});

const q = (id: string, answerKey: string[], target = `${id}-out`, over: Partial<FormField> = {}): FormField => ({
  id,
  type: 'checkbox_group',
  label: id,
  required: true,
  source: 'imported',
  options: ['a', 'b', 'c', 'd'],
  answerKey,
  outcomeTarget: { fieldId: target },
  ...over,
});

/** General section with two keyed questions, plus their outcome cells. */
const generalFields: FormField[] = [
  header('general'),
  q('g1', ['a']),
  outcome('g1-out'),
  q('g2', ['b', 'c']),
  outcome('g2-out'),
];

/** General is the must-pass set: both its questions, named explicitly. */
const part = { mandatoryFieldIds: ['g1', 'g2'] };

const run = (fields: FormField[], values: Record<string, SubmissionValue>) =>
  markTheory({ fields, values, part });

/** A checkbox_group question with no answer key — reaches an assessor. */
const unkeyed = (id: string, over: Partial<FormField> = {}): FormField => ({
  id,
  type: 'checkbox_group',
  label: id,
  required: true,
  source: 'imported',
  options: ['a', 'b', 'c', 'd'],
  ...over,
});

const signature = (id: string): FormField => ({
  id,
  type: 'signature',
  label: id,
  required: false,
  source: 'imported',
});

describe('isSelfMarking (U15)', () => {
  // A one-part manifest anchored at the first field, so `fieldsInPart` returns
  // the whole array as the part's slice.
  const selfMarks = (fields: FormField[]) => {
    const manifest: AssessmentToolManifest = {
      parts: [
        { key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'], startFieldId: fields[0]!.id },
      ],
    };
    return isSelfMarking(fields, manifest, 'p1');
  };

  it('is true when every real question carries a key — the interleaved outcome cells are furniture (R66)', () => {
    // generalFields interleaves each keyed question with its check_cross cell,
    // exactly as the real authored tool does — the case the literal predicate fails.
    expect(selfMarks(generalFields)).toBe(true);
  });

  it('ignores a section header and a signature box (R66)', () => {
    expect(selfMarks([header('h'), q('g1', ['a']), outcome('g1-out'), signature('sig')])).toBe(true);
  });

  it('is false when one question of several carries no key — routes to an assessor (R67)', () => {
    expect(selfMarks([header('h'), q('g1', ['a']), outcome('g1-out'), unkeyed('g2')])).toBe(false);
  });

  it('is false when no question carries a key, not satisfactory-with-nothing-checked (R68)', () => {
    expect(selfMarks([header('h'), unkeyed('g1'), unkeyed('g2')])).toBe(false);
  });

  it('is false for a part carrying no real question at all (R68)', () => {
    expect(selfMarks([header('h'), signature('sig')])).toBe(false);
  });

  it('is false for a practical demonstration — its criteria carry no key (R69)', () => {
    expect(selfMarks([header('prac'), unkeyed('c1'), unkeyed('c2'), unkeyed('c3')])).toBe(false);
  });

  /*
    DECLARING A PART'S VERDICT PAIR USED TO SWITCH OFF ITS AUTO-MARKING.

    "The Candidate's responses were: ☐ Satisfactory ☐ Not Satisfactory" prints
    at the END of a part, so it lands inside that part's slice. It carries no
    answer key because nobody keys it — `markTheory` WRITES it from the same
    arithmetic that produced the ✓/✗ above. But this test asked whether every
    question in the slice was keyed, saw an unkeyed field, and concluded a
    person had to judge the part.

    So the moment an author declared the pair the workflow needs, a fully-keyed
    30-question theory paper stopped marking itself and started demanding a
    manual verdict — the exact opposite of what declaring it was for, and
    silent.
  */
  const withVerdict = (fields: FormField[], part: Partial<AssessmentPart>) => {
    const manifest: AssessmentToolManifest = {
      parts: [
        {
          key: 'p1',
          ordinal: 1,
          label: 'P1',
          kind: 'theory',
          pathways: ['new'],
          startFieldId: fields[0]!.id,
          ...part,
        },
      ],
    };
    return isSelfMarking(fields, manifest, 'p1');
  };

  it('still self-marks when the part declares its own verdict pair', () => {
    const fields = [header('h'), q('g1', ['a']), outcome('g1-out'), unkeyed('verdict')];

    expect(
      withVerdict(fields, {
        outcomeSatisfactory: { fieldId: 'verdict', value: 'Satisfactory' },
        outcomeNotSatisfactory: { fieldId: 'verdict', value: 'Not Satisfactory' },
      }),
    ).toBe(true);
  });

  it('still self-marks when the part declares a further-action box', () => {
    // Written only on a not-satisfactory part, and never keyed.
    const fields = [header('h'), q('g1', ['a']), outcome('g1-out'), unkeyed('further')];

    expect(withVerdict(fields, { furtherActionFieldId: 'further' })).toBe(true);
  });

  it('still self-marks when the cover’s sign-off falls inside the slice', () => {
    const fields = [header('h'), q('g1', ['a']), outcome('g1-out'), unkeyed('result')];
    const manifest: AssessmentToolManifest = {
      parts: [
        { key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'], startFieldId: 'h' },
      ],
      signOff: {
        overallSatisfactory: { fieldId: 'result', value: 'Candidate Competent' },
        overallNotSatisfactory: { fieldId: 'result', value: 'Candidate not yet Competent' },
      },
    };

    expect(isSelfMarking(fields, manifest, 'p1')).toBe(true);
  });

  it('is STILL false for a genuinely unkeyed question beside a declared verdict', () => {
    /*
      The fix must not become a blanket exemption. A real question nobody keyed
      still routes the part to an assessor — otherwise declaring a verdict pair
      would buy a tool the right to mark itself against the keys it happens to
      hold, which is the R67 failure this whole predicate exists to prevent.
    */
    const fields = [header('h'), q('g1', ['a']), outcome('g1-out'), unkeyed('g2'), unkeyed('verdict')];

    expect(
      withVerdict(fields, {
        outcomeSatisfactory: { fieldId: 'verdict', value: 'Satisfactory' },
        outcomeNotSatisfactory: { fieldId: 'verdict', value: 'Not Satisfactory' },
      }),
    ).toBe(false);
  });
});

describe('exact set match', () => {
  it('marks an exact single-option answer correct', () => {
    const res = run(generalFields, { g1: ['a'], g2: ['b', 'c'] });

    expect(res.marks.find((m) => m.fieldId === 'g1')?.correct).toBe(true);
    expect(res.correctCount).toBe(2);
  });

  it('marks a strict subset of a multi-answer key incorrect', () => {
    const res = run(generalFields, { g1: ['a'], g2: ['b'] });

    expect(res.marks.find((m) => m.fieldId === 'g2')?.correct).toBe(false);
  });

  it('marks a superset incorrect even when every correct option is present', () => {
    const res = run(generalFields, { g1: ['a'], g2: ['b', 'c', 'd'] });

    expect(res.marks.find((m) => m.fieldId === 'g2')?.correct).toBe(false);
  });

  it('ignores selection order and duplicates', () => {
    const res = run(generalFields, { g1: ['a'], g2: ['c', 'b', 'b'] });

    expect(res.marks.find((m) => m.fieldId === 'g2')?.correct).toBe(true);
  });

  it('accepts a scalar answer for a single-option key', () => {
    const res = run(generalFields, { g1: 'a', g2: ['b', 'c'] });

    expect(res.marks.find((m) => m.fieldId === 'g1')?.correct).toBe(true);
  });

  it('normalises a boolean answer so a yes/no question can be keyed', () => {
    const fields = [header('general'), q('b1', ['true'], 'b1-out', { type: 'boolean_yes_no' }), outcome('b1-out')];

    expect(run(fields, { b1: true }).marks[0]?.correct).toBe(true);
    expect(run(fields, { b1: false }).marks[0]?.correct).toBe(false);
  });
});

describe('unanswered questions', () => {
  it('marks a missing answer incorrect rather than skipping it', () => {
    const res = run(generalFields, { g1: ['a'] });

    const g2 = res.marks.find((m) => m.fieldId === 'g2');
    expect(g2?.unanswered).toBe(true);
    expect(g2?.correct).toBe(false);
    expect(res.totalCount).toBe(2);
  });

  it('treats null and empty selections as unanswered', () => {
    expect(run(generalFields, { g1: null, g2: [] }).correctCount).toBe(0);
    expect(run(generalFields, { g1: null, g2: [] }).totalCount).toBe(2);
  });

  it('cannot reach a satisfactory outcome by answering nothing', () => {
    expect(run(generalFields, {}).outcome).toBe('not_satisfactory');
  });

  it('marks an attempt that was opened and never typed into', () => {
    // No value map at all, which is what an untouched attempt actually stores.
    // Refusing here would have left an assessor unable to fail a candidate who
    // wrote nothing — the one case where failing is least in doubt.
    for (const values of [null, undefined]) {
      const res = run(generalFields, values as never);

      expect(res.outcome).toBe('not_satisfactory');
      expect(res.correctCount).toBe(0);
      expect(res.totalCount).toBe(2);
      expect(res.marks.every((m) => m.unanswered)).toBe(true);
    }
  });
});

describe('mandatory section gate', () => {
  const withLocation: FormField[] = [
    ...generalFields,
    header('mining'),
    q('m1', ['d']),
    outcome('m1-out'),
  ];

  it('is satisfactory when every mandatory question is correct', () => {
    const res = run(withLocation, { g1: ['a'], g2: ['b', 'c'], m1: ['d'] });

    expect(res.mandatoryAllCorrect).toBe(true);
    expect(res.outcome).toBe('satisfactory');
  });

  it('is not satisfactory when one mandatory question is wrong, however good the rest', () => {
    const res = run(withLocation, { g1: ['b'], g2: ['b', 'c'], m1: ['d'] });

    expect(res.mandatoryAllCorrect).toBe(false);
    expect(res.outcome).toBe('not_satisfactory');
  });

  it('stays satisfactory when only a non-mandatory question is wrong', () => {
    const res = run(withLocation, { g1: ['a'], g2: ['b', 'c'], m1: ['a'] });

    expect(res.marks.find((m) => m.fieldId === 'm1')?.correct).toBe(false);
    expect(res.outcome).toBe('satisfactory');
  });

  /*
    AN EMPTY MUST-PASS SET USED TO PASS EVERYBODY, because `[].every(...)` is
    `true`. A theory part naming no mandatory questions — or naming some that
    were all hidden by the location stream, or all unkeyed — returned
    SATISFACTORY for a candidate who got every question on the paper wrong.
    Automatically, on a competency record, with no validator refusing the
    manifest and the printed verdict box ticked by the same code path as a
    genuine pass.
  */
  describe('when the must-pass set is empty', () => {
    const noMandatory = (values: Record<string, SubmissionValue>) =>
      markTheory({ fields: generalFields, values, part: {} });

    it('does NOT pass a candidate who got everything wrong', () => {
      const res = noMandatory({ g1: ['d'], g2: ['a'] });

      expect(res.correctCount).toBe(0);
      expect(res.outcome).toBe('not_satisfactory');
    });

    it('does not pass a candidate who answered nothing', () => {
      expect(noMandatory({}).outcome).toBe('not_satisfactory');
    });

    it('the whole part becomes the gate — one wrong answer fails it', () => {
      expect(noMandatory({ g1: ['a'], g2: ['a'] }).outcome).toBe('not_satisfactory');
    });

    it('still passes a perfect paper', () => {
      /*
        The fix must not become "always fail". An author who never narrowed the
        must-pass set has not said nothing matters — the natural reading of
        "every question in the must-pass set" when nobody narrowed it is every
        question. A blanket not_satisfactory would fail a candidate who got the
        whole paper right, which is its own way of being wrong.
      */
      expect(noMandatory({ g1: ['a'], g2: ['b', 'c'] }).outcome).toBe('satisfactory');
    });

    it('is not satisfactory when the part carries nothing to mark at all', () => {
      // "Satisfactory" here would be a claim about an assessment that did not
      // happen, and on this document that claim is a certificate.
      const res = markTheory({ fields: [header('h'), unkeyed('g1')], values: {}, part: {} });

      expect(res.marks).toHaveLength(0);
      expect(res.outcome).toBe('not_satisfactory');
    });

    it('applies equally when the named mandatory questions produced no marks', () => {
      /*
        The author DID declare a gate; none of it reached marking, because the
        ids name questions that are unkeyed. Treating that as "all mandatory
        questions correct" passes a candidate against a gate that never ran.
      */
      const res = markTheory({
        fields: generalFields,
        values: { g1: ['d'], g2: ['a'] },
        part: { mandatoryFieldIds: ['ghost'] },
      });

      expect(res.marks.some((m) => m.mandatory)).toBe(false);
      expect(res.outcome).toBe('not_satisfactory');
    });
  });

  it('marks location questions without treating them as mandatory', () => {
    const res = run(withLocation, { g1: ['a'], g2: ['b', 'c'], m1: ['d'] });

    expect(res.marks.find((m) => m.fieldId === 'm1')?.mandatory).toBe(false);
    expect(res.marks.find((m) => m.fieldId === 'g1')?.mandatory).toBe(true);
  });

  /*
    THIS TEST USED TO ASSERT THE OPPOSITE, and it was pinning the bug.

    It read "gates on nothing when the part declares no mandatory section" and
    expected SATISFACTORY from `{ g1: ['z'] }` — one question answered wrongly,
    one not answered at all. Its title described what the code did rather than
    what the rule should be, and there was no reasoning attached to it, so
    `[].every(...) === true` went unchallenged: on a competency record, a part
    with no must-pass set passed everybody.

    The behaviour it pinned is now the one case the gate must not allow. See
    "when the must-pass set is empty" above.
  */
  it('does not pass a wrong answer just because no mandatory section was named', () => {
    const res = markTheory({ fields: generalFields, values: { g1: ['z'] }, part: {} });

    expect(res.outcome).toBe('not_satisfactory');
  });
});

describe('unkeyed and hidden questions', () => {
  it('skips a question with no answer key without affecting the outcome', () => {
    const fields = [
      ...generalFields,
      { ...q('extra', []), answerKey: undefined, outcomeTarget: undefined } as FormField,
    ];

    const res = run(fields, { g1: ['a'], g2: ['b', 'c'], extra: ['z'] });

    expect(res.totalCount).toBe(2);
    expect(res.outcome).toBe('satisfactory');
  });

  it('skips a keyed question that has no outcome target', () => {
    const fields = [header('general'), { ...q('g9', ['a']), outcomeTarget: undefined } as FormField];

    expect(run(fields, { g9: ['a'] }).totalCount).toBe(0);
  });

  it('does not mark questions hidden by the location stream', () => {
    const fields: FormField[] = [
      { id: 'stream', type: 'dropdown', label: 'Stream', required: true, source: 'imported', options: ['mining', 'raw'] },
      ...generalFields,
      header('rawOnly', { visibleWhen: { fieldId: 'stream', op: 'equals', value: 'raw' } }),
      q('r1', ['a']),
      outcome('r1-out'),
    ];

    const res = run(fields, { stream: 'mining', g1: ['a'], g2: ['b', 'c'] });

    expect(res.marks.some((m) => m.fieldId === 'r1')).toBe(false);
    expect(res.outcome).toBe('satisfactory');
  });
});

describe('derived values', () => {
  it('writes each mark onto its scalar outcome field', () => {
    const res = run(generalFields, { g1: ['a'], g2: ['b'] });

    expect(res.derivedValues['g1-out']).toBe(true);
    expect(res.derivedValues['g2-out']).toBe(false);
  });

  it('preserves the candidate answers alongside the derived marks', () => {
    const res = run(generalFields, { g1: ['a'], g2: ['b', 'c'] });

    expect(res.derivedValues.g1).toEqual(['a']);
  });

  it('writes a repeating-cell target into the addressed row and column', () => {
    const fields: FormField[] = [
      header('general'),
      q('g1', ['a'], 'table', {
        outcomeTarget: { fieldId: 'table', rowKey: 'q1', columnKey: 'result' },
      }),
      { id: 'table', type: 'repeating_group', label: 'Outcomes', required: false, source: 'imported' },
    ];

    const rows = run(fields, { g1: ['a'] }).derivedValues.table as RepeatingRowValue[];

    expect(rows).toEqual([{ __key: 'q1', result: true }]);
  });

  it('updates an existing row rather than appending a duplicate', () => {
    const fields: FormField[] = [
      header('general'),
      q('g1', ['a'], 'table', {
        outcomeTarget: { fieldId: 'table', rowKey: 'q1', columnKey: 'result' },
      }),
      { id: 'table', type: 'repeating_group', label: 'Outcomes', required: false, source: 'imported' },
    ];

    const rows = run(fields, {
      g1: ['b'],
      table: [{ __key: 'q1', note: 'kept', result: true }],
    }).derivedValues.table as RepeatingRowValue[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ __key: 'q1', note: 'kept', result: false });
  });

  it('does not mutate the values it was given', () => {
    const values = { g1: ['a'], g2: ['b', 'c'] };

    run(generalFields, values);

    expect(values).toEqual({ g1: ['a'], g2: ['b', 'c'] });
    expect('g1-out' in values).toBe(false);
  });
});

/**
 * `answerKey` is the complete answer key to a safety assessment. The property
 * pinned here is that a fill surface can never be served it: stripping removes
 * both marking properties, leaves everything else intact, and is a no-op copy
 * only when something actually carried a secret.
 */
describe('stripMarkingSecrets', () => {
  it('removes answerKey and outcomeTarget, keeping the rest of the field', () => {
    const fields = [q('g1', ['a']), outcome('g1-out')];

    const stripped = stripMarkingSecrets(fields);

    const g1 = stripped.find((f) => f.id === 'g1');
    expect(g1?.answerKey).toBeUndefined();
    expect(g1?.outcomeTarget).toBeUndefined();
    expect(g1?.options).toEqual(['a', 'b', 'c', 'd']);
    expect(g1?.label).toBe('g1');
  });

  it('returns the same array when nothing carries a secret', () => {
    const fields = [header('general'), outcome('o1')];

    expect(stripMarkingSecrets(fields)).toBe(fields);
  });

  it('does not mutate the original fields', () => {
    const fields = [q('g1', ['a', 'b'])];

    stripMarkingSecrets(fields);

    expect(fields[0]?.answerKey).toEqual(['a', 'b']);
  });
});

/* ------------------------------------------------------------------ *
 * The part's own verdict, and what goes in "Detail further action"
 * ------------------------------------------------------------------ */

/**
 * A keyed theory part decides its own verdict, so the boxes that state it
 * should be written from the same arithmetic — not transcribed.
 *
 * "The Candidate's responses were: ☐ Satisfactory ☐ Not Satisfactory" is
 * printed at the end of every part of this paper, and on a fully-keyed part it
 * restates a sum the marking already did. An assessor ticking it by hand after
 * thirty questions is doing the slowest and least reliable step of marking for
 * no information gain.
 */
describe('markTheory — the part verdict box', () => {
  const verdictPart = {
    mandatoryFieldIds: ['g1', 'g2'],
    outcomeSatisfactory: { fieldId: 'verdict', value: true },
    outcomeNotSatisfactory: { fieldId: 'verdict', value: false },
  };

  const mark = (values: Record<string, SubmissionValue>, over = {}) =>
    markTheory({ fields: generalFields, values, part: { ...verdictPart, ...over } });

  it('TICKS SATISFACTORY WHEN EVERY MANDATORY QUESTION IS RIGHT', () => {
    const res = mark({ g1: ['a'], g2: ['b', 'c'] });

    expect(res.outcome).toBe('satisfactory');
    expect(res.derivedValues.verdict).toBe(true);
  });

  it('crosses it when one is wrong', () => {
    const res = mark({ g1: ['a'], g2: ['c'] });

    expect(res.outcome).toBe('not_satisfactory');
    expect(res.derivedValues.verdict).toBe(false);
  });

  it('crosses it when one is unanswered', () => {
    // A blank is not a question that did not happen.
    const res = mark({ g1: ['a'] });

    expect(res.derivedValues.verdict).toBe(false);
  });

  it('WRITES EXACTLY ONE HALF WHEN THE PAIR IS TWO SEPARATE BOXES', () => {
    /*
      A form may print two boxes rather than one ✓/✗ cell. Ticking both, or
      deriving one from the other's absence, would leave the record saying two
      things or nothing.
    */
    const res = mark({ g1: ['a'], g2: ['b', 'c'] }, {
      outcomeSatisfactory: { fieldId: 'sat', value: true },
      outcomeNotSatisfactory: { fieldId: 'notSat', value: true },
    });

    expect(res.derivedValues.sat).toBe(true);
    expect(res.derivedValues.notSat).toBeUndefined();
  });

  it('WRITES NOTHING EXTRA FOR A PART THAT DECLARES NO VERDICT BOX', () => {
    /*
      The property that makes this safe to add to a file that marks competency
      records: every tool authored before these fields existed marks exactly as
      it did, the per-question ✓/✗ and nothing else.
    */
    const before = markTheory({ fields: generalFields, values: { g1: ['a'], g2: ['b', 'c'] }, part });
    const after = mark({ g1: ['a'], g2: ['b', 'c'] }, { outcomeSatisfactory: undefined, outcomeNotSatisfactory: undefined });

    expect(after.derivedValues).toEqual(before.derivedValues);
  });
});

describe('markTheory — Detail further action', () => {
  const withAction = {
    mandatoryFieldIds: ['g1', 'g2'],
    outcomeSatisfactory: { fieldId: 'verdict', value: true },
    outcomeNotSatisfactory: { fieldId: 'verdict', value: false },
    furtherActionFieldId: 'action',
  };

  const mark = (values: Record<string, SubmissionValue>) =>
    markTheory({ fields: generalFields, values, part: withAction });

  it('LISTS THE QUESTIONS THE CANDIDATE GOT WRONG', () => {
    const res = mark({ g1: ['a'], g2: ['c'] });

    expect(res.derivedValues.action).toContain('Answered incorrectly');
    expect(res.derivedValues.action).toContain('g2');
    expect(res.derivedValues.action).not.toContain('g1');
  });

  it('TELLS A WRONG ANSWER FROM A BLANK ONE', () => {
    /*
      They call for different coaching — a wrong answer is a misunderstanding to
      correct, a blank is a question the candidate never reached — and this is
      the one document that records which happened.
    */
    const res = mark({ g1: ['c'] });

    expect(res.derivedValues.action).toContain('Answered incorrectly: g1.');
    expect(res.derivedValues.action).toContain('Not answered: g2.');
  });

  it('writes nothing on a satisfactory part', () => {
    // An empty box beside a passed assessment is correct; "None" is a sentence
    // nobody wrote.
    const res = mark({ g1: ['a'], g2: ['b', 'c'] });

    expect(res.derivedValues.action).toBeUndefined();
  });

  it('NEVER OVERWRITES WHAT AN ASSESSOR ALREADY TYPED', () => {
    /*
      A person who has written in that box has said something this cannot
      improve on. Overwriting their words on a competency record is not a thing
      an automatic mark may do.
    */
    const res = mark({ g1: ['a'], g2: ['c'], action: 'Refer to supervisor before retry.' });

    expect(res.derivedValues.action).toBe('Refer to supervisor before retry.');
  });
});

describe('incorrectQuestionsNote', () => {
  const fields: FormField[] = [
    q('short', ['a'], 'short-out', { label: '7. Which sign means STOP?' }),
    q('long', ['a'], 'long-out', {
      label:
        'Identify every one of the principal mining hazards that are relevant to the operation of a track dozer on this site',
    }),
  ];

  const marksFor = (values: Record<string, SubmissionValue>) =>
    markTheory({ fields, values, part: { mandatoryFieldIds: ['short', 'long'] } }).marks;

  it('names a question by its printed label, which carries the number', () => {
    const note = incorrectQuestionsNote(marksFor({ short: ['b'], long: ['a'] }), fields);

    expect(note).toBe('Answered incorrectly: 7. Which sign means STOP?.');
  });

  it('CUTS A LONG LABEL AT A WORD BOUNDARY', () => {
    // This lands in a printed box a couple of lines high, and an overrun draws
    // over whatever is beneath it.
    const note = incorrectQuestionsNote(marksFor({ short: ['a'], long: ['b'] }), fields);

    expect(note.length).toBeLessThan(100);
    const kept = note.slice('Answered incorrectly: '.length, note.indexOf('…'));
    const label = fields[1]!.label;
    // A prefix of the real label, ending where the label has a space — a
    // mid-word cut would leave half a hazard name on a competency record.
    expect(label.startsWith(kept)).toBe(true);
    expect(label[kept.length]).toBe(' ');
  });

  it('is empty when nothing was missed, so the caller writes nothing', () => {
    expect(incorrectQuestionsNote(marksFor({ short: ['a'], long: ['a'] }), fields)).toBe('');
  });
});

describe('deriveChecklistOutcome (B — a practical part auto-marks from its Yes/No checklist)', () => {
  const yesno = (id: string): FormField => ({
    id,
    type: 'boolean_yes_no',
    label: id,
    required: true,
    source: 'imported',
  });
  const verdict = (id: string, options: string[]): FormField => ({
    id,
    type: 'radio',
    label: id,
    required: false,
    source: 'imported',
    options,
  });

  const fields: FormField[] = [
    header('prac'),
    yesno('c1'),
    yesno('c2'),
    verdict('v', ['Candidate not yet Competent', 'Candidate Competent']),
  ];
  const manifest: AssessmentToolManifest = {
    parts: [{ key: 'p', ordinal: 1, label: 'Practical', kind: 'practical', pathways: ['new'], startFieldId: 'prac' }],
  };
  const part = manifest.parts[0]!;
  /** The author locked the verdict field to `auto` — the opt-in signal. */
  const AUTO: Record<string, 'entry' | 'prefill' | 'auto'> = { v: 'auto' };

  const derive = (
    values: Record<string, SubmissionValue>,
    source: Record<string, 'entry' | 'prefill' | 'auto'> | undefined = AUTO,
  ) => deriveChecklistOutcome(fields, manifest, part, values, source);

  it('is satisfactory and writes Competent when every criterion is Yes', () => {
    const out = derive({ c1: 'Yes', c2: 'Yes' });
    expect(out?.outcome).toBe('satisfactory');
    expect(out?.derivedValues.v).toBe('Candidate Competent');
  });

  it('is not satisfactory and writes not-yet when any criterion is No', () => {
    const out = derive({ c1: 'Yes', c2: 'No' });
    expect(out?.outcome).toBe('not_satisfactory');
    expect(out?.derivedValues.v).toBe('Candidate not yet Competent');
  });

  it('fails an untouched criterion — a blank box is not a pass', () => {
    const out = derive({ c1: 'Yes' });
    expect(out?.outcome).toBe('not_satisfactory');
    expect(out?.derivedValues.v).toBe('Candidate not yet Competent');
  });

  it('leaves the part to the assessor when the verdict field is NOT locked to auto', () => {
    expect(derive({ c1: 'Yes', c2: 'Yes' }, { v: 'entry' })).toBeNull();
    // No fieldSource map at all — nothing is auto, so nothing derives. (Called
    // directly: passing `undefined` through the helper would hit its default.)
    expect(deriveChecklistOutcome(fields, manifest, part, { c1: 'Yes', c2: 'Yes' }, undefined)).toBeNull();
  });

  it('returns null when there are no Yes/No criteria to read', () => {
    const noCriteria = [header('prac'), verdict('v', ['Candidate not yet Competent', 'Candidate Competent'])];
    expect(deriveChecklistOutcome(noCriteria, manifest, part, {}, AUTO)).toBeNull();
  });

  it('does not count a keyed question’s ✓/✗ cell as a criterion', () => {
    // A check_cross that is a question's outcomeTarget is furniture, not a
    // pass/fail criterion — it must not gate the checklist verdict.
    const withOutcomeCell: FormField[] = [
      header('prac'),
      yesno('c1'),
      { id: 'q-out', type: 'check_cross', label: 'q-out', required: false, source: 'imported' },
      {
        id: 'q',
        type: 'checkbox_group',
        label: 'q',
        required: true,
        source: 'imported',
        options: ['a'],
        answerKey: ['a'],
        outcomeTarget: { fieldId: 'q-out' },
      },
      verdict('v', ['Candidate not yet Competent', 'Candidate Competent']),
    ];
    // c1 = Yes and the q-out cell is left blank, but it is furniture — the part
    // is still satisfactory on the one real criterion.
    const out = deriveChecklistOutcome(withOutcomeCell, manifest, part, { c1: 'Yes' }, AUTO);
    expect(out?.outcome).toBe('satisfactory');
  });
});
