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
});
