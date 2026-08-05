/**
 * Authoring a matching question: getting from what the extraction managed to
 * read to the two lists and the pairings `matching.ts` turns into options and a
 * key.
 *
 * This is a THIN layer over `buildMatchingQuestion`, deliberately. That function
 * already models the question, already refuses every case where a silent result
 * would be unanswerable, and already carries messages written for a person to
 * read. Nothing here re-decides any of that — it seeds the editor, and it
 * converts a throw into a value the UI can render inline.
 *
 * THE SEEDING RULE THAT MATTERS: a seed is a PROPOSAL, never a decision. The
 * extraction may have read both sides, one side, or neither, and this module's
 * job is to say which of those happened and hand the author a starting point —
 * not to manufacture the missing half. A question the builder silently completed
 * is one nobody knows to check, and it sits in a section that must be passed.
 */

import {
  buildMatchingQuestion,
  isMatchingQuestion,
  MatchingQuestionError,
  parsePairingOption,
  type BuiltMatchingQuestion,
  type MatchingPair,
  type MatchingQuestion,
} from '@formai/shared';

/* ------------------------------------------------------------------ *
 * Seeding
 * ------------------------------------------------------------------ */

/**
 * Where a pair builder's starting content came from.
 *
 * Shown to the author, because the four cases deserve different amounts of
 * suspicion: `both_sides` is transcription, `split_options` is inference this
 * module performed, and `one_side` and `blank` are honest gaps.
 */
export type MatchSeedOrigin =
  /** Extraction read `matchLeft` and `matchRight`. Rule 10 did its job. */
  | 'both_sides'
  /** Extraction read one side only. The other is the author's to supply. */
  | 'one_side'
  /** Recovered by splitting a flat option list whose rows print both halves. */
  | 'split_options'
  /** Nothing usable was printed, or nothing survived extraction. */
  | 'blank'
  /** The field is ALREADY a built matching question — its options are pairings. */
  | 'existing';

export interface MatchSeed {
  lefts: string[];
  rights: string[];
  /** The pairings already keyed, where the field carries a key. Never inferred. */
  correct: MatchingPair[];
  origin: MatchSeedOrigin;
  /**
   * What the author is being told, in one sentence.
   *
   * Present whenever the seed is anything other than a clean two-sided read,
   * because every other case needs the author to do something before the
   * question is answerable.
   */
  note?: string;
}

/**
 * Printed separators between the two halves of a combined row, most specific
 * first.
 *
 * An em or en dash between spaces is nearly unambiguous in this document class.
 * A plain hyphen is NOT — "Wear PPE - including gloves" is one option, not a
 * pairing — so it is tried last and only ever survives the all-or-nothing rule
 * below. A colon sits between the two: common as a separator, common inside a
 * stem.
 */
const ROW_SEPARATORS: readonly RegExp[] = [
  /\s+—\s+/,
  /\s+–\s+/,
  /\s+:\s+/,
  /\s+-\s+/,
];

/**
 * Split a flat option list into two sides, or null if it does not split
 * cleanly.
 *
 * ALL-OR-NOTHING, ON ONE SEPARATOR. A separator qualifies only if EVERY row
 * splits on it into two non-empty halves. A list where four rows split on " - "
 * and the fifth does not is not a table printed as combined rows — it is an
 * ordinary option list containing a hyphen, and splitting four of its five
 * options would silently discard the fifth's second half and key a question
 * against options the candidate was never offered.
 *
 * The halves are kept VERBATIM apart from trimming. Printed enumerators ("1.",
 * "a)") stay: they are what the page shows, and the whole document class is read
 * on the principle that content is transcribed rather than tidied.
 */
export function splitCombinedRows(options: readonly string[]): { lefts: string[]; rights: string[] } | null {
  // One row cannot establish that a separator is structural rather than
  // incidental, and a one-row matching question is not one.
  if (options.length < 2) return null;

  for (const separator of ROW_SEPARATORS) {
    const halves = options.map((option) => {
      const at = option.search(separator);
      if (at < 0) return null;
      const match = option.match(separator);
      if (!match) return null;
      const left = option.slice(0, at).trim();
      const right = option.slice(at + match[0].length).trim();
      return left && right ? { left, right } : null;
    });

    if (halves.some((h) => h === null)) continue;
    const pairs = halves as MatchingPair[];

    /*
      Both sides are DEDUPLICATED, order-preserving.

      The answer side is a pool: "which sign goes with each statement" prints
      the same sign against more than one statement whenever a sign is reused.
      Carrying the repeat through would hit `buildMatchingQuestion`'s duplicate
      check and read to the author as a document problem rather than as the
      ordinary shape it is.
    */
    return { lefts: dedupe(pairs.map((p) => p.left)), rights: dedupe(pairs.map((p) => p.right)) };
  }

  return null;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((i) => i.length > 0))];
}

