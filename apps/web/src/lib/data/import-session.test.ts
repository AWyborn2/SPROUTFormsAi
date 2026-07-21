/**
 * Import session extraction lifecycle — startExtraction drives
 * POST /pdf/upload → POST /pdf/extract with status transitions
 * idle → uploading → extracting → ready | error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedField, ExtractionResult } from '@formai/shared';

// The real ApiError class is kept (error mapping relies on instanceof);
// only the request methods are mocked.
vi.mock('./api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api-client.js')>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      post: vi.fn(),
    },
  };
});

// Guard: the fixture path must never be consulted by this module again.
vi.mock('./store.js', () => ({
  store: {
    importDraft: () => {
      throw new Error('fixture path (store.importDraft) must not be used by import-session');
    },
  },
}));

import { apiClient, ApiError } from './api-client.js';
import {
  addFixedRowItem,
  fileToBase64,
  getImportSession,
  lowestUnresolvedField,
  removeFixedRowItem,
  renameFixedRowItem,
  resetImportSession,
  retryExtraction,
  reviewedToFields,
  setFieldRequired,
  startExtraction,
  type ReviewField,
} from './import-session.js';

const postMock = vi.mocked(apiClient.post);

const EXTRACTION: ExtractionResult = {
  sourceType: 'pdf_import',
  path: 'acroform',
  fileName: 'site-safety-audit.pdf',
  pageCount: 3,
  fields: [
    { id: 'f1', label: 'Auditor name', type: 'text', confidence: 0.98 },
    { id: 'f2', label: 'Signature', type: 'text', confidence: 0.4 },
  ],
  designNotes: ['Signature block detected as plain text'],
};

function makeFile(name = 'site-safety-audit.pdf'): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name, {
    type: 'application/pdf',
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  postMock.mockReset();
  resetImportSession();
});

describe('fileToBase64', () => {
  it('encodes the file bytes as base64', async () => {
    expect(await fileToBase64(makeFile())).toBe('JVBERi0='); // "%PDF-"
  });
});

describe('startExtraction', () => {
  it('walks idle → uploading → extracting → ready and exposes the real extraction', async () => {
    expect(getImportSession().status).toBe('idle');

    const upload = deferred<{ assetId: string }>();
    const extract = deferred<ExtractionResult>();
    postMock.mockImplementationOnce(() => upload.promise as Promise<never>);
    postMock.mockImplementationOnce(() => extract.promise as Promise<never>);

    const done = startExtraction(makeFile());
    await vi.waitFor(() => expect(getImportSession().status).toBe('uploading'));

    upload.resolve({ assetId: 'asset-123' });
    await vi.waitFor(() => expect(getImportSession().status).toBe('extracting'));
    expect(getImportSession().assetId).toBe('asset-123');

    extract.resolve(EXTRACTION);
    await done;

    const session = getImportSession();
    expect(session.status).toBe('ready');
    expect(session.fileName).toBe('site-safety-audit.pdf');
    expect(session.pageCount).toBe(3);
    expect(session.designNotes).toEqual(EXTRACTION.designNotes);
    expect(session.fields.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(session.extraction).toEqual(EXTRACTION);
    expect(session.error).toBeNull();

    expect(postMock).toHaveBeenNthCalledWith(1, '/pdf/upload', { pdfBase64: 'JVBERi0=' });
    expect(postMock).toHaveBeenNthCalledWith(2, '/pdf/extract', {
      assetId: 'asset-123',
      fileName: 'site-safety-audit.pdf',
    });
  });

  it('maps a 422 extraction_unavailable on extract to the AI-unavailable message, keeping the file name', async () => {
    postMock.mockResolvedValueOnce({ assetId: 'asset-123' });
    postMock.mockRejectedValueOnce(
      new ApiError(422, { error: 'extraction_unavailable: no ANTHROPIC_API_KEY configured' }),
    );

    await startExtraction(makeFile());

    const session = getImportSession();
    expect(session.status).toBe('error');
    expect(session.error).toBe(
      "This PDF needs AI extraction, which isn't configured on the server yet.",
    );
    expect(session.fileName).toBe('site-safety-audit.pdf');
  });

  it('maps a 503 on upload to the storage-unavailable message', async () => {
    postMock.mockRejectedValueOnce(new ApiError(503, { error: 'storage_unavailable' }));

    await startExtraction(makeFile());

    const session = getImportSession();
    expect(session.status).toBe('error');
    expect(session.error).toBe("File storage isn't available right now — try again shortly.");
    expect(session.fileName).toBe('site-safety-audit.pdf');
  });

  it('maps a 413 to the file-too-large message', async () => {
    postMock.mockRejectedValueOnce(new ApiError(413, undefined));

    await startExtraction(makeFile());

    expect(getImportSession().status).toBe('error');
    expect(getImportSession().error).toBe(
      'This PDF is too large to import — the limit is 25 MB.',
    );
  });

  it('maps any other failure to a generic message', async () => {
    postMock.mockRejectedValueOnce(new TypeError('network down'));

    await startExtraction(makeFile());

    expect(getImportSession().status).toBe('error');
    expect(getImportSession().error).toBe(
      'Something went wrong importing this PDF. Please try again.',
    );
  });
});

describe('retryExtraction', () => {
  it('re-runs the pipeline with the held file bytes after an error', async () => {
    postMock.mockRejectedValueOnce(new ApiError(503, { error: 'storage_unavailable' }));
    await startExtraction(makeFile());
    expect(getImportSession().status).toBe('error');

    postMock.mockResolvedValueOnce({ assetId: 'asset-456' });
    postMock.mockResolvedValueOnce(EXTRACTION);
    await retryExtraction();

    const session = getImportSession();
    expect(session.status).toBe('ready');
    expect(session.assetId).toBe('asset-456');
    expect(session.fields).toHaveLength(2);
    expect(postMock).toHaveBeenLastCalledWith('/pdf/extract', {
      assetId: 'asset-456',
      fileName: 'site-safety-audit.pdf',
    });
  });

  it('is a no-op when nothing was ever started', async () => {
    await retryExtraction();
    expect(getImportSession().status).toBe('idle');
    expect(postMock).not.toHaveBeenCalled();
  });
});

// --- Review UX pure logic (U5) ---------------------------------------------

function reviewField(overrides: Partial<ReviewField> & { id: string }): ReviewField {
  return { label: overrides.id, type: 'text', confidence: 0.9, ...overrides };
}

const CHECKLIST: ExtractedField = {
  id: 'chk',
  label: 'Category A checks',
  type: 'repeating_group',
  confidence: 0.8,
  columns: [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'checkbox' },
    { key: 'na', label: 'NA', type: 'checkbox' },
  ],
  fixedRows: ['Engine oil level', 'Park brake', 'Tyres'],
};

/** Seed the session store with the given extracted fields via the real pipeline. */
async function seedSession(fields: ExtractedField[]): Promise<void> {
  postMock.mockResolvedValueOnce({ assetId: 'asset-seed' });
  postMock.mockResolvedValueOnce({ ...EXTRACTION, fields });
  await startExtraction(makeFile());
  expect(getImportSession().status).toBe('ready');
}

