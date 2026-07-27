/**
 * Smart Fill staging. Every drop case matters as much as every write: what
 * survives this module is what a respondent sees pre-filled on a form they are
 * about to sign.
 */
import { describe, expect, it } from 'vitest';
import type { FormField, SmartFillMapping } from '@formai/shared';
import {
  SMART_FILL_CONFIDENCE_THRESHOLD,
  applyMappings,
  partitionByConfidence,
  smartFillFailure,
  smartFillSummary,
} from './smart-fill.js';

function field(patch: Partial<FormField> & { id: string }): FormField {
  return { type: 'text', label: patch.id, required: false, source: 'built', ...patch } as FormField;
}

function mapping(patch: Partial<SmartFillMapping> & { fieldId: string }): SmartFillMapping {
  return { value: 'spoken', confidence: 0.9, ...patch };
}

const FIELDS: FormField[] = [
  field({ id: 'site' }),
  field({ id: 'crew', type: 'number' }),
  field({ id: 'wet', type: 'boolean_yes_no' }),
  field({ id: 'hazards', type: 'checkbox_group', options: ['Dust', 'Noise'] }),
];

describe('applyMappings', () => {
  it('merges accepted mappings and reports each change', () => {
    const values = { site: 'Depot' };
    const result = applyMappings(
      values,
      [mapping({ fieldId: 'site', value: 'Warehouse B' }), mapping({ fieldId: 'crew', value: 4 })],
      FIELDS,
    );

    expect(result.values).toEqual({ site: 'Warehouse B', crew: 4 });
    expect(result.changes).toEqual([
      { fieldId: 'site', previous: 'Depot', next: 'Warehouse B' },
      { fieldId: 'crew', previous: null, next: 4 },
    ]);
  });

  it('leaves the caller’s values object untouched', () => {
    const values = { site: 'Depot' };
    applyMappings(values, [mapping({ fieldId: 'site', value: 'Warehouse B' })], FIELDS);
    expect(values).toEqual({ site: 'Depot' });
  });

  it('reports an unset field’s previous value as null, not undefined', () => {
    const result = applyMappings({}, [mapping({ fieldId: 'crew', value: 7 })], FIELDS);
    expect(result.changes[0]?.previous).toBeNull();
  });

  it('overwrites an existing answer but records what it replaced', () => {
    const result = applyMappings(
      { wet: false },
      [mapping({ fieldId: 'wet', value: true })],
      FIELDS,
    );
    expect(result.values.wet).toBe(true);
    expect(result.changes).toEqual([{ fieldId: 'wet', previous: false, next: true }]);
  });

  it('ignores field ids the form does not render', () => {
    const result = applyMappings(
      { site: 'Depot' },
      [mapping({ fieldId: 'ghost', value: 'anything' }), mapping({ fieldId: 'site', value: 'Yard' })],
      FIELDS,
    );
    expect(result.values).toEqual({ site: 'Yard' });
    expect(result.changes.map((c) => c.fieldId)).toEqual(['site']);
  });

  it.each(['signature', 'file_upload', 'section_header', 'repeating_group'] as const)(
    'refuses to write a %s field',
    (type) => {
      const fields = [field({ id: 'x', type })];
      const result = applyMappings({}, [mapping({ fieldId: 'x', value: 'said so' })], fields);
      expect(result.changes).toEqual([]);
      expect(result.values).toEqual({});
    },
  );

  it('keeps the first mapping when a field is named twice', () => {
    const result = applyMappings(
      {},
      [mapping({ fieldId: 'site', value: 'First' }), mapping({ fieldId: 'site', value: 'Second' })],
      FIELDS,
    );
    expect(result.values.site).toBe('First');
    expect(result.changes).toHaveLength(1);
  });

  it('does not let a later duplicate resurrect a field the first mapping left unchanged', () => {
    const result = applyMappings(
      { site: 'Depot' },
      [mapping({ fieldId: 'site', value: 'Depot' }), mapping({ fieldId: 'site', value: 'Yard' })],
      FIELDS,
    );
    expect(result.values.site).toBe('Depot');
    expect(result.changes).toEqual([]);
  });

  it('records no change when the proposal matches what is already there', () => {
    const values = { site: 'Depot', crew: 4 };
    const result = applyMappings(
      values,
      [mapping({ fieldId: 'site', value: 'Depot' }), mapping({ fieldId: 'crew', value: 4 })],
      FIELDS,
    );
    expect(result.changes).toEqual([]);
    // Same reference, so a React caller holding it re-renders nothing.
    expect(result.values).toBe(values);
  });

  it('compares checkbox-group arrays by contents, not identity', () => {
    const unchanged = applyMappings(
      { hazards: ['Dust', 'Noise'] },
      [mapping({ fieldId: 'hazards', value: ['Dust', 'Noise'] })],
      FIELDS,
    );
    expect(unchanged.changes).toEqual([]);

    const reordered = applyMappings(
      { hazards: ['Dust', 'Noise'] },
      [mapping({ fieldId: 'hazards', value: ['Noise', 'Dust'] })],
      FIELDS,
    );
    expect(reordered.changes).toHaveLength(1);
  });

  it('treats a shorter array as a change', () => {
    const result = applyMappings(
      { hazards: ['Dust', 'Noise'] },
      [mapping({ fieldId: 'hazards', value: ['Dust'] })],
      FIELDS,
    );
    expect(result.values.hazards).toEqual(['Dust']);
  });

  it('returns the same values and no changes for an empty mapping list', () => {
    const values = { site: 'Depot' };
    const result = applyMappings(values, [], FIELDS);
    expect(result.changes).toEqual([]);
    expect(result.values).toBe(values);
  });

  it('returns the same values when the form has no fields', () => {
    const values = {};
    const result = applyMappings(values, [mapping({ fieldId: 'site' })], []);
    expect(result.changes).toEqual([]);
    expect(result.values).toBe(values);
  });

  it('applies false and 0 rather than skipping them as empty', () => {
    const result = applyMappings(
      { wet: true, crew: 9 },
      [mapping({ fieldId: 'wet', value: false }), mapping({ fieldId: 'crew', value: 0 })],
      FIELDS,
    );
    expect(result.values).toEqual({ wet: false, crew: 0 });
    expect(result.changes).toHaveLength(2);
  });
});

