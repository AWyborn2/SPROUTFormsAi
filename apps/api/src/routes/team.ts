import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import { PERMISSION_CATEGORIES, ROLES, type PermissionMatrix, type Role } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { recordAudit } from '../audit/record.js';
import { sendInviteEmail } from '../email/resend.js';
import { env } from '../env.js';
import { db } from '../db.js';

export const teamRouter: Router = Router();

const permissionActions = ['view', 'create', 'edit', 'delete', 'export', 'invite', 'manage'] as const;

const canManageTeam = (tenant: { orgId: string; role: string }) => hasPermission(tenant, 'team', 'manage');

teamRouter.get(
  '/members',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const [memberships, pendingInvites] = await Promise.all([
      db.query.memberships.findMany({ where: eq(schema.memberships.orgId, tenant.orgId) }),
      db.query.invites.findMany({
        where: and(eq(schema.invites.orgId, tenant.orgId), isNull(schema.invites.acceptedAt)),
      }),
    ]);
    const userIds = memberships.map((m) => m.userId);
    const users = userIds.length
      ? await db.query.users.findMany({ where: inArray(schema.users.id, userIds) })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    res.json([
      ...memberships.map((m) => {
        const u = userById.get(m.userId);
        return { id: m.id, name: u?.name ?? '', email: u?.email ?? '', role: m.role, status: m.status };
      }),
      ...pendingInvites.map((i) => ({
        id: i.id,
        name: nameFromEmail(i.email) || i.email,
        email: i.email,
        role: i.role,
        status: 'invited' as const,
      })),
    ]);
  }),
);

/** "sam.lee@x.io" → "Sam Lee" */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function generateInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

const postMemberBody = z.object({
  email: z.string().trim().email(),
  role: z.enum(ROLES),
  name: z.string().trim().min(1).optional(),
});

teamRouter.post(
  '/members',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = postMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { role, name } = parsed.data;
    const normalizedEmail = parsed.data.email.toLowerCase();
    const displayName = name ?? (nameFromEmail(normalizedEmail) || normalizedEmail);

    // ── Seat limit check ──────────────────────────────────────────────────
    // Count active memberships and compare against the org's current seatLimit.
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, tenant.orgId),
    });
    if (org) {
      const [activeSeatResult] = await db
        .select({ count: count() })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.orgId, tenant.orgId),
            eq(schema.memberships.status, 'active'),
          ),
        );
      const activeSeats = activeSeatResult?.count ?? 0;
      if (activeSeats >= org.seatLimit) {
        res.status(403).json({
          error: 'seat_limit_reached',
          message: `Your ${org.planTier} plan allows ${org.seatLimit} seat${org.seatLimit === 1 ? '' : 's'}. Remove a member or upgrade your plan to invite more people.`,
          seatLimit: org.seatLimit,
          seatUsed: activeSeats,
        });
        return;
      }
    }

    // Duplicate check: already a member of this org.
    const candidates = await db.query.users.findMany({
      where: sql`lower(${schema.users.email}) = ${normalizedEmail}`,
    });
    if (candidates.length) {
      const existingMembership = await db.query.memberships.findFirst({
        where: and(
          inArray(
            schema.memberships.userId,
            candidates.map((u) => u.id),
          ),
          eq(schema.memberships.orgId, tenant.orgId),
        ),
      });
      if (existingMembership) {
        res.status(409).json({ error: 'already_member' });
        return;
      }
    }

    let invite;
    try {
      [invite] = await db
        .insert(schema.invites)
        .values({ orgId: tenant.orgId, email: normalizedEmail, role, token: generateInviteToken() })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'already_invited' });
        return;
      }
      throw err;
    }
    if (!invite) throw new Error('invite_failed: invite insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Invited member',
      target: normalizedEmail,
      category: 'team',
      icon: 'user-plus',
    });

    let emailSent = false;
    try {
      const [org, inviter] = await Promise.all([
        db.query.organizations.findFirst({ where: eq(schema.organizations.id, tenant.orgId) }),
        db.query.users.findFirst({ where: eq(schema.users.id, tenant.userId) }),
      ]);
      emailSent = await sendInviteEmail({
        to: invite.email,
        orgName: org?.name ?? 'your team',
        inviterName: inviter?.name ?? 'A teammate',
        acceptUrl: `${env.WEB_ORIGIN}/invite/${invite.token}`,
      });
    } catch {
      emailSent = false;
    }

    res.status(201).json({
      id: invite.id,
      name: displayName,
      email: invite.email,
      role: invite.role,
      status: 'invited',
      emailSent,
    });
  }),
);

const patchMemberBody = z.object({ role: z.enum(ROLES) });

