/**
 * Import session extraction lifecycle — startExtraction drives
 * POST /pdf/upload → POST /pdf/extract with status transitions
 * idle → uploading → extracting → ready | error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractionResult } from '@formai/shared';

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
  fileToBase64,
  getImportSession,
  resetImportSession,
  retryExtraction,
  startExtraction,
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
