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
export function isBlank(value: SubmissionValue | null | undefined): boolean {
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

// The assessor's own name box, by caption. Same intent as the builder's
// cover-page ASSESSOR_NAME (builder-manifest.ts) — deliberately narrow, so a
// plain candidate "Name" box is never mistaken for it.
const ASSESSOR_NAME_LABEL = /name\s+of\s+assessor|assessor'?s?\s+name/i;
// A date box, by type or by an unambiguous "date" caption. Kept off "date of
// birth" and the like by anchoring on a bare or "signed" date word.
const DATE_LABEL = /^date$|sign(?:ed)?\s*date|date\s+signed|date\s+of\s+assessment/i;

function isDateField(f: FormField): boolean {
  return f.type === 'date' || DATE_LABEL.test(f.label.trim());
}

/** The fields (id + label) an assessor sign-off block auto-fills, or null each. */
export interface AssessorSignoffTargets {
  nameFieldId: string | null;
  dateFieldId: string | null;
}

/**
 * The assessor's name and date boxes within a part, for prefilling when the
 * assessor opens it to mark — their name from the account, today's date — so
 * neither is transcribed by hand.
 *
 * Scoped to the fields it is GIVEN, which is one part's fields: the paper
 * reprints the same sign-off block under every part, so a whole-document search
 * would find several and could not say which is this one's. Within one part
 * there is at most one, so "exactly one, or nothing" is safe — the same rule the
 * builder's `proposeSignOff` follows. The date is the single date box in the
 * assessor-name's own section (between the headers that bound it), so a
 * candidate's date in a neighbouring block is never picked.
 */
export function assessorSignoffTargets(fields: readonly FormField[]): AssessorSignoffTargets {
  const named = fields.filter(
    (f) => f.type !== 'section_header' && ASSESSOR_NAME_LABEL.test(f.label),
  );
  // Two "assessor name" boxes in one part means the captions cannot say which is
  // meant; filling either is a guess, so fill neither.
  const nameField = named.length === 1 ? named[0]! : null;
  if (!nameField) return { nameFieldId: null, dateFieldId: null };

  const at = fields.findIndex((f) => f.id === nameField.id);
  // The block the name sits in — from the header before it to the header after.
  let start = 0;
  for (let j = at - 1; j >= 0; j--) {
    if (fields[j]!.type === 'section_header') {
      start = j + 1;
      break;
    }
  }
  let end = fields.length;
  for (let j = at + 1; j < fields.length; j++) {
    if (fields[j]!.type === 'section_header') {
      end = j;
      break;
    }
  }
  const dates = fields.slice(start, end).filter(isDateField);
  const dateFieldId = dates.length === 1 ? dates[0]!.id : null;
  return { nameFieldId: nameField.id, dateFieldId };
}

/**
 * The values after prefilling an assessor sign-off block — the caller's name and
 * today's date — over `values`, or `values` unchanged when there is nothing to
 * fill.
 *
 * Fills a box only where it is the caller's to fill (`writable`) and still blank,
 * so it never touches the candidate's own record and never clobbers a value the
 * assessor has since edited. Returns the SAME reference when nothing changes, so
 * a React caller can skip the state update.
 */
export function applyAssessorSignoff(
  fields: readonly FormField[],
  writable: ReadonlySet<string>,
  values: Record<string, SubmissionValue>,
  assessorName: string,
  today: string,
): Record<string, SubmissionValue> {
  const { nameFieldId, dateFieldId } = assessorSignoffTargets(fields);
  let next = values;
  const fill = (id: string | null, value: string) => {
    if (id && value && writable.has(id) && isBlank(next[id])) {
      if (next === values) next = { ...values };
      next[id] = value;
    }
  };
  fill(nameFieldId, assessorName);
  fill(dateFieldId, today);
  return next;
}
