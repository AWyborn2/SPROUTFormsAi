import { Router } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { competencySourcesByUser } from '../lib/standing.js';
import { awardingToolByCompetencyForOrg, runSnapshotted } from '../lib/requirement-links.js';
import {
  assembleTrainingMatrix,
  type MatrixCompetency,
  type MatrixGrant,
  type MatrixMember,
  type MatrixNamedRef,
  type TrainingMatrixPayload,
} from '../lib/training-matrix.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;

/**
 * TRAINING MATRIX (U3, R1/R2, KTD2) — the loading half of the workforce ×
 * competency grid: every active member against every org competency in one
 * response. The reads happen here; what each cell SAYS is decided entirely by
 * `lib/training-matrix.ts` (U2), which takes these rows as plain data — the
 * same route/lib split `compliance.ts` has with the standing resolvers, kept
 * so the cell rules test without a database.
 *
 * ONE REPEATABLE-READ SNAPSHOT FOR EVERY READ (R18, KTD1). `compliance.ts`
 * opens no route-level transaction — its only snapshot lives inside
 * `competencySourcesByUser` — which leaves its placement, holder and
 * competency reads on the root client, each statement free to see a different
 * world. This route follows the `assignment.ts` precedent instead: the whole
 * read set runs inside one `runSnapshotted` block (repeatable read — the
 * shared helper, so the isolation level is never retyped here), and the
 * resolver's own wrapper nests as a savepoint on THIS snapshot rather than
 * taking a second one. A grant landing or a transfer committing mid-request
 * can therefore never show a member's cells half in the old world — one row's
 * standing and the next row's grants always describe the same instant, which
 * also makes `now` (resolved once, threaded to assembly) honest.
 *
 * WHY GATES AND NOT THE DASHBOARD (KTD2, R17): the payload names every
 * member's compliance state, so it is admin/owner only behind the
 * `assessments` plan feature — mirroring `compliance.ts` exactly — and none of
 * it may ever reach the ungated `/dashboard` read.
 *
 * NO PAGINATION IN V1, ACCEPTED KNOWINGLY (R18). Unlike `/compliance`, which
 * scales with issue counts, this response scales with headcount × competency
 * count. The route logs the response dimensions on every request so "proves
 * heavy at real scale" is an observable fact in production logs rather than a
 * guess — that log line is the standing deferral's tripwire.
 */
export const trainingMatrixRouter: Router = Router();

function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

