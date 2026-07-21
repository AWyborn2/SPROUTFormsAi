/**
 * Condition authoring — logic level.
 *
 * The panel is a thin render over two things: the source list it may offer
 * (`conditionSources`) and the session/builder wrapper that writes the
 * condition. Both are asserted here, and everything that has to survive
 * publishing is asserted through `reviewedToFields` — the publish whitelist is
 * where a correctly-authored condition silently disappears.
 *
 * Section scope and the fail-open rule are NOT re-implemented in the editor, so
 * they are asserted against `visibleFields` / `isFieldVisible` from the shared
 * package: authoring one condition on a header has to govern the section
 * through the real evaluator, not through a UI-side approximation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedField, ExtractionResult, FormField } from '@formai/shared';
import { isFieldVisible, visibleFields } from '@formai/shared';

vi.mock('../../../lib/data/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/data/api-client.js')>();
  return { ...actual, apiClient: { ...actual.apiClient, post: vi.fn() } };
});

import { apiClient } from '../../../lib/data/api-client.js';
import {
  deleteField,
  getImportSession,
  moveField,
  resetImportSession,
  reviewedToFields,
  setFieldCondition,
  startExtraction,
  type ReviewField,
} from '../../../lib/data/import-session.js';
import { conditionSources, governedFieldIds, sourceValueOptions } from './ConditionEditor.js';
import { builderConditionActions, importSessionConditionActions } from './column-actions.js';

const postMock = vi.mocked(apiClient.post);

const FIELDS: ExtractedField[] = [
  { id: 'loc', label: 'Location', type: 'dropdown', confidence: 0.95, options: ['Depot A', 'Depot B'] },
  { id: 'notes', label: 'General notes', type: 'text', confidence: 0.9 },
  {
    id: 'tbl',
    label: 'Defects noted',
    type: 'repeating_group',
    confidence: 0.8,
    columns: [
      { key: 'desc', label: 'Description', type: 'text' },
      { key: 'ok', label: 'OK', type: 'checkbox' },
    ],
  },
  { id: 'sec', label: 'Depot A checks', type: 'section_header', confidence: 1 },
  { id: 'q1', label: 'Bay tidy?', type: 'text', confidence: 0.9 },
  { id: 'q2', label: 'Lights working?', type: 'text', confidence: 0.9 },
  { id: 'sec2', label: 'Sign off', type: 'section_header', confidence: 1 },
  { id: 'q3', label: 'Signature', type: 'signature', confidence: 0.9 },
];

const EXTRACTION: ExtractionResult = {
  sourceType: 'pdf_import',
  path: 'ai',
  fileName: 'prestart.pdf',
  pageCount: 2,
  fields: FIELDS,
  designNotes: [],
};

function all(): ReviewField[] {
  return getImportSession().fields;
}

function field(id: string): ReviewField {
  const f = all().find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id}`);
  return f;
}

function published(id: string): FormField {
  const f = reviewedToFields(all()).find((x) => x.id === id);
  if (!f) throw new Error(`no published field ${id}`);
  return f;
}

/** Ids the real evaluator leaves visible for a given answer set. */
function visibleIds(answers: Record<string, string>): string[] {
  return visibleFields(reviewedToFields(all()), answers).map((f) => f.id);
}

beforeEach(async () => {
  postMock.mockReset();
  resetImportSession();
  postMock.mockResolvedValueOnce({ assetId: 'asset-1' });
  postMock.mockResolvedValueOnce(structuredClone(EXTRACTION));
  await startExtraction(new File([new Uint8Array([1])], 'prestart.pdf'));
});

describe('source list', () => {
  it('excludes repeating groups and section headers — R20: no row state, no loops', () => {
    const ids = conditionSources(all(), 'q3').map((f) => f.id);

    expect(ids).not.toContain('tbl');
    expect(ids).not.toContain('sec');
    expect(ids).not.toContain('sec2');
  });

  it('excludes the field being edited and everything after it', () => {
    const ids = conditionSources(all(), 'notes').map((f) => f.id);

    // Only 'loc' is earlier, answerable, and not the field itself.
    expect(ids).toEqual(['loc']);
  });

  it('offers nothing for the first field in the form', () => {
    expect(conditionSources(all(), 'loc')).toEqual([]);
  });

  it('offers an options-bearing source its own options as condition values', () => {
    const source = conditionSources(all(), 'q1').find((f) => f.id === 'loc');

    expect(sourceValueOptions(source!)).toEqual(['Depot A', 'Depot B']);
    // A free-text source has no enumerable answers — the panel falls back to text.
    expect(sourceValueOptions(field('notes'))).toBeNull();
  });
});

