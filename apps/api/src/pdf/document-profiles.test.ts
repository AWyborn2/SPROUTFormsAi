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
import { hasProfile, profileFor } from './document-profiles.js';

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

  it('refuses to let a prerequisite row be read as a heading', () => {
    // The Track Dozer paper's driver's-licence prerequisite reads like a
    // sentence, so a generic read drops it — and then nothing downstream can
    // tell it was ever printed.
    expect(p).toContain('NEVER OMIT A PREREQUISITE ROW');
    expect(p).toContain('check_cross');
    expect(p.toLowerCase()).toContain('licence');
  });

  it('demands both sides of a matching question, and no guessed options', () => {
    // One side is not enough to build the pairings, and a guessed option list
    // is a different question from the one printed.
    expect(p).toContain('BOTH ITS SIDES');
    expect(p).toContain('matchLeft');
    expect(p).toContain('matchRight');
    expect(p).toContain('Never emit a matching question with only one');
  });
});