describe('partitionByConfidence', () => {
  it('splits on the named threshold, counting the threshold itself as confident', () => {
    const split = partitionByConfidence([
      mapping({ fieldId: 'a', confidence: 1 }),
      mapping({ fieldId: 'b', confidence: SMART_FILL_CONFIDENCE_THRESHOLD }),
      mapping({ fieldId: 'c', confidence: SMART_FILL_CONFIDENCE_THRESHOLD - 0.01 }),
      mapping({ fieldId: 'd', confidence: 0 }),
    ]);
    expect(split.confident.map((m) => m.fieldId)).toEqual(['a', 'b']);
    expect(split.uncertain.map((m) => m.fieldId)).toEqual(['c', 'd']);
  });

  it('puts the API’s default-when-unstated confidence in the review pile', () => {
    const split = partitionByConfidence([mapping({ fieldId: 'a', confidence: 0.5 })]);
    expect(split.uncertain).toHaveLength(1);
  });

  it('treats an unusable confidence as needing review', () => {
    const split = partitionByConfidence([
      mapping({ fieldId: 'a', confidence: Number.NaN }),
      mapping({ fieldId: 'b', confidence: undefined as unknown as number }),
    ]);
    expect(split.confident).toEqual([]);
    expect(split.uncertain).toHaveLength(2);
  });

  it('returns two empty lists for no mappings', () => {
    expect(partitionByConfidence([])).toEqual({ confident: [], uncertain: [] });
  });
});

describe('smartFillFailure', () => {
  it.each([403, 422])('retires the entry point on a %s', (status) => {
    expect(smartFillFailure(status).hide).toBe(true);
  });

  it.each([400, 404, 500, 503, 0])('keeps the entry point on a %s', (status) => {
    expect(smartFillFailure(status).hide).toBe(false);
  });

  it('never leaks a plan tier or an upgrade prompt to the respondent', () => {
    for (const status of [400, 403, 422, 500]) {
      const copy = smartFillFailure(status).message.toLowerCase();
      expect(copy).not.toContain('upgrade');
      expect(copy).not.toContain('plan');
      expect(copy).not.toContain('business');
      expect(copy).not.toContain('enterprise');
    }
  });

  it('always points at typing as the way through', () => {
    for (const status of [400, 403, 422, 500]) {
      expect(smartFillFailure(status).message).not.toBe('');
    }
    expect(smartFillFailure(403).message).toContain('as usual');
    expect(smartFillFailure(500).message).toContain('type them in');
  });
});

describe('smartFillSummary', () => {
  it('tells the respondent to answer by hand when nothing matched', () => {
    expect(smartFillSummary(0, 0)).toContain('Nothing matched');
  });

  it('asks for a check even when everything was confident', () => {
    expect(smartFillSummary(3, 0)).toBe('Filled in 3 answers. Check them before you submit.');
  });

  it('names how many need checking', () => {
    expect(smartFillSummary(4, 2)).toBe(
      'Filled in 4 answers — 2 need checking before you submit.',
    );
  });

  it('agrees in the singular', () => {
    expect(smartFillSummary(1, 1)).toBe(
      'Filled in 1 answer — 1 needs checking before you submit.',
    );
  });

  it('never claims the form is finished', () => {
    for (const [filled, uncertain] of [[0, 0], [1, 0], [5, 5]] as const) {
      expect(smartFillSummary(filled, uncertain).toLowerCase()).not.toContain('done');
    }
  });
});
