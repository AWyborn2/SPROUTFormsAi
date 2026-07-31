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
import {
  applyOutcomeLinks,
  linkOutcomeTargets,
  pairQuestionsWithOutcomes,
  type LinkableField,
} from './outcome-links.js';
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

/**
 * Pairing at AUTHORING time, against an already-published version.
 *
 * This is what the answer-key seeding script consumes. It matters more than it
 * looks: the key identifies its answers by section and number, nothing on a
 * published field carries that number, so the script aligns key entries against
 * these pairs BY ORDER. A pair in the wrong place writes question 8's answers
 * onto question 7 — marking a candidate wrong on one they answered correctly
 * and right on one they did not, on a safety record.
 */
describe('pairQuestionsWithOutcomes', () => {
  const question = (id: string, over: Partial<FormField> = {}): FormField => ({
    id,
    type: 'radio',
    label: id,
    required: false,
    source: 'imported',
    options: ['a', 'b'],
    ...over,
  });
  const box = (id: string): FormField => ({
    id,
    type: 'check_cross',
    label: id,
    required: false,
    source: 'imported',
  });

  it('uses the link publish already resolved', () => {
    const fields = [question('q1', { outcomeTarget: { fieldId: 'o1' } }), box('o1')];

    const { pairs, fromLink, fromAdjacency } = pairQuestionsWithOutcomes(fields);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.outcome.id).toBe('o1');
    expect(pairs[0]!.how).toBe('link');
    expect([fromLink, fromAdjacency]).toEqual([1, 0]);
  });

  it('follows the link even when it is NOT the adjacent box', () => {
    /*
      The whole point. The script used to take the next check_cross in document
      order; where the printed references say otherwise, they win — they are
      read off the page, adjacency is inferred from layout.
    */
    const fields = [
      question('q1', { outcomeTarget: { fieldId: 'o2' } }),
      box('o1'),
      box('o2'),
    ];

    const { pairs } = pairQuestionsWithOutcomes(fields);

    expect(pairs[0]!.outcome.id).toBe('o2');
    expect(pairs[0]!.how).toBe('link');
  });

  it('falls back to the adjacent box when nothing was linked', () => {
    // A document whose references the model could not read still has to be
    // authorable — but the caller is told the pairing was inferred.
    const fields = [question('q1'), box('o1')];

    const { pairs, fromAdjacency } = pairQuestionsWithOutcomes(fields);

    expect(pairs[0]!.outcome.id).toBe('o1');
    expect(pairs[0]!.how).toBe('adjacency');
    expect(fromAdjacency).toBe(1);
  });

  it('ignores a link pointing at something that is not an outcome box', () => {
    // A stale or hand-edited target must not silently become the verdict cell.
    const fields = [
      question('q1', { outcomeTarget: { fieldId: 'q2' } }),
      question('q2'),
      box('o1'),
    ];

    const { pairs } = pairQuestionsWithOutcomes(fields);

    expect(pairs[0]!.how).toBe('adjacency');
    expect(pairs[0]!.outcome.id).toBe('o1');
  });

  it('reports a question with no box rather than skipping it silently', () => {
    /*
      This is what turns "31 expected, 30 found" into something actionable. The
      script refuses on a count mismatch — correctly, because it cannot localise
      the shift — so naming the gap is the only way an operator can fix it.
    */
    const fields = [question('q1'), question('q2'), box('o2')];

    const { pairs, unpaired } = pairQuestionsWithOutcomes(fields);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.question.id).toBe('q2');
    expect(unpaired.map((f) => f.id)).toEqual(['q1']);
  });

  it('preserves document order, which the key is aligned against', () => {
    const fields = [
      question('q1', { outcomeTarget: { fieldId: 'o1' } }),
      box('o1'),
      question('q2'),
      box('o2'),
      question('q3', { outcomeTarget: { fieldId: 'o3' } }),
      box('o3'),
    ];

    const { pairs, fromLink, fromAdjacency } = pairQuestionsWithOutcomes(fields);

    expect(pairs.map((p) => p.question.id)).toEqual(['q1', 'q2', 'q3']);
    expect(pairs.map((p) => p.how)).toEqual(['link', 'adjacency', 'link']);
    expect([fromLink, fromAdjacency]).toEqual([2, 1]);
  });

  it('does not treat an option-less choice field as a question', () => {
    // Same rule the resolver above uses: with no options there is nothing to
    // mark, so it is not a question and must not consume a box.
    const fields = [question('q1', { options: [] }), box('o1')];

    expect(pairQuestionsWithOutcomes(fields).pairs).toHaveLength(0);
  });

  it('never pairs one box with two questions', () => {
    const fields = [question('q1'), box('o1'), question('q2')];

    const { pairs, unpaired } = pairQuestionsWithOutcomes(fields);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.question.id).toBe('q1');
    expect(unpaired.map((f) => f.id)).toEqual(['q2']);
  });
});
