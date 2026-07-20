import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('GET /auth/login', () => {
  it('redirects to the Replit auth URL with the request domain', async () => {
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location).toMatch(/^https:\/\/replit\.com\/auth_with_repl_site\?domain=.+/);
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
      });
    } finally {
      server.close();
    }
  });

  it('auto-provisions from Replit headers when no session cookie exists', async () => {
    const tenant = { userId: 'u1', orgId: 'o1', role: 'owner' as const };
    mockProvisionTenant.mockResolvedValue(tenant);
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
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ userId: 'u1', orgId: 'o1' });
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('fai_session=');
      const sessionToken = setCookie.split('fai_session=')[1]?.split(';')[0] ?? '';
      expect(unsealSession(decodeURIComponent(sessionToken))).toEqual(tenant);
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
