import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant, SESSION_COOKIE_NAME } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { sealSession } from '../auth/replit-auth.js';
import { BCRYPT_COST, SESSION_COOKIE_OPTIONS } from './auth.js';
import { checkSeatAvailability, lockOrgForSeats, poolFor, seatLimitError } from '../lib/seats.js';
import { recordExpansion, seatOrExpand, type SeatExpansion } from '../lib/seat-blocks.js';
import { insertUserWithUsername } from '../lib/username.js';
import { db } from '../db.js';

export const publicInvitesRouter: Router = Router();
export const invitesRouter: Router = Router();

/**
 * A refusal an acceptance transaction settled on, relayed once it has closed.
 * Both paths return one rather than writing the response from inside the
 * callback, so the transaction's lifetime stays visibly bounded by its braces.
 */
interface Refusal {
  status: number;
  body: unknown;
}

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

    // ── Seat check, claim, and join: one transaction ──────────────────────
    // Accepting an invite creates an active membership, and acceptance is the
    // LAST line of defence for the seat limit — a pending invite reserves
    // nothing, so an org can hold many more outstanding invites than it has
    // free seats. Bulk QR codes handed out at a site induction land several
    // acceptances within the same second. Counting and inserting as two loose
    // statements lets two of them both read `used = limit - 1`, both pass, and
    // both join. `lockOrgForSeats` closes that by serialising acceptances for
    // this org; see its comment for why the lock must lead and why it only
    // works inside a transaction.
    //
    // Claiming the invite moved in here too, which fixes a second window for
    // free: a membership INSERT that failed used to leave the token spent with
    // nobody joined, stranding the holder.
    let expansion: SeatExpansion | null = null;
    const refusal = await db.transaction(async (tx): Promise<Refusal | null> => {
      const org = await lockOrgForSeats(tx, invite.orgId);
      if (org) {
        const check = await checkSeatAvailability(tx, org, invite.role);
        /*
          A full CANDIDATE pool expands here rather than refusing (U37, R80,
          R86). Somebody standing at a site induction with a QR code in their
          hand is not the person to settle a billing question with — and the
          invitation was issued precisely so they could join.

          The expansion write holds the lock this count was taken under, which is
          what stops two acceptances arriving together buying a block each for
          one seat. A full STAFF pool still refuses.
        */
        const resolved = await seatOrExpand(tx, org, check);
        expansion = resolved.expansion;
        if (!check.ok && !expansion) return { status: 403, body: seatLimitError(check, org.planTier) };
      }

      // `acceptedAt IS NULL` in the WHERE makes acceptance single-use.
      const [claimed] = await tx
        .update(schema.invites)
        .set({ acceptedAt: new Date(), acceptedByUserId: userId })
        .where(and(eq(schema.invites.id, invite.id), isNull(schema.invites.acceptedAt)))
        .returning();
      if (!claimed) return { status: 404, body: { error: 'invite_not_found' } };

      // `onConflictDoNothing` rather than catching a unique violation, which is
      // what this was before the transaction: a raised error poisons the whole
      // transaction, so swallowing it would silently roll the claim above back
      // and still answer 200. Conflicts here mean the same user accepted twice
      // at once — already counted, so no seat is consumed by skipping.
      await tx
        .insert(schema.memberships)
        .values({
          userId,
          orgId: invite.orgId,
          role: invite.role,
          status: 'active',
        })
        .onConflictDoNothing();

      return null;
    });
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }

    const tenant = { userId, orgId: invite.orgId, role: invite.role };
    if (expansion) await recordExpansion(db, tenant, expansion, 'invitation accepted');
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

/** What the signup transaction settled on: the new account, or a refusal. */
type SignupOutcome = { refusal: Refusal } | { user: { id: string }; refusal?: never };

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

    /*
      Advisory seat check: refuses an obviously-full org before this route spends
      a deliberately-slow bcrypt hash on a request that cannot succeed. Unlocked,
      so it can be overtaken — the BINDING check is the locked one in the
      transaction below. Kept here as well as there because hashing inside the
      transaction would hold the org row lock for the length of a KDF,
      serialising every concurrent signup for the org behind it.

      IT STOPS REFUSING ON THE CANDIDATE POOL (U37), and it performs NO
      EXPANSION. That combination is the point: writing a charged block from an
      unlocked check is exactly the double-charge the lock exists to prevent, so
      this one defers and lets the locked check a few statements later decide.
      Its only remaining job is the staff pool, where a refusal here saves the
      hash on a request the locked check will refuse anyway.
    */
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, invite.orgId),
    });
    if (org && poolFor(invite.role) === 'staff') {
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

    // Hashed BEFORE the transaction opens, deliberately — see above.
    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);

    /** Set inside the transaction below; audited after it commits (R86). */
    let signupExpansion: SeatExpansion | null = null;

    // Same transaction as `/accept`, for the same reason: the seat count and
    // the membership INSERT it guards have to be one indivisible step or
    // concurrent acceptances both pass a count neither of them changed yet.
    //
    // Account creation is inside it as well, so a seat refusal or a lost claim
    // takes the half-made account with it. An orphaned users row would be worse
    // than no row at all: the retry, once a seat frees, would hit
    // `account_exists` — and this route will not touch an existing account, so
    // the person would be permanently unable to redeem their own invite.
    const outcome = await db.transaction(async (tx): Promise<SignupOutcome> => {
      const locked = await lockOrgForSeats(tx, invite.orgId);
      if (locked) {
        const check = await checkSeatAvailability(tx, locked, invite.role);
        // The binding check, so this is where a full candidate pool buys its
        // block (U37, R86) — under the lock, once, for one seat.
        const resolved = await seatOrExpand(tx, locked, check);
        signupExpansion = resolved.expansion;
        if (!check.ok && !resolved.expansion) {
          return { refusal: { status: 403, body: seatLimitError(check, locked.planTier) } };
        }
      }

      /*
        Issued in the SAME transaction as the row it belongs to (R21, KTD21), so
        no `users` row can land without one — the acceptance path is where most
        candidates are actually born.
      */
      const user = await insertUserWithUsername(tx, { name: parsed.data.name, email, passwordHash });
      if (!user) throw new Error('invite_signup_failed: user insert returned no row');

      const [claimed] = await tx
        .update(schema.invites)
        .set({ acceptedAt: new Date(), acceptedByUserId: user.id })
        .where(and(eq(schema.invites.id, invite.id), isNull(schema.invites.acceptedAt)))
        .returning();
      if (!claimed) {
        // Someone else redeemed it between the read and the write.
        return { refusal: { status: 404, body: { error: 'invite_not_found' } } };
      }

      await tx.insert(schema.memberships).values({
        userId: user.id,
        orgId: invite.orgId,
        role: invite.role,
        status: 'active',
      });

      return { user };
    });
    if (outcome.refusal) {
      res.status(outcome.refusal.status).json(outcome.refusal.body);
      return;
    }

    const tenant = { userId: outcome.user.id, orgId: invite.orgId, role: invite.role };
    if (signupExpansion) await recordExpansion(db, tenant, signupExpansion, 'invitation accepted at signup');
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
