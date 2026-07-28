/**
 * Total-hours calculation (`ColumnCalc` / time-calc.ts).
 *
 * The properties that matter: every function is total (bad input → null/blank,
 * never NaN or a throw), a blank lunch subtracts NOTHING (the config names it
 * optional for exactly that case), and an overnight shift wraps rather than
 * going negative — the source form has a Night shift box.
 */
import { describe, expect, it } from 'vitest';
import type { ColumnCalc, RepeatingColumn } from './form-field.js';
import {
  applyCalcs,
  applyRowCalcs,
  calcValueFor,
  machineHoursFor,
  parseLunchToMinutes,
  parseTimeToMinutes,
  totalHoursFor,
} from './time-calc.js';

const CALC: ColumnCalc = { kind: 'total_hours', startKey: 'start', finishKey: 'finish', lunchKey: 'lunch' };

describe('parseTimeToMinutes', () => {
  it('parses HH:MM and H:MM', () => {
    expect(parseTimeToMinutes('07:30')).toBe(450);
    expect(parseTimeToMinutes('7:30')).toBe(450);
    expect(parseTimeToMinutes('00:00')).toBe(0);
    expect(parseTimeToMinutes('23:59')).toBe(23 * 60 + 59);
  });

  it('rejects out-of-range, non-time and non-string values', () => {
    expect(parseTimeToMinutes('24:00')).toBeNull();
    expect(parseTimeToMinutes('12:60')).toBeNull();
    expect(parseTimeToMinutes('7.5')).toBeNull();
    expect(parseTimeToMinutes('')).toBeNull();
    expect(parseTimeToMinutes(450)).toBeNull();
    expect(parseTimeToMinutes(null)).toBeNull();
  });
});

describe('parseLunchToMinutes', () => {
  it('treats blank as ZERO — no break taken subtracts nothing', () => {
    expect(parseLunchToMinutes('')).toBe(0);
    expect(parseLunchToMinutes(null)).toBe(0);
    expect(parseLunchToMinutes(undefined)).toBe(0);
  });

  it('accepts HH:MM as a duration and bare numbers as decimal hours', () => {
    expect(parseLunchToMinutes('00:30')).toBe(30);
    expect(parseLunchToMinutes('1:00')).toBe(60);
    expect(parseLunchToMinutes(0.5)).toBe(30);
    expect(parseLunchToMinutes('0.5')).toBe(30);
    expect(parseLunchToMinutes(0)).toBe(0);
  });

  it('returns null for garbage rather than silently ignoring it', () => {
    expect(parseLunchToMinutes('half an hour')).toBeNull();
    expect(parseLunchToMinutes(-1)).toBeNull();
  });
});

describe('totalHoursFor', () => {
  it('computes finish − start − lunch in decimal hours', () => {
    expect(totalHoursFor(CALC, { start: '07:00', finish: '15:30', lunch: '00:30' })).toBe(8);
    expect(totalHoursFor(CALC, { start: '07:00', finish: '15:30', lunch: '' })).toBe(8.5);
    expect(totalHoursFor(CALC, { start: '08:00', finish: '12:15', lunch: 0 })).toBe(4.25);
  });

  it('subtracts nothing when the calc has no lunch column at all', () => {
    const noLunch: ColumnCalc = { kind: 'total_hours', startKey: 'start', finishKey: 'finish' };
    expect(totalHoursFor(noLunch, { start: '07:00', finish: '15:30' })).toBe(8.5);
  });

  it('wraps past midnight — a night shift is positive hours', () => {
    expect(totalHoursFor(CALC, { start: '22:00', finish: '06:00', lunch: '' })).toBe(8);
  });

  it('is null while start or finish is missing (a half-filled row is normal)', () => {
    expect(totalHoursFor(CALC, { start: '07:00', finish: '', lunch: '' })).toBeNull();
    expect(totalHoursFor(CALC, { start: '', finish: '15:00', lunch: '' })).toBeNull();
  });

  it('is null for an unparseable lunch or a lunch longer than the shift', () => {
    expect(totalHoursFor(CALC, { start: '07:00', finish: '15:00', lunch: 'a while' })).toBeNull();
    expect(totalHoursFor(CALC, { start: '09:00', finish: '09:30', lunch: '01:00' })).toBeNull();
  });
});

