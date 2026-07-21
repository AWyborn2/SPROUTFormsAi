/**
 * Answer-set resolvers (U1). These live in `packages/shared`, which has no test
 * runner of its own — same arrangement as `submission-validation.test.ts`.
 *
 * The theme throughout: every resolver is total. Malformed grouping degrades a
 * table to independent checkboxes, which a reviewer can regroup, rather than
 * throwing in front of a crew trying to fill the form.
 */
import { describe, expect, it } from 'vitest';
import {
  answerSetForColumn,
  applySelection,
  groupedColumnKeys,
  resolveAnswerSets,
  selectedOption,
} from '@formai/shared';
import type { AnswerSet, FormField, RepeatingColumn } from '@formai/shared';

const COLUMNS: RepeatingColumn[] = [
  { key: 'item', label: 'Item', type: 'text' },
  { key: 'ok', label: '✓', type: 'checkbox' },
  { key: 'no', label: '×', type: 'checkbox' },
  { key: 'na', label: 'N-A', type: 'checkbox' },
];

const TRIPLE: AnswerSet = { key: 'verdict', columnKeys: ['ok', 'no', 'na'] };

function field(answerSets?: AnswerSet[], columns = COLUMNS): Pick<FormField, 'columns' | 'answerSets'> {
  return { columns, ...(answerSets ? { answerSets } : {}) };
}

describe('resolveAnswerSets', () => {
  it('treats every column as ungrouped when the field declares no sets', () => {
    const { sets, dropped } = resolveAnswerSets(field());
    expect(sets).toEqual([]);
    expect(dropped).toEqual([]);
    expect(groupedColumnKeys(field()).size).toBe(0);
  });

  it('keeps a well-formed set', () => {
    const { sets, dropped } = resolveAnswerSets(field([TRIPLE]));
    expect(sets).toEqual([TRIPLE]);
    expect(dropped).toEqual([]);
  });

  it('drops a set naming a column the table does not have, without throwing', () => {
    const { sets, dropped } = resolveAnswerSets(field([{ key: 'v', columnKeys: ['ok', 'ghost'] }]));
    expect(sets).toEqual([]);
    expect(dropped).toEqual([{ key: 'v', reason: 'unknown-column' }]);
  });

  it('drops a set that includes the label column', () => {
    const { dropped } = resolveAnswerSets(field([{ key: 'v', columnKeys: ['item', 'ok'] }]));
    expect(dropped).toEqual([{ key: 'v', reason: 'label-column' }]);
  });

  it('drops a single-column set — a group of one is just a checkbox', () => {
    const { dropped } = resolveAnswerSets(field([{ key: 'v', columnKeys: ['ok'] }]));
    expect(dropped).toEqual([{ key: 'v', reason: 'too-few-columns' }]);
  });

  it('rejects the second set claiming an already-claimed column rather than resolving first-wins', () => {
    const { sets, dropped } = resolveAnswerSets(
      field([
        { key: 'a', columnKeys: ['ok', 'no'] },
        { key: 'b', columnKeys: ['no', 'na'] },
      ]),
    );
    expect(sets.map((s) => s.key)).toEqual(['a']);
    expect(dropped).toEqual([{ key: 'b', reason: 'duplicate-membership' }]);
  });

  it('keeps two disjoint sets on the same table', () => {
    const columns: RepeatingColumn[] = [
      ...COLUMNS,
      { key: 'am', label: 'AM', type: 'checkbox' },
      { key: 'pm', label: 'PM', type: 'checkbox' },
    ];
    const { sets } = resolveAnswerSets(
      field([TRIPLE, { key: 'shift', columnKeys: ['am', 'pm'] }], columns),
    );
    expect(sets.map((s) => s.key)).toEqual(['verdict', 'shift']);
  });

  it('returns no sets when the field has no columns at all', () => {
    expect(resolveAnswerSets({ columns: undefined, answerSets: [TRIPLE] }).sets).toEqual([]);
  });
});

describe('answerSetForColumn', () => {
  it('finds the owning set for a member column', () => {
    expect(answerSetForColumn(field([TRIPLE]), 'na')?.key).toBe('verdict');
  });

  it('returns undefined for an ungrouped column', () => {
    expect(answerSetForColumn(field([{ key: 'v', columnKeys: ['ok', 'no'] }]), 'na')).toBeUndefined();
  });

  it('returns undefined for a column whose set was dropped', () => {
    expect(answerSetForColumn(field([{ key: 'v', columnKeys: ['item', 'ok'] }]), 'ok')).toBeUndefined();
  });
});

describe('selectedOption', () => {
  it('reports the single truthy member as the answer', () => {
    expect(selectedOption(TRIPLE, { item: 'Seat belts', ok: true, no: null, na: null })).toEqual({
      columnKey: 'ok',
      malformed: false,
    });
  });

  it('reports an unanswered row when no member is truthy', () => {
    expect(selectedOption(TRIPLE, { item: 'Seat belts', ok: null, no: null, na: null })).toEqual({
      columnKey: null,
      malformed: false,
    });
  });

  it('distinguishes an explicit false from an answer — false is not a choice', () => {
    expect(selectedOption(TRIPLE, { ok: false, no: false, na: false }).columnKey).toBeNull();
  });

  it('flags a row with two truthy members and returns the first', () => {
    expect(selectedOption(TRIPLE, { ok: true, no: true, na: null })).toEqual({
      columnKey: 'ok',
      malformed: true,
    });
  });

  it('treats a missing row as unanswered', () => {
    expect(selectedOption(TRIPLE, undefined)).toEqual({ columnKey: null, malformed: false });
  });
});

describe('applySelection', () => {
  it('sets the chosen column truthy and nulls its siblings', () => {
    const row = applySelection(TRIPLE, { item: 'Horn', ok: true, no: null, na: null }, 'na');
    expect(row).toEqual({ item: 'Horn', ok: null, no: null, na: true });
  });

  it('clears every member when the selection is null', () => {
    const row = applySelection(TRIPLE, { item: 'Horn', ok: true, no: null, na: null }, null);
    expect(row).toEqual({ item: 'Horn', ok: null, no: null, na: null });
  });

  it('leaves non-member columns untouched', () => {
    const row = applySelection(TRIPLE, { item: 'Horn', ok: null, no: null, na: null, notes: 'seized' }, 'no');
    expect(row.notes).toBe('seized');
    expect(row.item).toBe('Horn');
  });

  it('repairs a malformed two-truthy row on the next selection', () => {
    const row = applySelection(TRIPLE, { ok: true, no: true, na: null }, 'ok');
    expect(selectedOption(TRIPLE, row)).toEqual({ columnKey: 'ok', malformed: false });
  });
});

describe('review findings — regressions', () => {
  it('drops a set naming the same column twice, which would make every row unanswerable', () => {
    // ['ok','ok'] passed the length>=2 check, then selectedOption filtered the
    // same key twice and always reported malformed — a required table became an
    // unclearable submit wall with no visible cause. Reachable from the LLM
    // proposal path, which coerces columnKeys without deduping.
    const { sets, dropped } = resolveAnswerSets(field([{ key: 'v', columnKeys: ['ok', 'ok'] }]));

    expect(sets).toEqual([]);
    expect(dropped).toEqual([{ key: 'v', reason: 'duplicate-membership' }]);
  });

  it('drops a three-key set with one repeat rather than silently grouping two', () => {
    const { sets } = resolveAnswerSets(field([{ key: 'v', columnKeys: ['ok', 'no', 'ok'] }]));
    expect(sets).toEqual([]);
  });
});
