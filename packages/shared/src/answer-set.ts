/**
 * Answer sets — a group of repeating-table columns that share ONE answer per
 * row. The house shape of real compliance paperwork: `OK`/`NA` on a pre-start,
 * `✓`/`×`/`N-A` on a competency assessment. Extraction reads those columns as
 * independent checkboxes, which lets a filler tick both or neither on a row the
 * form declares required; grouping them makes exactly one answer expressible.
 *
 * The grouping is a layer OVER the existing column list, not a replacement for
 * it (KTD1): `columns` keeps its definitions, and a row value keeps its
 * `Record<columnKey, primitive>` shape (KTD4). Answering writes the chosen
 * column's key truthy and its siblings null, so existing submissions, the wire
 * schemas, and the read-only submission render all keep working untouched.
 *
 * Every resolver here is total — malformed input resolves to "ungrouped"
 * rather than throwing. A bad answer set must degrade a table to independent
 * checkboxes (which the reviewer can then regroup), never break a fill view a
 * crew is standing in front of.
 */

import type { AnswerSet, FormField, RepeatingColumn } from './form-field.js';
import type { RepeatingRowValue } from './submission.js';

/** Why a proposed answer set was rejected. Surfaced in review, never thrown. */
export type AnswerSetDropReason =
  | 'too-few-columns'
  | 'unknown-column'
  | 'label-column'
  | 'duplicate-membership'
  | 'self-answering-column'
  | 'non-tickable-column';

export interface DroppedAnswerSet {
  key: string;
  reason: AnswerSetDropReason;
}

/**
 * Column types whose cell can carry a set's tick.
 *
 * A set is answered by ticking exactly one member, and `isChosen` recognises a
 * tick as `true` / `'true'` / `1`. Nothing previously constrained membership to
 * types that can HOLD such a value, so a Pass/Fail/NA table whose columns the
 * model typed `text` was accepted, and then no input could ever answer it: the
 * filler types `✓`, `isChosen` says false, the row reports unanswered, and a
 * required table returns 400 on every submit — including on the unauthenticated
 * fill link — with no way to clear it.
 *
 * Constraining membership here rather than widening `isChosen` is what keeps
 * extraction, authoring, fill, validation and export agreeing on one definition
 * of "answered". A mistyped column now simply fails to group, which is visible
 * and correctable in review.
 */
const TICKABLE_TYPES: ReadonlySet<string> = new Set(['checkbox', 'boolean_yes_no']);

/**
 * Types excluded for a DIFFERENT reason than "cannot hold a tick", reported
 * separately so review can say which problem it is.
 *
 * A `check_cross` cell can hold a boolean, but it already records its own
 * true/false. In a set, a member's falsity means "this option was not chosen"
 * and the set decides the row; a crossed member would assert two contradictory
 * things at once, and `selectedOption` would silently discard one.
 */
const SELF_ANSWERING_TYPES: ReadonlySet<string> = new Set(['check_cross']);

/** A column's declared type, or '' when the key names no column. */
function columnTypeOf(columns: readonly RepeatingColumn[], key: string): string {
  return columns.find((c) => c.key === key)?.type ?? '';
}

export interface AnswerSetResolution {
  /** Sets that survived validation, in declaration order. */
  sets: AnswerSet[];
  /** Sets rejected, with the reason. */
  dropped: DroppedAnswerSet[];
}

/**
 * The label column of a repeating table is always the first one — the
 * pre-printed item text ("Engine oil level"). It is never answerable, so it can
 * never join an answer set. Mirrors `labelColumnKey` in submission-validation.
 */
export function labelColumnKeyOf(columns: RepeatingColumn[] | undefined): string | undefined {
  return columns?.[0]?.key;
}

/**
 * Validate a field's answer sets against its columns.
 *
 * A set is dropped when it spans fewer than two columns (a "group" of one is
 * just a checkbox), names a column the table does not have, includes the label
 * column, or claims a column an earlier set already claimed. Overlapping
 * membership is rejected rather than resolved first-wins: a column owned by two
 * sets has no coherent answer, and silently picking one would make the fill
 * view and the validator disagree about the same cell.
 */