describe('lowestUnresolvedField', () => {
  it('returns the lowest-confidence field among unresolved fields only (KTD8)', () => {
    const fields: ReviewField[] = [
      reviewField({ id: 'a', confidence: 0.4, resolved: true }),
      reviewField({ id: 'b', confidence: 0.7 }),
      reviewField({ id: 'c', confidence: 0.9 }),
    ];
    expect(lowestUnresolvedField(fields)?.id).toBe('b');
  });

  it('is null when every field is resolved (stat hidden)', () => {
    const fields: ReviewField[] = [
      reviewField({ id: 'a', confidence: 0.4, resolved: true }),
      reviewField({ id: 'b', confidence: 0.99, resolved: true }),
    ];
    expect(lowestUnresolvedField(fields)).toBeNull();
  });

  it('is null for an empty field list', () => {
    expect(lowestUnresolvedField([])).toBeNull();
  });
});

describe('reviewedToFields — required + fixedRows (R4/AE5)', () => {
  it('defaults an untouched fixed-row checklist to required: true and passes fixedRows through', () => {
    const out = reviewedToFields([{ ...CHECKLIST }])[0]!;
    expect(out.required).toBe(true);
    expect(out.fixedRows).toEqual(['Engine oil level', 'Park brake', 'Tyres']);
  });

  it('carries a reviewer untoggle through (required: false wins over the checklist default)', () => {
    const out = reviewedToFields([{ ...CHECKLIST, required: false }])[0]!;
    expect(out.required).toBe(false);
  });

  it('defaults a non-checklist field to required: false and a toggle to true', () => {
    const fields = reviewedToFields([
      reviewField({ id: 'a' }),
      reviewField({ id: 'b', required: true }),
    ]);
    expect(fields[0]!.required).toBe(false);
    expect(fields[1]!.required).toBe(true);
  });

  it('omits fixedRows for open row-entry tables', () => {
    const out = reviewedToFields([{ ...CHECKLIST, fixedRows: undefined }])[0]!;
    expect(out.required).toBe(false); // no fixedRows → not a checklist → plain default
    expect('fixedRows' in out).toBe(false);
  });
});

