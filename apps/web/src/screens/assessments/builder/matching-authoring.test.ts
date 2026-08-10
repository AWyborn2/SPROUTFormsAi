import { describe, expect, it } from 'vitest';
import { pairingOption } from '@formai/shared';
import {
  buildFromDraft,
  seedFromField,
  splitCombinedRows,
  unpairedPrompts,
} from './matching-authoring.js';

describe('splitCombinedRows', () => {
  it('splits rows printed with an em dash into two sides', () => {
    const split = splitCombinedRows([
      'Restricted area — Red triangle',
      'Mandatory PPE — Blue circle',
      'Fire point — Red square',
    ]);
    expect(split).toEqual({
      lefts: ['Restricted area', 'Mandatory PPE', 'Fire point'],
      rights: ['Red triangle', 'Blue circle', 'Red square'],
    });
  });

  it('keeps printed enumerators, because content is transcribed rather than tidied', () => {
    // Every rule in the extraction profile turns on the page being reported as
    // printed. A splitter that quietly stripped "1." and "a)" would make this
    // the one place content is improved on the way through.
    const split = splitCombinedRows(['1. Restricted area — a) Red triangle', '2. Fire point — b) Red square']);
    expect(split?.lefts).toEqual(['1. Restricted area', '2. Fire point']);
    expect(split?.rights).toEqual(['a) Red triangle', 'b) Red square']);
  });

  it('refuses to split when a single row does not carry the separator', () => {
    /*
      THE FAILURE THIS EXISTS FOR. Four rows split on " - " and the fifth is an
      ordinary option containing a hyphen. Splitting the four would drop the
      fifth's second half and key the question against options the candidate is
      never offered — in a section that must be passed.
    */
    expect(
      splitCombinedRows([
        'Restricted area - Red triangle',
        'Mandatory PPE - Blue circle',
        'Wear high-visibility clothing at all times',
      ]),
    ).toBeNull();
  });

  it('does not tear an ordinary option list apart on an incidental hyphen', () => {
    expect(
      splitCombinedRows(['Wear PPE - including gloves', 'Sound the horn', 'Check the mirrors']),
    ).toBeNull();
  });

  it('prefers the more specific separator where a row contains both', () => {
    // A dash-separated row whose prompt also contains a colon must split on the
    // dash, not on the colon inside the prompt.
    const split = splitCombinedRows(['Warning: restricted area — Red triangle', 'Note: fire point — Red square']);
    expect(split?.lefts).toEqual(['Warning: restricted area', 'Note: fire point']);
    expect(split?.rights).toEqual(['Red triangle', 'Red square']);
  });

  it('deduplicates the answer side, because an answer may be printed against more than one prompt', () => {
    // "Which sign goes with each statement" reuses a sign whenever the paper
    // does. Carrying the repeat through hits buildMatchingQuestion's duplicate
    // check and reads to the author as a document problem.
    const split = splitCombinedRows([
      'Restricted area — Red triangle',
      'Fire point — Red triangle',
      'Mandatory PPE — Blue circle',
    ]);
    expect(split?.rights).toEqual(['Red triangle', 'Blue circle']);
    expect(split?.lefts).toEqual(['Restricted area', 'Fire point', 'Mandatory PPE']);
  });

  it('refuses a single row, which cannot establish that a separator is structural', () => {
    expect(splitCombinedRows(['Restricted area — Red triangle'])).toBeNull();
  });

  it('refuses a row whose half is empty on either side', () => {
    expect(splitCombinedRows(['Restricted area — ', 'Fire point — Red square'])).toBeNull();
  });
});

