/**
 * The structure model.
 *
 * Two properties carry this module, and both exist because the design
 * prototype's stateful equivalent got them wrong in ways that took three
 * rounds of bug reports to pin down:
 *
 *  · every operation is IDEMPOTENT BY REFERENCE, so a `dragOver` that fires
 *    forty times over one row produces one change and thirty-nine no-ops;
 *  · an emptied section is KEPT, so the place a field came from is still a
 *    drop target when the author changes their mind.
 *
 * The third property is `resolveStructure` losing nothing: a field that
 * disappears between the extraction and the published version is a box nobody
 * will ever fill in and nobody will notice is missing.
 */
import { describe, expect, it } from 'vitest';
import type { ExtractedField, ExtractionResult, FormField } from '@formai/shared';
import {
  colSpanFor,
  cycleFieldSpan,
  dissolveSection,
  dropSlotKey,
  groupIntoSection,
  moveField,
  moveSection,
  renameSection,
  resolveStructure,
  setOwnPage,
  setSectionColumns,
  structureFromExtraction,
} from './builder-structure.js';

function ex(over: Partial<ExtractedField> & { id: string }): ExtractedField {
  return { label: over.id, type: 'text', confidence: 0.9, ...over };
}

function extraction(fields: ExtractedField[]): ExtractionResult {
  return {
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'tool.pdf',
    pageCount: 18,
    fields,
    designNotes: [],
  };
}

function field(over: Partial<FormField> & { id: string }): FormField {
  return { label: over.id, type: 'text', required: false, source: 'imported', ...over };
}

/** Three sections, five fields — the shape most tests below start from. */
function sample() {
  return structureFromExtraction(
    extraction([
      ex({ id: 'h1', type: 'section_header', label: 'Part 1' }),
      ex({ id: 'a', label: 'A' }),
      ex({ id: 'b', label: 'B' }),
      ex({ id: 'h2', type: 'section_header', label: 'Part 2' }),
      ex({ id: 'c', label: 'C' }),
      ex({ id: 'h3', type: 'section_header', label: 'Part 3' }),
      ex({ id: 'd', label: 'D' }),
      ex({ id: 'e', label: 'E' }),
    ]),
  );
}

