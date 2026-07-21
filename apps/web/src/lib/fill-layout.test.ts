import { describe, expect, it } from 'vitest';
import type { FormContainer, FormField } from '@formai/shared';
import { DEFAULT_CONTAINER } from '@formai/shared';
import {
  containerSurfaceStyle,
  fillSpanClass,
  previewSpanClass,
  resolveFillSpan,
  resolveLayout,
} from './fill-layout.js';

function container(patch: Partial<FormContainer> = {}): FormContainer {
  return { ...DEFAULT_CONTAINER, ...patch };
}

describe('resolveLayout', () => {
  it('returns each renderable layout unchanged', () => {
    expect(resolveLayout('card')).toBe('card');
    expect(resolveLayout('hero')).toBe('hero');
    expect(resolveLayout('split')).toBe('split');
  });

  it('returns conversational now that the stepper renders it', () => {
    expect(resolveLayout('conversational')).toBe('conversational');
  });

  it('degrades anything unrecognised to card', () => {
    // This value comes off the network and may predate or postdate this build.
    expect(resolveLayout('carousel')).toBe('card');
    expect(resolveLayout('')).toBe('card');
    expect(resolveLayout(undefined)).toBe('card');
    expect(resolveLayout(null)).toBe('card');
  });
});

describe('containerSurfaceStyle', () => {
  it('maps the saved container onto surface styling', () => {
    const style = containerSurfaceStyle(container({ radius: 20, borderWidth: 2, shadow: 'sm' }));
    expect(style.borderRadius).toBe('20px');
    expect(style.borderWidth).toBe('2px');
    expect(style.borderStyle).toBe('solid');
    expect(style.boxShadow).toBe('var(--shadow-sm)');
  });

  it('omits empty colour fields so the product token keeps applying', () => {
    const style = containerSurfaceStyle(container({ borderColor: '', background: '' }));
    expect(style.borderColor).toBeUndefined();
    expect(style.background).toBeUndefined();
  });

  it('applies colour fields once they are set', () => {
    const style = containerSurfaceStyle(container({ borderColor: '#abcdef', background: '#101010' }));
    expect(style.borderColor).toBe('#abcdef');
    expect(style.background).toBe('#101010');
  });

  it('supports an explicitly shadowless container', () => {
    expect(containerSurfaceStyle(container({ shadow: 'none' })).boxShadow).toBe('none');
  });

  it('returns an empty style for a missing container rather than throwing', () => {
    expect(containerSurfaceStyle(null)).toEqual({});
    expect(containerSurfaceStyle(undefined)).toEqual({});
  });

  it('drops an unrecognised shadow level instead of emitting an empty shadow', () => {
    const style = containerSurfaceStyle(container({ shadow: 'glow' as FormContainer['shadow'] }));
    expect(style.boxShadow).toBeUndefined();
  });
});

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
