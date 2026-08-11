import { Router } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { owedProfileFiles } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { orphanedApiKeys } from '../lib/orphaned-keys.js';
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

export type WorkingListKind =
  | 'training_request'
  | 'retirement_review'
  | 'overdue_case'
  /** A profile picture or a competency certificate that has not arrived (R18). */
  | 'owed_file'
  /** An address an Admin flagged as reaching nobody (R16, R20). */
  | 'unreachable'
  /** A live API key whose issuing Admin has been deactivated (R65). */
  | 'api_key_review';

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

    // ── Source: files still owed (U34, R18) ──────────────────────────────────
    for (const item of await owedFileItems(orgId)) items.push(item);

    // ── Source: an address that reaches nobody (U36, R16, R20) ───────────────
    for (const item of await unreachableItems(orgId)) items.push(item);

    // ── Source: a live key whose issuer was deactivated (R65) ────────────────
    for (const item of await apiKeyReviewItems(orgId)) items.push(item);

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

/**
 * Files a record still owes (U34, R18) — a missing profile picture, and a
 * competency carrying no document.
 *
 * DERIVED, never stored. A profile with no picture key owes one; a competency
 * with no held document owes one. Deriving it means nothing has to be
 * reconciled when a file arrives — the item leaves because the underlying fact
 * changed, which is the posture this whole list takes.
 *
 * THE IMPORT WAIVER IS READ, NOT INFERRED (R19). A competency a migration run
 * loaded owes no certificate — a customer bringing in a decade of tickets has no
 * scans of them — while one recorded on the same person afterwards owes its own,
 * so the concession never becomes the standard. `importedAt` on the grant is what
 * tells those apart. Inferring it from a null granting user would also catch
 * grants the product itself made, which owe their documents like any other.
 *
 * GATES NOTHING. An owed file marks and lists; no case, no assessment and no
 * competency waits on it.
 */
/**
 * The active members of an organisation with the two lookups both the owed-file
 * and the unreachable listings derive per person: the display name by user, and
 * the membership→user map. Read once here rather than re-derived in each source.
 */
async function loadActiveMembers(orgId: string) {
  const database = db!;
  const memberships = await database.query.memberships.findMany({
    where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active')),
  });
  const users = memberships.length
    ? await database.query.users.findMany({
        where: inArray(schema.users.id, [...new Set(memberships.map((m) => m.userId))]),
      })
    : [];
  return {
    memberships,
    nameFor: new Map(users.map((u) => [u.id, u.name])),
    userForMembership: new Map(memberships.map((m) => [m.id, m.userId])),
  };
}

async function owedFileItems(orgId: string): Promise<WorkingListItem[]> {
  const database = db!;
  const items: WorkingListItem[] = [];

  const { memberships, nameFor, userForMembership } = await loadActiveMembers(orgId);
  if (memberships.length === 0) return items;

  // A profile with no picture key owes one.
  const profiles = await database.query.memberProfiles.findMany({
    where: inArray(
      schema.memberProfiles.membershipId,
      memberships.map((m) => m.id),
    ),
  });
  for (const profile of profiles) {
    if (owedProfileFiles(profile).length === 0) continue;
    const who = nameFor.get(userForMembership.get(profile.membershipId) ?? '') ?? 'A member';
    items.push({
      kind: 'owed_file',
      id: profile.membershipId,
      subject: `Profile picture owed: ${who}`,
      createdAt: profile.createdAt.toISOString(),
    });
  }

  // A competency with no HELD document owes one, unless an import loaded it.
  const grants = await database.query.competencyHolders.findMany({
    where: and(eq(schema.competencyHolders.orgId, orgId), isNull(schema.competencyHolders.revokedAt)),
  });
  const ownGrants = grants.filter((g) => g.importedAt === null);
  if (ownGrants.length === 0) return items;

  const documents = await database.query.competencyDocuments.findMany({
    where: and(
      eq(schema.competencyDocuments.orgId, orgId),
      inArray(
        schema.competencyDocuments.competencyHolderId,
        ownGrants.map((g) => g.id),
      ),
    ),
  });
  const heldFor = new Set(documents.filter((d) => d.state === 'held').map((d) => d.competencyHolderId));

  const competencies = await database.query.competencies.findMany({
    where: eq(schema.competencies.orgId, orgId),
  });
  const competencyName = new Map(competencies.map((c) => [c.id, c.name]));
  const activeUsers = new Set(memberships.map((m) => m.userId));

  for (const grant of ownGrants) {
    if (heldFor.has(grant.id)) continue;
    // A grant belonging to somebody who is no longer an active member is not an
    // Admin's to chase.
    if (!activeUsers.has(grant.userId)) continue;
    items.push({
      kind: 'owed_file',
      id: grant.id,
      subject: `Certificate owed: ${nameFor.get(grant.userId) ?? 'A member'} — ${competencyName.get(grant.competencyId) ?? 'a competency'}`,
      // `ownGrants` (above) is filtered to non-imported rows, and every path
      // that creates one stamps a real grant date — this is never actually
      // null today. The fallback is defensive: the column is nullable now
      // (R153, reversed), and a missing date here should read as "when this
      // was first seen" rather than crash the list.
      createdAt: (grant.grantedAt ?? grant.createdAt).toISOString(),
    });
  }

  return items;
}

