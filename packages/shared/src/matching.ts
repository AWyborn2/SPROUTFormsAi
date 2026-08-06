/**
 * Matching questions, expressed as an ordinary choice question.
 *
 * "Match the statement with the appropriate signage" has no field type of its
 * own, and does not need one. Turn the question inside out — from "which sign
 * goes with each statement" to "which of these pairings are correct" — and it
 * becomes a checkbox group whose options are the PAIRINGS: three statements
 * against three signs is nine options, of which three are right.
 *
 * That matters because the marking rule already handles it exactly. `answerKey`
 * is an exact-set match, so a candidate who pairs two correctly and one wrongly
 * produces a set that is neither a subset nor a superset of the key, and is
 * marked incorrect with no partial-credit mode to configure. Nothing in
 * `markTheory` changes, nothing in the export changes, and no migration is
 * needed for a question shape the extractor has been flagging as unanswerable.
 *
 * ONE FIELD, NOT ONE PER STATEMENT. Three dropdowns would read better on
 * screen, but each would need its own answer key and therefore its own outcome
 * target — and the printed page gives a matching question a SINGLE tick/cross
 * box in the right margin. The model has to match the paper it certifies, and
 * the paper says one verdict.
 */

/**
 * Between the two halves of a pairing option.
 *
 * Printed into the option value, so it lands in the stored submission and in
 * anything that renders it. Readable rather than compact, because an option
 * value is evidence: "a) -> 2)" tells a reader nothing six months later.
 *
 * ASCII, NOT AN ARROW GLYPH. This string can reach the evidence PDF — a choice
 * field with no per-option geometry falls through to having its joined value
 * drawn as text — and that page uses `StandardFonts.Helvetica`, which is
 * WinAnsi. pdf-lib THROWS on a character WinAnsi cannot encode, so a "→" here
 * would fail the export of a certificate rather than degrade it. The same file
 * already works around this for the checkmark.
 */
export const MATCH_SEPARATOR = ' -> ';

/** One correct correspondence. */
export interface MatchingPair {
  /** The prompt side, e.g. a statement about restricted areas. */
  left: string;
  /** What it corresponds to, e.g. the sign that carries it. */
  right: string;
}

/** A matching question, before it becomes options and a key. */
export interface MatchingQuestion {
  /** Every prompt, in the order they are printed. */
  lefts: readonly string[];
  /** Everything they may be matched to, in the order they are printed. */
  rights: readonly string[];
  /**
   * The correspondences that are correct.
   *
   * NOT required to be a bijection. "Match each hazard to its control" may use
   * one control twice, and a matching question that reuses an answer is a real
   * printed shape — refusing it here would force an author to model a normal
   * question as something else.
   */
  correct: readonly MatchingPair[];
}

/** One pairing, as it appears in `options` and in `answerKey`. */
export function pairingOption(left: string, right: string): string {
  return `${left}${MATCH_SEPARATOR}${right}`;
}

/**
 * Split a pairing option back into its halves, or null if it is not one.
 *
 * Splits on the FIRST separator. `buildMatchingQuestion` refuses to build an
 * option whose halves contain the separator, so within a well-formed question
 * the first occurrence is the only one — and a value that arrived from
 * somewhere else returning null is better than one silently torn in the wrong
 * place.
 */
export function parsePairingOption(option: string): MatchingPair | null {
  const at = option.indexOf(MATCH_SEPARATOR);
  if (at < 0) return null;
  const left = option.slice(0, at);
  const right = option.slice(at + MATCH_SEPARATOR.length);
  if (!left || !right) return null;
  return { left, right };
}

export interface BuiltMatchingQuestion {
  /** Every possible pairing, grouped by prompt in printed order. */
  options: string[];
  /** The pairings that are correct — an exact-set answer key. */
  answerKey: string[];
}

/** Why a matching question could not be built. */
export class MatchingQuestionError extends Error {}

