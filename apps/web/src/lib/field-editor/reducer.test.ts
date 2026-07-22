/**
 * Pure-logic tests for the builder's seeding path (U8): blank start, seeding
 * from a loaded form's fields, and id-sequence collision safety when a
 * previously-published builder form (with `b<n>` ids) is re-loaded for edit.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { DEFAULT_CONTAINER } from '@formai/shared';
import {
  builderReducer,
  initialBuilderState,
  initialSeq,
  isChoiceType,
  typeOptionsFor,
} from './reducer.js';

function field(id: string, label = id): FormField {
  return { id, type: 'text', label, required: false, source: 'built', colSpan: 12 };
}

describe('initialBuilderState', () => {
  it('starts blank for a new form (no seed fields, nothing selected)', () => {
    const s = initialBuilderState({ formId: null, name: 'Untitled form', fields: [] });
    expect(s.formId).toBeNull();
    expect(s.name).toBe('Untitled form');
    expect(s.fields).toEqual([]);
    expect(s.selectedId).toBeNull();
    expect(s.seq).toBe(0);
    expect(s.container).toEqual(DEFAULT_CONTAINER);
    expect(s.undo).toEqual([]);
  });

  it('seeds from an existing form and keeps its id + container', () => {
    const fields = [field('a'), field('b'), field('c')];
    const container = { ...DEFAULT_CONTAINER, maxWidth: 700, padding: 24, radius: 10 };
    const s = initialBuilderState({ formId: 'f-123', name: 'Site induction', fields, container });
    expect(s.formId).toBe('f-123');
    expect(s.name).toBe('Site induction');
    expect(s.fields).toEqual(fields);
    // Mirrors the original seeded behavior: select the second field when present.
    expect(s.selectedId).toBe('b');
    expect(s.container).toEqual(container);
  });

  it('clones seed fields so reducer mutations never touch the query cache', () => {
    const fields = [field('a')];
    const s = initialBuilderState({ formId: 'f-1', name: 'X', fields });
    expect(s.fields).not.toBe(fields);
    expect(s.fields[0]).not.toBe(fields[0]);
  });
});

describe('initialSeq', () => {
  it('is 0 for no fields', () => {
    expect(initialSeq([])).toBe(0);
  });

  it('uses field count for non-generated ids', () => {
    expect(initialSeq([field('uuid-1'), field('uuid-2')])).toBe(2);
  });

  it('clears the highest b<n> id even when deletions left gaps', () => {
    // 3 fields but max generated id is b4 — length alone would mint a colliding b4.
    expect(initialSeq([field('b1'), field('b2'), field('b4')])).toBe(4);
  });
});

describe('reorder', () => {
  function seeded() {
    return initialBuilderState({
      formId: 'f-1',
      name: 'X',
      fields: [field('a'), field('b'), field('c'), field('d')],
    });
  }

  it('moves a field forward with arrayMove semantics (0 → 3)', () => {
    const s = seeded();
    const next = builderReducer(s, { t: 'reorder', from: 0, to: 3 });
    expect(next.fields.map((f) => f.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves a field backward with arrayMove semantics (3 → 0)', () => {
    const s = seeded();
    const next = builderReducer(s, { t: 'reorder', from: 3, to: 0 });
    expect(next.fields.map((f) => f.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('preserves every field across a reorder', () => {
    const s = seeded();
    const next = builderReducer(s, { t: 'reorder', from: 1, to: 2 });
    expect(next.fields).toHaveLength(4);
    expect(new Set(next.fields.map((f) => f.id))).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('preserves the selection', () => {
    const s = { ...seeded(), selectedId: 'a' };
    const next = builderReducer(s, { t: 'reorder', from: 0, to: 2 });
    expect(next.selectedId).toBe('a');
  });

  it('is a no-op when from === to (state unchanged)', () => {
    const s = seeded();
    const next = builderReducer(s, { t: 'reorder', from: 2, to: 2 });
    expect(next).toBe(s);
  });

  it('ignores out-of-bounds indices', () => {
    const s = seeded();
    expect(builderReducer(s, { t: 'reorder', from: -1, to: 2 })).toBe(s);
    expect(builderReducer(s, { t: 'reorder', from: 0, to: 4 })).toBe(s);
    expect(builderReducer(s, { t: 'reorder', from: 4, to: 0 })).toBe(s);
    expect(builderReducer(s, { t: 'reorder', from: 0, to: -1 })).toBe(s);
  });

  it('records an undo snapshot like move does, so undo restores the prior order', () => {
    const s = seeded();
    const moved = builderReducer(s, { t: 'reorder', from: 0, to: 3 });
    expect(moved.undo).toHaveLength(s.undo.length + 1);
    expect(moved.redo).toEqual([]);
    const undone = builderReducer(moved, { t: 'undo' });
    expect(undone.fields.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('adding to a re-loaded form', () => {
  it('never mints an id that collides with existing b<n> ids', () => {
    const s = initialBuilderState({
      formId: 'f-1',
      name: 'X',
      fields: [field('b1'), field('b2'), field('b4')],
    });
    const next = builderReducer(s, { t: 'add', fieldType: 'text' });
    const ids = next.fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('b5');
  });
});

describe('review finding — reordering cannot orphan a condition', () => {
  const q: FormField = { id: 'q1', type: 'dropdown', label: 'Site', required: false, source: 'built', colSpan: 12 };
  const dep: FormField = {
    id: 'sec', type: 'section_header', label: 'Site A only', required: false, source: 'built', colSpan: 12,
    visibleWhen: { fieldId: 'q1', op: 'equals', value: 'A' },
  };

  it('clears a condition when its source is moved below the dependent', () => {
    // Otherwise the header hides, which hides the source as section content, so
    // the filler can never answer it and the section can never open — while its
    // required questions are silently exempted from validation.
    let s = initialBuilderState({ formId: null, name: 'f', fields: [q, dep] });
    s = builderReducer(s, { t: 'move', id: 'q1', dir: 1 });

    expect(s.fields.map((f) => f.id)).toEqual(['sec', 'q1']);
    expect(s.fields.find((f) => f.id === 'sec')?.visibleWhen).toBeUndefined();
  });

  it('clears it on a drag-reorder too', () => {
    let s = initialBuilderState({ formId: null, name: 'f', fields: [q, dep] });
    s = builderReducer(s, { t: 'reorder', from: 0, to: 1 });
    expect(s.fields.find((f) => f.id === 'sec')?.visibleWhen).toBeUndefined();
  });

  it('leaves a still-valid condition intact', () => {
    const other: FormField = { id: 'z', type: 'text', label: 'Z', required: false, source: 'built', colSpan: 12 };
    let s = initialBuilderState({ formId: null, name: 'f', fields: [q, dep, other] });
    s = builderReducer(s, { t: 'move', id: 'z', dir: -1 });
    expect(s.fields.find((f) => f.id === 'sec')?.visibleWhen).toEqual({
      fieldId: 'q1', op: 'equals', value: 'A',
    });
  });
});

/**
 * Retyping — the guard that keeps an unpublishable field from being authored,
 * and the payload reconciliation that makes a retype reversible.
 *
 * Both editors build their type dropdown from `typeOptionsFor`, so these are
 * the rules for the builder and for import review at once. Before this, review
 * built its dropdown straight from `FORM_FIELD_TYPES` and a reviewer could turn
 * a Date into an optionless Checkbox group that rendered nothing and blocked
 * every submit.
 */
