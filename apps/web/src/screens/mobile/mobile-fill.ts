/**
 * Mobile fill helpers specific to the field-app forms list. The generic
 * form-input helpers (`inputFields`, `isAnswered`, `validateRequired`) now live
 * in `lib/validation.ts` — shared with the public fill screen; this module
 * keeps the published-form picker filter and the progress numerator. Kept free
 * of React so they're unit-testable.
 */
import type { FormField, SubmissionValue } from '@formai/shared';
import type { FormSummary } from '../../lib/data/types.js';
import { inputFields, isAnswered } from '../../lib/validation.js';

/** Forms the field app offers for filling — published templates only. */
export function publishedForms(forms: FormSummary[]): FormSummary[] {
  return forms.filter((f) => f.status === 'published');
}

/** How many input fields have an answer (progress numerator). */
export function answeredCount(fields: FormField[], values: Record<string, SubmissionValue>): number {
  return inputFields(fields).filter((f) => isAnswered(values[f.id])).length;
}
