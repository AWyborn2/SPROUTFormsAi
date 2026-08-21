/**
 * The assessment profile exists because of one specific extraction failure: on
 * a real 18-page competency paper, fifteen theory questions came back as rows
 * inside a summary table instead of answerable fields, leaving a candidate
 * unable to answer half the assessment.
 *
 * These pin that the instruction addressing that failure is present and
 * unambiguous, and that an untuned document type still degrades to exactly the
 * previous behaviour rather than to something new and untested.
 */
import { describe, expect, it } from 'vitest';
import { DOCUMENT_TYPES } from '@formai/shared';
import {
  appendLearnedExamples,
  hasProfile,
  learnedExamplesFor,
  profileFor,
} from './document-profiles.js';

describe('profileFor', () => {
  it('gives generic no profile, so its behaviour is unchanged', () => {
    expect(profileFor('generic')).toBe('');
    expect(hasProfile('generic')).toBe(false);
  });

  it('gives an unspecified type no profile', () => {
    expect(profileFor(undefined)).toBe('');
    expect(hasProfile(undefined)).toBe(false);
  });

  it('gives untuned types no profile rather than a guess', () => {
    // Honest empty beats invented instructions nobody has tested against a
    // real document of that class.
    for (const t of ['checklist', 'report', 'timesheet', 'order_form', 'record', 'plan'] as const) {
      expect(profileFor(t)).toBe('');
    }
  });

  it('returns instructions for assessment', () => {
    expect(hasProfile('assessment')).toBe(true);
    expect(profileFor('assessment').length).toBeGreaterThan(200);
  });

  it('never returns undefined for any declared type', () => {
    for (const t of DOCUMENT_TYPES) expect(typeof profileFor(t)).toBe('string');
  });
});

