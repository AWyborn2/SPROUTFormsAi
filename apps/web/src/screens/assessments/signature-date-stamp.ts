/**
 * Signing a sign-off stamps the date it was signed on.
 *
 * A paper sign-off is a signature next to a date, and on paper the two happen in
 * one motion — you sign, and you write today's date. On the webform the date is
 * the value the app already knows, so making the signer type it is a step that
 * only ever reproduces today. This pairs a signature with the date field beside
 * it so drawing the signature fills that date.
 *
 * Deliberately NOT the assessor's alone: the same shape serves a candidate
 * signing their own declaration, a subject-matter expert, or a supervisor who
 * signs the logbook at end of shift — whoever the workflow lets sign the part.
 * The rule is about the sign-off SHAPE, not who fills it.
 */
import type { FormField, SubmissionValue } from '@formai/shared';

/** Blank = nothing a person entered: undefined, null, or an empty/space string. */
function isBlank(value: SubmissionValue | null | undefined): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * The date field a signature should stamp when signed, or null.
 *
 * The sign-off block shape: a signature, then the date it was signed on. Walking
 * forward from the signature, the first `date` field before the next signature
 * or section header is its companion — so "Signature / Date" and "Signature /
 * Name / Date" both pair, while a date sitting under a LATER signature belongs
 * to that one instead. Stopping at a section header keeps one part's sign-off
 * from reaching across into the next.
 */
export function companionDateField(
  fields: readonly FormField[],
  signatureFieldId: string,
): string | null {
  const at = fields.findIndex((f) => f.id === signatureFieldId);
  if (at < 0 || fields[at]!.type !== 'signature') return null;
  for (let j = at + 1; j < fields.length; j++) {
    const f = fields[j]!;
    if (f.type === 'section_header' || f.type === 'signature') return null;
    if (f.type === 'date') return f.id;
  }
  return null;
}

/**
 * The date field to stamp with today after `changedFieldId` was set, or null.
 *
 * Fires only on the transition that means "just signed" — a signature going
 * from blank to filled — and only while its companion date is still blank, so a
 * corrected or re-drawn signature never overwrites a date already recorded. Any
 * change that is not a fresh signature returns null and nothing is stamped.
 */
export function dateFieldToStamp(
  fields: readonly FormField[],
  values: Record<string, SubmissionValue>,
  changedFieldId: string,
  newValue: SubmissionValue,
): string | null {
  const changed = fields.find((f) => f.id === changedFieldId);
  if (!changed || changed.type !== 'signature') return null;
  // Blank → filled only: re-drawing an existing signature must not re-stamp.
  if (isBlank(newValue) || !isBlank(values[changedFieldId])) return null;
  const dateId = companionDateField(fields, changedFieldId);
  if (!dateId || !isBlank(values[dateId])) return null;
  return dateId;
}
