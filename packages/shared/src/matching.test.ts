/**
 * Matching questions as an ordinary choice question.
 *
 * The Track Dozer theory paper asks "Match the statement with the appropriate
 * signage" and "Match the correct response with the horn Signals". The
 * extractor has been typing both as free-response text at 50% confidence,
 * which means they are not auto-marked — and an unmarked question in the
 * must-pass set contributes nothing while looking answered.
 *
 * These pin the inversion that fixes it: not "which sign goes with each
 * statement" but "which of these pairings are correct", which the existing
 * exact-set-match answer key already handles.
 */
import { describe, expect, it } from 'vitest';
import {
  MATCH_SEPARATOR,
  MatchingQuestionError,
  buildMatchingQuestion,
  groupPairingOptions,
  isMatchingQuestion,
  matchAnchorKey,
  matchAnchors,
  matchAnchorsFor,
  matchSides,
  pairingOption,
  parsePairingOption,
} from './matching.js';

/** Q7, shortened. Three statements, three signs. */
const SIGNAGE = {
  lefts: [
    'Access to areas with suspected disease is restricted',
    'For permission to pass you must contact the person on the sign',
    'A hazard is ahead and can be passed with caution',
  ],
  rights: ['Biosecurity sign', 'Traffic hazard sign', 'Caution sign'],
  correct: [
    { left: 'Access to areas with suspected disease is restricted', right: 'Biosecurity sign' },
    { left: 'For permission to pass you must contact the person on the sign', right: 'Traffic hazard sign' },
    { left: 'A hazard is ahead and can be passed with caution', right: 'Caution sign' },
  ],
};

describe('buildMatchingQuestion', () => {
  it('offers every pairing and keys only the correct ones', () => {
    const built = buildMatchingQuestion(SIGNAGE);

    // 3 × 3. The candidate picks 3 of 9, which is what makes it a question
    // rather than a formality.
    expect(built.options).toHaveLength(9);
    expect(built.answerKey).toHaveLength(3);
    expect(built.answerKey.every((k) => built.options.includes(k))).toBe(true);
  });

  it('groups the options by prompt, in printed order', () => {
    // A shuffled block would make the candidate sort nine strings mentally
    // before answering. The printed page presents one statement at a time.
    const built = buildMatchingQuestion(SIGNAGE);
    const groups = groupPairingOptions(built.options);

    expect(groups.map((g) => g.left)).toEqual(SIGNAGE.lefts);
    expect(groups[0]!.options).toHaveLength(3);
  });

  it('makes a half-right answer WRONG, with no partial credit to configure', () => {
    /*
      The reason this shape works at all. Marking is exact-set-match, so a
      candidate who gets two of three pairings right produces a set that is
      neither a subset nor a superset of the key. No new marking rule, and no
      argument later about whether two-thirds is a pass on a safety assessment.
    */
    const { answerKey } = buildMatchingQuestion(SIGNAGE);
    const halfRight = [
      answerKey[0]!,
      answerKey[1]!,
      pairingOption(SIGNAGE.lefts[2]!, 'Biosecurity sign'), // wrong sign
    ];

    expect(halfRight).toHaveLength(answerKey.length);
    expect(new Set(halfRight)).not.toEqual(new Set(answerKey));
  });

  it('allows one answer to be correct for two prompts', () => {
    // "Match each hazard to its control" may reuse a control. Refusing
    // non-bijective questions would force a real printed shape to be modelled
    // as something else.
    const built = buildMatchingQuestion({
      lefts: ['Working at height', 'Working over water'],
      rights: ['Harness', 'Gloves'],
      correct: [
        { left: 'Working at height', right: 'Harness' },
        { left: 'Working over water', right: 'Harness' },
      ],
    });

    expect(built.answerKey).toHaveLength(2);
  });

  it('does not key the same pairing twice', () => {
    const built = buildMatchingQuestion({
      lefts: ['A'],
      rights: ['1'],
      correct: [
        { left: 'A', right: '1' },
        { left: 'A', right: '1' },
      ],
    });

    expect(built.answerKey).toEqual([pairingOption('A', '1')]);
  });

  describe('refuses rather than building a question nobody can answer', () => {
    it('when a correct pairing names something not listed', () => {
      // This is the one that fails EVERY candidate silently: a key naming an
      // option the form never offers can never be selected.
      expect(() =>
        buildMatchingQuestion({
          lefts: ['A'],
          rights: ['1'],
          correct: [{ left: 'A', right: '2' }],
        }),
      ).toThrow(MatchingQuestionError);
    });

    it('when a prompt or answer is duplicated', () => {
      // Two identical options cannot be told apart in the stored answer, so
      // the mark would depend on which one the UI happened to write.
      expect(() =>
        buildMatchingQuestion({ lefts: ['A', 'A'], rights: ['1'], correct: [{ left: 'A', right: '1' }] }),
      ).toThrow(/Duplicate prompt/);
      expect(() =>
        buildMatchingQuestion({ lefts: ['A'], rights: ['1', '1'], correct: [{ left: 'A', right: '1' }] }),
      ).toThrow(/Duplicate answer/);
    });

    it('when a half contains the separator', () => {
      // It would be torn in the wrong place when parsed back.
      expect(() =>
        buildMatchingQuestion({
          lefts: [`Left${MATCH_SEPARATOR}with arrow`],
          rights: ['1'],
          correct: [{ left: `Left${MATCH_SEPARATOR}with arrow`, right: '1' }],
        }),
      ).toThrow(MatchingQuestionError);
    });

    it('when there are no correct pairings', () => {
      // An empty key is indistinguishable from "not auto-marked", so the
      // question would silently contribute nothing.
      expect(() => buildMatchingQuestion({ lefts: ['A'], rights: ['1'], correct: [] })).toThrow(
        MatchingQuestionError,
      );
    });

    it('when either side is empty', () => {
      expect(() => buildMatchingQuestion({ lefts: [], rights: ['1'], correct: [] })).toThrow(
        MatchingQuestionError,
      );
    });

    it('when a prompt is blank', () => {
      expect(() =>
        buildMatchingQuestion({ lefts: ['  '], rights: ['1'], correct: [{ left: '  ', right: '1' }] }),
      ).toThrow(/blank/);
    });
  });
});