describe('the assessment profile', () => {
  const p = profileFor('assessment');

  it('forbids collapsing questions into table rows — the failure it exists for', () => {
    expect(p).toContain('QUESTIONS ARE FIELDS, NEVER TABLE ROWS');
    expect(p.toLowerCase()).toContain('never collapse a run of questions');
  });

  it('states that it overrides the base prompt on conflict', () => {
    expect(p).toContain('OVERRIDE');
  });

  it('distinguishes single-answer from multi-answer questions', () => {
    expect(p).toContain('select correct answers');
    expect(p).toContain('more than one answer');
    expect(p).toContain('selectionType');
  });

  it('asks for outcome boxes as their own check_cross fields', () => {
    expect(p).toContain('check_cross');
    expect(p.toLowerCase()).toContain('not one of the answer choices');
  });

  it('asks for section headers, which extraction otherwise omits', () => {
    expect(p).toContain('section_header');
    expect(p).toContain('PART 1');
  });

  it('exempts practical checklists from the questions rule', () => {
    expect(p).toContain('rule 1 does NOT');
    expect(p).toContain('fixedRows');
  });

  it('keeps logbooks open-ended and their hours column intact', () => {
    expect(p).toContain('OPEN');
    expect(p.toLowerCase()).toContain('duration');
  });

  it('strips the letter prefix so answer keys map onto option text', () => {
    // The authoring script matches key letters against option values; leaving
    // "a) " on the option would make every mapping ambiguous.
    expect(p).toContain('WITHOUT the a)/b)/c) prefix');
  });

  it('fixes the cover page at exactly three named sections', () => {
    // Three, and these three, because the split is a property of the document
    // class. A free-text section name would let two extractions of the same
    // page disagree about which boxes gate enrolment.
    expect(p).toContain('EXACTLY THREE SECTIONS');
    expect(p).toContain('candidate_declaration');
    expect(p).toContain('pathway_prerequisites');
    expect(p).toContain('assessor_declaration');
  });

  it('bounds coverSection to the first page, so a part sign-off cannot claim it', () => {
    /*
      The real paper prints each part's sign-off in the SAME words as the
      cover's assessor block — the same performance statement, the same
      competent pair, the same Name / Signature / Date row. Rule 8 opens by
      insisting the cover always splits into three, which biases toward filling
      them, and the page bound existed only in the tool schema.
    */
    expect(p).toContain('PROPERTY OF THE COVER PAGE, NOT OF A SHAPE');
    expect(p).toContain('FIRST page');
  });

  it('refuses to let a prerequisite row be read as a heading', () => {
    expect(p).toContain('NEVER OMIT A PREREQUISITE ROW');
    expect(p).toContain('check_cross');
    expect(p.toLowerCase()).toContain('licence');
  });

  it('refuses to let an assessor’s own ticket become a candidate prerequisite', () => {
    /*
      Page 2 of the real paper lists three qualifications the ASSESSOR must
      hold, in the identical shape as the candidate's licence prerequisite — a
      code and a title. Rule 9 shouts NEVER OMIT, so the pressure runs toward
      including them, and a false prerequisite gates enrolment on something the
      candidate never needed.
    */
    expect(p).toContain('NEVER PROMOTE AN ASSESSOR');
    expect(p).toContain('READ THE SENTENCE THAT INTRODUCES THE LIST FIRST');
  });

  it('demands both sides of a matching question, and no guessed options', () => {
    expect(p).toContain('BOTH ITS SIDES');
    expect(p).toContain('matchLeft');
    expect(p).toContain('matchRight');
    expect(p).toContain('Never emit a matching question with only one');
  });

  it('bounds the matching rule to pages that print two lists', () => {
    // Unbounded, a stem containing the word "match" over ordinary lettered
    // choices triggers the rule, which then orders `options` emptied — leaving
    // a question nobody can answer in a section that must be passed.
    expect(p).toContain('ONLY WHERE THE PAGE PRINTS');
    expect(p).toContain('TWO LISTS');
    expect(p).toContain('NEVER EMPTY THE OPTIONS OF A QUESTION THAT PRINTED THEM');
  });

  it('says a legend printed once heads every question beneath it', () => {
    /*
      THE FAILURE THIS EXISTS FOR. On the real paper the ✓ / ✗ is printed
      exactly once, above the first run of theory questions; the two later sets
      print none, and their per-question cells are blank. Read conservatively —
      "a question with no printed box gets no outcome field" — that yields no
      outcome box for 22 of 31 questions, which is the unmarkable-question
      failure `outcome-links.ts` exists to prevent.
    */
    expect(p).toContain('A LEGEND PRINTED ONCE HEADS EVERY ROW AND EVERY QUESTION BENEATH IT');
    expect(p).toContain('blank cell under such a legend IS a printed box');
    expect(p).toContain('belongs to the PART');
  });

  it('tells the model it is reading a page range and must not guess past it', () => {
    // Batched extraction means three of five calls on the real paper open
    // mid-part with no PART heading in view. A guessed part number anchors a
    // whole checklist to the wrong stage and nothing downstream can tell.
    expect(p).toContain('YOU ARE READING A PAGE RANGE');
    expect(p).toContain('GUESS NOTHING YOU CANNOT SEE');
  });

  it('reads a sideways margin label as the heading of the block beside it', () => {
    // The gutter labels print AFTER the block they name, so attaching one to
    // what follows names the next part wrongly.
    expect(p).toContain('ROTATED TEXT IN THE PAGE MARGIN');
    expect(p).toContain('never attach it to whatever follows it');
  });

  it('part-prefixes labels so identical copies can be told apart', () => {
    /*
      Parts 2, 4 and 6 of the real paper are character-identical, and 4 and 6
      share their heading text. Without a prefix the copies come back
      indistinguishable and one gets anchored to the wrong stage — certifying a
      demonstration nobody watched.
    */
    expect(p).toContain('ONLY THE PART TELLS THE COPIES APART');
    expect(p).toContain('PREFIX the `label`');
  });

  it('prefixes the label only, so verbatim content stays comparable', () => {
    // fixedRows and options are compared across copies and keyed against; a
    // prefix there would change the text everything downstream matches on.
    expect(p).toContain('Prefix the field’s own `label` ONLY');
    expect(p).toContain('`fixedRows`, `options`, `questionRef`');
  });

  it('never invents a sign-off box a part does not print', () => {
    // "Once per part" fabricated assessor name, signature and date on three of
    // six parts: Part 1 prints only a Satisfactory line, and the two logbook
    // parts print nothing at all.
    expect(p).toContain('SIGN-OFF BLOCKS ARE TRANSCRIBED, NEVER COMPLETED');
    expect(p).toContain('NEVER ADD an assessor');
  });

  it('keeps both printed outcome wordings rather than normalising one into the other', () => {
    expect(p).toContain('Satisfactory');
    expect(p).toContain('Candidate not yet Competent');
    expect(p).toContain('neither normalised into the other');
  });

  it('excludes publisher matter by who fills it, not by what shape it is', () => {
    /*
      The DOCUMENT CONTROL block is already completed with real approver names,
      ticks and dates, and has exactly the shape of a fixed-item checklist —
      so a shape test does not exclude it. Read as one it manufactures approval
      sign-offs on a compliance record.
    */
    expect(p).toContain('WHAT THE PUBLISHER ALREADY FILLED IN IS NOT A FIELD');
    expect(p).toContain('THE TEST IS WHO FILLS IT');
    expect(p).toContain('DOCUMENT CONTROL');
  });

  it('keeps a genuinely empty cell a field, so the exclusion cannot overreach', () => {
    expect(p).toContain('left EMPTY for a candidate or assessor to complete is still a field');
  });

  it('captures a logbook’s minimum hours without adding a heading that hides its table', () => {
    // `fieldsInSection` stops at the first section_header after a part's
    // anchor, so a heading between the anchor and the table hides the table
    // from the part that totals its hours.
    expect(p).toContain('NOT as a `section_header`');
    expect(p).toContain('duration');
  });

  it('captures the pathway lines verbatim, because their part numbers are the mapping', () => {
    // `AssessmentPart.pathways` is mandatory and validateManifest hard-errors
    // on a part belonging to no pathway; the printed lines are the only
    // statement of which parts each route requires.
    expect(p).toContain('THE PATHWAY LINES ARE ONE EXCLUSIVE CHOICE');
    expect(p).toContain('part numbers included');
  });

  it('keeps the assessment-method list one addressable table', () => {
    // coverSection is one value per field, and a part marks its own method row
    // when it passes — which needs the rows to be cells of one table.
    expect(p).toContain('ONE TABLE, NOT ONE FIELD PER METHOD');
  });

  it('tests a practical checklist by its tick column, not its bullet style', () => {
    // A sibling paper lettering its criteria a)/b)/c) would otherwise have its
    // whole observation checklist converted into radio questions — rule 1's
    // mistake run backwards, leaving the assessor's tick nowhere to go.
    expect(p).toContain('THE TEST IS THE COLUMN, NOT THE BULLET STYLE');
  });

  it('folds an item’s sub-bullets into its row rather than inventing criteria', () => {
    expect(p).toContain('ONE PRINTED TICK IS ONE ROW');
    expect(p).toContain('WRAPS onto a second printed line is ONE');
  });

  it('defaults a lettered question to a single answer, so an over-eager multiple cannot creep in', () => {
    /*
      Failure mode (b): the corpus marks multi-answer questions with an explicit
      "(more than one answer)" / "select correct answers" and everything else is
      one answer — but a lettered list drawn with tick boxes reads as multiple
      unless the default is pinned. A single-answer question read as multiple
      lets a candidate select every choice and still mark correct.
    */
    expect(p).toContain('DEFAULT SINGLE');
    expect(p).toContain('do NOT make it multiple');
  });

  it('names the short-answer question as its own free-text field, not a choice field', () => {
    /*
      The dominant question type across the theory and familiarisation papers is
      open-answer with no printed choices. Rule 1 speaks only of lettered
      questions, so without rule 18 an open question is either given invented
      options or read as the shape of the multiple-choice question above it.
    */
    expect(p).toContain('A NUMBERED QUESTION THAT PRINTS NO CHOICES IS ONE FREE-TEXT ANSWER');
    expect(p).toContain('textarea');
    expect(p).toContain('NEVER invent');
    expect(p).toContain('read each on its own printed shape');
  });

  it('treats a bare orphaned lettered choice as a batch-boundary fragment, not a field', () => {
    /*
      Failure mode (a): a question straddling a page-batch boundary drops its
      later choices into the next call with no stem above them. Emitted as a
      field they manufacture a question the paper never asked and mis-number
      everything after — the commonest way batching corrupts this class.
    */
    expect(p).toContain('A BARE LETTERED CHOICE WITH NO QUESTION ABOVE IT');
    expect(p).toContain('EMIT NOTHING FOR IT');
    expect(p).toContain('designNotes');
  });

  it('disambiguates a questionRef when the set heading repeats verbatim', () => {
    /*
      The familiarisation papers title every question run identically ("Verbal
      Questions") and restart numbering under each, so a heading-plus-number
      reference collides. The reference must single out one question in the pages
      given — anchored to the nearest distinctive heading or the page number.
    */
    expect(p).toContain('WHERE THE SET HEADING REPEATS VERBATIM IT CANNOT BE THE PREFIX');
    expect(p).toContain('single out ONE');
  });

  it('keeps the printed question as the label, never the bare reference', () => {
    /*
      The real failure: theory questions inside parts came back with `label`
      "Part 1 Q1" and the question's words nowhere. The label is the only text
      the builder's question bank shows, and it is what placement matches
      against the page's own text — a label printed nowhere can never be found
      on the page, so the field is unreadable AND unplaceable at once.
    */
    expect(p).toContain('A QUESTION’S `label` IS THE PRINTED QUESTION, NEVER ITS NUMBER');
    expect(p).toContain('never substitute the reference for the words');
  });

  it('names no employer, site or ticket code as a requirement', () => {
    /*
      Every example in this profile is illustrative of a printed SHAPE. A rule
      that required "BBM" or a specific qualification code would misfire on the
      next customer's document — the product promise is a paper it has never
      seen.
    */
    for (const shouted of ['MUST BE BBM', 'always Q50001782', 'Worsley']) {
      expect(p).not.toContain(shouted);
    }
  });
});

