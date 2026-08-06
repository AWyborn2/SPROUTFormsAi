import type { NextFunction, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { TenantContext } from '@formai/shared';
import { unsealSession } from '../auth/replit-auth.js';
import { db } from '../db.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Resolved tenant context, present on authenticated routes. */
      tenant?: TenantContext;
    }
  }
}

export const SESSION_COOKIE_NAME = 'fai_session';

/**
 * Resolves `req.tenant` from the sealed session cookie and 401s when it is
 * absent, tampered, or expired. Every DB query downstream filters by
 * `tenant.orgId` — the enforced multi-tenant boundary.
 *
 * IT ALSO REVALIDATES THE MEMBERSHIP, which is what makes deactivation
 * immediate (R65).
 *
 * There is no session to revoke. `auth/replit-auth.ts` is a sealed-cookie pair
 * — an AES-256-GCM envelope carrying the tenant with a seven-day expiry — and
 * nothing server-side records that a session exists. So deactivation cannot
 * delete one; the cookie stays valid crypto until it expires. The only place
 * that envelope becomes authority is here, so here is where a membership that
 * has stopped being active must stop being honoured. Without it a leaver keeps
 * full access for up to seven days, which is exactly what R65 exists to prevent.
 *
 * IT REFUSES WHAT DEACTIVATION WRITES, and nothing else. `suspended` is the
 * state R62's deactivation puts a membership in; the check is against that
 * rather than against "anything that is not active", because the two are not
 * the same question. An `invited` membership is not a deactivated one, and a
 * rule phrased as not-active would refuse states that mean something else
 * entirely — turning a narrow revocation into a broad lockout the requirement
 * never asked for.
 *
 * FAIL-OPEN ON UNKNOWN. A lookup that cannot answer — no database configured, a
 * transient error, no row — passes, because the alternative is that one blip in
 * a read logs out every user of the product at once. That is the soft-fail
 * posture a certificate revocation check takes, and it is safe here for a
 * specific reason: deactivation is never a delete (R62), so the row is always
 * there to be read. A missing row means something other than "deactivated".
 *
 * COST: one indexed read per authenticated request, on every route rather than
 * only the profile ones.
 */
export function requireTenant(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const tenant = typeof token === 'string' ? unsealSession<TenantContext>(token) : null;
  if (!tenant) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }

  void membershipDeactivated(tenant).then((deactivated) => {
    if (deactivated) {
      // Same shape as an absent cookie: a deactivated session is simply not
      // authenticated any more.
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    req.tenant = tenant;
    next();
  });
}

/** The status R62's deactivation writes. Refusing it is the whole of R65's immediacy. */
export const DEACTIVATED_STATUS = 'suspended';

/**
 * Whether the membership the sealed context names has been deactivated.
 *
 * Returns false on anything it cannot determine — see the fail-open reasoning
 * above. Never throws: a rejected read must not become an unhandled rejection
 * on the request path.
 */
async function membershipDeactivated(tenant: TenantContext): Promise<boolean> {
  if (!db) return false;
  try {
    const membership = await db.query.memberships.findFirst({
      where: and(
        eq(schema.memberships.userId, tenant.userId),
        eq(schema.memberships.orgId, tenant.orgId),
      ),
    });
    return membership?.status === DEACTIVATED_STATUS;
  } catch {
    return false;
  }
}
