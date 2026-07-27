/**
 * The builder's ColumnActions adapter (U9/R17).
 *
 * Post-publish edits go through `builderReducer`, not the import session, so
 * this adapter turns the same panel's actions into field patches. The rules it
 * must preserve are the ones that keep an answer set resolvable — the shared
 * resolver silently DROPS a malformed set, so an adapter that leaves one behind
 * turns a grouped table into an ungrouped one with no visible error.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { resolveAnswerSets } from '@formai/shared';
import { builderColumnActions } from './column-actions.js';

const table: FormField = {
  id: 'cat-a',
  type: 'repeating_group',
  label: 'Category A checks',
  required: true,
  source: 'imported',
  columns: [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: '✓', type: 'checkbox' },
    { key: 'no', label: '×', type: 'checkbox' },
    { key: 'na', label: 'N-A', type: 'checkbox' },
  ],
  answerSets: [{ key: 'verdict', columnKeys: ['ok', 'no', 'na'] }],
  // A fixed-item checklist: `item` is the pre-printed label column. Without
  // fixedRows this is an OPEN table and `item` is a fillable cell like the rest.
  fixedRows: ['Engine oil level'],
};

/** An open row-entry table — no fixedRows, so no pre-printed label column. */
const openTable: FormField = {
  id: 'timesheet',
  type: 'repeating_group',
  label: 'Daily timesheet',
  required: false,
  source: 'imported',
  columns: [
    { key: 'wo', label: 'Work Order #', type: 'text' },
    { key: 'plant', label: 'Plant ID', type: 'text' },
    { key: 'hours', label: 'Total Hours', type: 'number' },
  ],
};

/** Apply one action and return the resulting field. */
function afterAction(field: FormField, run: (a: ReturnType<typeof builderColumnActions>) => void): FormField {
  let next = field;
  run(builderColumnActions(field, (patch) => {
    next = { ...field, ...patch };
  }));
  return next;
}

