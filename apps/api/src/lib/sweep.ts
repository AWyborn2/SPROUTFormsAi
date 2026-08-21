/**
 * The expiry sweep (U21, KTD11, KTD12). Makes renewal happen because the product
 * noticed: three passes over an organisation, safe to run repeatedly.
 *
 * PASS 1 — ASSIGNMENT. Expired REQUIRED competencies go back through the same
 * assignment engine every other trigger uses, which creates a case only where a
 * requirement is genuinely unmet and none is already open (R45, R46, KTD16). So
 * a re-run inside the same window makes no case twice, and an optional lapse
 * assigns nothing (a Role requires it of nobody).
 *
 * PASS 2 — NOTIFICATION. A holder whose competency expires within the
 * organisation's lead window is notified once per window. Idempotence is a
 * `sent_notices` row keyed by the expiry date: a second sweep finds it and sends
 * nothing; a renewal moves the expiry, opening a fresh window. The row is written
 * regardless of the email's outcome, because it is ALSO the login delivery route
 * (R98) — a person with a login but no reachable email is still reached — and it
 * is the idempotence guard.
 *
 * PASS 3 — SNAPSHOT CAPTURE (U4, KTD5). One `compliance_snapshots` row per org
 * per UTC day, plus one per active location and department — the history the
 * Training summary's trend reads, captured here because compliance is derived
 * everywhere else and yesterday's number is unrecoverable once grants move.
 * Isolated in its own error boundary: a snapshot failure is a missing trend
 * point (the chart renders a gap), never a reason to mask the assignment and
 * notification work the same run already completed.
 *
 * One call sweeps EVERY organisation, each inside its own error boundary, so no
 * organisation has to be registered with the caller and a failing one does not
 * stop the rest — a newly onboarded organisation must not go silently unswept.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { expiryOf } from '@formai/shared';
import { assignForMembership } from './assignment.js';
import { requiredCompetencyIdsByUser } from './standing.js';
import { runSnapshotted } from './requirement-links.js';
import {
  complianceCountsOf,
  requiredStandingByMember,
  usersByScopeId,
  type MatrixCompetency,
  type MatrixGrant,
} from './training-matrix.js';
import { sendExpiryNoticeEmail } from '../email/resend.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;
const DAY_MS = 86_400_000;

export interface OrgSweepResult {
  orgId: string;
  casesCreated: number;
  noticesSent: number;
  /** Snapshot rows written by pass 3 — org row plus one per active location/department. */
  snapshotsWritten: number;
  /** Set when pass 3 threw. The other passes' numbers above still stand —
   * a lost trend point must not read as a lost sweep. */
  snapshotFailed?: boolean;
  /** Set when this organisation's pass threw and was skipped, so one failure does not stop the rest. */
  failed?: boolean;
}

/** Sweep one organisation. `now` is threaded so a run is reproducible against fixed data. */
export async function sweepOrganization(
  database: Database,
  org: typeof schema.organizations.$inferSelect,
  now: Date,
): Promise<Omit<OrgSweepResult, 'orgId'>> {
  // PASS 1 — assignment. Re-assign the requirements of every active member; the
  // engine's skip rule turns an expired required competency into a case and
  // leaves everything current alone (R46, KTD16).
  const memberships = await database.query.memberships.findMany({
    where: and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.status, 'active')),
  });
  let casesCreated = 0;
  for (const membership of memberships) {
    const result = await assignForMembership(database, org.id, membership.id, now);
    casesCreated += result.createdCaseIds.length;
  }

  // PASS 2 — notification.
  const noticesSent = await runNotificationPass(database, org, now);

  /*
    PASS 3 — snapshot capture, in its OWN error boundary (U4). The first two
    passes have already committed their work row by row; a snapshot failure
    after them is a missing trend point, and throwing here would report the
    whole sweep failed — masking cases created and notices sent that very much
    happened. The flag surfaces the miss without un-counting the rest.
  */
  let snapshotsWritten = 0;
  let snapshotFailed: true | undefined;
  try {
    snapshotsWritten = await captureComplianceSnapshots(database, org.id, now);
  } catch {
    snapshotFailed = true;
  }

  return snapshotFailed
    ? { casesCreated, noticesSent, snapshotsWritten, snapshotFailed }
    : { casesCreated, noticesSent, snapshotsWritten };
}

/** PASS 2 — the notification pass, verbatim from its inline form; extracted so
 * pass 3 runs whether or not anybody holds anything (its zero-holder early
 * return used to end the whole sweep). */
