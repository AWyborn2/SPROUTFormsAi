import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import {
  fillSpanClass,
  previewSpanClass,
  resolveFillSpan,
  visibleFillFields,
} from './fill-layout.js';

function field(patch: Partial<FormField>): FormField {
  return {
    id: 'f1',
    type: 'text',
    label: 'Field',
    required: false,
    source: 'built',
    ...patch,
  };
}

describe('resolveFillSpan', () => {
  it('maps the builder col options through when not narrow', () => {
    expect(resolveFillSpan(field({ colSpan: 12 }), false)).toBe(12);
    expect(resolveFillSpan(field({ colSpan: 6 }), false)).toBe(6);
    expect(resolveFillSpan(field({ colSpan: 4 }), false)).toBe(4);
    expect(resolveFillSpan(field({ colSpan: 3 }), false)).toBe(3);
  });

  it('collapses everything to 12 when narrow', () => {
    expect(resolveFillSpan(field({ colSpan: 12 }), true)).toBe(12);
    expect(resolveFillSpan(field({ colSpan: 6 }), true)).toBe(12);
    expect(resolveFillSpan(field({ colSpan: 4 }), true)).toBe(12);
    expect(resolveFillSpan(field({ colSpan: 3 }), true)).toBe(12);
  });

  it('forces repeating_group to 12 regardless of colSpan and narrow', () => {
    // RepeatingGroup cells have min-w-[120px] and overflow partial columns.
    expect(resolveFillSpan(field({ type: 'repeating_group', colSpan: 4 }), false)).toBe(12);
    expect(resolveFillSpan(field({ type: 'repeating_group', colSpan: 4 }), true)).toBe(12);
    expect(resolveFillSpan(field({ type: 'repeating_group' }), false)).toBe(12);
  });

  it('forces signature to 12 regardless of colSpan and narrow', () => {
    expect(resolveFillSpan(field({ type: 'signature', colSpan: 3 }), false)).toBe(12);
    expect(resolveFillSpan(field({ type: 'signature', colSpan: 3 }), true)).toBe(12);
  });

  it('forces section_header to 12 regardless of colSpan', () => {
    expect(resolveFillSpan(field({ type: 'section_header', colSpan: 6 }), false)).toBe(12);
    expect(resolveFillSpan(field({ type: 'section_header' }), false)).toBe(12);
  });

  it('defaults a missing colSpan to 12', () => {
    expect(resolveFillSpan(field({}), false)).toBe(12);
  });

  it('treats out-of-range colSpans as full width', () => {
    // Choice documented here: rather than clamping (0 -> 1, 13 -> 12), any
    // value outside [1..12] — or a non-integer — falls back to the default
    // full-width span of 12. A corrupt layout hint should degrade to the
    // safe stacked layout, never to a sliver column.
    expect(resolveFillSpan(field({ colSpan: 0 }), false)).toBe(12);
    expect(resolveFillSpan(field({ colSpan: 13 }), false)).toBe(12);
    expect(resolveFillSpan(field({ colSpan: -4 }), false)).toBe(12);
    expect(resolveFillSpan(field({ colSpan: 6.5 }), false)).toBe(12);
  });

  it('passes through every integer span inside [1..12]', () => {
    for (let span = 1; span <= 12; span++) {
      expect(resolveFillSpan(field({ colSpan: span }), false)).toBe(span);
    }
  });
});

describe('span class lookups', () => {
  it('fillSpanClass collapses to 12 below sm and applies the span from sm up', () => {
    expect(fillSpanClass(6)).toBe('col-span-12 sm:col-span-6');
    expect(fillSpanClass(12)).toBe('col-span-12 sm:col-span-12');
  });

  it('previewSpanClass is the bare span (narrow prop does the collapsing)', () => {
    expect(previewSpanClass(4)).toBe('col-span-4');
    expect(previewSpanClass(12)).toBe('col-span-12');
  });

  it('both lookups cover every resolvable span and fall back to 12', () => {
    for (let span = 1; span <= 12; span++) {
      expect(fillSpanClass(span)).toBe(`col-span-12 sm:col-span-${span}`);
      expect(previewSpanClass(span)).toBe(`col-span-${span}`);
    }
    expect(fillSpanClass(99)).toBe('col-span-12 sm:col-span-12');
    expect(previewSpanClass(99)).toBe('col-span-12');
  });
});

/**
 * U11 — hidden fields must consume NO layout space. The fill surfaces filter
 * the field list BEFORE laying out the grid, so a hidden field contributes no
 * grid cell at all — as opposed to an empty `col-span-*` wrapper, which would
 * leave a visible gap in the row.
 */
describe('visibleFillFields', () => {
  const trigger = field({ id: 'has_plant', type: 'boolean_yes_no', label: 'Plant?' });
  const conditional = field({
    id: 'plant_reg',
    label: 'Plant registration',
    visibleWhen: { fieldId: 'has_plant', op: 'equals', value: 'true' },
  });
  const after = field({ id: 'notes', label: 'Notes' });

  it('drops a hidden field entirely — no cell, no gap', () => {
    const out = visibleFillFields([trigger, conditional, after], { has_plant: false });
    expect(out.map((f) => f.id)).toEqual(['has_plant', 'notes']);
  });

  it('restores it once its condition is met', () => {
    const out = visibleFillFields([trigger, conditional, after], { has_plant: true });
    expect(out.map((f) => f.id)).toEqual(['has_plant', 'plant_reg', 'notes']);
  });

  it('drops a hidden section header and its whole scope', () => {
    const header = field({
      id: 'plant_section',
      type: 'section_header',
      label: 'Plant',
      visibleWhen: { fieldId: 'has_plant', op: 'equals', value: 'true' },
    });
    const inSection = field({ id: 'plant_owner', label: 'Owner' });
    const out = visibleFillFields([trigger, header, inSection], { has_plant: false });
    expect(out.map((f) => f.id)).toEqual(['has_plant']);
  });

  it('returns a condition-free form unchanged', () => {
    const fields = [trigger, after];
    expect(visibleFillFields(fields, {})).toEqual(fields);
  });
});
