import { Router } from 'express';
import { and, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { requiredCompetencyIdsByUser } from '../lib/standing.js';
import { awardingToolByCompetencyForOrg, runSnapshotted } from '../lib/requirement-links.js';
import {
  cellCountsAsHeld,
  complianceCountsOf,
  requiredStandingByMember,
  usersByScopeId,
  type MatrixCompetency,
  type MatrixGrant,
  type MemberRequiredStanding,
} from '../lib/training-matrix.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;

/**
 * Training summary aggregates (U4) — the reporting dashboard's one read:
 * compliance KPIs, expiring buckets, gap counts, per-group compliance,
 * sign-off throughput and the snapshot trend, in a single response.
 *
 * EVERY NUMBER DERIVES FROM THE SHARED HELPERS (R17): the member-set standing
 * comes from `requiredStandingByMember` — `matrixCell` under the hood, the
 * same rules the matrix grid renders — and the fold is `complianceCountsOf`,
 * the same implementation the sweep's snapshot writer uses. So a KPI here, a
 * cell on the matrix and a `compliance_snapshots` row captured tonight are
 * three readings of one derivation, not three opinions.
 *
 * SCOPE (`?location=` / `?department=`, R12): mutually exclusive — both is a
 * 400 (`invalid_scope`), because "the Brisbane rows of the maintenance crew"
 * is a filter this dashboard does not sell and silently picking one would
 * misreport the other. An UNKNOWN scope id is also a 400 (`unknown_scope`)
 * rather than an empty set, deliberately: an admin scoping to a deleted or
 * mistyped value should hear that the scope does not exist, not read a
 * confident 0-member dashboard about nothing. A RETIRED value is still a
 * valid scope — its members exist and their numbers are real; retirement
 * changes what a scope REQUIRES (the expansion drops it), never who is placed
 * there. The scoped member set is active memberships intersected with RAW
 * placement rows, matching how the engine reads placement.
 *
 * TREND IS ORG-GRAIN REGARDLESS OF SCOPE (R12, v1): snapshots are captured
 * per scope from day one, but the UI reads only org rows for now, so the
 * payload carries `trend.scope: 'org'` and the client labels it — a scoped
 * dashboard must not pass the org trend off as its own.
 *
 * ONE REPEATABLE-READ TRANSACTION for the whole expansion (the assignment.ts
 * posture, KTD1): memberships, placements, standing, holders, competencies,
 * awarding resolution, cases and snapshots all read one snapshot, so a grant
 * or transfer committing mid-request cannot show a member compliant in one
 * panel and gapped in another. The Database-typed standing loader opens its
 * own transaction internally; called on this route's handle it nests as a
 * SAVEPOINT on the same snapshot (`runSnapshotted`'s documented design)
 * rather than taking a second one.
 */
export const trainingSummaryRouter: Router = Router();

function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

const DAY_MS = 86_400_000;
/** ~6 months of daily snapshots — the R11 trend window. */
const TREND_DAYS = 185;
/** The gap delta compares against the org snapshot nearest to this many days ago… */
const GAP_DELTA_TARGET_DAYS = 30;
/** …within this tolerance either side; nothing close enough → delta is null,
 * because a delta against a month-old-ish number is honest and a delta against
 * whatever happens to exist is not. */
const GAP_DELTA_TOLERANCE_DAYS = 7;
/** Eight ISO weeks of sign-off throughput: seven full weeks plus the current
 * week to date, which the payload labels so the chart can say so. */
const SIGN_OFF_WEEKS = 8;
/** The cumulative expiring buckets (R10): 30 ⊆ 60 ⊆ 90 by construction. */
const EXPIRING_BUCKET_DAYS = [30, 60, 90] as const;

const summaryQuery = z.object({
  location: z.string().uuid().optional(),
  department: z.string().uuid().optional(),
  axis: z.enum(['location', 'department', 'role']).optional(),
});

export type SummaryAxis = 'location' | 'department' | 'role';

export interface SummaryGroup {
  id: string;
  name: string;
  memberCount: number;
  compliantCount: number;
}

export interface TrainingSummaryPayload {
  scope: { type: 'org' } | { type: 'location' | 'department'; id: string; name: string };
  /** Percentage is CLIENT-derived; zero members is 0/0, so the client renders
   * 0% and no NaN can be minted here. */
  compliance: { compliantCount: number; memberCount: number };
  /** CUMULATIVE grants lapsing within 30/60/90 days on required, currently
   * counting cells. A grace-period grant is already past its date (days ≤ 0),
   * so it lands in every bucket — the most urgent entry, never hidden. */
  expiring: { in30: number; in60: number; in90: number };
  gaps: {
    total: number;
    /** Gaps whose competency no bookable assessment awards (R7) — cleared by
     * recording evidence, never by booking. */
    evidenceOnly: number;
    /** Top 6 by open-gap count, descending; ties stable by name. */
    byCompetency: Array<{ competencyId: string; name: string; count: number }>;
  };
  complianceByGroup: {
    axis: SummaryAxis;
    /** Every group value on the axis, zero-member ones included — the client
     * decides what to chart. A member placed in several groups counts in each. */
    groups: SummaryGroup[];
  };
  signOffs: {
    /** Oldest first; the last entry is the current ISO week TO DATE and says so. */
    weeks: Array<{ weekStart: string; count: number; currentWeek?: true }>;
    currentWeek: number;
    priorFullWeek: number;
  };
  trend: {
    /** Always 'org' in v1 (R12) — the client labels the trend org-wide when a
     * narrower scope is selected. */
    scope: 'org';
    points: Array<{
      capturedOn: string;
      compliantCount: number;
      memberCount: number;
      requiredGapCount: number;
    }>;
    /** Current ORG open-gap count minus the org snapshot ~30 days ago; null
     * when no snapshot sits close enough to compare against. */
    gapDelta: number | null;
  };
}

/** UTC Monday of the ISO week containing `at` — sign-off bucketing's one clock. */
function isoWeekStartUtc(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

trainingSummaryRouter.get(
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
    const parsed = summaryQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const { location: locationScopeId, department: departmentScopeId } = parsed.data;
    if (locationScopeId && departmentScopeId) {
      // Mutually exclusive by design (see the module docblock) — refusing
      // beats silently privileging one axis over the other.
      res.status(400).json({ error: 'invalid_scope' });
      return;
    }
    const axis: SummaryAxis = parsed.data.axis ?? 'department';
    const orgId = tenant.orgId;
    const now = new Date();

    const result = await runSnapshotted(db, async (tx) => {
      const memberships = await tx.query.memberships.findMany({
        where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active')),
      });
      const membershipIds = memberships.map((m) => m.id);
      const userIds = [...new Set(memberships.map((m) => m.userId))];
      const userOfMembership = new Map(memberships.map((m) => [m.id, m.userId]));

      /*
        RAW placement rows, any value status — the engine-shaped read (the
        compliance.ts review-corrected rule): scoping and grouping are
        questions about WHERE people are placed, and retirement governs what a
        scope requires, not who stands in it.
      */
      // Independent reads issued together — the driver pipelines them on the
      // transaction's connection; this is a whole-workforce read where serial
      // round trips add up. Role placements only feed the role AXIS — held
      // (non-withdrawn) roles, the same filter the scope expansion applies
      // (R52). Taxonomy values load with ANY status: scope validation must
      // recognise a retired value (its members' numbers are real — module
      // docblock); the group axis below filters to active itself.
      const [locationPlacements, departmentPlacements, rolePlacements, locations, departments, jobRoles] =
        await Promise.all([
          membershipIds.length
            ? tx.query.membershipLocations.findMany({
                where: inArray(schema.membershipLocations.membershipId, membershipIds),
              })
            : [],
          membershipIds.length
            ? tx.query.membershipDepartments.findMany({
                where: inArray(schema.membershipDepartments.membershipId, membershipIds),
              })
            : [],
          axis === 'role' && membershipIds.length
            ? tx.query.membershipRoles.findMany({
                where: and(
                  inArray(schema.membershipRoles.membershipId, membershipIds),
                  isNull(schema.membershipRoles.withdrawnAt),
                ),
              })
            : [],
          tx.query.locations.findMany({ where: eq(schema.locations.orgId, orgId) }),
          tx.query.departments.findMany({ where: eq(schema.departments.orgId, orgId) }),
          axis === 'role'
            ? tx.query.jobRoles.findMany({ where: eq(schema.jobRoles.orgId, orgId) })
            : [],
        ]);

      // Resolve the scope BEFORE the heavy reads: an unknown id answers 400
      // without walking the workforce.
      let scope: TrainingSummaryPayload['scope'] = { type: 'org' };
      let scopedUserIds = new Set(userIds);
      if (locationScopeId) {
        const row = locations.find((l) => l.id === locationScopeId);
        if (!row) return { unknownScope: true as const };
        scope = { type: 'location', id: row.id, name: row.name };
        scopedUserIds = new Set(
          locationPlacements
            .filter((p) => p.locationId === locationScopeId)
            .map((p) => userOfMembership.get(p.membershipId))
            .filter((id): id is string => Boolean(id)),
        );
      } else if (departmentScopeId) {
        const row = departments.find((d) => d.id === departmentScopeId);
        if (!row) return { unknownScope: true as const };
        scope = { type: 'department', id: row.id, name: row.name };
        scopedUserIds = new Set(
          departmentPlacements
            .filter((p) => p.departmentId === departmentScopeId)
            .map((p) => userOfMembership.get(p.membershipId))
            .filter((id): id is string => Boolean(id)),
        );
      }

      /*
        THE ONE EXPANSION, org-wide even when scoped: the trend's gap delta
        compares ORG numbers, and a scoped member set is a subset of the org
        set anyway — so the standing derivation runs once and every consumer
        (scoped KPIs, org delta, per-group bars) slices it. The standing
        loader's own transaction nests as a savepoint on this route's snapshot
        — the cast is the same one `runSnapshotted` performs internally, needed
        because a transaction handle carries `.transaction` but not `$client`.
      */
      const requiredByUser = await requiredCompetencyIdsByUser(tx as Database, orgId, userIds);
      const holders = userIds.length
        ? await tx.query.competencyHolders.findMany({
            where: and(
              eq(schema.competencyHolders.orgId, orgId),
              inArray(schema.competencyHolders.userId, userIds),
            ),
          })
        : [];
      const grantsByUser = new Map<string, MatrixGrant[]>();
      for (const h of holders) {
        const list = grantsByUser.get(h.userId) ?? [];
        list.push(h);
        grantsByUser.set(h.userId, list);
      }

      // Every competency the numbers can name — required or held, like
      // compliance.ts; a required id the org no longer defines still gaps
      // (the shared helper's synthetic-column rule).
      const relevantIds = new Set<string>();
      for (const set of requiredByUser.values()) for (const id of set) relevantIds.add(id);
      for (const h of holders) relevantIds.add(h.competencyId);
      const competencies = relevantIds.size
        ? await tx.query.competencies.findMany({
            where: and(
              eq(schema.competencies.orgId, orgId),
              inArray(schema.competencies.id, [...relevantIds]),
            ),
          })
        : [];
      const competencyById = new Map<string, MatrixCompetency>(
        competencies.map((c) => [c.id, c]),
      );

      // One org-wide awarding resolution per request (KTD4) — absence from the
      // map is what makes a gap evidence-only (R7).
      const awarding = await awardingToolByCompetencyForOrg(tx, orgId);

      const standings = requiredStandingByMember({
        userIds,
        requiredByUser,
        competencyById,
        grantsByUser,
        awardingToolByCompetency: awarding,
        now,
      });
      const standingsOf = (users: ReadonlySet<string>): MemberRequiredStanding[] => {
        const out: MemberRequiredStanding[] = [];
        for (const userId of users) {
          const standing = standings.get(userId);
          if (standing) out.push(standing);
        }
        return out;
      };
      const scopedStandings = standingsOf(scopedUserIds);

      // ── compliance KPI ─────────────────────────────────────────────────
      const scopedCounts = complianceCountsOf(scopedStandings);

      // ── expiring buckets (cumulative — see the payload docblock) ───────
      const expiring = { in30: 0, in60: 0, in90: 0 };
      for (const standing of scopedStandings) {
        for (const cell of standing.cells.values()) {
          if (!cellCountsAsHeld(cell) || !cell.expiresAt) continue;
          const daysTo = (cell.expiresAt.getTime() - now.getTime()) / DAY_MS;
          if (daysTo <= EXPIRING_BUCKET_DAYS[0]) expiring.in30 += 1;
          if (daysTo <= EXPIRING_BUCKET_DAYS[1]) expiring.in60 += 1;
          if (daysTo <= EXPIRING_BUCKET_DAYS[2]) expiring.in90 += 1;
        }
      }

      // ── gaps: total, evidence-only, top competencies ───────────────────
      const gapCountByCompetency = new Map<string, number>();
      for (const standing of scopedStandings) {
        for (const competencyId of standing.gapCompetencyIds) {
          gapCountByCompetency.set(competencyId, (gapCountByCompetency.get(competencyId) ?? 0) + 1);
        }
      }
      let evidenceOnly = 0;
      for (const [competencyId, count] of gapCountByCompetency) {
        if (!awarding.has(competencyId)) evidenceOnly += count;
      }
      const nameOf = (competencyId: string): string =>
        competencyById.get(competencyId)?.name ?? 'Unknown competency';
      const byCompetency = [...gapCountByCompetency.entries()]
        .map(([competencyId, count]) => ({ competencyId, name: nameOf(competencyId), count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 6);

      // ── compliance by group, over the SCOPED member set ────────────────
      const groupCounts = (users: ReadonlySet<string>): Pick<SummaryGroup, 'memberCount' | 'compliantCount'> => {
        const counts = complianceCountsOf(standingsOf(users));
        return { memberCount: counts.memberCount, compliantCount: counts.compliantCount };
      };
      const inScope = (userId: string): boolean => scopedUserIds.has(userId);
      const noUsers: ReadonlySet<string> = new Set<string>();
      let groups: SummaryGroup[];
      if (axis === 'location') {
        // Active values only: a retired site confers nothing and charting it
        // would resurrect it; its members still count in the org KPIs above.
        const byLocation = usersByScopeId(locationPlacements, (p) => p.locationId, userOfMembership, inScope);
        groups = locations
          .filter((l) => l.status === 'active')
          .map((l) => ({
            id: l.id,
            name: l.name,
            ...groupCounts(byLocation.get(l.id) ?? noUsers),
          }));
      } else if (axis === 'role') {
        // ALL roles, any status: a retired-but-held role still contributes
        // requirements (the U4 split), so its holders' bar stays honest.
        const byRole = usersByScopeId(rolePlacements, (p) => p.roleId, userOfMembership, inScope);
        groups = jobRoles.map((r) => ({
          id: r.id,
          name: r.name,
          ...groupCounts(byRole.get(r.id) ?? noUsers),
        }));
      } else {
        const byDepartment = usersByScopeId(departmentPlacements, (p) => p.departmentId, userOfMembership, inScope);
        groups = departments
          .filter((d) => d.status === 'active')
          .map((d) => ({
            id: d.id,
            name: d.name,
            ...groupCounts(byDepartment.get(d.id) ?? noUsers),
          }));
      }

      // ── sign-off throughput (8 ISO weeks, invalidated cases excluded) ──
      const currentWeekStart = isoWeekStartUtc(now);
      const oldestWeekStart = new Date(
        currentWeekStart.getTime() - (SIGN_OFF_WEEKS - 1) * 7 * DAY_MS,
      );
      const signedCases = await tx.query.assessmentCases.findMany({
        where: and(
          eq(schema.assessmentCases.orgId, orgId),
          isNotNull(schema.assessmentCases.signedOffAt),
        ),
      });
      const weekCounts = new Array<number>(SIGN_OFF_WEEKS).fill(0);
      for (const c of signedCases) {
        if (!c.signedOffAt) continue;
        // An invalidated case's sign-off no longer stands — a deactivated
        // candidate's abandoned assessment is not throughput.
        if (c.state === 'invalidated') continue;
        // Scoped via the candidate's membership: only sign-offs belonging to
        // the scoped member set count, matching every other panel.
        if (!scopedUserIds.has(c.candidateUserId)) continue;
        const bucket = Math.round(
          (isoWeekStartUtc(c.signedOffAt).getTime() - oldestWeekStart.getTime()) / (7 * DAY_MS),
        );
        if (bucket >= 0 && bucket < SIGN_OFF_WEEKS) weekCounts[bucket] = weekCounts[bucket]! + 1;
      }
      const weeks = weekCounts.map((count, i) => {
        const weekStart = new Date(oldestWeekStart.getTime() + i * 7 * DAY_MS)
          .toISOString()
          .slice(0, 10);
        return i === SIGN_OFF_WEEKS - 1
          ? { weekStart, count, currentWeek: true as const }
          : { weekStart, count };
      });

      // ── trend + gap delta, ORG grain regardless of scope (R12) ─────────
      // Bounded at the query: the sweep writes one org row per day forever,
      // so an unbounded read grows with org age while the trend only ever
      // needs the last TREND_DAYS. The (orgId, capturedOn) partial unique
      // index serves the range directly.
      const trendCutoff = new Date(now.getTime() - TREND_DAYS * DAY_MS).toISOString().slice(0, 10);
      const snapshotRows = await tx.query.complianceSnapshots.findMany({
        where: and(
          eq(schema.complianceSnapshots.orgId, orgId),
          isNull(schema.complianceSnapshots.scopeType),
          gte(schema.complianceSnapshots.capturedOn, trendCutoff),
        ),
      });
      const points = snapshotRows
        .sort((a, b) => (a.capturedOn < b.capturedOn ? -1 : a.capturedOn > b.capturedOn ? 1 : 0))
        .map((r) => ({
          capturedOn: r.capturedOn,
          compliantCount: r.compliantCount,
          memberCount: r.memberCount,
          requiredGapCount: r.requiredGapCount,
        }));

      // The delta baseline: the org snapshot nearest ~30 days back, within the
      // tolerance; ties break to the EARLIER row so the answer is stable.
      const targetTime = now.getTime() - GAP_DELTA_TARGET_DAYS * DAY_MS;
      let baseline: (typeof snapshotRows)[number] | null = null;
      let baselineDistance = Number.POSITIVE_INFINITY;
      for (const row of snapshotRows) {
        const distance = Math.abs(new Date(`${row.capturedOn}T00:00:00Z`).getTime() - targetTime);
        if (distance > GAP_DELTA_TOLERANCE_DAYS * DAY_MS) continue;
        if (
          distance < baselineDistance ||
          (distance === baselineDistance && baseline && row.capturedOn < baseline.capturedOn)
        ) {
          baseline = row;
          baselineDistance = distance;
        }
      }
      // Org-grain current gaps, whatever the scope — the delta must compare
      // like with like, and the snapshot rows are org rows.
      const orgCounts = complianceCountsOf(standings.values());
      const gapDelta = baseline ? orgCounts.requiredGapCount - baseline.requiredGapCount : null;

      const payload: TrainingSummaryPayload = {
        scope,
        compliance: {
          compliantCount: scopedCounts.compliantCount,
          memberCount: scopedCounts.memberCount,
        },
        expiring,
        gaps: { total: scopedCounts.requiredGapCount, evidenceOnly, byCompetency },
        complianceByGroup: { axis, groups },
        signOffs: {
          weeks,
          currentWeek: weekCounts[SIGN_OFF_WEEKS - 1]!,
          priorFullWeek: weekCounts[SIGN_OFF_WEEKS - 2]!,
        },
        trend: { scope: 'org', points, gapDelta },
      };
      return { payload };
    });

    if ('unknownScope' in result) {
      res.status(400).json({ error: 'unknown_scope' });
      return;
    }
    res.json(result.payload);
  }),
);