describe('typeOptionsFor', () => {
  const values = (type: FormField['type']) => typeOptionsFor(type).map((o) => o.value);

  it('offers no structural type for a scalar field', () => {
    const v = values('text');
    expect(v).not.toContain('repeating_group');
    expect(v).not.toContain('checkbox_group');
    expect(v).not.toContain('boolean_yes_no');
    expect(v).toContain('date');
    expect(v).toContain('dropdown');
  });

  it('offers a structural field its OWN type, exactly once, and no other', () => {
    const v = values('repeating_group');
    expect(v.filter((x) => x === 'repeating_group')).toHaveLength(1);
    expect(v).not.toContain('checkbox_group');
    expect(v).not.toContain('boolean_yes_no');
    // ...and it stays retypeable to any authorable type.
    expect(v).toContain('text');
  });

  it('does the same for an imported checkbox_group (the fixture Shift field)', () => {
    const v = values('checkbox_group');
    expect(v.filter((x) => x === 'checkbox_group')).toHaveLength(1);
    expect(v).not.toContain('repeating_group');
  });
});

describe('isChoiceType', () => {
  it('covers every type whose answer comes from options', () => {
    expect(isChoiceType('dropdown')).toBe(true);
    expect(isChoiceType('radio')).toBe(true);
    // The gap that made an imported checkbox_group's options uneditable.
    expect(isChoiceType('checkbox_group')).toBe(true);
  });

  it('excludes a lone checkbox, which is a boolean and not a choice', () => {
    expect(isChoiceType('checkbox')).toBe(false);
    expect(isChoiceType('text')).toBe(false);
    expect(isChoiceType('repeating_group')).toBe(false);
  });
});

