/**
 * Notify the shared queue when a pooled case is invalidated (U18, R130).
 *
 * When a person with a case in flight is deactivated, that case is invalidated
 * and — if it named nobody — falls back to the shared queue. A named-assessor
 * case has one obvious person to tell; a POOLED case names nobody, so there is
 * no existing mechanism to tell anyone, and this is the piece U18 supplies that
 * the deactivation rule (the candidate profile artifact's) cannot: it works out
 * who is ELIGIBLE to assess that tool at that Location and tells all of them.
 *
 * Eligibility is the very rule an assessor must meet to open or sign off the
 * case (R64): they hold every competency the tool requires at the case's
 * Location, CURRENT — revoked or expired grants do not qualify. A named assessor
 * on the case is notified too, whatever their competencies, because the case was
 * theirs.
 *
 * Fail-soft throughout (like `sendInviteEmail`): an unconfigured or failing
 * sender stops neither the notification loop nor the remediation that triggered
 * it. The return value reports who we ATTEMPTED to reach (eligible, with an
 * address), which is what a caller wants to record — not whether the mail server
 * happened to be up.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { competencyCurrency, countsAsHeld, resolveAssessorRequirements } from '@formai/shared';
import { sendPooledCaseNoticeEmail } from '../email/resend.js';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;

/** The facts about an invalidated case the notice needs. */
export interface InvalidatedCase {
  toolId: string;
  /** The case's Location — the assessor rule is resolved against it (R64). */
  locationId: string | null;
  /** Whose case it was, for the message. */
  candidateName: string;
  /** A named assessor on the case, if any — notified too regardless of currency (R130). */
  namedAssessorUserId: string | null;
}

/**
 * Everyone eligible to assess an invalidated case's tool at its Location, plus
 * any named assessor, notified best-effort. Returns the user ids we tried to
 * reach (eligible, with an email). Pure eligibility — no case is touched.
 */
export async function notifyPoolOfInvalidatedCase(
  database: Database,
  orgId: string,
  invalidated: InvalidatedCase,
  now: Date = new Date(),
): Promise<{ notifiedUserIds: string[] }> {
  const tool = await database.query.assessmentTools.findFirst({
    where: and(
      eq(schema.assessmentTools.id, invalidated.toolId),
      eq(schema.assessmentTools.orgId, orgId),
    ),
  });
  if (!tool) return { notifiedUserIds: [] };

  const needs = resolveAssessorRequirements(
    {
      always: tool.assessorCompetencyIds ?? [],
      byStream: tool.assessorStreamCompetencyIds ?? {},
    },
    invalidated.locationId,
  );

  const eligible = new Set<string>();
  if (needs.required.length > 0) {
    // Everyone holding ANY required competency, then keep only those holding ALL
    // of them, current. A revoked grant is excluded in the query; expiry is
    // respected by `countsAsHeld`.
    const holders = await database.query.competencyHolders.findMany({
      where: and(
        eq(schema.competencyHolders.orgId, orgId),
        inArray(schema.competencyHolders.competencyId, needs.required),
        isNull(schema.competencyHolders.revokedAt),
      ),
    });
    const comps = await database.query.competencies.findMany({
      where: and(
        eq(schema.competencies.orgId, orgId),
        inArray(schema.competencies.id, needs.required),
      ),
    });
    const validityById = new Map(comps.map((c) => [c.id, c]));

    const currentByUser = new Map<string, Set<string>>();
    for (const holder of holders) {
      const validity = validityById.get(holder.competencyId);
      if (!validity) continue;
      if (!countsAsHeld(competencyCurrency(holder, validity, now, 'assessor'))) continue;
      const held = currentByUser.get(holder.userId) ?? new Set<string>();
      held.add(holder.competencyId);
      currentByUser.set(holder.userId, held);
    }
    for (const [userId, held] of currentByUser) {
      if (needs.required.every((id) => held.has(id))) eligible.add(userId);
    }
  }

  // The named assessor is told too — the case was theirs (R130).
  if (invalidated.namedAssessorUserId) eligible.add(invalidated.namedAssessorUserId);

  if (eligible.size === 0) return { notifiedUserIds: [] };

  const users = await database.query.users.findMany({
    where: inArray(schema.users.id, [...eligible]),
  });
  const userById = new Map(users.map((u) => [u.id, u]));
  const notifiedUserIds: string[] = [];
  // Iterate the eligible set, not the query result — only these are notified,
  // whatever else a broad read returned.
  for (const userId of eligible) {
    const user = userById.get(userId);
    if (!user?.email) continue;
    // Best-effort: a failed send never stops the loop or the remediation.
    await sendPooledCaseNoticeEmail({
      to: user.email,
      toolName: tool.name,
      candidateName: invalidated.candidateName,
    });
    notifiedUserIds.push(userId);
  }
  return { notifiedUserIds };
}
