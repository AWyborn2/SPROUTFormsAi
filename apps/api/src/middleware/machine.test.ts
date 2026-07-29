import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { requireMachineOrTenant } = await import('./machine.js');
const { mintApiKey } = await import('../auth/api-key.js');
const { sealSession } = await import('../auth/replit-auth.js');

const ISSUER = { id: 'u-admin', name: 'Ash Wyborn', email: 'ash@example.com' };

function fakeDb(opts: {
  apiKey?: unknown;
  issuer?: unknown;
  updateThrows?: boolean;
  findThrows?: boolean;
}) {
  const updateSet = vi.fn();
  return {
    updateSet,
    db: {
      query: {
        apiKeys: {
          findFirst: vi.fn(async () => {
            if (opts.findThrows) throw new Error('db down');
            return opts.apiKey;
          }),
        },
        users: { findFirst: vi.fn().mockResolvedValue('issuer' in opts ? opts.issuer : ISSUER) },
      },
      update: vi.fn(() => ({
        set: (v: unknown) => {
          updateSet(v);
          return {
            where: () =>
              opts.updateThrows ? Promise.reject(new Error('write failed')) : Promise.resolve(),
          };
        },
      })),
    } as unknown as Db,
  };
}

function fakeReq(headers: Record<string, string>, cookies: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    cookies,
  } as unknown as Request;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function liveKey(overrides: Record<string, unknown> = {}) {
  const minted = mintApiKey();
  return {
    minted,
    row: {
      id: 'key-1',
      orgId: 'org-1',
      name: 'Induction agent',
      role: 'reviewer' as const,
      prefix: minted.prefix,
      hash: minted.hash,
      createdByUserId: ISSUER.id,
      revokedAt: null,
      ...overrides,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('requireMachineOrTenant — rejections', () => {
  it.each([
    ['no credential at all', {}],
    ['a non-bearer scheme', { authorization: 'Basic abc' }],
    ['a malformed key', { authorization: 'Bearer nonsense' }],
  ])('401s on %s', async (_label, headers) => {
    const { db } = fakeDb({});
    mockDbValue = db;
    const res = fakeRes();
    await requireMachineOrTenant(fakeReq(headers), res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated' });
  });

  it('gives an unknown prefix and a wrong secret the same opaque answer', async () => {
    const { minted, row } = liveKey();

    const unknown = fakeDb({ apiKey: undefined });
    mockDbValue = unknown.db;
    const unknownRes = fakeRes();
    await requireMachineOrTenant(fakeReq({ authorization: `Bearer ${minted.plaintext}` }), unknownRes, vi.fn());

    const wrongSecret = fakeDb({ apiKey: row });
    mockDbValue = wrongSecret.db;
    const wrongRes = fakeRes();
    await requireMachineOrTenant(
      fakeReq({ authorization: `Bearer fai_${row.prefix}_wrong` }),
      wrongRes,
      vi.fn(),
    );

    expect(wrongRes.statusCode).toBe(unknownRes.statusCode);
    expect(wrongRes.body).toEqual(unknownRes.body);
    expect(unknownRes.statusCode).toBe(401);
  });

  it('401s when the issuing user no longer exists', async () => {
    const { minted, row } = liveKey();
    const { db } = fakeDb({ apiKey: row, issuer: undefined });
    mockDbValue = db;
    const res = fakeRes();
    const next = vi.fn();
    await requireMachineOrTenant(fakeReq({ authorization: `Bearer ${minted.plaintext}` }), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s rather than 500s when the lookup throws', async () => {
    const { minted } = liveKey();
    const { db } = fakeDb({ findThrows: true });
    mockDbValue = db;
    const res = fakeRes();
    await requireMachineOrTenant(fakeReq({ authorization: `Bearer ${minted.plaintext}` }), res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it('401s when a bearer key is presented with no database configured', async () => {
    const { minted } = liveKey();
    mockDbValue = null;
    const res = fakeRes();
    await requireMachineOrTenant(fakeReq({ authorization: `Bearer ${minted.plaintext}` }), res, vi.fn());
    expect(res.statusCode).toBe(401);
  });
});

describe('requireMachineOrTenant — acceptance', () => {
  it('resolves the tenant from a live key, acting as the issuing administrator', async () => {
    const { minted, row } = liveKey();
    const { db } = fakeDb({ apiKey: row });
    mockDbValue = db;
    const req = fakeReq({ authorization: `Bearer ${minted.plaintext}` });
    const next = vi.fn();
    await requireMachineOrTenant(req, fakeRes(), next as unknown as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect(req.tenant).toEqual({ userId: ISSUER.id, orgId: 'org-1', role: 'reviewer' });
    expect(req.apiKeyId).toBe('key-1');
  });

  it('stamps lastUsedAt without blocking the request when the write fails', async () => {
    const { minted, row } = liveKey();
    const { db, updateSet } = fakeDb({ apiKey: row, updateThrows: true });
    mockDbValue = db;
    const next = vi.fn();
    await requireMachineOrTenant(
      fakeReq({ authorization: `Bearer ${minted.plaintext}` }),
      fakeRes(),
      next as unknown as NextFunction,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(updateSet).toHaveBeenCalledWith({ lastUsedAt: expect.any(Date) });
  });

  it('still accepts a session cookie, so the web app can call the same routes', async () => {
    const { db } = fakeDb({});
    mockDbValue = db;
    const tenant = { userId: 'u1', orgId: 'org-9', role: 'owner' as const };
    const req = fakeReq({}, { fai_session: sealSession(tenant) });
    const next = vi.fn();
    await requireMachineOrTenant(req, fakeRes(), next as unknown as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect(req.tenant).toEqual(tenant);
    expect(req.apiKeyId).toBeUndefined();
  });

  it('prefers the bearer key when both credentials are present', async () => {
    const { minted, row } = liveKey();
    const { db } = fakeDb({ apiKey: row });
    mockDbValue = db;
    const req = fakeReq(
      { authorization: `Bearer ${minted.plaintext}` },
      { fai_session: sealSession({ userId: 'u1', orgId: 'org-9', role: 'owner' }) },
    );
    await requireMachineOrTenant(req, fakeRes(), vi.fn() as unknown as NextFunction);
    expect(req.tenant?.orgId).toBe('org-1');
  });
});
