/**
 * Time arithmetic for auto-calculated table columns (`ColumnCalc`).
 *
 * The ONE implementation of "total hours = finish − start − lunch": the fill
 * view computes with it as the respondent types, and because the computed
 * number is then STORED in the row value, validation, the submission detail
 * view and the PDF export all read the same figure without re-deriving it.
 *
 * Every function here is total — malformed input yields `null` (cell renders
 * blank), never a throw and never NaN. A timesheet row mid-entry has a start
 * time and no finish time for most of its life; that state is normal, not an
 * error.
 */
import type { ColumnCalc, RepeatingColumn } from './form-field.js';
import type { RepeatingRowValue } from './submission.js';

/**
 * Parse an `HH:MM` 24-hour string (the native time input's value format) to
 * minutes since midnight. `H:MM` is accepted (a hand-typed "7:30"); seconds,
 * 12-hour suffixes, out-of-range parts and anything else return null.
 */
export function parseTimeToMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * A lunch cell as a duration in minutes.
 *
 * Two spellings are honest on a paper timesheet and both are accepted:
 * `HH:MM` (a time-typed cell — "00:30") and a plain decimal number of hours
 * (a number-typed cell — "0.5"). Blank/absent is ZERO, not null: the config
 * names lunch optional precisely because a task finished before any break
 * subtracts nothing. Anything unparseable is null so the total goes blank
 * rather than silently ignoring what the filler wrote.
 */
export function parseLunchToMinutes(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return 0;
  const asTime = parseTimeToMinutes(value);
  if (asTime !== null) return asTime;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  // A bare number is decimal HOURS (0.5 = half an hour) — the timesheet idiom.
  return Math.round(n * 60);
}

/**
 * Total hours for one row under a `total_hours` calc, in decimal hours
 * rounded to 2 places — or null when it cannot honestly be computed (start or
 * finish missing/invalid, lunch unparseable, or lunch exceeding the span).
 *
 * A finish earlier than the start wraps past midnight (+24h): the source form
 * has a Night shift box, and 22:00→06:00 is eight hours, not minus sixteen.
 */
export function totalHoursFor(calc: ColumnCalc, row: RepeatingRowValue): number | null {
  const start = parseTimeToMinutes(row[calc.startKey]);
  const finish = parseTimeToMinutes(row[calc.finishKey]);
  if (start === null || finish === null) return null;

  const lunch = calc.lunchKey !== undefined ? parseLunchToMinutes(row[calc.lunchKey]) : 0;
  if (lunch === null) return null;

  const span = finish >= start ? finish - start : finish + 24 * 60 - start;
  const total = span - lunch;
  if (total < 0) return null; // a lunch longer than the shift is a data error, not zero hours

  return Math.round((total / 60) * 100) / 100;
}

/**
 * Recompute every calc column of one row, returning a new row (or the same
 * object when nothing changed, so callers can cheaply skip no-op updates).
 * An uncomputable calc writes '' — the cell reads blank, and blank is
 * unanswered to validation, which is the honest state for a half-filled row.
 */
export function applyRowCalcs(
  columns: readonly RepeatingColumn[] | undefined,
  row: RepeatingRowValue,
): RepeatingRowValue {
  let next = row;
  for (const column of columns ?? []) {
    if (!column.calc) continue;
    const total = totalHoursFor(column.calc, next);
    const value = total === null ? '' : total;
    if (next[column.key] !== value) next = { ...next, [column.key]: value };
  }
  return next;
}

/** `applyRowCalcs` over a whole value array, preserving identity when no row changed. */
export function applyCalcs(
  columns: readonly RepeatingColumn[] | undefined,
  rows: readonly RepeatingRowValue[],
): RepeatingRowValue[] {
  if (!columns?.some((c) => c.calc)) return rows as RepeatingRowValue[];
  let changed = false;
  const next = rows.map((row) => {
    const out = applyRowCalcs(columns, row);
    if (out !== row) changed = true;
    return out;
  });
  return changed ? next : (rows as RepeatingRowValue[]);
}
