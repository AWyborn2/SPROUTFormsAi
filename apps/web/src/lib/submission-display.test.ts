/**
 * Submission-detail display model — fixed-row label derivation (KTD1: the
 * pinned version's `fixedRows` is authoritative over stored label cells) and
 * submitter-identity precedence (R15: stamped user beats free-text).
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { resolveSubmitterIdentity, toDisplayRows } from './submission-display.js';

const checklist: FormField = {
  id: 'cat_a',
  type: 'repeating_group',
  label: 'Category A checks',
  required: true,
  source: 'imported',
  columns: [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'checkbox' },
    { key: 'na', label: 'N/A', type: 'checkbox' },
  ],
  fixedRows: ['Engine oil level', 'Coolant level', 'Park brake'],
};

const openTable: FormField = {
  id: 'defects',
  type: 'repeating_group',
  label: 'Defects',
  required: false,
  source: 'imported',
  columns: [
    { key: 'defect', label: 'Defect', type: 'text' },
    { key: 'severity', label: 'Severity', type: 'text' },
  ],
};

describe('toDisplayRows', () => {
  it('overlays the authoritative fixedRows labels over tampered stored label cells', () => {
    const rows = toDisplayRows(checklist, [
      { item: 'HACKED LABEL', ok: true, na: false },
      { item: '', ok: false, na: true },
      { item: 'Park brake', ok: true, na: false },
    ]);
    expect(rows.map((r) => r.item)).toEqual(['Engine oil level', 'Coolant level', 'Park brake']);
    // Non-label cells keep the stored answers.
    expect(rows.map((r) => r.ok)).toEqual([true, false, true]);
    expect(rows.map((r) => r.na)).toEqual([false, true, false]);
  });

  it('appends stored ad-hoc rows after the fixed set verbatim', () => {
    const rows = toDisplayRows(checklist, [
      { item: 'x', ok: true, na: false },
      { item: 'y', ok: true, na: false },
      { item: 'z', ok: true, na: false },
      { item: 'Left mirror crack', ok: false, na: false },
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual({ item: 'Left mirror crack', ok: false, na: false });
  });

  it('pads a value array shorter than fixedRows with unanswered labelled rows', () => {
    const rows = toDisplayRows(checklist, [{ item: 'Engine oil level', ok: true, na: false }]);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({ item: 'Coolant level', ok: null, na: null });
    expect(rows[2]).toEqual({ item: 'Park brake', ok: null, na: null });
  });

  it('treats a missing value as all fixed rows unanswered', () => {
    const rows = toDisplayRows(checklist, undefined);
    expect(rows.map((r) => r.item)).toEqual(['Engine oil level', 'Coolant level', 'Park brake']);
    expect(rows.every((r) => r.ok === null && r.na === null)).toBe(true);
  });

  it('returns stored rows verbatim for tables without fixedRows (legacy behavior)', () => {
    const stored = [
      { defect: 'Cracked lens', severity: 'low' },
      { defect: 'Slow leak', severity: 'high' },
    ];
    expect(toDisplayRows(openTable, stored)).toEqual(stored);
    expect(toDisplayRows(openTable, undefined)).toEqual([]);
  });

  it('ignores non-row entries defensively instead of rendering broken cells', () => {
    const rows = toDisplayRows(openTable, ['not-a-row', 'also-not'] as never);
    expect(rows).toEqual([]);
  });
});

describe('resolveSubmitterIdentity', () => {
  it('prefers the server-stamped user (verified) over any free-text claim', () => {
    expect(resolveSubmitterIdentity({ userId: 'u1', name: 'Priya Sharma' }, 'Someone Else')).toEqual({
      name: 'Priya Sharma',
      verified: true,
    });
  });

  it('shows a free-text-only claim as unverified', () => {
    expect(resolveSubmitterIdentity(null, 'Site Visitor')).toEqual({
      name: 'Site Visitor',
      verified: false,
    });
    expect(resolveSubmitterIdentity(undefined, 'Site Visitor')).toEqual({
      name: 'Site Visitor',
      verified: false,
    });
  });

  it('falls back to an em-dash when neither identity exists', () => {
    expect(resolveSubmitterIdentity(null, '')).toEqual({ name: '—', verified: false });
    expect(resolveSubmitterIdentity(null, '   ')).toEqual({ name: '—', verified: false });
    expect(resolveSubmitterIdentity(null, undefined)).toEqual({ name: '—', verified: false });
  });

  it('keeps a stamped identity verified even when the stored name is blank', () => {
    expect(resolveSubmitterIdentity({ userId: 'u1', name: '' }, 'Claimed')).toEqual({
      name: '—',
      verified: true,
    });
  });
});
