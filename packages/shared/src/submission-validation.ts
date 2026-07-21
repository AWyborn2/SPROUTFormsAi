/**
 * Submission completeness — the ONE implementation of "is this answered?"
 * shared by web validation, the mobile progress counter, and both API submit
 * routes, so client and server can never drift (KTD2).
 *
 * Pure and React-free. Tested from apps/api (packages/shared has no test
 * runner): see apps/api/src/routes/submission-validation.test.ts.
 */
import { resolveAnswerSets, selectedOption } from './answer-set.js';
import type { FormField, FormFieldType, RepeatingColumn } from './form-field.js';
import type { RepeatingRowValue, SubmissionValue } from './submission.js';

/**
 * Typed scalar answered-ness (KTD2):
 *  - text (and anything string-valued): non-whitespace;
 *  - number: any number — 0 counts;
 *  - checkbox: explicitly `true` only (an unchecked box is not an answer);
 *  - boolean_yes_no: explicit `true` OR `false` — a seeded/untouched `null`
 *    is unanswered, so an honest "No" is recordable;
 *  - everything else: defined and non-empty.
 */
function scalarAnswered(type: FormFieldType, value: string | number | boolean | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'boolean') return type === 'checkbox' ? value === true : true;
  return true; // number — 0 counts
}

/** Whether a single repeating-group cell counts as answered, per its column type. */
export function isCellAnswered(
  column: RepeatingColumn,
  cell: string | number | boolean | null | undefined,
): boolean {
  return scalarAnswered(column.type, cell);
}

function isRowRecord(row: unknown): row is RepeatingRowValue {
  return typeof row === 'object' && row !== null && !Array.isArray(row);
}

/**
 * Key of the read-only label column of a repeating table — `columns[0]` is the
 * label column by contract (KTD1). Undefined when the field has no columns.
 */
export function labelColumnKey(field: FormField): string | undefined {
  return field.columns?.[0]?.key;
}

/**
 * The columns a filler can actually answer: everything AFTER the label column
 * (KTD1). Empty for label-only or column-less fields.
 */
export function answerColumns(field: FormField): RepeatingColumn[] {
  return (field.columns ?? []).slice(1);
}

/**
 * Incomplete fixed-row indices of a fixed-item checklist table (R6): index i
 * (i < fixedRows.length) is incomplete unless row i exists and has at least
 * one NON-LABEL cell answered — `columns[0]` is the read-only label column
 * (KTD1), so answers typed there don't count. A value array shorter than
 * `fixedRows` reports the missing tail as incomplete. Ad-hoc rows appended
 * after the fixed set are exempt. Empty for fields without `fixedRows`.
 */
export function incompleteFixedRowIndices(
  field: FormField,
  value: SubmissionValue | undefined,
): number[] {
  const fixedRows = field.fixedRows;
  if (!fixedRows || fixedRows.length === 0) return [];
  // Non-label columns are what a filler can actually answer; a degenerate
  // label-only table has nothing answerable, so nothing can be incomplete.
  const answerable = answerColumns(field);
  if (answerable.length === 0) return [];

  const rows: unknown[] = Array.isArray(value) ? value : [];
  const incomplete: number[] = [];
  for (let i = 0; i < fixedRows.length; i++) {
    if (!isRowAnswered(field, rows[i])) incomplete.push(i);
  }
  return incomplete;
}

/**
 * Whether one repeating row counts as answered.
 *
 * Grouping changes the question. On an UNGROUPED table it stays the legacy
 * rule — any non-label cell carrying something — so existing published
 * versions never change behaviour. On a table with answer sets the row must
 * carry exactly one chosen option per set: neither zero (unanswered) nor two
 * (the contradiction the grouping exists to prevent, which the legacy rule
 * would happily accept).
 *
 * A malformed set is dropped by `resolveAnswerSets`, so a bad grouping falls
 * back to the legacy rule rather than making the table unanswerable.
 */
function isRowAnswered(field: FormField, row: unknown): boolean {
  if (!isRowRecord(row)) return false;

  const sets = resolveAnswerSets(field).sets;
  if (sets.length > 0) {
    return sets.every((s) => {
      const sel = selectedOption(s, row);
      return sel.columnKey !== null && !sel.malformed;
    });
  }

  return answerColumns(field).some((c) => isCellAnswered(c, row[c.key]));
}

/**
 * Per-field answered-ness predicate — drives the progress numerator and the
 * required check on every surface. Section headers take no input and are
 * always "answered". A fixed-row table is answered only when EVERY fixed row
 * is (see `incompleteFixedRowIndices`); tables without `fixedRows` keep the
 * legacy any-row rule so existing published versions never change behavior
 * (R3/AE4).
 */
export function isFieldAnswered(field: FormField, value: SubmissionValue | undefined): boolean {
  if (field.type === 'section_header') return true;
  if (field.type === 'repeating_group' && field.fixedRows && field.fixedRows.length > 0) {
    return incompleteFixedRowIndices(field, value).length === 0;
  }
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    // An open row-entry table backed by answer sets still cannot record a
    // contradictory or blank row — the any-row rule would accept both.
    if (field.type === 'repeating_group' && resolveAnswerSets(field).sets.length > 0) {
      return value.length > 0 && value.every((row) => isRowAnswered(field, row));
    }
    return value.length > 0;
  }
  return scalarAnswered(field.type, value);
}

/**
 * Rows of a required table the given value leaves unanswered, keyed by field
 * id — the per-row detail behind R10. `missingRequiredFields` reports WHICH
 * fields failed; this reports WHERE inside them, so a filler who missed rows 7
 * and 14 of a forty-row table is told exactly that instead of re-scanning the
 * whole table on a phone.
 */
export function incompleteRowsByField(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const f of fields) {
    if (f.type !== 'repeating_group' || !f.required) continue;
    const incomplete = incompleteFixedRowIndices(f, values[f.id]);
    if (incomplete.length > 0) out[f.id] = incomplete;
  }
  return out;
}

/**
 * Ids of required fields the given values leave unanswered, in field order.
 * Empty means the submission is complete enough to finalize. This is the
 * server's enforcement input (KTD4's `fields` payload) and the client's
 * per-field error source.
 */
export function missingRequiredFields(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
): string[] {
  return fields
    .filter((f) => f.type !== 'section_header' && f.required && !isFieldAnswered(f, values[f.id]))
    .map((f) => f.id);
}
