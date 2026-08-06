import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATEGORIES,
  ROLES,
  type PermissionMatrix,
  type Role,
} from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { recordAudit } from '../audit/record.js';
import { sendInviteEmail } from '../email/resend.js';
import { env } from '../env.js';
import { checkSeatAvailability, lockOrgForSeats, poolFor, seatLimitError } from '../lib/seats.js';
import { readPlacement, writePlacement } from '../lib/membership-placement.js';
import { assignForMembership } from '../lib/assignment.js';
import { identifyMember, loadDisplayIdentities } from '../lib/display-identity.js';
import { db } from '../db.js';

export const teamRouter: Router = Router();

const canViewTeam = (tenant: { orgId: string; role: string }) => hasPermission(tenant, 'team', 'view');

const permissionActions = [
  'view',
  'create',
  'edit',
  'delete',
  'export',
  'invite',
  'manage',
  'approve',
] as const;

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
    /*
      R24: a name alone is not an identification. Resolved live from the profile
      rather than stored on the membership, so a corrected number corrects itself
      here without a write (R61). Members with no profile yet keep the name this
      list already showed.
    */
    const identities = await loadDisplayIdentities(db, tenant.orgId, userIds);

    res.json([
      ...memberships.map((m) => {
        const u = userById.get(m.userId);
        const identified = identifyMember(identities, m.userId, u?.name ?? '');
        return {
          id: m.id,
          /*
            The USER id, distinct from the membership id above. Anything that
            records something against a person — an assessment case, a
            competency grant — keys on this, and it used to be resolved here
            and thrown away, so opening the first case meant querying the
            database by hand. A pending invite has no user yet, hence null.
          */
          userId: m.userId,
          name: identified.name,
          /** The organisation-assigned number shown beside the name; null until one is issued (R24). */
          identifier: identified.identifier,
          email: u?.email ?? '',
          role: m.role,
          status: m.status,
        };
      }),
      ...pendingInvites.map((i) => ({
        id: i.id,
        // Nobody has accepted yet, so there is no user to key anything to. A
        // caller that needs a person must skip these rather than fall back to
        // the invite id, which belongs to a different table.
        userId: null,
        // A QR-delivered invite has no email at all, so the recorded name is
        // the only way to tell pending rows apart.
        name: i.inviteeName || nameFromEmail(i.email ?? '') || i.email || 'Pending invite',
        /*
          Always null here: nobody has accepted, so there is no membership to
          carry a profile and no number to resolve. The key is present anyway so
          every row in this list has one shape for the caller to read.
        */
        identifier: null,
        email: i.email ?? '',
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

/**
 * Inviting someone.
 *
 * `email` is OPTIONAL because many candidates have no work address — their
 * invite is delivered as a printed QR code instead. When it is omitted a name
 * is required, so a pending invite is still identifiable in the member list.
 */
const postMemberBody = z
  .object({
    email: z.string().trim().email().optional(),
    role: z.enum(ROLES),
    name: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.email || v.name), {
    message: 'an invite needs an email address or a name',
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
    const normalizedEmail = parsed.data.email?.toLowerCase() ?? null;
    const displayName =
      name ?? (normalizedEmail ? nameFromEmail(normalizedEmail) || normalizedEmail : 'Invited');

    // Seat limit check — staff and candidates draw on separate pools. The
    // resolution rules live in lib/seats.ts alongside the acceptance-time
    // check, so both ends of an invite cannot drift apart.
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, tenant.orgId),
    });
    if (org) {
      const check = await checkSeatAvailability(db, org, role);
      if (!check.ok) {
        res.status(403).json(seatLimitError(check, org.planTier));
        return;
      }
    }

    // Duplicate check: already a member of this org. Only possible when an
    // address was given — a QR invite has nobody to match against yet.
    const candidates = normalizedEmail
      ? await db.query.users.findMany({
          where: sql`lower(${schema.users.email}) = ${normalizedEmail}`,
        })
      : [];
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
        .values({
          orgId: tenant.orgId,
          email: normalizedEmail,
          inviteeName: name ?? '',
          role,
          token: generateInviteToken(),
        })
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
      target: normalizedEmail ?? displayName,
      category: 'team',
      icon: 'user-plus',
    });

    // Only attempt delivery when there is somewhere to deliver to. A QR invite
    // reports emailSent:false, which the UI already reads as "share the link".
    let emailSent = false;
    try {
      if (!invite.email) throw new Error('no_email_delivery');
      const [org, inviter] = await Promise.all([
        db.query.organizations.findFirst({ where: eq(schema.organizations.id, tenant.orgId) }),
        db.query.users.findFirst({ where: eq(schema.users.id, tenant.userId) }),
      ]);
      emailSent = await sendInviteEmail({
        to: invite.email!,
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
      email: invite.email ?? '',
      role: invite.role,
      status: 'invited',
      emailSent,
      /**
       * The acceptance link, returned so the admin can print it as a QR or
       * hand it over directly. This is the invite's whole credential, which is
       * why only a team manager reaches this route at all.
       */
      acceptPath: `/invite/${invite.token}`,
    });
  }),
);

