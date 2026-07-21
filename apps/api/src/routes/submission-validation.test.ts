/**
 * Unit tests for the shared submission-completeness helper
 * (`@formai/shared`'s submission-validation module). They live in the API
 * package because packages/shared has no test runner — and the API's submit
 * routes are the enforcement consumers of this exact contract (KTD2/R6).
 */
import { describe, expect, it } from 'vitest';
import type { FormField, RepeatingRowValue } from '@formai/shared';
import {
  incompleteFixedRowIndices,
  isFieldAnswered,
  missingRequiredFields,
  stripHiddenValues,
} from '@formai/shared';

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

/**
 * Answer-set backed tables (U5/R9/R10). The grouping changes what "this row is
 * answered" means: not "some cell has something in it" but "exactly one of the
 * alternatives is chosen". A row with both OK and N/A ticked is the exact
 * contradiction answer sets exist to prevent, so it must FAIL rather than pass
 * the old any-cell rule.
 */
const grouped: FormField = {
  id: 'cat-a-grouped',
  type: 'repeating_group',
  label: 'Category A checks',
  required: true,
  source: 'imported',
  columns: [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: '✓', type: 'checkbox' },
    { key: 'no', label: '×', type: 'checkbox' },
    { key: 'na', label: 'N-A', type: 'checkbox' },
  ],
  answerSets: [{ key: 'verdict', columnKeys: ['ok', 'no', 'na'] }],
  fixedRows: ['Engine oil level', 'Park brake', 'Tyres'],
};

function rows(...picks: Array<'ok' | 'no' | 'na' | null>) {
  return picks.map((p) => ({
    ok: p === 'ok' ? true : null,
    no: p === 'no' ? true : null,
    na: p === 'na' ? true : null,
  }));
}

describe('answer sets — row completeness (R9)', () => {
  it('passes when every row has exactly one option chosen', () => {
    expect(incompleteFixedRowIndices(grouped, rows('ok', 'no', 'na'))).toEqual([]);
    expect(missingRequiredFields([grouped], { 'cat-a-grouped': rows('ok', 'no', 'na') })).toEqual([]);
  });

  it('counts an explicit N/A as an answer', () => {
    expect(incompleteFixedRowIndices(grouped, rows('na', 'na', 'na'))).toEqual([]);
  });

  it('reports the unanswered rows individually (AE4)', () => {
    expect(incompleteFixedRowIndices(grouped, rows('ok', null, 'na'))).toEqual([1]);
    expect(incompleteFixedRowIndices(grouped, rows(null, null, 'na'))).toEqual([0, 1]);
  });

  it('fails a row with two options ticked rather than passing it as answered', () => {
    const value = [{ ok: true, no: true, na: null }, ...rows('ok', 'ok')];
    expect(incompleteFixedRowIndices(grouped, value)).toEqual([0]);
    expect(isFieldAnswered(grouped, value)).toBe(false);
  });

  it('treats an explicit false in every option as unanswered, not as an answer', () => {
    const value = [{ ok: false, no: false, na: false }, ...rows('ok', 'ok')];
    expect(incompleteFixedRowIndices(grouped, value)).toEqual([0]);
  });

  it('reports the missing tail when the value array is shorter than fixedRows', () => {
    expect(incompleteFixedRowIndices(grouped, rows('ok'))).toEqual([1, 2]);
  });

  it('exempts ad-hoc rows appended past the fixed set', () => {
    const value = [...rows('ok', 'ok', 'ok'), { ok: null, no: null, na: null }];
    expect(incompleteFixedRowIndices(grouped, value)).toEqual([]);
  });

  it('ignores a malformed answer set and falls back to the ungrouped rule', () => {
    // The set names the label column, so it is dropped — the table behaves
    // exactly as an ungrouped one rather than becoming unanswerable.
    const bad: FormField = { ...grouped, answerSets: [{ key: 'v', columnKeys: ['item', 'ok'] }] };
    expect(incompleteFixedRowIndices(bad, rows('ok', 'ok', 'ok'))).toEqual([]);
  });

  it('leaves an ungrouped fixed-row table behaving exactly as before', () => {
    expect(incompleteFixedRowIndices(checklist, rows('ok', 'ok', 'ok'))).toEqual([]);
    // The old any-cell rule still accepts a double-ticked row on an ungrouped table.
    const both: RepeatingRowValue[] = [
      { ok: true, na: true },
      { ok: true, na: null },
      { ok: null, na: true },
    ];
    expect(incompleteFixedRowIndices(checklist, both)).toEqual([]);
  });
});