describe('structureFromExtraction', () => {
  it('opens a section at each heading and runs it to the next', () => {
    const structure = sample();

    expect(structure.map((s) => s.label)).toEqual(['Part 1', 'Part 2', 'Part 3']);
    expect(structure[0]!.fields.map((f) => f.id)).toEqual(['a', 'b']);
    expect(structure[1]!.fields.map((f) => f.id)).toEqual(['c']);
    expect(structure[2]!.fields.map((f) => f.id)).toEqual(['d', 'e']);
  });

  it('keeps the heading out of its own section’s fields', () => {
    // A heading is structure, not something somebody fills in — the same rule
    // `fieldsInSection` applies in @formai/shared.
    const structure = sample();

    expect(structure.flatMap((s) => s.fields.map((f) => f.id))).not.toContain('h1');
    expect(structure[0]!.headerFieldId).toBe('h1');
  });

  it('keys a section from its heading’s id, not its label', () => {
    // "Plan and prepare" prints once per practical part on a real assessment;
    // a label-derived key would collide and merge two different sections.
    const structure = structureFromExtraction(
      extraction([
        ex({ id: 'h1', type: 'section_header', label: 'Plan and prepare' }),
        ex({ id: 'a' }),
        ex({ id: 'h2', type: 'section_header', label: 'Plan and prepare' }),
        ex({ id: 'b' }),
      ]),
    );

    expect(structure).toHaveLength(2);
    expect(new Set(structure.map((s) => s.key)).size).toBe(2);
  });

  it('keeps a heading that has nothing under it', () => {
    // Either the extraction missed what belongs there, or the author has
    // somewhere to drag fields into. Both are worth showing.
    const structure = structureFromExtraction(
      extraction([
        ex({ id: 'h1', type: 'section_header', label: 'Empty part' }),
        ex({ id: 'h2', type: 'section_header', label: 'Part 2' }),
        ex({ id: 'a' }),
      ]),
    );

    expect(structure).toHaveLength(2);
    expect(structure[0]!.fields).toEqual([]);
  });

  it('names the fields printed before any heading rather than inventing a title', () => {
    const structure = structureFromExtraction(
      extraction([ex({ id: 'a' }), ex({ id: 'h1', type: 'section_header', label: 'Part 1' })]),
    );

    expect(structure[0]!.label).toBe('Fields before the first heading');
    expect(structure[0]!.fields.map((f) => f.id)).toEqual(['a']);
  });

  it('groups the cover into its three declared sections, in printed order', () => {
    const structure = structureFromExtraction(
      extraction([
        ex({ id: 'r1', coverSection: 'assessor_declaration' }),
        ex({ id: 'c1', coverSection: 'candidate_declaration' }),
        ex({ id: 'p1', coverSection: 'pathway_prerequisites' }),
        ex({ id: 'h1', type: 'section_header', label: 'Part 1' }),
        ex({ id: 'a' }),
      ]),
    );

    expect(structure.slice(0, 3).map((s) => s.label)).toEqual([
      'Candidate declaration',
      'Pathway & prerequisites',
      'Assessor feedback & declaration',
    ]);
    expect(structure.slice(0, 3).every((s) => s.cover)).toBe(true);
  });

  it('omits a cover section the document does not have', () => {
    const structure = structureFromExtraction(
      extraction([ex({ id: 'c1', coverSection: 'candidate_declaration' })]),
    );

    expect(structure).toHaveLength(1);
  });

  it('leaves an unmarked cover field in the ordinary run, where it is visible', () => {
    // Filing it under a guess would hide the fact that the model did not
    // classify it.
    const structure = structureFromExtraction(
      extraction([
        ex({ id: 'c1', coverSection: 'candidate_declaration' }),
        ex({ id: 'x' }),
        ex({ id: 'h1', type: 'section_header', label: 'Part 1' }),
      ]),
    );

    expect(structure[0]!.fields.map((f) => f.id)).toEqual(['c1']);
    expect(structure[1]!.label).toBe('Fields before the first heading');
    expect(structure[1]!.fields.map((f) => f.id)).toEqual(['x']);
  });
});

describe('moveSection', () => {
  it('moves a section earlier and later', () => {
    const s = sample();

    expect(moveSection(s, s[2]!.key, -1).map((x) => x.label)).toEqual([
      'Part 1',
      'Part 3',
      'Part 2',
    ]);
    expect(moveSection(s, s[0]!.key, 1).map((x) => x.label)).toEqual([
      'Part 2',
      'Part 1',
      'Part 3',
    ]);
  });

  it('clamps at both ends rather than wrapping', () => {
    const s = sample();

    expect(moveSection(s, s[0]!.key, -1)).toBe(s);
    expect(moveSection(s, s[2]!.key, 1)).toBe(s);
  });

  it('ignores an unknown section', () => {
    const s = sample();
    expect(moveSection(s, 'nope', 1)).toBe(s);
  });
});

