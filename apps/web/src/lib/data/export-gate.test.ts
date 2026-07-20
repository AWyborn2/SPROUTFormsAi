/**
 * canExportSubmission — the round-trip export gate. Exportability is decided
 * by field positions (`sourcePosition`), never by source-PDF asset presence:
 * AI-extracted forms store the asset but carry no positions, and the server
 * silently skips positionless fields.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { canExportSubmission } from './store.js';

const positioned: FormField = {
  id: 'abn',
  type: 'text',
  label: 'ABN',
  required: true,
  source: 'imported',
  sourcePosition: { page: 0, x: 72, y: 640, width: 180, height: 18, pageWidth: 595, pageHeight: 842 },
};

const positionless: FormField = {
  id: 'notes',
  type: 'textarea',
  label: 'Notes',
  required: false,
  source: 'imported',
};

describe('canExportSubmission', () => {
  it('is true when at least one field carries a sourcePosition', () => {
    expect(canExportSubmission([positionless, positioned])).toBe(true);
  });

  it('is false when no field carries a sourcePosition (AI-extraction path)', () => {
    expect(canExportSubmission([positionless])).toBe(false);
  });

  it('is false for an empty field set', () => {
    expect(canExportSubmission([])).toBe(false);
  });
});
