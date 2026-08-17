import { describe, expect, it } from 'vitest';
import { diffExtraction, type DiffContext, type DiffField } from './extraction-corrections.js';

const AI: DiffContext = { path: 'ai', pageCount: 18, documentType: 'assessment' };

/** A raw field with sensible defaults, overridable per test. */
function field(over: Partial<DiffField> & { id: string }): DiffField {
  return { type: 'text', label: over.id, ...over };
}

describe('diffExtraction — context', () => {
  it('carries the context through and reports no corrections for an identical list', () => {
    const fields = [field({ id: 'ai_1', type: 'text', label: 'Site name' })];
    const result = diffExtraction(fields, fields, { ...AI, captureId: 'cap-1' });

    expect(result).toMatchObject({
      captureId: 'cap-1',
      documentType: 'assessment',
      path: 'ai',
      pageCount: 18,
    });
    expect(result.corrections).toEqual([]);
  });

  it('omits an absent captureId and documentType rather than writing undefined', () => {
    const result = diffExtraction([], [], { path: 'acroform', pageCount: 1 });
    expect('captureId' in result).toBe(false);
    expect('documentType' in result).toBe(false);
    expect(result.path).toBe('acroform');
  });
});

describe('diffExtraction — per-field changes', () => {
  it('records a retype from radio to textarea (the short-answer correction)', () => {
    const raw = [field({ id: 'ai_1', type: 'radio', label: 'Q3', options: ['a', 'b'] })];
    const reviewed = [field({ id: 'ai_1', type: 'textarea', label: 'Q3' })];

    const { corrections } = diffExtraction(raw, reviewed, AI);
    // A radio→textarea with its options removed yields BOTH signals.
    expect(corrections).toContainEqual({ fieldId: 'ai_1', kind: 'retype', from: 'radio', to: 'textarea' });
    expect(corrections).toContainEqual({ fieldId: 'ai_1', kind: 'options-edited', from: ['a', 'b'], to: [] });
  });

  it('records selectionType multiple → single', () => {
    const raw = [
      field({ id: 'ai_1', type: 'checkbox_group', selectionType: 'multiple', options: ['a', 'b'] }),
    ];
    const reviewed = [
      field({ id: 'ai_1', type: 'checkbox_group', selectionType: 'single', options: ['a', 'b'] }),
    ];

    const { corrections } = diffExtraction(raw, reviewed, AI);
    expect(corrections).toEqual([
      { fieldId: 'ai_1', kind: 'selection-type-changed', from: 'multiple', to: 'single' },
    ]);
  });

  it('records an options edit (order-sensitive) and a label rewrite independently', () => {
    const raw = [field({ id: 'ai_1', type: 'radio', label: 'Q1', options: ['True', 'False'] })];
    const reviewed = [field({ id: 'ai_1', type: 'radio', label: 'Q1.', options: ['False', 'True'] })];

    const { corrections } = diffExtraction(raw, reviewed, AI);
    expect(corrections).toContainEqual({
      fieldId: 'ai_1',
      kind: 'options-edited',
      from: ['True', 'False'],
      to: ['False', 'True'],
    });
    expect(corrections).toContainEqual({ fieldId: 'ai_1', kind: 'label-rewritten', from: 'Q1', to: 'Q1.' });
  });

  it('records a fixedRows edit by count-bearing from/to lists', () => {
    const raw = [field({ id: 'ai_1', type: 'repeating_group', fixedRows: ['a', 'b'] })];
    const reviewed = [field({ id: 'ai_1', type: 'repeating_group', fixedRows: ['a', 'b', 'c'] })];

    const { corrections } = diffExtraction(raw, reviewed, AI);
    expect(corrections).toEqual([
      { fieldId: 'ai_1', kind: 'fixed-rows-edited', from: ['a', 'b'], to: ['a', 'b', 'c'] },
    ]);
  });

  it('records an answer-sets change by count, ignoring member order within a set', () => {
    const raw = [
      field({
        id: 'ai_1',
        type: 'repeating_group',
        answerSets: [{ key: 's1', columnKeys: ['ok', 'na'] }],
      }),
    ];
    // Same set, members reordered → NOT a change.
    const sameOrderFlipped = [
      field({
        id: 'ai_1',
        type: 'repeating_group',
        answerSets: [{ key: 's1', columnKeys: ['na', 'ok'] }],
      }),
    ];
    expect(diffExtraction(raw, sameOrderFlipped, AI).corrections).toEqual([]);

    // A second set added → a change, reported by count.
    const twoSets = [
      field({
        id: 'ai_1',
        type: 'repeating_group',
        answerSets: [
          { key: 's1', columnKeys: ['ok', 'na'] },
          { key: 's2', columnKeys: ['pass', 'fail'] },
        ],
      }),
    ];
    expect(diffExtraction(raw, twoSets, AI).corrections).toEqual([
      { fieldId: 'ai_1', kind: 'answer-sets-changed', fromCount: 1, toCount: 2 },
    ]);
  });

  it('records a questionRef edit, and omits the side that is absent', () => {
    const raw = [field({ id: 'ai_1', type: 'radio', questionRef: 'Verbal Q1' })];
    const reviewed = [field({ id: 'ai_1', type: 'radio', questionRef: 'Functional Tests Q1' })];

    const { corrections } = diffExtraction(raw, reviewed, AI);
    expect(corrections).toEqual([
      { fieldId: 'ai_1', kind: 'question-ref-edited', from: 'Verbal Q1', to: 'Functional Tests Q1' },
    ]);
  });
});

