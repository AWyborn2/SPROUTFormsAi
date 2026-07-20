/**
 * Pure helpers for the import review screen. Component rendering is covered by
 * the plan's browser smoke pass (vitest here runs in node without jsdom/RTL).
 */
import { describe, expect, it } from 'vitest';
import { displayTitleFromFileName } from './ImportReviewScreen.js';

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
