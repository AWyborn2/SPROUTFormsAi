/**
 * Sections → preview pages.
 *
 * The rule that earns its own module: consecutive COVER sections collapse into
 * one page, because a competency paper's cover crams identity, eligibility and
 * verdict onto one sheet. Everything about that rule is a place to get it
 * wrong — where the run starts, what ends it, and what the collapsed page is
 * called when an author splits it by reordering.
 *
 * The page KIND is derived from the fields a section holds rather than from its
 * label, because a label is whatever an author typed. The order those checks
 * run in is the specificity order, and a criteria table and a logbook table are
 * the same field type distinguished only by whether the rows are pre-printed.
 */
import { describe, expect, it } from 'vitest';
import type { BuilderStructure, FormField, StructureSection } from '@formai/shared';
import { clampPage, previewLabel, previewPages, sectionKind } from './builder-pages.js';

function field(over: Partial<FormField> & { id: string }): FormField {
  return { label: over.id, type: 'text', required: false, source: 'imported', ...over };
}

function section(over: Partial<StructureSection> & { key: string }): StructureSection {
  return { label: over.key, cols: 1, fields: [], ...over };
}

function ids(...list: string[]) {
  return list.map((id) => ({ id }));
}

describe('sectionKind', () => {
  const byId = new Map(
    [
      field({ id: 'txt' }),
      field({ id: 'q', type: 'radio', options: ['True', 'False'] }),
      field({ id: 'out', type: 'check_cross' }),
      field({ id: 'crit', type: 'repeating_group', fixedRows: ['Sound the horn', 'Check tags'] }),
      field({ id: 'log', type: 'repeating_group' }),
    ].map((f) => [f.id, f]),
  );

  it('calls a flagged cover section a cover, whatever it holds', () => {
    expect(sectionKind(section({ key: 's', cover: true, fields: ids('txt') }), byId)).toBe('cover');
  });

  it('reads a pre-printed checklist table as a practical', () => {
    expect(sectionKind(section({ key: 's', fields: ids('crit') }), byId)).toBe('practical');
  });

  it('reads an open table as a logbook', () => {
    // Same field type; the difference is whether the rows are printed on the
    // page or added over weeks.
    expect(sectionKind(section({ key: 's', fields: ids('log') }), byId)).toBe('logbook');
  });

  it('prefers practical when a section holds both kinds of table', () => {
    // A criteria list is the more specific claim about what the section is for.
    expect(sectionKind(section({ key: 's', fields: ids('log', 'crit') }), byId)).toBe('practical');
  });

  it('reads choice questions and outcome cells as theory', () => {
    expect(sectionKind(section({ key: 's', fields: ids('q') }), byId)).toBe('theory');
    expect(sectionKind(section({ key: 's', fields: ids('out') }), byId)).toBe('theory');
  });

  it('falls back to plain fields', () => {
    expect(sectionKind(section({ key: 's', fields: ids('txt') }), byId)).toBe('fields');
  });

  it('ignores a field id the arrangement holds but the field list no longer has', () => {
    expect(sectionKind(section({ key: 's', fields: ids('deleted') }), byId)).toBe('fields');
  });
});

