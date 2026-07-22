/**
 * Submission completeness — the ONE implementation of "is this answered?"
 * shared by web validation, the mobile progress counter, and both API submit
 * routes, so client and server can never drift (KTD2).
 *
 * Pure and React-free. Tested from apps/api (packages/shared has no test
 * runner): see apps/api/src/routes/submission-validation.test.ts.
 */
import { groupedColumnKeys, resolveAnswerSets, selectedOption } from './answer-set.js';
import { visibleFields } from './visibility.js';
import type { FormField, FormFieldType, RepeatingColumn } from './form-field.js';
import type { RepeatingRowValue, SubmissionValue } from './submission.js';

/**
 * Typed scalar answered-ness (KTD2):
 *  - text (and anything string-valued): non-whitespace;
 *  - number: any number — 0 counts;
 *  - checkbox: explicitly `true` only (an unchecked box is not an answer);
 *  - boolean_yes_no / check_cross: explicit `true` OR `false` — a
 *    seeded/untouched `null` is unanswered, so an honest "No" (or a cross) is
 *    recordable. This is what keeps "assessed as failing" distinct from "never
 *    assessed", which for an audit record is the distinction that matters;
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
    // A contradictory row is refused whatever the set's required flag says:
    // one-answer-per-row is the grouping's structural invariant, not a
    // required-ness question. `required: false` only relaxes "must be
    // answered" — it never licenses recording both OK and N/A.
    if (sets.some((s) => selectedOption(s, row).malformed)) return false;
    if (!requiredColumnsFilled(field, row)) return false;
    if (
      !sets
        .filter((s) => s.required !== false)
        .every((s) => selectedOption(s, row).columnKey !== null)
    ) {
      return false;
    }
    // The legacy floor still applies. Without it, a table whose every set is
    // `required: false` filtered down to an empty list, `every` over which is
    // vacuously true — so a completely blank row reported as answered and a
    // required ten-item checklist passed with nothing ticked. Grouping columns
    // must never WEAKEN a table.
  }

  if (!requiredColumnsFilled(field, row)) return false;
  return rowEngaged(field, row);
}

/**
 * Has the filler put anything in this row at all?
 *
 * The legacy any-cell rule, named because it now means something specific: a
 * row nobody touched is not an incomplete answer, it is an absent one. Used as
 * the floor under every table shape, and to decide which rows of an OPTIONAL
 * table are worth validating.
 */
function rowEngaged(field: FormField, row: RepeatingRowValue): boolean {
  return answerColumns(field).some((c) => isCellAnswered(c, row[c.key]));
}

/**
 * Every column the author marked required must be answered on this row.
 *
 * `@formai/ui` renders a red asterisk from `RepeatingColumn.required` and the
 * column inspector offers the toggle, but nothing read the flag — so a reviewer
 * could mark "Corrective action" required, the filler would see it marked
 * mandatory, tick Fail, leave every comment blank, and submit with no errors.
 * An investigation would then show a mandatory column that is entirely empty
 * on a form the system reported complete. A required marker nothing enforces is
 * worse than no marker.
 *
 * Grouped member columns are exempt: their required-ness is the answer set's
 * (exactly one option per row), and requiring each member individually would
 * demand every option be ticked at once — the contradiction the set prevents.
 */
