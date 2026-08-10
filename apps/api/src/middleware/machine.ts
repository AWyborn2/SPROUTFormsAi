import type { NextFunction, Request, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { TenantContext } from '@formai/shared';
import { unsealSession } from '../auth/replit-auth.js';
import { bearerToken, parseApiKey, verifyApiKey } from '../auth/api-key.js';
import { DEACTIVATED_STATUS, SESSION_COOKIE_NAME, revalidateTenant } from './tenant.js';
import { db } from '../db.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set when the request authenticated with an API key rather than a session. */
      apiKeyId?: string;
      /**
       * The plaintext key this request authenticated with, kept so a handler
       * that proxies onward (the MCP router) can forward the caller's own
       * credential rather than minting authority of its own.
       */
      machineApiKey?: string;
    }
  }
}

/**
 * Resolves `req.tenant` from EITHER a session cookie or an org-scoped API key.
 *
 * Mounted only on machine-facing routers. Teaching `requireTenant` itself to
 * accept a bearer token would have made every existing endpoint — team
 * management, billing, submission deletion — machine-callable in one edit, with
 * nothing at the call sites to notice. Keeping the machine door a separate
 * middleware means the set of endpoints an API key can reach is exactly the set
 * someone deliberately mounted it on, and widening it is a visible act.
 *
 * Every rejection is the same opaque `401 unauthenticated`. An unknown prefix,
 * a wrong secret, a revoked key and an orphaned issuer must be
 * indistinguishable, or the response becomes an oracle for enumerating which
 * prefixes exist.
 */
/**
 * Resolves a presented key to the context it authenticates, or null.
 *
 * Shared by both machine doors — the `Authorization` header and the
 * URL-credentialed connector path — so revocation, issuer resolution and the
 * last-used stamp cannot drift apart between them.
 */
/**
 * Whether the issuer holds a DEACTIVATED membership of the key's organisation.
 *
 * Only a KNOWN-deactivated membership counts. A read that fails, or an
 * organisation whose membership row cannot be found, answers false — this
 * decides a display label, not access, and a database hiccup must not start
 * renaming the actor on audit entries. The same fail-open-on-unknown posture
 * `revalidateTenant` takes, for the same reason.
 */
async function issuerIsDeactivated(orgId: string, userId: string): Promise<boolean> {
  if (!db) return false;
  try {
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)),
    });
    return membership?.status === DEACTIVATED_STATUS;
  } catch {
    return false;
  }
}

async function resolveApiKey(
  presented: string,
): Promise<{ tenant: TenantContext; apiKeyId: string } | null> {
  const parsed = parseApiKey(presented);
  if (!parsed || !db) return null;

  const key = await db.query.apiKeys.findFirst({
    where: and(eq(schema.apiKeys.prefix, parsed.prefix), isNull(schema.apiKeys.revokedAt)),
  });
  if (!key || !verifyApiKey(presented, key.hash) || !key.createdByUserId) return null;

  // Machine calls act as the issuing administrator: `TenantContext.userId` is
  // non-nullable and `recordAudit` resolves it to name the actor, so an agent's
  // writes are attributable to whoever authorised the key.
  const issuer = await db.query.users.findFirst({
    where: eq(schema.users.id, key.createdByUserId),
  });
  if (!issuer) return null;

  /*
    The key KEEPS WORKING when its issuer is deactivated, because it is the
    organisation's credential rather than theirs — its own role, its own
    lifecycle, revocable by any Admin. Cutting it here would turn somebody
    leaving into an unannounced outage of whatever integration it drives.

    What must NOT survive is the attribution. Naming a person who can no longer
    sign in as the actor on every write the key makes would have the audit trail
    assert something untrue, indefinitely. The entry keeps their id — the key
    really was theirs to authorise — and shows the key's name instead.

    An Admin is told about the key through the working list and the keys screen;
    rotating it is their decision, and R65's containment is prompted rather than
    enforced. See `lib/orphaned-keys.ts`.
  */
  const issuerDeactivated = await issuerIsDeactivated(key.orgId, issuer.id);

  // Best-effort: a last-used stamp is for detection, and failing to write it
  // must never fail the request it was observing.
  void db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, key.id))
    .catch(() => {});

  return {
    tenant: {
      userId: issuer.id,
      orgId: key.orgId,
      role: key.role,
      ...(issuerDeactivated ? { actorLabel: `${key.name} (API key)` } : {}),
    },
    apiKeyId: key.id,
  };
}

/**
 * Authenticates a key carried in the URL path rather than a header.
 *
 * This exists for one reason: Claude's custom-connector dialog accepts a URL
 * and OAuth credentials, with nowhere to put a bearer token. The credential is
 * the SAME api key — same role, same audit, same revocation, so pulling the key
 * in the app kills the connector immediately — but it travels in the URL, where
 * proxies and access logs can see it. That is a real downgrade over a header,
 * and the reason this door is separate and documented rather than the default.
 */
export function requireMachineKeyFromPath(paramName = 'key') {
  return async function machineKeyFromPath(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const presented = req.params[paramName];
    let resolved: Awaited<ReturnType<typeof resolveApiKey>> = null;
    try {
      resolved = presented ? await resolveApiKey(presented) : null;
    } catch {
      resolved = null;
    }
    if (!resolved) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    req.tenant = resolved.tenant;
    req.apiKeyId = resolved.apiKeyId;
    req.machineApiKey = presented;
    // Deliberately no cache-control override here: the streaming transport sets
    // its own (`no-cache, no-transform`, which proxies need to leave the stream
    // alone), and a response header would do nothing about the actual exposure
    // anyway — that is the URL itself, sitting in access logs and connector
    // storage. Revoking the key is the mitigation, not a header.
    next();
  };
}

export async function requireMachineOrTenant(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const unauthenticated = () => res.status(401).json({ error: 'unauthenticated' });

  const presented = bearerToken(req.header('authorization'));
  if (presented) {
    if (!db) {
      unauthenticated();
      return;
    }
    // The try covers ONLY credential resolution. `next()` runs after it —
    // inside, a synchronous throw from downstream middleware would be caught
    // here and misreported as a 401 (or double-send once headers are out).
    let resolved: Awaited<ReturnType<typeof resolveApiKey>> = null;
    try {
      resolved = await resolveApiKey(presented);
    } catch {
      unauthenticated();
      return;
    }
    if (!resolved) {
      unauthenticated();
      return;
    }
    req.tenant = resolved.tenant;
    req.apiKeyId = resolved.apiKeyId;
    req.machineApiKey = presented;
    next();
    return;
  }

  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const tenant = typeof token === 'string' ? unsealSession<TenantContext>(token) : null;
  if (!tenant) {
    unauthenticated();
    return;
  }
  // The session-cookie door revalidates exactly as `requireTenant` does — a
  // membership deactivated since the cookie was sealed is refused, and a stale
  // role is corrected. Without this the machine-facing routes (/inductions,
  // /mcp) would honour a leaver's cookie that every other route now rejects.
  const current = await revalidateTenant(tenant);
  if (!current) {
    unauthenticated();
    return;
  }
  req.tenant = current;
  next();
}