describe('previewPages', () => {
  const fields = [
    field({ id: 'c1' }),
    field({ id: 'p1', type: 'check_cross' }),
    field({ id: 'a1' }),
    field({ id: 'q1', type: 'radio', options: ['True', 'False'] }),
    field({ id: 'crit', type: 'repeating_group', fixedRows: ['One'] }),
  ];

  const cover: BuilderStructure = [
    section({ key: 'cov1', label: 'Candidate declaration', cover: true, fields: ids('c1') }),
    section({ key: 'cov2', label: 'Pathway & prerequisites', cover: true, fields: ids('p1') }),
    section({ key: 'cov3', label: 'Assessor feedback & declaration', cover: true, fields: ids('a1') }),
    section({ key: 'theory', label: 'Part 1 — Theory', fields: ids('q1') }),
    section({ key: 'prac', label: 'Part 2 — Practical', fields: ids('crit') }),
  ];

  it('collapses a run of cover sections into one page', () => {
    const pages = previewPages(cover, fields);

    expect(pages).toHaveLength(3);
    expect(pages[0]!.kind).toBe('cover');
    expect(pages[0]!.sectionKeys).toEqual(['cov1', 'cov2', 'cov3']);
  });

  it('titles a collapsed run by its first section and a count', () => {
    // Not by the first alone: splitting the run by reordering then produces two
    // chips reading "Candidate declaration" with no way to tell them apart.
    const pages = previewPages(cover, fields);

    expect(pages[0]!.label).toBe('Candidate declaration + 2 more');
  });

  it('titles a run of one by its own name', () => {
    const pages = previewPages(
      [section({ key: 'cov1', label: 'Candidate declaration', cover: true, fields: ids('c1') })],
      fields,
    );

    expect(pages[0]!.label).toBe('Candidate declaration');
  });

  it('splits the run where an author flags a cover section "own page"', () => {
    const split = cover.map((s) => (s.key === 'cov2' ? { ...s, ownPage: true } : s));
    const pages = previewPages(split, fields);

    expect(pages.map((p) => p.sectionKeys)).toEqual([
      ['cov1'],
      ['cov2'],
      ['cov3'],
      ['theory'],
      ['prac'],
    ]);
    // And the two remaining runs are distinguishable, which is the whole point.
    expect(new Set(pages.slice(0, 3).map((p) => p.label)).size).toBe(3);
  });

  it('ends a cover run at the first non-cover section, and starts a new one after', () => {
    const interrupted: BuilderStructure = [
      section({ key: 'cov1', label: 'Candidate declaration', cover: true, fields: ids('c1') }),
      section({ key: 'theory', label: 'Theory', fields: ids('q1') }),
      section({ key: 'cov2', label: 'Assessor declaration', cover: true, fields: ids('a1') }),
    ];
    const pages = previewPages(interrupted, fields);

    expect(pages.map((p) => p.sectionKeys)).toEqual([['cov1'], ['theory'], ['cov2']]);
  });

  it('gives every non-cover section a page of its own', () => {
    const pages = previewPages(cover, fields);

    expect(pages[1]).toMatchObject({ kind: 'theory', label: 'Part 1 — Theory' });
    expect(pages[2]).toMatchObject({ kind: 'practical', label: 'Part 2 — Practical' });
  });

  it('follows the author’s order', () => {
    const reordered = [cover[4]!, cover[3]!, ...cover.slice(0, 3)];
    const pages = previewPages(reordered, fields);

    expect(pages[0]!.label).toBe('Part 2 — Practical');
    expect(pages[1]!.label).toBe('Part 1 — Theory');
    expect(pages[2]!.sectionKeys).toEqual(['cov1', 'cov2', 'cov3']);
  });

  it('skips an empty section rather than showing a blank page', () => {
    // The section is real and visible in the editor. A blank page in the
    // preview says nothing and pushes the pages an author wants further away.
    const withEmpty = [...cover, section({ key: 'empty', label: 'Empty' })];
    const pages = previewPages(withEmpty, fields);

    expect(pages.map((p) => p.key)).not.toContain('empty');
  });

  it('does not let an empty cover section join a run it contributes nothing to', () => {
    const withEmptyCover: BuilderStructure = [
      section({ key: 'cov1', label: 'Candidate declaration', cover: true, fields: ids('c1') }),
      section({ key: 'covEmpty', label: 'Nothing here', cover: true }),
      section({ key: 'cov3', label: 'Assessor declaration', cover: true, fields: ids('a1') }),
    ];
    const pages = previewPages(withEmptyCover, fields);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.sectionKeys).toEqual(['cov1', 'cov3']);
    expect(pages[0]!.label).toBe('Candidate declaration + 1 more');
  });

  it('returns nothing for an arrangement with no fields anywhere', () => {
    expect(previewPages([section({ key: 'a' }), section({ key: 'b' })], fields)).toEqual([]);
  });
});

describe('clampPage', () => {
  it('keeps an index inside a list that just got shorter', () => {
    expect(clampPage(7, 3)).toBe(2);
    expect(clampPage(-1, 3)).toBe(0);
    expect(clampPage(1, 3)).toBe(1);
  });

  it('returns zero for an empty list rather than a negative index', () => {
    expect(clampPage(4, 0)).toBe(0);
  });
});

describe('previewLabel', () => {
  it('strips the trailing answer words off a Yes/No question', () => {
    // The printed page reads "…required? No Yes" because on paper the boxes ARE
    // beside the text. Rendered beside a pair of controls it asks twice.
    expect(
      previewLabel(
        field({
          id: 'f',
          type: 'boolean_yes_no',
          label: 'More coaching and/or training required? No Yes',
        }),
      ),
    ).toBe('More coaching and/or training required?');
  });

  it('handles either order and a slash', () => {
    for (const tail of ['Yes No', 'Yes/No', 'No / Yes', 'yes no']) {
      expect(previewLabel(field({ id: 'f', type: 'boolean_yes_no', label: `Ready? ${tail}` }))).toBe(
        'Ready?',
      );
    }
  });

  it('only strips at the end, so a question about the words keeps them', () => {
    const label = 'When would you answer Yes rather than No to a permit request?';
    expect(previewLabel(field({ id: 'f', type: 'boolean_yes_no', label }))).toBe(label);
  });

  it('leaves other field types alone', () => {
    expect(previewLabel(field({ id: 'f', type: 'text', label: 'Name Yes No' }))).toBe('Name Yes No');
  });

  it('keeps the original label rather than emptying it', () => {
    // A label that is ONLY the answer words is a bad extraction, and a blank
    // label in its place hides that.
    expect(previewLabel(field({ id: 'f', type: 'boolean_yes_no', label: 'Yes No' }))).toBe('Yes No');
  });
});