describe('diffExtraction — structural changes', () => {
  it('records a deletion with the raw type, label and page range (the orphan-option signal)', () => {
    const raw = [
      field({ id: 'ai_5', type: 'radio', label: 'c) All of these', sourcePages: { from: 5, to: 8 } }),
    ];
    const { corrections } = diffExtraction(raw, [], AI);
    expect(corrections).toEqual([
      {
        fieldId: 'ai_5',
        kind: 'deleted',
        wasType: 'radio',
        wasLabel: 'c) All of these',
        sourcePages: { from: 5, to: 8 },
      },
    ]);
  });

  it('records an addition with the field it follows (a box the extraction missed)', () => {
    const raw = [field({ id: 'ai_1', label: 'Site name' })];
    const reviewed = [
      field({ id: 'ai_1', label: 'Site name' }),
      field({ id: 'new_1', type: 'signature', label: 'Assessor signature' }),
    ];
    const { corrections } = diffExtraction(raw, reviewed, AI);
    expect(corrections).toEqual([
      {
        fieldId: 'new_1',
        kind: 'added',
        addedType: 'signature',
        label: 'Assessor signature',
        afterFieldId: 'ai_1',
      },
    ]);
  });

  it('records a field added at the very start with a null anchor', () => {
    const raw = [field({ id: 'ai_1', label: 'A' })];
    const reviewed = [field({ id: 'new_0', label: 'Preamble' }), field({ id: 'ai_1', label: 'A' })];
    const { corrections } = diffExtraction(raw, reviewed, AI);
    expect(corrections).toContainEqual({
      fieldId: 'new_0',
      kind: 'added',
      addedType: 'text',
      label: 'Preamble',
      afterFieldId: null,
    });
  });

  it('collapses a table split into ONE split correction, not a delete plus N adds', () => {
    const raw = [
      field({ id: 'ai_1', type: 'repeating_group', label: 'Category A checks', fixedRows: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ];
    // splitTableGroups labels the parts "<label> (g of N)" with fresh ids.
    const reviewed = [
      field({ id: 'sp_1', type: 'repeating_group', label: 'Category A checks (1 of 3)', fixedRows: ['a', 'b'] }),
      field({ id: 'sp_2', type: 'repeating_group', label: 'Category A checks (2 of 3)', fixedRows: ['c', 'd'] }),
      field({ id: 'sp_3', type: 'repeating_group', label: 'Category A checks (3 of 3)', fixedRows: ['e', 'f'] }),
    ];
    const { corrections } = diffExtraction(raw, reviewed, AI);
    expect(corrections).toEqual([{ fieldId: 'ai_1', kind: 'split', into: 3 }]);
  });

  it('does not read unrelated added fields as split children', () => {
    const raw = [field({ id: 'ai_1', type: 'repeating_group', label: 'Checks' })];
    // A single "(1 of 2)" with no sibling of the same count is not a split.
    const reviewed = [field({ id: 'x_1', type: 'text', label: 'Checks (1 of 2)' })];
    const { corrections } = diffExtraction(raw, reviewed, AI);
    expect(corrections).toContainEqual({
      fieldId: 'ai_1',
      kind: 'deleted',
      wasType: 'repeating_group',
      wasLabel: 'Checks',
    });
    expect(corrections).toContainEqual({
      fieldId: 'x_1',
      kind: 'added',
      addedType: 'text',
      label: 'Checks (1 of 2)',
      afterFieldId: null,
    });
    expect(corrections.some((c) => c.kind === 'split')).toBe(false);
  });
});

describe('diffExtraction — ordering', () => {
  it('emits raw-field corrections in raw order, then additions in reviewed order', () => {
    const raw = [
      field({ id: 'ai_1', type: 'radio', label: 'Q1', options: ['a'] }),
      field({ id: 'ai_2', type: 'text', label: 'Gone' }),
    ];
    const reviewed = [
      field({ id: 'ai_1', type: 'textarea', label: 'Q1' }),
      field({ id: 'add_1', type: 'date', label: 'Date' }),
    ];
    const kinds = diffExtraction(raw, reviewed, AI).corrections.map((c) => `${c.fieldId}:${c.kind}`);
    // ai_1 changes (retype + options) → ai_2 deleted → add_1 added, in that order.
    expect(kinds).toEqual([
      'ai_1:retype',
      'ai_1:options-edited',
      'ai_2:deleted',
      'add_1:added',
    ]);
  });
});
