/**
 * Column / answer-set inspector — logic level.
 *
 * The panel itself is a thin render over the session wrappers, so everything
 * that can go wrong (a proposal published unreviewed, a column claimed by two
 * sets, a rename that breaks a set) is asserted against the wrappers and, where
 * publish is the thing at stake, through `reviewedToFields`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedField, ExtractionResult } from '@formai/shared';
import { groupedColumnKeys, resolveAnswerSets } from '@formai/shared';

vi.mock('../../../lib/data/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/data/api-client.js')>();
  return { ...actual, apiClient: { ...actual.apiClient, post: vi.fn() } };
});

import { apiClient } from '../../../lib/data/api-client.js';
import {
  acceptAnswerSet,
  answerSetAccepted,
  getImportSession,
  groupColumns,
  renameColumn,
  resetImportSession,
  reviewedToFields,
  setColumnRequired,
  setColumnType,
  startExtraction,
  ungroupAnswerSet,
  type ReviewField,
} from '../../../lib/data/import-session.js';
import { columnRows } from './ColumnInspector.js';

const postMock = vi.mocked(apiClient.post);

/** Pre-start style table: a proposed OK / N/A / Fault set over five columns. */
const PROPOSED: ExtractedField = {
  id: 't1',
  label: 'Pre-start checks',
  type: 'repeating_group',
  confidence: 0.72,
  columns: [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'checkbox' },
    { key: 'na', label: 'N/A', type: 'checkbox' },
    { key: 'fault', label: 'Fault', type: 'checkbox' },
    { key: 'notes', label: 'Notes', type: 'text' },
  ],
  answerSets: [{ key: 'as1', columnKeys: ['ok', 'na', 'fault'] }],
  fixedRows: ['Engine oil level'],
};

/** A table extraction proposed nothing for. */
const UNGROUPED: ExtractedField = {
  id: 't2',
  label: 'Defects noted',
  type: 'repeating_group',
  confidence: 0.9,
  columns: [
    { key: 'desc', label: 'Description', type: 'text' },
    { key: 'yes', label: 'Yes', type: 'checkbox' },
    { key: 'no', label: 'No', type: 'checkbox' },
    { key: 'note', label: 'Note', type: 'text' },
  ],
};

const EXTRACTION: ExtractionResult = {
  sourceType: 'pdf_import',
  path: 'ai',
  fileName: 'prestart.pdf',
  pageCount: 1,
  fields: [PROPOSED, UNGROUPED],
  designNotes: [],
};

