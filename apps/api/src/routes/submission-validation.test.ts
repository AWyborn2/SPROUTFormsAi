/**
 * Unit tests for the shared submission-completeness helper
 * (`@formai/shared`'s submission-validation module). They live in the API
 * package because packages/shared has no test runner — and the API's submit
 * routes are the enforcement consumers of this exact contract (KTD2/R6).
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { incompleteFixedRowIndices, isFieldAnswered, missingRequiredFields } from '@formai/shared';

const text: FormField = { id: 'name', type: 'text', label: 'Name', required: true, source: 'built' };
const num: FormField = { id: 'qty', type: 'number', label: 'Qty', required: true, source: 'built' };
const check: FormField = { id: 'consent', type: 'checkbox', label: 'Consent', required: true, source: 'built' };
const yesNo: FormField = { id: 'fit', type: 'boolean_yes_no', label: 'Fit for work', required: true, source: 'built' };
const header: FormField = { id: 'h1', type: 'section_header', label: 'Section', required: true, source: 'built' };

/** A required fixed-item checklist: label column first, then two result columns. */
const checklist: FormField = {
  id: 'cat-a',
  type: 'repeating_group',
  label: 'Category A checks',
  required: true,
  source: 'imported',
  columns: [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'checkbox' },
    { key: 'na', label: 'N/A', type: 'checkbox' },
  ],
  fixedRows: ['Engine oil level', 'Park brake', 'Tyres'],
};

describe('missingRequiredFields — scalar answered-ness', () => {
  it('reports a required text field that is absent, empty, or whitespace-only', () => {
    expect(missingRequiredFields([text], {})).toEqual(['name']);
    expect(missingRequiredFields([text], { name: '' })).toEqual(['name']);
    expect(missingRequiredFields([text], { name: '   ' })).toEqual(['name']);
    expect(missingRequiredFields([text], { name: 'Priya' })).toEqual([]);
  });

  it('counts zero as an answered number', () => {
    expect(missingRequiredFields([num], { qty: 0 })).toEqual([]);
    expect(missingRequiredFields([num], {})).toEqual(['qty']);
  });

  it('counts a checkbox answered only when explicitly true', () => {
    expect(missingRequiredFields([check], { consent: false })).toEqual(['consent']);
    expect(missingRequiredFields([check], { consent: true })).toEqual([]);
  });

  it('counts boolean_yes_no null as unanswered but an explicit false as answered', () => {
    expect(missingRequiredFields([yesNo], { fit: null })).toEqual(['fit']);
    expect(missingRequiredFields([yesNo], { fit: false })).toEqual([]);
    expect(missingRequiredFields([yesNo], { fit: true })).toEqual([]);
  });

  it('never reports a section header, even when marked required', () => {
    expect(missingRequiredFields([header], {})).toEqual([]);
  });

  it('names every unanswered required field, in field order', () => {
    expect(missingRequiredFields([header, text, num, check], { consent: true })).toEqual(['name', 'qty']);
  });
});

