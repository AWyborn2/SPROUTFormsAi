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
 * immediate (R65) and keeps the sealed role honest (see `revalidateTenant`).
 *
 * There is no session to revoke. `auth/replit-auth.ts` is a sealed-cookie pair
 * — an AES-256-GCM envelope carrying the tenant with a seven-day expiry — and
 * nothing server-side records that a session exists. So deactivation cannot
 * delete one; the cookie stays valid crypto until it expires. The only place
 * that envelope becomes authority is here, so here is where a membership that
 * has stopped being active must stop being honoured, and where a role the
 * envelope has outlived must be corrected.
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

  void revalidateTenant(tenant).then((current) => {
    if (!current) {
      // Same shape as an absent cookie: a deactivated session is simply not
      // authenticated any more.
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    req.tenant = current;
    next();
  });
}

/** The status R62's deactivation writes. Refusing it is the whole of R65's immediacy. */
export const DEACTIVATED_STATUS = 'suspended';

/**
 * Revalidate a sealed context against the live membership row, returning the
 * context to honour or `null` to refuse. Shared by every authenticated door so
 * the two properties below cannot drift between the session middleware and the
 * machine-or-tenant one.
 *
 * Two things the sealed cookie cannot be trusted for, because it is a seven-day
 * AES envelope with nothing server-side to revoke or amend:
 *
 *  - STATUS. `suspended` is the state R62's deactivation writes; a membership
 *    in it must stop being honoured at once (R65) — returns null. The check is
 *    against what deactivation WRITES, not against "anything not active": an
 *    `invited` membership is not a deactivated one, and the broader phrasing
 *    would lock out states that mean something else entirely.
 *  - ROLE. A membership demoted since the cookie was sealed still carries the
 *    old access level in the envelope; left alone, a demoted admin keeps
 *    Admin-only powers for up to seven days. The live row's role wins.
 *
 * FAIL-OPEN ON UNKNOWN. A lookup that cannot answer — no database configured, a
 * transient error, no row — honours the sealed context unchanged, because the
 * alternative is that one read blip logs out (or mis-roles) every user at once.
 * Safe because deactivation is never a delete (R62): the row is always there to
 * be read, so a missing row means something other than "deactivated". Never
 * throws: a rejected read must not become an unhandled rejection on the path.
 */
export async function revalidateTenant(tenant: TenantContext): Promise<TenantContext | null> {
  if (!db) return tenant;
  let membership: { status: string; role?: string } | undefined;
  try {
    membership = await db.query.memberships.findFirst({
      where: and(
        eq(schema.memberships.userId, tenant.userId),
        eq(schema.memberships.orgId, tenant.orgId),
      ),
    });
  } catch {
    return tenant;
  }
  if (!membership) return tenant;
  if (membership.status === DEACTIVATED_STATUS) return null;
  // Refresh the role from the live row — the sealed cookie's may be stale after
  // a demotion. Absent role (only in test doubles; the column is NOT NULL) keeps
  // the sealed value under the same fail-open reasoning.
  if (membership.role && membership.role !== tenant.role) {
    return { ...tenant, role: membership.role as TenantContext['role'] };
  }
  return tenant;
}