/**
 * Issue a one-time link that lets a member set their OWN password.
 *
 * Deliberately does NOT set a password. An admin who could choose a candidate's
 * password could sign in as them, and the same admins mark the assessments
 * those candidates sit — so a signed "satisfactory" would no longer prove the
 * candidate was ever there. The admin gets a link to hand over; the candidate
 * chooses the secret.
 */
teamRouter.post(
  '/members/:id/password-reset',
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

    // Scoped to a membership in the CALLER's org — the id is a membership id,
    // so an admin cannot raise a reset against a user in someone else's tenant.
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const [reset] = await db
      .insert(schema.passwordResets)
      .values({
        userId: membership.userId,
        orgId: tenant.orgId,
        token: generateInviteToken(),
        issuedByUserId: tenant.userId,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      })
      .returning();
    if (!reset) throw new Error('password_reset_failed: insert returned no row');

    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, membership.userId),
    });

    await recordAudit(db, tenant, {
      action: 'Issued password reset',
      target: user?.email ?? user?.name ?? membership.userId,
      category: 'team',
      icon: 'key-round',
    });

    res.status(201).json({
      resetPath: `/reset-password/${reset.token}`,
      expiresAt: reset.expiresAt.toISOString(),
      name: user?.name ?? '',
    });
  }),
);

/** Long enough to hand a printed code over on site, short enough to expire. */
const PASSWORD_RESET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Placement (R21, R22) — the same act for every member, whatever level ─────

const placementBody = z.object({
  locationIds: z.array(z.string().uuid()),
  departmentIds: z.array(z.string().uuid()),
  roleIds: z.array(z.string().uuid()),
});

teamRouter.get(
  '/members/:id/placement',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canViewTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(await readPlacement(db, membership.id));
  }),
);

