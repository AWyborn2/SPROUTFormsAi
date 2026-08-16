import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import { bestCurrency, competencyCurrency, countsAsHeld } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { competencySourcesByUser, sourceRefs, type CompetencySourceRef } from '../lib/standing.js';
import { awardingToolByCompetency } from '../lib/requirement-links.js';
import { db } from '../db.js';

/**
 * Compliance reporting (U20) — how the workforce stands, as the surface shown an
 * auditor: a REQUIRED competency expired, a required competency a holder has
 * NEVER held, a required competency EXPIRING inside the assessor planning
 * window or already IN GRACE (both still count, both need a booking — the
 * number that lets an Admin act before anything stops counting), and a member
 * no notification can reach.
 *
 * Only REQUIRED competencies count (R101): an optional lapse is not a compliance
 * failure (R102), so standing is read here, not currency alone. The two gaps are
 * reported SEPARATELY (R103) because they have different remedies — a refresher
 * vs a training booking. The never-held figure reads the same requirement
 * resolver the assignment engine reads, so a gap and an assignment describe one
 * situation from two sides and cannot disagree. Nothing else reaches this
 * surface: an overdue pooled case is a backlog and belongs on the working list.
 */
export const complianceRouter: Router = Router();

function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

export interface ComplianceGap {
  userId: string;
  name: string;
  competencyId: string;
  competencyName: string;
  /**
   * Whether a BOOKABLE assessment awards this competency, from the KTD2
   * resolver — the same resolution assignment plans cases with, so this flag
   * and "an assignment exists for it" describe one situation from two sides
   * (U8, R7, R9). False is the evidence-only case: a licence-type competency
   * nothing awards (or whose only awarding tool has no published version) is
   * cleared by RECORDING EVIDENCE — an imported or manual grant (R11) — never
   * by booking an assessment that does not exist.
   */
  hasAwardingAssessment: boolean;
  /**
   * WHICH scopes require it of this person, by name (R5, U8) — org, location,
   * department, role; every contributor on a cross-scope duplicate (AE4), the
   * legacy role derivation included. Empty on an optional lapse: nothing
   * requires those, which is exactly what the section says. No viewer gate
   * here — this whole route is admin/owner-only (the isAdmin check below).
   */
  sources: CompetencySourceRef[];
  /**
   * The KTD4 visibility outcome: this member has NO location placement, so
   * the assignment engine can plan no case for them anywhere — the gap is
   * real but permanently unbookable until somebody places them.
   *
   * READ THE WAY THE ENGINE READS IT (review-corrected): raw
   * `membership_locations`, ANY status. The scope EXPANSION drops retired
   * locations because a retired site confers no requirements (the U4 split) —
   * but `decideAssignments` never sees that filter: it takes the membership's
   * placement rows as they stand, so a member placed only at a closed site
   * still gets a case booked there. Deriving the marker from the expansion
   * therefore told an admin "cannot be scheduled — no location placement"
   * about somebody whose case already exists, which is the one claim this
   * flag must never make. Retirement changes WHAT is required, not WHERE a
   * booking can land.
   */
  noLocationPlacement: boolean;
}

/** A member no notification can reach: a flagged address AND no login (R98, R99). */
export interface UnreachableMember {
  userId: string;
  name: string;
  /** What an Admin acts on — the profile carrying the mark. */
  membershipId: string;
}