describe('parsePairingOption', () => {
  it('recovers both halves', () => {
    expect(parsePairingOption(pairingOption('Statement', 'Sign'))).toEqual({
      left: 'Statement',
      right: 'Sign',
    });
  });

  it('returns null for anything that is not a pairing', () => {
    // A value that came from somewhere else is better refused than torn in an
    // arbitrary place.
    expect(parsePairingOption('just an option')).toBeNull();
    expect(parsePairingOption(`${MATCH_SEPARATOR}no left`)).toBeNull();
    expect(parsePairingOption(`no right${MATCH_SEPARATOR}`)).toBeNull();
  });
});

describe('isMatchingQuestion', () => {
  it('recognises a field whose options are all pairings', () => {
    const { options } = buildMatchingQuestion(SIGNAGE);
    expect(isMatchingQuestion(options)).toBe(true);
  });

  it('rejects a field with even one plain option', () => {
    /*
      Rendering a mixed field as a matching question would silently drop the
      option that is not a pairing — the candidate would never see it, and
      nothing would say so.
    */
    const { options } = buildMatchingQuestion(SIGNAGE);
    expect(isMatchingQuestion([...options, 'None of the above'])).toBe(false);
  });

  it('rejects an ordinary choice question', () => {
    expect(isMatchingQuestion(['True', 'False'])).toBe(false);
    expect(isMatchingQuestion(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Where a matching question is DRAWN
 * ------------------------------------------------------------------ */

/**
 * n + m ANCHORS, NOT n × m BOXES.
 *
 * Placement used to offer one box per PAIRING, because that is what the field
 * stores. A three-by-three question therefore asked the author for nine boxes
 * and a five-by-five for twenty-five — and eight of those nine describe a
 * correspondence the page never printed anywhere, so there was nothing on the
 * paper to place them against.
 *
 * The printed entries are the things that exist: three statements and three
 * signs. Anchoring those is linear, every anchor sits on something visible, and
 * each pairing's connector is derived from the two it runs between.
 */
describe('matchSides', () => {
  const OPTIONS = buildMatchingQuestion({
    lefts: ['Restricted area', 'Permission to pass', 'Wash-down required'],
    rights: ['Biosecurity sign', 'Traffic hazard sign', 'Wash bay sign'],
    correct: [{ left: 'Restricted area', right: 'Biosecurity sign' }],
  }).options;

  it('recovers both printed sides from the pairings', () => {
    expect(matchSides(OPTIONS)).toEqual({
      lefts: ['Restricted area', 'Permission to pass', 'Wash-down required'],
      rights: ['Biosecurity sign', 'Traffic hazard sign', 'Wash bay sign'],
    });
  });

  it('keeps printed order rather than first-seen-alphabetical', () => {
    // The order is what `l0`/`r2` index into, so an anchor placed against the
    // third printed statement has to stay the third.
    expect(matchSides(OPTIONS).lefts[2]).toBe('Wash-down required');
  });

  it('deduplicates, because each side is listed once however often it pairs', () => {
    expect(matchSides(OPTIONS).rights).toHaveLength(3);
    expect(OPTIONS).toHaveLength(9);
  });

  it('skips anything that is not a pairing rather than inventing a side for it', () => {
    // The same refusal `groupPairingOptions` makes: a field carrying a mix is
    // malformed, and giving the stray option a side would hide that.
    expect(matchSides(['a -> b', 'stray'])).toEqual({ lefts: ['a'], rights: ['b'] });
  });

  it('is empty for a question with no options at all', () => {
    expect(matchSides([])).toEqual({ lefts: [], rights: [] });
  });
});

describe('matchAnchors', () => {
  const OPTIONS = buildMatchingQuestion({
    lefts: ['One', 'Two', 'Three'],
    rights: ['A', 'B', 'C'],
    correct: [{ left: 'One', right: 'A' }],
  }).options;

  it('ASKS FOR SIX ANCHORS WHERE THE OLD MODEL ASKED FOR NINE BOXES', () => {
    expect(OPTIONS).toHaveLength(9);
    expect(matchAnchors(OPTIONS)).toHaveLength(6);
  });

  it('carries each anchor’s key, side, index and printed text', () => {
    const anchors = matchAnchors(OPTIONS);

    expect(anchors[0]).toEqual({ key: 'l0', side: 'l', index: 0, text: 'One' });
    expect(anchors[3]).toEqual({ key: 'r0', side: 'r', index: 0, text: 'A' });
  });

  it('lists the prompts before the answers, as they print', () => {
    expect(matchAnchors(OPTIONS).map((a) => a.key)).toEqual(['l0', 'l1', 'l2', 'r0', 'r1', 'r2']);
  });

  it('uses the key scheme MatchPresentation.images ALREADY uses', () => {
    // A picture and a placement both address "the third prompt". Two schemes
    // for one concept is two things to keep in step for no gain.
    expect(matchAnchorKey('l', 0)).toBe('l0');
    expect(matchAnchorKey('r', 2)).toBe('r2');
  });
});

describe('matchAnchorsFor', () => {
  const SIDES = { lefts: ['One', 'Two'], rights: ['A', 'B'] };

  it('resolves a pairing to the two anchors its connector runs between', () => {
    expect(matchAnchorsFor('Two -> B', SIDES)).toEqual({ left: 'l1', right: 'r1' });
  });

  it('REFUSES A PAIRING NAMING SOMETHING NO LONGER PRINTED', () => {
    /*
      A stored value can outlive an edit to the question. Returning null draws
      nothing, which is the point: a connector to a statement that is no longer
      on the page would be a line across a competency record asserting a
      correspondence nobody can check.
    */
    expect(matchAnchorsFor('Three -> A', SIDES)).toBeNull();
    expect(matchAnchorsFor('One -> C', SIDES)).toBeNull();
  });

  it('refuses a value that is not a pairing at all', () => {
    expect(matchAnchorsFor('One', SIDES)).toBeNull();
  });
});