describe('authoring a condition', () => {
  it('round-trips through publish onto the published field', () => {
    setFieldCondition('q1', { fieldId: 'loc', op: 'equals', value: 'Depot A' });

    expect(field('q1').visibleWhen).toEqual({ fieldId: 'loc', op: 'equals', value: 'Depot A' });
    expect(published('q1').visibleWhen).toEqual({ fieldId: 'loc', op: 'equals', value: 'Depot A' });
    expect(visibleIds({ loc: 'Depot B' })).not.toContain('q1');
    expect(visibleIds({ loc: 'Depot A' })).toContain('q1');
  });

  it('returns the field to always-visible when the condition is cleared', () => {
    setFieldCondition('q1', { fieldId: 'loc', op: 'equals', value: 'Depot A' });
    setFieldCondition('q1', null);

    expect(field('q1').visibleWhen).toBeUndefined();
    expect(published('q1').visibleWhen).toBeUndefined();
    expect(isFieldVisible(published('q1'), reviewedToFields(all()), {})).toBe(true);
    expect(visibleIds({ loc: 'Depot B' })).toContain('q1');
  });

  it('leaves a dependent visible when its source field is later deleted (fails open)', () => {
    setFieldCondition('q1', { fieldId: 'loc', op: 'equals', value: 'Depot A' });
    deleteField('loc');

    const fields = reviewedToFields(all());
    expect(isFieldVisible(published('q1'), fields, {})).toBe(true);
    expect(visibleIds({})).toContain('q1');
  });

  it('drives the same write through the builder adapter', () => {
    const patches: Array<Partial<FormField>> = [];
    const actions = builderConditionActions((patch) => patches.push(patch));

    actions.setCondition('q1', { fieldId: 'loc', op: 'notEquals', value: 'Depot A' });
    actions.setCondition('q1', null);

    expect(patches).toEqual([
      { visibleWhen: { fieldId: 'loc', op: 'notEquals', value: 'Depot A' } },
      { visibleWhen: undefined },
    ]);
  });

  it('exposes the session wrapper as the import-review adapter', () => {
    importSessionConditionActions.setCondition('q2', { fieldId: 'loc', op: 'equals', value: 'Depot B' });
    expect(field('q2').visibleWhen).toEqual({ fieldId: 'loc', op: 'equals', value: 'Depot B' });
  });
});

describe('section scope', () => {
  it('governs every field in the section from ONE condition on the header', () => {
    setFieldCondition('sec', { fieldId: 'loc', op: 'equals', value: 'Depot A' });

    // Not authored on q1/q2 individually — the header carries it.
    expect(field('q1').visibleWhen).toBeUndefined();
    expect(field('q2').visibleWhen).toBeUndefined();

    expect(visibleIds({ loc: 'Depot B' })).toEqual(['loc', 'notes', 'tbl', 'sec2', 'q3']);
    expect(visibleIds({ loc: 'Depot A' })).toEqual(['loc', 'notes', 'tbl', 'sec', 'q1', 'q2', 'sec2', 'q3']);
  });

  it('reports the governed range so the canvas can mark it', () => {
    expect(governedFieldIds(all(), 'sec')).toEqual(['q1', 'q2']);
    // The last section runs to the end of the form.
    expect(governedFieldIds(all(), 'sec2')).toEqual(['q3']);
    // A non-header governs nothing but itself, so the range is empty.
    expect(governedFieldIds(all(), 'q1')).toEqual([]);
  });

  it('releases the condition when the section header is deleted', () => {
    setFieldCondition('sec', { fieldId: 'loc', op: 'equals', value: 'Depot A' });
    deleteField('sec');

    // The section's fields must not be permanently hidden by a header that is gone.
    expect(visibleIds({ loc: 'Depot B' })).toEqual(['loc', 'notes', 'tbl', 'q1', 'q2', 'sec2', 'q3']);
  });

  it('stops a field inheriting the condition once it moves out of the section', () => {
    setFieldCondition('sec', { fieldId: 'loc', op: 'equals', value: 'Depot A' });
    moveField('q1', -1); // q1 hops above its header

    expect(governedFieldIds(all(), 'sec')).toEqual(['q2']);
    const ids = visibleIds({ loc: 'Depot B' });
    expect(ids).toContain('q1');
    expect(ids).not.toContain('q2');
  });
});
