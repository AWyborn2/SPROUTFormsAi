/**
 * The expiry sweep (U21, KTD11, KTD12). Makes renewal happen because the product
 * noticed: two passes over an organisation, safe to run repeatedly.
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
 * One call sweeps EVERY organisation, each inside its own error boundary, so no
 * organisation has to be registered with the caller and a failing one does not
 * stop the rest — a newly onboarded organisation must not go silently unswept.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { expiryOf } from '@formai/shared';
import { assignForMembership } from './assignment.js';
import { sendExpiryNoticeEmail } from '../email/resend.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;
const DAY_MS = 86_400_000;

export interface OrgSweepResult {
  orgId: string;
  casesCreated: number;
  noticesSent: number;
  /** Set when this organisation's pass threw and was skipped, so one failure does not stop the rest. */
  failed?: boolean;
}

/** Sweep one organisation. `now` is threaded so a run is reproducible against fixed data. */
export async function sweepOrganization(
  database: Database,
  org: typeof schema.organizations.$inferSelect,
  now: Date,
): Promise<{ casesCreated: number; noticesSent: number }> {
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
  const leadDays = org.notificationLeadDays ?? 30;
  const holders = await database.query.competencyHolders.findMany({
    where: and(
      eq(schema.competencyHolders.orgId, org.id),
      isNull(schema.competencyHolders.revokedAt),
    ),
  });
  let noticesSent = 0;
  if (holders.length === 0) return { casesCreated, noticesSent };

  const comps = await database.query.competencies.findMany({
    where: eq(schema.competencies.orgId, org.id),
  });
  const competencyById = new Map(comps.map((c) => [c.id, c]));
  const userIds = [...new Set(holders.map((h) => h.userId))];
  const users = await database.query.users.findMany({
    where: inArray(schema.users.id, userIds),
  });
  const userById = new Map(users.map((u) => [u.id, u]));

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

    const user = userById.get(holder.userId);
    // Email is best-effort and never gates the record below.
    if (user?.email) {
      await sendExpiryNoticeEmail({ to: user.email, competencyName: competency.name, expiresOn });
    }
    // The record IS the login route AND the idempotence guard, so it is written
    // whether or not the email went out. `onConflictDoNothing` on the (user,
    // competency, window) unique index makes a lost check-then-insert race — two
    // sweeps overlapping — a no-op rather than an error that would abort the rest
    // of this organisation's pass.
    await database
      .insert(schema.sentNotices)
      .values({ orgId: org.id, userId: holder.userId, competencyId: holder.competencyId, expiresOn })
      .onConflictDoNothing({
        target: [
          schema.sentNotices.userId,
          schema.sentNotices.competencyId,
          schema.sentNotices.expiresOn,
        ],
      });
    noticesSent++;
  }

  return { casesCreated, noticesSent };
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
      results.push({ orgId: org.id, casesCreated: 0, noticesSent: 0, failed: true });
    }
  }
  return results;
}