function requiredColumnsFilled(field: FormField, row: RepeatingRowValue): boolean {
  const grouped = groupedColumnKeys(field);
  return answerColumns(field)
    .filter((c) => c.required && !grouped.has(c.key))
    .every((c) => isCellAnswered(c, row[c.key]));
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
    /*
      Every open row-entry table is validated row by row, grouped or not.

      It used to short-circuit here on `value.length > 0` unless the table had
      answer sets, which meant a table's REQUIRED COLUMNS were enforced on the
      fixed-row and grouped shapes and silently ignored on the third — a
      `Defects` table with a required `comment` accepted one wholly blank row.
      The author marked a column mandatory, the filler saw the asterisk, and
      nothing checked it.

      Safe to tighten because an open table has no phantom rows: `minRows`
      defaults to 0 and `seedFixedRows` returns [] without `fixedRows`, so a row
      exists only because the filler added it. A blank one is reported by
      `openRowIndices`, which highlights exactly which row to fix or remove.
    */
    if (field.type === 'repeating_group') {
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
/**
 * Unanswered row indexes of an OPEN (no `fixedRows`) table backed by an answer
 * set. Without this the filler gets "this table is incomplete" with no row
 * highlighted — the R10 gap left open for one of the two table shapes, since
 * `incompleteFixedRowIndices` returns [] the moment `fixedRows` is absent.
 */
function openRowIndices(field: FormField, value: SubmissionValue | undefined): number[] {
  // No longer gated on the table having answer sets. `isFieldAnswered` now
  // validates every open table row by row, so gating here would report "this
  // table is incomplete" with no row highlighted — the exact R10 gap this
  // function exists to close, reopened for the ungrouped shape.
  const rows: unknown[] = Array.isArray(value) ? value : [];
  const out: number[] = [];
  rows.forEach((row, i) => {
    if (!isRowAnswered(field, row)) out.push(i);
  });
  return out;
}

/**
 * Rows of an OPTIONAL table that the filler started and left invalid.
 *
 * `AnswerSet.required` is documented as independent of the field's own
 * `required`, but both entry points filtered on `f.required` before any
 * row-level work ran — so an author who marked a set required on an optional
 * table set a flag that did nothing at all, with no indication of it.
 *
 * "Optional" means you need not fill the table. It does not mean a row you DID
 * fill may be left half-answered. So only rows the filler engaged with are
 * judged: an untouched optional table still reports nothing, and can never
 * block a submit.
 */
function engagedInvalidRowIndices(field: FormField, value: SubmissionValue | undefined): number[] {
  if (field.type !== 'repeating_group') return [];
  const sets = resolveAnswerSets(field).sets;
  if (!sets.some((s) => s.required !== false)) return [];

  const rows: unknown[] = Array.isArray(value) ? value : [];
  const fixedCount = field.fixedRows?.length ?? 0;
  const out: number[] = [];
  rows.forEach((row, i) => {
    if (!isRowRecord(row)) return;
    // A pre-printed fixed row is "engaged" the moment it exists, since the
    // filler did not create it — judging those would make an optional
    // checklist mandatory by the back door.
    if (i < fixedCount) return;
    if (!rowEngaged(field, row)) return;
    if (!isRowAnswered(field, row)) out.push(i);
  });
  return out;
}

export function incompleteRowsByField(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  // Hidden tables cannot be incomplete — the filler was never shown them (U11).
  for (const f of visibleFields(fields, values)) {
    if (f.type !== 'repeating_group') continue;
    const incomplete = !f.required
      ? engagedInvalidRowIndices(f, values[f.id])
      : f.fixedRows && f.fixedRows.length > 0
        ? incompleteFixedRowIndices(f, values[f.id])
        : openRowIndices(f, values[f.id]);
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
  // Required-ness is scoped to what the filler can actually SEE (U11): a
  // hidden required field has no answer to give and must never block a submit,
  // or a conditional section becomes an unclearable wall. `visibleFields`
  // expands section-header conditions across their scope, so this agrees with
  // the fill renderer field-for-field.
  return visibleFields(fields, values)
    .filter((f) => {
      if (f.type === 'section_header') return false;
      if (f.required) return !isFieldAnswered(f, values[f.id]);
      // An OPTIONAL table still cannot record a half-answered row when the
      // author marked one of its answer sets required — see
      // `engagedInvalidRowIndices`. An untouched table reports nothing here.
      return engagedInvalidRowIndices(f, values[f.id]).length > 0;
    })
    .map((f) => f.id);
}

/**
 * Drop the values of fields that are not visible under `values` itself, and
 * name what was dropped.
 *
 * The guarantee U11 exists for is that a hidden field is UNRECORDED — not
 * merely unrendered. A client can post whatever it likes (the public fill
 * route's only credential is a link token), and a draft saved while a section
 * was visible carries stale answers after the source answer changes. Both
 * cases resolve here, on the server, before the insert.
 *
 * Ids with no matching field are left alone: this decides on visibility, not
 * on schema membership, and silently eating unknown keys would hide a
 * different class of bug. `discarded` names only fields that actually carried
 * a value, so an audit trace of `[]` means "nothing was thrown away" rather
 * than "nothing was hidden".
 */
export function stripHiddenValues(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
): { values: Record<string, SubmissionValue>; discarded: string[] } {
  // Iterate to a fixpoint. One pass is not enough with chained conditions: a
  // dependent can be kept because its source was still present in `values`,
  // while that same pass discards the source. Every later evaluation — the
  // exporter, the submission render, an approval-time re-strip — then sees the
  // source gone and treats the dependent as hidden, so the stored record and
  // the exported evidence PDF disagree about what was answered. Re-running
  // until nothing new drops makes the recorded values self-consistent under the
  // same evaluator every consumer uses.
  let kept = values;
  const discarded: string[] = [];

  // Bounded by the field count: each round must discard at least one field to
  // continue, so it cannot exceed the number of fields.
  for (let round = 0; round <= fields.length; round++) {
    const visibleIds = new Set(visibleFields(fields, kept).map((f) => f.id));
    const dropped = fields.filter((f) => !visibleIds.has(f.id) && f.id in kept).map((f) => f.id);
    if (dropped.length === 0) break;

    const next: Record<string, SubmissionValue> = {};
    for (const [key, value] of Object.entries(kept)) {
      if (!dropped.includes(key)) next[key] = value;
    }
    kept = next;
    discarded.push(...dropped);
  }

  return { values: kept, discarded };
}
