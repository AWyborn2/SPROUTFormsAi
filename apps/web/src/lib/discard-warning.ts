/**
 * "Answering this will throw away work you already did" (R22/U13).
 *
 * Changing a source answer can hide a whole section, and the server strips
 * hidden values on save — so the answers in that section are gone, not parked.
 * On an eighteen-page assessment that can be dozens of rows of work, and the
 * filler has no way to know it is about to happen. This computes what a
 * pending change would actually destroy so they can be told first.
 *
 * The rule is deliberately narrow: warn only when answers would REALLY be
 * lost. A change that hides only empty fields applies silently, because a
 * confirmation that fires on every harmless toggle is one people learn to
 * dismiss without reading — and then it fails on the one that mattered.
 */
import type { FormField, SubmissionValue } from '@formai/shared';
import { incompleteFixedRowIndices, isFieldAnswered, visibleFields } from '@formai/shared';

export interface DiscardImpact {
  /** Fields that are visible now, would be hidden after the change, and hold answers. */
  fields: FormField[];
  /** Convenience for messaging — `fields.length`. */
  count: number;
}

const NO_IMPACT: DiscardImpact = { fields: [], count: 0 };

/**
 * What changing `fieldId` to `nextValue` would discard.
 *
 * Section headers are excluded from the count: a header holds no answer, so
 * naming it would inflate the number the filler is asked to weigh.
 */
export function discardImpactOf(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
  fieldId: string,
  nextValue: SubmissionValue,
): DiscardImpact {
  // Nothing can be conditioned on a field no rule mentions, which is the
  // overwhelmingly common case — skip the work entirely.
  const isSource = fields.some((f) => f.visibleWhen?.fieldId === fieldId);
  if (!isSource) return NO_IMPACT;

  const before = visibleFields(fields, values);
  const after = new Set(visibleFields(fields, { ...values, [fieldId]: nextValue }).map((f) => f.id));

  const lost = before.filter(
    (f) => f.type !== 'section_header' && !after.has(f.id) && holdsWork(f, values[f.id]),
  );

  return lost.length > 0 ? { fields: lost, count: lost.length } : NO_IMPACT;
}

/**
 * Whether a field carries work worth warning about — ANY answered content, not
 * a complete answer.
 *
 * `isFieldAnswered` on a table is all-or-nothing: a 40-row checklist with 25
 * rows ticked reads as unanswered. Using it here inverted the guarantee — the
 * warning fired on a finished table (little left to lose, since the filler is
 * about to submit) and stayed silent on a half-finished one, which is exactly
 * the state someone is in when they go back to correct an earlier answer.
 */
function holdsWork(field: FormField, value: SubmissionValue | undefined): boolean {
  if (field.type === 'repeating_group') {
    const fixed = field.fixedRows?.length ?? 0;
    if (fixed > 0) return incompleteFixedRowIndices(field, value).length < fixed;
    // Open table: any row present at all is work the filler entered.
    return Array.isArray(value) && value.length > 0;
  }
  return isFieldAnswered(field, value);
}

/** Sentence shown to the filler before the change is applied. */
export function discardWarningMessage(impact: DiscardImpact): string {
  const { count } = impact;
  return count === 1
    ? 'Changing this hides 1 answered question, and its answer will be cleared. Continue?'
    : `Changing this hides ${count} answered questions, and their answers will be cleared. Continue?`;
}

/**
 * Whether a change to this field should be treated as a committed answer.
 *
 * Discrete-choice fields commit on every change — picking a dropdown option is
 * a decision. Free-text, number and date fields change on each keystroke, and
 * an intermediate value is not an answer; warning there would block editing
 * entirely. Unknown ids are treated as non-committing, which fails toward
 * silence rather than toward an undismissable prompt.
 */
export function isCommittedChange(fields: FormField[], fieldId: string): boolean {
  const field = fields.find((f) => f.id === fieldId);
  if (!field) return false;
  return (
    field.type === 'dropdown' ||
    field.type === 'radio' ||
    field.type === 'checkbox' ||
    field.type === 'boolean_yes_no' ||
    field.type === 'checkbox_group'
  );
}
