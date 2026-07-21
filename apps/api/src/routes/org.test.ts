import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';
import type { BrandingKit } from '@formai/shared';

const ownerTenant = { userId: 'u1', orgId: 'org-1', role: 'owner' as const };
const adminTenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
const builderTenant = { userId: 'u1', orgId: 'org-1', role: 'builder' as const };
const viewerTenant = { userId: 'u1', orgId: 'org-1', role: 'viewer' as const };
let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

/**
 * Storage is unconfigured by default (mirroring a deployment with no bucket
 * credentials); the logo tests swap in a fake client per-test.
 */
let mockStorage: unknown = null;
vi.mock('../storage/index.js', () => ({
  getStorageClient: () => mockStorage,
}));

const { createApp } = await import('../app.js');
({ sealSession } = await import('../auth/workos.js'));

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader(tenant: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(tenant)}` };
}

const ORG_ROW = {
  id: 'org-1',
  name: 'Old Name',
  plan: 'Business',
  branding: {
    logoAssetUrl: null,
    primaryColor: '#253439',
    secondaryColor: '#7c898b',
    accentColor: '#6ec792',
    formFont: 'Inter',
  } as BrandingKit,
};

const NEW_KIT: BrandingKit = {
  logoAssetUrl: null,
  primaryColor: '#112233',
  secondaryColor: '#445566',
  accentColor: '#778899',
  formFont: 'Sora',
};

/**
 * Minimal drizzle-surface mock for `PATCH /org`: `organizations.findFirst`
 * loads the tenant's row, `update(...).set(...).where(...)` captures the
 * write, `insert(...).values(...)` captures the audit entry, and
 * `users.findFirst` feeds `recordAudit`'s actor lookup.
 *
 * The `where(...)` result is both awaitable and `.returning()`-able, because
 * the onboarding stamp is a conditional UPDATE whose matched-row count is the
 * idempotency signal. `opts.stampRaceLost` makes that UPDATE match zero rows,
 * standing in for a concurrent PATCH that stamped first.
 */
function fakeDb(opts: { org?: unknown; stampRaceLost?: boolean } = { org: ORG_ROW }) {
  const updateSet = vi.fn();
  const insertValues = vi.fn();
  const db = {
    query: {
      organizations: { findFirst: vi.fn().mockResolvedValue(opts.org) },
      users: { findFirst: vi.fn().mockResolvedValue({ id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' }) },
    },
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => ({
        where: (_w: unknown) => {
          updateSet(table, v);
          const settled = Promise.resolve(undefined);
          return Object.assign(settled, {
            returning: (_cols?: unknown) =>
              Promise.resolve(
                opts.stampRaceLost
                  ? []
                  : [{ onboardingCompletedAt: (v as { onboardingCompletedAt?: Date }).onboardingCompletedAt ?? null }],
              ),
          });
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        return Promise.resolve(undefined);
      },
    })),
  } as unknown as Db;
  return { db, updateSet, insertValues };
}

async function patchOrg(base: string, tenant: { userId: string; orgId: string; role: string }, body: unknown) {
  return fetch(`${base}/org`, {
    method: 'PATCH',
    headers: { ...authHeader(tenant), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
  mockStorage = null;
});

// ── Logo upload fixtures ──────────────────────────────────────────────────

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 3)]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>');

/** Fake storage client covering the whole `StorageClient` surface. */
function fakeStorage(over: { deleteObject?: () => Promise<void> } = {}) {
  const uploadImage = vi.fn(
    async (orgId: string, _bytes: Uint8Array, mimeType: string) =>
      `${orgId}/logo-fixed-uuid.${mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'}`,
  );
  const download = vi.fn(async (): Promise<Buffer | null> => PNG_BYTES);
  const deleteObject = vi.fn(over.deleteObject ?? (async () => {}));
  const client = {
    upload: vi.fn(),
    download,
    deletePrefix: vi.fn(),
    uploadImage,
    deleteObject,
  };
  return { client, uploadImage, download, deleteObject };
}

