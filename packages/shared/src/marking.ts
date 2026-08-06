/**
 * Auto-marking for theory questions.
 *
 * ONE RULE: exact set match. A question's answer key lists the options that
 * together make it correct, and the candidate must select all of them and
 * nothing else. A strict subset is wrong (they missed a required option) and so
 * is a superset (they picked a wrong one). That single rule covers both printed
 * shapes — an ordinary single-answer question is a one-element key, a "select
 * correct answers" question is a multi-element one — so there is no
 * partial-credit mode to configure, and no second rule for two surfaces to
 * disagree about.
 *
 * UNANSWERED IS INCORRECT, NEVER SKIPPED. A blank question on a competency
 * paper is not a question that didn't happen; it is one the candidate did not
 * answer, and it must count against them. Skipping blanks would let a candidate
 * reach 100% on a mandatory section by answering nothing.
 *
 * MARKS ARE ORDINARY VALUES. Marking returns values keyed exactly like any
 * other answer, so the round-trip exporter draws them with no special case and
 * a reviewer reading stored data sees the same mark the PDF shows.
 *
 * HIDDEN QUESTIONS DO NOT COUNT. Marking runs over the VISIBLE field set, so a
 * candidate on one location stream is never marked on another stream's
 * questions. This reuses `visibility.ts` rather than reimplementing the rule.
 */

import { fieldsInPart } from './assessment.js';
import type { AssessmentPart, AssessmentToolManifest, PartOutcome } from './assessment.js';
import type { FormField, FormFieldType, OutcomeTarget } from './form-field.js';
import type { RepeatingRowValue, SubmissionValue } from './submission.js';
import { visibleFields, type VisibilityAnswers } from './visibility.js';

/**
 * Field types that are STRUCTURAL — furniture in the printed document, not
 * questions a candidate answers. A part's automatic marking turns only on its
 * real questions, so these are excluded from the keyed-ness test: a
 * `section_header` (the part's own anchor) and a `signature` box can hold no
 * answer key, and reading them into the test would stop any real part from ever
 * self-marking.
 */
const STRUCTURAL_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set(['section_header', 'signature']);

/**
 * Whether a part MARKS ITSELF (U15, R66–R68): it carries at least one real
 * question and EVERY real question has both a non-empty answer key and an
 * outcome target.
 *
 * Decided by keyed-ness, not by `part.kind`. The domain is stated on purpose:
 * `fieldsInPart` returns a contiguous slice carrying the part's structural
 * furniture, the ✓/✗ OUTCOME CELLS each question's mark is written into, any
 * assessor-name/date boxes the part prints, and the LOCATION-STREAM question that
 * gates which sections show — none of which holds an answer key or is a
 * competency question. All of those are excluded and every remaining real
 * question must be keyed.
 * Requiring only SOME question be keyed would let a partly-keyed part mark itself
 * against the keys it happens to hold and pass the rest unchecked — the exact
 * failure this replaces — so a part with any unkeyed question, or no real
 * question at all, reaches an assessor instead.
 *
 * Pass the FULL version field set — the slice is taken here — and unstripped, so
 * the answer keys are visible to the test.
 */
export function isSelfMarking(
  fields: readonly FormField[],
  manifest: AssessmentToolManifest,
  partKey: string,
): boolean {
  const partFields = fieldsInPart(fields, manifest, partKey);
  const part = manifest.parts.find((p) => p.key === partKey);

  // Furniture the candidate does not answer: the part's own printed
  // assessor-name and date boxes, and every field a question WRITES ITS MARK
  // INTO (a check_cross box, or the repeating group a margin table addresses).
  const furniture = new Set<string>();
  if (part?.assessorNameFieldId) furniture.add(part.assessorNameFieldId);
  if (part?.signedDateFieldId) furniture.add(part.signedDateFieldId);
  // The location-stream selector gates which sections a candidate sees; it is
  // answered but carries no answer key, so it is not a question to mark.
  if (manifest.locationStreamFieldId) furniture.add(manifest.locationStreamFieldId);
  for (const f of partFields) if (f.outcomeTarget) furniture.add(f.outcomeTarget.fieldId);

  const questions = partFields.filter(
    (f) => !STRUCTURAL_FIELD_TYPES.has(f.type) && !furniture.has(f.id),
  );
  return (
    questions.length > 0 &&
    questions.every((f) => (f.answerKey?.length ?? 0) > 0 && f.outcomeTarget !== undefined)
  );
}

/** One question's verdict. */
export interface QuestionMark {
  fieldId: string;
  correct: boolean;
  /** True when the candidate recorded no answer at all. Still `correct: false`. */
  unanswered: boolean;
  target: OutcomeTarget;
  /** Whether this question sits in the part's must-pass-entirely section. */
  mandatory: boolean;
}

export interface TheoryMarkingResult {
  marks: QuestionMark[];
  /**
   * Derived answers to merge into the attempt's values — the ✓/✗ each question
   * earned, keyed by the field it lands on.
   */
  derivedValues: Record<string, SubmissionValue>;
  /** Correct / total across the marked (visible, keyed) questions. */
  correctCount: number;
  totalCount: number;
  /** False when any question in the mandatory section is not correct. */
  mandatoryAllCorrect: boolean;
  outcome: PartOutcome;
}

