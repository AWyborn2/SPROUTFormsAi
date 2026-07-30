/**
 * The exact-set-match rule and the mandatory-section gate are the two things a
 * candidate's competence turns on, so both directions of every boundary are
 * pinned here: subset wrong, superset wrong, exact right, blank wrong.
 *
 * Covers AE1 (multi-answer marking) and AE2 (the 100% mandatory-section rule).
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from './form-field.js';
import type { RepeatingRowValue, SubmissionValue } from './submission.js';
import { markTheory, stripMarkingSecrets } from './marking.js';

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

  it('marks location questions without treating them as mandatory', () => {
    const res = run(withLocation, { g1: ['a'], g2: ['b', 'c'], m1: ['d'] });

    expect(res.marks.find((m) => m.fieldId === 'm1')?.mandatory).toBe(false);
    expect(res.marks.find((m) => m.fieldId === 'g1')?.mandatory).toBe(true);
  });

  it('gates on nothing when the part declares no mandatory section', () => {
    const res = markTheory({ fields: generalFields, values: { g1: ['z'] }, part: {} });

    expect(res.outcome).toBe('satisfactory');
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
