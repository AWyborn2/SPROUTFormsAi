/**
 * Adding, renaming, deleting, folding away and linking up fields.
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
  duplicateSection,
  mergeIntoDescription,
  nextAddedId,
  renameField,
  setOutcomeTarget,
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

describe('renameField', () => {
  it('renames the field the extraction never read', () => {
    /*
      The shape this exists for. `addField` creates "New field" because there is
      no printed label to copy — the extraction MISSED the box — and until this
      existed that string was permanent. The published form said "New field"
      where the paper says "Assessment Result".
    */
    const next = renameField(state(), 'a', 'Assessment Result');

    expect(next.fields.find((f) => f.id === 'a')!.label).toBe('Assessment Result');
  });

  it('stores what was typed, including a trailing space', () => {
    // An author mid-keystroke has one. A rename that trims under the caret
    // fights the person using it.
    const next = renameField(state(), 'a', 'Assessment ');

    expect(next.fields.find((f) => f.id === 'a')!.label).toBe('Assessment ');
  });

  it('leaves every other field exactly as it was', () => {
    const before = state();
    const next = renameField(before, 'a', 'Renamed');

    expect(next.fields.find((f) => f.id === 'b')).toEqual(before.fields[1]);
  });

  it('ignores an id the draft does not have', () => {
    const before = state();
    const next = renameField(before, 'ghost', 'Nothing');

    expect(next.fields).toEqual(before.fields);
  });
});

describe('setOutcomeTarget', () => {
  const LINKABLE = [
    field({ id: 'q1', type: 'radio', options: ['a', 'b'] }),
    field({ id: 'added-1', type: 'check_cross', label: 'Assessment Result', source: 'built' }),
  ];

  it('points a question at a box the author created', () => {
    /*
      THE WHOLE REASON THIS OPERATION EXISTS. `linkOutcomeTargets` pairs by the
      printed reference both fields carry, and a box the extraction missed has
      none — nothing read a reference off a box nobody read. So the field an
      author adds to fix the gap could never receive a mark, and they met that
      as a publish-time refusal with no control that could answer it.
    */
    const next = setOutcomeTarget(state({ fields: LINKABLE }), 'q1', 'added-1');

    expect(next.fields.find((f) => f.id === 'q1')!.outcomeTarget).toEqual({ fieldId: 'added-1' });
  });

  it('clears back to automatic resolution', () => {
    const linked = [{ ...LINKABLE[0]!, outcomeTarget: { fieldId: 'added-1' } }, LINKABLE[1]!];

    const next = setOutcomeTarget(state({ fields: linked }), 'q1', null);

    expect(next.fields.find((f) => f.id === 'q1')!.outcomeTarget).toBeUndefined();
    // Removed, not set to undefined: `resolvePublishFields` reads
    // `field.outcomeTarget ?? resolved`, and both spell the same thing there,
    // but a key present-and-undefined survives JSON round-trips as absent
    // anyway — so storing the absence honestly is the only version with one
    // meaning.
    expect('outcomeTarget' in next.fields.find((f) => f.id === 'q1')!).toBe(false);
  });

  it('REFUSES A TARGET THE EXPORTER WOULD NOT MARK', () => {
    /*
      `validateAnswerKeys` only checks the target field EXISTS. A text box
      passes that, publishes, and then draws nothing — the mark computes,
      validates, ships, and never reaches the page. Refusing here is the only
      point where somebody is still looking.
    */
    const withText = [...LINKABLE, field({ id: 'notes', type: 'text' })];

    const next = setOutcomeTarget(state({ fields: withText }), 'q1', 'notes');

    expect(next.fields.find((f) => f.id === 'q1')!.outcomeTarget).toBeUndefined();
  });

  it('accepts a boolean_yes_no box, because the exporter marks one', () => {
    // The rule is the EXPORTER'S list, not "is it a check_cross". A paper that
    // prints its verdict as Yes/No is the same assessment.
    const withYesNo = [LINKABLE[0]!, field({ id: 'yn', type: 'boolean_yes_no' })];

    const next = setOutcomeTarget(state({ fields: withYesNo }), 'q1', 'yn');

    expect(next.fields.find((f) => f.id === 'q1')!.outcomeTarget).toEqual({ fieldId: 'yn' });
  });

  it('refuses to point a question at itself', () => {
    // The mark would overwrite the answer it was derived from.
    const selfish = [field({ id: 'q1', type: 'check_cross' })];

    const next = setOutcomeTarget(state({ fields: selfish }), 'q1', 'q1');

    expect(next.fields.find((f) => f.id === 'q1')!.outcomeTarget).toBeUndefined();
  });

  it('refuses a target that is not in the draft at all', () => {
    const next = setOutcomeTarget(state({ fields: LINKABLE }), 'q1', 'ghost');

    expect(next.fields.find((f) => f.id === 'q1')!.outcomeTarget).toBeUndefined();
  });

  it('is undone by deleting the box, key and all', () => {
    /*
      The link this operation creates has to be as cleanable as the resolved
      one. `deleteField` clears `outcomeTarget` and the key together, and an
      explicitly-authored target must not survive as a dangling reference the
      publish validator finds hours later.
    */
    const linked = [
      { ...LINKABLE[0]!, answerKey: ['a'], outcomeTarget: { fieldId: 'added-1' } },
      LINKABLE[1]!,
    ];
    const keys: DraftAnswerKey[] = [{ fieldId: 'q1', answerKey: ['a'], source: 'manual' }];

    const next = deleteField(state({ fields: linked, keys }), 'added-1');

    expect(next.fields.find((f) => f.id === 'q1')!.outcomeTarget).toBeUndefined();
    expect(next.keys).toEqual([]);
  });
});

