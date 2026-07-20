import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { resolveRepeatingRows, seedFixedRows } from './fixed-rows.js';

const CHECKLIST_ITEMS = [
  'Engine oil level',
  'Coolant level',
  'Park brake',
  'Tyres & wheel nuts',
  'Lights & indicators',
  'Windscreen & wipers',
  'Seatbelts',
];

function checklistField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: 'f1',
    type: 'repeating_group',
    label: 'Category A checks',
    required: true,
    source: 'imported',
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'ok', label: 'OK', type: 'checkbox' },
      { key: 'na', label: 'NA', type: 'checkbox' },
    ],
    fixedRows: CHECKLIST_ITEMS,
    ...overrides,
  };
}

describe('seedFixedRows', () => {
  it('seeds one row per fixed item with the label cell filled', () => {
    const rows = seedFixedRows(checklistField());
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.item)).toEqual(CHECKLIST_ITEMS);
  });

  it('seeds checkbox cells as false (component convention)', () => {
    const rows = seedFixedRows(checklistField());
    for (const row of rows) {
      expect(row.ok).toBe(false);
      expect(row.na).toBe(false);
    }
  });

  it('seeds boolean_yes_no cells as null so an honest "No" is recordable', () => {
    const rows = seedFixedRows(
      checklistField({
        columns: [
          { key: 'item', label: 'Item', type: 'text' },
          { key: 'result', label: 'Result', type: 'boolean_yes_no' },
        ],
      }),
    );
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.result).toBeNull();
  });

  it('seeds other cell types as empty strings', () => {
    const rows = seedFixedRows(
      checklistField({
        columns: [
          { key: 'item', label: 'Item', type: 'text' },
          { key: 'comments', label: 'Comments', type: 'text' },
        ],
      }),
    );
    for (const row of rows) expect(row.comments).toBe('');
  });

  it('returns [] for a field without fixedRows', () => {
    const rows = seedFixedRows(checklistField({ fixedRows: undefined }));
    expect(rows).toEqual([]);
  });

  it('returns [] for a non-repeating_group field', () => {
    const rows = seedFixedRows(
      checklistField({ type: 'text', columns: undefined }),
    );
    expect(rows).toEqual([]);
  });
});

describe('resolveRepeatingRows', () => {
  it('seeds when the value is undefined', () => {
    const rows = resolveRepeatingRows(checklistField(), undefined);
    expect(rows).toHaveLength(7);
    expect(rows[0]?.item).toBe(CHECKLIST_ITEMS[0]);
  });

  it('seeds when the value is null', () => {
    const rows = resolveRepeatingRows(checklistField(), null);
    expect(rows).toHaveLength(7);
  });

  it('does NOT re-seed a non-empty existing value', () => {
    const existing = [{ item: 'Engine oil level', ok: true, na: false }];
    const rows = resolveRepeatingRows(checklistField(), existing);
    expect(rows).toBe(existing);
  });

  it('does NOT re-seed an existing empty array', () => {
    const existing: Record<string, string | number | boolean | null>[] = [];
    const rows = resolveRepeatingRows(checklistField(), existing);
    expect(rows).toBe(existing);
  });

  it('returns [] for a nullish value on a field without fixedRows (legacy behavior)', () => {
    expect(resolveRepeatingRows(checklistField({ fixedRows: undefined }), null)).toEqual([]);
    expect(resolveRepeatingRows(checklistField({ fixedRows: undefined }), undefined)).toEqual([]);
  });
});
