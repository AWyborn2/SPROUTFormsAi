import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { PLAN_CONFIG, schema, type PlanTier } from '@formai/db';
import { requireTenant, SESSION_COOKIE_NAME } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { sealSession } from '../auth/replit-auth.js';
import { SESSION_COOKIE_OPTIONS } from './auth.js';
import { db } from '../db.js';

/**
 * Self-serve candidate join links — the QR code on a toolbox-talk sheet.
 *
 * An invite is one email, one person, one use. This is one token many people
 * present, which changes the threat model entirely: the credential is printed,
 * photographed, and passed around. Three rules follow from that.
 *
 * 1. THE ROLE IS PINNED IN CODE, NOT READ FROM THE ROW. Redemption always
 *    grants `candidate` — the least-privileged role, scoped to its own records
 *    — regardless of what the stored row says. A poster on a wall must never be
 *    able to mint an administrator, and pinning it here means neither a bad
 *    create request nor a direct database edit can change that.
 *
 * 2. EVERY LINK CAN BE STOPPED. Expiry, a use cap, and revocation are all
 *    checked at redemption. A link that has left the building cannot be
 *    un-printed, so the only real control is refusing it server-side.
 *
 * 3. JOINING IS NOT SILENT. Each redemption writes an audit entry and
 *    increments a counter, so "who joined off which link" is answerable later.
 *
 * Seat limits apply exactly as they do to invites — the same candidate
 * allowance, checked the same way.
 */
export const joinLinksRouter: Router = Router();
export const publicJoinRouter: Router = Router();

/** The only role a join link may ever grant. See rule 1. */
const JOIN_ROLE = 'candidate' as const;

function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

const canManage = (tenant: { orgId: string; role: string }) =>
  hasPermission(tenant, 'team', 'manage');

function linkDto(row: typeof schema.orgJoinLinks.$inferSelect) {
  return {
    id: row.id,
    token: row.token,
    /** Path only — the web layer prefixes its own origin. */
    path: `/join/${row.token}`,
    label: row.label,
    role: row.role,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    maxUses: row.maxUses,
    useCount: row.useCount,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

const createBody = z.object({
  label: z.string().trim().max(120).optional(),
  /** ISO 8601 with offset; null/omitted = never expires. */
  expiresAt: z.string().datetime({ offset: true }).nullish(),
  maxUses: z.number().int().positive().max(10_000).nullish(),
});

joinLinksRouter.post(
  '/join-links',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManage(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }

    const [row] = await db
      .insert(schema.orgJoinLinks)
      .values({
        orgId: tenant.orgId,
        token: generateToken(),
        // Not taken from the request. See rule 1.
        role: JOIN_ROLE,
        label: parsed.data.label ?? '',
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        maxUses: parsed.data.maxUses ?? null,
        createdByUserId: tenant.userId,
      })
      .returning();
    if (!row) throw new Error('join_link_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Created candidate join link',
      target: row.label || row.id,
      category: 'team',
      icon: 'qr-code',
    });

    res.status(201).json(linkDto(row));
  }),
);

joinLinksRouter.get(
  '/join-links',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    // The listed rows contain live tokens — bearer credentials — so listing is
    // gated exactly like creating.
    if (!(await canManage(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const rows = await db.query.orgJoinLinks.findMany({
      where: eq(schema.orgJoinLinks.orgId, tenant.orgId),
      orderBy: [desc(schema.orgJoinLinks.createdAt)],
    });
    res.json(rows.map(linkDto));
  }),
);

joinLinksRouter.delete(
  '/join-links/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManage(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const row = await db.query.orgJoinLinks.findFirst({
      where: and(
        eq(schema.orgJoinLinks.id, req.params.id!),
        eq(schema.orgJoinLinks.orgId, tenant.orgId),
      ),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Deactivated, never deleted: the row is what makes past joins attributable
    // to the link that produced them.
    await db
      .update(schema.orgJoinLinks)
      .set({ active: false })
      .where(eq(schema.orgJoinLinks.id, row.id));

    await recordAudit(db, tenant, {
      action: 'Revoked candidate join link',
      target: row.label || row.id,
      category: 'team',
      icon: 'qr-code',
    });

    res.status(204).end();
  }),
);

