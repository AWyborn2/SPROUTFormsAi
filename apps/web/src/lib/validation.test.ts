/**
 * Shared form-validation helpers — the input-field filter, the required-field
 * submit gate (moved here from the mobile fill module now that the public fill
 * screen shares them), and the server-error → per-field-error mapping.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import {
  inputFields,
  requiredFieldErrors,
  requiredFieldsMissingIds,
  validateRequired,
  incompleteRowsByFieldFrom,
} from './validation.js';

const header: FormField = { id: 's1', type: 'section_header', label: 'Section', required: false, source: 'built' };
const name: FormField = { id: 'name', type: 'text', label: 'Name', required: true, source: 'built' };
const notes: FormField = { id: 'notes', type: 'textarea', label: 'Notes', required: false, source: 'built' };
const consent: FormField = { id: 'consent', type: 'boolean_yes_no', label: 'Consent', required: true, source: 'built' };

describe('inputFields', () => {
  it('excludes display-only section headers', () => {
    expect(inputFields([header, name, notes]).map((f) => f.id)).toEqual(['name', 'notes']);
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

describe('requiredFieldsMissingIds', () => {
  it('extracts the field ids from a well-formed KTD4 body', () => {
    expect(
      requiredFieldsMissingIds({ error: 'required_fields_missing', fields: ['name', 'consent'] }),
    ).toEqual(['name', 'consent']);
  });

  it('returns null for any other error string', () => {
    expect(requiredFieldsMissingIds({ error: 'version_mismatch', fields: ['name'] })).toBeNull();
  });

  it('returns null for non-object bodies', () => {
    expect(requiredFieldsMissingIds(null)).toBeNull();
    expect(requiredFieldsMissingIds(undefined)).toBeNull();
    expect(requiredFieldsMissingIds('required_fields_missing')).toBeNull();
    expect(requiredFieldsMissingIds(400)).toBeNull();
  });

  it('returns null when fields is missing or not an array', () => {
    expect(requiredFieldsMissingIds({ error: 'required_fields_missing' })).toBeNull();
    expect(requiredFieldsMissingIds({ error: 'required_fields_missing', fields: 'name' })).toBeNull();
  });

  it('filters non-string entries out of the fields array', () => {
    expect(
      requiredFieldsMissingIds({ error: 'required_fields_missing', fields: ['name', 7, null, 'consent'] }),
    ).toEqual(['name', 'consent']);
  });
});

describe('requiredFieldErrors', () => {
  it('maps each id to the shared required message', () => {
    expect(requiredFieldErrors(['name', 'consent'])).toEqual({
      name: 'This field is required',
      consent: 'This field is required',
    });
  });

  it('returns an empty map for no ids', () => {
    expect(requiredFieldErrors([])).toEqual({});
  });
});

describe('incompleteRowsByFieldFrom', () => {
  it('reads per-field row indexes out of a required_fields_missing body', () => {
    expect(
      incompleteRowsByFieldFrom({
        error: 'required_fields_missing',
        fields: ['cat-a'],
        incompleteRows: { 'cat-a': [6, 13] },
      }),
    ).toEqual({ 'cat-a': [6, 13] });
  });

  it('returns empty when the server omitted the detail (scalar-only failure)', () => {
    expect(incompleteRowsByFieldFrom({ error: 'required_fields_missing', fields: ['name'] })).toEqual({});
  });

  it('ignores a body for a different error', () => {
    expect(incompleteRowsByFieldFrom({ error: 'invalid_request', incompleteRows: { a: [1] } })).toEqual({});
  });

  it('tolerates junk rather than throwing in front of a filler', () => {
    expect(incompleteRowsByFieldFrom(null)).toEqual({});
    expect(incompleteRowsByFieldFrom('nope')).toEqual({});
    expect(incompleteRowsByFieldFrom({ error: 'required_fields_missing', incompleteRows: 'nope' })).toEqual({});
  });

  it('drops non-integer and negative indexes, and fields left with none', () => {
    expect(
      incompleteRowsByFieldFrom({
        error: 'required_fields_missing',
        incompleteRows: { good: [0, 2], bad: ['x', -1, 1.5], empty: [] },
      }),
    ).toEqual({ good: [0, 2] });
  });
});
