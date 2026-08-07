import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { sealSession } = await import('../auth/workos.js');
const { requireTenant, SESSION_COOKIE_NAME } = await import('./tenant.js');

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

/** The membership the revalidation reads, or nothing at all. */
function fakeDb(membership: { status: string } | undefined | 'throws') {
  mockDbValue = {
    query: {
      memberships: {
        findFirst: async () => {
          if (membership === 'throws') throw new Error('transient read failure');
          return membership;
        },
      },
    },
  } as unknown as Db;
}

const TENANT = { userId: 'u1', orgId: 'o1', role: 'owner' };

/**
 * The middleware became asynchronous when it started revalidating the
 * membership, so a test must wait for the decision rather than assert straight
 * after the call. Resolves once `next` or `res.status` has been reached.
 */
function run(req: Request, res: Response, next: NextFunction): Promise<void> {
  requireTenant(req, res, next);
  // One macrotask is enough: the revalidation is a single awaited read.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function reqWith(token: string): Request {
  return { cookies: { [SESSION_COOKIE_NAME]: token } } as unknown as Request;
}

describe('requireTenant', () => {
  it('sets req.tenant and calls next() for a valid session cookie', async () => {
    fakeDb({ status: 'active' });
    const req = reqWith(sealSession(TENANT));
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await run(req, res, next);

    expect(req.tenant).toEqual(TENANT);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('401s with no response sent by next() when the cookie is missing', async () => {
    fakeDb({ status: 'active' });
    const req = { cookies: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await run(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'unauthenticated' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401s for a tampered session cookie', async () => {
    fakeDb({ status: 'active' });
    const token = sealSession(TENANT);
    const [iv, tag, data] = token.split('.');
    const tampered = [iv, tag, `${(data ?? '').slice(0, -2)}zz`].join('.');
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await run(reqWith(tampered), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  describe('deactivation is immediate (R65)', () => {
    it('refuses a still-valid cookie whose membership has been deactivated', async () => {
      /*
        THE POINT OF THE WHOLE CHANGE. The session is a sealed cookie with a
        seven-day expiry and nothing server-side records it, so deactivation
        cannot delete one — without this check a leaver keeps full access until
        the cookie lapses.
      */
      fakeDb({ status: 'suspended' });
      const res = mockRes();
      const next = vi.fn() as NextFunction;

      await run(reqWith(sealSession(TENANT)), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('admits an invited membership, which is not a deactivated one', async () => {
      // The rule is against what deactivation WRITES, not against "anything
      // that is not active" — those are different questions, and the broader
      // phrasing would lock out states that mean something else.
      fakeDb({ status: 'invited' });
      const res = mockRes();
      const next = vi.fn() as NextFunction;

      await run(reqWith(sealSession(TENANT)), res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('admits when the lookup cannot answer, rather than logging everybody out', async () => {
      // Soft-fail on unknown: one blip in a read must not sign out every user
      // of the product at once. Safe because deactivation is never a delete
      // (R62), so the row is always there to be read.
      for (const state of [undefined, 'throws'] as const) {
        fakeDb(state);
        const res = mockRes();
        const next = vi.fn() as NextFunction;
        await run(reqWith(sealSession(TENANT)), res, next);
        expect(next, `state ${String(state)}`).toHaveBeenCalledTimes(1);
      }
    });

    it('admits when no database is configured', async () => {
      mockDbValue = null;
      const res = mockRes();
      const next = vi.fn() as NextFunction;

      await run(reqWith(sealSession(TENANT)), res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
