/**
 * Pure helpers for the import review screen. Component rendering is covered by
 * the plan's browser smoke pass (vitest here runs in node without jsdom/RTL).
 */
import { describe, expect, it } from 'vitest';
import { displayTitleFromFileName, offersSignatureRemap } from './ImportReviewScreen.js';

describe('offersSignatureRemap — the flagged-card remap gating (R2/AE2)', () => {
  it('offers the signature remap for a text field', () => {
    expect(offersSignatureRemap({ type: 'text' })).toBe(true);
  });

  it('hides it for a repeating table, where a signature remap is nonsensical', () => {
    expect(offersSignatureRemap({ type: 'repeating_group' })).toBe(false);
  });

  it('hides it for every other non-text type', () => {
    for (const type of ['dropdown', 'checkbox', 'date', 'number', 'section_header'] as const) {
      expect(offersSignatureRemap({ type })).toBe(false);
    }
  });
});

describe('displayTitleFromFileName', () => {
  it('strips the file extension', () => {
    expect(displayTitleFromFileName('Facility Inspection Checklist.pdf')).toBe(
      'Facility Inspection Checklist',
    );
  });

  it('only strips the last extension segment', () => {
    expect(displayTitleFromFileName('site.safety.audit.pdf')).toBe('site.safety.audit');
  });

  it('keeps names without an extension as-is', () => {
    expect(displayTitleFromFileName('inspection-checklist')).toBe('inspection-checklist');
  });

  it('trims surrounding whitespace', () => {
    expect(displayTitleFromFileName('  weekly report .pdf ')).toBe('weekly report');
  });

  it('falls back to a generic title when the name is empty or extension-only', () => {
    expect(displayTitleFromFileName('')).toBe('Imported document');
    expect(displayTitleFromFileName('   ')).toBe('Imported document');
    expect(displayTitleFromFileName('.pdf')).toBe('Imported document');
  });
});
