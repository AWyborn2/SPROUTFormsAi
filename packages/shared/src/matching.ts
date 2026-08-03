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
