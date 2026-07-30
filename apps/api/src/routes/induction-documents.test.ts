import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import { CHC_FIELD_IDS, chcIntakeFields, type SubmissionValue } from '@formai/shared';

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

let mockStorage: { download: ReturnType<typeof vi.fn> } | null = null;
vi.mock('../storage/index.js', () => ({
  getStorageClient: () => mockStorage,
}));

const { createApp } = await import('../app.js');
const { sealSession } = await import('../auth/replit-auth.js');

const OWNER = { userId: 'u-owner', orgId: 'org-1', role: 'owner' as const };
const VIEWER = { userId: 'u-viewer', orgId: 'org-1', role: 'viewer' as const };

const PHOTO_KEY = 'org-1/upload-abc123.jpg';
const INTAKE_FIELDS = chcIntakeFields();
const PHOTO_BYTES = Buffer.from('\xff\xd8\xff\xe0 not really a jpeg', 'binary');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader(tenant: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(tenant)}` };
}

function submissionWith(overrides: Record<string, SubmissionValue> = {}) {
  return {
    id: 'sub-1',
    orgId: 'org-1',
    templateId: 'tpl-intake',
    templateVersionId: 'ver-intake',
    submittedByUserId: null,
    submitterName: '',
    submitterEmail: '',
    values: {
      [CHC_FIELD_IDS.firstName]: 'Marlee',
      [CHC_FIELD_IDS.lastName]: 'Okonkwo',
      [CHC_FIELD_IDS.inBeakon]: false,
      [CHC_FIELD_IDS.inductionDate]: '2026-03-16',
      [CHC_FIELD_IDS.photo]: {
        kind: 'file',
        key: PHOTO_KEY,
        fileName: 'marlee.jpg',
        contentType: 'image/jpeg',
        size: 2048,
      },
      ...overrides,
    } as Record<string, SubmissionValue>,
    status: 'submitted',
    flag: '',
    createdAt: new Date('2026-03-01T00:00:00Z'),
  };
}

function fakeDb(submission: unknown) {
  const insertValues = vi.fn();
  const db = {
    query: {
      submissions: { findFirst: vi.fn().mockResolvedValue(submission) },
      formTemplateVersions: {
        findFirst: vi.fn().mockResolvedValue({ id: 'ver-intake', fields: INTAKE_FIELDS }),
      },
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      users: { findFirst: vi.fn().mockResolvedValue({ id: 'u-owner', name: 'Ash Wyborn' }) },
      apiKeys: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
  } as unknown as Db;
  return Object.assign(db, { __insertValues: insertValues }) as Db & {
    __insertValues: ReturnType<typeof vi.fn>;
  };
}

async function mintLink(
  base: string,
  tenant: { userId: string; orgId: string; role: string } = OWNER,
  kind = 'photo',
) {
  const res = await fetch(`${base}/inductions/candidates/sub-1/documents/${kind}`, {
    headers: authHeader(tenant),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
  mockStorage = null;
});

describe('minting a document link', () => {
  it('returns a path, an expiry, and the file metadata — never the storage key', async () => {
    mockDbValue = fakeDb(submissionWith());
    const { server, base } = startApp();
    try {
      const { status, body } = await mintLink(base);
      expect(status).toBe(200);
      expect(body.path).toMatch(/^\/inductions\/documents\/.+/);
      expect(body.fileName).toBe('marlee.jpg');
      expect(body.contentType).toBe('image/jpeg');
      expect(Date.parse(body.expiresAt!)).toBeGreaterThan(Date.now());
      // A URL, not a key — the caller must not learn where the object lives.
      expect(JSON.stringify(body)).not.toContain(PHOTO_KEY);
    } finally {
      server.close();
    }
  });

  it('audits the issue, because a document leaving the system is a security event', async () => {
    const db = fakeDb(submissionWith());
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await mintLink(base);
      const audit = db.__insertValues.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .find((v) => typeof v?.action === 'string');
      expect(audit!.category).toBe('security');
      expect(String(audit!.action)).toContain('document link');
      expect(String(audit!.target)).toContain('marlee.jpg');
    } finally {
      server.close();
    }
  });

  it('refuses a caller who may read inductions but not export them', async () => {
    const db = fakeDb(submissionWith());
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { status } = await mintLink(base, VIEWER);
      expect(status).toBe(403);
      expect(db.__insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s for an unknown kind, a missing document, and another org submission', async () => {
    const { server, base } = startApp();
    try {
      mockDbValue = fakeDb(submissionWith());
      expect((await mintLink(base, OWNER, 'passport')).status).toBe(404);

      mockDbValue = fakeDb(submissionWith({ [CHC_FIELD_IDS.photo]: null }));
      expect((await mintLink(base)).status).toBe(404);

      // The org filter is in the WHERE clause, so a foreign submission misses.
      mockDbValue = fakeDb(undefined);
      expect((await mintLink(base)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('refuses an answer whose key points outside the caller org', async () => {
    mockDbValue = fakeDb(
      submissionWith({
        [CHC_FIELD_IDS.photo]: {
          kind: 'file',
          key: 'org-2/upload-stolen.jpg',
          fileName: 'x.jpg',
          contentType: 'image/jpeg',
          size: 1,
        },
      }),
    );
    const { server, base } = startApp();
    try {
      expect((await mintLink(base)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('redeeming a document link', () => {
  it('serves the bytes to a caller holding only the link', async () => {
    mockDbValue = fakeDb(submissionWith());
    mockStorage = { download: vi.fn().mockResolvedValue(PHOTO_BYTES) };
    const { server, base } = startApp();
    try {
      const { body } = await mintLink(base);
      // No credential of any kind — the token is the whole authority.
      const res = await fetch(`${base}${body.path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/jpeg');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(Buffer.from(await res.arrayBuffer()).equals(PHOTO_BYTES)).toBe(true);
      expect(mockStorage.download).toHaveBeenCalledWith('org-1', PHOTO_KEY);
    } finally {
      server.close();
    }
  });

  it('gives a forged, tampered, or expired token the same opaque 404', async () => {
    mockStorage = { download: vi.fn().mockResolvedValue(PHOTO_BYTES) };
    mockDbValue = fakeDb(submissionWith());
    const { server, base } = startApp();
    try {
      for (const token of [
        'not-a-token',
        'aaa.bbb.ccc',
        // Correctly sealed, but already past its expiry.
        sealSession({ orgId: 'org-1', key: PHOTO_KEY }, -1000),
      ]) {
        const res = await fetch(`${base}/inductions/documents/${encodeURIComponent(token)}`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'not_found' });
      }
      expect(mockStorage.download).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('refuses a sealed token naming an object outside the attachment namespace', async () => {
    // A valid seal is not a licence to read anything — a PDF asset id or a logo
    // key replayed here must miss exactly as a nonexistent object does.
    mockStorage = { download: vi.fn().mockResolvedValue(PHOTO_BYTES) };
    const { server, base } = startApp();
    try {
      for (const key of ['org-1/logo-brand.png', 'org-1/asset-source.pdf', 'org-2/upload-a.jpg']) {
        const token = sealSession({ orgId: 'org-1', key });
        const res = await fetch(`${base}/inductions/documents/${encodeURIComponent(token)}`);
        expect(res.status).toBe(404);
      }
      expect(mockStorage.download).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s when the object is gone from storage', async () => {
    mockDbValue = fakeDb(submissionWith());
    mockStorage = { download: vi.fn().mockResolvedValue(null) };
    const { server, base } = startApp();
    try {
      const { body } = await mintLink(base);
      const res = await fetch(`${base}${body.path}`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