teamRouter.patch(
  '/members/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = patchMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      const invite = await db.query.invites.findFirst({
        where: and(
          eq(schema.invites.id, req.params.id!),
          eq(schema.invites.orgId, tenant.orgId),
          isNull(schema.invites.acceptedAt),
        ),
      });
      if (!invite) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const nextInviteRole = parsed.data.role;
      await db.update(schema.invites).set({ role: nextInviteRole }).where(eq(schema.invites.id, invite.id));
      if (invite.role !== nextInviteRole) {
        await recordAudit(db, tenant, {
          action: 'Changed role',
          target: `${invite.email}: ${invite.role} → ${nextInviteRole} (pending invite)`,
          category: 'team',
          icon: 'shield',
        });
      }
      res.json({
        id: invite.id,
        name: nameFromEmail(invite.email) || invite.email,
        email: invite.email,
        role: nextInviteRole,
        status: 'invited',
      });
      return;
    }
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, membership.userId) });
    const previousRole = membership.role;
    const nextRole = parsed.data.role;

    await db.update(schema.memberships).set({ role: nextRole }).where(eq(schema.memberships.id, membership.id));

    if (previousRole !== nextRole) {
      await recordAudit(db, tenant, {
        action: 'Changed role',
        target: `${user?.name ?? user?.email ?? 'Member'}: ${previousRole} → ${nextRole}`,
        category: 'team',
        icon: 'shield',
      });
    }

    res.json({ id: membership.id, name: user?.name ?? '', email: user?.email ?? '', role: nextRole, status: membership.status });
  }),
);

teamRouter.delete(
  '/members/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      const invite = await db.query.invites.findFirst({
        where: and(
          eq(schema.invites.id, req.params.id!),
          eq(schema.invites.orgId, tenant.orgId),
          isNull(schema.invites.acceptedAt),
        ),
      });
      if (!invite) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await db.delete(schema.invites).where(eq(schema.invites.id, invite.id));
      await recordAudit(db, tenant, {
        action: 'Revoked invite',
        target: invite.email,
        category: 'team',
        icon: 'user-minus',
      });
      res.status(204).end();
      return;
    }
    if (membership.role === 'owner') {
      const owners = await db.query.memberships.findMany({
        where: and(eq(schema.memberships.orgId, tenant.orgId), eq(schema.memberships.role, 'owner')),
      });
      if (owners.length <= 1) {
        res.status(403).json({ error: 'cannot_remove_last_owner' });
        return;
      }
    }
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, membership.userId) });

    await db.delete(schema.memberships).where(eq(schema.memberships.id, membership.id));

    await recordAudit(db, tenant, {
      action: 'Removed member',
      target: user?.email ?? '',
      category: 'team',
      icon: 'user-minus',
    });

    res.status(204).end();
  }),
);

teamRouter.get(
  '/permissions',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.rolePermissions.findMany({
      where: eq(schema.rolePermissions.orgId, tenant.orgId),
    });
    const result: Partial<Record<Role, PermissionMatrix>> = {};
    for (const r of rows) result[r.role] = r.matrix;
    res.json(result);
  }),
);

const patchPermissionsBody = z.object({
  role: z.enum(ROLES),
  category: z.enum(PERMISSION_CATEGORIES),
  action: z.enum(permissionActions),
  allowed: z.boolean().optional(),
});

teamRouter.patch(
  '/permissions',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = patchPermissionsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { role, category, action, allowed } = parsed.data;

    if (role !== 'owner') {
      const row = await db.query.rolePermissions.findFirst({
        where: and(eq(schema.rolePermissions.orgId, tenant.orgId), eq(schema.rolePermissions.role, role)),
      });
      if (row) {
        const nextAllowed = allowed ?? !(row.matrix[category]?.[action] ?? false);
        const nextMatrix: PermissionMatrix = {
          ...row.matrix,
          [category]: { ...row.matrix[category], [action]: nextAllowed },
        };
        await db
          .update(schema.rolePermissions)
          .set({ matrix: nextMatrix })
          .where(eq(schema.rolePermissions.id, row.id));
        await recordAudit(db, tenant, {
          action: 'Updated permissions',
          target: `${role}: ${category}.${action} → ${nextAllowed ? 'allowed' : 'denied'}`,
          category: 'settings',
          icon: 'shield',
        });
      }
    }

    const rows = await db.query.rolePermissions.findMany({
      where: eq(schema.rolePermissions.orgId, tenant.orgId),
    });
    const result: Partial<Record<Role, PermissionMatrix>> = {};
    for (const r of rows) result[r.role] = r.matrix;
    res.json(result);
  }),
);
