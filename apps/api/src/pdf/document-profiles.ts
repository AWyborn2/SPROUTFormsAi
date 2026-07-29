import type { DocumentType } from '@formai/shared';

/**
 * Per-document-type extraction instructions, appended to the base prompt.
 *
 * The base prompt describes forms in general. It gets some document classes
 * badly wrong, because the same printed structure means different things in
 * different classes — a table of rows is a checklist in one document and a set
 * of questions in another, and only the class tells you which.
 *
 * The failure that produced this module: on a real competency assessment paper,
 * the model emitted Mining Q7-Q12 and all ten Raw Materials questions as proper
 * answerable choice fields, but folded General Q1-Q9 and Mining Q1-Q6 into two
 * summary tables whose rows were the question text. Same document, same kind of
 * content, two incompatible readings — and fifteen questions a candidate could
 * not answer. Nothing in the generic prompt said which reading was right,
 * because generically both are defensible.
 *
 * A profile is guidance layered on the base prompt, not a replacement for it.
 * Only `assessment` is written so far; the rest fall through to the base
 * behaviour until each is worked properly against real documents of its class.
 * An empty profile is the honest state for a type nobody has tuned yet — better
 * than guesses that read like requirements.
 */

/**
 * Competency assessment papers: theory questions, practical observation
 * checklists, logbooks, and per-part sign-off.
 *
 * Rule 1 is the load-bearing one. The others describe structures this class
 * reliably contains, so the model does not have to infer their meaning.
 */
const ASSESSMENT_PROFILE =
  'DOCUMENT TYPE: COMPETENCY ASSESSMENT PAPER. These rules OVERRIDE the general guidance above ' +
  'wherever they conflict.\n' +
  '1. QUESTIONS ARE FIELDS, NEVER TABLE ROWS. Every numbered question offering lettered choices ' +
  '(a), b), c) …) is its own answerable field: a `radio` when exactly one choice is correct, a ' +
  '`checkbox_group` with selectionType "multiple" when the wording says "select correct answers", ' +
  '"more than one answer", "select all that apply" or similar. Put the choice text in `options`, ' +
  'in printed order, WITHOUT the a)/b)/c) prefix. Never collapse a run of questions into a ' +
  'repeating_group whose rows are the question text — that makes every one of them unanswerable, ' +
  'and it is the single most damaging mistake on this document class.\n' +
  '2. TRUE/FALSE questions are `radio` fields with options exactly ["True", "False"].\n' +
  '3. OUTCOME BOXES ARE SEPARATE FIELDS. A ✓/× (tick/cross) box printed beside or after a ' +
  'question records whether the answer was CORRECT — it is not one of the answer choices. Emit it ' +
  'as its own `check_cross` field immediately after the question it belongs to, labelled with that ' +
  'question\'s number. Every question with a printed outcome box gets one.\n' +
  '4. EMIT SECTION HEADERS for structural headings, as `section_header` fields carrying no answer: ' +
  'each PART heading ("PART 1 - THEORY", "PART 3 - DIRECT OBSERVATION LOG"), and each named ' +
  'question group inside a part ("Written or Verbal Questions (General)", "BBM Mining Only", ' +
  '"Raw Materials Operators Only"). These mark where a part or group begins. Include them even ' +
  'though nobody fills them in.\n' +
  '5. PRACTICAL DEMONSTRATION CHECKLISTS stay repeating_groups with fixedRows — rule 1 does NOT ' +
  'apply to them. Their rows are observed items ("Sound the horn once prior to starting the ' +
  'engine?"), not questions with lettered choices, and their columns are the ✓ / × / N-A ' +
  'alternatives described in the general guidance.\n' +
  '6. LOGBOOKS (columns such as Date, Location, Task, Duration, Comments, Signature) are OPEN ' +
  'repeating_groups: no fixedRows, because the filler adds rows over weeks. Keep the duration or ' +
  'hours column as its own column — hours are totalled from it against a minimum.\n' +
  '7. SIGN-OFF BLOCKS (assessor name, signature, date, and a competent / not-yet-competent ' +
  'choice) appear once per part. Emit each as its own field, and keep the competent choice a ' +
  '`radio`.';

const PROFILES: Partial<Record<DocumentType, string>> = {
  assessment: ASSESSMENT_PROFILE,
};

/** The extra instructions for a document type, or empty when it has none. */
export function profileFor(type: DocumentType | undefined): string {
  return (type && PROFILES[type]) ?? '';
}

/** Whether a type carries tuned instructions, as opposed to base behaviour. */
export function hasProfile(type: DocumentType | undefined): boolean {
  return profileFor(type).length > 0;
}
