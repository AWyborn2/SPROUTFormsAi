import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import { db } from '../db.js';
import { requireTenant, SESSION_COOKIE_NAME } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { getStorageClient } from '../storage/index.js';
import { SESSION_COOKIE_OPTIONS } from './auth.js';

export const accountRouter: Router = Router();

/**
 * Self-service account deletion. Solo member of their org (the common case
 * for a test/trial org) takes the whole organization and its data with them;
 * a member of a multi-person org just leaves it, unless they're the last
 * owner — mirrors `DELETE /team/members/:id`'s last-owner guard, since
 * self-removal shouldn't be able to do what removing someone else can't.
 *
 * Pending invites need no special handling here: an invite is a row in
 * `invites`, not a `users` row plus a membership, so it can't inflate the
 * member count, keep an org alive, or trip the last-owner guard. The org's
 * invites go with it via `invites.orgId`'s `ON DELETE cascade`.
 *
 * `submissions.templateId` references `form_templates.id` with `ON DELETE
 * RESTRICT` (submissions must pin an existing template), so the org-wide
 * deletion below deletes submissions before templates explicitly rather than
 * relying on a single cascading `DELETE FROM organizations` to sequence that
 * correctly. The whole cascade — including the caller's own `users` row when
 * no memberships remain — runs in one transaction, so a mid-cascade failure
 * can't leave the org half-deleted.
 */
accountRouter.delete(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;

    const orgMemberships = await db.query.memberships.findMany({
      where: eq(schema.memberships.orgId, tenant.orgId),
    });
    const mine = orgMemberships.find((m) => m.userId === tenant.userId);
    const others = orgMemberships.filter((m) => m.userId !== tenant.userId);

    const orgDeleted = others.length === 0;

    if (!orgDeleted && mine?.role === 'owner' && !others.some((m) => m.role === 'owner')) {
      res.status(403).json({ error: 'cannot_delete_last_owner' });
      return;
    }

    // `recordAudit` requires the root `Db` (drizzle's transaction handle lacks
    // its `$client` property), so the audit insert lands just before the
    // transaction — same ordering as PR #18. Worst case a failed membership
    // delete leaves a stray audit row, never a silent unaudited removal.
    if (!orgDeleted) {
      await recordAudit(db, tenant, {
        action: 'Deleted account',
        target: 'Left organization',
        category: 'security',
        icon: 'trash-2',
      });
    }

    await db.transaction(async (tx) => {
      if (orgDeleted) {
        await tx.delete(schema.submissions).where(eq(schema.submissions.orgId, tenant.orgId));
        await tx.delete(schema.competencyRules).where(eq(schema.competencyRules.orgId, tenant.orgId));
        await tx.delete(schema.competencies).where(eq(schema.competencies.orgId, tenant.orgId));
        await tx.delete(schema.formTemplates).where(eq(schema.formTemplates.orgId, tenant.orgId));
        await tx.delete(schema.auditLogEntries).where(eq(schema.auditLogEntries.orgId, tenant.orgId));
        await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.orgId, tenant.orgId));
        await tx.delete(schema.memberships).where(eq(schema.memberships.orgId, tenant.orgId));
        await tx.delete(schema.organizations).where(eq(schema.organizations.id, tenant.orgId));
      } else if (mine) {
        await tx.delete(schema.memberships).where(eq(schema.memberships.id, mine.id));
      }

      const remainingMemberships = await tx.query.memberships.findMany({
        where: eq(schema.memberships.userId, tenant.userId),
      });
      if (remainingMemberships.length === 0) {
        await tx.delete(schema.users).where(eq(schema.users.id, tenant.userId));
      }
    });

    // Best-effort storage cleanup, strictly after commit: a storage failure
    // must never resurrect the org, so log and keep the 200.
    if (orgDeleted) {
      try {
        await getStorageClient()?.deletePrefix(tenant.orgId);
      } catch (err) {
        console.error(`storage cleanup failed for deleted org ${tenant.orgId}:`, err);
      }
    }

    const { maxAge: _maxAge, ...clearOptions } = SESSION_COOKIE_OPTIONS;
    res.clearCookie(SESSION_COOKIE_NAME, clearOptions);
    res.status(200).json({ orgDeleted });
  }),
);
