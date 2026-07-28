/**
 * The ANONYMOUS attachment door — `POST /fill/:token/uploads`.
 *
 * Kept separate from `uploads.test.ts` because the interesting property is
 * different: that door has no session, so the link token is the entire
 * credential and the org must come from the LINK rather than anything the
 * caller can say. These tests exist to hold that line, and to prove the door
 * validates exactly as strictly as the authenticated one.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

let mockStorage: unknown = null;
vi.mock('../storage/index.js', () => ({
  getStorageClient: () => mockStorage,
}));

const { createApp } = await import('../app.js');

const TOKEN = 'tok_0123456789abcdef0123456789ab';

const ACTIVE_LINK = {
  id: 'fl1',
  token: TOKEN,
  orgId: 'org-7',
  templateId: 't1',
  expiresAt: null,
  active: true,
  createdAt: new Date('2026-07-01T00:00:00Z'),
};

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);

function fakeDb(link: unknown): Db {
  return {
    query: { fillLinks: { findFirst: vi.fn().mockResolvedValue(link) } },
  } as unknown as Db;
}

function fakeStorage() {
  const uploadAttachment = vi.fn(
    async (orgId: string, _b: Uint8Array, _c: string, ext: string) =>
      `${orgId}/upload-fixed-uuid.${ext}`,
  );
  const client = {
    upload: vi.fn(),
    uploadImage: vi.fn(),
    uploadAttachment,
    download: vi.fn(),
    deleteObject: vi.fn(),
    deletePrefix: vi.fn(),
  };
  return { client, uploadAttachment };
}

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function post(base: string, token: string, body: unknown) {
  return fetch(`${base}/fill/${token}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const GOOD_BODY = {
  fileBase64: PNG_BYTES.toString('base64'),
  mimeType: 'image/png',
  fileName: 'licence.png',
};

afterEach(() => {
  mockDbValue = null;
  mockStorage = null;
  vi.clearAllMocks();
});

describe('POST /fill/:token/uploads', () => {
  it('stores an attachment against the LINK’s org, with no session at all', async () => {
    const { client, uploadAttachment } = fakeStorage();
    mockStorage = client;
    mockDbValue = fakeDb(ACTIVE_LINK);
    const { server, base } = startApp();
    try {
      const res = await post(base, TOKEN, GOOD_BODY);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        kind: 'file',
        key: 'org-7/upload-fixed-uuid.png',
        fileName: 'licence.png',
        contentType: 'image/png',
        size: PNG_BYTES.length,
      });
      // org-7 comes from the link row — never from the request.
      expect(uploadAttachment).toHaveBeenCalledWith('org-7', expect.anything(), 'image/png', 'png');
    } finally {
      server.close();
    }
  });

  it('404s an unknown token without touching storage', async () => {
    const { client, uploadAttachment } = fakeStorage();
    mockStorage = client;
    mockDbValue = fakeDb(undefined);
    const { server, base } = startApp();
    try {
      expect((await post(base, 'tok_nope', GOOD_BODY)).status).toBe(404);
      expect(uploadAttachment).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s a REVOKED link — a dead link must not stay a live write primitive', async () => {
    const { client, uploadAttachment } = fakeStorage();
    mockStorage = client;
    mockDbValue = fakeDb({ ...ACTIVE_LINK, active: false });
    const { server, base } = startApp();
    try {
      expect((await post(base, TOKEN, GOOD_BODY)).status).toBe(404);
      expect(uploadAttachment).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s an EXPIRED link', async () => {
    const { client, uploadAttachment } = fakeStorage();
    mockStorage = client;
    mockDbValue = fakeDb({ ...ACTIVE_LINK, expiresAt: new Date('2020-01-01T00:00:00Z') });
    const { server, base } = startApp();
    try {
      expect((await post(base, TOKEN, GOOD_BODY)).status).toBe(404);
      expect(uploadAttachment).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('applies the same type and magic-number checks as the authed door', async () => {
    const { client, uploadAttachment } = fakeStorage();
    mockStorage = client;
    mockDbValue = fakeDb(ACTIVE_LINK);
    const { server, base } = startApp();
    try {
      // Disallowed type.
      const wrongType = await post(base, TOKEN, {
        fileBase64: Buffer.from('MZ').toString('base64'),
        mimeType: 'application/x-msdownload',
        fileName: 'payload.exe',
      });
      expect(wrongType.status).toBe(400);

      // Allowed type, contradicted by the bytes.
      const mismatched = await post(base, TOKEN, {
        fileBase64: Buffer.from('%PDF-1.7\n').toString('base64'),
        mimeType: 'image/png',
        fileName: 'not-really.png',
      });
      expect(mismatched.status).toBe(400);

      expect(uploadAttachment).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('accepts a body far larger than the global 2 MB JSON limit', async () => {
    const { client } = fakeStorage();
    mockStorage = client;
    mockDbValue = fakeDb(ACTIVE_LINK);
    const { server, base } = startApp();
    try {
      // ~4 MB of PNG → ~5.4 MB base64, which the global parser would 413.
      const big = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(4 * 1024 * 1024, 1),
      ]);
      const res = await post(base, TOKEN, {
        fileBase64: big.toString('base64'),
        mimeType: 'image/png',
        fileName: 'phone-photo.png',
      });
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });

  it('503s when no bucket is configured', async () => {
    mockDbValue = fakeDb(ACTIVE_LINK);
    const { server, base } = startApp();
    try {
      expect((await post(base, TOKEN, GOOD_BODY)).status).toBe(503);
    } finally {
      server.close();
    }
  });
});
