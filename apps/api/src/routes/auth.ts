import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { eq, or } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PLAN_CONFIG, schema, type PlanTier } from '@formai/db';
import type { SessionInfo, TenantContext } from '@formai/shared';
import { db } from '../db.js';
import { sealSession, unsealSession } from '../auth/replit-auth.js';
import { DeactivatedMemberError, provisionTenant } from '../auth/tenant-provisioning.js';
import { SESSION_COOKIE_NAME } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { insertUserWithUsername } from '../lib/username.js';

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

/** Cost factor for every bcrypt hash the app mints (signup and the dummy hash below). */
/** Cost factor for every bcrypt hash the app mints. Exported so the
 * invite-signup path cannot drift to a weaker cost than signup. */
export const BCRYPT_COST = 12;

/**
 * Structurally valid, full-cost bcrypt hash of a random string, minted once at
 * module load. When a login hits an unknown email we still run bcrypt.compare
 * against this hash so the request does the same full-cost work as a real
 * compare — a malformed constant would let bcrypt short-circuit and reopen the
 * email-enumeration timing oracle. It hashes random bytes, so no input can
 * ever match it. Exported for tests only.
 */
export const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_COST);

export const authRouter: Router = Router();

const signupSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  orgName: z.string().min(1).optional(),
  /**
   * 'individual' → solo workspace, auto-named "{name}'s workspace",
   *   planTier='individual', seatLimit=1, orgName ignored.
   * 'team' → shared org, keeps orgName, planTier='team', seatLimit=5.
   * Defaults to 'team' when omitted for backward compatibility.
   */
  accountKind: z.enum(['individual', 'team']).default('team'),
});

/**
 * R22: a person signs in with their username OR their email address, so the
 * field is an IDENTIFIER and cannot be validated as an email — a `.email()`
 * rule here would reject every generated username before the lookup ran.
 *
 * `identifier` also accepts the legacy `email` key, so a client that has not
 * been updated keeps working; the web form sends the new name.
 */
const loginSchema = z
  .object({
    identifier: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    password: z.string().min(1),
  })
  .transform((v) => ({ identifier: (v.identifier ?? v.email ?? '').trim(), password: v.password }))
  .refine((v) => v.identifier.length > 0, {
    message: 'A username or email address is required',
    path: ['identifier'],
  });

// ── Helpers ────────────────────────────────────────────────────────────────

async function buildSessionInfo(tenant: TenantContext): Promise<SessionInfo> {
  if (!db) throw new Error('db_unavailable');
  const [org, user] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, tenant.orgId) }),
    db.query.users.findFirst({ where: eq(schema.users.id, tenant.userId) }),
  ]);
  return {
    ...tenant,
    orgName: org?.name ?? '',
    userName: user?.name ?? '',
    userEmail: user?.email ?? '',
    accountKind: (org?.accountKind ?? 'team') as SessionInfo['accountKind'],
    branding: org?.branding ?? null,
    teamSize: org?.teamSize ?? null,
    onboardingCompletedAt: org?.onboardingCompletedAt?.toISOString() ?? null,
    /*
      Resolved here rather than in the web, which cannot import PLAN_CONFIG and
      would otherwise keep a hand-copied mirror of it. Null where the org row
      could not be read — the nav reads that as "show nothing gated", and the
      API's own `requirePlanFeature` remains the boundary regardless.
    */
    features: org ? (PLAN_CONFIG[org.planTier as PlanTier]?.features ?? null) : null,
  };
}

// ── POST /auth/signup ──────────────────────────────────────────────────────

authRouter.post(
  '/signup',
  withErrorHandling(async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.issues });
      return;
    }
    const { name, email, password, accountKind } = parsed.data;
    // For individual accounts, orgName is ignored — the org is auto-named.
    const orgName = accountKind === 'individual' ? undefined : parsed.data.orgName;

    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    const existing = await db.query.users.findFirst({
      where: eq(schema.users.email, email),
    });
    if (existing) {
      res.status(409).json({ error: 'email_taken', message: 'An account with this email already exists.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    // Self-signup is one of the three places a person is born (R21, KTD21).
    await insertUserWithUsername(db, { name, email, passwordHash });

    const tenant = await provisionTenant(db, { name, email, orgName, accountKind });

    res.cookie(SESSION_COOKIE_NAME, sealSession(tenant), SESSION_COOKIE_OPTIONS);

    const session = await buildSessionInfo(tenant);
    res.status(201).json(session);
  }),
);

// ── POST /auth/login ───────────────────────────────────────────────────────

authRouter.post(
  '/login',
  withErrorHandling(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.issues });
      return;
    }
    const { identifier, password } = parsed.data;

    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    /*
      R22: either credential reaches the same account. The lookup is ONE query
      over both columns rather than an email query followed by a username one —
      two sequential reads would make an unknown email measurably slower than an
      unknown username, rebuilding on the new identifier exactly the enumeration
      oracle the dummy-hash comparison below exists to close.

      Both are compared case-sensitively, matching how the email lookup has
      always behaved. Usernames are case-folded at generation (see
      `lib/username.ts`), so a generated one always matches what was issued.
    */
    const user = await db.query.users.findFirst({
      where: or(eq(schema.users.email, identifier), eq(schema.users.username, identifier)),
    });

    // Constant-time path even when no user is found — prevents enumeration via
    // timing, on either credential.
    const hashToVerify = user?.passwordHash ?? DUMMY_HASH;
    const valid = await bcrypt.compare(password, hashToVerify);

    if (!user || !valid) {
      res
        .status(401)
        .json({ error: 'invalid_credentials', message: 'Invalid username or password.' });
      return;
    }

    let tenant;
    try {
      tenant = await provisionTenant(db, { name: user.name, email: user.email });
    } catch (err) {
      if (err instanceof DeactivatedMemberError) {
        /*
          R64: a deactivated member cannot sign in. Refused with the SAME body a
          wrong password gets — whether an account has been deactivated is not
          something an unauthenticated caller should be able to discover, and a
          distinct message here would turn the login form into a way to ask.
        */
        res
          .status(401)
          .json({ error: 'invalid_credentials', message: 'Invalid username or password.' });
        return;
      }
      throw err;
    }

    res.cookie(SESSION_COOKIE_NAME, sealSession(tenant), SESSION_COOKIE_OPTIONS);

    const session = await buildSessionInfo(tenant);
    res.json(session);
  }),
);

// ── POST /auth/logout ──────────────────────────────────────────────────────

authRouter.post('/logout', (_req, res) => {
  const { maxAge: _maxAge, ...clearOptions } = SESSION_COOKIE_OPTIONS;
  res.clearCookie(SESSION_COOKIE_NAME, clearOptions);
  res.status(204).end();
});

// ── GET /auth/me ───────────────────────────────────────────────────────────

authRouter.get(
  '/me',
  withErrorHandling(async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    const tenant = typeof token === 'string' ? unsealSession<TenantContext>(token) : null;

    if (!tenant) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    const session = await buildSessionInfo(tenant);
    res.json(session);
  }),
);
