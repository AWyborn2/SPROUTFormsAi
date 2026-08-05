/**
 * Adding, deleting and folding away fields.
 *
 * Almost every test here is about REFERENCES. A field id is named from five
 * places, and a delete that cleans up four of them produces a manifest that
 * fails at publish, naming a field the author cannot see because they already
 * deleted it. The operations take the whole draft and return the whole draft
 * precisely so the half-done version cannot be written.
 */
import { describe, expect, it } from 'vitest';
import type { BuilderStructure, DraftAnswerKey, FormField } from '@formai/shared';
import {
  addField,
  deleteField,
  mergeIntoDescription,
  nextAddedId,
  type FieldEditState,
} from './builder-fields.js';

function field(over: Partial<FormField> & { id: string }): FormField {
  return { label: over.id, type: 'text', required: false, source: 'imported', ...over };
}

function state(over: Partial<FieldEditState> = {}): FieldEditState {
  const fields = over.fields ?? [field({ id: 'a' }), field({ id: 'b' })];
  return {
    fields,
    structure: over.structure ?? [
      { key: 's1', label: 'Section', cols: 1, fields: fields.map((f) => ({ id: f.id })) },
    ],
    keys: over.keys ?? [],
    excluded: over.excluded ?? new Set(),
  };
}

describe('nextAddedId', () => {
  it('numbers from the highest already present, so a re-add cannot collide', () => {
    // Add three, delete the middle, add again: reusing "added-2" would attach a
    // new field to whatever still referenced the old one.
    expect(nextAddedId([field({ id: 'added-1' }), field({ id: 'added-3' })])).toBe('added-4');
  });

  it('starts at one on a document with none', () => {
    expect(nextAddedId([field({ id: 'fx_q_1' })])).toBe('added-1');
  });
});

describe('addField', () => {
  it('inserts directly after the named neighbour', () => {
    // A missed box is missed from SOMEWHERE. Appending and making the author
    // drag it into place is half a feature.
    const next = addField(state(), 's1', 'a', 'text', 'Second signature');
    expect(next.structure[0]!.fields.map((f) => f.id)).toEqual(['a', 'added-1', 'b']);
  });

  it('inserts first when no neighbour is named', () => {
    const next = addField(state(), 's1', null, 'text', 'Preamble');
    expect(next.structure[0]!.fields[0]!.id).toBe('added-1');
  });

  it('marks the field as BUILT, not imported', () => {
    /*
      Provenance that cannot be reconstructed later: an imported field can be
      checked against the paper, a built one cannot, because the paper never had
      it.
    */
    const next = addField(state(), 's1', 'a', 'text', 'Second signature');
    expect(next.fields.at(-1)).toMatchObject({ id: 'added-1', source: 'built', label: 'Second signature' });
  });

  it('seeds options for a choice type, through the shared retype', () => {
    // A radio with no options is a question nobody can answer, and a second
    // seeding rule here would drift from `retypeField`'s.
    const next = addField(state(), 's1', 'a', 'radio', 'Competent?');
    expect((next.fields.at(-1)!.options?.length ?? 0)).toBeGreaterThan(0);
  });

  it('does nothing for a section that is not there', () => {
    const before = state();
    expect(addField(before, 'nope', null, 'text', 'x').fields).toHaveLength(before.fields.length);
  });
});

