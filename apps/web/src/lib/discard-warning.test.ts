/**
 * R22 — the filler is told before a change destroys answers they already gave.
 *
 * The two failure modes this pins are opposite: warning too rarely loses work
 * silently, warning too often trains people to click through the one that
 * mattered. Both are tested.
 */
import { describe, expect, it } from 'vitest';
import type { FormField, SubmissionValue } from '@formai/shared';
import { discardImpactOf, discardWarningMessage } from './discard-warning.js';

const location: FormField = {
  id: 'loc',
  type: 'dropdown',
  label: 'Location',
  required: true,
  source: 'imported',
  options: ['BBM Mining', 'Raw Materials'],
};

function scoped(id: string, value: string, extra: Partial<FormField> = {}): FormField {
  return {
    id,
    type: 'text',
    label: id,
    required: false,
    source: 'imported',
    visibleWhen: { fieldId: 'loc', op: 'equals', value },
    ...extra,
  };
}

const bbm = scoped('bbm-1', 'BBM Mining');
const bbm2 = scoped('bbm-2', 'BBM Mining');
const raw = scoped('raw-1', 'Raw Materials');
const FIELDS: FormField[] = [location, bbm, bbm2, raw];

const at = (values: Record<string, SubmissionValue>, next: SubmissionValue) =>
  discardImpactOf(FIELDS, { ...values }, 'loc', next);

describe('discardImpactOf', () => {
  it('names the answered fields a change would hide', () => {
    const impact = at({ loc: 'BBM Mining', 'bbm-1': 'seized', 'bbm-2': 'ok' }, 'Raw Materials');

    expect(impact.count).toBe(2);
    expect(impact.fields.map((f) => f.id)).toEqual(['bbm-1', 'bbm-2']);
  });

  it('stays silent when the fields about to hide are empty', () => {
    expect(at({ loc: 'BBM Mining' }, 'Raw Materials')).toEqual({ fields: [], count: 0 });
  });

  it('counts only the answered ones when a section is partly filled', () => {
    const impact = at({ loc: 'BBM Mining', 'bbm-1': 'seized' }, 'Raw Materials');

    expect(impact.count).toBe(1);
    expect(impact.fields[0]?.id).toBe('bbm-1');
  });

  it('stays silent when nothing is conditioned on the changed field', () => {
    expect(discardImpactOf(FIELDS, { 'bbm-1': 'seized' }, 'bbm-1', 'other')).toEqual({
      fields: [],
      count: 0,
    });
  });

  it('stays silent when the change hides nothing', () => {
    expect(at({ loc: 'BBM Mining', 'bbm-1': 'seized' }, 'BBM Mining')).toEqual({
      fields: [],
      count: 0,
    });
  });

  it('does not count fields that were already hidden', () => {
    // raw-1 carries a stale answer but is not visible under BBM Mining, so
    // switching away from BBM must not report it as newly lost.
    const impact = at({ loc: 'BBM Mining', 'bbm-1': 'seized', 'raw-1': 'stale' }, 'Raw Materials');

    expect(impact.fields.map((f) => f.id)).toEqual(['bbm-1']);
  });

  it('counts an answered table inside a section about to hide', () => {
    const table: FormField = {
      id: 'checks',
      type: 'repeating_group',
      label: 'Checks',
      required: true,
      source: 'imported',
      visibleWhen: { fieldId: 'loc', op: 'equals', value: 'BBM Mining' },
      columns: [
        { key: 'item', label: 'Item', type: 'text' },
        { key: 'ok', label: 'OK', type: 'checkbox' },
      ],
      fixedRows: ['Horn', 'Brakes'],
    };
    const impact = discardImpactOf(
      [location, table],
      { loc: 'BBM Mining', checks: [{ ok: true }, { ok: true }] },
      'loc',
      'Raw Materials',
    );

    expect(impact.fields.map((f) => f.id)).toEqual(['checks']);
  });

  it('excludes section headers from the count — a header holds no answer', () => {
    const header: FormField = {
      id: 'h-bbm',
      type: 'section_header',
      label: 'BBM Mining only',
      required: false,
      source: 'imported',
      visibleWhen: { fieldId: 'loc', op: 'equals', value: 'BBM Mining' },
    };
    // The header governs the field after it, so both leave view; only the
    // answered field should be counted.
    const impact = discardImpactOf(
      [location, header, { ...bbm, visibleWhen: undefined }],
      { loc: 'BBM Mining', 'bbm-1': 'seized' },
      'loc',
      'Raw Materials',
    );

    expect(impact.fields.map((f) => f.id)).toEqual(['bbm-1']);
  });
});

describe('discardWarningMessage', () => {
  it('reads naturally for one answer', () => {
    expect(discardWarningMessage({ fields: [bbm], count: 1 })).toContain('1 answered question,');
  });

  it('pluralises for several', () => {
    expect(discardWarningMessage({ fields: [bbm, bbm2], count: 2 })).toContain('2 answered questions');
  });
});
