import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import { MAX_ATTACHMENT_BYTES } from '@formai/shared';

const builderTenant = { userId: 'u1', orgId: 'org-1', role: 'builder' as const };
const otherOrgTenant = { userId: 'u2', orgId: 'org-2', role: 'builder' as const };
let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

/** Unconfigured by default — each test that needs a bucket swaps one in. */
let mockStorage: unknown = null;
vi.mock('../storage/index.js', () => ({
  getStorageClient: () => mockStorage,
}));

const { createApp } = await import('../app.js');
({ sealSession } = await import('../auth/workos.js'));
const { sanitizeFileName } = await import('./uploads.js');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader(tenant: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(tenant)}` };
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 9)]);
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32, 3)]);

/** Fake storage covering the whole `StorageClient` surface. */
function fakeStorage() {
  const uploadAttachment = vi.fn(
    async (orgId: string, _bytes: Uint8Array, _contentType: string, ext: string) =>
      `${orgId}/upload-fixed-uuid.${ext}`,
  );
  const download = vi.fn(async (): Promise<Buffer | null> => PNG_BYTES);
  const client = {
    upload: vi.fn(),
    uploadImage: vi.fn(),
    uploadAttachment,
    download,
    deleteObject: vi.fn(),
    deletePrefix: vi.fn(),
  };
  return { client, uploadAttachment, download };
}

async function postUpload(base: string, tenant: typeof builderTenant | null, body: unknown) {
  return fetch(`${base}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tenant ? authHeader(tenant) : {}) },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  mockStorage = null;
  mockDbValue = null;
  vi.restoreAllMocks();
});