describe('builderColumnActions', () => {
  it('renames a column without changing its key, so row values and sets stay valid', () => {
    const next = afterAction(table, (a) => a.renameColumn(table.id, 'ok', 'Pass'));

    expect(next.columns?.[1]).toEqual({ key: 'ok', label: 'Pass', type: 'checkbox' });
    expect(resolveAnswerSets(next).sets[0]?.columnKeys).toEqual(['ok', 'no', 'na']);
  });

  it('marks a column required without touching the others', () => {
    const next = afterAction(table, (a) => a.setColumnRequired(table.id, 'na', true));

    expect(next.columns?.find((c) => c.key === 'na')?.required).toBe(true);
    expect(next.columns?.find((c) => c.key === 'ok')?.required).toBeUndefined();
  });

  it('drops a retyped column out of its set, keeping the remaining two grouped', () => {
    const next = afterAction(table, (a) => a.setColumnType(table.id, 'na', 'text'));

    expect(next.columns?.find((c) => c.key === 'na')?.type).toBe('text');
    expect(resolveAnswerSets(next).sets[0]?.columnKeys).toEqual(['ok', 'no']);
  });

  it('dissolves a set rather than leaving a one-member remnant the resolver would drop', () => {
    const pair: FormField = { ...table, answerSets: [{ key: 'v', columnKeys: ['ok', 'no'] }] };
    const next = afterAction(pair, (a) => a.setColumnType(pair.id, 'no', 'text'));

    expect(next.answerSets).toEqual([]);
    expect(resolveAnswerSets(next).dropped).toEqual([]);
  });

  it('groups two independent columns into a resolvable set', () => {
    const ungrouped: FormField = { ...table, answerSets: undefined };
    const next = afterAction(ungrouped, (a) => a.groupColumns(ungrouped.id, ['ok', 'no']));

    expect(resolveAnswerSets(next).sets).toHaveLength(1);
    expect(resolveAnswerSets(next).sets[0]?.columnKeys).toEqual(['ok', 'no']);
  });

  it('filters the label column out of a grouping request instead of rejecting it', () => {
    const ungrouped: FormField = { ...table, answerSets: undefined };
    const next = afterAction(ungrouped, (a) => a.groupColumns(ungrouped.id, ['item', 'ok', 'no']));

    expect(resolveAnswerSets(next).sets[0]?.columnKeys).toEqual(['ok', 'no']);
  });

  it('refuses to group when fewer than two groupable columns remain', () => {
    let result: string | null = 'unset';
    builderColumnActions(table, () => {});
    result = builderColumnActions(table, () => {}).groupColumns(table.id, ['item', 'ok']);
    expect(result).toBeNull();
  });

  it('moves a column between sets rather than leaving it in both', () => {
    const two: FormField = {
      ...table,
      columns: [...(table.columns ?? []), { key: 'am', label: 'AM', type: 'checkbox' }],
      answerSets: [
        { key: 'verdict', columnKeys: ['ok', 'no', 'na'] },
      ],
    };
    const next = afterAction(two, (a) => a.groupColumns(two.id, ['na', 'am']));
    const { sets } = resolveAnswerSets(next);

    const owners = sets.filter((s) => s.columnKeys.includes('na'));
    expect(owners).toHaveLength(1);
    expect(sets.find((s) => s.key === 'verdict')?.columnKeys).toEqual(['ok', 'no']);
  });

  it('ungroups a set, returning its columns to independent cells', () => {
    const next = afterAction(table, (a) => a.ungroupAnswerSet(table.id, 'verdict'));

    expect(resolveAnswerSets(next).sets).toEqual([]);
  });

  it('reports every set as accepted — a published grouping was already reviewed', () => {
    // The proposal affordance is review-only; after publish there is nothing
    // left to accept, so the builder must never render "Accept grouping".
    const actions = builderColumnActions(table, () => {});
    expect(actions.answerSetAccepted(table.id, 'verdict')).toBe(true);
  });

  it('excludes the first column from grouping even in an open table (row identity, not a set option)', () => {
    // columns[0] is the row-identity column; `resolveAnswerSets` never accepts
    // it as a set member, so grouping filters it out and groups the rest.
    const openTickable: FormField = {
      ...openTable,
      columns: [
        { key: 'wo', label: 'Work Order #', type: 'checkbox' },
        { key: 'am', label: 'AM', type: 'checkbox' },
        { key: 'pm', label: 'PM', type: 'checkbox' },
      ],
    };
    const next = afterAction(openTickable, (a) => a.groupColumns(openTickable.id, ['wo', 'am', 'pm']));
    expect(resolveAnswerSets(next).sets[0]?.columnKeys).toEqual(['am', 'pm']);
  });

  describe('setLabelColumn', () => {
    it('drops fixedRows to turn a checklist into an open table', () => {
      const next = afterAction(table, (a) => a.setLabelColumn(table.id, false));
      expect(next.fixedRows).toBeUndefined();
      expect(next.columns?.map((c) => c.key)).toEqual(['item', 'ok', 'no', 'na']);
    });

    it('seeds a blank checklist and frees the first column of its set turning an open table into a checklist', () => {
      const grouped: FormField = {
        ...openTable,
        columns: [
          { key: 'wo', label: 'Work Order #', type: 'checkbox' },
          { key: 'plant', label: 'Plant ID', type: 'checkbox' },
          { key: 'hours', label: 'Total Hours', type: 'checkbox' },
        ],
        answerSets: [{ key: 's', columnKeys: ['wo', 'plant', 'hours'] }],
      };
      const next = afterAction(grouped, (a) => a.setLabelColumn(grouped.id, true));
      expect(next.fixedRows).toEqual(['']);
      expect(next.columns?.[0]).toEqual({ key: 'wo', label: 'Work Order #', type: 'text' });
      // wo left the set, leaving a still-valid two-member group.
      expect(resolveAnswerSets(next).sets[0]?.columnKeys).toEqual(['plant', 'hours']);
    });

    it('is a no-op when the table is already in the requested state', () => {
      let called = false;
      builderColumnActions(table, () => {
        called = true;
      }).setLabelColumn(table.id, true);
      expect(called).toBe(false);
    });
  });

  describe('add / remove column', () => {
    it('appends a fillable text column with a unique key', () => {
      const next = afterAction(openTable, (a) => a.addColumn(openTable.id));
      expect(next.columns).toHaveLength(4);
      expect(next.columns?.at(-1)).toEqual({ key: 'col4', label: 'Column 4', type: 'text' });
    });

    it('removes a column and strips it from any answer set', () => {
      const next = afterAction(table, (a) => a.removeColumn(table.id, 'na'));
      expect(next.columns?.map((c) => c.key)).toEqual(['item', 'ok', 'no']);
      expect(resolveAnswerSets(next).sets[0]?.columnKeys).toEqual(['ok', 'no']);
    });

    it('refuses to remove the checklist label column', () => {
      const next = afterAction(table, (a) => a.removeColumn(table.id, 'item'));
      expect(next.columns?.map((c) => c.key)).toEqual(['item', 'ok', 'no', 'na']);
    });
  });
});
