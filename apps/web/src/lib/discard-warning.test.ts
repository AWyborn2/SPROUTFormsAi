/**
 * R22 — the filler is told before a change destroys answers they already gave.
 *
 * The two failure modes this pins are opposite: warning too rarely loses work
 * silently, warning too often trains people to click through the one that
 * mattered. Both are tested.
 */
import { describe, expect, it } from 'vitest';
import type { FormField, SubmissionValue } from '@formai/shared';
import {
  discardImpactOf,
  discardImpactOfPatch,
  discardWarningMessage,
  isCommittedChange,
} from './discard-warning.js';

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

/**
 * Smart Fill applies many answers as one action. Applying them one at a time
 * through the single-field path asked the respondent once per mapping and
 * judged every question against the pre-merge values — so the count was wrong
 * in both directions and the modals were unanswerable.
 */
describe('discardImpactOfPatch', () => {
  const shift: FormField = {
    id: 'shift',
    type: 'dropdown',
    label: 'Shift',
    required: false,
    source: 'imported',
    options: ['Day', 'Night'],
  };
  const night: FormField = {
    id: 'night-1',
    type: 'text',
    label: 'Night notes',
    required: false,
    source: 'imported',
    visibleWhen: { fieldId: 'shift', op: 'equals', value: 'Night' },
  };
  const TWO_SOURCE_FIELDS: FormField[] = [location, bbm, raw, shift, night];

  it('reports one combined impact when the patch hides sections behind two sources', () => {
    const impact = discardImpactOfPatch(
      TWO_SOURCE_FIELDS,
      { loc: 'BBM Mining', 'bbm-1': 'seized', shift: 'Night', 'night-1': 'gate left open' },
      { loc: 'Raw Materials', shift: 'Day' },
    );

    // One decision covering both — the per-field loop this replaced raised a
    // separate blocking confirm for each source in the same Smart Fill run.
    expect(impact.count).toBe(2);
    expect(impact.fields.map((f) => f.id)).toEqual(['bbm-1', 'night-1']);
  });

  it('judges visibility against the merged result, not the values it started from', () => {
    // `raw-1` is hidden before the patch and visible after, so nothing about it
    // is lost — even though a mapping applied on its own, against the pre-merge
    // values, would have been weighed while it was still out of view.
    const impact = discardImpactOfPatch(
      TWO_SOURCE_FIELDS,
      { loc: 'BBM Mining', 'raw-1': 'stale' },
      { loc: 'Raw Materials', 'raw-1': 'heard this' },
    );

    expect(impact).toEqual({ fields: [], count: 0 });
  });

  it('warns about work the respondent already did, not about the patch hiding its own proposal', () => {
    const values = { loc: 'BBM Mining' };
    const patch = { loc: 'Raw Materials', 'bbm-1': 'heard this' };
    // bbm-1 is only ever going to hold something the model just proposed, and
    // the server strips it on save regardless — a modal here would put a
    // blocking question in front of a sentence that cost nobody anything.
    expect(discardImpactOfPatch(TWO_SOURCE_FIELDS, values, patch)).toEqual({ fields: [], count: 0 });

    // The same patch over an answer they typed themselves does warn.
    const typed = discardImpactOfPatch(TWO_SOURCE_FIELDS, { ...values, 'bbm-1': 'seized' }, patch);
    expect(typed.fields.map((f) => f.id)).toEqual(['bbm-1']);
  });

  it('stays silent when no rule reads any patched field', () => {
    expect(
      discardImpactOfPatch(FIELDS, { loc: 'BBM Mining', 'bbm-1': 'seized' }, { 'bbm-1': 'other' }),
    ).toEqual({ fields: [], count: 0 });
  });

  it('stays silent for an empty patch', () => {
    expect(discardImpactOfPatch(FIELDS, { loc: 'BBM Mining', 'bbm-1': 'seized' }, {})).toEqual({
      fields: [],
      count: 0,
    });
  });

  // Free-text sources are excluded from the typed path by `isCommittedChange`
  // (a per-keystroke modal makes the field uneditable). A patch has no
  // keystrokes, so that exemption must not carry over.
  it('counts a free-text source, which the per-keystroke path deliberately skips', () => {
    const textSource: FormField = {
      id: 'loc-text',
      type: 'text',
      label: 'Location',
      required: false,
      source: 'imported',
    };
    const scopedToText: FormField = {
      ...bbm,
      visibleWhen: { fieldId: 'loc-text', op: 'equals', value: 'BBM Mining' },
    };
    const impact = discardImpactOfPatch(
      [textSource, scopedToText],
      { 'loc-text': 'BBM Mining', 'bbm-1': 'seized' },
      { 'loc-text': 'Raw Materials' },
    );

    expect(isCommittedChange([textSource], 'loc-text')).toBe(false);
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

describe('discardImpactOf — partially completed tables (review finding)', () => {
  const table: FormField = {
    id: 'checks',
    type: 'repeating_group',
    label: 'Category A checks',
    required: true,
    source: 'imported',
    visibleWhen: { fieldId: 'loc', op: 'equals', value: 'BBM Mining' },
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'ok', label: 'OK', type: 'checkbox' },
      { key: 'na', label: 'N/A', type: 'checkbox' },
    ],
    fixedRows: ['Horn', 'Brakes', 'Tyres', 'Lights'],
  };

  it('warns about a HALF-filled checklist — the highest-loss case', () => {
    // Two of four rows done. isFieldAnswered says "not answered", which is why
    // this silently lost 25 rows of work before.
    const impact = discardImpactOf(
      [location, table],
      { loc: 'BBM Mining', checks: [{ ok: true }, { ok: true }, {}, {}] },
      'loc',
      'Raw Materials',
    );

    expect(impact.count).toBe(1);
    expect(impact.fields[0]?.id).toBe('checks');
  });

  it('warns about a single answered row', () => {
    const impact = discardImpactOf(
      [location, table],
      { loc: 'BBM Mining', checks: [{ ok: true }, {}, {}, {}] },
      'loc',
      'Raw Materials',
    );
    expect(impact.count).toBe(1);
  });

  it('stays silent for a completely untouched table', () => {
    const impact = discardImpactOf(
      [location, table],
      { loc: 'BBM Mining', checks: [{}, {}, {}, {}] },
      'loc',
      'Raw Materials',
    );
    expect(impact.count).toBe(0);
  });

  it('warns about an open row-entry table carrying any row', () => {
    const open: FormField = { ...table, id: 'faults', fixedRows: undefined };
    const impact = discardImpactOf(
      [location, open],
      { loc: 'BBM Mining', faults: [{ item: 'Cracked mirror' }] },
      'loc',
      'Raw Materials',
    );
    expect(impact.count).toBe(1);
  });
});

describe('isCommittedChange', () => {
  it('treats discrete-choice fields as committing', () => {
    expect(isCommittedChange([location], 'loc')).toBe(true);
  });

  it('does not treat free-text as committing — a keystroke is not an answer', () => {
    const text: FormField = { id: 'notes', type: 'text', label: 'Notes', required: false, source: 'built' };
    expect(isCommittedChange([text], 'notes')).toBe(false);
  });

  it('fails toward silence for an unknown field id', () => {
    expect(isCommittedChange([location], 'nope')).toBe(false);
  });
});
