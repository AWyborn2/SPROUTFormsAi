/**
 * store.exportSubmissionPdf — POSTs the round-trip export to /pdf/round-trip.
 * The assetId must be OMITTED when the version has no source PDF (mirrors
 * publishImport), so the API's zod doesn't reject a null.
 *
 * Plus the form-lifecycle methods (delete / archive / restore / version
 * publish / re-extract version create): each must hit the right path + verb
 * with the right body, and surface ApiError with status AND body error code
 * intact — the templates screen branches its dialog copy on the code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormField } from '@formai/shared';

// Keep the real ApiError; only mock the request methods used here.
vi.mock('./api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api-client.js')>();
  return {
    ...actual,
    uploadAttachment: vi.fn(),
    apiClient: {
      ...actual.apiClient,
      postForBlob: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    },
  };
});

import { ApiError, apiClient, uploadAttachment } from './api-client.js';
import { store } from './store.js';
import type { SubmissionDetail } from './types.js';

const postForBlobMock = vi.mocked(apiClient.postForBlob);
const postMock = vi.mocked(apiClient.post);
const deleteMock = vi.mocked(apiClient.delete);
const uploadAttachmentMock = vi.mocked(uploadAttachment);

const SUMMARY_DTO = {
  id: 'form-1',
  name: 'Site safety audit',
  dept: 'Ops',
  sourceType: 'pdf_import',
  status: 'published',
  currentVersionId: 'ver-1',
  currentVersionLabel: 'v1',
  submissionsCount: 0,
  updatedAt: '2026-07-01T00:00:00.000Z',
};

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
    submittedBy: null,
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

/**
 * U11 — the export is evidentiary: the client sends only the submission id and
 * the server loads the pinned version's fields and the stored values itself.
 * Sending fields/values from the browser would let a caller unmask a hidden
 * answer (post the same fields with `visibleWhen` stripped) or export values
 * matching no stored submission at all.
 */
describe('store.exportSubmissionPdf', () => {
  it('posts /pdf/round-trip with the submission id only', async () => {
    const d = detail();
    await store.exportSubmissionPdf(d);

    expect(postForBlobMock).toHaveBeenCalledWith('/pdf/round-trip', { submissionId: 'sub-1' });
  });

  it('never sends fields or values — the server owns both', async () => {
    await store.exportSubmissionPdf(detail());
    const body = postForBlobMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('fields');
    expect(body).not.toHaveProperty('values');
    expect(body).not.toHaveProperty('assetId');
  });
});

describe('form lifecycle methods', () => {
  beforeEach(() => {
    postMock.mockReset();
    deleteMock.mockReset();
    postMock.mockResolvedValue(SUMMARY_DTO);
    deleteMock.mockResolvedValue(undefined);
  });

  it('deleteForm DELETEs /forms/:id and resolves void', async () => {
    await expect(store.deleteForm('form-1')).resolves.toBeUndefined();
    expect(deleteMock).toHaveBeenCalledWith('/forms/form-1');
  });

  it('deleteForm surfaces ApiError with status AND body error code for dialog branching', async () => {
    deleteMock.mockRejectedValue(new ApiError(409, { error: 'form_has_submissions' }));
    const err = await store.deleteForm('form-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect(((err as ApiError).body as { error: string }).error).toBe('form_has_submissions');
  });

  it('archiveForm POSTs /forms/:id/archive and maps the summary', async () => {
    const summary = await store.archiveForm('form-1');
    expect(postMock).toHaveBeenCalledWith('/forms/form-1/archive', {});
    expect(summary).toMatchObject({ id: 'form-1', status: 'published' });
  });

  it('restoreForm POSTs /forms/:id/restore', async () => {
    await store.restoreForm('form-1');
    expect(postMock).toHaveBeenCalledWith('/forms/form-1/restore', {});
  });

  it('publishFormVersion POSTs /forms/:id/versions/:versionId/publish', async () => {
    await store.publishFormVersion({ formId: 'form-1', versionId: 'ver-2' });
    expect(postMock).toHaveBeenCalledWith('/forms/form-1/versions/ver-2/publish', {});
  });

  it('createVersionFromImport sends fields + sourcePdfAssetId + publish to the versions endpoint', async () => {
    await store.createVersionFromImport({
      formId: 'form-1',
      fields: FIELDS,
      sourcePdfAssetId: 'asset-new',
      publish: false,
    });
    expect(postMock).toHaveBeenCalledWith('/forms/form-1/versions', {
      fields: FIELDS,
      sourcePdfAssetId: 'asset-new',
      publish: false,
    });
  });

  it('createVersionFromImport omits sourcePdfAssetId when absent (inherit-from-previous stays intact)', async () => {
    await store.createVersionFromImport({ formId: 'form-1', fields: FIELDS, publish: true });
    const body = postMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('sourcePdfAssetId');
    expect(body).toMatchObject({ publish: true });
  });
});

/**
 * The geometry editor's client surface.
 *
 * Shape drift here surfaces to a user as an unexplained 400 or as placement
 * silently not saving, so the request shapes are pinned rather than inferred.
 */
describe('version placement editing', () => {
  const FIELDS: FormField[] = [
    { id: 'ai_137', type: 'checkbox_group', label: 'Steering', required: false, source: 'imported' },
  ];

  it('reads ONE version, not the form’s current one', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ id: 'v3', fields: [] });
    await store.formVersion({ formId: 'f1', versionId: 'v3' });

    // /forms/f1 would serve whichever version is current — the wrong answer
    // while editing a draft fork.
    expect(apiClient.get).toHaveBeenCalledWith('/forms/f1/versions/v3');
  });

  it('PATCHes fields onto a specific version', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ id: 'v3', state: 'draft', fieldCount: 1 });
    await store.saveVersionFields({ formId: 'f1', versionId: 'v3', fields: FIELDS });

    expect(apiClient.patch).toHaveBeenCalledWith('/forms/f1/versions/v3', { fields: FIELDS });
  });

  it('forks a DRAFT — never publishing — and returns the new version id', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      id: 'f1',
      name: 'Track Dozer',
      versions: [],
      createdVersionId: 'v4',
    });
    const res = await store.forkDraftVersion({ formId: 'f1', fields: FIELDS });

    // publish:false is load-bearing — forking must not flip every live fill
    // link to a half-placed version.
    expect(apiClient.post).toHaveBeenCalledWith('/forms/f1/versions', {
      fields: FIELDS,
      publish: false,
    });
    // The id comes back explicitly rather than being guessed from a refetch.
    expect(res.versionId).toBe('v4');
  });

  it('carries the same field ids into the fork', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ id: 'f1', name: 'x', versions: [], createdVersionId: 'v4' });
    await store.forkDraftVersion({ formId: 'f1', fields: FIELDS });

    // The whole reason this exists instead of a re-import: an assessment tool's
    // manifest, answer keys and outcome targets are keyed to these ids.
    // `lastCall`, not `calls[0]` — only postForBlob is reset between tests here,
    // so `post` accumulates calls from earlier ones.
    const [, body] = vi.mocked(apiClient.post).mock.lastCall as [string, { fields: FormField[] }];
    expect(body.fields.map((f) => f.id)).toEqual(['ai_137']);
  });
});

