import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const mockProvisionTenant = vi.fn();
vi.mock('../auth/tenant-provisioning.js', () => ({
  provisionTenant: mockProvisionTenant,
}));

let mockDbValue: object | null = {};
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { createApp } = await import('../app.js');
const { sealSession, unsealSession } = await import('../auth/replit-auth.js');
const { DUMMY_HASH } = await import('./auth.js');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = {};
});

describe('POST /auth/login', () => {
  // Low cost factor keeps the test fast; the route only cares that the hash verifies.
  const passwordHash = bcrypt.hashSync('correct horse battery', 4);
  const userRow = { id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io', passwordHash };
  const tenant = { userId: 'u1', orgId: 'o1', role: 'owner' as const };

  function loginDb(user: object | undefined) {
    return {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue(user) },
        organizations: { findFirst: vi.fn().mockResolvedValue({ id: 'o1', name: 'Acme Inc' }) },
      },
    };
  }

  async function postLogin(base: string, body: unknown) {
    return fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('400s on a malformed body', async () => {
    mockDbValue = loginDb(userRow);
    const { server, base } = startApp();
    try {
      const res = await postLogin(base, { email: 'not-an-email', password: '' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('validation_error');
    } finally {
      server.close();
    }
  });

  it('401s with invalid_credentials for a wrong password, setting no cookie', async () => {
    mockDbValue = loginDb(userRow);
    const { server, base } = startApp();
    try {
      const res = await postLogin(base, { email: 'ash@x.io', password: 'wrong-password' });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_credentials');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(mockProvisionTenant).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('401s with the same invalid_credentials shape for an unknown email', async () => {
    mockDbValue = loginDb(undefined);
    const { server, base } = startApp();
    try {
      const res = await postLogin(base, { email: 'nobody@x.io', password: 'whatever-pass' });
      expect(res.status).toBe(401);
      // Same error body as a wrong password — no email enumeration.
      expect(((await res.json()) as { error: string }).error).toBe('invalid_credentials');
    } finally {
      server.close();
    }
  });

  it('backs the unknown-email path with a structurally valid, full-cost dummy hash', async () => {
    // A malformed constant would make bcrypt.compare short-circuit instead of
    // doing full-cost work, reintroducing the timing oracle the dummy compare
    // exists to prevent. Cost must match the 12 used for real password hashes.
    expect(DUMMY_HASH).toMatch(/^\$2[aby]\$12\$/);
    expect(DUMMY_HASH).toHaveLength(60);
    await expect(bcrypt.compare('anything', DUMMY_HASH)).resolves.toBe(false);
  });

  it('seals a session cookie and returns the session info on a correct password', async () => {
    mockProvisionTenant.mockResolvedValue(tenant);
    mockDbValue = loginDb(userRow);
    const { server, base } = startApp();
    try {
      const res = await postLogin(base, { email: 'ash@x.io', password: 'correct horse battery' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ...tenant,
        orgName: 'Acme Inc',
        userName: 'Ash Wyborn',
        userEmail: 'ash@x.io',
        accountKind: 'team',
        branding: null,
        teamSize: null,
        onboardingCompletedAt: null,
      });
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('fai_session=');
      const sessionToken = setCookie.split('fai_session=')[1]?.split(';')[0] ?? '';
      expect(unsealSession(decodeURIComponent(sessionToken))).toEqual(tenant);
    } finally {
      server.close();
    }
  });

  it('503s when the DB client is unavailable', async () => {
    mockDbValue = null;
    const { server, base } = startApp();
    try {
      const res = await postLogin(base, { email: 'ash@x.io', password: 'correct horse battery' });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });
});

describe('POST /auth/logout', () => {
  it('clears the session cookie and returns 204', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/auth/logout`, { method: 'POST' });
      expect(res.status).toBe(204);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('fai_session=;');
    } finally {
      server.close();
    }
  });
});

describe('GET /auth/me', () => {
  it('resolves the sealed tenant against org/user rows and returns display fields', async () => {
    const tenant = { userId: 'u1', orgId: 'o1', role: 'owner' as const };
    mockDbValue = {
      query: {
        organizations: { findFirst: vi.fn().mockResolvedValue({ id: 'o1', name: 'Acme Inc' }) },
        users: {
          findFirst: vi.fn().mockResolvedValue({ id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' }),
        },
      },
    };
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/auth/me`, {
        headers: { cookie: `fai_session=${sealSession(tenant)}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        ...tenant,
        orgName: 'Acme Inc',
        userName: 'Ash Wyborn',
        userEmail: 'ash@x.io',
        accountKind: 'team',
        branding: null,
        teamSize: null,
        onboardingCompletedAt: null,
      });
    } finally {
      server.close();
    }
  });

  it('returns accountKind, branding, teamSize, and onboardingCompletedAt from the org row', async () => {
    const tenant = { userId: 'u1', orgId: 'o1', role: 'owner' as const };
    const branding = {
      logoAssetUrl: null,
      primaryColor: '#112233',
      secondaryColor: '#445566',
      accentColor: '#778899',
      formFont: 'Sora',
    };
    mockDbValue = {
      query: {
        organizations: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'o1',
            name: 'Acme Inc',
            accountKind: 'individual',
            branding,
            teamSize: '10–49',
            onboardingCompletedAt: new Date('2026-07-01T00:00:00.000Z'),
          }),
        },
        users: {
          findFirst: vi.fn().mockResolvedValue({ id: 'u1', name: 'Ash Wyborn', email: 'ash@x.io' }),
        },
      },
    };
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/auth/me`, {
        headers: { cookie: `fai_session=${sealSession(tenant)}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        accountKind: 'individual',
        branding,
        teamSize: '10–49',
        onboardingCompletedAt: '2026-07-01T00:00:00.000Z',
      });
    } finally {
      server.close();
    }
  });

  it('does NOT auto-provision from X-Replit-User-* headers — the cookie is the only credential', async () => {
    // Replit header auth was removed with the move to email+password; headers
    // that used to mint a session are now ignored entirely.
    mockDbValue = {
      query: {
        organizations: { findFirst: vi.fn().mockResolvedValue({ id: 'o1', name: 'Replit Org' }) },
        users: {
          findFirst: vi.fn().mockResolvedValue({ id: 'u1', name: 'replituser', email: 'replituser@replit.user' }),
        },
      },
    };
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/auth/me`, {
        headers: {
          'x-replit-user-id': 'replit_123',
          'x-replit-user-name': 'replituser',
        },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(mockProvisionTenant).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('401s with no session cookie and no Replit headers', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/auth/me`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('503s when the DB client is unavailable', async () => {
    const tenant = { userId: 'u1', orgId: 'o1', role: 'owner' as const };
    mockDbValue = null;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/auth/me`, {
        headers: { cookie: `fai_session=${sealSession(tenant)}` },
      });
      expect(res.status).toBe(503);
    } finally {
      server.close();
    }
  });
});
