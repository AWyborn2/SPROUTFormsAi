import { Router } from 'express';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { PLAN_CONFIG, schema, type PlanTier } from '@formai/db';
import { requireTenant, SESSION_COOKIE_NAME } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { recordAudit } from '../audit/record.js';
import { sealSession } from '../auth/replit-auth.js';
import { SESSION_COOKIE_OPTIONS } from './auth.js';
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
    res.json({ orgName: org?.name ?? 'a team', role: invite.role, email: invite.email });
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
      // Mirrors the invite-creation check in team.ts: candidates draw on their
      // own allowance, everyone else on staff seats. Both ends must agree, or
      // an invite that passed creation would be refused at acceptance.
      const acceptingCandidate = invite.role === 'candidate';
      const tierConfig = PLAN_CONFIG[org.planTier as PlanTier];
      const seatLimit = acceptingCandidate
        ? ((org.candidateSeatLimit as number | null) ?? tierConfig?.candidateSeatLimit)
        : ((org.seatLimit as number | null) ?? tierConfig?.seatLimit);

      if (seatLimit != null && Number.isFinite(seatLimit)) {
        const [activeSeatResult] = await db
          .select({ count: count() })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.orgId, invite.orgId),
              eq(schema.memberships.status, 'active'),
              acceptingCandidate
                ? eq(schema.memberships.role, 'candidate')
                : ne(schema.memberships.role, 'candidate'),
            ),
          );
        const activeSeats = activeSeatResult?.count ?? 0;
        if (activeSeats >= seatLimit) {
          res.status(403).json({
            error: acceptingCandidate ? 'candidate_limit_reached' : 'seat_limit_reached',
            message: `This organisation's ${org.planTier} plan is at its ${acceptingCandidate ? 'candidate' : 'seat'} limit (${seatLimit}). Ask an owner to upgrade the plan or free a seat.`,
            seatLimit,
            seatUsed: activeSeats,
          });
          return;
        }
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
      target: invite.email,
      category: 'team',
      icon: 'user-plus',
    });

    res.cookie(SESSION_COOKIE_NAME, sealSession(tenant), SESSION_COOKIE_OPTIONS);
    res.status(200).json({ orgId: invite.orgId, role: invite.role });
  }),
);
