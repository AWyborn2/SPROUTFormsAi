/**
 * Pure-logic tests for the builder's seeding path (U8): blank start, seeding
 * from a loaded form's fields, and id-sequence collision safety when a
 * previously-published builder form (with `b<n>` ids) is re-loaded for edit.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { DEFAULT_CONTAINER } from '@formai/shared';
import { builderReducer, initialBuilderState, initialSeq } from './reducer.js';

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