/**
 * Everything the seed is allowed to look at.
 *
 * Structural rather than `Pick<FormField, …>` because a `FormField` does NOT
 * carry `matchLeft` / `matchRight` — those are read by extraction and live on
 * `ExtractedField`, and the builder's editable field list is seeded from the
 * extraction without them. The caller composes this from both, which keeps the
 * data flow visible: the sides come from what the document said, the options and
 * key come from what the author has done since.
 *
 * `FormField` is deliberately NOT widened to hold the sides. Once a question is
 * built, its options ARE both sides — `parsePairingOption` recovers them — so
 * storing them again would create a second copy that can disagree with the
 * first.
 */
export interface MatchSeedSource {
  options?: readonly string[];
  answerKey?: readonly string[];
  matchLeft?: readonly string[];
  matchRight?: readonly string[];
}

/**
 * What the pair builder opens with, for a given field.
 *
 * Deliberately does NOT infer pairings from row order. A flat list whose rows
 * happen to read "statement — sign" may be a printed answer table or may be the
 * two lists set side by side for the candidate to work from; nothing on the page
 * says which. Keying from that layout would be an adjacency guess standing in
 * for a decision, on a question in a section that must be passed — the same
 * trade this codebase refuses wherever a printed reference exists to use
 * instead.
 */
export function seedFromField(field: MatchSeedSource): MatchSeed {
  const left = field.matchLeft?.filter((s) => s.trim()) ?? [];
  const right = field.matchRight?.filter((s) => s.trim()) ?? [];

  /*
    An ALREADY-BUILT question is reopened from its own options.

    Editing a matching question that has been saved once must show what it
    currently says, not re-seed from the extraction and quietly discard the
    author's work. Its options are pairings, so both sides and any existing key
    are read straight back out of them.
  */
  if (isMatchingQuestion(field.options)) {
    const parsed = field.options!.map(parsePairingOption).filter((p): p is MatchingPair => p !== null);
    const keyed = (field.answerKey ?? [])
      .map(parsePairingOption)
      .filter((p): p is MatchingPair => p !== null);
    return {
      lefts: dedupe(parsed.map((p) => p.left)),
      rights: dedupe(parsed.map((p) => p.right)),
      correct: keyed,
      origin: 'existing',
    };
  }

  if (left.length > 0 && right.length > 0) {
    return { lefts: dedupe(left), rights: dedupe(right), correct: [], origin: 'both_sides' };
  }

  if (left.length > 0 || right.length > 0) {
    const side = left.length > 0 ? 'prompts' : 'answers';
    const missing = left.length > 0 ? 'answers' : 'prompts';
    return {
      lefts: dedupe(left),
      rights: dedupe(right),
      correct: [],
      origin: 'one_side',
      note: `Only the ${side} were read from the document. Add the ${missing} before keying this question.`,
    };
  }

  const split = splitCombinedRows(field.options ?? []);
  if (split) {
    return {
      ...split,
      correct: [],
      origin: 'split_options',
      note: 'Both sides were recovered by splitting the printed rows. Check them against the document, then set which pairings are correct — the row order was not read as an answer.',
    };
  }

  return {
    lefts: [],
    rights: [],
    correct: [],
    origin: 'blank',
    note: 'Neither side of this matching question was read from the document. Both lists have to be entered from the paper.',
  };
}

/* ------------------------------------------------------------------ *
 * Building
 * ------------------------------------------------------------------ */

export type MatchBuildResult =
  | { ok: true; built: BuiltMatchingQuestion }
  | { ok: false; message: string };

/**
 * Build, returning the refusal rather than throwing it.
 *
 * `buildMatchingQuestion` throws `MatchingQuestionError` with a message already
 * written for a person — "Duplicate prompt …", "Correct pairing names answer …,
 * which is not listed". The pair builder renders those verbatim beside the
 * offending row instead of rewording them, because a second wording is a second
 * thing to keep true.
 *
 * Only `MatchingQuestionError` is caught. Anything else is a fault in this code
 * and is left to surface.
 */
export function buildFromDraft(question: MatchingQuestion): MatchBuildResult {
  try {
    return { ok: true, built: buildMatchingQuestion(question) };
  } catch (err) {
    if (err instanceof MatchingQuestionError) return { ok: false, message: err.message };
    throw err;
  }
}

/**
 * Prompts with no correct pairing yet.
 *
 * A matching question whose key covers three of its five statements BUILDS —
 * `buildMatchingQuestion` requires at least one pairing, not all of them,
 * because "match each hazard to its control" legitimately leaves some prompts
 * unmatched on some papers. So this cannot be an error, and it cannot be
 * silence either: the overwhelmingly common cause is an author who stopped
 * half-way, and exact-set marking then fails every candidate who pairs the
 * unkeyed statements correctly.
 */
export function unpairedPrompts(question: MatchingQuestion): string[] {
  const paired = new Set(question.correct.map((p) => p.left));
  return question.lefts.filter((l) => !paired.has(l));
}
