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
  | 'duplicate-membership';

export interface DroppedAnswerSet {
  key: string;
  reason: AnswerSetDropReason;
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
