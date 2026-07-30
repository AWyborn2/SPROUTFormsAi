/**
 * WHICH rows a logbook part counts, and why there is only one answer now.
 *
 * There were three. The threshold notification read the part's declared table;
 * the progress dashboard summed every array on the attempt; the retry
 * carry-forward kept its own copy of the lookup. So two readers of the SAME
 * attempt could report different totals with no retry involved, and an auditor
 * comparing the dashboard against the audit trail would find a contradiction
 * with nothing on either to explain it.
 *
 * The case that separated them is a logbook part sharing an attempt with a
 * checkbox group: an array of strings that the dashboard skipped and the
 * threshold's old fallback would have counted.
 */
import { describe, expect, it } from 'vitest';
import { logbookRows, totalLoggedHours } from './assessment.js';
import type { FormField } from './form-field.js';

const header = (id: string): FormField => ({
  id,
  type: 'section_header',
  label: id,
  required: false,
  source: 'imported',
});

const LOG_TABLE: FormField = {
  id: 'log-table',
  type: 'repeating_group',
  label: 'Direct observation log',
  required: false,
  source: 'imported',
  columns: [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'duration', label: 'Duration', type: 'number' },
  ],
};

const FIELDS: FormField[] = [header('h-log'), LOG_TABLE, header('h-next')];
const PART = { startFieldId: 'h-log', durationColumnKey: 'duration' };

const ROWS = [
  { __key: 'r1', date: '2026-07-01', duration: 20 },
  { __key: 'r2', date: '2026-07-08', duration: 27 },
];

describe('logbookRows', () => {
  it('reads the rows under the part declared table', () => {
    expect(logbookRows(FIELDS, PART, { 'log-table': ROWS })).toEqual(ROWS);
  });

  it('ignores an array of strings sitting beside the log', () => {
    // The divergence case. A checkbox group answered on the same attempt is an
    // array; the old threshold fallback took the FIRST array of any kind, so it
    // could count option labels as logbook rows and report hours of zero for a
    // candidate whose log was full.
    const rows = logbookRows(FIELDS, PART, {
      'some-checkbox': ['Stop all work', 'Park up safely'],
      'log-table': ROWS,
    });

    expect(rows).toEqual(ROWS);
    expect(totalLoggedHours(rows, 'duration')).toBe(47);
  });

  it('never mistakes a string array for a log when the table is missing', () => {
    // No declared table resolves, so the fallback runs — and must still refuse
    // an array of strings rather than treating labels as rows.
    const rows = logbookRows([header('h-log')], PART, {
      'some-checkbox': ['Stop all work', 'Park up safely'],
    });

    expect(rows).toEqual([]);
    expect(totalLoggedHours(rows, 'duration')).toBe(0);
  });

  it('falls back to rows saved under an unexpected key', () => {
    // Saved values are not validated against the part — the save route stores
    // whatever keys the client sends, and real data already carries logbook rows
    // under keys the manifest never named. Reading them is better than silently
    // zeroing a candidate hours.
    const rows = logbookRows([header('h-log')], PART, { entries: ROWS });

    expect(totalLoggedHours(rows, 'duration')).toBe(47);
  });

  it('prefers the declared table over any other row list', () => {
    const rows = logbookRows(FIELDS, PART, {
      entries: [{ __key: 'x', duration: 999 }],
      'log-table': ROWS,
    });

    expect(totalLoggedHours(rows, 'duration')).toBe(47);
  });

  it('reads nothing from an attempt that was never filled', () => {
    expect(logbookRows(FIELDS, PART, {})).toEqual([]);
    expect(logbookRows(FIELDS, PART, null)).toEqual([]);
    expect(logbookRows(FIELDS, PART, undefined)).toEqual([]);
  });

  it('refuses a row list that does not carry the duration column', () => {
    // The fallback's own guard. A table without the column this part totals is
    // not this part's log — most obviously another part's table, which an
    // attempt should never hold but nothing enforces. Reading it would report
    // someone else's hours against this candidate.
    const rows = logbookRows([header('h-log')], PART, {
      'other-table': [{ __key: 'x', minutes: 90 }],
    });

    expect(rows).toEqual([]);
  });

  it('reads a differently-keyed table that does carry the column', () => {
    // The case the fallback exists for: the same part's rows under a key the
    // manifest never named, which real data already contains.
    const rows = logbookRows([header('h-log')], PART, { entries: ROWS });

    expect(totalLoggedHours(rows, 'duration')).toBe(47);
  });
});