/**
 * The options a candidate selected, as a set of strings.
 *
 * A multi-select answer arrives as an array; a single-select as a scalar. A
 * boolean is normalized to `'true'`/`'false'` so a yes/no question can carry an
 * answer key like any other. Absent, null and empty string all mean unanswered.
 */
function selectedOptions(value: SubmissionValue | undefined): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    // A repeating-group value cannot be a question answer.
    if (value.some((v) => typeof v === 'object' && v !== null)) return undefined;
    const options = (value as string[]).map(String).filter((s) => s !== '');
    return options.length > 0 ? options : undefined;
  }
  if (typeof value === 'boolean') return [value ? 'true' : 'false'];
  if (typeof value === 'number') return [String(value)];
  if (typeof value === 'string') return [value];
  return undefined;
}

/** Exact set equality, order- and duplicate-insensitive. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

/**
 * Write each mark onto the values map at its target.
 *
 * A scalar target takes the boolean directly. A repeating target addresses one
 * cell, so the row is found by `rowKey` (or appended when absent) and the
 * column set on it — which is how a printed outcome column beside each question
 * is actually shaped.
 */
function applyMarks(
  marks: readonly QuestionMark[],
  base: Record<string, SubmissionValue>,
): Record<string, SubmissionValue> {
  const out: Record<string, SubmissionValue> = { ...base };

  for (const mark of marks) {
    const { fieldId, rowKey, columnKey } = mark.target;

    if (!rowKey || !columnKey) {
      out[fieldId] = mark.correct;
      continue;
    }

    const existing = Array.isArray(out[fieldId]) ? (out[fieldId] as RepeatingRowValue[]) : [];
    const rows: RepeatingRowValue[] = existing.map((row) => ({ ...row }));
    const found = rows.find((row) => row.__key === rowKey);

    if (found) {
      found[columnKey] = mark.correct;
    } else {
      rows.push({ __key: rowKey, [columnKey]: mark.correct });
    }
    out[fieldId] = rows;
  }

  return out;
}

/**
 * Fields with the marking secrets removed — what a FILL surface may be served.
 *
 * `answerKey` is the complete answer key to the assessment; serving it to the
 * browser that renders the questions hands every candidate the answers in
 * devtools. Marking never runs client-side (the outcome route computes it from
 * the stored attempt), so no fill surface has any use for these properties —
 * only the builder, where keys are authored, may see them.
 *
 * Returns the same array when nothing carried a key, so callers can cheaply
 * skip no-op copies.
 */
export function stripMarkingSecrets(fields: readonly FormField[]): FormField[] {
  if (!fields.some((f) => f.answerKey || f.outcomeTarget)) return fields as FormField[];
  return fields.map((f) => {
    if (!f.answerKey && !f.outcomeTarget) return f;
    const { answerKey: _key, outcomeTarget: _target, ...rest } = f;
    return rest;
  });
}

export interface MarkTheoryInput {
  /** The full field set of the template version. */
  fields: readonly FormField[];
  /** The candidate's answers, including whatever seeds visibility. */
  /**
   * The candidate's answers. NULLABLE because an attempt that was opened and
   * never typed into stores no value map at all, and that is a real state to
   * mark: every question comes out unanswered, which is incorrect.
   */
  values: Record<string, SubmissionValue> | null | undefined;
  /** The theory part being marked — supplies the mandatory section. */
  part: Pick<AssessmentPart, 'mandatoryFieldIds'>;
}

/**
 * Mark every visible keyed question and decide the part's outcome.
 *
 * The outcome turns on the mandatory section alone: questions outside it are
 * marked and reported, but a wrong answer there does not by itself make the
 * part unsatisfactory. That mirrors the paper, where the must-pass section is
 * the gate and the location-specific sets are evidence.
 */
export function markTheory({ fields, values, part }: MarkTheoryInput): TheoryMarkingResult {
  // An untouched attempt has no map. Marking it is meaningful — every question
  // is unanswered — so normalize rather than refusing, which would have made an
  // assessor unable to fail a candidate who wrote nothing.
  const answers = values ?? {};
  const visible = visibleFields(fields, answers as VisibilityAnswers);

  const mandatoryIds = new Set(part.mandatoryFieldIds ?? []);

  const marks: QuestionMark[] = [];

  for (const field of visible) {
    if (!field.answerKey || field.answerKey.length === 0) continue;
    if (!field.outcomeTarget) continue;

    const selected = selectedOptions(answers[field.id]);
    const unanswered = selected === undefined;

    marks.push({
      fieldId: field.id,
      correct: !unanswered && sameSet(selected, field.answerKey),
      unanswered,
      target: field.outcomeTarget,
      mandatory: mandatoryIds.has(field.id),
    });
  }

  const correctCount = marks.filter((m) => m.correct).length;
  const mandatoryMarks = marks.filter((m) => m.mandatory);
  const mandatoryAllCorrect = mandatoryMarks.every((m) => m.correct);

  return {
    marks,
    derivedValues: applyMarks(marks, answers),
    correctCount,
    totalCount: marks.length,
    mandatoryAllCorrect,
    outcome: mandatoryAllCorrect ? 'satisfactory' : 'not_satisfactory',
  };
}
