/**
 * Which fields a spoken result may land on. A target wrongly excluded is a
 * respondent's sentence thrown away with the banner still reporting success —
 * the one Smart Fill failure nothing downstream can surface.
 */
import { describe, expect, it } from 'vitest';
import type { FormField, SmartFillMapping } from '@formai/shared';
import { visibleFillFields } from '../fill-layout.js';
import { isDictatable } from './coerce.js';
import { applyMappings } from './smart-fill.js';
import { smartFillTargets } from './smart-fill-targets.js';

function field(patch: Partial<FormField> & { id: string }): FormField {
  return { type: 'text', label: patch.id, required: false, source: 'built', ...patch } as FormField;
}

function mapping(patch: Partial<SmartFillMapping> & { fieldId: string }): SmartFillMapping {
  return { value: 'spoken', confidence: 0.9, ...patch };
}

/** What the fill renderer offers a mic for; `check_cross` has no control yet. */
const writable = (f: FormField) => isDictatable(f.type) && f.type !== 'check_cross';

const ids = (fields: readonly FormField[]) => fields.map((f) => f.id);

describe('smartFillTargets', () => {
  it('offers the visible fields when no mapping changes what is showing', () => {
    const fields = [field({ id: 'site' }), field({ id: 'crew', type: 'number' })];
    expect(ids(smartFillTargets(fields, {}, [mapping({ fieldId: 'site' })], writable))).toEqual([
      'site',
      'crew',
    ]);
  });

  it('never offers a field the renderer cannot draw a control for', () => {
    const fields = [
      field({ id: 'site' }),
      field({ id: 'sig', type: 'signature' }),
      field({ id: 'tick', type: 'check_cross' }),
    ];
    expect(ids(smartFillTargets(fields, {}, [], writable))).toEqual(['site']);
  });

  /**
   * The defect this module exists for. One sentence answers the gating question
   * and the question it reveals; judged against the form as it looked before,
   * the second answer was silently discarded.
   */
  it('offers a field that the same result reveals', () => {
    const fields = [
      field({ id: 'incident', type: 'boolean_yes_no', label: 'Any incident?' }),
      field({
        id: 'detail',
        type: 'textarea',
        visibleWhen: { fieldId: 'incident', op: 'equals', value: 'true' },
      }),
    ];
    const mappings = [
      mapping({ fieldId: 'incident', value: true }),
      mapping({ fieldId: 'detail', value: 'the guard came loose' }),
    ];

    // What the screen renders right now, and what used to be handed to
    // `applyMappings` — the spoken description is not on it.
    expect(ids(visibleFillFields(fields, {}))).toEqual(['incident']);

    const targets = smartFillTargets(fields, {}, mappings, writable);
    expect(ids(targets)).toEqual(['incident', 'detail']);

    const applied = applyMappings({}, mappings, targets);
    expect(applied.changes.map((c) => c.fieldId)).toEqual(['incident', 'detail']);
    expect(applied.values.detail).toBe('the guard came loose');
  });

  it('reveals a whole section, not just a single dependent field', () => {
    const fields = [
      field({ id: 'loc', type: 'dropdown', options: ['BBM Mining', 'Raw Materials'] }),
      field({
        id: 'part_b',
        type: 'section_header',
        visibleWhen: { fieldId: 'loc', op: 'equals', value: 'BBM Mining' },
      }),
      field({ id: 'gate' }),
      field({ id: 'plant', type: 'number' }),
    ];
    const mappings = [
      mapping({ fieldId: 'loc', value: 'BBM Mining' }),
      mapping({ fieldId: 'gate', value: 'left open' }),
      mapping({ fieldId: 'plant', value: 4 }),
    ];
    // The header itself takes no answer, so it is not a target — everything it
    // scopes is.
    expect(ids(smartFillTargets(fields, {}, mappings, writable))).toEqual(['loc', 'gate', 'plant']);
  });

  it('follows a chain of reveals to its end', () => {
    const fields = [
      field({ id: 'a', type: 'dropdown', options: ['yes', 'no'] }),
      field({
        id: 'b',
        type: 'dropdown',
        options: ['yes', 'no'],
        visibleWhen: { fieldId: 'a', op: 'equals', value: 'yes' },
      }),
      field({ id: 'c', visibleWhen: { fieldId: 'b', op: 'equals', value: 'yes' } }),
    ];
    const mappings = [
      mapping({ fieldId: 'a', value: 'yes' }),
      mapping({ fieldId: 'b', value: 'yes' }),
      mapping({ fieldId: 'c', value: 'reached' }),
    ];
    expect(ids(smartFillTargets(fields, {}, mappings, writable))).toEqual(['a', 'b', 'c']);
  });

  it('still refuses a field the result leaves hidden', () => {
    const fields = [
      field({ id: 'incident', type: 'boolean_yes_no' }),
      field({
        id: 'detail',
        type: 'textarea',
        visibleWhen: { fieldId: 'incident', op: 'equals', value: 'true' },
      }),
    ];
    const mappings = [
      mapping({ fieldId: 'incident', value: false }),
      mapping({ fieldId: 'detail', value: 'never asked' }),
    ];
    expect(ids(smartFillTargets(fields, {}, mappings, writable))).toEqual(['incident']);
  });

  /**
   * A field the result HIDES loses its target too: writing there would put an
   * answer on a question the merged form does not ask, and the server strips it
   * on save anyway — so counting it as filled would only mislead.
   */
  it('drops a field the result hides on its way past', () => {
    const fields = [
      field({ id: 'incident', type: 'boolean_yes_no' }),
      field({
        id: 'detail',
        type: 'textarea',
        visibleWhen: { fieldId: 'incident', op: 'equals', value: 'true' },
      }),
    ];
    const values = { incident: true, detail: 'earlier note' };
    const mappings = [mapping({ fieldId: 'incident', value: false })];
    expect(ids(smartFillTargets(fields, values, mappings, writable))).toEqual(['incident']);
  });

  it('terminates on a form that conditions a field on its own answer', () => {
    const fields = [
      field({
        id: 'self',
        type: 'dropdown',
        options: ['a', 'b'],
        visibleWhen: { fieldId: 'self', op: 'equals', value: 'a' },
      }),
    ];
    const targets = smartFillTargets(
      fields,
      { self: 'a' },
      [mapping({ fieldId: 'self', value: 'b' })],
      writable,
    );
    expect(targets.length).toBeLessThanOrEqual(1);
  });

  it('returns nothing for a form with no fields', () => {
    expect(smartFillTargets([], {}, [mapping({ fieldId: 'ghost' })], writable)).toEqual([]);
  });
});
