/**
 * Shared form-validation helpers used by the public fill screen, the mobile
 * field app, and the invite dialog. Kept free of React so they're
 * unit-testable. The completeness rule itself lives in @formai/shared
 * (`missingRequiredFields` / `isFieldAnswered`) so client and server enforce
 * the exact same contract — this module maps it into UI error state.
 */
import { missingRequiredFields } from '@formai/shared';
import type { FormField, SubmissionValue } from '@formai/shared';

/** Loose email shape check shared by the invite dialog and public fill screen. */
export const EMAIL_RE = /.+@.+\..+/;

/** The one per-field required message, client-side and server-mapped alike. */
const REQUIRED_MESSAGE = 'This field is required';

/** Fields that actually take input (section headers are display-only). */
export function inputFields(fields: FormField[]): FormField[] {
  return fields.filter((f) => f.type !== 'section_header');
}

/** Error map for unanswered required fields; empty means submittable. */
export function validateRequired(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
): Record<string, string> {
  return requiredFieldErrors(missingRequiredFields(fields, values));
}

/** Per-field error map from a list of missing-required field ids. */
export function requiredFieldErrors(ids: string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const id of ids) errors[id] = REQUIRED_MESSAGE;
  return errors;
}

/**
 * Field ids from a server `400 {error:'required_fields_missing', fields:[…]}`
 * body (KTD4), or null when the body is some other error shape. Fill surfaces
 * feed the ids into their per-field `errors` state instead of a generic toast.
 */
export function requiredFieldsMissingIds(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { error, fields } = body as { error?: unknown; fields?: unknown };
  if (error !== 'required_fields_missing' || !Array.isArray(fields)) return null;
  return fields.filter((f): f is string => typeof f === 'string');
}

/**
 * Per-field incomplete row indices from a `required_fields_missing` 400 body.
 *
 * The server names WHICH fields failed in `fields`; this reads the additive
 * `incompleteRows` detail saying WHERE inside them. Without it a filler who
 * missed rows 7 and 14 of a forty-row table is told only that the table is
 * incomplete and has to re-scan it by eye, outdoors, on a phone — which is the
 * gap R10 exists to close. Absent on older responses and on scalar-only
 * failures, so callers must tolerate `{}`.
 */
export function incompleteRowsByFieldFrom(body: unknown): Record<string, number[]> {
  if (typeof body !== 'object' || body === null) return {};
  const { error, incompleteRows } = body as { error?: unknown; incompleteRows?: unknown };
  if (error !== 'required_fields_missing') return {};
  if (typeof incompleteRows !== 'object' || incompleteRows === null) return {};

  const out: Record<string, number[]> = {};
  for (const [fieldId, rows] of Object.entries(incompleteRows as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    const indexes = rows.filter((r): r is number => typeof r === 'number' && Number.isInteger(r) && r >= 0);
    if (indexes.length > 0) out[fieldId] = indexes;
  }
  return out;
}