describe('seedFromField', () => {
  it('seeds both sides when extraction read both', () => {
    const seed = seedFromField({
      matchLeft: ['Restricted area', 'Fire point'],
      matchRight: ['Red triangle', 'Red square'],
    });
    expect(seed.origin).toBe('both_sides');
    expect(seed.lefts).toEqual(['Restricted area', 'Fire point']);
    expect(seed.rights).toEqual(['Red triangle', 'Red square']);
    // A clean two-sided read is transcription and needs no warning.
    expect(seed.note).toBeUndefined();
  });

  it('never invents the missing half when only one side was read', () => {
    // The pair builder opening pre-filled on both sides when only one was
    // printed is a question nobody knows to check.
    const seed = seedFromField({ matchLeft: ['Restricted area', 'Fire point'] });
    expect(seed.origin).toBe('one_side');
    expect(seed.rights).toEqual([]);
    expect(seed.note).toContain('Only the prompts were read');
  });

  it('names the side that is missing, whichever one it is', () => {
    const seed = seedFromField({ matchRight: ['Red triangle', 'Red square'] });
    expect(seed.origin).toBe('one_side');
    expect(seed.lefts).toEqual([]);
    expect(seed.note).toContain('Only the answers were read');
  });

  it('recovers both sides from a flat option list of combined rows', () => {
    const seed = seedFromField({
      options: ['Restricted area — Red triangle', 'Fire point — Red square'],
    });
    expect(seed.origin).toBe('split_options');
    expect(seed.lefts).toEqual(['Restricted area', 'Fire point']);
    expect(seed.rights).toEqual(['Red triangle', 'Red square']);
  });

  it('does not key a split question from its row order', () => {
    /*
      A flat list whose rows read "statement — sign" may be a printed answer
      table or the two lists set side by side; nothing on the page says which.
      Keying from the layout is an adjacency guess standing in for a decision.
    */
    const seed = seedFromField({
      options: ['Restricted area — Red triangle', 'Fire point — Red square'],
    });
    expect(seed.correct).toEqual([]);
    expect(seed.note).toContain('the row order was not read as an answer');
  });

  it('reopens an already-built question from its own options rather than re-seeding', () => {
    // Re-seeding from the extraction on every open would discard the author's
    // work the moment they came back to check it.
    const options = [
      pairingOption('Restricted area', 'Red triangle'),
      pairingOption('Restricted area', 'Blue circle'),
      pairingOption('Fire point', 'Red triangle'),
      pairingOption('Fire point', 'Blue circle'),
    ];
    const seed = seedFromField({
      options,
      answerKey: [pairingOption('Restricted area', 'Red triangle')],
      // Present, and deliberately ignored — the saved question wins.
      matchLeft: ['something else entirely'],
      matchRight: ['and another'],
    });
    expect(seed.origin).toBe('existing');
    expect(seed.lefts).toEqual(['Restricted area', 'Fire point']);
    expect(seed.rights).toEqual(['Red triangle', 'Blue circle']);
    expect(seed.correct).toEqual([{ left: 'Restricted area', right: 'Red triangle' }]);
  });

  it('returns a blank seed, with a note, when nothing usable was read', () => {
    const seed = seedFromField({ options: ['True', 'False'] });
    expect(seed.origin).toBe('blank');
    expect(seed.lefts).toEqual([]);
    expect(seed.rights).toEqual([]);
    expect(seed.note).toContain('Neither side');
  });

  it('treats a side of blank strings as no side at all', () => {
    const seed = seedFromField({ matchLeft: ['  ', ''], matchRight: ['Red triangle', 'Red square'] });
    expect(seed.origin).toBe('one_side');
    expect(seed.lefts).toEqual([]);
  });
});

describe('buildFromDraft', () => {
  it('builds options and a key from the two sides', () => {
    const result = buildFromDraft({
      lefts: ['Restricted area', 'Fire point'],
      rights: ['Red triangle', 'Red square'],
      correct: [{ left: 'Restricted area', right: 'Red triangle' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.built.options).toHaveLength(4);
    expect(result.built.answerKey).toEqual([pairingOption('Restricted area', 'Red triangle')]);
  });

  it('returns the refusal as a value rather than throwing it', () => {
    // The pair builder renders this beside the offending row. A throw here
    // would take the step down instead.
    const result = buildFromDraft({
      lefts: ['Restricted area', 'Restricted area'],
      rights: ['Red triangle'],
      correct: [{ left: 'Restricted area', right: 'Red triangle' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('Duplicate prompt');
  });

  it('surfaces the shared message verbatim, rather than rewording it', () => {
    // These messages are already written for a person. A second wording is a
    // second thing to keep true.
    const result = buildFromDraft({
      lefts: ['Restricted area'],
      rights: ['Red triangle'],
      correct: [{ left: 'Restricted area', right: 'Blue circle' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      'Correct pairing names answer "Blue circle", which is not listed.',
    );
  });

  it('refuses a question with no correct pairing at all', () => {
    const result = buildFromDraft({
      lefts: ['Restricted area'],
      rights: ['Red triangle'],
      correct: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('at least one correct pairing');
  });
});

describe('unpairedPrompts', () => {
  it('names prompts the author has not keyed yet', () => {
    /*
      A partially-keyed question BUILDS — at least one pairing is the rule, not
      all of them, because some papers legitimately leave prompts unmatched. So
      this cannot be an error; but exact-set marking then fails every candidate
      who pairs the unkeyed statements correctly, so it cannot be silence.
    */
    expect(
      unpairedPrompts({
        lefts: ['Restricted area', 'Fire point', 'Mandatory PPE'],
        rights: ['Red triangle', 'Red square'],
        correct: [{ left: 'Restricted area', right: 'Red triangle' }],
      }),
    ).toEqual(['Fire point', 'Mandatory PPE']);
  });

  it('is empty when every prompt is keyed', () => {
    expect(
      unpairedPrompts({
        lefts: ['Restricted area'],
        rights: ['Red triangle'],
        correct: [{ left: 'Restricted area', right: 'Red triangle' }],
      }),
    ).toEqual([]);
  });

  it('counts a prompt keyed more than once as keyed', () => {
    // "Match each hazard to its control" may pair one prompt with two controls.
    expect(
      unpairedPrompts({
        lefts: ['Restricted area', 'Fire point'],
        rights: ['Red triangle', 'Red square'],
        correct: [
          { left: 'Restricted area', right: 'Red triangle' },
          { left: 'Restricted area', right: 'Red square' },
        ],
      }),
    ).toEqual(['Fire point']);
  });
});