/**
 * The learned-examples promotion path (Phase F / U11) — the ONLY route from the
 * loop's evidence to the prompt, and a human-gated one. These pin that the seam
 * is byte-exact when nothing is promoted, that a promoted example actually
 * reaches the prompt, and that the anti-forms discipline holds over promoted
 * examples too — so a future promotion cannot smuggle a paper-specific rule in.
 */
describe('learned examples', () => {
  it('leaves the base profile byte-identical when nothing is promoted', () => {
    // The whole safety claim: adding this seam changed no existing prompt.
    expect(appendLearnedExamples('BASE PROFILE TEXT', [])).toBe('BASE PROFILE TEXT');
  });

  it('appends one clearly-headed block carrying each promoted example', () => {
    const out = appendLearnedExamples('BASE', ['first shape → reading', 'second shape → reading']);
    expect(out.startsWith('BASE\n')).toBe(true);
    expect(out).toContain('LEARNED EXAMPLES');
    expect(out).toContain('1. first shape → reading');
    expect(out).toContain('2. second shape → reading');
  });

  it('emits only the block when the base is empty (an untuned type given examples)', () => {
    const out = appendLearnedExamples('', ['a shape → its reading']);
    expect(out.startsWith('LEARNED EXAMPLES')).toBe(true);
    expect(out).toContain('1. a shape → its reading');
  });

  it('promotes nothing yet, so every profile reads as its base', () => {
    for (const t of DOCUMENT_TYPES) {
      expect(learnedExamplesFor(t)).toEqual([]);
      expect(profileFor(t)).not.toContain('LEARNED EXAMPLES');
    }
  });

  it('holds the anti-forms guard over every promoted example, of every type', () => {
    // Trivially true while nothing is promoted; the point is that it runs, so a
    // future promotion naming an employer, site or ticket code fails CI here.
    for (const t of DOCUMENT_TYPES) {
      for (const example of learnedExamplesFor(t)) {
        for (const shouted of ['MUST BE BBM', 'always Q50001782', 'Worsley']) {
          expect(example).not.toContain(shouted);
        }
      }
    }
  });
});
