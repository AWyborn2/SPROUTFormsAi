/**
 * Pairing questions with their outcome boxes by printed reference.
 *
 * What these pin is the failure the previous approach had. Pairing every
 * question with the next `check_cross` in document order works right up until
 * one box is missing, at which point every question after it silently pairs with
 * the following question's cell — and the mapping still looks complete. A
 * reference has to match, so a gap stays a gap and is reported as one.
 *
 * The Track Dozer restarts its numbering in each section, so the same reference
 * legitimately appears more than once. Resolution therefore has to be LOCAL.
 */
import { describe, expect, it } from 'vitest';
import { applyOutcomeLinks, linkOutcomeTargets, type LinkableField } from './outcome-links.js';
import type { FormField } from './form-field.js';

const question = (id: string, ref?: string): LinkableField => ({
  id,
  type: 'radio',
  options: ['True', 'False'],
  ...(ref ? { questionRef: ref } : {}),
});

const outcome = (id: string, ref?: string): LinkableField => ({
  id,
  type: 'check_cross',
  ...(ref ? { questionRef: ref } : {}),
});

const header = (id: string): LinkableField => ({ id, type: 'section_header' });

describe('linkOutcomeTargets', () => {
  it('pairs each question with the outcome box carrying its reference', () => {
    const { links } = linkOutcomeTargets([
      question('ai_29', 'Q1'),
      outcome('ai_30', 'Q1'),
      question('ai_31', 'Q2'),
      outcome('ai_32', 'Q2'),
    ]);

    expect(links).toEqual([
      { questionId: 'ai_29', outcomeId: 'ai_30', ref: 'Q1' },
      { questionId: 'ai_31', outcomeId: 'ai_32', ref: 'Q2' },
    ]);
  });

  it('reports a question whose box is missing, and does not shift the rest', () => {
    // The old adjacency rule paired Q1 with Q2's cell here, then Q2 with Q3's,
    // and reported a complete mapping. Every verdict after the gap landed on the
    // wrong question.
    const { links, unlinkedQuestions } = linkOutcomeTargets([
      question('ai_29', 'Q1'),
      question('ai_31', 'Q2'),
      outcome('ai_32', 'Q2'),
      question('ai_33', 'Q3'),
      outcome('ai_34', 'Q3'),
    ]);

    expect(unlinkedQuestions).toEqual(['ai_29']);
    expect(links.map((l) => l.questionId)).toEqual(['ai_31', 'ai_33']);
    expect(links.find((l) => l.outcomeId === 'ai_32')?.questionId).toBe('ai_31');
  });

  it('keeps repeated references in their own sections', () => {
    // "7." appears in the General set and again under Raw Materials. Matching
    // across the whole document would pair the second question with the first
    // section's cell.
    const { links } = linkOutcomeTargets([
      header('ai_28'),
      question('ai_62', '7'),
      outcome('ai_63', '7'),
      header('ai_74'),
      question('ai_88', '7'),
      outcome('ai_89', '7'),
    ]);

    expect(links).toEqual([
      { questionId: 'ai_62', outcomeId: 'ai_63', ref: '7' },
      { questionId: 'ai_88', outcomeId: 'ai_89', ref: '7' },
    ]);
  });

  it('never lets one outcome box serve two questions', () => {
    const { links, unlinkedQuestions } = linkOutcomeTargets([
      question('ai_1', '7'),
      question('ai_2', '7'),
      outcome('ai_3', '7'),
    ]);

    expect(links).toHaveLength(1);
    expect(unlinkedQuestions).toHaveLength(1);
  });

  it('does not reach past the next question for a box', () => {
    // ai_29's own box is absent; ai_34 belongs to ai_33 and must stay its.
    const { links } = linkOutcomeTargets([
      question('ai_29', 'Q1'),
      question('ai_33', 'Q1'),
      outcome('ai_34', 'Q1'),
    ]);

    expect(links).toEqual([{ questionId: 'ai_33', outcomeId: 'ai_34', ref: 'Q1' }]);
  });

  it('ignores printed noise in a reference but not the reference itself', () => {
    const { links } = linkOutcomeTargets([question('ai_1', 'BBM Q3'), outcome('ai_2', 'bbm-q3')]);

    expect(links).toHaveLength(1);
  });

  it('refuses to pair references that merely look similar', () => {
    const { links, unlinkedQuestions, orphanOutcomes } = linkOutcomeTargets([
      question('ai_1', 'Q3'),
      outcome('ai_2', 'Q30'),
    ]);

    expect(links).toEqual([]);
    expect(unlinkedQuestions).toEqual(['ai_1']);
    expect(orphanOutcomes).toEqual(['ai_2']);
  });

  it('reports an outcome box that belongs to no question', () => {
    const { orphanOutcomes } = linkOutcomeTargets([
      question('ai_1', 'Q1'),
      outcome('ai_2', 'Q1'),
      outcome('ai_3', 'Q9'),
    ]);

    expect(orphanOutcomes).toEqual(['ai_3']);
  });

  it('links nothing when the model supplied no references', () => {
    // The safe degradation: no reference, no guess. Placement still works and a
    // reviewer can repoint by hand.
    const { links, unlinkedQuestions } = linkOutcomeTargets([question('ai_1'), outcome('ai_2')]);

    expect(links).toEqual([]);
    expect(unlinkedQuestions).toEqual([]);
  });

  it('ignores a choice field with no options — it is not a question', () => {
    const { links } = linkOutcomeTargets([
      { id: 'ai_1', type: 'radio', questionRef: 'Q1' },
      outcome('ai_2', 'Q1'),
    ]);

    expect(links).toEqual([]);
  });
});

describe('applyOutcomeLinks', () => {
  const q: FormField = {
    id: 'ai_29',
    type: 'radio',
    label: 'Q1',
    required: false,
    source: 'imported',
    options: ['True', 'False'],
  };

  it('writes outcomeTarget onto the question', () => {
    const [linked] = applyOutcomeLinks([q], [
      { questionId: 'ai_29', outcomeId: 'ai_30', ref: 'Q1' },
    ]);

    expect(linked!.outcomeTarget).toEqual({ fieldId: 'ai_30' });
  });

  it('leaves an existing target alone', () => {
    // A reviewer who repointed a cell made a decision; re-running the resolver
    // must not quietly undo it.
    const [linked] = applyOutcomeLinks(
      [{ ...q, outcomeTarget: { fieldId: 'chosen-by-hand' } }],
      [{ questionId: 'ai_29', outcomeId: 'ai_30', ref: 'Q1' }],
    );

    expect(linked!.outcomeTarget).toEqual({ fieldId: 'chosen-by-hand' });
  });

  it('returns the same array when there is nothing to link', () => {
    const fields = [q];

    expect(applyOutcomeLinks(fields, [])).toBe(fields);
  });

  it('leaves fields with no link untouched', () => {
    const other: FormField = { ...q, id: 'ai_99' };
    const out = applyOutcomeLinks([q, other], [
      { questionId: 'ai_29', outcomeId: 'ai_30', ref: 'Q1' },
    ]);

    expect(out[1]!.outcomeTarget).toBeUndefined();
  });
});
