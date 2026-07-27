import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { visibleFillFields } from '../fill-layout.js';
import { applyMappings } from './smart-fill.js';

const FIELDS = [
  { id: 'S', type: 'boolean_yes_no', label: 'Any incident?', required: false, source: 'built' },
  {
    id: 'D',
    type: 'textarea',
    label: 'Describe the incident',
    required: true,
    source: 'built',
    visibleWhen: { fieldId: 'S', op: 'equals', value: 'true' },
  },
] as unknown as FormField[];

describe('reveal-in-same-patch', () => {
  it('shows what actually happens', () => {
    const values = {};
    const visible = visibleFillFields(FIELDS, values);
    expect(visible.map((f) => f.id)).toEqual(['S']);

    const result = applyMappings(
      values,
      [
        { fieldId: 'S', value: true, confidence: 0.95 },
        { fieldId: 'D', value: 'the guard came loose', confidence: 0.9 },
      ],
      visible,
    );
    expect(result.changes.map((c) => c.fieldId)).toEqual(['S']);

    // after the patch D is visible + empty
    const after = visibleFillFields(FIELDS, { S: true });
    expect(after.map((f) => f.id)).toEqual(['S', 'D']);
  });
});