describe('missingRequiredFields — fixed-row tables (R6)', () => {
  it('reports the table when one fixed row has no non-label cell answered', () => {
    const value = [
      { item: 'Engine oil level', ok: true, na: false },
      { item: 'Park brake', ok: false, na: false }, // nothing answered
      { item: 'Tyres', ok: false, na: true },
    ];
    expect(missingRequiredFields([checklist], { 'cat-a': value })).toEqual(['cat-a']);
  });

  it('passes when every fixed row is answered, even with an empty ad-hoc row below', () => {
    const value = [
      { item: 'Engine oil level', ok: true, na: false },
      { item: 'Park brake', ok: true, na: false },
      { item: 'Tyres', ok: false, na: true },
      { item: '', ok: false, na: false }, // ad-hoc extra row — exempt
    ];
    expect(missingRequiredFields([checklist], { 'cat-a': value })).toEqual([]);
  });

  it('treats a value array shorter than fixedRows as having unanswered missing rows', () => {
    const value = [{ item: 'Engine oil level', ok: true, na: false }];
    expect(missingRequiredFields([checklist], { 'cat-a': value })).toEqual(['cat-a']);
  });

  it('ignores answers typed into the label column (label cells are not answers)', () => {
    const value = [
      { item: 'Engine oil level', ok: true, na: false },
      { item: 'Park brake — looks fine', ok: false, na: false },
      { item: 'Tyres', ok: true, na: false },
    ];
    expect(missingRequiredFields([checklist], { 'cat-a': value })).toEqual(['cat-a']);
  });

  it('answers boolean_yes_no cells only on explicit true/false (seeded null stays unanswered)', () => {
    const yesNoTable: FormField = {
      ...checklist,
      columns: [
        { key: 'item', label: 'Item', type: 'text' },
        { key: 'result', label: 'Result', type: 'boolean_yes_no' },
      ],
    };
    const seeded = [
      { item: 'Engine oil level', result: null },
      { item: 'Park brake', result: null },
      { item: 'Tyres', result: null },
    ];
    expect(missingRequiredFields([yesNoTable], { 'cat-a': seeded })).toEqual(['cat-a']);
    const answered = [
      { item: 'Engine oil level', result: true },
      { item: 'Park brake', result: false }, // an honest "No" counts
      { item: 'Tyres', result: true },
    ];
    expect(missingRequiredFields([yesNoTable], { 'cat-a': answered })).toEqual([]);
  });
});

describe('incompleteFixedRowIndices', () => {
  it('names the exact incomplete fixed-row indices', () => {
    const value = [
      { item: 'Engine oil level', ok: true, na: false },
      { item: 'Park brake', ok: false, na: false },
    ];
    // Row 1 has no non-label answer; row 2 is missing entirely (short array).
    expect(incompleteFixedRowIndices(checklist, value)).toEqual([1, 2]);
  });

  it('is empty when every fixed row is answered', () => {
    const value = [
      { item: 'Engine oil level', ok: true, na: false },
      { item: 'Park brake', ok: true, na: false },
      { item: 'Tyres', ok: false, na: true },
    ];
    expect(incompleteFixedRowIndices(checklist, value)).toEqual([]);
  });

  it('is empty for fields without fixedRows', () => {
    const open: FormField = { ...checklist, fixedRows: undefined };
    expect(incompleteFixedRowIndices(open, [])).toEqual([]);
  });
});

describe('isFieldAnswered (progress-counting predicate)', () => {
  it('does not count a seeded-untouched fixed-row checklist as answered', () => {
    const seeded = [
      { item: 'Engine oil level', ok: false, na: false },
      { item: 'Park brake', ok: false, na: false },
      { item: 'Tyres', ok: false, na: false },
    ];
    expect(isFieldAnswered(checklist, seeded)).toBe(false);
  });

  it('counts a fully answered checklist', () => {
    const done = [
      { item: 'Engine oil level', ok: true, na: false },
      { item: 'Park brake', ok: true, na: false },
      { item: 'Tyres', ok: false, na: true },
    ];
    expect(isFieldAnswered(checklist, done)).toBe(true);
  });

  it('keeps legacy open-table behavior: any row counts as answered (AE4)', () => {
    const open: FormField = { ...checklist, fixedRows: undefined };
    expect(isFieldAnswered(open, [])).toBe(false);
    expect(isFieldAnswered(open, [{ item: 'Ladder', ok: true, na: false }])).toBe(true);
  });

  it('applies the typed scalar rules', () => {
    expect(isFieldAnswered(text, '  ')).toBe(false);
    expect(isFieldAnswered(num, 0)).toBe(true);
    expect(isFieldAnswered(check, false)).toBe(false);
    expect(isFieldAnswered(check, true)).toBe(true);
    expect(isFieldAnswered(yesNo, null)).toBe(false);
    expect(isFieldAnswered(yesNo, false)).toBe(true);
  });
});
