/**
 * Grouping a reviewed field list into question + outcome-cell units.
 *
 * Two things are pinned here, and neither is the pairing rule — that belongs to
 * `linkOutcomeTargets` and is pinned in its own suite.
 *
 * First, that a linked cell is in exactly ONE place: inside its question's unit
 * and gone from the top level. A cell left in both would put the reviewer back
 * where they started, reading one printed box as two rows.
 *
 * Second, that both gaps the resolver reports survive into the unit as a status.
 * That is the whole reason this layer exists: an unpaired question is a verdict
 * never drawn on the exported record, and it had no way to reach the screen.
 *
 * Fixtures are real `ReviewField`s, because the review list is the only caller
 * and a narrower stand-in would not prove the generic accepts it.
 */
import { describe, expect, it } from 'vitest';
import type { ReviewField } from './data/import-session.js';
import { outcomeUnits } from './outcome-units.js';

const question = (id: string, ref?: string): ReviewField => ({
  id,
  label: `Question ${id}`,
  type: 'radio',
  confidence: 1,
  options: ['True', 'False'],
  ...(ref ? { questionRef: ref } : {}),
});

const cell = (id: string, ref?: string): ReviewField => ({
  id,
  label: `${ref ?? id} Outcome`,
  type: 'check_cross',
  confidence: 1,
  ...(ref ? { questionRef: ref } : {}),
});

const heading = (id: string): ReviewField => ({
  id,
  label: 'Raw Materials',
  type: 'section_header',
  confidence: 1,
});

const note = (id: string): ReviewField => ({
  id,
  label: 'Assessor comments',
  type: 'text',
  confidence: 1,
});

describe('outcomeUnits', () => {
  it('carries a question’s outcome cell inside the question’s own unit', () => {
    const units = outcomeUnits([question('ai_29', 'Q1'), cell('ai_30', 'Q1')]);

    expect(units).toHaveLength(1);
    expect(units[0]!.field.id).toBe('ai_29');
    expect(units[0]!.outcome?.id).toBe('ai_30');
    expect(units[0]!.linkStatus).toBe('linked');
  });

  it('lists a linked outcome cell once, never also at the top level', () => {
    const units = outcomeUnits([question('ai_29', 'Q1'), cell('ai_30', 'Q1')]);

    expect(units.map((u) => u.field.id)).toEqual(['ai_29']);
  });

  it('pairs across the fields printed between a question and its cell', () => {
    // The cell is not adjacent on this paper — it sits in a summary block well
    // below the question, with unrelated fields in between.
    const units = outcomeUnits([question('ai_29', 'Q1'), note('ai_40'), cell('ai_61', 'Q1')]);

    expect(units.find((u) => u.field.id === 'ai_29')?.outcome?.id).toBe('ai_61');
    expect(units.map((u) => u.field.id)).toEqual(['ai_29', 'ai_40']);
  });

  it('flags a question whose outcome cell is missing', () => {
    const units = outcomeUnits([
      question('ai_29', 'Q1'),
      question('ai_31', 'Q2'),
      cell('ai_32', 'Q2'),
    ]);

    expect(units[0]!.linkStatus).toBe('question-has-no-outcome');
    expect(units[0]!.outcome).toBeUndefined();
  });

  it('flags an outcome cell whose reference matches no question', () => {
    const units = outcomeUnits([question('ai_1', 'Q1'), cell('ai_2', 'Q1'), cell('ai_3', 'Q9')]);

    const orphan = units.find((u) => u.field.id === 'ai_3');
    expect(orphan?.linkStatus).toBe('outcome-has-no-question');
  });

  it('leaves the unit after a missing cell paired with its own cell', () => {
    // The gap must stay local. Under the adjacency rule this replaces, ai_29
    // took ai_32 and every question after it shifted one cell along, so each
    // verdict landed on its neighbour and the list still read as complete.
    const units = outcomeUnits([
      question('ai_29', 'Q1'),
      question('ai_31', 'Q2'),
      cell('ai_32', 'Q2'),
      question('ai_33', 'Q3'),
      cell('ai_34', 'Q3'),
    ]);

    expect(units.map((u) => [u.field.id, u.outcome?.id])).toEqual([
      ['ai_29', undefined],
      ['ai_31', 'ai_32'],
      ['ai_33', 'ai_34'],
    ]);
  });

  it('keeps a reference repeated in a later section with its own section’s cell', () => {
    // Numbering restarts under each heading, so "7" is printed twice.
    const units = outcomeUnits([
      question('ai_62', '7'),
      cell('ai_63', '7'),
      heading('ai_74'),
      question('ai_88', '7'),
      cell('ai_89', '7'),
    ]);

    expect(units.map((u) => [u.field.id, u.outcome?.id])).toEqual([
      ['ai_62', 'ai_63'],
      ['ai_74', undefined],
      ['ai_88', 'ai_89'],
    ]);
  });

  it('says nothing about a field the pairing does not concern', () => {
    const units = outcomeUnits([heading('ai_1'), note('ai_2')]);

    expect(units.map((u) => u.linkStatus)).toEqual([undefined, undefined]);
  });

  it('says nothing about a question carrying no printed reference', () => {
    // No reference is not a gap the resolver can name — flagging it would mark
    // every unreferenced field on the page, and a warning on everything is a
    // warning on nothing.
    const units = outcomeUnits([question('ai_1'), cell('ai_2')]);

    expect(units.map((u) => u.linkStatus)).toEqual([undefined, undefined]);
  });

  it('preserves the reviewed order', () => {
    // The reviewer reorders this list; units follow it rather than the order
    // extraction happened to emit.
    const units = outcomeUnits([
      question('ai_31', 'Q2'),
      cell('ai_32', 'Q2'),
      heading('ai_50'),
      question('ai_29', 'Q1'),
      cell('ai_30', 'Q1'),
    ]);

    expect(units.map((u) => u.field.id)).toEqual(['ai_31', 'ai_50', 'ai_29']);
  });

  it('returns one unit per field when there is nothing to pair', () => {
    const fields = [heading('ai_1'), note('ai_2'), note('ai_3')];

    expect(outcomeUnits(fields).map((u) => u.field)).toEqual(fields);
  });

  it('returns nothing for an empty list', () => {
    expect(outcomeUnits([])).toEqual([]);
  });
});