/**
 * Turn a matching question into the options and answer key of a choice field.
 *
 * Options are every left × every right, GROUPED BY LEFT and in printed order,
 * so the rendered list reads as "statement one, its candidates; statement two,
 * its candidates" rather than as a shuffled block a candidate has to sort
 * mentally before answering.
 *
 * Refuses rather than guessing, in every case where a silent result would be a
 * question that cannot be answered correctly:
 *
 *  - a correct pair naming something not in the lists, which would key an
 *    option the candidate is never offered and fail everyone;
 *  - a duplicate prompt or answer, which makes two options identical and the
 *    stored set unable to say which was meant;
 *  - either half containing the separator, which would make the option
 *    unparseable back into halves.
 */
export function buildMatchingQuestion(question: MatchingQuestion): BuiltMatchingQuestion {
  const { lefts, rights, correct } = question;

  if (lefts.length === 0 || rights.length === 0) {
    throw new MatchingQuestionError('A matching question needs at least one prompt and one answer.');
  }

  for (const [side, items] of [
    ['prompt', lefts],
    ['answer', rights],
  ] as const) {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.trim()) throw new MatchingQuestionError(`A ${side} is blank.`);
      if (item.includes(MATCH_SEPARATOR)) {
        throw new MatchingQuestionError(
          `The ${side} "${item}" contains "${MATCH_SEPARATOR.trim()}", which separates the two halves of a pairing.`,
        );
      }
      if (seen.has(item)) {
        // Two identical options cannot be told apart in the stored answer, so
        // the mark would depend on which one the UI happened to write.
        throw new MatchingQuestionError(`Duplicate ${side} "${item}".`);
      }
      seen.add(item);
    }
  }

  const leftSet = new Set(lefts);
  const rightSet = new Set(rights);
  for (const pair of correct) {
    if (!leftSet.has(pair.left)) {
      throw new MatchingQuestionError(`Correct pairing names prompt "${pair.left}", which is not listed.`);
    }
    if (!rightSet.has(pair.right)) {
      throw new MatchingQuestionError(`Correct pairing names answer "${pair.right}", which is not listed.`);
    }
  }

  if (correct.length === 0) {
    // A key of zero is indistinguishable from "not auto-marked", and the
    // question would silently contribute nothing.
    throw new MatchingQuestionError('A matching question needs at least one correct pairing.');
  }

  const options: string[] = [];
  for (const left of lefts) {
    for (const right of rights) options.push(pairingOption(left, right));
  }

  // Deduplicated: the same correspondence listed twice is one correct answer,
  // and a repeated key entry would not change the set but would mislead anyone
  // reading it.
  const answerKey = [...new Set(correct.map((p) => pairingOption(p.left, p.right)))];

  return { options, answerKey };
}

/**
 * Group a matching question's options by prompt, for rendering.
 *
 * The flat `options` array is what the field stores and what marking compares;
 * a fill surface wants them in blocks so a candidate answers one statement at a
 * time. Derived rather than stored, so the two cannot disagree.
 */
export function groupPairingOptions(options: readonly string[]): { left: string; options: string[] }[] {
  const groups: { left: string; options: string[] }[] = [];
  const byLeft = new Map<string, string[]>();

  for (const option of options) {
    const parsed = parsePairingOption(option);
    // Anything that is not a pairing is left out rather than guessed at — a
    // field carrying a mix is malformed, and inventing a group for it would
    // hide that.
    if (!parsed) continue;
    let bucket = byLeft.get(parsed.left);
    if (!bucket) {
      bucket = [];
      byLeft.set(parsed.left, bucket);
      groups.push({ left: parsed.left, options: bucket });
    }
    bucket.push(option);
  }

  return groups;
}

/**
 * Whether a field's options look like a matching question.
 *
 * Used to decide whether to render the grouped matching layout. Requires EVERY
 * option to be a pairing — a field with one stray plain option is not a
 * matching question, and rendering it as one would drop that option from the
 * form without saying so.
 */
export function isMatchingQuestion(options: readonly string[] | undefined): boolean {
  if (!options || options.length < 2) return false;
  return options.every((o) => parsePairingOption(o) !== null);
}