function field(id: string): ReviewField {
  const f = getImportSession().fields.find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id}`);
  return f;
}

function published(id: string) {
  const f = reviewedToFields(getImportSession().fields).find((x) => x.id === id);
  if (!f) throw new Error(`no published field ${id}`);
  return f;
}

beforeEach(async () => {
  postMock.mockReset();
  resetImportSession();
  postMock.mockResolvedValueOnce({ assetId: 'asset-1' });
  postMock.mockResolvedValueOnce(structuredClone(EXTRACTION));
  await startExtraction(new File([new Uint8Array([1])], 'prestart.pdf'));
});

describe('proposed vs accepted', () => {
  it('starts a proposed set unaccepted and lets the reviewer accept it', () => {
    expect(answerSetAccepted('t1', 'as1')).toBe(false);
    expect(columnRows(field('t1')).find((r) => r.column.key === 'ok')?.membership).toBe('proposed');

    acceptAnswerSet('t1', 'as1');

    expect(answerSetAccepted('t1', 'as1')).toBe(true);
    expect(columnRows(field('t1')).find((r) => r.column.key === 'ok')?.membership).toBe('accepted');
  });

  it('treats a reviewer-made grouping as accepted immediately', () => {
    const key = groupColumns('t2', ['yes', 'no']);
    expect(key).not.toBeNull();
    expect(answerSetAccepted('t2', key!)).toBe(true);
  });

  it('starts a table with no proposed set with an empty grouping state', () => {
    expect(field('t2').answerSets ?? []).toEqual([]);
    expect(groupedColumnKeys(field('t2')).size).toBe(0);
    expect(columnRows(field('t2')).every((r) => r.membership === 'none')).toBe(true);
    expect(published('t2').answerSets).toBeUndefined();
  });
});

describe('grouping', () => {
  it('ungroups a proposed three-column set back to independent cells, and publishes that way', () => {
    ungroupAnswerSet('t1', 'as1');

    expect(field('t1').answerSets ?? []).toEqual([]);
    expect(groupedColumnKeys(field('t1')).size).toBe(0);
    expect(published('t1').answerSets).toBeUndefined();
    // The columns themselves survive untouched.
    expect(published('t1').columns?.map((c) => c.key)).toEqual(['item', 'ok', 'na', 'fault', 'notes']);
  });

  it('groups two previously independent columns into a valid set', () => {
    groupColumns('t2', ['yes', 'no']);

    const resolved = resolveAnswerSets(field('t2'));
    expect(resolved.dropped).toEqual([]);
    expect(resolved.sets).toHaveLength(1);
    expect(resolved.sets[0]!.columnKeys).toEqual(['yes', 'no']);
    expect(published('t2').answerSets).toHaveLength(1);
  });

  it('never lets the label column join a set', () => {
    groupColumns('t2', ['desc', 'yes', 'no']);

    const set = resolveAnswerSets(field('t2')).sets[0]!;
    expect(set.columnKeys).toEqual(['yes', 'no']);

    // And a request that is only the label column plus one other cannot form a set.
    resetGroups('t2');
    expect(groupColumns('t2', ['desc', 'yes'])).toBeNull();
    expect(field('t2').answerSets ?? []).toEqual([]);
    expect(columnRows(field('t2'))[0]!.groupable).toBe(false);
  });

  it('moves a column already in another set rather than duplicating membership', () => {
    groupColumns('t1', ['fault', 'notes']);

    const resolved = resolveAnswerSets(field('t1'));
    expect(resolved.dropped).toEqual([]);
    expect(resolved.sets.map((s) => s.columnKeys)).toEqual([
      ['ok', 'na'],
      ['fault', 'notes'],
    ]);
    const memberships = resolved.sets.flatMap((s) => s.columnKeys);
    expect(new Set(memberships).size).toBe(memberships.length);
  });

  it('drops a set that a move would leave with a single member', () => {
    groupColumns('t2', ['yes', 'no']);
    groupColumns('t2', ['no', 'note']);

    const resolved = resolveAnswerSets(field('t2'));
    expect(resolved.dropped).toEqual([]);
    expect(resolved.sets.map((s) => s.columnKeys)).toEqual([['no', 'note']]);
  });
});

describe('column edits', () => {
  it('preserves the column key when renaming, keeping the set valid', () => {
    renameColumn('t1', 'ok', 'Compliant');

    const col = field('t1').columns!.find((c) => c.key === 'ok')!;
    expect(col.label).toBe('Compliant');
    expect(published('t1').columns!.map((c) => c.key)).toEqual(['item', 'ok', 'na', 'fault', 'notes']);
    expect(resolveAnswerSets(field('t1')).sets[0]!.columnKeys).toEqual(['ok', 'na', 'fault']);
  });

  it('marks a column required', () => {
    setColumnRequired('t1', 'notes', true);
    expect(published('t1').columns!.find((c) => c.key === 'notes')!.required).toBe(true);
  });

  it('removes a grouped column from its set when retyped to text', () => {
    setColumnType('t1', 'fault', 'text');

    const resolved = resolveAnswerSets(field('t1'));
    expect(resolved.dropped).toEqual([]);
    expect(resolved.sets.map((s) => s.columnKeys)).toEqual([['ok', 'na']]);
    expect(field('t1').columns!.find((c) => c.key === 'fault')!.type).toBe('text');
  });

  it('dissolves the whole set when retyping leaves fewer than two members', () => {
    groupColumns('t2', ['yes', 'no']);
    setColumnType('t2', 'no', 'text');

    expect(field('t2').answerSets ?? []).toEqual([]);
    expect(resolveAnswerSets(field('t2')).dropped).toEqual([]);
    expect(published('t2').answerSets).toBeUndefined();
  });

  it('leaves the label column untouched by retype requests', () => {
    setColumnType('t1', 'item', 'checkbox');
    expect(field('t1').columns![0]!.type).toBe('text');
  });
});

/** Clear every set on a field (test helper — mirrors ungrouping each in turn). */
function resetGroups(id: string) {
  for (const set of [...(field(id).answerSets ?? [])]) ungroupAnswerSet(id, set.key);
}
