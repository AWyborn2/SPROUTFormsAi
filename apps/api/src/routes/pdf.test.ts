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

describe('POST /pdf/round-trip', () => {
  it('400s when neither pdfBase64 nor assetId is present', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/round-trip`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ fields: [], values: {} }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('round-trips from inline base64 (existing behavior, unchanged)', async () => {
    mockRoundTripExport.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/round-trip`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ pdfBase64: 'AAA=', fields: [], values: {} }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(mockDownloadPdf).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('round-trips from a storage assetId', async () => {
    mockGetStorageClient.mockReturnValue(fakeStorageClient());
    mockDownloadPdf.mockResolvedValue(Buffer.from('pdf-bytes'));
    mockRoundTripExport.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/pdf/round-trip`, {
        method: 'POST',
        headers: { ...authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: 'org-1/x.pdf', fields: [], values: {} }),
      });
      expect(res.status).toBe(200);
      expect(mockRoundTripExport).toHaveBeenCalledWith(
        expect.objectContaining({ originalPdf: Buffer.from('pdf-bytes') }),
      );
    } finally {
      server.close();
    }
  });
});
