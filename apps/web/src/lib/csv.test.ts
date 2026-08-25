import { describe, expect, it } from 'vitest';
import { toCsv } from './csv.js';

describe('toCsv', () => {
  it('leaves a plain value untouched inside its quotes', () => {
    expect(toCsv([['Bo Worker']])).toBe('"Bo Worker"');
  });

  it('quotes embedded commas so they never split a row', () => {
    expect(toCsv([['Dozer, Track']])).toBe('"Dozer, Track"');
  });

  it('doubles embedded quotes', () => {
    expect(toCsv([['the "big" one']])).toBe('"the ""big"" one"');
  });

  it('joins rows with newlines and cells with commas', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('"a","b"\n"c","d"');
  });

  it.each([
    ['=', '=HYPERLINK("http://evil")'],
    ['+', '+1+1'],
    ['-', '-2+3'],
    ['@', '@SUM(A1)'],
    ['tab', '\t=cmd'],
    ['carriage return', '\r=cmd'],
  ])('guards a leading %s formula trigger with an apostrophe', (_label, value) => {
    const out = toCsv([[value]]);
    // The apostrophe lands INSIDE the quotes, before the trigger, so the
    // spreadsheet reads the cell as text rather than evaluating it.
    expect(out.startsWith(`"'`)).toBe(true);
    expect(out).toBe(`"'${value.replace(/"/g, '""')}"`);
  });

  it('guards only at the start — an interior = is data, not a formula', () => {
    expect(toCsv([['a=b']])).toBe('"a=b"');
  });
});
