/**
 * The placement list's grouping, filtering and pairing.
 *
 * Two properties carry this file, and both are ways the list can quietly lie:
 *
 *   · the per-group counts describe the GROUP, never what the filter left — a
 *     filtered list reading "2 of 2 placed" while thirty unplaced fields sit
 *     behind the filter reads as finished;
 *   · a question and its outcome box are ONE unit of work, and a pair whose
 *     outcome does not resolve says so rather than offering a chip that places
 *     nothing.
 */
import { describe, expect, it } from 'vitest';
import type { FormField, PageBox } from '@formai/shared';
import {
  groupFields,
  matchesFilter,
  outcomeFieldIds,
  overallCounts,
  pairsFor,
} from './placement-list.js';

const BOX: PageBox = { page: 0, x: 1, y: 1, width: 10, height: 10, pageWidth: 595, pageHeight: 842 };

function field(over: Partial<FormField> & { id: string }): FormField {
  return { label: over.id, type: 'text', required: false, source: 'imported', ...over };
}

function placed(over: Partial<FormField> & { id: string }): FormField {
  return field({ ...over, geometry: { segments: [BOX] } });
}

/** One box per field, which is what a scalar needs. */
const one = () => 1;

describe('pairsFor', () => {
  it('pairs a question with the outcome box it names', () => {
    const q = field({ id: 'q1', outcomeTarget: { fieldId: 'o1' } });
    const o = field({ id: 'o1', type: 'check_cross' });

    const pairs = pairsFor([q, o]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.question.id).toBe('q1');
    expect(pairs[0]!.outcome?.id).toBe('o1');
  });

  it('reports each half’s placement separately', () => {
    /*
      THE FAILURE THIS EXISTS FOR. Shown as two unrelated rows in a list of
      three hundred, one of the pair is how the other ends up unplaced — and
      the export then draws the candidate's answer with no verdict beside it,
      on the document that says whether somebody may operate the machine.
    */
    const pairs = pairsFor([
      placed({ id: 'q1', outcomeTarget: { fieldId: 'o1' } }),
      field({ id: 'o1', type: 'check_cross' }),
    ]);

    expect(pairs[0]!.responsePlaced).toBe(true);
    expect(pairs[0]!.outcomePlaced).toBe(false);
  });

  it('says an outcome target did not resolve, rather than pairing with nothing', () => {
    // A manifest authored against a different version, or a reference that
    // never resolved. Offering a chip here would place nothing, silently.
    const pairs = pairsFor([field({ id: 'q1', outcomeTarget: { fieldId: 'gone' } })]);

    expect(pairs[0]!.outcome).toBeNull();
    expect(pairs[0]!.unresolvedOutcomeId).toBe('gone');
    expect(pairs[0]!.outcomePlaced).toBe(false);
  });

  it('does not pair a question that declares no outcome target', () => {
    // Plenty of fields are placed on their own; only a declared link creates
    // the two-location unit of work.
    expect(pairsFor([field({ id: 'name' })])).toEqual([]);
  });
});

describe('outcomeFieldIds', () => {
  it('collects every field that some question points at', () => {
    const ids = outcomeFieldIds([
      field({ id: 'q1', outcomeTarget: { fieldId: 'o1' } }),
      field({ id: 'q2', outcomeTarget: { fieldId: 'o2' } }),
      field({ id: 'o1' }),
    ]);
    expect([...ids].sort()).toEqual(['o1', 'o2']);
  });
});

describe('matchesFilter', () => {
  const q = field({
    id: 'fx_q_7',
    label: 'Question 7',
    description: 'Before entering the footprint you must isolate the machine',
  });

  it('matches the label', () => {
    expect(matchesFilter(q, 'question 7')).toBe(true);
  });

  it('matches the QUESTION TEXT, not only the label', () => {
    // On this document class the question text is routinely the longer of the
    // two, and an author searching remembers the question, not its label.
    expect(matchesFilter(q, 'isolate')).toBe(true);
  });

  it('matches the field id, so a validator message can be pasted in', () => {
    expect(matchesFilter(q, 'fx_q_7')).toBe(true);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(matchesFilter(q, '  ISOLATE  ')).toBe(true);
  });

  it('matches everything on an empty filter, rather than nothing', () => {
    expect(matchesFilter(q, '')).toBe(true);
    expect(matchesFilter(q, '   ')).toBe(true);
  });

  it('does not match text that is in neither', () => {
    expect(matchesFilter(q, 'hydraulics')).toBe(false);
  });
});