trainingMatrixRouter.get(
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
    // Resolved ONCE, outside the loop and inside no helper: every cell of the
    // response is derived at this instant (assembly takes it as a parameter),
    // so two cells cannot disagree about what "today" is.
    const now = new Date();

    const payload = await runSnapshotted(db, async (reader): Promise<TrainingMatrixPayload> => {
      /*
        COLUMNS ARE THE ORG'S WHOLE COMPETENCY LIST (R2) — not the relevant-ids
        subset compliance narrows to, because the grid's point is the full
        cross-product: a competency nobody is required to hold still renders a
        column (its cells read null/optional). Loaded BEFORE the zero-member
        early return so an empty workforce still answers with its columns —
        the client renders headers either way. Name-sorted (the register
        read's own convention in competencies.ts) so column order is stable
        across requests without the client re-sorting thousands of cells.
      */
      const competencyRows = await reader.query.competencies.findMany({
        where: eq(schema.competencies.orgId, orgId),
      });
      const competencies: MatrixCompetency[] = competencyRows
        .map((c) => ({
          id: c.id,
          name: c.name,
          code: c.code,
          validForMonths: c.validForMonths,
          gracePeriodDays: c.gracePeriodDays,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const memberships = await reader.query.memberships.findMany({
        where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active')),
      });
      if (memberships.length === 0) {
        // Nobody to grid, but the FULL payload shape regardless (the
        // compliance.ts zero-member posture): the web type has no optional
        // keys, and an empty org's matrix is "columns, no rows", not a 404.
        return { competencies, members: [] };
      }
      const membershipIds = memberships.map((m) => m.id);
      const userIds = [...new Set(memberships.map((m) => m.userId))];

      const users = await reader.query.users.findMany({
        where: inArray(schema.users.id, userIds),
      });
      const nameByUser = new Map(users.map((u) => [u.id, u.name]));

      /*
        PLACEMENT ROWS, TWO READINGS FROM ONE READ SET.

        `hasPlacementRows` reads `membership_locations` RAW — any location
        status — because it feeds the "cannot be scheduled" marker, and the
        assignment engine books against raw rows: a member placed only at a
        retired site still gets a case there (the review-corrected rule on
        `ComplianceGap.noLocationPlacement` in compliance.ts). Filtering to
        active placements here would mark somebody unschedulable while their
        case sits open.

        The DISPLAY refs are the same rows resolved to names (names beside
        ids, never bare ids on anything a person reads — the role-scoped UI
        rule, PR #198). A retired location or department stays listed: the
        person is genuinely placed there, and hiding the placement would make
        the row's own requirements unexplainable. Roles differ: a WITHDRAWN
        role has stopped being held at all (R52), so it is excluded from
        display exactly as it is excluded from standing.

        Position-ordered, because placement order is meaningful (R60 reads
        the first location) and the grid should list them the way every other
        surface does.
      */
      // Independent reads issued together — the driver pipelines them on the
      // transaction's connection, and this route is a whole-workforce read
      // where serial round trips add up (the R18 tripwire below).
      const [locationRows, departmentRows, roleRows] = await Promise.all([
        reader.query.membershipLocations.findMany({
          where: inArray(schema.membershipLocations.membershipId, membershipIds),
        }),
        reader.query.membershipDepartments.findMany({
          where: inArray(schema.membershipDepartments.membershipId, membershipIds),
        }),
        reader.query.membershipRoles.findMany({
          where: and(
            inArray(schema.membershipRoles.membershipId, membershipIds),
            isNull(schema.membershipRoles.withdrawnAt),
          ),
        }),
      ]);
      const placedMembershipIds = new Set(locationRows.map((r) => r.membershipId));

      const nameById = async (
        table: 'locations' | 'departments' | 'jobRoles',
        ids: readonly string[],
      ): Promise<Map<string, string>> => {
        if (ids.length === 0) return new Map();
        const rows =
          table === 'locations'
            ? await reader.query.locations.findMany({
                where: and(eq(schema.locations.orgId, orgId), inArray(schema.locations.id, [...ids])),
              })
            : table === 'departments'
              ? await reader.query.departments.findMany({
                  where: and(
                    eq(schema.departments.orgId, orgId),
                    inArray(schema.departments.id, [...ids]),
                  ),
                })
              : await reader.query.jobRoles.findMany({
                  where: and(eq(schema.jobRoles.orgId, orgId), inArray(schema.jobRoles.id, [...ids])),
                });
        return new Map(rows.map((r) => [r.id, r.name]));
      };
      const [locationNames, departmentNames, roleNames] = await Promise.all([
        nameById('locations', [...new Set(locationRows.map((r) => r.locationId))]),
        nameById('departments', [...new Set(departmentRows.map((r) => r.departmentId))]),
        nameById('jobRoles', [...new Set(roleRows.map((r) => r.roleId))]),
      ]);

      const collectRefs = <T extends { membershipId: string; position: number }>(
        rows: readonly T[],
        idOf: (row: T) => string,
        names: ReadonlyMap<string, string>,
      ): Map<string, MatrixNamedRef[]> => {
        const byMembership = new Map<string, MatrixNamedRef[]>();
        for (const row of [...rows].sort((a, b) => a.position - b.position)) {
          const list = byMembership.get(row.membershipId) ?? [];
          list.push({ id: idOf(row), name: names.get(idOf(row)) ?? '' });
          byMembership.set(row.membershipId, list);
        }
        return byMembership;
      };
      const locationRefs = collectRefs(locationRows, (r) => r.locationId, locationNames);
      const departmentRefs = collectRefs(departmentRows, (r) => r.departmentId, departmentNames);
      const roleRefs = collectRefs(roleRows, (r) => r.roleId, roleNames);

      /*
        STANDING FROM THE ONE RESOLVER (KTD1, R17): the source maps' keys ARE
        the required/recommended sets — legacy role derivation, four-scope
        union and the retired-value split all live inside the resolver, and
        assembly consumes the maps as given, so this grid, the compliance
        report and the assignment engine cannot disagree about obligation.
        Called on THIS transaction's handle: the resolver's internal wrapper
        nests as a savepoint on the route's snapshot instead of opening a
        second one (the cast is the same surface-widening `runSnapshotted`
        itself performs).
      */
      const sourcesByUser = await competencySourcesByUser(reader as Database, orgId, userIds);

      const holders = await reader.query.competencyHolders.findMany({
        where: and(
          eq(schema.competencyHolders.orgId, orgId),
          inArray(schema.competencyHolders.userId, userIds),
        ),
      });
      const grantsByUser = new Map<string, MatrixGrant[]>();
      for (const h of holders) {
        const list = grantsByUser.get(h.userId) ?? [];
        list.push(h);
        grantsByUser.set(h.userId, list);
      }

      // Competency → its ONE awarding tool, resolved ONCE per request (KTD4)
      // — the org-wide shape, so headcount never multiplies the tools read.
      // Absence from the map is what marks a required gap evidence-only (R7).
      const awardingToolByCompetency = await awardingToolByCompetencyForOrg(reader, orgId);

      // Row order is the route's decision (assembly keeps whatever it is
      // given): by name, the same convention the columns follow above.
      const members: MatrixMember[] = memberships
        .map((m) => ({
          membershipId: m.id,
          userId: m.userId,
          name: nameByUser.get(m.userId) ?? 'Unknown user',
          role: m.role,
          locations: locationRefs.get(m.id) ?? [],
          departments: departmentRefs.get(m.id) ?? [],
          roles: roleRefs.get(m.id) ?? [],
          hasPlacementRows: placedMembershipIds.has(m.id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return assembleTrainingMatrix({
        competencies,
        members,
        standingByUser: sourcesByUser,
        grantsByUser,
        awardingToolByCompetency,
        now,
      });
    });

    // R18's tripwire: the matrix scales with headcount × competency count and
    // v1 ships unpaginated knowingly — this line is what turns "proves heavy
    // at real scale" from a guess into something production logs can show.
    console.log(
      `[training-matrix] org=${orgId} members=${payload.members.length} competencies=${payload.competencies.length} cells=${payload.members.length * payload.competencies.length}`,
    );
    res.json(payload);
  }),
);
