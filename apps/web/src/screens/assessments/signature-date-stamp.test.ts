/**
 * Pairing a sign-off signature with the date it stamps.
 *
 * The property under test is the SHAPE rule: a signature stamps the date beside
 * it, once, on the stroke that signs it, and never over a date already there.
 * Getting the pairing wrong stamps the wrong block's date — a competency record
 * that reads as signed on a day nobody signed.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import {
  applyAssessorSignoff,
  assessorSignoffTargets,
  companionDateField,
  dateFieldToStamp,
} from './signature-date-stamp.js';

function f(over: Partial<FormField> & { id: string; type: FormField['type'] }): FormField {
  return { label: over.id, required: false, source: 'imported', ...over };
}

const SIGNED = 'data:image/png;base64,AAAA';

describe('companionDateField', () => {
  it('pairs a signature with the date immediately after it', () => {
    const fields = [f({ id: 'sig', type: 'signature' }), f({ id: 'date', type: 'date' })];
    expect(companionDateField(fields, 'sig')).toBe('date');
  });

  it('reaches past a name field to the date — "Signature / Name / Date"', () => {
    const fields = [
      f({ id: 'sig', type: 'signature' }),
      f({ id: 'name', type: 'text' }),
      f({ id: 'date', type: 'date' }),
    ];
    expect(companionDateField(fields, 'sig')).toBe('date');
  });

  it('stops at the NEXT signature — a later block owns its own date', () => {
    const fields = [
      f({ id: 'sig1', type: 'signature' }),
      f({ id: 'sig2', type: 'signature' }),
      f({ id: 'date', type: 'date' }),
    ];
    // sig1's companion is not date — sig2 sits between them.
    expect(companionDateField(fields, 'sig1')).toBeNull();
    expect(companionDateField(fields, 'sig2')).toBe('date');
  });

  it('does not reach across a section header into the next part', () => {
    const fields = [
      f({ id: 'sig', type: 'signature' }),
      f({ id: 'h', type: 'section_header' }),
      f({ id: 'date', type: 'date' }),
    ];
    expect(companionDateField(fields, 'sig')).toBeNull();
  });

  it('returns null when the id is not a signature, or is unknown', () => {
    const fields = [f({ id: 'sig', type: 'signature' }), f({ id: 'date', type: 'date' })];
    expect(companionDateField(fields, 'date')).toBeNull();
    expect(companionDateField(fields, 'ghost')).toBeNull();
  });
});

describe('dateFieldToStamp', () => {
  const fields = [f({ id: 'sig', type: 'signature' }), f({ id: 'date', type: 'date' })];

  it('stamps the companion date when a blank signature is drawn', () => {
    expect(dateFieldToStamp(fields, { sig: '', date: '' }, 'sig', SIGNED)).toBe('date');
  });

  it('does NOT re-stamp when an already-signed signature is redrawn', () => {
    // The date is a record of when it was FIRST signed; a correction keeps it.
    expect(dateFieldToStamp(fields, { sig: SIGNED, date: '2026-08-01' }, 'sig', SIGNED)).toBeNull();
  });

  it('does not stamp when the signature is being cleared', () => {
    expect(dateFieldToStamp(fields, { sig: SIGNED }, 'sig', '')).toBeNull();
  });

  it('never overwrites a date already entered', () => {
    // Someone back-dated the block by hand; signing must not clobber it.
    expect(dateFieldToStamp(fields, { sig: '', date: '2026-07-30' }, 'sig', SIGNED)).toBeNull();
  });

  it('ignores changes to fields that are not signatures', () => {
    expect(dateFieldToStamp(fields, { sig: '', date: '' }, 'date', '2026-08-02')).toBeNull();
  });
});

describe('assessorSignoffTargets', () => {
  it('finds the assessor name box and the date in its block', () => {
    const fields = [
      f({ id: 'h', type: 'section_header', label: 'Assessor sign-off' }),
      f({ id: 'nm', type: 'text', label: 'Assessor Name' }),
      f({ id: 'sig', type: 'text', label: 'Assessor Signature' }),
      f({ id: 'dt', type: 'date', label: 'Date' }),
    ];
    expect(assessorSignoffTargets(fields)).toEqual({ nameFieldId: 'nm', dateFieldId: 'dt' });
  });

  it('finds the date whether it sits before or after the name in the block', () => {
    const fields = [
      f({ id: 'dt', type: 'date', label: 'Date' }),
      f({ id: 'nm', type: 'text', label: 'Name of Assessor' }),
    ];
    expect(assessorSignoffTargets(fields)).toEqual({ nameFieldId: 'nm', dateFieldId: 'dt' });
  });

  it('accepts a date box typed as text but captioned "Date"', () => {
    const fields = [
      f({ id: 'nm', type: 'text', label: "Assessor's Name" }),
      f({ id: 'dt', type: 'text', label: 'Date' }),
    ];
    expect(assessorSignoffTargets(fields)).toEqual({ nameFieldId: 'nm', dateFieldId: 'dt' });
  });

  it('does NOT mistake a plain candidate "Name" box for the assessor', () => {
    const fields = [
      f({ id: 'nm', type: 'text', label: 'Name' }),
      f({ id: 'dt', type: 'date', label: 'Date' }),
    ];
    expect(assessorSignoffTargets(fields)).toEqual({ nameFieldId: null, dateFieldId: null });
  });

  it('fills neither when a part carries two assessor-name boxes (ambiguous)', () => {
    const fields = [
      f({ id: 'nm1', type: 'text', label: 'Assessor Name' }),
      f({ id: 'nm2', type: 'text', label: 'Assessor Name' }),
      f({ id: 'dt', type: 'date', label: 'Date' }),
    ];
    expect(assessorSignoffTargets(fields)).toEqual({ nameFieldId: null, dateFieldId: null });
  });

  it('leaves the date null when its block holds two dates (ambiguous)', () => {
    const fields = [
      f({ id: 'nm', type: 'text', label: 'Assessor Name' }),
      f({ id: 'd1', type: 'date', label: 'Date' }),
      f({ id: 'd2', type: 'date', label: 'Date' }),
    ];
    expect(assessorSignoffTargets(fields)).toEqual({ nameFieldId: 'nm', dateFieldId: null });
  });

  it('does not reach across a section header into a neighbouring block for the date', () => {
    const fields = [
      f({ id: 'nm', type: 'text', label: 'Assessor Name' }),
      f({ id: 'h', type: 'section_header', label: 'Candidate declaration' }),
      f({ id: 'dt', type: 'date', label: 'Date' }),
    ];
    expect(assessorSignoffTargets(fields)).toEqual({ nameFieldId: 'nm', dateFieldId: null });
  });

  it('keeps "date of birth" out of the assessor date box', () => {
    const fields = [
      f({ id: 'nm', type: 'text', label: 'Assessor Name' }),
      f({ id: 'dob', type: 'text', label: 'Date of birth' }),
    ];
    // dob is a text field whose label is not a bare/"signed" date — not picked.
    expect(assessorSignoffTargets(fields)).toEqual({ nameFieldId: 'nm', dateFieldId: null });
  });
});

describe('applyAssessorSignoff', () => {
  const fields = [
    f({ id: 'nm', type: 'text', label: 'Assessor Name' }),
    f({ id: 'dt', type: 'date', label: 'Date' }),
  ];
  const writable = new Set(['nm', 'dt']);
  const TODAY = '2026-08-19';

  it('fills the assessor name and today’s date when both are blank and writable', () => {
    const out = applyAssessorSignoff(fields, writable, {}, 'Ash Wyborn', TODAY);
    expect(out).toEqual({ nm: 'Ash Wyborn', dt: TODAY });
  });

  it('never clobbers a value already there', () => {
    const out = applyAssessorSignoff(
      fields,
      writable,
      { nm: 'Someone Else', dt: '2026-01-01' },
      'Ash Wyborn',
      TODAY,
    );
    expect(out).toEqual({ nm: 'Someone Else', dt: '2026-01-01' });
  });

  it('leaves a box the caller may NOT fill alone — the candidate’s record is untouched', () => {
    // Only the date is writable here; the name box belongs to someone else.
    const out = applyAssessorSignoff(fields, new Set(['dt']), {}, 'Ash Wyborn', TODAY);
    expect(out).toEqual({ dt: TODAY });
  });

  it('stamps the date even when the session has no name yet', () => {
    const out = applyAssessorSignoff(fields, writable, {}, '', TODAY);
    expect(out).toEqual({ dt: TODAY });
  });

  it('returns the SAME object when there is nothing to fill, so React can skip the update', () => {
    const values = { nm: 'Ash Wyborn', dt: TODAY };
    expect(applyAssessorSignoff(fields, writable, values, 'Ash Wyborn', TODAY)).toBe(values);
  });

  it('does nothing when the part has no assessor sign-off block', () => {
    const plain = [f({ id: 'q1', type: 'text', label: 'Comment' })];
    const values = {};
    expect(applyAssessorSignoff(plain, new Set(['q1']), values, 'Ash Wyborn', TODAY)).toBe(values);
  });
});
