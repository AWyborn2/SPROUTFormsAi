/**
 * Shared CSV export — the one serialiser every screen's Export button goes
 * through (Audit log, Submissions, Training matrix). Grown from the identical
 * per-screen copies, plus the guard those copies lacked: a cell starting with
 * a formula trigger gets a leading apostrophe so a spreadsheet opens it as
 * text. An exported value like `=HYPERLINK(...)` typed into a free-text field
 * must never execute on an auditor's machine.
 */

/**
 * Characters a spreadsheet reads as "evaluate me" at the start of a cell.
 * `=` `+` `-` `@` are the formula triggers; tab and carriage return smuggle
 * a trigger past naive filters.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * One cell, serialised: formula-guarded FIRST, then quote-escaped and wrapped.
 * Every cell is quoted (as the per-screen copies always did) so embedded
 * commas and newlines never split a row.
 */
function csvCell(value: string): string {
  const v = String(value);
  const guarded = FORMULA_TRIGGER.test(v) ? `'${v}` : v;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Rows (header included) → the CSV text. Pure — the testable half of `exportCsv`. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

/** Serialise `rows` (header row included) and trigger a browser download. */
export function exportCsv(filename: string, rows: string[][]): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
