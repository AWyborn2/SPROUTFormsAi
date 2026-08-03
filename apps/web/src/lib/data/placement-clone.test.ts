/**
 * When one field's placement may be reused on another.
 *
 * This module is mostly REFUSAL, and the refusals are the point. Parts 2, 4 and
 * 6 of an assessment are one checklist printed three times, so copying the grid
 * across saves measuring the same twenty-two rows three times. But a grid
 * stretched over the wrong number of rows does not fail visibly — it lands
 * every mark one row out, on a document certifying somebody is safe to operate
 * a dozer, and nothing downstream can tell.
 *
 * So each test below is a way two tables can look alike and not be alike.
 */
import { describe, expect, it } from 'vitest';
import type { PageBox } from '@formai/shared';
import { type ClonableField, cloneCandidates, cloneRefusal, clonedBox } from './placement-clone.js';

/** A 22-row practical checklist with tick / cross / N-A columns. */
function checklist(id: string, over: Partial<ClonableField> = {}): ClonableField {
  return {
    id,
    label: `${id} checklist`,
    type: 'repeating_group',
    columns: [
      { key: 'yes', label: 'Yes', type: 'check_cross' },
      { key: 'no', label: 'No', type: 'check_cross' },
      { key: 'na', label: 'N/A', type: 'check_cross' },
    ],
    fixedRows: Array.from({ length: 22 }, (_, i) => `Criterion ${i + 1}`),
    ...over,
  };
}

function choice(id: string, options: string[]): ClonableField {
  return { id, label: id, type: 'checkbox_group', options };
}

describe('cloneRefusal', () => {
  it('allows one checklist onto an identical one', () => {
    expect(cloneRefusal(checklist('p2'), checklist('p4'))).toBeNull();
  });

  it('refuses a field onto itself', () => {
    expect(cloneRefusal(checklist('p2'), checklist('p2'))).toContain('same field');
  });

  it('refuses across different kinds of field', () => {
    expect(cloneRefusal(checklist('p2'), choice('shift', ['D', 'N']))).toContain('different kinds');
  });

  it('refuses when the row counts differ', () => {
    // The dangerous one. Two checklists that look identical on the page but one
    // has an extra criterion: every mark below it lands a row out.
    const twentyFour = checklist('p4', {
      fixedRows: Array.from({ length: 24 }, (_, i) => `Criterion ${i + 1}`),
    });
    expect(cloneRefusal(checklist('p2'), twentyFour)).toContain('has 22 rows, this one has 24');
  });

  it('refuses when the column counts differ', () => {
    const noNa = checklist('p4', {
      columns: [
        { key: 'yes', label: 'Yes', type: 'check_cross' },
        { key: 'no', label: 'No', type: 'check_cross' },
      ],
    });
    expect(cloneRefusal(checklist('p2'), noNa)).toContain('has 3 columns, this one has 2');
  });

  it('refuses when the columns are named differently, even with the same count', () => {
    /*
      Bands are addressed by column KEY. Three columns each, but named
      differently, would copy a grid whose bands name columns the target does
      not have — the marks then have nowhere to land, silently.
    */
    const renamed = checklist('p4', {
      columns: [
        { key: 'sat', label: 'Satisfactory', type: 'check_cross' },
        { key: 'unsat', label: 'Not satisfactory', type: 'check_cross' },
        { key: 'na', label: 'N/A', type: 'check_cross' },
      ],
    });
    expect(cloneRefusal(checklist('p2'), renamed)).toContain('named differently');
  });

  it('refuses when a choice field has different options', () => {
    // Each option's box is keyed by its value, so mismatched options would
    // place some and silently leave the rest unplaced.
    expect(cloneRefusal(choice('a', ['D', 'N']), choice('b', ['D', 'A', 'N']))).toContain('has 2 options, this one has 3');
    expect(cloneRefusal(choice('a', ['D', 'N']), choice('b', ['Day', 'Night']))).toContain(
      'options differ',
    );
  });

  it('allows a choice field onto one with the same options in the same order', () => {
    expect(cloneRefusal(choice('a', ['D', 'N']), choice('b', ['D', 'N']))).toBeNull();
  });

  it('refuses the same options in a different order', () => {
    // Order is identity here: the boxes are copied positionally, so a reversed
    // pair would place Day's box on Night.
    expect(cloneRefusal(choice('a', ['D', 'N']), choice('b', ['N', 'D']))).toContain('options differ');
  });
});

describe('clonedBox', () => {
  const source: PageBox = {
    page: 3,
    x: 60,
    y: 120,
    width: 480,
    height: 300,
    pageWidth: 595,
    pageHeight: 842,
    columnBands: [
      { key: 'yes', start: 400, end: 430 },
      { key: 'no', start: 440, end: 470 },
    ],
    rowBands: [
      { key: 'r1', start: 400, end: 414 },
      { key: 'r2', start: 386, end: 400 },
    ],
  };

  it('changes the page and nothing else about the shape', () => {
    const out = clonedBox(source, 7, 595, 842);

    expect(out.page).toBe(7);
    expect(out.x).toBe(source.x);
    expect(out.y).toBe(source.y);
    expect(out.width).toBe(source.width);
    expect(out.height).toBe(source.height);
    expect(out.columnBands).toEqual(source.columnBands);
    expect(out.rowBands).toEqual(source.rowBands);
  });

  it('copies the bands rather than sharing them', () => {
    // Two placements sharing one band array would mean dragging an edge on the
    // copy silently moved the original's grid too.
    const out = clonedBox(source, 7, 595, 842);
    out.columnBands![0]!.start = 999;

    expect(source.columnBands![0]!.start).toBe(400);
  });
});

describe('cloneCandidates', () => {
  it('offers placed fields, and says why the unusable ones are unusable', () => {
    /*
      The refusals are returned, not filtered out. "No sources available" on a
      page of visibly similar tables reads as a broken feature, where
      "different number of rows — 22 and 24" tells the reviewer something true
      about their document, and is usually what they wanted to know.
    */
    const target = checklist('p6');
    const fields = [
      checklist('p2'),
      checklist('p4', { fixedRows: ['only one'] }),
      checklist('p8'), // compatible, but nothing placed on it
      target,
    ];

    const candidates = cloneCandidates(target, fields, (id) => id === 'p2' || id === 'p4');

    expect(candidates.map((c) => c.field.id)).toEqual(['p2', 'p4']);
    expect(candidates.find((c) => c.field.id === 'p2')?.refusal).toBeNull();
    expect(candidates.find((c) => c.field.id === 'p4')?.refusal).toContain('has 1 row, this one has 22');
  });

  it('never offers the target itself', () => {
    const target = checklist('p6');
    expect(cloneCandidates(target, [target], () => true)).toEqual([]);
  });
});
