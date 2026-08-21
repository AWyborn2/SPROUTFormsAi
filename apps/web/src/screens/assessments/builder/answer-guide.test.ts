/**
 * Seeding an answer key from a guide.
 *
 * The load-bearing test in this file is the COUNT GATE. A guide identifies its
 * answers by section and number, no published field carries that number, so
 * matching can only align by order — and a count mismatch means every entry
 * after the first discrepancy lands on the wrong question. That is the failure
 * `author-track-dozer-tool.mjs` refuses to write on, and it has to be refused
 * here too, per section and out loud.
 */
import { describe, expect, it } from 'vitest';
import { pairingOption } from '@formai/shared';
import type { FormField, StructureSection } from '@formai/shared';
import {
  matchGuideToQuestions,
  parseAnswerGuide,
  resolveAnswer,
  sectionsMatch,
} from './answer-guide.js';

function question(id: string, options = ['a', 'b', 'c']): FormField {
  return { id, label: id, type: 'radio', required: false, source: 'imported', options };
}

function section(label: string, ids: string[]): StructureSection {
  return { key: label, label, cols: 1, fields: ids.map((id) => ({ id })) };
}

describe('parseAnswerGuide', () => {
  it('reads the repo’s own sectioned shape', () => {
    const parsed = parseAnswerGuide({
      sections: {
        general: { mandatory: true, questions: [{ n: 1, answers: ['a'] }, { n: 2, answers: ['b', 'c'] }] },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual([
      { section: 'general', n: 1, answers: ['a'] },
      { section: 'general', n: 2, answers: ['b', 'c'] },
    ]);
  });

  it('reads the flat "Section:n" shape', () => {
    const parsed = parseAnswerGuide({ answers: { 'General:4': ['b', 'c'], 'BBM Mining:1': ['a'] } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toContainEqual({ section: 'General', n: 4, answers: ['b', 'c'] });
    expect(parsed.entries).toContainEqual({ section: 'BBM Mining', n: 1, answers: ['a'] });
  });

  it('splits a flat key on the LAST colon, so a section name may contain one', () => {
    const parsed = parseAnswerGuide({ answers: { 'Part 2: Practical:3': ['a'] } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries[0]).toEqual({ section: 'Part 2: Practical', n: 3, answers: ['a'] });
  });

  it('names both accepted shapes when the file is neither', () => {
    // "That didn't work" on a file somebody exported from another system is a
    // dead end; naming the two shapes is what makes it fixable.
    const parsed = parseAnswerGuide({ questions: [] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('"sections"');
    expect(parsed.error).toContain('"answers"');
  });

  it('refuses a guide whose sections carry no questions', () => {
    const parsed = parseAnswerGuide({ sections: { general: { questions: [] } } });
    expect(parsed.ok).toBe(false);
  });

  it('refuses a non-object', () => {
    expect(parseAnswerGuide('a string').ok).toBe(false);
    expect(parseAnswerGuide(null).ok).toBe(false);
  });
});

describe('sectionsMatch', () => {
  it('matches a guide’s short name against the paper’s printed heading', () => {
    // The real pairing: the guide says "general", the paper prints "Written or
    // Verbal Questions (General)". Equality would match neither, and every real
    // guide would report as entirely unmatched.
    expect(sectionsMatch('general', 'Written or Verbal Questions (General)')).toBe(true);
    expect(sectionsMatch('bbmMining', 'BBM Mining Only')).toBe(true);
    expect(sectionsMatch('rawMaterials', 'Raw Materials')).toBe(true);
  });

  it('does not match unrelated sections', () => {
    expect(sectionsMatch('general', 'BBM Mining Only')).toBe(false);
  });

  it('does not match on empty text', () => {
    expect(sectionsMatch('', 'General')).toBe(false);
    expect(sectionsMatch('general', '')).toBe(false);
  });
});

describe('resolveAnswer', () => {
  it('resolves a printed letter positionally', () => {
    expect(resolveAnswer('b', ['Red', 'Green', 'Blue'])).toBe('Green');
  });

  it('resolves an answer given as text', () => {
    expect(resolveAnswer('Green', ['Red', 'Green', 'Blue'])).toBe('Green');
  });

  it('resolves text that differs only in punctuation or case', () => {
    expect(resolveAnswer('sound the horn', ['Sound the horn.', 'Wait'])).toBe('Sound the horn.');
  });

  it('returns null rather than guessing when a letter is past the options', () => {
    // A wrong option here is a question every candidate fails.
    expect(resolveAnswer('e', ['Red', 'Green'])).toBeNull();
  });

  it('returns null on text that matches nothing', () => {
    expect(resolveAnswer('Purple', ['Red', 'Green'])).toBeNull();
  });
});

describe('matchGuideToQuestions', () => {
  const FIELDS = [question('q1'), question('q2'), question('q3')];
  const SECTIONS = [section('Written or Verbal Questions (General)', ['q1', 'q2', 'q3'])];
  const NONE = new Set<string>();

  it('seeds a section whose count matches, as unverified', () => {
    const match = matchGuideToQuestions(
      [
        { section: 'general', n: 1, answers: ['a'] },
        { section: 'general', n: 2, answers: ['b'] },
        { section: 'general', n: 3, answers: ['c'] },
      ],
      SECTIONS,
      FIELDS,
      NONE,
    );

    expect(match.problems).toEqual([]);
    expect(match.keys).toHaveLength(3);
    expect(match.keys[0]).toEqual({ fieldId: 'q1', answerKey: ['a'], source: 'guide_json' });
    // Seeded is not attested, however confident the guide was.
    expect(match.keys.every((k) => k.verifiedAt === undefined)).toBe(true);
    expect(match.seeded).toEqual([{ section: 'Written or Verbal Questions (General)', count: 3 }]);
  });

  it('SEEDS NOTHING for a section whose count does not match, and says what it saw', () => {
    /*
      THE FAILURE THIS EXISTS FOR. Aligning 2 guide answers against 3 questions
      by order writes question 3's answer onto question 2 — marking a candidate
      wrong on a question they answered correctly, on a safety record. Writing
      nothing is the only safe response to a misalignment that cannot be
      localised.
    */
    const match = matchGuideToQuestions(
      [
        { section: 'general', n: 1, answers: ['a'] },
        { section: 'general', n: 2, answers: ['b'] },
      ],
      SECTIONS,
      FIELDS,
      NONE,
    );

    expect(match.keys).toEqual([]);
    expect(match.problems).toHaveLength(1);
    expect(match.problems[0]!.reason).toContain('2 answers');
    expect(match.problems[0]!.reason).toContain('3 questions');
  });

  it('A DUPLICATED QUESTION NUMBER refuses the section, naming the number', () => {
    /*
      Entries 1, 2, 2 count-match a three-question section while double-seeding
      question 2 (the later entry silently winning) and never seeding question
      3 — the same misalignment the count gate refuses, folded so the counts
      agree. Same response: name it, seed nothing.
    */
    const match = matchGuideToQuestions(
      [
        { section: 'general', n: 1, answers: ['a'] },
        { section: 'general', n: 2, answers: ['b'] },
        { section: 'general', n: 2, answers: ['c'] },
      ],
      SECTIONS,
      FIELDS,
      NONE,
    );

    expect(match.keys).toEqual([]);
    expect(match.seeded).toEqual([]);
    expect(match.problems).toHaveLength(1);
    expect(match.problems[0]!.reason).toContain('question 2 more than once');
  });

  it('a mismatch in one section does not block a section that is correct', () => {
    // Per section rather than per document: an optional stream the author has
    // not finished typing should not hold up the two that are right.
    const sections = [
      section('General', ['q1', 'q2', 'q3']),
      section('BBM Mining Only', ['q4']),
    ];
    const fields = [...FIELDS, question('q4')];
    const match = matchGuideToQuestions(
      [
        { section: 'General', n: 1, answers: ['a'] },
        { section: 'General', n: 2, answers: ['b'] },
        { section: 'General', n: 3, answers: ['c'] },
        { section: 'bbmMining', n: 1, answers: ['a'] },
        { section: 'bbmMining', n: 2, answers: ['b'] },
      ],
      sections,
      fields,
      NONE,
    );

    expect(match.keys).toHaveLength(3);
    expect(match.keys.every((k) => k.fieldId !== 'q4')).toBe(true);
    expect(match.problems).toHaveLength(1);
    expect(match.problems[0]!.section).toBe('bbmMining');
  });

  it('reports a section the document does not have, rather than dropping it', () => {
    const match = matchGuideToQuestions(
      [{ section: 'Underground', n: 1, answers: ['a'] }],
      SECTIONS,
      FIELDS,
      NONE,
    );

    expect(match.keys).toEqual([]);
    expect(match.problems[0]!.reason).toContain('No section in this document matches');
  });

  it('reports an answer that names an option the question does not offer', () => {
    const match = matchGuideToQuestions(
      [
        { section: 'general', n: 1, answers: ['a'] },
        { section: 'general', n: 2, answers: ['b'] },
        { section: 'general', n: 3, answers: ['z'] },
      ],
      SECTIONS,
      FIELDS,
      NONE,
    );

    expect(match.keys).toHaveLength(2);
    expect(match.problems[0]!.reason).toContain('"z"');
    expect(match.problems[0]!.reason).toContain('not one of its 3 options');
  });

  it('counts only questions, so a heading cannot consume a guide position', () => {
    // A section's headings and text boxes are not numbered by a guide. Letting
    // one take a position shifts every answer after it.
    const fields = [
      question('q1'),
      { id: 'h', label: 'Note', type: 'section_header' as const, required: false, source: 'imported' as const },
      question('q2'),
    ];
    const match = matchGuideToQuestions(
      [
        { section: 'General', n: 1, answers: ['a'] },
        { section: 'General', n: 2, answers: ['b'] },
      ],
      [section('General', ['q1', 'h', 'q2'])],
      fields,
      NONE,
    );

    expect(match.problems).toEqual([]);
    expect(match.keys.map((k) => k.fieldId)).toEqual(['q1', 'q2']);
  });

  it('excludes questions the author turned off, on both sides of the count', () => {
    const match = matchGuideToQuestions(
      [
        { section: 'General', n: 1, answers: ['a'] },
        { section: 'General', n: 2, answers: ['b'] },
      ],
      [section('General', ['q1', 'q2', 'q3'])],
      FIELDS,
      new Set(['q3']),
    );

    expect(match.problems).toEqual([]);
    expect(match.keys.map((k) => k.fieldId)).toEqual(['q1', 'q2']);
  });

  it('carries a multi-answer entry through as an exact set', () => {
    const match = matchGuideToQuestions(
      [{ section: 'General', n: 1, answers: ['b', 'c'] }],
      [section('General', ['q1'])],
      FIELDS,
      NONE,
    );

    expect(match.keys[0]!.answerKey).toEqual(['b', 'c']);
  });
});

/**
 * The ENTRY-LIST shape — `answers` as an array of objects.
 *
 * This is what a real guide looks like: a model asked to derive an answer key
 * from a source manual emits one entry per question carrying its number, its
 * printed text, the correct option letters and a reference. It is the richest
 * of the three shapes, and it was the one shape the parser refused — an array
 * fell into the keyed-object branch (`typeof [] === 'object'`), produced index
 * keys with no ":" in them, skipped all of them, and reported "no usable
 * entries" on a perfectly good file.
 */
describe('parseAnswerGuide — the entry-list shape', () => {
  const REAL = {
    assessment_title: 'Mine Site SME Theory',
    version: '10.0',
    answers: [
      {
        question: 1,
        text: 'Select the Principal Mining Hazards relevant to the active mine area at BBM (more than one answer)',
        correct_answers: ['a', 'b', 'c'],
        correct_answer_text: ['Vehicle Accident', 'Ground Movement', 'Falling from Height'],
        reference: 'Section 4',
      },
      {
        question: 2,
        text: 'During blasting activities radio silence is required on what channel?',
        correct_answers: ['c'],
        correct_answer_text: 'Blast',
      },
    ],
  };

  it('READS IT AT ALL, which it used to refuse', () => {
    const parsed = parseAnswerGuide(REAL);
    expect(parsed.ok).toBe(true);
  });

  it('keeps the question text, which is how it finds its question', () => {
    const parsed = parseAnswerGuide(REAL);
    expect(parsed.ok && parsed.entries[0]?.text).toContain('Principal Mining Hazards');
  });

  it('carries no section, because the guide has none', () => {
    const parsed = parseAnswerGuide(REAL);
    expect(parsed.ok && parsed.entries[0]?.section).toBe('');
  });

  it('prefers the letters over the printed text', () => {
    // A guide giving both can disagree with itself, and the letters are what
    // the printed paper is numbered by.
    const parsed = parseAnswerGuide(REAL);
    expect(parsed.ok && parsed.entries[0]?.answers).toEqual(['a', 'b', 'c']);
  });

  it('falls back to the printed text when there are no letters', () => {
    const parsed = parseAnswerGuide({
      answers: [{ question: 1, text: 'Q', correct_answer_text: ['True'] }],
    });
    expect(parsed.ok && parsed.entries[0]?.answers).toEqual(['True']);
  });

  it('turns a MATCHING question’s object into pairing options', () => {
    /*
      Q7 and Q9 of the real paper give `correct_answers` as prompt → answer.
      Built into the same `left → right` strings `buildMatchingQuestion`
      produces, so they resolve against the question's own built options.
    */
    const parsed = parseAnswerGuide({
      answers: [
        {
          question: 7,
          text: 'Match the statement with the appropriate signage',
          correct_answers: { 'Red cone': 'Contact the person on the sign.' },
        },
      ],
    });
    expect(parsed.ok && parsed.entries[0]?.answers[0]).toBe(
      pairingOption('Red cone', 'Contact the person on the sign.'),
    );
  });

  it('skips an entry with no answers rather than keying an empty one', () => {
    const parsed = parseAnswerGuide({
      answers: [{ question: 1, text: 'Q' }, { question: 2, text: 'R', correct_answers: ['a'] }],
    });
    expect(parsed.ok && parsed.entries).toHaveLength(1);
  });

  it('names the shape it wanted when the list yields nothing', () => {
    const parsed = parseAnswerGuide({ answers: [{ nope: true }] });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/correct_answers/);
  });
});

/**
 * WRITTEN questions in a guide — the two-pass count gate and match-time kinds.
 *
 * THE CASE THIS ROUND EXISTS FOR: the Tip Head Controller key is one section
 * of 15 entries — 4 choice questions answered with letters, 11 written
 * questions answered with prose. The old choice-only gate read that as "15
 * answers, 4 questions" and silently seeded nothing. Pass 1 aligns against
 * the FULL numbered list, so the file seeds 4 keys and 11 model answers; a
 * shorter all-choice guide still seeds through the old gate verbatim.
 */
describe('matchGuideToQuestions — written questions and the two-pass gate', () => {
  const WRITTEN_AT = new Set([1, 2, 3, 4, 5, 6, 9, 10, 13, 14, 15]);

  function writtenQ(id: string, label: string): FormField {
    return { id, label, type: 'textarea', required: false, source: 'imported' };
  }

  /** 15 questions in one printed section, choice at positions 7, 8, 11, 12. */
  function tipHeadDocument(): { sections: StructureSection[]; fields: FormField[] } {
    const fields: FormField[] = [];
    for (let n = 1; n <= 15; n++) {
      if (n === 11) {
        fields.push({
          id: `q${n}`,
          label: `Question ${n}`,
          type: 'checkbox_group',
          required: false,
          source: 'imported',
          selectionType: 'multiple',
          options: ['option a', 'option b', 'option c', 'option d'],
        });
      } else if (n === 12) {
        fields.push(question(`q${n}`, ['True', 'False']));
      } else if (n === 7 || n === 8) {
        fields.push(question(`q${n}`, ['option a', 'option b', 'option c', 'option d']));
      } else {
        fields.push(writtenQ(`q${n}`, `Question ${n}`));
      }
    }
    return {
      sections: [section('Theory Questions', fields.map((f) => f.id))],
      fields,
    };
  }

  /** The reference guide: letters on the choice slots, prose on the rest. */
  function tipHeadGuide(): { section: string; n: number; answers: string[] }[] {
    return Array.from({ length: 15 }, (_, i) => {
      const n = i + 1;
      if (n === 7) return { section: 'theory', n, answers: ['b'] };
      if (n === 8) return { section: 'theory', n, answers: ['a'] };
      if (n === 11) return { section: 'theory', n, answers: ['a', 'b', 'c', 'd'] };
      if (n === 12) return { section: 'theory', n, answers: ['True'] };
      return { section: 'theory', n, answers: [`The expected prose for question ${n}.`] };
    });
  }

  it('THE REFERENCE CASE: 15 mixed entries seed 4 keys and 11 model answers', () => {
    const { sections, fields } = tipHeadDocument();
    const match = matchGuideToQuestions(tipHeadGuide(), sections, fields, new Set());

    expect(match.problems).toEqual([]);
    expect(match.keys).toHaveLength(15);

    const keyed = match.keys.filter((k) => k.answerKey.length > 0);
    const models = match.keys.filter((k) => k.modelAnswer);
    expect(keyed.map((k) => k.fieldId).sort()).toEqual(['q11', 'q12', 'q7', 'q8']);
    expect(models).toHaveLength(11);

    // The letters resolved positionally, the multi-select as an exact set,
    // true/false by option text — all exactly as a choice guide resolves.
    expect(keyed.find((k) => k.fieldId === 'q7')?.answerKey).toEqual(['option b']);
    expect(keyed.find((k) => k.fieldId === 'q11')?.answerKey).toEqual([
      'option a',
      'option b',
      'option c',
      'option d',
    ]);
    expect(keyed.find((k) => k.fieldId === 'q12')?.answerKey).toEqual(['True']);

    // Written entries land as prose, on the written questions only.
    expect(models.every((k) => WRITTEN_AT.has(Number(k.fieldId.slice(1))))).toBe(true);
    expect(models.find((k) => k.fieldId === 'q1')?.modelAnswer).toBe(
      'The expected prose for question 1.',
    );
    expect(models.every((k) => k.answerKey.length === 0)).toBe(true);

    // Seeded is never attested, whichever kind it is.
    expect(match.keys.every((k) => k.source === 'guide_json')).toBe(true);
    expect(match.keys.every((k) => k.verifiedAt === undefined && k.verifiedBy === undefined)).toBe(
      true,
    );
    expect(match.seeded).toEqual([{ section: 'Theory Questions', count: 15 }]);
  });

  it('BACKWARD-COMPAT PIN: a 4-entry all-choice guide still seeds via the legacy pass', () => {
    // The repo's own track-dozer key numbers only the choice questions. The
    // full list is 15, the guide is 4 — pass 1 fails, pass 2 aligns against
    // the choice questions alone, exactly as it always has.
    const { sections, fields } = tipHeadDocument();
    const match = matchGuideToQuestions(
      [
        { section: 'theory', n: 1, answers: ['b'] },
        { section: 'theory', n: 2, answers: ['a'] },
        { section: 'theory', n: 3, answers: ['a', 'b', 'c', 'd'] },
        { section: 'theory', n: 4, answers: ['True'] },
      ],
      sections,
      fields,
      new Set(),
    );

    expect(match.problems).toEqual([]);
    expect(match.keys.map((k) => k.fieldId)).toEqual(['q7', 'q8', 'q11', 'q12']);
    expect(match.keys.every((k) => k.answerKey.length > 0)).toBe(true);
    expect(match.keys.every((k) => k.modelAnswer === undefined)).toBe(true);
  });

  it('DOUBLE MISS: failing both passes reports BOTH counts and seeds nothing', () => {
    const { sections, fields } = tipHeadDocument();
    const match = matchGuideToQuestions(
      Array.from({ length: 7 }, (_, i) => ({
        section: 'theory',
        n: i + 1,
        answers: ['a'],
      })),
      sections,
      fields,
      new Set(),
    );

    expect(match.keys).toEqual([]);
    expect(match.problems).toHaveLength(1);
    expect(match.problems[0]!.reason).toContain('7 answers');
    expect(match.problems[0]!.reason).toContain('15 questions');
    expect(match.problems[0]!.reason).toContain('4 with options');
  });

  it('A LETTER ON A WRITTEN QUESTION is a reported problem, never a guess', () => {
    // The guide and the document disagree about what kind of question sits at
    // this position. "b" as a model answer would hand the assessor a
    // one-letter marking guide that means nothing.
    const { sections, fields } = tipHeadDocument();
    const entries = tipHeadGuide();
    entries[0] = { section: 'theory', n: 1, answers: ['b'] };

    const match = matchGuideToQuestions(entries, sections, fields, new Set());

    expect(match.keys.some((k) => k.fieldId === 'q1')).toBe(false);
    expect(match.keys).toHaveLength(14);
    expect(match.problems).toHaveLength(1);
    expect(match.problems[0]!.reason).toContain('written question');
    expect(match.problems[0]!.reason).toContain('"b"');
  });

  it('prose on a choice question that resolves to no option is still the existing problem', () => {
    const { sections, fields } = tipHeadDocument();
    const entries = tipHeadGuide();
    entries[6] = { section: 'theory', n: 7, answers: ['Prose that names no option'] };

    const match = matchGuideToQuestions(entries, sections, fields, new Set());

    expect(match.keys.some((k) => k.fieldId === 'q7')).toBe(false);
    expect(match.problems).toHaveLength(1);
    expect(match.problems[0]!.reason).toContain('not one of its 4 options');
  });
});

describe('parseAnswerGuide — written entries in the sectioned shape', () => {
  it('reads a single prose string under "answers", "answer" or "model_answer"', () => {
    // Real keys write a written answer three ways; all land in the same
    // answers list, and the kind is decided at match time by the question.
    const parsed = parseAnswerGuide({
      sections: {
        theory: {
          questions: [
            { n: 1, answers: 'Prose as a bare string' },
            { n: 2, answer: 'Prose under answer' },
            { n: 3, model_answer: 'Prose under model_answer' },
            { n: 4, answers: ['b'] },
          ],
        },
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual([
      { section: 'theory', n: 1, answers: ['Prose as a bare string'] },
      { section: 'theory', n: 2, answers: ['Prose under answer'] },
      { section: 'theory', n: 3, answers: ['Prose under model_answer'] },
      { section: 'theory', n: 4, answers: ['b'] },
    ]);
  });
});

describe('matchGuideToQuestions — a sectionless guide matches by text', () => {
  function q(id: string, label: string, options: string[]): FormField {
    return { id, type: 'radio', label, required: false, source: 'imported', options };
  }
  const FIELDS = [
    q('f1', 'During blasting activities radio silence is required on what channel?', ['Haul', 'Pit', 'Blast']),
    q('f2', 'What is the maximum passing speed at BBM?', ['20kph', '40kph']),
  ];
  const SECTIONS: StructureSection[] = [
    { key: 's1', label: 'Written Questions', cols: 1, fields: [{ id: 'f1' }, { id: 'f2' }] },
  ];

  it('FINDS THE QUESTION BY ITS TEXT, wherever it sits', () => {
    // Position is what the count gate refuses for a sectioned guide; across a
    // whole document it would be worse. Text identifies a question no matter
    // what sits around it.
    const match = matchGuideToQuestions(
      [{ section: '', n: 1, answers: ['c'], text: 'During blasting activities radio silence is required on what channel?' }],
      SECTIONS,
      FIELDS,
      new Set(),
    );
    expect(match.keys).toEqual([
      { fieldId: 'f1', answerKey: ['Blast'], source: 'guide_json' },
    ]);
  });

  it('matches when the guide trims or pads the printed wording', () => {
    // A guide often quotes a question with the "(more than one answer)" hint
    // dropped, or with it added.
    const match = matchGuideToQuestions(
      [{ section: '', n: 2, answers: ['b'], text: 'What is the maximum passing speed at BBM? (choose one)' }],
      SECTIONS,
      FIELDS,
      new Set(),
    );
    expect(match.keys[0]?.fieldId).toBe('f2');
  });

  it('REFUSES AN AMBIGUOUS MATCH rather than picking one', () => {
    // Two questions matching one entry means seeding either could key the
    // wrong one, which marks a candidate against a question they got right.
    const twins = [q('a1', 'Is this safe?', ['Yes', 'No']), q('a2', 'Is this safe?', ['Yes', 'No'])];
    const match = matchGuideToQuestions(
      [{ section: '', n: 1, answers: ['a'], text: 'Is this safe?' }],
      [{ key: 's1', label: 'S', cols: 1, fields: [{ id: 'a1' }, { id: 'a2' }] }] as StructureSection[],
      twins,
      new Set(),
    );
    expect(match.keys).toHaveLength(0);
    expect(match.problems[0]?.reason).toMatch(/matches 2 questions/);
  });

  it('says so when nothing in the document matches', () => {
    const match = matchGuideToQuestions(
      [{ section: '', n: 1, answers: ['a'], text: 'A question from another paper entirely' }],
      SECTIONS,
      FIELDS,
      new Set(),
    );
    expect(match.keys).toHaveLength(0);
    expect(match.problems[0]?.reason).toMatch(/No question in this document matches/);
  });

  it('will not guess from a number alone', () => {
    // Without text there is nothing to match on, and counting across a whole
    // document is the failure this path exists to avoid.
    const match = matchGuideToQuestions(
      [{ section: '', n: 1, answers: ['a'] }],
      SECTIONS,
      FIELDS,
      new Set(),
    );
    expect(match.keys).toHaveLength(0);
    expect(match.problems[0]?.reason).toMatch(/no question text/i);
  });

  it('leaves a sectioned guide on its own path', () => {
    // The count gate still governs guides that name their sections.
    const match = matchGuideToQuestions(
      [
        { section: 'Written', n: 1, answers: ['c'] },
        { section: 'Written', n: 2, answers: ['b'] },
      ],
      SECTIONS,
      FIELDS,
      new Set(),
    );
    expect(match.keys.map((k) => k.fieldId)).toEqual(['f1', 'f2']);
  });

  it('SEEDS A MODEL ANSWER when the matched question is written', () => {
    // Written questions join the text-match pool: their labels are exactly as
    // findable, and a guide quoting one is carrying its model answer.
    const written: FormField = {
      id: 'w1',
      type: 'textarea',
      label: 'Explain the exclusion zone at the tip head',
      required: false,
      source: 'imported',
    };
    const match = matchGuideToQuestions(
      [
        {
          section: '',
          n: 3,
          answers: ['Nobody enters while tipping is in progress.'],
          text: 'Explain the exclusion zone at the tip head',
        },
      ],
      [{ key: 's1', label: 'S', cols: 1, fields: [{ id: 'w1' }] }],
      [written],
      new Set(),
    );

    expect(match.keys).toEqual([
      {
        fieldId: 'w1',
        answerKey: [],
        modelAnswer: 'Nobody enters while tipping is in progress.',
        source: 'guide_json',
      },
    ]);
  });

  it('refuses an option letter on a text-matched written question', () => {
    const written: FormField = {
      id: 'w1',
      type: 'textarea',
      label: 'Explain the exclusion zone at the tip head',
      required: false,
      source: 'imported',
    };
    const match = matchGuideToQuestions(
      [
        {
          section: '',
          n: 3,
          answers: ['b'],
          text: 'Explain the exclusion zone at the tip head',
        },
      ],
      [{ key: 's1', label: 'S', cols: 1, fields: [{ id: 'w1' }] }],
      [written],
      new Set(),
    );

    expect(match.keys).toHaveLength(0);
    expect(match.problems[0]?.reason).toMatch(/written question/);
  });
});
