/**
 * store.exportSubmissionPdf — POSTs the round-trip export to /pdf/round-trip.
 * The assetId must be OMITTED when the version has no source PDF (mirrors
 * publishImport), so the API's zod doesn't reject a null.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormField } from '@formai/shared';

// Keep the real ApiError; only mock the request methods used here.
vi.mock('./api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api-client.js')>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      postForBlob: vi.fn(),
    },
  };
});

import { apiClient } from './api-client.js';
import { store } from './store.js';
import type { SubmissionDetail } from './types.js';

const postForBlobMock = vi.mocked(apiClient.postForBlob);

const FIELDS: FormField[] = [
  { id: 'f1', type: 'text', label: 'Auditor name', required: true, source: 'imported' },
];

function detail(overrides: Partial<SubmissionDetail> = {}): SubmissionDetail {
  return {
    id: 'sub-1',
    formId: 'form-1',
    form: 'Site safety audit',
    who: 'Priya Nair',
    email: 'priya@example.com',
    date: 'Just now',
    status: 'submitted',
    flag: '',
    templateVersionId: 'ver-1',
    values: { f1: 'Priya Nair' },
    sourcePdfAssetId: 'asset-123',
    fields: FIELDS,
    ...overrides,
  };
}

beforeEach(() => {
  postForBlobMock.mockReset();
  postForBlobMock.mockResolvedValue(new Blob());
});

describe('store.exportSubmissionPdf', () => {
  it('posts /pdf/round-trip with { assetId, fields, values } when sourcePdfAssetId is set', async () => {
    const d = detail();
    await store.exportSubmissionPdf(d);

    expect(postForBlobMock).toHaveBeenCalledWith('/pdf/round-trip', {
      assetId: 'asset-123',
      fields: d.fields,
      values: d.values,
    });
  });

  it('omits assetId when sourcePdfAssetId is null', async () => {
    const d = detail({ sourcePdfAssetId: null });
    await store.exportSubmissionPdf(d);

    expect(postForBlobMock).toHaveBeenCalledWith('/pdf/round-trip', {
      fields: d.fields,
      values: d.values,
    });
    const body = postForBlobMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('assetId');
  });
});
