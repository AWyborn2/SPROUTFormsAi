import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { sealSession } from '../auth/workos.js';
import { requireTenant, SESSION_COOKIE_NAME } from './tenant.js';

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe('requireTenant', () => {
  it('sets req.tenant and calls next() for a valid session cookie', () => {
    const tenant = { userId: 'u1', orgId: 'o1', role: 'owner' };
    const req = { cookies: { [SESSION_COOKIE_NAME]: sealSession(tenant) } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireTenant(req, res, next);

    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('401s with no response sent by next() when the cookie is missing', () => {
    const req = { cookies: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireTenant(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'unauthenticated' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401s for a tampered session cookie', () => {
    const token = sealSession({ userId: 'u1', orgId: 'o1', role: 'owner' });
    const [iv, tag, data] = token.split('.');
    const tampered = [iv, tag, `${(data ?? '').slice(0, -2)}zz`].join('.');
    const req = { cookies: { [SESSION_COOKIE_NAME]: tampered } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireTenant(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