/** Why a link cannot be redeemed, or null when it can. */
function refusalReason(row: typeof schema.orgJoinLinks.$inferSelect): string | null {
  if (!row.active) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return 'expired';
  if (row.maxUses != null && row.useCount >= row.maxUses) return 'exhausted';
  return null;
}

/**
 * What a link points at, before anyone signs in.
 *
 * Public and unauthenticated, because the person scanning the code has no
 * account yet. It reveals only the org name and the role on offer — enough to
 * decide whether to sign up, and nothing about the org's members or work.
 */
publicJoinRouter.get(
  '/:token',
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const row = await db.query.orgJoinLinks.findFirst({
      where: eq(schema.orgJoinLinks.token, req.params.token!),
    });
    if (!row) {
      res.status(404).json({ error: 'join_link_not_found' });
      return;
    }
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, row.orgId),
    });

    const reason = refusalReason(row);
    res.json({
      orgName: org?.name ?? 'this organisation',
      label: row.label,
      role: JOIN_ROLE,
      usable: reason === null,
      reason,
    });
  }),
);

/**
 * Redeem the link: join the org as a candidate.
 *
 * Requires an authenticated user — the token says which org to join, never who
 * is joining. Identity comes from the session, exactly as invite acceptance
 * does.
 */
publicJoinRouter.post(
  '/:token/accept',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const { userId } = req.tenant!;

    const link = await db.query.orgJoinLinks.findFirst({
      where: eq(schema.orgJoinLinks.token, req.params.token!),
    });
    if (!link) {
      res.status(404).json({ error: 'join_link_not_found' });
      return;
    }
    const reason = refusalReason(link);
    if (reason) {
      res.status(409).json({ error: `join_link_${reason}` });
      return;
    }

    // Already a member: succeed without touching the existing membership. A
    // trainer who scans the poster out of curiosity must not be demoted to
    // candidate by it.
    const existing = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.userId, userId), eq(schema.memberships.orgId, link.orgId)),
    });
    if (existing) {
      res.status(200).json({ orgId: link.orgId, role: existing.role, alreadyMember: true });
      return;
    }

    // Candidate seats, checked exactly as the invite paths check them.
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, link.orgId),
    });
    if (org) {
      const tierConfig = PLAN_CONFIG[org.planTier as PlanTier];
      const seatLimit =
        (org.candidateSeatLimit as number | null) ?? tierConfig?.candidateSeatLimit;
      if (seatLimit != null && Number.isFinite(seatLimit)) {
        const [used] = await db
          .select({ count: count() })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.orgId, link.orgId),
              eq(schema.memberships.status, 'active'),
              eq(schema.memberships.role, JOIN_ROLE),
            ),
          );
        if ((used?.count ?? 0) >= seatLimit) {
          res.status(403).json({
            error: 'candidate_limit_reached',
            message: `This organisation's ${org.planTier} plan allows ${seatLimit} candidates.`,
            seatLimit,
          });
          return;
        }
      }
    }

    await db.insert(schema.memberships).values({
      userId,
      orgId: link.orgId,
      role: JOIN_ROLE,
      status: 'active',
    });

    // Counted with a SQL increment rather than a read-modify-write, so two
    // people scanning the same poster at once cannot both read the same count
    // and overwrite each other — which would let a capped link be redeemed past
    // its cap.
    await db
      .update(schema.orgJoinLinks)
      .set({ useCount: sql`${schema.orgJoinLinks.useCount} + 1` })
      .where(eq(schema.orgJoinLinks.id, link.id));

    const tenant = { userId, orgId: link.orgId, role: JOIN_ROLE };
    await recordAudit(db, tenant, {
      action: 'Joined via candidate link',
      target: link.label || link.id,
      category: 'team',
      icon: 'user-plus',
    });

    // Re-seal the session onto the joined org so the candidate lands inside it.
    res.cookie(SESSION_COOKIE_NAME, sealSession(tenant), SESSION_COOKIE_OPTIONS);
    res.status(201).json({ orgId: link.orgId, role: JOIN_ROLE, alreadyMember: false });
  }),
);
