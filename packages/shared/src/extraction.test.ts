import { describe, expect, it } from 'vitest';
import { filterUncapturedInputs, normalizeInputLabel, type MissedInput } from './extraction.js';

describe('normalizeInputLabel', () => {
  it('lowercases and flattens punctuation and whitespace', () => {
    expect(normalizeInputLabel('Assessor Signature:')).toBe('assessor signature');
    expect(normalizeInputLabel('  Date   completed  ')).toBe('date completed');
    expect(normalizeInputLabel('Site name / location')).toBe('site name location');
  });

  it('collapses two spellings of the same label to one key', () => {
    expect(normalizeInputLabel('Assessor signature')).toBe(normalizeInputLabel('ASSESSOR  Signature'));
  });
});

describe('filterUncapturedInputs', () => {
  const box = (label: string, over: Partial<MissedInput> = {}): MissedInput => ({
    label,
    type: 'text',
    ...over,
  });

  it('drops boxes that match a captured label, ignoring case and punctuation', () => {
    const missed = [box('Site Name:'), box('Inspector signature')];
    expect(filterUncapturedInputs(missed, ['site name']).map((m) => m.label)).toEqual([
      'Inspector signature',
    ]);
  });

  it('drops duplicates within the audit itself, keeping the first', () => {
    const missed = [box('Second witness'), box('second WITNESS')];
    expect(filterUncapturedInputs(missed, [])).toEqual([box('Second witness')]);
  });

  it('drops a blank label', () => {
    expect(filterUncapturedInputs([box('   '), box('Date')], [])).toEqual([box('Date')]);
  });

  it('keeps everything when nothing overlaps', () => {
    const missed = [box('Odometer'), box('Fuel level')];
    expect(filterUncapturedInputs(missed, ['Driver name'])).toEqual(missed);
  });
});