describe('applyRowCalcs / applyCalcs', () => {
  const columns: RepeatingColumn[] = [
    { key: 'wo', label: 'Work Order #', type: 'text' },
    { key: 'start', label: 'Start Time', type: 'time' },
    { key: 'finish', label: 'Finish Time', type: 'time' },
    { key: 'lunch', label: 'Lunch Time', type: 'time' },
    { key: 'total', label: 'Total Hours', type: 'number', calc: CALC },
  ];

  it('writes the computed total into the row and blanks it when uncomputable', () => {
    const row = applyRowCalcs(columns, { wo: '123', start: '07:00', finish: '15:30', lunch: '00:30', total: '' });
    expect(row.total).toBe(8);

    const half = applyRowCalcs(columns, { wo: '123', start: '07:00', finish: '', lunch: '', total: 8 });
    expect(half.total).toBe('');
  });

  it('returns the SAME objects when nothing changes, so no-op updates are skippable', () => {
    const row = { wo: '1', start: '07:00', finish: '15:00', lunch: '', total: 8 };
    expect(applyRowCalcs(columns, row)).toBe(row);

    const rows = [row];
    expect(applyCalcs(columns, rows)).toBe(rows);
    // And with no calc columns at all, the array passes through untouched.
    expect(applyCalcs(columns.slice(0, 4), rows)).toBe(rows);
  });

  it('overwrites a manually tampered total with the computed one', () => {
    const row = applyRowCalcs(columns, { wo: '1', start: '07:00', finish: '15:00', lunch: '', total: 99 });
    expect(row.total).toBe(8);
  });
});

/**
 * `machine_hours` is what makes a logbook's hour column trustworthy: the
 * filler enters two meter readings and the duration is derived, so a total
 * cannot simply be typed. Non-positive spans are null, not zero — meter
 * readings only go up, and a zero would count a row that says nothing (U9,
 * R14/R15).
 */
describe('machineHoursFor', () => {
  const calc = { kind: 'machine_hours', startKey: 'start', finishKey: 'finish' } as const;

  it('derives hours from meter readings', () => {
    expect(machineHoursFor(calc, { start: 1204.5, finish: 1212.0 })).toBe(7.5);
  });

  it('parses string readings, as a number input submits them', () => {
    expect(machineHoursFor(calc, { start: '1204.5', finish: '1212' })).toBe(7.5);
  });

  it('is null while either reading is missing', () => {
    expect(machineHoursFor(calc, { start: 1204.5, finish: '' })).toBeNull();
    expect(machineHoursFor(calc, { finish: 1212 })).toBeNull();
  });

  it('is null when the meter did not advance — never zero', () => {
    expect(machineHoursFor(calc, { start: 1212, finish: 1212 })).toBeNull();
    expect(machineHoursFor(calc, { start: 1212, finish: 1204 })).toBeNull();
  });

  it('rejects negative and malformed readings', () => {
    expect(machineHoursFor(calc, { start: -5, finish: 3 })).toBeNull();
    expect(machineHoursFor(calc, { start: 'noon', finish: 1212 })).toBeNull();
  });
});

describe('calcValueFor routing', () => {
  it('routes machine_hours to meter arithmetic, not time-of-day parsing', () => {
    const calc = { kind: 'machine_hours', startKey: 's', finishKey: 'f' } as const;
    // As HH:MM these would wrap midnight; as meter readings they are invalid.
    expect(calcValueFor(calc, { s: 22, f: 6 })).toBeNull();
  });

  it('still routes total_hours through the timesheet path', () => {
    const calc = { kind: 'total_hours', startKey: 's', finishKey: 'f' } as const;
    expect(calcValueFor(calc, { s: '22:00', f: '06:00' })).toBe(8);
  });
});

describe('applyRowCalcs with machine_hours', () => {
  it('writes the derived duration into the row', () => {
    const columns = [
      { key: 'start', label: 'Start hours', type: 'number' },
      { key: 'finish', label: 'Finish hours', type: 'number' },
      {
        key: 'duration',
        label: 'Total',
        type: 'number',
        calc: { kind: 'machine_hours', startKey: 'start', finishKey: 'finish' },
      },
    ] as const;

    const row = applyRowCalcs(columns as never, { start: 100, finish: 106.5, duration: 999 });

    expect(row.duration).toBe(6.5);
  });

  it('blanks the cell when readings go backwards, overwriting a typed value', () => {
    const columns = [
      {
        key: 'duration',
        label: 'Total',
        type: 'number',
        calc: { kind: 'machine_hours', startKey: 'start', finishKey: 'finish' },
      },
    ] as const;

    const row = applyRowCalcs(columns as never, { start: 106, finish: 100, duration: 50 });

    expect(row.duration).toBe('');
  });
});
