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
 *
 * Rules 8-10 each exist because of a specific thing this class of document
 * carries that a generic read drops on the floor:
 *
 *  - The COVER PAGE of an assessment paper is three different documents
 *    printed on one sheet — who the candidate is, what they must already hold
 *    and which route they are taking, and what the assessor concluded. Read as
 *    one undifferentiated block it cannot be split into parts, and the
 *    pathway half — the half that gates enrolment — is the half that reads
 *    least like a form.
 *
 *  - A PREREQUISITE ROW ("Driver's Licence C or higher class") is a sentence
 *    with a tick box beside it, and a generic read treats it as a heading. It
 *    then disappears: nothing downstream can tell it was ever printed, and the
 *    tool is authored with no record that the candidate had to hold a licence.
 *    That happened on the real Track Dozer paper.
 *
 *  - A MATCHING QUESTION has no printed option list, so a read that must
 *    produce one invents it. `packages/shared/src/matching.ts` models these
 *    properly — as a choice field whose options are the PAIRINGS — but it can
 *    only build them from both sides, and nothing was ever asked for either.
 *    The result is a question sitting in a mandatory section that marking
 *    silently skips, which `validateManifest` calls out by name.
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
  '3. OUTCOME BOXES ARE SEPARATE FIELDS, LINKED BY QUESTION REFERENCE. A tick/cross box printed ' +
  'beside or after a question records whether the answer was CORRECT - it is not one of the answer ' +
  'choices. Emit it as its own `check_cross` field immediately after the question it belongs to. ' +
  'Set `questionRef` on BOTH the question and its outcome box to the reference exactly as printed ' +
  '("Q1", "BBM Q3", "7") - that string is what pairs them, so the two must match character for ' +
  'character. Numbering restarts in each section, so repeat a reference only where the page does. ' +
  'Every question with a printed outcome box gets one; a question with no printed box gets no ' +
  'outcome field, and omitting one is far better than inventing it.\n' +
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
  '`radio`.\n' +
  '8. THE COVER PAGE ALWAYS SPLITS INTO EXACTLY THREE SECTIONS, in this order, and every ' +
  'fillable box on that page belongs to one of them. Set `coverSection` on each: ' +
  '"candidate_declaration" — the candidate identity boxes (name, company, employee or swipe-card ' +
  'number) and the candidate declaration signature; "pathway_prerequisites" — EVERY prerequisite ' +
  'row, EVERY pathway statement, and EVERY assessment-method tracking row; ' +
  '"assessor_declaration" — the coaching yes/no boxes, the further-action and mandatory comment ' +
  'boxes, the competent / not-yet-competent boxes, and the assessor name, signature and date. ' +
  'Emit `section_header` fields for the three as well, so the parts they open are anchorable.\n' +
  '9. NEVER OMIT A PREREQUISITE ROW. A licence class, permit, ticket or qualification the ' +
  'candidate must already hold ("Q50001782 Driver’s Licence C or higher class") is a ' +
  'GATING FACT, not page furniture: emit it verbatim as its own `check_cross` field in ' +
  '"pathway_prerequisites". A prerequisite that is read as a heading disappears from the ' +
  'assessment entirely, and nothing downstream can tell it was ever printed.\n' +
  '10. A MATCHING QUESTION CARRIES BOTH ITS SIDES. When a question asks the candidate to match ' +
  'statements to answers, signs, images or signals, emit `matchLeft` (every prompt, verbatim, in ' +
  'printed order — where the prompts are pictures, describe each one, e.g. "Sign photo — ' +
  'red pyramid") and `matchRight` (everything they may be matched to, verbatim, in printed ' +
  'order). Set `type` to `checkbox_group` with selectionType "multiple" and leave `options` ' +
  'EMPTY — the pairings are built from the two sides, so an options list guessed here would ' +
  'be a different question from the one printed. Never emit a matching question with only one ' +
  'side: a side that cannot be read is better reported empty than invented.';

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
