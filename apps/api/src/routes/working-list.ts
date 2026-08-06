import { Router } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { db } from '../db.js';

/**
 * The working list (U19, KTD9) — everything waiting on an Admin, from all
 * sources, on ONE list. A union over facts that already exist rather than a
 * work-item table: nothing writes to the list and nothing marks an item done, so
 * an item leaves ONLY because the underlying fact changed (R95's "emptied by
 * acting"). It gates nothing and carries no COMPLIANCE fact — an expired or
 * never-held competency is compliance reporting's business, not this (R95, R101).
 *
 * The route composes WHICHEVER sources exist. Two of the six the plan names come
 * from the candidate-profile artifact (a record's owed file, an unreachable
 * mark) and one from U24 (an incomplete import row); those are simply absent
 * queries here, not a broken response. It ships useful now with the three this
 * work owns and gains the rest as they land.
 */
export const workingListRouter: Router = Router();

function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

export type WorkingListKind = 'training_request' | 'retirement_review' | 'overdue_case';

export interface WorkingListItem {
  kind: WorkingListKind;
  /** The underlying entity's id — what an Admin acts on to clear the item. */
  id: string;
  /** A human label for the row. */
  subject: string;
  /** When the underlying fact arose, for the default age ordering; null when it has no date. */
  createdAt: string | null;
}

workingListRouter.get(
  '/',
  requireTenant,
  requirePlanFeature('assessments'),
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
    const orgId = tenant.orgId;
    const items: WorkingListItem[] = [];

    // ── Source: pending voluntary training requests (U22) ────────────────────
    const requests = await db.query.trainingRequests.findMany({
      where: and(eq(schema.trainingRequests.orgId, orgId), eq(schema.trainingRequests.state, 'pending')),
    });
    if (requests.length > 0) {
      const toolIds = [...new Set(requests.map((r) => r.toolId))];
      const tools = await db.query.assessmentTools.findMany({
        where: inArray(schema.assessmentTools.id, toolIds),
      });
      const toolName = new Map(tools.map((t) => [t.id, t.name]));
      for (const r of requests) {
        items.push({
          kind: 'training_request',
          id: r.id,
          subject: `Training request: ${toolName.get(r.toolId) ?? 'an assessment'}`,
          createdAt: r.createdAt.toISOString(),
        });
      }
    }

    // ── Source: retirement reviews — retired values still held (U18) ──────────
    for (const item of await retirementReviewItems(orgId)) items.push(item);

    // ── Source: overdue pooled cases (U13) ───────────────────────────────────
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, orgId),
    });
    const overdueDays = org?.pooledCaseOverdueDays ?? 14;
    const pooled = await db.query.assessmentCases.findMany({
      where: and(
        eq(schema.assessmentCases.orgId, orgId),
        eq(schema.assessmentCases.state, 'open'),
        isNull(schema.assessmentCases.assessorUserId),
      ),
    });
    if (pooled.length > 0) {
      const now = Date.now();
      const toolIds = [...new Set(pooled.map((c) => c.toolId))];
      const tools = await db.query.assessmentTools.findMany({
        where: inArray(schema.assessmentTools.id, toolIds),
      });
      const toolName = new Map(tools.map((t) => [t.id, t.name]));
      for (const c of pooled) {
        const ageDays = Math.floor((now - c.createdAt.getTime()) / 86_400_000);
        // Overdue is DERIVED against the org threshold (R63) — a fresh case is
        // not on this list, only one that has waited too long.
        if (ageDays < overdueDays) continue;
        items.push({
          kind: 'overdue_case',
          id: c.id,
          subject: `Overdue case: ${toolName.get(c.toolId) ?? 'an assessment'}`,
          createdAt: c.createdAt.toISOString(),
        });
      }
    }

    // Default ordering by age — oldest first; a dateless item sorts last.
    items.sort((a, b) => {
      if (a.createdAt === b.createdAt) return 0;
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    res.json(items);
  }),
);

/** Retired Locations / Departments / Roles that ACTIVE people still hold (U18) → one item each. */
async function retirementReviewItems(orgId: string): Promise<WorkingListItem[]> {
  const database = db!;
  const [locations, departments, roles] = await Promise.all([
    database.query.locations.findMany({
      where: and(eq(schema.locations.orgId, orgId), eq(schema.locations.status, 'retired')),
    }),
    database.query.departments.findMany({
      where: and(eq(schema.departments.orgId, orgId), eq(schema.departments.status, 'retired')),
    }),
    database.query.jobRoles.findMany({
      where: and(eq(schema.jobRoles.orgId, orgId), eq(schema.jobRoles.status, 'retired')),
    }),
  ]);
  if (locations.length + departments.length + roles.length === 0) return [];

  const [locHolders, deptHolders, roleHolders] = await Promise.all([
    locations.length
      ? database.query.membershipLocations.findMany({
          where: inArray(schema.membershipLocations.locationId, locations.map((l) => l.id)),
        })
      : [],
    departments.length
      ? database.query.membershipDepartments.findMany({
          where: inArray(schema.membershipDepartments.departmentId, departments.map((d) => d.id)),
        })
      : [],
    roles.length
      ? database.query.membershipRoles.findMany({
          where: and(
            inArray(schema.membershipRoles.roleId, roles.map((r) => r.id)),
            isNull(schema.membershipRoles.withdrawnAt),
          ),
        })
      : [],
  ]);

  const membershipIds = [
    ...new Set([
      ...locHolders.map((h) => h.membershipId),
      ...deptHolders.map((h) => h.membershipId),
      ...roleHolders.map((h) => h.membershipId),
    ]),
  ];
  if (membershipIds.length === 0) return [];
  const active = await database.query.memberships.findMany({
    where: and(
      eq(schema.memberships.orgId, orgId),
      inArray(schema.memberships.id, membershipIds),
      eq(schema.memberships.status, 'active'),
    ),
  });
  const activeIds = new Set(active.map((m) => m.id));

  const heldBy = (rows: Array<{ membershipId: string }>, valueId: (r: never) => string) => {
    const held = new Set<string>();
    for (const row of rows) {
      if (activeIds.has(row.membershipId)) held.add(valueId(row as never));
    }
    return held;
  };
  const locHeld = heldBy(locHolders, (r) => (r as { locationId: string }).locationId);
  const deptHeld = heldBy(deptHolders, (r) => (r as { departmentId: string }).departmentId);
  const roleHeld = heldBy(roleHolders, (r) => (r as { roleId: string }).roleId);

  const items: WorkingListItem[] = [];
  for (const l of locations) if (locHeld.has(l.id)) items.push({ kind: 'retirement_review', id: l.id, subject: `Retired Location still held: ${l.name}`, createdAt: null });
  for (const d of departments) if (deptHeld.has(d.id)) items.push({ kind: 'retirement_review', id: d.id, subject: `Retired Department still held: ${d.name}`, createdAt: null });
  for (const r of roles) if (roleHeld.has(r.id)) items.push({ kind: 'retirement_review', id: r.id, subject: `Retired Role still held: ${r.name}`, createdAt: null });
  return items;
}