describe('assessment-builder drafts', () => {
  /*
    The routes have existed since the draft table did; nothing in the UI called
    them, so an author who left the builder half-way had no route back in.

    THESE TWO TESTS USED TO ASSERT `/builder-drafts` — the source FILE's name,
    not the mount path, which `app.ts` sets to `/assessment-tool-drafts`. They
    passed because the store had the same mistake, so the pair agreed with each
    other and disagreed with the server. Every list 404'd, `rows.length === 0`
    was always true, and "Pick up where you left off" rendered nothing on a
    workspace that had drafts to resume.
  */
  it('listBuilderDrafts GETs the mounted path', async () => {
    await store.listBuilderDrafts();
    expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith('/assessment-tool-drafts');
  });

  it('getBuilderDraft GETs one draft, which is the read that carries state', async () => {
    await store.getBuilderDraft('draft-1');
    expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith('/assessment-tool-drafts/draft-1');
  });

  it('saveBuilderDraft POSTs to the mounted path', async () => {
    const input = { name: 'Mine Site SME Theory', assetId: 'asset-1', state: {} };
    await store.saveBuilderDraft(input);
    expect(vi.mocked(apiClient.post)).toHaveBeenCalledWith('/assessment-tool-drafts', input);
  });

  it('discardBuilderDraft DELETEs the mounted path', async () => {
    await store.discardBuilderDraft('draft-1');
    expect(deleteMock).toHaveBeenCalledWith('/assessment-tool-drafts/draft-1');
  });
});

describe('granting a competency by hand', () => {
  /*
    Same story as the drafts above: POST /competencies/:id/holders had existed
    since the holders table did — shared with the sign-off auto-grant — and no
    client code ever called it, so a competency nobody earns through an
    assessment (a sighted driver's licence) could never be recorded at all.
  */
  it('grantCompetency POSTs the holder onto the competency', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ competencyId: 'c1', holders: 1 });
    await store.grantCompetency({ competencyId: 'c1', userId: 'u1' });

    expect(vi.mocked(apiClient.post)).toHaveBeenLastCalledWith('/competencies/c1/holders', {
      userId: 'u1',
    });
  });

  it('sends expiry and evidence only when given — the zod body rejects nulls', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ competencyId: 'c1', holders: 1 });
    await store.grantCompetency({
      competencyId: 'c1',
      userId: 'u1',
      evidenceRef: 'Licence sighted at induction',
      expiresAt: '2027-03-15T23:59:59.000Z',
    });

    expect(vi.mocked(apiClient.post)).toHaveBeenLastCalledWith('/competencies/c1/holders', {
      userId: 'u1',
      evidenceRef: 'Licence sighted at induction',
      expiresAt: '2027-03-15T23:59:59.000Z',
    });
  });

  /*
    Renewing a lapsed ticket files the new licence against the HOLDING, keyed on
    the grant row's id — a different door from the by-competency grant above, and
    the one with zero client code before task #43.
  */
  it('uploadCompetencyEvidence streams the file to the holding’s document endpoint', async () => {
    uploadAttachmentMock.mockResolvedValue({ id: 'doc-1', fileName: 'licence.pdf' });
    const file = new File(['%PDF-1.4'], 'licence.pdf', { type: 'application/pdf' });
    const onProgress = vi.fn();

    const res = await store.uploadCompetencyEvidence('holder-9', file, onProgress);

    expect(uploadAttachmentMock).toHaveBeenCalledWith(
      '/competency-documents/holder-9',
      file,
      onProgress,
    );
    expect(res).toEqual({ id: 'doc-1', fileName: 'licence.pdf' });
  });
});
