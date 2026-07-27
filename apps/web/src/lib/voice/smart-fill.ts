/**
 * Staging Smart Fill's proposals onto a form's answers.
 *
 * The API hands back what a model believes it heard about a whole form at once,
 * so this module is the last gate before those guesses become someone's
 * compliance record. Pure and React-free for the same reason `coerce.ts` is:
 * "which answers actually changed, and which of them must a human look at" is
 * the part that has to be exercised directly rather than inferred from a
 * rendered page.
 *
 * Nothing here submits. Every path produces a proposal for the existing review
 * step to carry — the respondent is still the one who commits.
 */
import type { FormField, SmartFillMapping, SubmissionValue } from '@formai/shared';
import { isDictatable } from './coerce.js';

/**
 * Below this a mapping is surfaced as "check this" rather than as an answer.
 *
 * 0.75 rather than a coin-flip 0.5 because the API defaults a missing or
 * unparseable confidence to exactly 0.5 — a model that told us nothing about
 * how sure it was has to land in the review pile, not in the accepted one.
 */
export const SMART_FILL_CONFIDENCE_THRESHOLD = 0.75;

export interface SmartFillChange {
  fieldId: string;
  /** What the field held before — kept so the UI can show what was replaced. */
  previous: SubmissionValue;
  next: SubmissionValue;
}

export interface AppliedSmartFill {
  /** `values` merged with every accepted mapping. */
  values: Record<string, SubmissionValue>;
  changes: SmartFillChange[];
}

/**
 * Merge accepted mappings into `values`.
 *
 * A mapping is dropped, never errored, when it names a field this page is not
 * rendering: that happens when a tab has been open across a republish, or when
 * a condition hides the question, and writing it would put an answer on a
 * question this respondent was never asked. The API applies the same rule
 * server-side; doing it again here is what makes a stale client safe rather
 * than merely unlucky.
 *
 * `values` is returned by reference when nothing changed, so a caller holding
 * it in React state re-renders only when there is something new to look at.
 */
export function applyMappings(
  values: Record<string, SubmissionValue>,
  mappings: readonly SmartFillMapping[],
  fields: readonly FormField[],
): AppliedSmartFill {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const changes: SmartFillChange[] = [];
  const claimed = new Set<string>();

  for (const mapping of mappings) {
    // First mapping for a field wins, matching the API's own de-duplication:
    // two answers to one question is a contradiction, not something to merge.
    if (claimed.has(mapping.fieldId)) continue;

    const field = byId.get(mapping.fieldId);
    // Signature, file upload, section header and repeating group can't be
    // answered by speaking, so a mapping onto one is a model mistake however
    // confident it claims to be. Same set the mic is offered for.
    if (!field || !isDictatable(field.type)) continue;
    claimed.add(mapping.fieldId);

    const previous = values[mapping.fieldId] ?? null;
    // An unchanged value is not a change: highlighting it would send the
    // respondent to re-check a field nothing happened to.
    if (sameValue(previous, mapping.value)) continue;

    changes.push({ fieldId: mapping.fieldId, previous, next: mapping.value });
  }

  if (changes.length === 0) return { values, changes };

  const next = { ...values };
  for (const change of changes) next[change.fieldId] = change.next;
  return { values: next, changes };
}

/** Checkbox groups arrive as arrays, so identity alone would report every re-run as a change. */
function sameValue(a: SubmissionValue, b: SubmissionValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

export interface ConfidenceSplit {
  /** At or above the threshold — presented as a filled-in answer. */
  confident: SmartFillMapping[];
  /** Below it — flagged so the respondent confirms it before submitting. */
  uncertain: SmartFillMapping[];
}

/**
 * Split proposals into "shown as answered" and "shown as needs checking".
 *
 * A non-numeric confidence falls to `uncertain`: comparisons against NaN are
 * false, which is the safe direction here and is asserted in the tests so a
 * future refactor cannot quietly flip it.
 */
export function partitionByConfidence(mappings: readonly SmartFillMapping[]): ConfidenceSplit {
  const confident: SmartFillMapping[] = [];
  const uncertain: SmartFillMapping[] = [];
  for (const mapping of mappings) {
    if (mapping.confidence >= SMART_FILL_CONFIDENCE_THRESHOLD) confident.push(mapping);
    else uncertain.push(mapping);
  }
  return { confident, uncertain };
}

export interface SmartFillFailure {
  /** Retire the entry point for the rest of this page load. */
  hide: boolean;
  message: string;
}

/**
 * What a failed Smart Fill request means for the respondent.
 *
 * `hide` is for failures that will repeat: the org's plan does not include the
 * feature (403), or the server has no model configured (422). Both are fixed
 * for this page load, and an entry point that fails every press is worse than
 * none — which is also why the gate is a missing control rather than a
 * disabled one. Everything else is transient, so the mic stays.
 *
 * No copy here names a plan tier or offers an upgrade. The public door
 * deliberately withholds both because the respondent is not the plan holder,
 * and restating them client-side would put them straight back on the page.
 */
export function smartFillFailure(status: number): SmartFillFailure {
  switch (status) {
    case 403:
      return {
        hide: true,
        message: 'Fill by voice isn’t available on this form — answer the questions as usual.',
      };
    case 422:
      return {
        hide: true,
        message: 'Fill by voice isn’t switched on right now — answer the questions as usual.',
      };
    case 400:
      return {
        hide: false,
        message: 'That was a lot to take in at once — try again with a shorter description.',
      };
    default:
      return {
        hide: false,
        message: 'Your answers couldn’t be worked out just then. Try again, or type them in.',
      };
  }
}

/**
 * The line announced after a run.
 *
 * Always asks for a check and never says "done": Smart Fill cannot submit, and
 * copy implying the form is finished is exactly what stops people reading the
 * review step it deliberately leaves in their way.
 */
export function smartFillSummary(filled: number, uncertain: number): string {
  if (filled <= 0) {
    return 'Nothing matched a question on this form — answer them below as usual.';
  }
  const answers = `${filled} answer${filled === 1 ? '' : 's'}`;
  if (uncertain <= 0) return `Filled in ${answers}. Check them before you submit.`;
  return `Filled in ${answers} — ${uncertain} need${uncertain === 1 ? 's' : ''} checking before you submit.`;
}
