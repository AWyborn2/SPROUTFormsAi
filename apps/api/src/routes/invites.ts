import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant, SESSION_COOKIE_NAME } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { recordAudit } from '../audit/record.js';
import { sealSession } from '../auth/replit-auth.js';
import { BCRYPT_COST, SESSION_COOKIE_OPTIONS } from './auth.js';
import { checkSeatAvailability, seatLimitError } from '../lib/seats.js';
import { db } from '../db.js';

export const publicInvitesRouter: Router = Router();
export const invitesRouter: Router = Router();

/** Pending, unexpired, and matching the token — the only acceptable invite. */
function pendingInviteWhere(token: string) {
  return and(
    eq(schema.invites.token, token),
    isNull(schema.invites.acceptedAt),
    sql`(${schema.invites.expiresAt} IS NULL OR ${schema.invites.expiresAt} > now())`,
  );
}

publicInvitesRouter.get(
  '/:token',
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const invite = await db.query.invites.findFirst({
      where: pendingInviteWhere(req.params.token!),
    });
    if (!invite) {
      res.status(404).json({ error: 'invite_not_found' });
      return;
    }
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, invite.orgId),
    });
    res.json({
      orgName: org?.name ?? 'a team',
      role: invite.role,
      email: invite.email,
      inviteeName: invite.inviteeName,
    });
  }),
);

invitesRouter.post(
  '/:token/accept',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const { userId } = req.tenant!;
    const token = req.params.token!;

    const invite = await db.query.invites.findFirst({ where: pendingInviteWhere(token) });
    if (!invite) {
      res.status(404).json({ error: 'invite_not_found' });
      return;
    }

    const alreadyMember = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.userId, userId), eq(schema.memberships.orgId, invite.orgId)),
    });
    if (alreadyMember) {
      res.status(409).json({ error: 'already_member' });
      return;
    }

    // ── Seat limit check ──────────────────────────────────────────────────
    // Accepting an invite creates an active membership — verify there's room.
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, invite.orgId),
    });
    if (org) {
      const check = await checkSeatAvailability(db, org, invite.role);
      if (!check.ok) {
        res.status(403).json(seatLimitError(check, org.planTier));
        return;
      }
    }

    // `acceptedAt IS NULL` in the WHERE makes acceptance single-use.
    const [claimed] = await db
      .update(schema.invites)
      .set({ acceptedAt: new Date(), acceptedByUserId: userId })
      .where(and(eq(schema.invites.id, invite.id), isNull(schema.invites.acceptedAt)))
      .returning();
    if (!claimed) {
      res.status(404).json({ error: 'invite_not_found' });
      return;
    }

    try {
      await db.insert(schema.memberships).values({
        userId,
        orgId: invite.orgId,
        role: invite.role,
        status: 'active',
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }

    const tenant = { userId, orgId: invite.orgId, role: invite.role };
    await recordAudit(db, tenant, {
      action: 'Accepted invite',
      target: invite.email ?? (invite.inviteeName || invite.id),
      category: 'team',
      icon: 'user-plus',
    });

    res.cookie(SESSION_COOKIE_NAME, sealSession(tenant), SESSION_COOKIE_OPTIONS);
    res.status(200).json({ orgId: invite.orgId, role: invite.role });
  }),
);

const signupBody = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

/**
 * Accept an invite by CREATING an account — the concierge path.
 *
 * Without this, a new candidate has to sign up first, and ordinary signup
 * provisions them their own organisation. They would then accept the invite
 * from inside a junk org they never wanted, having already been counted as its
 * owner. This route makes the invite the account's origin instead: one step,
 * no stray tenant.
 *
 * The token decides which org and which ROLE. Nothing in the request body can
 * influence either — a candidate invite makes candidates, whatever is posted.
 *
 * Public by necessity: the person accepting has no session yet, which is the
 * whole point.
 */
publicInvitesRouter.post(
  '/:token/signup',
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = signupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }

    const invite = await db.query.invites.findFirst({
      where: pendingInviteWhere(req.params.token!),
    });
    if (!invite) {
      res.status(404).json({ error: 'invite_not_found' });
      return;
    }

    const email = parsed.data.email.toLowerCase();

    // An emailed invite names its recipient; honouring a different address
    // would let a forwarded email be redeemed by whoever received it. A
    // QR-delivered invite has no address to check, which is exactly why it is
    // handed over in person.
    if (invite.email && invite.email.toLowerCase() !== email) {
      res.status(409).json({ error: 'email_mismatch' });
      return;
    }

    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, invite.orgId),
    });
    if (org) {
      const check = await checkSeatAvailability(db, org, invite.role);
      if (!check.ok) {
        res.status(403).json(seatLimitError(check, org.planTier));
        return;
      }
    }

    // An existing account keeps its password: this route creates accounts, it
    // does not reset them. Letting it overwrite a password would turn any
    // invite into a takeover of the address it names.
    const existing = await db.query.users.findFirst({
      where: sql`lower(${schema.users.email}) = ${email}`,
    });
    if (existing) {
      res.status(409).json({ error: 'account_exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);
    const [user] = await db
      .insert(schema.users)
      .values({ name: parsed.data.name, email, passwordHash })
      .returning();
    if (!user) throw new Error('invite_signup_failed: user insert returned no row');

    const [claimed] = await db
      .update(schema.invites)
      .set({ acceptedAt: new Date(), acceptedByUserId: user.id })
      .where(and(eq(schema.invites.id, invite.id), isNull(schema.invites.acceptedAt)))
      .returning();
    if (!claimed) {
      // Someone else redeemed it between the read and the write.
      res.status(404).json({ error: 'invite_not_found' });
      return;
    }

    await db.insert(schema.memberships).values({
      userId: user.id,
      orgId: invite.orgId,
      role: invite.role,
      status: 'active',
    });

    const tenant = { userId: user.id, orgId: invite.orgId, role: invite.role };
    await recordAudit(db, tenant, {
      action: 'Created account from invite',
      target: email,
      category: 'team',
      icon: 'user-plus',
    });

    res.cookie(SESSION_COOKIE_NAME, sealSession(tenant), SESSION_COOKIE_OPTIONS);
    res.status(201).json({ orgId: invite.orgId, role: invite.role });
  }),
);
