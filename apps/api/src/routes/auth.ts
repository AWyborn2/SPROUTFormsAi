import { Router } from 'express';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { schema } from '@formai/db';
import type { SessionInfo, TenantContext } from '@formai/shared';
import { db } from '../db.js';
import { sealSession, unsealSession } from '../auth/replit-auth.js';
import { provisionTenant } from '../auth/tenant-provisioning.js';
import { SESSION_COOKIE_NAME } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

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

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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

    const passwordHash = await bcrypt.hash(password, 12);
    await db.insert(schema.users).values({ name, email, passwordHash });

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
    const { email, password } = parsed.data;

    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    const user = await db.query.users.findFirst({
      where: eq(schema.users.email, email),
    });

    // Constant-time path even when user is not found — prevents email enumeration via timing
    const DUMMY_HASH = '$2b$12$invalidhashforenumerationprotect00000000000000000000000';
    const hashToVerify = user?.passwordHash ?? DUMMY_HASH;
    const valid = await bcrypt.compare(password, hashToVerify);

    if (!user || !valid) {
      res.status(401).json({ error: 'invalid_credentials', message: 'Invalid email or password.' });
      return;
    }

    const tenant = await provisionTenant(db, { name: user.name, email: user.email });

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
