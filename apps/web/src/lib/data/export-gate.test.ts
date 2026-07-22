/**
 * canExportSubmission — the round-trip export gate. Exportability is decided
 * by whether a field can be PLACED, never by source-PDF asset presence: a form
 * can hold the asset and still have nowhere recorded to draw, and the server
 * silently skips fields it cannot place.
 *
 * "Placeable" spans both geometry sources — a legacy `sourcePosition` from the
 * AcroForm path, or geometry a reviewer confirmed on an AI-extracted form.
 * Keying on `sourcePosition` alone was a fair proxy only while the second did
 * not exist.
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

/**
 * U6 — the gate now reflects whether anything can be PLACED, not which
 * extraction path produced the form. Before geometry existed, "carries a
 * sourcePosition" was a fair proxy for that; once a reviewer can confirm
 * geometry on an AI-extracted form it is simply the wrong question.
 */
describe('canExportSubmission — geometry, not extraction path', () => {
  const table = (patch: Partial<FormField> = {}): FormField => ({
    id: 'checks',
    type: 'repeating_group',
    label: 'Checks',
    required: false,
    source: 'imported',
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
    ],
    ...patch,
  });

  const GEOMETRY = {
    segments: [
      {
        page: 0,
        x: 40,
        y: 400,
        width: 300,
        height: 40,
        pageWidth: 600,
        pageHeight: 800,
        columnBands: [
          { key: 'item', start: 40, end: 240 },
          { key: 'ok', start: 240, end: 340 },
        ],
        rowBands: [{ key: 'r0', start: 400, end: 440 }],
      },
    ],
  };

  it('an AI-extracted form with confirmed geometry now round-trips', () => {
    // The case the old copy called impossible.
    expect(canExportSubmission([table({ geometry: GEOMETRY })])).toBe(true);
  });

  it('an AI-extracted form with no confirmed geometry still does not', () => {
    expect(canExportSubmission([table()])).toBe(false);
  });

  it('a legacy AcroForm field keeps round-tripping on sourcePosition alone', () => {
    // R14: an existing version must behave exactly as it did before geometry.
    const legacy = table({
      type: 'text',
      columns: undefined,
      sourcePosition: { page: 0, x: 130, y: 680, width: 200, height: 16, pageWidth: 600, pageHeight: 800 },
    });

    expect(canExportSubmission([legacy])).toBe(true);
  });

  it('geometry naming a page beyond the document does not count as placeable', () => {
    const broken = table({ geometry: { segments: [{ ...GEOMETRY.segments[0]!, page: -1 }] } });

    expect(canExportSubmission([broken])).toBe(false);
  });
});
