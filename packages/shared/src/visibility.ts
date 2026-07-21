/**
 * Conditional visibility — ONE answer to "is this field visible right now",
 * shared by every surface that has to agree on it: the fill renderer, the
 * submission validator, the submission writer, and the PDF export. Four
 * consumers reimplementing this independently is four chances to disagree
 * about whether a required-but-hidden field blocks a submit.
 *
 * Two rules carry the module.
 *
 * 1. FAIL OPEN. A condition that cannot be evaluated honestly — the source
 *    field id isn't in the form, the source is a repeating group, the source is
 *    itself hidden — resolves to VISIBLE. This is compliance paperwork: a
 *    malformed template must over-collect rather than silently swallow required
 *    content. A section that shows when it shouldn't is a nuisance a reviewer
 *    can see and fix; a section that vanishes without trace is an incident
 *    nobody notices until an audit.
 *
 * 2. SECTION SCOPE RESOLVES HERE. A condition on a `section_header` governs
 *    every field from that header up to the next header (or the end of the
 *    form). `visibleFields` performs that expansion, so consumers only ever ask
 *    about individual fields and never reimplement section membership. This is
 *    what makes an 18-page multi-location assessment ONE authored condition
 *    instead of dozens.
 *
 * Sources are restricted to non-repeating fields (see `VisibilityCondition`),
 * so evaluation needs no row state. Combined with the no-cascade rule that also
 * means it cannot loop: a condition is decided by reading exactly one answer,
 * never by evaluating another condition.
 */

import type { FormField, VisibilityCondition } from './form-field.js';
import type { SubmissionValue } from './submission.js';

/**
 * A snapshot of the answers available at evaluation time. Deliberately partial
 * and tolerant of extra keys: the fill view holds a live draft, the validator
 * holds a posted body, and the exporter holds a stored submission — all three
 * are "field id -> value" and none of them is guaranteed complete.
 */
export type VisibilityAnswers = Record<string, SubmissionValue | undefined>;

/**
 * Field types whose answer cannot serve as a condition source. Repeating groups
 * carry an array of rows with no single scalar answer, so any comparison
 * against them is meaningless — and meaningless means visible, per rule 1.
 * `section_header` is listed for the same reason: it holds no answer at all.
 */
const NON_SCALAR_TYPES = new Set<FormField['type']>(['repeating_group', 'section_header']);

/**
 * Normalize an answer to the string a condition's `value` is compared against.
 * Returns undefined for "no answer", which is distinct from the empty string:
 * an unanswered source cannot equal a specific value, and a field conditioned
 * on that value stays hidden until the source is actually answered.
 *
 * Multi-select arrays deliberately do NOT participate — a checkbox group's
 * answer is a set, and "equals" over a set has more than one defensible
 * meaning. Returning undefined here would HIDE dependents, so arrays are
 * handled by the caller as unevaluatable (visible) instead.
 */
function scalarAnswer(value: SubmissionValue | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return undefined;
}

/** True when the answer is an array/row-list rather than a scalar. */
function isNonScalarAnswer(value: SubmissionValue | undefined): boolean {
  return Array.isArray(value);
}

/**
 * Evaluate a single condition against the form and the current answers.
 *
 * Every unevaluatable path returns true. The one case that returns false is the
 * fully-determined one: a real, non-repeating, currently-visible source field
 * whose scalar answer fails the comparison.
 */
