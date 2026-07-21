import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
let sealSession: (t: typeof tenant) => string;

const mockExtractForm = vi.fn();
const mockRoundTripExport = vi.fn();
vi.mock('../pdf/index.js', () => ({
  extractForm: (...args: unknown[]) => mockExtractForm(...args),
  roundTripExport: (...args: unknown[]) => mockRoundTripExport(...args),
}));

const mockGetAnthropic = vi.fn(() => undefined);
vi.mock('../anthropic.js', () => ({
  getAnthropic: () => mockGetAnthropic(),
}));

const mockGetStorageClient = vi.fn();
const mockUploadPdf = vi.fn();
const mockDownloadPdf = vi.fn();
vi.mock('../storage/index.js', () => ({
  getStorageClient: () => mockGetStorageClient(),
}));

/** A configured storage client — `mockGetStorageClient.mockReturnValue(fakeStorageClient())`. */
function fakeStorageClient() {
  return { upload: mockUploadPdf, download: mockDownloadPdf };
}

/**
 * The round-trip export reads the submission and its pinned version from the
 * database (U11) — the request body is no longer trusted for fields/values —
 * so this suite needs a db surface like the submissions/fill-link suites.
 */
let mockDbValue: unknown = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

function fakeDb(opts: { submissionsFindFirst?: unknown; formTemplateVersionsFindFirst?: unknown }) {
  const query = {
    submissions: { findFirst: vi.fn().mockResolvedValue(opts.submissionsFindFirst) },
    formTemplateVersions: { findFirst: vi.fn().mockResolvedValue(opts.formTemplateVersionsFindFirst) },
  };
  return { db: { query } as unknown, query };
}

const { createApp } = await import('../app.js');
({ sealSession } = await import('../auth/workos.js'));

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader() {
  return { cookie: `fai_session=${sealSession(tenant)}` };
}

afterEach(() => {
  vi.clearAllMocks();
  mockGetStorageClient.mockReturnValue(null);
  mockGetAnthropic.mockReturnValue(undefined);
  mockDbValue = null;
});

describe('POST /pdf/upload', () => {
  it('503s when storage is unconfigured', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/upload`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ pdfBase64: 'AAA=' }),
      });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('accepts a JSON body larger than the 2 MB global limit (25 MB PDFs base64 to ~34 MB)', async () => {
    mockGetStorageClient.mockReturnValue(fakeStorageClient());
    mockUploadPdf.mockResolvedValue('org-1/big-asset.pdf');

    const { server, base } = startApp();
    try {
      // 3 MB of valid base64 chars — over the global 2 MB parser limit.
      const pdfBase64 = 'A'.repeat(3 * 1024 * 1024);
      const res = await fetch(`${base}/pdf/upload`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ pdfBase64 }),
      });
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });

  it('413s when the body exceeds the 40 MB /pdf limit', async () => {
    mockGetStorageClient.mockReturnValue(fakeStorageClient());
    mockUploadPdf.mockResolvedValue('org-1/too-big.pdf');

    const { server, base } = startApp();
    try {
      const pdfBase64 = 'A'.repeat(41 * 1024 * 1024);
      const res = await fetch(`${base}/pdf/upload`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ pdfBase64 }),
      }).catch(() => null); // server may reset the socket mid-write on oversize bodies
      if (res) expect(res.status).toBe(413);
      expect(mockUploadPdf).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('uploads and returns an assetId', async () => {
    mockGetStorageClient.mockReturnValue(fakeStorageClient());
    mockUploadPdf.mockResolvedValue('org-1/some-asset.pdf');

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/upload`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ pdfBase64: 'AAA=' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { assetId: string };
      expect(body.assetId).toBe('org-1/some-asset.pdf');
      expect(mockUploadPdf).toHaveBeenCalledWith('org-1', expect.any(Buffer));
    } finally {
      server.close();
    }
  });
});

describe('POST /pdf/extract', () => {
  it('400s when neither pdfBase64 nor assetId is present', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/extract`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'a.pdf' }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('400s when both pdfBase64 and assetId are present', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/extract`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'a.pdf', pdfBase64: 'AAA=', assetId: 'org-1/x.pdf' }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('extracts from inline base64 (existing behavior, unchanged)', async () => {
    mockExtractForm.mockResolvedValue({ fields: [], pageCount: 1 });

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/extract`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'a.pdf', pdfBase64: 'AAA=' }),
      });
      expect(res.status).toBe(200);
      expect(mockExtractForm).toHaveBeenCalledTimes(1);
      expect(mockDownloadPdf).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('extracts from a storage assetId, matching the base64 path\'s output shape', async () => {
    mockGetStorageClient.mockReturnValue(fakeStorageClient());
    mockDownloadPdf.mockResolvedValue(Buffer.from('pdf-bytes'));
    mockExtractForm.mockResolvedValue({ fields: [], pageCount: 1 });

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/extract`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'a.pdf', assetId: 'org-1/x.pdf' }),
      });
      expect(res.status).toBe(200);
      expect(mockDownloadPdf).toHaveBeenCalledWith('org-1', 'org-1/x.pdf');
      expect(mockExtractForm).toHaveBeenCalledWith(Buffer.from('pdf-bytes'), expect.anything());
    } finally {
      server.close();
    }
  });

  it('503s for the assetId path when storage is unconfigured', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/extract`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'a.pdf', assetId: 'org-1/x.pdf' }),
      });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('404s when the asset is missing or belongs to another org', async () => {
    mockGetStorageClient.mockReturnValue(fakeStorageClient());
    mockDownloadPdf.mockResolvedValue(null);

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/extract`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'a.pdf', assetId: 'org-2/x.pdf' }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