complianceRouter.get(
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
    const now = new Date();

    const memberships = await db.query.memberships.findMany({
      where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active')),
    });
    if (memberships.length === 0) {
      // An organisation with no active members has nobody to report on, and
      // nobody unreachable. Returns the FULL shape (all five keys) so this path
      // never differs from the normal one — the web type has no optional keys
      // and reads `optionalLapses.length` unconditionally.
      res.json({ expired: [], expiring: [], neverHeld: [], optionalLapses: [], unreachable: [] });
      return;
    }
    const userIds = [...new Set(memberships.map((m) => m.userId))];

    /*
      ONE ORG-WIDE EXPANSION SERVES THE OBLIGATION HALF OF THE REPORT
      (review-verified). The batched provenance read answers two questions at
      once, on one repeatable-read snapshot instead of the two split reads:
        — WHY each obligation stands (R5, U8): the sources maps themselves,
          one read for the whole workforce, never a per-member loop.
        — The obligation per person (R103, required only, R101): the required
          map's KEYS are exactly the resolver's set — same expansion, same
          dual read, the legacy role derivation included — so the assignment
          engine and this report still cannot disagree.
      WHO CAN BE SCHEDULED is deliberately NOT one of them: it is a question
      about placement rows, not about scopes. See the read below.
    */
    const sourcesByUser = await competencySourcesByUser(db, orgId, userIds);
    const requiredByUser = new Map<string, Set<string>>();
    for (const userId of userIds) {
      requiredByUser.set(userId, new Set(sourcesByUser.get(userId)?.required.keys() ?? []));
    }

    /*
      WHO CAN BE SCHEDULED (U8, KTD4) — read the way the ENGINE reads it: raw
      `membership_locations` over this report's memberships, ANY location
      status. A member with no placement keeps their gaps (the requirement is
      real) but the engine can plan no case with nowhere to assess, so their
      rows carry an explicit marker instead of silently never resolving.

      NOT from the scope expansion (review-corrected). The expansion drops
      RETIRED locations, because a retired site stops conferring requirements
      (the U4 split) — but `decideAssignments` reads the membership's
      placement rows unfiltered, so a member placed only at a retired site
      still has a case booked there. Marking them "cannot be scheduled" while
      their case sits open is the flag asserting the opposite of the truth.
      Retirement governs WHAT is required, never WHERE it can be booked, and
      this marker is a statement about the latter.
    */
    const placements = await db.query.membershipLocations.findMany({
      where: inArray(
        schema.membershipLocations.membershipId,
        memberships.map((m) => m.id),
      ),
    });
    const placedMembershipIds = new Set(placements.map((p) => p.membershipId));
    const placedUserIds = new Set<string>();
    for (const membership of memberships) {
      if (placedMembershipIds.has(membership.id)) placedUserIds.add(membership.userId);
    }
    const users = await db.query.users.findMany({ where: inArray(schema.users.id, userIds) });
    const nameByUser = new Map(users.map((u) => [u.id, u.name]));

    const holders = await db.query.competencyHolders.findMany({
      where: and(eq(schema.competencyHolders.orgId, orgId), inArray(schema.competencyHolders.userId, userIds)),
    });
    const grantsByKey = new Map<string, (typeof holders)[number][]>();
    for (const h of holders) {
      const key = `${h.userId}|${h.competencyId}`;
      const list = grantsByKey.get(key) ?? [];
      list.push(h);
      grantsByKey.set(key, list);
    }

    // Every competency we must name — those required, plus those merely held (an
    // optional lapse needs the held competency's validity and name too).
    const relevantIds = new Set<string>();
    for (const set of requiredByUser.values()) for (const id of set) relevantIds.add(id);
    for (const h of holders) relevantIds.add(h.competencyId);
    const competencies = relevantIds.size
      ? await db.query.competencies.findMany({
          where: and(eq(schema.competencies.orgId, orgId), inArray(schema.competencies.id, [...relevantIds])),
        })
      : [];
    const competencyById = new Map(competencies.map((c) => [c.id, c]));

    /*
      Bookability per competency, resolved ONCE for every competency the report
      can name (U8, KTD2). Never read off raw awards: a tool whose template has
      no published version cannot carry a case, and the resolver is the one
      place that filter lives — so this flag cannot disagree with what the
      assignment engine would actually book.
    */
    const awarding = await awardingToolByCompetency(db, orgId, [...relevantIds]);

    const gapOf = (userId: string, competencyId: string, competencyName: string): ComplianceGap => ({
      userId,
      name: nameByUser.get(userId) ?? 'Unknown user',
      competencyId,
      competencyName,
      hasAwardingAssessment: awarding.has(competencyId),
      // REQUIRED provenance only: gaps are required by definition, and an
      // optional lapse's empty list is the true answer (nothing requires it).
      sources: sourceRefs(sourcesByUser.get(userId)?.required.get(competencyId)),
      noLocationPlacement: !placedUserIds.has(userId),
    });

    const expired: ComplianceGap[] = [];
    const expiring: ComplianceGap[] = [];
    const neverHeld: ComplianceGap[] = [];
    const optionalLapses: ComplianceGap[] = [];
    for (const membership of memberships) {
      const required = requiredByUser.get(membership.userId) ?? new Set<string>();

      // REQUIRED gaps — a required competency not currently held (R101).
      for (const competencyId of required) {
        const competency = competencyById.get(competencyId);
        if (!competency) {
          // The org no longer defines this required competency, so nobody can
          // hold it current — the assignment engine treats that as unmet and
          // would assign, so the report must show it as never held too (R103).
          neverHeld.push(gapOf(membership.userId, competencyId, 'Unknown competency'));
          continue;
        }
        const currencies = (grantsByKey.get(`${membership.userId}|${competencyId}`) ?? []).map((g) =>
          competencyCurrency(g, competency, now, 'assessor'),
        );
        /*
          EXPIRING-OR-GRACE is captured before the compliant-continue swallows
          it: `countsAsHeld` deliberately treats both as current, so without
          this branch the person books nowhere until they tip into `expired` —
          and somebody in grace is PAST their date, the last person this
          surface may hide. Read off the BEST grant, not any grant: a renewal
          leaves the superseded row in place, and flagging a renewed person on
          the old row's date would book someone who already acted.
        */
        const best = bestCurrency(currencies);
        if (best && (best.status === 'expiring' || best.status === 'grace')) {
          expiring.push(gapOf(membership.userId, competencyId, competency.name));
        }
        if (currencies.some((c) => countsAsHeld(c))) continue; // compliant
        const gap = gapOf(membership.userId, competencyId, competency.name);
        // Lapsed on its date (not revoked) → a refresher; otherwise (no grant, or
        // only a revoked one that counts as not held, R107) → a fresh assessment.
        if (currencies.some((c) => !c.revoked && c.status === 'expired')) expired.push(gap);
        else neverHeld.push(gap);
      }

      // OPTIONAL lapses — a competency the person HOLDS that expired but no Role
      // requires (R102): reported, but not a compliance failure.
      const seenOptional = new Set<string>();
      for (const h of holders) {
        if (h.userId !== membership.userId) continue;
        if (required.has(h.competencyId) || seenOptional.has(h.competencyId)) continue;
        const competency = competencyById.get(h.competencyId);
        if (!competency) continue;
        const currencies = (grantsByKey.get(`${membership.userId}|${h.competencyId}`) ?? []).map((g) =>
          competencyCurrency(g, competency, now, 'assessor'),
        );
        // Only a genuine lapse (past its date, not revoked, not still current).
        if (currencies.some((c) => countsAsHeld(c))) continue;
        if (currencies.some((c) => !c.revoked && c.status === 'expired')) {
          optionalLapses.push(gapOf(membership.userId, h.competencyId, competency.name));
          seenOptional.add(h.competencyId);
        }
      }
    }

    /*
      UNREACHABLE (R98, R99) — a member no notification can reach.

      Reachable means EITHER delivery route works, so unreachable is the
      conjunction: an address an Admin flagged as bouncing AND no login. The
      sweep serves its notice on the person's own record regardless of what the
      email did, so somebody who signs in has been notified whatever their
      address does, and counting them here would report a failure that did not
      occur.

      Narrower than the working list's reading of the same mark on purpose. The
      working list asks "does somebody need chasing", and a marked member with a
      login still does. This asks "did the organisation discharge its
      obligation", and for them it did.
    */
    const unreachable: UnreachableMember[] = [];
    const profiles = await db.query.memberProfiles.findMany({
      where: inArray(
        schema.memberProfiles.membershipId,
        memberships.map((m) => m.id),
      ),
    });
    const markedMembership = new Set(
      profiles.filter((p) => Boolean(p.emailUnreachableAt)).map((p) => p.membershipId),
    );
    if (markedMembership.size > 0) {
      // A password hash is what makes a login real: an invited person who never
      // completed their signup has an account row but cannot sign in.
      const hasLogin = new Set(users.filter((u) => Boolean(u.passwordHash)).map((u) => u.id));
      for (const membership of memberships) {
        if (!markedMembership.has(membership.id)) continue;
        if (hasLogin.has(membership.userId)) continue;
        unreachable.push({
          userId: membership.userId,
          name: nameByUser.get(membership.userId) ?? 'A member',
          membershipId: membership.id,
        });
      }
    }

    res.json({ expired, expiring, neverHeld, optionalLapses, unreachable });
  }),
);
