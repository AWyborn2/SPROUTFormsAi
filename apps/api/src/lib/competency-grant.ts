import { and, count, eq, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { TenantContext } from '@formai/shared';
import { recordAudit } from '../audit/record.js';
import type { db as dbType } from '../db.js';

type Database = NonNullable<typeof dbType>;

/**
 * Granting and revoking a competency — the one implementation, shared.
 *
 * There were two callers coming: the manual grant an admin performs, and the
 * automatic one a signed-off assessment performs. A second copy is how
 * `competencies.holders` drifts — it is a denormalised COUNT, it is the only
 * holder figure any screen shows, and a writer that forgets to resync it leaves
 * the register quietly disagreeing with itself with no test to catch it.
 *
 * REVOCATION DOES NOT DELETE. An overturned appeal has to strip a grant while
 * leaving the fact it was once held on the record, which is the same conclusion
 * this codebase already reached for API keys: something that WAS true stays
 * visible to the audit conversation about it. Every eligibility read therefore
 * has to filter `revokedAt IS NULL`, and so does the count.
 */

/**
 * Holders of a competency, EXCLUDING revoked grants, written back to the count.
 *
 * DELIBERATELY COUNTS GRANTED, NOT CURRENT. Expiry is derived from each grant's
 * date, so the number of people currently qualified changes as the clock moves,
 * with no write to trigger a resync — a stored count that excluded expired
 * grants would be wrong every day after it was written, and silently so. A
 * count that means "has been granted this, and not had it taken away" is
 * something a stored integer can actually stay true to.
 *
 * Whether a particular person is CURRENT is a per-holder question, answered by
 * `competencyStatus` at the point of asking. Any screen that shows this number
 * beside a claim about currency has to get the currency from there.
 */
export async function syncHolderCount(database: Database, competencyId: string): Promise<number> {
  // A SQL aggregate, not findMany().length — this table grows with people ×
  // competencies, and loading every row to count it would scale with the
  // workforce on a request that only needs one number.
  const [result] = await database
    .select({ count: count() })
    .from(schema.competencyHolders)
    .where(
      and(
        eq(schema.competencyHolders.competencyId, competencyId),
        // A revoked grant is kept for the trail but is not a holder. Counting
        // it would tell a manager twelve people are qualified when eleven are.
        isNull(schema.competencyHolders.revokedAt),
      ),
    );
  const holders = result?.count ?? 0;
  await database
    .update(schema.competencies)
    .set({ holders })
    .where(eq(schema.competencies.id, competencyId));
  return holders;
}

/** Load a competency within the caller's org, or null. */
export async function findOwnedCompetency(database: Database, competencyId: string, orgId: string) {
  return (
    (await database.query.competencies.findFirst({
      where: and(eq(schema.competencies.id, competencyId), eq(schema.competencies.orgId, orgId)),
    })) ?? null
  );
}

export interface GrantOutcome {
  competencyId: string;
  /** Null on an internal competency that legitimately has no code. */
  code: string | null;
  /** Always present — what a caller names the grant by when there is no code. */
  name: string;
  /** True when this call created the row rather than refreshing an existing one. */
  created: boolean;
  holders: number;
}

/**
 * Why a grant could not be made. Two distinct reasons, kept distinct: an admin
 * granting by hand needs to know whether they picked the wrong competency or
 * the wrong person, and collapsing both into "not found" makes that
 * undiagnosable from the UI.
 */
export type GrantRefusal = 'competency_not_found' | 'user_not_in_org';

export type GrantResult = { ok: true; outcome: GrantOutcome } | { ok: false; reason: GrantRefusal };

export interface GrantInput {
  competencyId: string;
  userId: string;
  evidenceRef?: string | null;
  /** The assessment case that earned it, when the product granted it itself. */
  sourceCaseId?: string | null;
  /**
   * An explicit end date, overriding the one derived from the qualification's
   * validity. For a date imported from the training system that does not fit
   * the formula. Omit for a normal grant.
   */
  expiresAt?: Date | null;
  /**
   * Licence class and number, where this competency IS a licence (R33, R34).
   *
   * Recorded on the grant rather than as profile fields, so the licence
   * inherits expiry, grace, revocation and every prerequisite check from this
   * model instead of rebuilding them badly. Its expiry is `expiresAt` above and
   * its document is a `competency_documents` row; nothing else is needed.
   */
  licenceClass?: string | null;
  licenceNumber?: string | null;
}

/**
 * Grant one competency to one person, within the caller's org.
 *
 * UPSERTS rather than skipping. The route this replaces guarded with
 * `if (!existing)` and did nothing when a row was already there, so a re-grant
 * silently discarded the new evidence and the surviving row went on pointing at
 * the first case that earned it — and since (competencyId, userId) is unique,
 * there was no room for a second row to hold the newer link. Re-granting now
 * refreshes the evidence and clears any revocation.
 *
 * Refuses, distinguishably, when the competency does not exist in this org or
 * the holder is not a member of it. The membership check is not ceremony:
 * without it any org could record a grant against any user id in the system and
 * read it back as eligibility.
 */
export async function grantCompetency(
  database: Database,
  tenant: TenantContext,
  input: GrantInput,
): Promise<GrantResult> {
  const competency = await findOwnedCompetency(database, input.competencyId, tenant.orgId);
  if (!competency) return { ok: false, reason: 'competency_not_found' };

  const membership = await database.query.memberships.findFirst({
    where: and(
      eq(schema.memberships.userId, input.userId),
      eq(schema.memberships.orgId, tenant.orgId),
    ),
  });
  if (!membership) return { ok: false, reason: 'user_not_in_org' };

  const existing = await database.query.competencyHolders.findFirst({
    where: and(
      eq(schema.competencyHolders.competencyId, competency.id),
      eq(schema.competencyHolders.userId, input.userId),
    ),
  });

  /*
    REQUALIFYING RESTARTS THE CLOCK.

    Granting is an upsert — a second grant updates the existing row rather than
    inserting a new one — so `createdAt` records when the person FIRST earned
    the ticket and never moves again. Expiry counts from `grantedAt`, which is
    why it is a separate column and why it is stamped on both paths: without
    this, someone who re-sat a three-year assessment last week would still read
    as expired from their 2022 grant.

    An explicit `expiresAt` is cleared on a re-grant unless a new one is
    supplied. It is an override for an imported date, and carrying a stale one
    forward would silently cap the new grant at the old ticket's end date.
  */
  const grantedAt = new Date();

  if (existing) {
    await database
      .update(schema.competencyHolders)
      .set({
        evidenceRef: input.evidenceRef ?? existing.evidenceRef ?? null,
        sourceCaseId: input.sourceCaseId ?? existing.sourceCaseId ?? null,
        grantedByUserId: tenant.userId,
        grantedAt,
        expiresAt: input.expiresAt ?? null,
        // Carried forward unless new ones are supplied: renewing a ticket
        // rarely changes its class or its number (R34).
        licenceClass: input.licenceClass ?? existing.licenceClass ?? null,
        licenceNumber: input.licenceNumber ?? existing.licenceNumber ?? null,
        // A fresh grant supersedes an earlier revocation — the person has just
        // demonstrated the competency again.
        revokedAt: null,
        revokedReason: null,
      })
      .where(eq(schema.competencyHolders.id, existing.id));
  } else {
    await database.insert(schema.competencyHolders).values({
      orgId: tenant.orgId,
      competencyId: competency.id,
      userId: input.userId,
      evidenceRef: input.evidenceRef ?? null,
      sourceCaseId: input.sourceCaseId ?? null,
      grantedByUserId: tenant.userId,
      grantedAt,
      expiresAt: input.expiresAt ?? null,
      licenceClass: input.licenceClass ?? null,
      licenceNumber: input.licenceNumber ?? null,
    });
  }

  await recordAudit(database, tenant, {
    action: 'Granted competency',
    // By code where there is one, by name where there is not: an internal
    // competency has no code, and "null → <user>" names nobody's qualification.
    target: `${competency.code ?? competency.name} → ${input.userId}`,
    category: 'settings',
    icon: 'award',
  });

  return {
    ok: true,
    outcome: {
      competencyId: competency.id,
      code: competency.code,
      name: competency.name,
      created: !existing,
      holders: await syncHolderCount(database, competency.id),
    },
  };
}

/**
 * Revoke every grant that came from one case, without erasing it.
 *
 * Used when a case is appealed: the disputed result can no longer confer
 * eligibility, but the record that it was once held has to survive, or the
 * register and the audit log start telling different stories about the same
 * person.
 */
export async function revokeGrantsFromCase(
  database: Database,
  tenant: TenantContext,
  caseId: string,
  reason: string,
): Promise<number> {
  const rows = await database.query.competencyHolders.findMany({
    where: and(
      eq(schema.competencyHolders.sourceCaseId, caseId),
      eq(schema.competencyHolders.orgId, tenant.orgId),
      isNull(schema.competencyHolders.revokedAt),
    ),
  });
  if (rows.length === 0) return 0;

  const revokedAt = new Date();
  for (const row of rows) {
    await database
      .update(schema.competencyHolders)
      .set({ revokedAt, revokedReason: reason })
      .where(eq(schema.competencyHolders.id, row.id));
    await syncHolderCount(database, row.competencyId);
  }

  await recordAudit(database, tenant, {
    action: 'Revoked competency',
    target: `${rows.length} grant(s) from case ${caseId}: ${reason}`,
    category: 'settings',
    icon: 'award',
  });

  return rows.length;
}
