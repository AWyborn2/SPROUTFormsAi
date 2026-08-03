/**
 * Grouping a part's fields under the headings the document already prints.
 *
 * The Track Dozer has 185 fields. Flat, an author hunting for the assessor's
 * comments box scrolls past sixty checklist criteria — so the builder groups
 * them, and reads the grouping off the paper rather than inventing one.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { groupFieldsByHeading, totalFields } from './workflow-groups.js';

const heading = (id: string, label: string): FormField => ({
  id,
  type: 'section_header',
  label,
  required: false,
  source: 'imported',
});

const input = (id: string): FormField => ({
  id,
  type: 'text',
  label: id,
  required: false,
  source: 'imported',
});

describe('groupFieldsByHeading', () => {
  it('starts a group at each printed heading', () => {
    const groups = groupFieldsByHeading([
      heading('h1', 'Plan & Prepare'),
      input('a'),
      input('b'),
      heading('h2', 'Start-Up Procedure'),
      input('c'),
    ]);

    expect(groups.map((g) => g.heading)).toEqual(['Plan & Prepare', 'Start-Up Procedure']);
    expect(groups[0]!.fields.map((f) => f.id)).toEqual(['a', 'b']);
    expect(groups[1]!.fields.map((f) => f.id)).toEqual(['c']);
  });

  it('puts fields before the first heading in an untitled leading group', () => {
    /*
      Happens on a part whose anchor IS its heading — the heading is consumed as
      the part's start and never appears in the slice — and on the cover page,
      which prints no headings at all. Dropping those fields would hide them
      from the only screen that assigns ownership.
    */
    const groups = groupFieldsByHeading([input('a'), heading('h1', 'Later'), input('b')]);

    expect(groups[0]!.heading).toBeNull();
    expect(groups[0]!.fields.map((f) => f.id)).toEqual(['a']);
  });

  it('does not offer the heading itself as a field', () => {
    // A printed line of text carries no answer, so asking who may fill it is a
    // question with no meaning.
    const groups = groupFieldsByHeading([heading('h1', 'Plan'), input('a')]);

    expect(groups[0]!.fields.map((f) => f.id)).toEqual(['a']);
    expect(groups.flatMap((g) => g.fields).some((f) => f.type === 'section_header')).toBe(false);
  });

  it('drops a heading with nothing under it', () => {
    // A printed divider, not a group. Keeping it gives an author an empty box.
    const groups = groupFieldsByHeading([
      heading('h1', 'Empty'),
      heading('h2', 'Real'),
      input('a'),
    ]);

    expect(groups.map((g) => g.heading)).toEqual(['Real']);
  });

  it('returns nothing for a part with no answerable fields', () => {
    expect(groupFieldsByHeading([heading('h1', 'Only a heading')])).toEqual([]);
    expect(groupFieldsByHeading([])).toEqual([]);
  });

  it('counts every field across groups', () => {
    const groups = groupFieldsByHeading([
      input('a'),
      heading('h1', 'One'),
      input('b'),
      input('c'),
    ]);

    expect(totalFields(groups)).toBe(3);
  });
});