/**
 * U11 — `POST /pdf/round-trip` is an EVIDENTIARY endpoint. It no longer takes
 * fields or values from the request body: it takes a submission id, loads the
 * stored values and the pinned version's fields server-side, and applies the
 * visibility filter to those. A caller cannot strip `visibleWhen` to unmask a
 * hidden answer, nor substitute values that were never recorded — the export
 * is a render of the RECORD, not of whatever the caller sent.
 */
describe('POST /pdf/round-trip', () => {
  const HIDDEN_FIELDS = [
    { id: 'has_plant', type: 'boolean_yes_no', label: 'Plant?', required: false, source: 'imported' },
    {
      id: 'plant_reg',
      type: 'text',
      label: 'Plant registration',
      required: false,
      source: 'imported',
      visibleWhen: { fieldId: 'has_plant', op: 'equals', value: 'true' },
    },
  ];

  const SUBMISSION = {
    id: 'sub-1',
    orgId: 'org-1',
    templateId: 't1',
    templateVersionId: 'v1',
    values: { has_plant: false, plant_reg: 'STALE-REG' },
  };

  const VERSION = {
    id: 'v1',
    templateId: 't1',
    state: 'published',
    fields: HIDDEN_FIELDS,
    sourcePdfAssetId: 'org-1/source.pdf',
  };

  function post(base: string, body: unknown) {
    return fetch(`${base}/pdf/round-trip`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('400s when submissionId is absent', async () => {
    mockDbValue = fakeDb({}).db;
    const { server, base } = startApp();
    try {
      expect((await post(base, { fields: [], values: {} })).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('404s for a missing or cross-tenant submission', async () => {
    mockDbValue = fakeDb({ submissionsFindFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      expect((await post(base, { submissionId: 'sub-other' })).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('exports from the stored submission and its pinned version, ignoring the body', async () => {
    mockGetStorageClient.mockReturnValue(fakeStorageClient());
    mockDownloadPdf.mockResolvedValue(Buffer.from('pdf-bytes'));
    mockRoundTripExport.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockDbValue = fakeDb({ submissionsFindFirst: SUBMISSION, formTemplateVersionsFindFirst: VERSION }).db;

    const { server, base } = startApp();
    try {
      const res = await post(base, {
        submissionId: 'sub-1',
        // Attacker-supplied: fields with `visibleWhen` stripped, plus values
        // matching no stored submission.
        fields: HIDDEN_FIELDS.map(({ visibleWhen: _drop, ...f }) => f),
        values: { has_plant: true, plant_reg: 'FABRICATED' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(mockDownloadPdf).toHaveBeenCalledWith('org-1', 'org-1/source.pdf');

      const call = mockRoundTripExport.mock.calls[0]![0] as {
        fields: { id: string; visibleWhen?: unknown }[];
        values: Record<string, unknown>;
      };
      // Fields come from the PINNED VERSION with their conditions intact — not
      // from the body, whose copy had `visibleWhen` stripped off. (The
      // exporter then drops the hidden one; see round-trip.test.ts.)
      expect(call.fields.map((f) => f.id)).toEqual(['has_plant', 'plant_reg']);
      expect(call.fields.find((f) => f.id === 'plant_reg')?.visibleWhen).toEqual({
        fieldId: 'has_plant',
        op: 'equals',
        value: 'true',
      });
      // Values come from the stored submission — never from the body.
      expect(call.values).toEqual({ has_plant: false, plant_reg: 'STALE-REG' });
      expect(call.values.plant_reg).not.toBe('FABRICATED');
    } finally {
      server.close();
    }
  });

  it('exports every field of a condition-free version, unchanged from today', async () => {
    mockGetStorageClient.mockReturnValue(fakeStorageClient());
    mockDownloadPdf.mockResolvedValue(Buffer.from('pdf-bytes'));
    mockRoundTripExport.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const plainFields = [
      { id: 'site', type: 'text', label: 'Site', required: true, source: 'imported' },
    ];
    mockDbValue = fakeDb({
      submissionsFindFirst: { ...SUBMISSION, values: { site: 'Warehouse B' } },
      formTemplateVersionsFindFirst: { ...VERSION, fields: plainFields },
    }).db;

    const { server, base } = startApp();
    try {
      expect((await post(base, { submissionId: 'sub-1' })).status).toBe(200);
      const call = mockRoundTripExport.mock.calls[0]![0] as {
        fields: { id: string }[];
        values: Record<string, unknown>;
      };
      expect(call.fields.map((f) => f.id)).toEqual(['site']);
      expect(call.values).toEqual({ site: 'Warehouse B' });
    } finally {
      server.close();
    }
  });

  it('422s when the pinned version has no stored source PDF (nothing to overlay onto)', async () => {
    mockGetStorageClient.mockReturnValue(fakeStorageClient());
    mockDbValue = fakeDb({
      submissionsFindFirst: SUBMISSION,
      formTemplateVersionsFindFirst: { ...VERSION, sourcePdfAssetId: null },
    }).db;

    const { server, base } = startApp();
    try {
      expect((await post(base, { submissionId: 'sub-1' })).status).toBe(422);
      expect(mockRoundTripExport).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('503s when storage is unconfigured', async () => {
    mockDbValue = fakeDb({ submissionsFindFirst: SUBMISSION, formTemplateVersionsFindFirst: VERSION }).db;
    const { server, base } = startApp();
    try {
      expect((await post(base, { submissionId: 'sub-1' })).status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('503s when the database is unavailable', async () => {
    mockDbValue = null;
    const { server, base } = startApp();
    try {
      expect((await post(base, { submissionId: 'sub-1' })).status).toBe(503);
    } finally {
      server.close();
    }
  });
});