describe('groupFields', () => {
  const FIELDS = [
    field({ id: 'h1', type: 'section_header', label: 'PART 1 — THEORY' }),
    placed({ id: 'q1', label: 'Question 1' }),
    field({ id: 'q2', label: 'Question 2' }),
    field({ id: 'h2', type: 'section_header', label: 'PART 2 — PRACTICAL' }),
    placed({ id: 'c1', label: 'Criterion 1' }),
  ];

  it('groups fields under the heading that precedes them, in document order', () => {
    // Document order is the order the boxes are printed and therefore the order
    // an author works through the page.
    const groups = groupFields(FIELDS, one);

    expect(groups.map((g) => g.label)).toEqual(['PART 1 — THEORY', 'PART 2 — PRACTICAL']);
    expect(groups[0]!.fields.map((f) => f.id)).toEqual(['q1', 'q2']);
    expect(groups[1]!.fields.map((f) => f.id)).toEqual(['c1']);
  });

  it('counts placed against total per group', () => {
    const groups = groupFields(FIELDS, one);
    expect([groups[0]!.placed, groups[0]!.total]).toEqual([1, 2]);
    expect([groups[1]!.placed, groups[1]!.total]).toEqual([1, 1]);
  });

  it('KEEPS THE COUNTS OF THE WHOLE GROUP WHEN A FILTER IS ON', () => {
    /*
      A filtered list showing "1 of 1 placed" while an unplaced field sits
      behind the filter reads as finished. The filter decides what is SHOWN;
      the counts always describe the group.
    */
    const groups = groupFields(FIELDS, one, 'Question 1');

    expect(groups[0]!.fields.map((f) => f.id)).toEqual(['q1']);
    expect([groups[0]!.placed, groups[0]!.total]).toEqual([1, 2]);
  });

  it('drops a group the filter emptied', () => {
    // So the list is the answer to the search rather than a page of empty
    // headings to scroll past.
    const groups = groupFields(FIELDS, one, 'Criterion');
    expect(groups.map((g) => g.label)).toEqual(['PART 2 — PRACTICAL']);
  });

  it('keeps fields printed before any heading', () => {
    // A cover page routinely has no heading above it, and losing those fields
    // from the list would lose them from the placement session entirely.
    const groups = groupFields([field({ id: 'name' }), ...FIELDS], one);
    expect(groups[0]!.fields.map((f) => f.id)).toEqual(['name']);
    expect(groups[0]!.label).toBe('Before the first heading');
  });

  it('counts a per-option field placed only when every option has a box', () => {
    // A choice field needs one box per option; counting it done on the first
    // would report a question as placed with three of its four boxes missing.
    const perOption = field({
      id: 'radio',
      type: 'radio',
      options: ['a', 'b'],
      geometry: { segments: [{ ...BOX, optionKey: 'a' }] },
    });
    const expected = (f: FormField) => (f.options?.length ?? 1);

    const groups = groupFields([field({ id: 'h', type: 'section_header' }), perOption], expected);
    expect([groups[0]!.placed, groups[0]!.total]).toEqual([0, 1]);
  });

  it('never counts a heading as a placeable field', () => {
    const groups = groupFields(FIELDS, one);
    expect(groups.reduce((n, g) => n + g.total, 0)).toBe(3);
  });
});

describe('overallCounts', () => {
  it('counts placeable fields only, across the whole document', () => {
    const counts = overallCounts(
      [
        field({ id: 'h', type: 'section_header' }),
        placed({ id: 'a' }),
        field({ id: 'b' }),
      ],
      one,
    );
    expect(counts).toEqual({ placed: 1, total: 2 });
  });
});
