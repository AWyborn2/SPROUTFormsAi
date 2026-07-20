/**
 * Shared form-validation helpers — the input-field filter, the answered-value
 * predicate, and the required-field submit gate (moved here from the mobile
 * fill module now that the public fill screen shares them).
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { inputFields, isAnswered, validateRequired } from './validation.js';

const header: FormField = { id: 's1', type: 'section_header', label: 'Section', required: false, source: 'built' };
const name: FormField = { id: 'name', type: 'text', label: 'Name', required: true, source: 'built' };
const notes: FormField = { id: 'notes', type: 'textarea', label: 'Notes', required: false, source: 'built' };
const consent: FormField = { id: 'consent', type: 'boolean_yes_no', label: 'Consent', required: true, source: 'built' };

describe('inputFields', () => {
  it('excludes display-only section headers', () => {
    expect(inputFields([header, name, notes]).map((f) => f.id)).toEqual(['name', 'notes']);
  });
});

describe('isAnswered', () => {
  it('rejects null, undefined, empty and whitespace-only strings, and empty arrays', () => {
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered('')).toBe(false);
    expect(isAnswered('   ')).toBe(false);
    expect(isAnswered([])).toBe(false);
  });

  it('accepts non-empty strings, numbers, booleans (including false), and non-empty arrays', () => {
    expect(isAnswered('x')).toBe(true);
    expect(isAnswered(0)).toBe(true);
    expect(isAnswered(true)).toBe(true);
    expect(isAnswered(false)).toBe(true); // an explicit "No" is an answer
    expect(isAnswered(['a'])).toBe(true);
    expect(isAnswered([{ col: 'v' }])).toBe(true);
  });
});

describe('validateRequired', () => {
  it('flags only unanswered required fields', () => {
    const errors = validateRequired([header, name, notes, consent], { consent: false });
    expect(Object.keys(errors)).toEqual(['name']);
  });

  it('is empty when all required fields are answered (optional ones may stay blank)', () => {
    expect(validateRequired([header, name, notes, consent], { name: 'Priya', consent: true })).toEqual({});
  });

  it('never flags a section header, even if marked required', () => {
    const requiredHeader: FormField = { ...header, required: true };
    expect(validateRequired([requiredHeader], {})).toEqual({});
  });
});
