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

import type { AssessmentPart, PartOutcome } from './assessment.js';
import type { FormField, OutcomeTarget } from './form-field.js';
import type { RepeatingRowValue, SubmissionValue } from './submission.js';
import { visibleFields, type VisibilityAnswers } from './visibility.js';

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
  values: Record<string, SubmissionValue>;
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
  const visible = visibleFields(fields, values as VisibilityAnswers);

  const mandatoryIds = new Set(part.mandatoryFieldIds ?? []);

  const marks: QuestionMark[] = [];

  for (const field of visible) {
    if (!field.answerKey || field.answerKey.length === 0) continue;
    if (!field.outcomeTarget) continue;

    const selected = selectedOptions(values[field.id]);
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
    derivedValues: applyMarks(marks, values),
    correctCount,
    totalCount: marks.length,
    mandatoryAllCorrect,
    outcome: mandatoryAllCorrect ? 'satisfactory' : 'not_satisfactory',
  };
}