describe('deleteField', () => {
  it('removes the field from the list AND the arrangement', () => {
    const next = deleteField(state(), 'a');
    expect(next.fields.map((f) => f.id)).toEqual(['b']);
    expect(next.structure[0]!.fields.map((f) => f.id)).toEqual(['b']);
  });

  it('DROPS THE DELETED FIELD’S ANSWER KEY', () => {
    // A key naming a field that does not exist fails validateAnswerKeys at
    // publish, hours after the delete that caused it.
    const keys: DraftAnswerKey[] = [{ fieldId: 'a', answerKey: ['x'], source: 'manual' }];
    expect(deleteField(state({ keys }), 'a').keys).toEqual([]);
  });

  it('CLEARS AN OUTCOME TARGET POINTING AT IT, and the key that needed it', () => {
    /*
      THE ONE THAT MATTERS MOST. Deleting an outcome box leaves the question
      that wrote into it with a mark that has nowhere to land — which the
      validator rejects, naming a field the author deleted and can no longer
      see. Keeping the key would move the failure rather than fix it.
    */
    const fields = [
      field({ id: 'q1', type: 'radio', options: ['a'], answerKey: ['a'], outcomeTarget: { fieldId: 'o1' } }),
      field({ id: 'o1', type: 'check_cross' }),
    ];
    const keys: DraftAnswerKey[] = [{ fieldId: 'q1', answerKey: ['a'], source: 'manual' }];

    const next = deleteField(state({ fields, keys }), 'o1');

    const q1 = next.fields.find((f) => f.id === 'q1')!;
    expect(q1.outcomeTarget).toBeUndefined();
    expect(q1.answerKey).toBeUndefined();
    expect(next.keys).toEqual([]);
  });

  it('leaves an unrelated question’s key and target alone', () => {
    const fields = [
      field({ id: 'q1', outcomeTarget: { fieldId: 'o1' } }),
      field({ id: 'o1', type: 'check_cross' }),
      field({ id: 'spare' }),
    ];
    const keys: DraftAnswerKey[] = [{ fieldId: 'q1', answerKey: ['a'], source: 'manual' }];

    const next = deleteField(state({ fields, keys }), 'spare');

    expect(next.fields.find((f) => f.id === 'q1')!.outcomeTarget).toEqual({ fieldId: 'o1' });
    expect(next.keys).toHaveLength(1);
  });

  it('drops the field from the excluded set too', () => {
    // Otherwise a stale id sits in the set forever, and a later added-N could
    // in principle land on it.
    const next = deleteField(state({ excluded: new Set(['a']) }), 'a');
    expect(next.excluded.has('a')).toBe(false);
  });

  it('does nothing for a field that is not there', () => {
    const before = state();
    expect(deleteField(before, 'nope').fields).toHaveLength(2);
  });
});

describe('mergeIntoDescription', () => {
  it('appends the folded field’s text to the target’s description', () => {
    /*
      The printed shape this exists for: extraction reads an instruction — "Tick
      one box only" — as a fillable text box, because it sits where a box would.
      It is not a field and it is not a heading.
    */
    const fields = [field({ id: 'q1', label: 'Question 1' }), field({ id: 'note', label: 'Tick one box only' })];
    const next = mergeIntoDescription(state({ fields }), 'note', 'q1');

    expect(next.fields.find((f) => f.id === 'q1')!.description).toBe('Tick one box only');
    expect(next.fields.some((f) => f.id === 'note')).toBe(false);
  });

  it('keeps a description the target already had', () => {
    const fields = [
      field({ id: 'q1', description: 'From the SME manual.' }),
      field({ id: 'note', label: 'Tick one box only' }),
    ];
    const next = mergeIntoDescription(state({ fields }), 'note', 'q1');
    expect(next.fields.find((f) => f.id === 'q1')!.description).toBe('From the SME manual. Tick one box only');
  });

  it('cleans up the folded field’s references, via the one delete that knows them', () => {
    const fields = [
      field({ id: 'q1' }),
      field({ id: 'note', label: 'Tick one box only' }),
    ];
    const keys: DraftAnswerKey[] = [{ fieldId: 'note', answerKey: ['x'], source: 'manual' }];
    const next = mergeIntoDescription(state({ fields, keys }), 'note', 'q1');
    expect(next.keys).toEqual([]);
  });

  it('just deletes a field with no text to fold', () => {
    const fields = [field({ id: 'q1' }), field({ id: 'blank', label: '   ' })];
    const next = mergeIntoDescription(state({ fields }), 'blank', 'q1');
    expect(next.fields.find((f) => f.id === 'q1')!.description).toBeUndefined();
    expect(next.fields.some((f) => f.id === 'blank')).toBe(false);
  });

  it('refuses to fold a field into itself', () => {
    const before = state();
    expect(mergeIntoDescription(before, 'a', 'a').fields).toHaveLength(2);
  });
});

describe('the arrangement stays consistent with the field list', () => {
  it('never leaves a structure entry pointing at a field that is gone', () => {
    // resolveStructure reports fields it cannot place, and a dangling entry
    // would show up there as a field lost between extraction and publish.
    const structure: BuilderStructure = [
      { key: 's1', label: 'One', cols: 1, fields: [{ id: 'a' }] },
      { key: 's2', label: 'Two', cols: 1, fields: [{ id: 'b' }] },
    ];
    const next = deleteField(state({ structure }), 'b');
    const referenced = next.structure.flatMap((s) => s.fields.map((f) => f.id));
    const present = new Set(next.fields.map((f) => f.id));
    expect(referenced.every((id) => present.has(id))).toBe(true);
  });
});