function evaluate(
  condition: VisibilityCondition,
  fields: readonly FormField[],
  answers: VisibilityAnswers,
): boolean {
  const source = fields.find((x) => x.id === condition.fieldId);

  // Missing source: a dangling reference (deleted field, bad import). Visible.
  if (!source) return true;

  // Repeating group / header source: no single answer to compare. Visible.
  if (NON_SCALAR_TYPES.has(source.type)) return true;

  // Hidden source: conditions do NOT cascade. A dependent whose source the
  // filler cannot even see has no meaningful answer to key off, so it shows.
  // This is also the loop guard — we evaluate the source's OWN condition only,
  // never recursing further.
  if (source.visibleWhen && !evaluateSelf(source, fields, answers)) return true;

  // ...and so is a source hidden by its ENCLOSING SECTION. Section scope is the
  // main way authors hide things, so exempting it left the fail-open guarantee
  // not holding for the common case: a source the filler never saw was still
  // treated as authoritative. That also made `stripHiddenValues` non-idempotent
  // — a dependent kept because of an answer discarded in the same pass — so the
  // stored record and the exported PDF could disagree.
  if (isSectionHidden(source, fields, answers)) return true;

  const raw = answers[condition.fieldId];
  if (isNonScalarAnswer(raw)) return true;

  const answer = scalarAnswer(raw);

  // notEquals is the strict inverse of equals, including when the source is
  // unanswered: "not yes" is true of a blank. That direction fails open, which
  // is the side of the line this module lives on.
  const matches = answer !== undefined && answer === condition.value;
  return condition.op === 'notEquals' ? !matches : matches;
}

/**
 * One level of condition evaluation with no further chaining — used to decide
 * whether a *source* field is visible. Deliberately shallow: see the no-cascade
 * comment above.
 */
function evaluateSelf(
  field: FormField,
  fields: readonly FormField[],
  answers: VisibilityAnswers,
): boolean {
  const condition = field.visibleWhen;
  if (!condition) return true;

  const source = fields.find((x) => x.id === condition.fieldId);
  if (!source || NON_SCALAR_TYPES.has(source.type)) return true;

  const raw = answers[condition.fieldId];
  if (isNonScalarAnswer(raw)) return true;

  const answer = scalarAnswer(raw);
  const matches = answer !== undefined && answer === condition.value;
  return condition.op === 'notEquals' ? !matches : matches;
}

/**
 * Is this field visible on its OWN condition?
 *
 * Section membership is NOT considered here — a field inside a hidden section
 * can still answer true. Use `visibleFields` when you need the effective
 * answer for a whole form; use this when you already know the section state (or
 * the field is a `section_header`, where own-condition IS the section's state).
 */
export function isFieldVisible(
  field: FormField,
  fields: readonly FormField[],
  answers: VisibilityAnswers,
): boolean {
  if (!field.visibleWhen) return true;
  return evaluate(field.visibleWhen, fields, answers);
}

/**
 * The visible subset of a field list, in authored order, with section scope
 * expanded.
 *
 * Walking the list once is what makes section scope cheap and unambiguous: a
 * `section_header` opens a scope that runs until the next header, so two
 * consecutive headers produce an EMPTY section rather than the first header
 * swallowing the second one's fields. A hidden header hides itself and its
 * scope; fields after the next header are untouched.
 */
/**
 * Whether `field` sits inside a section whose header is hidden.
 *
 * Walks back to the governing `section_header` and tests only that header's own
 * condition — never recursing, which keeps this a loop-free single level like
 * the own-condition check above.
 */
function isSectionHidden(
  field: FormField,
  fields: readonly FormField[],
  answers: VisibilityAnswers,
): boolean {
  const index = fields.findIndex((f) => f.id === field.id);
  if (index < 0) return false;

  for (let i = index - 1; i >= 0; i--) {
    const candidate = fields[i]!;
    if (candidate.type !== 'section_header') continue;
    // The nearest preceding header governs; anything before it is a closed scope.
    return !!candidate.visibleWhen && !evaluateSelf(candidate, fields, answers);
  }
  return false;
}

export function visibleFields(
  fields: readonly FormField[],
  answers: VisibilityAnswers,
): FormField[] {
  const out: FormField[] = [];
  let sectionHidden = false;

  for (const field of fields) {
    if (field.type === 'section_header') {
      // A header always opens a fresh scope, closing whatever preceded it.
      sectionHidden = !isFieldVisible(field, fields, answers);
      if (!sectionHidden) out.push(field);
      continue;
    }

    // Section scope wins over the field's own condition: content the author
    // scoped away is gone regardless of what its individual rule says.
    if (sectionHidden) continue;
    if (isFieldVisible(field, fields, answers)) out.push(field);
  }

  return out;
}