/**
 * Members whose address an Admin has flagged as reaching nobody (U36, R16, R20).
 *
 * THE MARK ALONE, deliberately — this is the broader of the two populations the
 * mark feeds, and the difference from compliance reporting is the point rather
 * than an inconsistency. An Admin flagged the address because mail bounces, so
 * an expiry notice that would have been emailed now needs a person to chase it.
 * That is true whether or not the member also holds a login: the notice still
 * lands on their own record, but nobody can rely on their opening it.
 *
 * Compliance reporting counts the narrower population (the mark AND no login),
 * because there "unreachable" is a claim about whether the organisation
 * discharged its obligation, and a login discharges it. Here it is a claim about
 * whether somebody needs chasing.
 */
async function unreachableItems(orgId: string): Promise<WorkingListItem[]> {
  const database = db!;
  const { memberships, nameFor, userForMembership } = await loadActiveMembers(orgId);
  if (memberships.length === 0) return [];

  const profiles = await database.query.memberProfiles.findMany({
    where: inArray(
      schema.memberProfiles.membershipId,
      memberships.map((m) => m.id),
    ),
  });
  const marked = profiles.filter((p) => Boolean(p.emailUnreachableAt));
  if (marked.length === 0) return [];

  return marked.map((profile) => ({
    kind: 'unreachable' as const,
    id: profile.membershipId,
    subject: `Address unreachable: ${nameFor.get(userForMembership.get(profile.membershipId) ?? '') ?? 'A member'}`,
    // When the flag was raised, not when the profile was created — the age that
    // matters here is how long somebody has gone unchased.
    createdAt: profile.emailUnreachableAt!.toISOString(),
  }));
}

/**
 * Live API keys whose issuing Admin has been deactivated (R65).
 *
 * A key is the ORGANISATION's credential — its own role, revocable by any Admin
 * — so it keeps working when the person who issued it leaves, and cutting it
 * automatically would turn an HR event into an unannounced outage. What the
 * product owes instead is TELLING somebody: a leaver holds a copy of the
 * plaintext, and rotating it is an Admin decision nobody can make unprompted.
 *
 * Clears by being acted upon, like every other source here — the item leaves
 * when the key is revoked or the member is reactivated, not when anyone ticks
 * it off.
 */
async function apiKeyReviewItems(orgId: string): Promise<WorkingListItem[]> {
  const keys = await orphanedApiKeys(db!, orgId);
  return keys.map((k) => ({
    kind: 'api_key_review' as const,
    id: k.id,
    subject: `API key still live: ${k.name} — issued by ${k.issuerName}, since deactivated`,
    // The age that matters is how long it has stood unreviewed, which starts
    // when it was issued; the deactivation has no timestamp on the key itself.
    createdAt: k.createdAt.toISOString(),
  }));
}

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

  // Generic over the row type, so each call site's real shape flows to its
  // valueId callback and no casts are needed.
  const heldBy = <T extends { membershipId: string }>(rows: T[], valueId: (r: T) => string) => {
    const held = new Set<string>();
    for (const row of rows) {
      if (activeIds.has(row.membershipId)) held.add(valueId(row));
    }
    return held;
  };
  const locHeld = heldBy(locHolders, (r) => r.locationId);
  const deptHeld = heldBy(deptHolders, (r) => r.departmentId);
  const roleHeld = heldBy(roleHolders, (r) => r.roleId);

  const items: WorkingListItem[] = [];
  for (const l of locations) if (locHeld.has(l.id)) items.push({ kind: 'retirement_review', id: l.id, subject: `Retired Location still held: ${l.name}`, createdAt: null });
  for (const d of departments) if (deptHeld.has(d.id)) items.push({ kind: 'retirement_review', id: d.id, subject: `Retired Department still held: ${d.name}`, createdAt: null });
  for (const r of roles) if (roleHeld.has(r.id)) items.push({ kind: 'retirement_review', id: r.id, subject: `Retired Role still held: ${r.name}`, createdAt: null });
  return items;
}
