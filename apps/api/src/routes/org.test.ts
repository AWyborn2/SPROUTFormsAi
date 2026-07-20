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

vi.mock('../storage/index.js', () => ({
  getStorageClient: () => null,
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
 */
function fakeDb(opts: { org?: unknown } = { org: ORG_ROW }) {
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
          return Promise.resolve(undefined);
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