describe('moveField', () => {
  it('moves a field to another section', () => {
    const s = sample();
    const next = moveField(s, 'a', s[1]!.key, 'c');

    expect(next[0]!.fields.map((f) => f.id)).toEqual(['b']);
    expect(next[1]!.fields.map((f) => f.id)).toEqual(['a', 'c']);
  });

  it('respects the midpoint: `after` inserts below the hovered row', () => {
    const s = sample();

    expect(moveField(s, 'a', s[2]!.key, 'd', false)[2]!.fields.map((f) => f.id)).toEqual([
      'a',
      'd',
      'e',
    ]);
    expect(moveField(s, 'a', s[2]!.key, 'd', true)[2]!.fields.map((f) => f.id)).toEqual([
      'd',
      'a',
      'e',
    ]);
  });

  it('appends when the drop names no row — dropping on empty space', () => {
    const s = sample();
    const next = moveField(s, 'a', s[1]!.key, null);

    expect(next[1]!.fields.map((f) => f.id)).toEqual(['c', 'a']);
  });

  it('returns the SAME array when the order would not change', () => {
    // This is what makes a continuously-firing dragOver free. The prototype
    // re-ran the whole move on every fire and the row oscillated.
    const s = sample();
    const once = moveField(s, 'a', s[1]!.key, 'c');
    const twice = moveField(once, 'a', once[1]!.key, 'c');
    const thrice = moveField(twice, 'a', twice[1]!.key, 'c');

    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it('is a no-op when a field is dropped on itself', () => {
    const s = sample();
    expect(moveField(s, 'a', s[0]!.key, 'a')).toBe(s);
  });

  it('is a no-op when the field is already exactly there', () => {
    const s = sample();
    expect(moveField(s, 'a', s[0]!.key, 'b', false)).toBe(s);
  });

  it('keeps a section that has just been emptied', () => {
    // The section a field came from is where the author is most likely to drop
    // it back, and a section that vanishes mid-drag has no drop target.
    const s = sample();
    const next = moveField(s, 'c', s[0]!.key, null);

    expect(next).toHaveLength(3);
    expect(next[1]!.fields).toEqual([]);
  });

  it('can move a field back into a section it emptied', () => {
    const s = sample();
    const emptied = moveField(s, 'c', s[0]!.key, null);
    const back = moveField(emptied, 'c', emptied[1]!.key, null);

    expect(back[1]!.fields.map((f) => f.id)).toEqual(['c']);
    expect(back[0]!.fields.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('carries a field’s span with it', () => {
    const s = setSectionColumns(sample(), sample()[0]!.key, 3);
    const spanned = cycleFieldSpan(s, s[0]!.key, 'a');
    const moved = moveField(spanned, 'a', spanned[1]!.key, null);

    expect(moved[1]!.fields.find((f) => f.id === 'a')?.span).toBe(2);
  });

  it('ignores an unknown field or an unknown target section', () => {
    const s = sample();

    expect(moveField(s, 'nope', s[0]!.key, null)).toBe(s);
    expect(moveField(s, 'a', 'nope', null)).toBe(s);
  });
});

describe('dropSlotKey', () => {
  it('distinguishes the two halves of one row, and the end of a section', () => {
    expect(dropSlotKey('s1', 'a', false)).not.toBe(dropSlotKey('s1', 'a', true));
    expect(dropSlotKey('s1', null, false)).toContain('#end');
  });
});

describe('groupIntoSection', () => {
  it('pulls the ticked fields into a new own-page section', () => {
    const s = sample();
    const next = groupIntoSection(s, ['a', 'd'], 'Sign-off', 'secnew1');

    expect(next).toHaveLength(4);
    expect(next[3]!.label).toBe('Sign-off');
    expect(next[3]!.ownPage).toBe(true);
    expect(next[3]!.fields.map((f) => f.id)).toEqual(['a', 'd']);
    expect(next[0]!.fields.map((f) => f.id)).toEqual(['b']);
    expect(next[2]!.fields.map((f) => f.id)).toEqual(['e']);
  });

  it('orders by the arrangement, not by the order they were ticked', () => {
    const s = sample();
    const next = groupIntoSection(s, ['e', 'b'], 'Group', 'secnew1');

    expect(next[3]!.fields.map((f) => f.id)).toEqual(['b', 'e']);
  });

  it('drops spans, which mean nothing in a new single-column section', () => {
    const widened = setSectionColumns(sample(), sample()[0]!.key, 3);
    const spanned = cycleFieldSpan(widened, widened[0]!.key, 'a');
    const next = groupIntoSection(spanned, ['a'], 'Group', 'secnew1');

    expect(next[3]!.fields[0]!.span).toBeUndefined();
  });

  it('keeps a section it emptied', () => {
    const s = sample();
    const next = groupIntoSection(s, ['c'], 'Group', 'secnew1');

    expect(next.find((x) => x.key === s[1]!.key)?.fields).toEqual([]);
  });

  it('does nothing when nothing is ticked, or nothing ticked exists', () => {
    const s = sample();

    expect(groupIntoSection(s, [], 'Group', 'k')).toBe(s);
    expect(groupIntoSection(s, ['nope'], 'Group', 'k')).toBe(s);
  });
});

describe('section settings', () => {
  it('renames, and is a no-op for the same name', () => {
    const s = sample();
    expect(renameSection(s, s[0]!.key, 'Part 1')).toBe(s);
    expect(renameSection(s, s[0]!.key, 'Theory')[0]!.label).toBe('Theory');
  });

  it('sets columns without rewriting the spans underneath', () => {
    // Narrowing must not destroy work the author can see they did: the stored
    // span stays, and `resolveSpan` clamps it on read.
    const three = setSectionColumns(sample(), sample()[0]!.key, 3);
    const spanned = cycleFieldSpan(cycleFieldSpan(three, three[0]!.key, 'a'), three[0]!.key, 'a');
    expect(spanned[0]!.fields[0]!.span).toBe(3);

    const narrowed = setSectionColumns(spanned, spanned[0]!.key, 2);
    expect(narrowed[0]!.fields[0]!.span).toBe(3);

    const widened = setSectionColumns(narrowed, narrowed[0]!.key, 3);
    expect(widened[0]!.fields[0]!.span).toBe(3);
  });

  it('toggles own-page, and is a no-op for the same value', () => {
    const s = sample();
    const on = setOwnPage(s, s[0]!.key, true);

    expect(on[0]!.ownPage).toBe(true);
    expect(setOwnPage(on, on[0]!.key, true)).toBe(on);
  });
});

describe('cycleFieldSpan', () => {
  it('cycles 1 → 2 → 3 → 1 in a three-column section', () => {
    let s = setSectionColumns(sample(), sample()[0]!.key, 3);
    const key = s[0]!.key;

    s = cycleFieldSpan(s, key, 'a');
    expect(s[0]!.fields[0]!.span).toBe(2);
    s = cycleFieldSpan(s, key, 'a');
    expect(s[0]!.fields[0]!.span).toBe(3);
    s = cycleFieldSpan(s, key, 'a');
    expect(s[0]!.fields[0]!.span).toBe(1);
  });

  it('does nothing in a single-column section, where there is one value', () => {
    const s = sample();
    expect(cycleFieldSpan(s, s[0]!.key, 'a')).toBe(s);
  });
});

describe('dissolveSection', () => {
  it('returns a section’s fields to the one before it', () => {
    const s = sample();
    const next = dissolveSection(s, s[1]!.key);

    expect(next).toHaveLength(2);
    expect(next[0]!.fields.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('sends the first section’s fields forward, since it has nothing before it', () => {
    const s = sample();
    const next = dissolveSection(s, s[0]!.key);

    expect(next).toHaveLength(2);
    expect(next[0]!.fields.map((f) => f.id)).toEqual(['c', 'a', 'b']);
  });

  it('refuses to dissolve the only section, which would lose its fields', () => {
    const one = structureFromExtraction(
      extraction([ex({ id: 'h1', type: 'section_header', label: 'Only' }), ex({ id: 'a' })]),
    );

    expect(dissolveSection(one, one[0]!.key)).toBe(one);
  });
});

describe('colSpanFor', () => {
  it('maps onto the twelve-column grid the fill surfaces already use', () => {
    // Not a new grid — `FormField.colSpan` has always been out of twelve, and
    // `resolveFillSpan` reads it on every fill surface.
    expect(colSpanFor(1, 1)).toBe(12);
    expect(colSpanFor(1, 2)).toBe(6);
    expect(colSpanFor(2, 2)).toBe(12);
    expect(colSpanFor(1, 3)).toBe(4);
    expect(colSpanFor(2, 3)).toBe(8);
    expect(colSpanFor(3, 3)).toBe(12);
  });
});

describe('resolveStructure', () => {
  const fields = [
    field({ id: 'h1', type: 'section_header', label: 'Part 1' }),
    field({ id: 'a' }),
    field({ id: 'b' }),
    field({ id: 'h2', type: 'section_header', label: 'Part 2' }),
    field({ id: 'c' }),
  ];
  const structure = structureFromExtraction(
    extraction([
      ex({ id: 'h1', type: 'section_header', label: 'Part 1' }),
      ex({ id: 'a' }),
      ex({ id: 'b' }),
      ex({ id: 'h2', type: 'section_header', label: 'Part 2' }),
      ex({ id: 'c' }),
    ]),
  );

  it('emits each section’s heading followed by its fields, in the author’s order', () => {
    const { fields: out } = resolveStructure(moveSection(structure, structure[1]!.key, -1), fields);

    expect(out.map((f) => f.id)).toEqual(['h2', 'c', 'h1', 'a', 'b']);
  });

  it('reuses the extracted heading field rather than minting a replacement', () => {
    // A heading is a real field with a real id, and a manifest part's
    // `startFieldId` may already anchor to it.
    const { fields: out } = resolveStructure(structure, fields);

    expect(out[0]!.id).toBe('h1');
    expect(out[0]!.source).toBe('imported');
  });

  it('carries a renamed section onto its heading', () => {
    const renamed = renameSection(structure, structure[0]!.key, 'Theory assessment');
    const { fields: out } = resolveStructure(renamed, fields);

    expect(out[0]!.label).toBe('Theory assessment');
  });

  it('synthesises a heading for a section the author created', () => {
    // Without one, `visibility.ts` and `fieldsInPart` cannot see the grouping
    // at all, so the author's section would not survive as a section.
    const grouped = groupIntoSection(structure, ['a'], 'Sign-off', 'secnew1');
    const { fields: out } = resolveStructure(grouped, fields);

    const header = out.find((f) => f.label === 'Sign-off');
    expect(header?.type).toBe('section_header');
    expect(header?.source).toBe('built');
    expect(out.at(-1)!.id).toBe('a');
  });

  it('writes each field’s span onto the twelve-column grid', () => {
    const three = setSectionColumns(structure, structure[0]!.key, 3);
    const { fields: out } = resolveStructure(three, fields);

    expect(out.find((f) => f.id === 'a')!.colSpan).toBe(4);
  });

  it('clamps a span wider than its section without rewriting the author’s value', () => {
    const three = setSectionColumns(structure, structure[0]!.key, 3);
    const wide = cycleFieldSpan(cycleFieldSpan(three, three[0]!.key, 'a'), three[0]!.key, 'a');
    const narrowed = setSectionColumns(wide, wide[0]!.key, 2);
    const { fields: out } = resolveStructure(narrowed, fields);

    // Stored 3, rendered 2-of-2 — full width, not overflowing.
    expect(narrowed[0]!.fields[0]!.span).toBe(3);
    expect(out.find((f) => f.id === 'a')!.colSpan).toBe(12);
  });

  it('reports a field the arrangement never placed instead of dropping it', () => {
    // A field lost between the extraction and the published version is a box
    // nobody will ever fill in and nobody will notice is missing.
    const { orphanIds } = resolveStructure(structure, [...fields, field({ id: 'stray' })]);

    expect(orphanIds).toEqual(['stray']);
  });

  it('does not report an unused heading as an orphan', () => {
    // A heading whose section was dissolved is structure that no longer
    // applies, not a lost input.
    const dissolved = dissolveSection(structure, structure[1]!.key);
    const { orphanIds, fields: out } = resolveStructure(dissolved, fields);

    expect(orphanIds).toEqual([]);
    expect(out.map((f) => f.id)).toEqual(['h1', 'a', 'b', 'c']);
  });

  it('skips a structure entry whose field has been deleted', () => {
    const { fields: out, orphanIds } = resolveStructure(
      structure,
      fields.filter((f) => f.id !== 'b'),
    );

    expect(out.map((f) => f.id)).toEqual(['h1', 'a', 'h2', 'c']);
    expect(orphanIds).toEqual([]);
  });
});