/* ------------------------------------------------------------------ *
 * Where a matching question is DRAWN on the page
 * ------------------------------------------------------------------ */

/**
 * A matching question's anchor key — `l0`, `r2`.
 *
 * THE SAME VOCABULARY `MatchPresentation.images` ALREADY USES. A picture and a
 * placement both address "the third prompt", and two key schemes for one
 * concept is two things to keep in step for no gain. This is that scheme, moved
 * out of the pair builder so the exporter can speak it too.
 */
export function matchAnchorKey(side: 'l' | 'r', index: number): string {
  return `${side}${index}`;
}

/** The two printed sides of a matching question, in printed order. */
export interface MatchSides {
  lefts: string[];
  rights: string[];
}

/**
 * Recover both sides from a built matching question's options.
 *
 * DERIVED, NEVER STORED. `buildMatchingQuestion` writes every left × every
 * right as a flat list of pairings, and `matching-authoring.ts` already reads
 * the sides back out of it for exactly this reason: a second stored copy is a
 * second thing that can disagree with the first, and the disagreement would
 * surface as a connector drawn to the wrong statement on a competency record.
 *
 * Order-preserving and deduplicated, matching how the options were generated —
 * the outer loop is the prompts, the inner one the answers.
 */
export function matchSides(options: readonly string[]): MatchSides {
  const lefts: string[] = [];
  const rights: string[] = [];
  const seenLeft = new Set<string>();
  const seenRight = new Set<string>();

  for (const option of options) {
    const parsed = parsePairingOption(option);
    // A stray non-pairing is skipped rather than guessed at, for the same
    // reason `groupPairingOptions` skips it: a field carrying a mix is
    // malformed, and inventing a side for it would hide that.
    if (!parsed) continue;
    if (!seenLeft.has(parsed.left)) {
      seenLeft.add(parsed.left);
      lefts.push(parsed.left);
    }
    if (!seenRight.has(parsed.right)) {
      seenRight.add(parsed.right);
      rights.push(parsed.right);
    }
  }

  return { lefts, rights };
}

/**
 * Every anchor a matching question needs placed, in the order they print.
 *
 * n + m, NOT n × m, AND THAT IS THE WHOLE POINT. Placement used to offer one
 * box per PAIRING, so a three-by-three question asked the author for nine boxes
 * and a five-by-five for twenty-five — quadratic work for a question that has
 * ten printed things on it. Worse, eight of those nine boxes describe a
 * correspondence the page never printed anywhere, so there was nothing to place
 * them against.
 *
 * Anchoring the printed ENTRIES instead is linear, and every anchor corresponds
 * to something visible: the statement, and the sign. Each pairing's connector is
 * then derived from the two anchors it runs between.
 */
export interface MatchAnchor {
  key: string;
  side: 'l' | 'r';
  index: number;
  /** The printed text this anchor sits on. */
  text: string;
}

export function matchAnchors(options: readonly string[]): MatchAnchor[] {
  const { lefts, rights } = matchSides(options);
  return [
    ...lefts.map((text, index) => ({ key: matchAnchorKey('l', index), side: 'l' as const, index, text })),
    ...rights.map((text, index) => ({ key: matchAnchorKey('r', index), side: 'r' as const, index, text })),
  ];
}

/**
 * The two anchors a pairing's connector runs between.
 *
 * Null when either half names something the sides do not contain, which cannot
 * happen for an option `buildMatchingQuestion` produced and can happen for a
 * stored value that outlived an edit to the question. Returning null draws
 * nothing: a connector to a statement that is no longer printed would be a line
 * across the page asserting a correspondence nobody can check.
 */
export function matchAnchorsFor(
  option: string,
  sides: MatchSides,
): { left: string; right: string } | null {
  const parsed = parsePairingOption(option);
  if (!parsed) return null;
  const l = sides.lefts.indexOf(parsed.left);
  const r = sides.rights.indexOf(parsed.right);
  if (l < 0 || r < 0) return null;
  return { left: matchAnchorKey('l', l), right: matchAnchorKey('r', r) };
}
