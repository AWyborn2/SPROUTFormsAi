/**
 * Shared form-validation helpers used by the public fill screen, the mobile
 * field app, and the invite dialog. Kept free of React so they're
 * unit-testable.
 */
import type { FormField, SubmissionValue } from '@formai/shared';

/** Loose email shape check shared by the invite dialog and public fill screen. */
export const EMAIL_RE = /.+@.+\..+/;

/** Fields that actually take input (section headers are display-only). */
export function inputFields(fields: FormField[]): FormField[] {
  return fields.filter((f) => f.type !== 'section_header');
}

/** Whether a value counts as answered — drives the progress bar and required check. */
export function isAnswered(value: SubmissionValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true; // number | boolean
}

/** Error map for unanswered required fields; empty means submittable. */
export function validateRequired(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of inputFields(fields)) {
    if (f.required && !isAnswered(values[f.id])) errors[f.id] = 'This field is required';
  }
  return errors;
}