async function runNotificationPass(
  database: Database,
  org: typeof schema.organizations.$inferSelect,
  now: Date,
): Promise<number> {
  const leadDays = org.notificationLeadDays ?? 30;
  const holders = await database.query.competencyHolders.findMany({
    where: and(
      eq(schema.competencyHolders.orgId, org.id),
      isNull(schema.competencyHolders.revokedAt),
    ),
  });
  let noticesSent = 0;
  if (holders.length === 0) return noticesSent;

  const comps = await database.query.competencies.findMany({
    where: eq(schema.competencies.orgId, org.id),
  });
  const competencyById = new Map(comps.map((c) => [c.id, c]));
  const userIds = [...new Set(holders.map((h) => h.userId))];
  const users = await database.query.users.findMany({
    where: inArray(schema.users.id, userIds),
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  /*
    Addresses an Admin has flagged as reaching nobody (U36, R16, R98).

    Sending to one is not merely wasted: repeated mail to a dead address is what
    gets a sender's domain marked as a spammer, which would cost every OTHER
    member their notices. The record below is still written — it is the login
    delivery route and the idempotence guard, and neither depends on what the
    email did — so a marked member who signs in is notified exactly as before.

    Read per organisation, keyed by USER because the holder rows are, and scoped
    to this org's profiles because one customer's mail bouncing says nothing
    about another's.
  */
  const orgMemberships = await database.query.memberships.findMany({
    where: eq(schema.memberships.orgId, org.id),
  });
  const orgProfiles = orgMemberships.length
    ? await database.query.memberProfiles.findMany({
        where: inArray(
          schema.memberProfiles.membershipId,
          orgMemberships.map((m) => m.id),
        ),
      })
    : [];
  const userForMembership = new Map(orgMemberships.map((m) => [m.id, m.userId]));
  const unreachableUsers = new Set(
    orgProfiles
      .filter((p) => Boolean(p.emailUnreachableAt))
      .map((p) => userForMembership.get(p.membershipId))
      .filter((id): id is string => Boolean(id)),
  );

  /*
    Members deactivated here (U35, R65). Pass 1 already sweeps only active
    members; pass 2 must skip them too, or a leaver receives expiry mail — and a
    login-delivery record — for a competency they hold no live seat against.
    Keyed by user, matching the holder rows. On reactivation the window's record
    is absent, so they are reminded then.
  */
  const deactivatedUsers = new Set(
    orgMemberships.filter((m) => m.status !== 'active').map((m) => m.userId),
  );

  for (const holder of holders) {
    const competency = competencyById.get(holder.competencyId);
    if (!competency) continue;
    const expiry = expiryOf(holder, competency);
    if (!expiry) continue; // never expires → nothing to warn about (R97)
    const msLeft = expiry.getTime() - now.getTime();
    // Already lapsed is PASS 1's business, not a warning; outside the window is
    // simply too early to say anything.
    if (msLeft <= 0 || msLeft > leadDays * DAY_MS) continue;

    const expiresOn = expiry.toISOString().slice(0, 10);
    const already = await database.query.sentNotices.findFirst({
      where: and(
        eq(schema.sentNotices.userId, holder.userId),
        eq(schema.sentNotices.competencyId, holder.competencyId),
        eq(schema.sentNotices.expiresOn, expiresOn),
      ),
    });
    if (already) continue; // once per window (KTD11)
    if (deactivatedUsers.has(holder.userId)) continue; // a leaver is not reminded

    /*
      CLAIM THE WINDOW BEFORE SENDING. The record is the login route AND the
      idempotence guard, written whether or not the email goes out. Writing it
      first and sending only when the insert WON closes the overlapping-sweep
      race: two sweeps both pass the `already` check above, but the (user,
      competency, window) unique index lets only one insert land — the other's
      `onConflictDoNothing` returns no row, so only the winner emails and the
      loser does not double-send. A returned row is also this pass's proof the
      notice is ours to count.
    */
    const [claimed] = await database
      .insert(schema.sentNotices)
      .values({ orgId: org.id, userId: holder.userId, competencyId: holder.competencyId, expiresOn })
      .onConflictDoNothing({
        target: [
          schema.sentNotices.userId,
          schema.sentNotices.competencyId,
          schema.sentNotices.expiresOn,
        ],
      })
      .returning();
    if (!claimed) continue; // another sweep claimed this window first

    const user = userById.get(holder.userId);
    // Email is best-effort and never gates the record above — and it is skipped
    // entirely for an address flagged as reaching nobody (R98).
    if (user?.email && !unreachableUsers.has(holder.userId)) {
      await sendExpiryNoticeEmail({ to: user.email, competencyName: competency.name, expiresOn });
    }
    noticesSent++;
  }

  return noticesSent;
}

/**
 * PASS 3 — capture today's compliance numbers as `compliance_snapshots` rows
 * (U4, KTD5): the org row, plus one row per ACTIVE location and department.
 * Scoped rows are captured from day one even though v1 UI reads only the org
 * rows — a scoped trend asked for later cannot be backfilled. A retired scope
 * stops getting new rows (its requirements stopped applying) but keeps its
 * history.
 *
 * THE NUMBERS ARE THE ROUTE'S NUMBERS, by construction: one org-wide
 * expansion (active memberships → required sets → grants), resolved by
 * `requiredStandingByMember` and folded by `complianceCountsOf` — the exact
 * helpers `GET /training-summary` derives its KPIs with — then sliced per
 * scope from RAW placement rows intersected with the active member set. No
 * second opinion of "compliant" or "gap" exists for a snapshot to disagree
 * with the dashboard about. The awarding map is deliberately empty: no COUNT
 * reads the `noAward` flag, and resolving tools here would be a read for
 * nothing.
 *
 * IDEMPOTENT PER (org, UTC day) BY DELETE-THEN-INSERT inside one transaction,
 * not an upsert: the two partial unique indexes (org rows vs scoped rows)
 * would need two separate `onConflictDoUpdate` statements with per-index
 * `targetWhere` clauses — and an upsert still leaves a STALE row behind when
 * a scope retires between runs of the same day, claiming numbers for a scope
 * the recompute no longer produces. Deleting the day's rows and inserting the
 * recompute makes the day's snapshot exactly the recompute, every run. The
 * partial unique indexes remain the concurrency backstop: two same-day runs
 * racing serialize on them (one may abort; the caller's pass-3 try/catch
 * absorbs it, and the surviving rows are a complete, correct capture).
 *
 * `capturedOn` is the UTC date of `now` — the sweep is externally triggered,
 * and pinning to UTC keeps an irregular invocation time from double-filling
 * or skipping a day.
 */
export async function captureComplianceSnapshots(
  database: Database,
  orgId: string,
  now: Date,
): Promise<number> {
  return runSnapshotted(database, async (tx) => {
    const memberships = await tx.query.memberships.findMany({
      where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active')),
    });
    const membershipIds = memberships.map((m) => m.id);
    const userIds = [...new Set(memberships.map((m) => m.userId))];
    const userOfMembership = new Map(memberships.map((m) => [m.id, m.userId]));

    /*
      The standing loader opens its own repeatable-read transaction; on this
      pass's handle it nests as a SAVEPOINT on the same snapshot
      (`runSnapshotted`'s documented design). The cast is the one
      `runSnapshotted` itself performs — a transaction handle carries
      `.transaction` but not `$client`, so it does not satisfy `Db` nominally.
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
    const competencyById = new Map<string, MatrixCompetency>(competencies.map((c) => [c.id, c]));

    const standings = requiredStandingByMember({
      userIds,
      requiredByUser,
      competencyById,
      grantsByUser,
      awardingToolByCompetency: new Map(), // counts never read `noAward` — see docblock
      now,
    });

    // RAW placement rows, any value status — who stands WHERE is a placement
    // question; only the ACTIVE-scope filter below decides which scopes get a
    // row today.
    const locationPlacements = membershipIds.length
      ? await tx.query.membershipLocations.findMany({
          where: inArray(schema.membershipLocations.membershipId, membershipIds),
        })
      : [];
    const departmentPlacements = membershipIds.length
      ? await tx.query.membershipDepartments.findMany({
          where: inArray(schema.membershipDepartments.membershipId, membershipIds),
        })
      : [];
    const activeLocations = await tx.query.locations.findMany({
      where: and(eq(schema.locations.orgId, orgId), eq(schema.locations.status, 'active')),
    });
    const activeDepartments = await tx.query.departments.findMany({
      where: and(eq(schema.departments.orgId, orgId), eq(schema.departments.status, 'active')),
    });

    const capturedOn = now.toISOString().slice(0, 10);
    const rowFor = (
      scopeType: 'location' | 'department' | null,
      scopeId: string | null,
      users: Iterable<string>,
    ): typeof schema.complianceSnapshots.$inferInsert => {
      const subset = [];
      for (const userId of new Set(users)) {
        const standing = standings.get(userId);
        if (standing) subset.push(standing);
      }
      return { orgId, capturedOn, scopeType, scopeId, ...complianceCountsOf(subset) };
    };
    const byLocation = usersByScopeId(locationPlacements, (p) => p.locationId, userOfMembership);
    const byDepartment = usersByScopeId(
      departmentPlacements,
      (p) => p.departmentId,
      userOfMembership,
    );
    const noUsers: ReadonlySet<string> = new Set<string>();

    const rows = [
      rowFor(null, null, userIds),
      ...activeLocations.map((l) => rowFor('location', l.id, byLocation.get(l.id) ?? noUsers)),
      ...activeDepartments.map((d) =>
        rowFor('department', d.id, byDepartment.get(d.id) ?? noUsers),
      ),
    ];

    // Delete-then-insert per (org, day) — the idempotence rationale above.
    await tx
      .delete(schema.complianceSnapshots)
      .where(
        and(
          eq(schema.complianceSnapshots.orgId, orgId),
          eq(schema.complianceSnapshots.capturedOn, capturedOn),
        ),
      );
    await tx.insert(schema.complianceSnapshots).values(rows);
    return rows.length;
  });
}

/** Sweep every organisation, each isolated so one failure cannot stop the rest (KTD11). */
export async function sweepAllOrganizations(
  database: Database,
  now: Date = new Date(),
): Promise<OrgSweepResult[]> {
  const orgs = await database.query.organizations.findMany();
  const results: OrgSweepResult[] = [];
  for (const org of orgs) {
    try {
      const result = await sweepOrganization(database, org, now);
      results.push({ orgId: org.id, ...result });
    } catch {
      results.push({ orgId: org.id, casesCreated: 0, noticesSent: 0, snapshotsWritten: 0, failed: true });
    }
  }
  return results;
}