teamRouter.put(
  '/members/:id/placement',
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
    const parsed = placementBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const result = await writePlacement(db, tenant.orgId, membership.id, parsed.data);
    if (!result.ok) {
      res.status(400).json({ error: 'invalid_placement', code: result.error.code, subjectId: result.error.subjectId });
      return;
    }
    await recordAudit(db, tenant, {
      action: 'Placed member',
      target: membership.id,
      category: 'team',
      icon: 'map-pin',
    });
    // Placement is one of the four triggers that assign (U11, R47, R51):
    // changing the Roles a person holds gives them their new Roles' required
    // assessments, and the run is idempotent so no case is duplicated.
    await assignForMembership(db, tenant.orgId, membership.id);
    res.json(await readPlacement(db, membership.id));
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

      // Same pool-crossing rule as the membership branch below, but ADVISORY:
      // a pending invite reserves nothing, so this is the courtesy refusal the
      // dialog shows, exactly as at invite creation. It is here because
      // without it "create a viewer invite, then PATCH it to candidate" walks
      // straight around the creation-time check on the candidate pool. Same-pool
      // changes need no check — creation already cleared that pool.
      if (poolFor(invite.role) !== poolFor(nextInviteRole)) {
        const inviteOrg = await db.query.organizations.findFirst({
          where: eq(schema.organizations.id, tenant.orgId),
        });
        if (inviteOrg) {
          const check = await checkSeatAvailability(db, inviteOrg, nextInviteRole);
          if (!check.ok) {
            res.status(403).json(seatLimitError(check, inviteOrg.planTier));
            return;
          }
        }
      }

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
        name: invite.inviteeName || nameFromEmail(invite.email ?? '') || invite.email || 'Pending invite',
        email: invite.email ?? '',
        role: nextInviteRole,
        status: 'invited',
      });
      return;
    }
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, membership.userId) });
    const previousRole = membership.role;
    const nextRole = parsed.data.role;

    // ── Seat limit check ──────────────────────────────────────────────────
    // A role change only consumes a seat when it CROSSES pools. Promoting an
    // operator who now runs their own inductions (candidate → assessor) moves
    // them out of the candidate pool and into the staff one, which is a new
    // staff seat; viewer → builder moves nobody and can never breach a limit,
    // so a full pool it is not joining must not refuse it. Crossing the other
    // way frees a seat and is always allowed.
    //
    // The member is not in the target pool yet, so the plain `used < limit`
    // asks the right question. A non-active membership is in NEITHER pool —
    // the count is of active rows — so re-roling a suspended member consumes
    // nothing and is not gated.
    //
    // Transaction and row lock for the same reason invite acceptance has
    // them: the count and the UPDATE it guards must be one indivisible step,
    // or two admins promoting two candidates at once both pass a count that
    // neither of them has changed yet. See lib/seats.ts.
    const consumesSeat = membership.status === 'active' && poolFor(previousRole) !== poolFor(nextRole);
    const refusal = await db.transaction(async (tx) => {
      if (consumesSeat) {
        const org = await lockOrgForSeats(tx, tenant.orgId);
        if (org) {
          const check = await checkSeatAvailability(tx, org, nextRole);
          if (!check.ok) return seatLimitError(check, org.planTier);
        }
      }
      await tx.update(schema.memberships).set({ role: nextRole }).where(eq(schema.memberships.id, membership.id));
      return null;
    });
    if (refusal) {
      res.status(403).json(refusal);
      return;
    }

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
        target: invite.email ?? (invite.inviteeName || invite.id),
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
    const stored = new Map(rows.map((r) => [r.role, r.matrix]));
    // Return EVERY access level (R28), falling back to the product default for
    // one the org never customised — so Assessor and Candidate show the
    // capabilities they already hold rather than reading as all-off, matching
    // what the enforcement side (permissions.ts matrixFor) resolves.
    const result: Partial<Record<Role, PermissionMatrix>> = {};
    for (const role of ROLES) {
      result[role] = stored.get(role) ?? DEFAULT_ROLE_PERMISSIONS[role];
    }
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
      // The matrix this change applies to: the stored one, or the product
      // default when the org never customised this level. Assessor and Candidate
      // are exactly the levels most likely to have no stored row, so without
      // this a toggle on either wrote nothing and returned 200 unchanged.
      const baseMatrix = row?.matrix ?? DEFAULT_ROLE_PERMISSIONS[role];

      // A scoped ('own') grant cannot be represented by this two-state control,
      // and the toggle below would read it as truthy and collapse it to `false`
      // — silently destroying the scope that keeps a candidate confined to their
      // own records. Refuse instead.
      if (baseMatrix[category]?.[action] === 'own') {
        res.status(409).json({
          error: 'scoped_permission',
          message: `${role}: ${category}.${action} is scoped to own records and cannot be toggled here.`,
        });
        return;
      }

      const nextAllowed = allowed ?? !(baseMatrix[category]?.[action] ?? false);
      const nextMatrix: PermissionMatrix = {
        ...baseMatrix,
        [category]: { ...baseMatrix[category], [action]: nextAllowed },
      };
      if (row) {
        await db
          .update(schema.rolePermissions)
          .set({ matrix: nextMatrix })
          .where(eq(schema.rolePermissions.id, row.id));
      } else {
        // Materialise the level's row from its default and insert (upsert), so
        // the write side and the read-side fallback in permissions.ts cannot
        // disagree.
        await db
          .insert(schema.rolePermissions)
          .values({ orgId: tenant.orgId, role, matrix: nextMatrix });
      }
      await recordAudit(db, tenant, {
        action: 'Updated permissions',
        target: `${role}: ${category}.${action} → ${nextAllowed ? 'allowed' : 'denied'}`,
        category: 'settings',
        icon: 'shield',
      });
    }

    const rows = await db.query.rolePermissions.findMany({
      where: eq(schema.rolePermissions.orgId, tenant.orgId),
    });
    const result: Partial<Record<Role, PermissionMatrix>> = {};
    for (const r of rows) result[r.role] = r.matrix;
    res.json(result);
  }),
);
