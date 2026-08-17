import { describe, expect, it, vi } from 'vitest';
import type { ExtractionResult } from '@formai/shared';
import { captureExtraction, type CaptureDb } from './capture.js';

/** A minimal AI-path extraction result to capture. */
function aiResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'dozer.pdf',
    pageCount: 18,
    fields: [
      { id: 'ai_1', label: 'Site name', type: 'text', confidence: 0.9 },
      { id: 'ai_2', label: 'Q1', type: 'radio', confidence: 0.8, options: ['True', 'False'] },
    ],
    designNotes: [],
    ...overrides,
  };
}

/** A stub db that records the inserted row. */
function recordingDb(): { db: CaptureDb; rows: unknown[] } {
  const rows: unknown[] = [];
  const db: CaptureDb = {
    insert: () => ({
      values: async (row: unknown) => {
        rows.push(row);
      },
    }),
  };
  return { db, rows };
}

describe('captureExtraction', () => {
  it('no-ops without a database rather than throwing', async () => {
    await expect(captureExtraction(null, { orgId: 'o', fileName: 'x.pdf', result: aiResult() })).resolves.toBeUndefined();
    await expect(
      captureExtraction(undefined, { orgId: 'o', fileName: 'x.pdf', result: aiResult() }),
    ).resolves.toBeUndefined();
  });

  it('derives path, pageCount and fieldCount off the result', async () => {
    const { db, rows } = recordingDb();

    await captureExtraction(db, {
      orgId: 'org-1',
      assetId: 'asset-1',
      fileName: 'dozer.pdf',
      documentType: 'assessment',
      extractedByUserId: 'user-1',
      model: 'claude-sonnet-5',
      result: aiResult(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: 'org-1',
      assetId: 'asset-1',
      fileName: 'dozer.pdf',
      documentType: 'assessment',
      path: 'ai',
      pageCount: 18,
      model: 'claude-sonnet-5',
      fieldCount: 2,
      extractedByUserId: 'user-1',
    });
  });

  it('maps absent optional fields to null, so the row is always well-formed', async () => {
    const { db, rows } = recordingDb();

    // The inline-base64 path: no asset, no document type, no user, no model.
    await captureExtraction(db, {
      orgId: 'org-1',
      fileName: 'pasted.pdf',
      result: aiResult({ path: 'acroform', pageCount: 1, fields: [] }),
    });

    expect(rows[0]).toMatchObject({
      assetId: null,
      documentType: null,
      extractedByUserId: null,
      model: null,
      path: 'acroform',
      fieldCount: 0,
    });
  });

  it('swallows an insert failure so an import can never fail on capture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db: CaptureDb = {
      insert: () => ({
        values: async () => {
          throw new Error('db exploded');
        },
      }),
    };

    await expect(
      captureExtraction(db, { orgId: 'o', fileName: 'boom.pdf', result: aiResult() }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