describe('POST /uploads', () => {
  it('stores a PNG and returns a file ref carrying the minted key', async () => {
    const { client, uploadAttachment } = fakeStorage();
    mockStorage = client;
    const { server, base } = startApp();
    try {
      const res = await postUpload(base, builderTenant, {
        fileBase64: PNG_BYTES.toString('base64'),
        mimeType: 'image/png',
        fileName: 'licence.png',
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        kind: 'file',
        key: 'org-1/upload-fixed-uuid.png',
        fileName: 'licence.png',
        contentType: 'image/png',
        size: PNG_BYTES.length,
      });
      // Bytes reach storage under the caller's own org, never a body-supplied one.
      expect(uploadAttachment).toHaveBeenCalledWith(
        'org-1',
        expect.anything(),
        'image/png',
        'png',
      );
    } finally {
      server.close();
    }
  });

  it('accepts JPEG and PDF, the other two intake payloads', async () => {
    const { client } = fakeStorage();
    mockStorage = client;
    const { server, base } = startApp();
    try {
      for (const [bytes, mimeType, ext] of [
        [JPEG_BYTES, 'image/jpeg', 'jpg'],
        [PDF_BYTES, 'application/pdf', 'pdf'],
      ] as const) {
        const res = await postUpload(base, builderTenant, {
          fileBase64: bytes.toString('base64'),
          mimeType,
          fileName: `scan.${ext}`,
        });
        expect(res.status).toBe(201);
        expect(((await res.json()) as { key: string }).key).toBe(
          `org-1/upload-fixed-uuid.${ext}`,
        );
      }
    } finally {
      server.close();
    }
  });

  it('401s without a session — attachments are never anonymous on this door', async () => {
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      const res = await postUpload(base, null, {
        fileBase64: PNG_BYTES.toString('base64'),
        mimeType: 'image/png',
        fileName: 'a.png',
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('refuses a type outside the allow-list', async () => {
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      const res = await postUpload(base, builderTenant, {
        fileBase64: Buffer.from('MZ...').toString('base64'),
        mimeType: 'application/x-msdownload',
        fileName: 'payload.exe',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('unsupported_file_type');
    } finally {
      server.close();
    }
  });

  it('refuses bytes that contradict the declared MIME type', async () => {
    const { client, uploadAttachment } = fakeStorage();
    mockStorage = client;
    const { server, base } = startApp();
    try {
      // A PDF wearing an image/png label — the declared type is a claim, and
      // the magic-number check is what makes it a fact.
      const res = await postUpload(base, builderTenant, {
        fileBase64: PDF_BYTES.toString('base64'),
        mimeType: 'image/png',
        fileName: 'not-really.png',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('unsupported_file_type');
      expect(uploadAttachment).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('413s past the size ceiling', async () => {
    const { client, uploadAttachment } = fakeStorage();
    mockStorage = client;
    const { server, base } = startApp();
    try {
      const oversize = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(MAX_ATTACHMENT_BYTES, 1),
      ]);
      const res = await postUpload(base, builderTenant, {
        fileBase64: oversize.toString('base64'),
        mimeType: 'image/png',
        fileName: 'huge.png',
      });
      expect(res.status).toBe(413);
      expect(uploadAttachment).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('503s when no bucket is configured', async () => {
    const { server, base } = startApp();
    try {
      const res = await postUpload(base, builderTenant, {
        fileBase64: PNG_BYTES.toString('base64'),
        mimeType: 'image/png',
        fileName: 'a.png',
      });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });
});

describe('GET /uploads/file/*', () => {
  async function get(base: string, key: string, tenant: typeof builderTenant | null) {
    return fetch(`${base}/uploads/file/${key}`, {
      headers: tenant ? authHeader(tenant) : undefined,
    });
  }

  it('serves an attachment to its own org', async () => {
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      const res = await get(base, 'org-1/upload-fixed-uuid.png', builderTenant);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      // Private, unlike the immutable public logo objects.
      expect(res.headers.get('cache-control')).toContain('private');
    } finally {
      server.close();
    }
  });

  it('401s an anonymous read — this is the whole reason it is not the logo route', async () => {
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      expect((await get(base, 'org-1/upload-fixed-uuid.png', null)).status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("404s another org's attachment without touching storage", async () => {
    const { client, download } = fakeStorage();
    mockStorage = client;
    const { server, base } = startApp();
    try {
      const res = await get(base, 'org-1/upload-fixed-uuid.png', otherOrgTenant);
      expect(res.status).toBe(404);
      expect(download).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s a key outside the upload namespace, so a logo or PDF id cannot be replayed', async () => {
    const { client, download } = fakeStorage();
    mockStorage = client;
    const { server, base } = startApp();
    try {
      for (const key of [
        'org-1/logo-fixed-uuid.png', // logo namespace
        'org-1/2f8a1c3e-0000-4000-8000-000000000000.pdf', // PDF asset id
        'org-1/nested/upload-x.png', // nesting
      ]) {
        expect((await get(base, key, builderTenant)).status).toBe(404);
      }
      expect(download).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('submissionValueSchema — the file variant', () => {
  it('accepts a ref the upload route could have minted', async () => {
    const { submissionValueSchema } = await import('./submissions.js');
    expect(
      submissionValueSchema.safeParse({
        kind: 'file',
        key: 'org-1/upload-fixed-uuid.png',
        fileName: 'licence.png',
        contentType: 'image/png',
        size: 4096,
      }).success,
    ).toBe(true);
  });

  it('rejects a key outside the upload namespace', async () => {
    const { submissionValueSchema } = await import('./submissions.js');
    for (const key of [
      'org-1/logo-fixed-uuid.png', // another org asset class
      'org-1/2f8a1c3e-0000-4000-8000-000000000000.pdf', // a PDF asset id
      'org-1/nested/upload-x.png', // nesting
      '../../etc/passwd',
    ]) {
      expect(
        submissionValueSchema.safeParse({
          kind: 'file',
          key,
          fileName: 'x.png',
          contentType: 'image/png',
          size: 1,
        }).success,
        `${key} should be rejected`,
      ).toBe(false);
    }
  });

  it('rejects extra keys rather than letting them into the JSONB column', async () => {
    const { submissionValueSchema } = await import('./submissions.js');
    const parsed = submissionValueSchema.safeParse({
      kind: 'file',
      key: 'org-1/upload-fixed-uuid.png',
      fileName: 'licence.png',
      contentType: 'image/png',
      size: 4096,
      smuggled: { deeply: 'nested' },
    });
    expect(parsed.success).toBe(true);
    // Zod strips unknown keys, so the extra payload never reaches the column.
    expect(parsed.success ? Object.keys(parsed.data as object).sort() : []).toEqual([
      'contentType',
      'fileName',
      'key',
      'kind',
      'size',
    ]);
  });

  it('still accepts the ordinary scalar shapes', async () => {
    const { submissionValueSchema } = await import('./submissions.js');
    for (const value of ['text', 7, true, null, ['a', 'b']]) {
      expect(submissionValueSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe('sanitizeFileName', () => {
  it('reduces a traversal attempt to its last segment', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\ash\\licence.png')).toBe('licence.png');
  });

  it('strips control characters and markup/quoting characters', () => {
    expect(sanitizeFileName('lic\u0000en\u001Fce<script>.png')).toBe('licencescript.png');
    expect(sanitizeFileName('a"b|c?d*e`f.png')).toBe('abcdef.png');
  });

  it('keeps ordinary names — including digits — intact', () => {
    expect(sanitizeFileName('IMG_20260713_0522.jpg')).toBe('IMG_20260713_0522.jpg');
  });

  it('falls back rather than returning an empty name', () => {
    expect(sanitizeFileName('<<<>>>')).toBe('attachment');
  });

  it('caps absurd lengths', () => {
    expect(sanitizeFileName(`${'a'.repeat(500)}.png`)).toHaveLength(120);
  });
});