async function postLogo(
  base: string,
  tenant: { userId: string; orgId: string; role: string },
  body: unknown,
) {
  return fetch(`${base}/org/logo`, {
    method: 'POST',
    headers: { ...authHeader(tenant), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /org/logo', () => {
  it('503s storage_unavailable when no storage backend is configured', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await postLogo(base, ownerTenant, {
        imageBase64: PNG_BYTES.toString('base64'),
        mimeType: 'image/png',
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage_unavailable' });
    } finally {
      server.close();
    }
  });

  it('uploads a PNG within the cap, returns a public-route URL, audits, and the URL round-trips through PATCH /org', async () => {
    const { db, updateSet, insertValues } = fakeDb();
    mockDbValue = db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await postLogo(base, ownerTenant, {
        imageBase64: PNG_BYTES.toString('base64'),
        mimeType: 'image/png',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { url: string };
      expect(body.url).toBe('/api/assets/logo/org-1/logo-fixed-uuid.png');
      expect(storage.uploadImage).toHaveBeenCalledTimes(1);
      expect(storage.uploadImage.mock.calls[0]?.[0]).toBe('org-1');
      expect(storage.uploadImage.mock.calls[0]?.[2]).toBe('image/png');

      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({ category: 'settings' });

      // The returned URL is accepted by PATCH /org branding and echoed back.
      const kit: BrandingKit = { ...NEW_KIT, logoAssetUrl: body.url };
      const patched = await patchOrg(base, ownerTenant, { branding: kit });
      expect(patched.status).toBe(200);
      const patchedBody = (await patched.json()) as { branding: BrandingKit };
      expect(patchedBody.branding.logoAssetUrl).toBe(body.url);
      expect(updateSet.mock.calls.at(-1)?.[1]).toEqual({ branding: kit });
    } finally {
      server.close();
    }
  });

  it('rejects an oversized payload with a 4xx and never touches storage', async () => {
    mockDbValue = fakeDb().db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const big = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(3 * 1024 * 1024, 1),
      ]);
      const res = await postLogo(base, ownerTenant, {
        imageBase64: big.toString('base64'),
        mimeType: 'image/png',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'file_too_large' });
      expect(storage.uploadImage).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('rejects PDF bytes declared as image/png via the magic-byte check', async () => {
    mockDbValue = fakeDb().db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await postLogo(base, ownerTenant, {
        imageBase64: PDF_BYTES.toString('base64'),
        mimeType: 'image/png',
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'unsupported_image_type',
      });
      expect(storage.uploadImage).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('rejects image/svg+xml — SVG never reaches storage', async () => {
    mockDbValue = fakeDb().db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await postLogo(base, ownerTenant, {
        imageBase64: SVG_BYTES.toString('base64'),
        mimeType: 'image/svg+xml',
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'unsupported_image_type',
      });
      expect(storage.uploadImage).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('403s a viewer and a builder without touching storage', async () => {
    mockDbValue = fakeDb().db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      for (const tenant of [viewerTenant, builderTenant]) {
        const res = await postLogo(base, tenant, {
          imageBase64: PNG_BYTES.toString('base64'),
          mimeType: 'image/png',
        });
        expect(res.status).toBe(403);
      }
      expect(storage.uploadImage).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('401s without a session', async () => {
    mockDbValue = fakeDb().db;
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/org/logo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: PNG_BYTES.toString('base64'), mimeType: 'image/png' }),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });
});

describe('GET /assets/logo/*', () => {
  it('serves a logo key without auth, with an extension-derived content type and nosniff', async () => {
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assets/logo/org-1/logo-fixed-uuid.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
      expect(storage.download).toHaveBeenCalledWith('org-1', 'org-1/logo-fixed-uuid.png');
    } finally {
      server.close();
    }
  });

  it('404s a PDF-style asset key without touching storage', async () => {
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assets/logo/org-1/2f1c1b6e-0000-4000-8000-000000000000.pdf`);
      expect(res.status).toBe(404);
      expect(storage.download).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s a nested or traversal-shaped key without touching storage', async () => {
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      for (const key of ['org-1/nested/logo-a.png', 'org-1/notlogo-a.png']) {
        const res = await fetch(`${base}/assets/logo/${key}`);
        expect(res.status).toBe(404);
      }
      expect(storage.download).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s when the object is missing', async () => {
    const storage = fakeStorage();
    storage.download.mockResolvedValue(null);
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assets/logo/org-1/logo-fixed-uuid.png`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /org logo replacement cleanup', () => {
  const PREV_URL = '/api/assets/logo/org-1/logo-previous.png';
  const orgWithLogo = {
    ...ORG_ROW,
    branding: { ...ORG_ROW.branding, logoAssetUrl: PREV_URL },
  };

  it('best-effort deletes the previous logo object when logoAssetUrl changes', async () => {
    const { db } = fakeDb({ org: orgWithLogo });
    mockDbValue = db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, {
        branding: { ...NEW_KIT, logoAssetUrl: '/api/assets/logo/org-1/logo-new.png' },
      });
      expect(res.status).toBe(200);
      expect(storage.deleteObject).toHaveBeenCalledWith('org-1', 'org-1/logo-previous.png');
    } finally {
      server.close();
    }
  });

  it('does not delete when logoAssetUrl is unchanged', async () => {
    const { db } = fakeDb({ org: orgWithLogo });
    mockDbValue = db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, {
        branding: { ...NEW_KIT, logoAssetUrl: PREV_URL },
      });
      expect(res.status).toBe(200);
      expect(storage.deleteObject).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('still succeeds when the previous-logo deletion fails', async () => {
    const { db } = fakeDb({ org: orgWithLogo });
    mockDbValue = db;
    const storage = fakeStorage({
      deleteObject: async () => {
        throw new Error('storage_delete_failed');
      },
    });
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, {
        branding: { ...NEW_KIT, logoAssetUrl: '/api/assets/logo/org-1/logo-new.png' },
      });
      expect(res.status).toBe(200);
      expect(storage.deleteObject).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('POST /org/brand-scan', () => {
  it('403s a viewer', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/org/brand-scan`, {
        method: 'POST',
        headers: {
          ...authHeader({ userId: 'u1', orgId: 'org-1', role: 'viewer' }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: 'https://example.com' }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('400s a missing url', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/org/brand-scan`, {
        method: 'POST',
        headers: { ...authHeader(ownerTenant), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  /**
   * The SSRF guard has its own suite; this asserts the route surfaces its
   * refusal as a clean 422 rather than a 500, and that an internal hostname
   * cannot be scanned through this endpoint.
   */
  it('422s a URL the SSRF guard refuses', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/org/brand-scan`, {
        method: 'POST',
        headers: { ...authHeader(ownerTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; reason: string };
      expect(body.error).toBe('scan_failed');
      expect(body.reason).toBe('blocked_address');
    } finally {
      server.close();
    }
  });

  it('422s a blocked scheme', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/org/brand-scan`, {
        method: 'POST',
        headers: { ...authHeader(ownerTenant), 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'file:///etc/passwd' }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toBe('blocked_scheme');
    } finally {
      server.close();
    }
  });

  /**
   * This endpoint makes the server fetch an address the caller picks, so it is
   * usable as an amplifier or scanner even with private space refused. The
   * logo upload shipped without a limit; this one does not.
   */
  it('rate limits repeated scans for one org', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const call = () =>
        fetch(`${base}/org/brand-scan`, {
          method: 'POST',
          headers: {
            ...authHeader({ userId: 'u1', orgId: 'rate-test-org', role: 'owner' }),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ url: 'http://127.0.0.1/' }),
        });

      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await call()).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /org theme', () => {
  const THEMED: BrandingKit = {
    ...NEW_KIT,
    theme: {
      headingSize: 28,
      headingWeight: 700,
      buttonShape: 'pill',
      radius: 18,
      density: 'spacious',
      layout: 'hero',
      pageBackground: '#101010',
      // An unset role is the empty string, not a missing key — the emitter
      // relies on that to skip the variable and keep the product token.
      headingColor: '',
    },
  };

  it('round-trips a full theme through the branding column', async () => {
    const { db, updateSet } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { branding: THEMED });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { branding: BrandingKit };
      expect(body.branding.theme).toEqual(THEMED.theme);
      // Persisted, not merely echoed.
      const written = updateSet.mock.calls.at(-1)?.[1] as { branding?: BrandingKit };
      expect(written.branding?.theme?.layout).toBe('hero');
    } finally {
      server.close();
    }
  });

  it('accepts branding with no theme at all, leaving the org on defaults', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { branding: NEW_KIT });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { branding: BrandingKit };
      expect(body.branding.theme).toBeUndefined();
    } finally {
      server.close();
    }
  });

  /**
   * These values are emitted straight into CSS custom properties on a public,
   * respondent-facing page, so the bound is a defacement guard rather than
   * taste policing.
   */
  it.each([
    ['a non-hex colour role', { pageBackground: 'red' }],
    ['a colour role with a CSS payload', { headingColor: '#fff; background: url(//evil)' }],
    ['an absurd type size', { headingSize: 9000 }],
    ['a zero type size', { headingSize: 0 }],
    ['a fractional type size', { headingSize: 14.5 }],
    ['a weight the font loader never requests', { headingWeight: 250 }],
    ['an unknown button shape', { buttonShape: 'blob' }],
    ['an unknown layout', { layout: 'carousel' }],
    ['an unknown density', { density: 'airy' }],
    ['a negative radius', { radius: -4 }],
  ])('rejects %s with a 400', async (_label, theme) => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, {
        branding: { ...NEW_KIT, theme },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    } finally {
      server.close();
    }
  });

  /**
   * A client on an older build must not have its whole save rejected because
   * this server does not know a key yet — the unknown key is dropped instead.
   */
  it('strips an unknown theme key rather than failing the request', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, {
        branding: { ...NEW_KIT, theme: { radius: 8, futureKey: 'whatever' } },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { branding: BrandingKit };
      expect(body.branding.theme).toEqual({ radius: 8 });
    } finally {
      server.close();
    }
  });

  it('403s a viewer attempting a theme change', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(
        base,
        { userId: 'u1', orgId: 'org-1', role: 'viewer' },
        { branding: THEMED },
      );
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /org', () => {
  it('503s when the DB client is unavailable', async () => {
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { name: 'New Name' });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('401s without a session', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/org`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('lets an owner update name and branding together, persists the row, and audits the rename', async () => {
    const { db, updateSet, insertValues } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { name: '  Meridian Ops  ', branding: NEW_KIT });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; name: string; branding: BrandingKit };
      expect(body).toEqual({
        id: 'org-1',
        name: 'Meridian Ops',
        branding: NEW_KIT,
        teamSize: null,
        onboardingCompletedAt: null,
      });

      // The row update carried both fields (name trimmed).
      expect(updateSet).toHaveBeenCalledTimes(1);
      expect(updateSet.mock.calls[0]?.[0]).toBe(schema.organizations);
      expect(updateSet.mock.calls[0]?.[1]).toEqual({ name: 'Meridian Ops', branding: NEW_KIT });

      // Audit entry written: a rename takes the rename wording.
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({
        action: 'Renamed organisation',
        category: 'settings',
        icon: 'settings',
      });
    } finally {
      server.close();
    }
  });

  it('supports a name-only update (admin allowed)', async () => {
    const { db, updateSet } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, adminTenant, { name: 'Renamed Co' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; branding: BrandingKit };
      expect(body.name).toBe('Renamed Co');
      // Untouched branding echoes the stored kit.
      expect(body.branding).toEqual(ORG_ROW.branding);
      expect(updateSet.mock.calls[0]?.[1]).toEqual({ name: 'Renamed Co' });
    } finally {
      server.close();
    }
  });

  it('supports a branding-only update and audits it as a settings update (not a rename)', async () => {
    const { db, updateSet, insertValues } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { branding: NEW_KIT });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; branding: BrandingKit };
      expect(body.name).toBe('Old Name');
      expect(body.branding).toEqual(NEW_KIT);
      expect(updateSet.mock.calls[0]?.[1]).toEqual({ branding: NEW_KIT });

      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({
        action: 'Updated organisation settings',
        category: 'settings',
      });
    } finally {
      server.close();
    }
  });

  it('403s a viewer without touching the row', async () => {
    const { db, updateSet, insertValues } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, viewerTenant, { name: 'Sneaky Rename' });
      expect(res.status).toBe(403);
      expect(updateSet).not.toHaveBeenCalled();
      expect(insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('403s a builder without touching the row', async () => {
    const { db, updateSet, insertValues } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, builderTenant, { teamSize: '2-5' });
      expect(res.status).toBe(403);
      expect(updateSet).not.toHaveBeenCalled();
      expect(insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('accepts a branding update on a team-tier org — branding is not plan-gated', async () => {
    const { db, updateSet } = fakeDb({ org: { ...ORG_ROW, planTier: 'team' } });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { branding: NEW_KIT });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { branding: BrandingKit };
      expect(body.branding).toEqual(NEW_KIT);
      expect(updateSet.mock.calls[0]?.[1]).toEqual({ branding: NEW_KIT });
    } finally {
      server.close();
    }
  });

  it('persists teamSize and round-trips it in the response', async () => {
    const { db, updateSet } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { teamSize: '10–49' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { teamSize: string | null };
      expect(body.teamSize).toBe('10–49');
      expect(updateSet).toHaveBeenCalledTimes(1);
      expect(updateSet.mock.calls[0]?.[1]).toEqual({ teamSize: '10–49' });
    } finally {
      server.close();
    }
  });

  it('stamps onboardingCompletedAt on the first completion call', async () => {
    const { db, updateSet } = fakeDb({ org: { ...ORG_ROW, onboardingCompletedAt: null } });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { onboardingComplete: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { onboardingCompletedAt: string | null };
      expect(body.onboardingCompletedAt).not.toBeNull();
      const setArg = updateSet.mock.calls[0]?.[1] as { onboardingCompletedAt?: unknown };
      expect(setArg?.onboardingCompletedAt).toBeInstanceOf(Date);
    } finally {
      server.close();
    }
  });

  it('does not reset onboardingCompletedAt when completion is repeated', async () => {
    const stamped = new Date('2026-07-01T00:00:00.000Z');
    const { db, updateSet } = fakeDb({ org: { ...ORG_ROW, onboardingCompletedAt: stamped } });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { onboardingComplete: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { onboardingCompletedAt: string | null };
      expect(body.onboardingCompletedAt).toBe('2026-07-01T00:00:00.000Z');
      // No write carried a fresh timestamp.
      for (const call of updateSet.mock.calls) {
        expect((call[1] as { onboardingCompletedAt?: unknown }).onboardingCompletedAt).toBeUndefined();
      }
    } finally {
      server.close();
    }
  });

  it('does not stamp — or audit — when a concurrent PATCH won the race', async () => {
    // Both requests read a null column; the guarded UPDATE matches zero rows
    // for the loser, which must not claim a stamp it did not write.
    const { db, insertValues } = fakeDb({
      org: { ...ORG_ROW, onboardingCompletedAt: null },
      stampRaceLost: true,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { onboardingComplete: true });
      expect(res.status).toBe(200);
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('writes no audit entry for a repeat completion — nothing changed', async () => {
    const { db, insertValues } = fakeDb({
      org: { ...ORG_ROW, onboardingCompletedAt: new Date('2026-07-01T00:00:00.000Z') },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { onboardingComplete: true });
      expect(res.status).toBe(200);
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('audits a teamSize-only update as organisation details, not a branding change', async () => {
    const { db, insertValues } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { teamSize: '2-5' });
      expect(res.status).toBe(200);
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({
        action: 'Updated organisation settings',
        target: 'Organisation details',
      });
    } finally {
      server.close();
    }
  });

  it('audits a first completion as onboarding, not a branding change', async () => {
    const { db, insertValues } = fakeDb({ org: { ...ORG_ROW, onboardingCompletedAt: null } });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { onboardingComplete: true });
      expect(res.status).toBe(200);
      const auditInsert = insertValues.mock.calls.find(([table]) => table === schema.auditLogEntries);
      expect(auditInsert?.[1]).toMatchObject({ target: 'Onboarding completed' });
    } finally {
      server.close();
    }
  });

  it('400s a logoAssetUrl owned by another org — no cross-tenant assignment', async () => {
    const { db, updateSet } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, {
        branding: { ...NEW_KIT, logoAssetUrl: '/api/assets/logo/org-2/logo-victim.png' },
      });
      expect(res.status).toBe(400);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('400s a logoAssetUrl this API never minted', async () => {
    const rejected = [
      'https://evil.example/logo.png',
      '/api/assets/logo/org-1/notlogo-a.png', // outside the logo namespace
      '/api/assets/logo/org-1/logo-a.svg', // SVG is never a logo key
      '/api/assets/logo/org-1/nested/logo-a.png',
      'javascript:alert(1)',
    ];
    for (const url of rejected) {
      const { db, updateSet } = fakeDb();
      mockDbValue = db;
      const { server, base } = startApp();
      try {
        const res = await patchOrg(base, ownerTenant, {
          branding: { ...NEW_KIT, logoAssetUrl: url },
        });
        expect(res.status, url).toBe(400);
        expect(updateSet, url).not.toHaveBeenCalled();
      } finally {
        server.close();
      }
    }
  });

  it('accepts a logoAssetUrl minted for this org', async () => {
    const { db, updateSet } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const kit = { ...NEW_KIT, logoAssetUrl: '/api/assets/logo/org-1/logo-fixed-uuid.png' };
      const res = await patchOrg(base, ownerTenant, { branding: kit });
      expect(res.status).toBe(200);
      expect(updateSet.mock.calls[0]?.[1]).toEqual({ branding: kit });
    } finally {
      server.close();
    }
  });

  it('400s an empty body (neither name nor branding)', async () => {
    const { db, updateSet } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, {});
      expect(res.status).toBe(400);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('400s a blank name and a malformed branding kit', async () => {
    const { db, updateSet } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const blankName = await patchOrg(base, ownerTenant, { name: '   ' });
      expect(blankName.status).toBe(400);

      const badKit = await patchOrg(base, ownerTenant, {
        branding: { ...NEW_KIT, formFont: 'Comic Sans' },
      });
      expect(badKit.status).toBe(400);
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s when the tenant org row is missing', async () => {
    const { db } = fakeDb({ org: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, { name: 'Ghost Org' });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

// ── formFont catalog validation ───────────────────────────────────────────
//
// `formFont` is no longer a four-value enum: it is any family name present in
// the bundled Google Fonts catalog snapshot. These pin both halves — the
// catalog widens what is accepted, and it must still be a closed set (a free
// string would land unescaped in a `fonts.googleapis.com/css2` URL).

describe('PATCH /org — formFont catalog validation', () => {
  async function patchFont(font: string) {
    const { db, updateSet } = fakeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await patchOrg(base, ownerTenant, {
        branding: { ...NEW_KIT, formFont: font },
      });
      return { status: res.status, updateSet };
    } finally {
      server.close();
    }
  }

  it('accepts a catalog family beyond the original four presets', async () => {
    for (const font of ['Lora', 'Oswald', 'Playfair Display']) {
      const { status, updateSet } = await patchFont(font);
      expect(status, font).toBe(200);
      expect(updateSet.mock.calls[0]?.[1]).toEqual({
        branding: { ...NEW_KIT, formFont: font },
      });
    }
  });

  it('still accepts all four preset families saved by existing orgs', async () => {
    for (const font of ['Inter', 'Sora', 'Spectral', 'JetBrains Mono']) {
      const { status } = await patchFont(font);
      expect(status, font).toBe(200);
    }
  });

  it('rejects a non-catalog family and injection-shaped values', async () => {
    const rejected = [
      'Not A Real Font',
      'Inter"); @import url(evil',
      'Inter&family=Evil',
      'Inter;wght@400',
      '',
      'inter', // case-sensitive: the catalog spelling is what reaches the css2 URL
    ];
    for (const font of rejected) {
      const { status, updateSet } = await patchFont(font);
      expect(status, font).toBe(400);
      expect(updateSet, font).not.toHaveBeenCalled();
    }
  });
});
