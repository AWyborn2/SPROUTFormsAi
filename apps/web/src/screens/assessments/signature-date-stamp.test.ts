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
import { companionDateField, dateFieldToStamp } from './signature-date-stamp.js';

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