describe('changeType payload reconciliation', () => {
  function table(id: string): FormField {
    return {
      id,
      type: 'repeating_group',
      label: 'Category A faults',
      required: true,
      source: 'imported',
      colSpan: 12,
      columns: [
        { key: 'item', label: 'Item', type: 'text' },
        { key: 'ok', label: 'OK', type: 'checkbox' },
        { key: 'na', label: 'N/A', type: 'checkbox' },
      ],
      answerSets: [{ key: 'status', columnKeys: ['ok', 'na'] }],
      fixedRows: ['Engine oil level', 'Park brake'],
    };
  }

  const retype = (f: FormField, type: FormField['type']) => {
    const s = initialBuilderState({ formId: null, name: 'n', fields: [f] });
    return builderReducer(s, { t: 'changeType', id: f.id, fieldType: type }).fields[0]!;
  };

  it('drops table payload when a table stops being a table', () => {
    const nf = retype(table('t1'), 'text');
    expect(nf.type).toBe('text');
    expect(nf.columns).toBeUndefined();
    expect(nf.answerSets).toBeUndefined();
    expect(nf.fixedRows).toBeUndefined();
  });

  it('does not resurrect a cleared answer set on the way back', () => {
    // The trap: spreading the old field kept `answerSets` alive through the
    // round trip, so an accepted grouping reappeared attached to a table whose
    // columns had been cleared from under it.
    const once = retype(table('t1'), 'text');
    const back = retype(once, 'repeating_group');
    expect(back.columns).toBeUndefined();
    expect(back.answerSets).toBeUndefined();
    expect(back.fixedRows).toBeUndefined();
  });

  it('seeds options when a field becomes a choice, and clears them when it stops', () => {
    const text = field('q');
    const dd = retype(text, 'dropdown');
    expect(dd.options).toEqual(['Option 1', 'Option 2']);
    expect(retype(dd, 'text').options).toBeUndefined();
  });

  it('preserves real options rather than overwriting them with seeds', () => {
    // The fixture's Shift field: D / N must survive being retyped to a dropdown.
    const shift: FormField = {
      id: 'shift',
      type: 'checkbox_group',
      label: 'Shift',
      required: false,
      source: 'imported',
      colSpan: 12,
      options: ['D', 'N'],
      selectionType: 'single',
    };
    expect(retype(shift, 'dropdown').options).toEqual(['D', 'N']);
  });

  it('clears selectionType, which only a checkbox_group owns', () => {
    const shift: FormField = {
      id: 'shift',
      type: 'checkbox_group',
      label: 'Shift',
      required: false,
      source: 'imported',
      colSpan: 12,
      options: ['D', 'N'],
      selectionType: 'multiple',
    };
    expect(retype(shift, 'dropdown').selectionType).toBeUndefined();
  });

  it('leaves a retype undoable', () => {
    const t = table('t1');
    const s = initialBuilderState({ formId: null, name: 'n', fields: [t] });
    const changed = builderReducer(s, { t: 'changeType', id: 't1', fieldType: 'text' });
    const undone = builderReducer(changed, { t: 'undo' });
    expect(undone.fields[0]).toEqual(t);
  });
});