describe('answer sets — open row-entry tables', () => {
  const openTable: FormField = { ...grouped, id: 'faults', fixedRows: undefined };

  it('accepts rows that each carry exactly one answer', () => {
    expect(isFieldAnswered(openTable, rows('ok', 'na'))).toBe(true);
  });

  it('rejects a contradictory row even with no fixed rows', () => {
    expect(isFieldAnswered(openTable, [{ ok: true, no: true, na: null }])).toBe(false);
  });

  it('rejects a row that answers nothing', () => {
    expect(isFieldAnswered(openTable, [{ ok: null, no: null, na: null }])).toBe(false);
  });

  it('is unanswered when there are no rows at all', () => {
    expect(isFieldAnswered(openTable, [])).toBe(false);
  });
});

/**
 * U11 — conditional visibility crosses into completeness. A hidden field is
 * unrequired: it must not appear in `missingRequiredFields`, because the
 * filler was never shown it and no amount of scrolling will reveal it.
 * `visibleFields` (shared) does the section expansion, so a hidden section
 * header takes its whole scope with it.
 */
describe('missingRequiredFields — conditional visibility', () => {
  const trigger: FormField = { id: 'has_plant', type: 'boolean_yes_no', label: 'Plant on site?', required: false, source: 'built' };
  const hiddenRequired: FormField = {
    id: 'plant_reg',
    type: 'text',
    label: 'Plant registration',
    required: true,
    source: 'built',
    visibleWhen: { fieldId: 'has_plant', op: 'equals', value: 'true' },
  };
  const sectionHeader: FormField = {
    id: 'plant_section',
    type: 'section_header',
    label: 'Plant',
    required: false,
    source: 'built',
    visibleWhen: { fieldId: 'has_plant', op: 'equals', value: 'true' },
  };

  it('omits a hidden required field — it cannot block a submit', () => {
    expect(missingRequiredFields([trigger, hiddenRequired], { has_plant: false })).toEqual([]);
  });

  it('still reports the field once its condition is met', () => {
    expect(missingRequiredFields([trigger, hiddenRequired], { has_plant: true })).toEqual(['plant_reg']);
  });

  it('omits every required field inside a hidden section', () => {
    const plainRequired: FormField = { id: 'plant_reg', type: 'text', label: 'Plant registration', required: true, source: 'built' };
    const fields: FormField[] = [trigger, sectionHeader, plainRequired, { ...text, id: 'plant_owner' }];
    expect(missingRequiredFields(fields, { has_plant: false })).toEqual([]);
    expect(missingRequiredFields(fields, { has_plant: true }).sort()).toEqual(['plant_owner', 'plant_reg']);
  });

  it('behaves identically to today for a form with no conditions', () => {
    expect(missingRequiredFields([text, num], {})).toEqual(['name', 'qty']);
  });
});

describe('stripHiddenValues', () => {
  const trigger: FormField = { id: 'has_plant', type: 'boolean_yes_no', label: 'Plant?', required: false, source: 'built' };
  const hidden: FormField = {
    id: 'plant_reg',
    type: 'text',
    label: 'Plant registration',
    required: false,
    source: 'built',
    visibleWhen: { fieldId: 'has_plant', op: 'equals', value: 'true' },
  };

  it('drops values for hidden fields and names them', () => {
    const out = stripHiddenValues([trigger, hidden], { has_plant: false, plant_reg: 'ABC123' });
    expect(out.values).toEqual({ has_plant: false });
    expect(out.discarded).toEqual(['plant_reg']);
  });

  it('keeps everything and discards nothing when all fields are visible', () => {
    const out = stripHiddenValues([trigger, hidden], { has_plant: true, plant_reg: 'ABC123' });
    expect(out.values).toEqual({ has_plant: true, plant_reg: 'ABC123' });
    expect(out.discarded).toEqual([]);
  });

  it('is a no-op for a form with no conditions', () => {
    const values = { name: 'Priya', qty: 3 };
    const out = stripHiddenValues([text, num], values);
    expect(out.values).toEqual(values);
    expect(out.discarded).toEqual([]);
  });

  it('only names hidden fields that actually carried a value', () => {
    const out = stripHiddenValues([trigger, hidden], { has_plant: false });
    expect(out.discarded).toEqual([]);
  });

  it('keeps values for ids that are not fields at all — stripping decides on visibility, not membership', () => {
    const out = stripHiddenValues([trigger], { has_plant: true, stray: 'x' });
    expect(out.values).toEqual({ has_plant: true, stray: 'x' });
  });
});