describe('duplicateSection', () => {
  /*
    The paper this exists for: the Scraper prints ONE practical checklist with
    a column per stage where the Dozer printed three copies. The webform wants
    three parts, so the section duplicates and each copy re-bands its column.
  */
  const GEOMETRY = {
    segments: [{ page: 3, x: 40, y: 100, width: 500, height: 300, pageWidth: 595, pageHeight: 842 }],
  };

  function stagedState(): FieldEditState {
    const fields = [
      field({ id: 'hdr', type: 'section_header', label: 'Practical checklist' }),
      field({ id: 'q1', type: 'radio', options: ['a', 'b'], geometry: GEOMETRY, outcomeTarget: { fieldId: 'o1' } }),
      field({ id: 'o1', type: 'check_cross', geometry: GEOMETRY }),
      field({ id: 'outside', type: 'check_cross' }),
    ];
    return {
      fields,
      structure: [
        {
          key: 'sec1',
          label: 'Part 2 — Practical',
          cols: 2,
          headerFieldId: 'hdr',
          fields: [{ id: 'q1', span: 2 }, { id: 'o1' }],
        },
        { key: 'sec2', label: 'Elsewhere', cols: 1, fields: [{ id: 'outside' }] },
      ],
      keys: [{ fieldId: 'q1', answerKey: ['a'], source: 'manual' }],
      excluded: new Set(['o1']),
    };
  }

  it('clones the header and every field under fresh added-N ids', () => {
    const next = duplicateSection(stagedState(), 'sec1');

    // Originals untouched, three clones appended (header + two fields).
    expect(next.fields.map((f) => f.id)).toEqual([
      'hdr', 'q1', 'o1', 'outside', 'added-1', 'added-2', 'added-3',
    ]);
    // Built, not imported: the paper never had a second copy of these boxes.
    expect(next.fields.slice(4).every((f) => f.source === 'built')).toBe(true);
  });

  it('inserts the copy right after the original, ids mapped and label marked', () => {
    const next = duplicateSection(stagedState(), 'sec1');

    expect(next.structure.map((s) => s.label)).toEqual([
      'Part 2 — Practical', 'Part 2 — Practical (copy)', 'Elsewhere',
    ]);
    const copy = next.structure[1]!;
    expect(copy.key).not.toBe('sec1');
    expect(copy.headerFieldId).toBe('added-1');
    // Arrangement metadata survives — span rides along under the new id.
    expect(copy.fields).toEqual([{ id: 'added-2', span: 2 }, { id: 'added-3' }]);
    expect(copy.cols).toBe(2);
  });

  it('COPIES GEOMETRY VERBATIM, as its own object', () => {
    /*
      Verbatim is the point: every copy maps the SAME printed grid, and each
      copy's tables are then trimmed to that stage's column in PDF mapping.
      Its own object, because re-banding the copy must not move the original.
    */
    const next = duplicateSection(stagedState(), 'sec1');

    const original = next.fields.find((f) => f.id === 'q1')!;
    const clone = next.fields.find((f) => f.id === 'added-2')!;
    expect(clone.geometry).toEqual(original.geometry);
    expect(clone.geometry).not.toBe(original.geometry);
  });

  it('remaps an outcome target INSIDE the section to the copied twin', () => {
    // q1 → o1 becomes added-2 → added-3: the copy marks its own verdict box,
    // not the original's.
    const next = duplicateSection(stagedState(), 'sec1');

    expect(next.fields.find((f) => f.id === 'added-2')!.outcomeTarget).toEqual({ fieldId: 'added-3' });
  });

  it('DROPS an outcome target pointing outside the section', () => {
    /*
      Two questions writing one printed cell would overdraw each other's
      verdicts — the copy loses the link rather than sharing the box.
    */
    const base = stagedState();
    base.fields = base.fields.map((f) =>
      f.id === 'q1' ? { ...f, outcomeTarget: { fieldId: 'outside' } } : f,
    );

    const next = duplicateSection(base, 'sec1');

    expect(next.fields.find((f) => f.id === 'q1')!.outcomeTarget).toEqual({ fieldId: 'outside' });
    expect(next.fields.find((f) => f.id === 'added-2')!.outcomeTarget).toBeUndefined();
  });

  it('does NOT clone answer keys', () => {
    // A key's verification is a person's attestation on ONE field. The copy
    // starts unkeyed and gets keyed on its own.
    const next = duplicateSection(stagedState(), 'sec1');

    expect(next.keys).toEqual([{ fieldId: 'q1', answerKey: ['a'], source: 'manual' }]);
  });

  it('mirrors exclusions, so a turned-off original does not come back on as its copy', () => {
    const next = duplicateSection(stagedState(), 'sec1');

    expect(next.excluded.has('o1')).toBe(true);
    expect(next.excluded.has('added-3')).toBe(true);
    expect(next.excluded.has('added-2')).toBe(false);
  });

  it('numbers clones past added-N ids already in the draft', () => {
    const base = stagedState();
    base.fields = [...base.fields, field({ id: 'added-7', source: 'built' })];

    const next = duplicateSection(base, 'sec1');

    expect(next.structure[1]!.headerFieldId).toBe('added-8');
  });

  it('does nothing for a section that is not there', () => {
    const before = stagedState();
    const next = duplicateSection(before, 'ghost');

    expect(next.fields).toHaveLength(before.fields.length);
    expect(next.structure).toHaveLength(2);
  });
});