describe('review actions — required toggle + fixed-row item editing', () => {
  it('setFieldRequired writes into the reviewed field state', async () => {
    await seedSession([{ ...CHECKLIST }]);

    setFieldRequired('chk', false);
    expect(getImportSession().fields[0]!.required).toBe(false);

    setFieldRequired('chk', true);
    expect(getImportSession().fields[0]!.required).toBe(true);
  });

  it('renameFixedRowItem renames one label order-stably', async () => {
    await seedSession([{ ...CHECKLIST }]);

    renameFixedRowItem('chk', 1, 'Park brake operation');
    expect(getImportSession().fields[0]!.fixedRows).toEqual([
      'Engine oil level',
      'Park brake operation',
      'Tyres',
    ]);
  });

  it('renameFixedRowItem ignores out-of-range indices', async () => {
    await seedSession([{ ...CHECKLIST }]);

    renameFixedRowItem('chk', 3, 'nope');
    renameFixedRowItem('chk', -1, 'nope');
    expect(getImportSession().fields[0]!.fixedRows).toEqual(CHECKLIST.fixedRows);
  });

  it('addFixedRowItem appends after the existing items', async () => {
    await seedSession([{ ...CHECKLIST }]);

    addFixedRowItem('chk', 'Horn');
    expect(getImportSession().fields[0]!.fixedRows).toEqual([
      'Engine oil level',
      'Park brake',
      'Tyres',
      'Horn',
    ]);
  });

  it('removeFixedRowItem removes one item keeping the rest in order', async () => {
    await seedSession([{ ...CHECKLIST }]);

    removeFixedRowItem('chk', 0);
    expect(getImportSession().fields[0]!.fixedRows).toEqual(['Park brake', 'Tyres']);
  });

  it('removing the last item normalizes fixedRows to undefined (never an empty array)', async () => {
    await seedSession([{ ...CHECKLIST, fixedRows: ['Only item'] }]);

    removeFixedRowItem('chk', 0);
    expect(getImportSession().fields[0]!.fixedRows).toBeUndefined();
  });
});

describe('field-editor backing (U2) — extraction metadata survives edits', () => {
  it('keeps confidence and note when a reducer edit changes the field', async () => {
    await seedSession([{ ...CHECKLIST, confidence: 0.42, note: 'Low-confidence table' }]);

    setFieldRequired('chk', false);

    const field = getImportSession().fields[0]!;
    expect(field.confidence).toBe(0.42);
    expect(field.note).toBe('Low-confidence table');
    expect(field.required).toBe(false);
  });

  it('carries answerSets from extraction through to the published field', async () => {
    await seedSession([
      { ...CHECKLIST, answerSets: [{ key: 'verdict', columnKeys: ['ok', 'na'] }] },
    ]);

    expect(getImportSession().fields[0]!.answerSets).toEqual([
      { key: 'verdict', columnKeys: ['ok', 'na'] },
    ]);
    expect(reviewedToFields(getImportSession().fields)[0]!.answerSets).toEqual([
      { key: 'verdict', columnKeys: ['ok', 'na'] },
    ]);
  });

  it('resolves the checklist required default at seed time, matching what publish would produce', async () => {
    await seedSession([{ ...CHECKLIST }]);

    // The reviewer sees the same value that ships, rather than a blank that
    // silently becomes `true` at publish.
    expect(getImportSession().fields[0]!.required).toBe(true);
    expect(reviewedToFields(getImportSession().fields)[0]!.required).toBe(true);
  });

  it('drops metadata for a field that is no longer in the editor', async () => {
    await seedSession([{ ...CHECKLIST, note: 'Confirm this table' }]);

    expect(getImportSession().fields).toHaveLength(1);
    resetImportSession();
    expect(getImportSession().fields).toHaveLength(0);
  });

  it('leaves an untouched extraction publishing exactly what it extracted', async () => {
    const source: ExtractedField = { ...CHECKLIST };
    await seedSession([source]);

    const published = reviewedToFields(getImportSession().fields)[0]!;
    expect(published.id).toBe(source.id);
    expect(published.label).toBe(source.label);
    expect(published.type).toBe(source.type);
    expect(published.columns).toEqual(source.columns);
    expect(published.fixedRows).toEqual(source.fixedRows);
    expect(published.source).toBe('imported');
    // Extraction-only metadata never reaches the published field.
    expect('note' in published).toBe(false);
    expect('resolved' in published).toBe(false);
  });
});

describe('resetImportSession', () => {
  it('returns to idle with zero fields and no fixture data', async () => {
    postMock.mockResolvedValueOnce({ assetId: 'asset-123' });
    postMock.mockResolvedValueOnce(EXTRACTION);
    await startExtraction(makeFile());
    expect(getImportSession().status).toBe('ready');

    resetImportSession();

    const session = getImportSession();
    expect(session.status).toBe('idle');
    expect(session.fields).toEqual([]);
    expect(session.fileName).toBe('');
    expect(session.pageCount).toBe(0);
    expect(session.designNotes).toEqual([]);
    expect(session.assetId).toBeNull();
    expect(session.extraction).toBeNull();
    expect(session.error).toBeNull();
  });
});
