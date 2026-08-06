import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { assignToolToMembership } from '../lib/assignment.js';
import { db } from '../db.js';

/**
 * Voluntary training requests (U22). A person asks for an assessment no Role
 * obliges them to hold; an Admin approves it, and approving assigns through the
 * ordinary assignment path (R94, R96). Making a request is an action on one's
 * OWN record (R37): the create route authorises on the requester being the
 * subject, so the permission matrix neither grants nor withholds it — the same
 * footing as a candidate reading their own record. Approving and listing are
 * Admin acts.
 */
export const trainingRequestsRouter: Router = Router();

const GATE = [requireTenant, requirePlanFeature('assessments')] as const;

/** Admin (or Owner ⊇ Admin) — approving and the org-wide list are Admin acts. */
function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

function requestDto(r: typeof schema.trainingRequests.$inferSelect) {
  return {
    id: r.id,
    userId: r.userId,
    toolId: r.toolId,
    state: r.state,
    createdAt: r.createdAt.toISOString(),
  };
}

const createBody = z.object({ toolId: z.string().uuid() });

/**
 * Request training for a tool. OWN-SCOPE (R37): the subject is always the
 * caller, never raised on another's behalf, so no matrix check applies.
 * Idempotent — a second identical request while one is still pending returns the
 * existing one rather than stacking duplicates on the working list.
 */
trainingRequestsRouter.post(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    // The tool must be the organisation's.
    const tool = await db.query.assessmentTools.findFirst({
      where: and(
        eq(schema.assessmentTools.id, parsed.data.toolId),
        eq(schema.assessmentTools.orgId, tenant.orgId),
      ),
    });
    if (!tool) {
      res.status(404).json({ error: 'tool_not_found' });
      return;
    }
    const existing = await db.query.trainingRequests.findFirst({
      where: and(
        eq(schema.trainingRequests.userId, tenant.userId),
        eq(schema.trainingRequests.toolId, parsed.data.toolId),
        eq(schema.trainingRequests.state, 'pending'),
      ),
    });
    if (existing) {
      res.json(requestDto(existing));
      return;
    }
    const [row] = await db
      .insert(schema.trainingRequests)
      .values({ orgId: tenant.orgId, userId: tenant.userId, toolId: parsed.data.toolId })
      .returning();
    if (!row) throw new Error('training_request_create_failed');
    await recordAudit(db, tenant, {
      action: 'Requested training',
      target: tool.name,
      category: 'team',
      icon: 'graduation-cap',
    });
    res.status(201).json(requestDto(row));
  }),
);

/** The org's pending requests, for an Admin to work through. Admin-only. */
trainingRequestsRouter.get(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const rows = await db.query.trainingRequests.findMany({
      where: and(
        eq(schema.trainingRequests.orgId, tenant.orgId),
        eq(schema.trainingRequests.state, 'pending'),
      ),
      orderBy: (t) => [desc(t.createdAt)],
    });
    res.json(rows.map(requestDto));
  }),
);

/** Load a pending request the caller may decide on — Admin, in-org, still pending. */
async function loadDecidableRequest(
  orgId: string,
  role: string,
  id: string,
): Promise<
  | { error: { status: number; body: unknown } }
  | { request: typeof schema.trainingRequests.$inferSelect }
> {
  if (!isAdmin(role)) return { error: { status: 403, body: { error: 'forbidden' } } };
  const request = await db!.query.trainingRequests.findFirst({
    where: and(eq(schema.trainingRequests.id, id), eq(schema.trainingRequests.orgId, orgId)),
  });
  if (!request) return { error: { status: 404, body: { error: 'not_found' } } };
  if (request.state !== 'pending')
    return { error: { status: 409, body: { error: 'already_decided' } } };
  return { request };
}

/**
 * Approve a request (Admin). Approving ASSIGNS the tool through the ordinary
 * assignment path (R94): a case is created only if the person does not already
 * hold the awarded competency current and has no open case (R45), so approving
 * something already held creates nothing. There is no route that enrols without
 * this approval (R96).
 */
trainingRequestsRouter.post(
  '/:id/approve',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const loaded = await loadDecidableRequest(tenant.orgId, tenant.role, req.params.id!);
    if ('error' in loaded) {
      res.status(loaded.error.status).json(loaded.error.body);
      return;
    }
    const { request } = loaded;

    // Resolve the subject's membership — the assignment path works on it.
    const membership = await db.query.memberships.findFirst({
      where: and(
        eq(schema.memberships.userId, request.userId),
        eq(schema.memberships.orgId, tenant.orgId),
      ),
    });

    let createdCaseIds: string[] = [];
    if (membership) {
      const result = await assignToolToMembership(db, tenant.orgId, membership.id, request.toolId);
      createdCaseIds = result.createdCaseIds;
    }

    const [row] = await db
      .update(schema.trainingRequests)
      .set({ state: 'approved', decidedByUserId: tenant.userId, decidedAt: new Date() })
      .where(eq(schema.trainingRequests.id, request.id))
      .returning();
    await recordAudit(db, tenant, {
      action: 'Approved training request',
      target: request.toolId,
      category: 'team',
      icon: 'graduation-cap',
    });
    res.json({ ...requestDto(row ?? request), state: 'approved', createdCaseIds });
  }),
);

/** Decline a request (Admin). Nothing is assigned; the item leaves the working list. */
trainingRequestsRouter.post(
  '/:id/decline',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const loaded = await loadDecidableRequest(tenant.orgId, tenant.role, req.params.id!);
    if ('error' in loaded) {
      res.status(loaded.error.status).json(loaded.error.body);
      return;
    }
    const [row] = await db
      .update(schema.trainingRequests)
      .set({ state: 'declined', decidedByUserId: tenant.userId, decidedAt: new Date() })
      .where(eq(schema.trainingRequests.id, loaded.request.id))
      .returning();
    res.json({ ...requestDto(row ?? loaded.request), state: 'declined' });
  }),
);