export function resolveAnswerSets(field: Pick<FormField, 'columns' | 'answerSets'>): AnswerSetResolution {
  const sets: AnswerSet[] = [];
  const dropped: DroppedAnswerSet[] = [];

  const columns = field.columns ?? [];
  if (!field.answerSets?.length || columns.length === 0) return { sets, dropped };

  const known = new Set(columns.map((c) => c.key));
  const labelKey = labelColumnKeyOf(columns);
  const claimed = new Set<string>();

  for (const set of field.answerSets) {
    const keys = set.columnKeys ?? [];
    const drop = (reason: AnswerSetDropReason) => dropped.push({ key: set.key, reason });

    // Duplicates first: ['ok','ok'] would otherwise pass the length check,
    // then make `selectedOption` report two chosen members on every row, so
    // the row can never be answered and a required table becomes an
    // unclearable submit wall with no visible cause.
    if (new Set(keys).size !== keys.length) {
      drop('duplicate-membership');
      continue;
    }
    if (keys.length < 2) {
      drop('too-few-columns');
      continue;
    }
    if (keys.some((k) => !known.has(k))) {
      drop('unknown-column');
      continue;
    }
    if (labelKey !== undefined && keys.includes(labelKey)) {
      drop('label-column');
      continue;
    }
    if (keys.some((k) => claimed.has(k))) {
      drop('duplicate-membership');
      continue;
    }
    // Every member must be able to CARRY the set's tick (see TICKABLE_TYPES).
    // Reported as two reasons because they are two different mistakes: a
    // mistyped column the reviewer should retype, versus a column that already
    // answers itself and should never have been grouped.
    const badKey = keys.find((k) => !TICKABLE_TYPES.has(columnTypeOf(columns, k)));
    if (badKey !== undefined) {
      drop(
        SELF_ANSWERING_TYPES.has(columnTypeOf(columns, badKey))
          ? 'self-answering-column'
          : 'non-tickable-column',
      );
      continue;
    }

    for (const k of keys) claimed.add(k);
    sets.push(set);
  }

  return { sets, dropped };
}

/** The valid answer set owning `columnKey`, or undefined when it is ungrouped. */
export function answerSetForColumn(
  field: Pick<FormField, 'columns' | 'answerSets'>,
  columnKey: string,
): AnswerSet | undefined {
  return resolveAnswerSets(field).sets.find((s) => s.columnKeys.includes(columnKey));
}

/** Column keys belonging to any valid answer set on this field. */
export function groupedColumnKeys(field: Pick<FormField, 'columns' | 'answerSets'>): Set<string> {
  const keys = new Set<string>();
  for (const set of resolveAnswerSets(field).sets) {
    for (const k of set.columnKeys) keys.add(k);
  }
  return keys;
}

export interface SelectedOption {
  /** The chosen column's key, or null when the row is unanswered. */
  columnKey: string | null;
  /**
   * True when more than one member column is truthy — data that predates the
   * grouping, or a bug. Callers render/validate the first truthy option and use
   * this flag to avoid treating the row as cleanly answered.
   */
  malformed: boolean;
}

/**
 * Which option a row has chosen within one answer set.
 *
 * A row is answered when exactly one member column is truthy. Two truthy
 * members is precisely the contradiction answer sets exist to prevent, so it is
 * reported rather than silently normalized — validation refuses it (R9) and the
 * renderer shows the first rather than crashing.
 */
export function selectedOption(set: AnswerSet, row: RepeatingRowValue | undefined): SelectedOption {
  if (!row) return { columnKey: null, malformed: false };

  const chosen = set.columnKeys.filter((k) => isChosen(row[k]));
  if (chosen.length === 0) return { columnKey: null, malformed: false };
  return { columnKey: chosen[0]!, malformed: chosen.length > 1 };
}

/**
 * Whether a cell counts as this row's answer. Only an explicit truthy value
 * does: `false` and `null` both mean "not this option", which is what lets a
 * three-column set distinguish "answered N/A" from "not answered at all".
 */
function isChosen(cell: RepeatingRowValue[string] | undefined): boolean {
  return cell === true || cell === 'true' || cell === 1;
}

/** Set every member column to reflect `columnKey` being the row's answer. */
export function applySelection(
  set: AnswerSet,
  row: RepeatingRowValue,
  columnKey: string | null,
): RepeatingRowValue {
  const next: RepeatingRowValue = { ...row };
  for (const k of set.columnKeys) {
    next[k] = k === columnKey ? true : null;
  }
  return next;
}
