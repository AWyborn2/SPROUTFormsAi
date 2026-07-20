/**
 * Mobile fill helpers specific to the field-app forms list. The generic
 * form-input helpers (`inputFields`, `isAnswered`, `validateRequired`) now live
 * in `lib/validation.ts` — shared with the public fill screen; this module
 * keeps the published-form picker filter and the progress numerator. Kept free
 * of React so they're unit-testable.
 */
import { isFieldAnswered } from '@formai/shared';
import type { FormField, SubmissionValue } from '@formai/shared';
import type { FormSummary } from '../../lib/data/types.js';
import { inputFields } from '../../lib/validation.js';

/** Forms the field app offers for filling — published templates only. */
export function publishedForms(forms: FormSummary[]): FormSummary[] {
  return forms.filter((f) => f.status === 'published');
}

/**
 * How many input fields have an answer (progress numerator). Uses the shared
 * field-aware predicate so a seeded-but-untouched fixed-row checklist does
 * NOT count as answered — the progress bar stays honest.
 */
export function answeredCount(fields: FormField[], values: Record<string, SubmissionValue>): number {
  return inputFields(fields).filter((f) => isFieldAnswered(f, values[f.id])).length;
}
