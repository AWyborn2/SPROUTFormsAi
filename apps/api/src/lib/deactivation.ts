import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import type { TenantContext } from '@formai/shared';
import { DEACTIVATED_STATUS } from '../middleware/tenant.js';
import { notifyPoolOfInvalidatedCase } from './pool-notify.js';
import { recordAudit } from '../audit/record.js';

/**
 * Leaving is DEACTIVATION — not deletion, and not revocation (R62–R78).
 *
 * THREE IDEAS THAT MUST NOT BE CONFLATED:
 *
 *  - DELETION would take the competency evidence that certified somebody along
 *    with them. Every record is retained indefinitely and with no expiry (R63),
 *    which is what lets a returning worker keep competencies still in date.
 *  - REVOCATION means the qualification was withdrawn — a judgement about
 *    competence. Leaving is not that, so deactivation revokes nothing (R66) and
 *    a competency that lapsed while somebody was away reads as expired rather
 *    than revoked.
 *  - DEACTIVATION ends REACH. A record kept forever is not the same as a door
 *    left open (R65).
 *
 * WHAT ENDS REACH, and all three are needed:
 *  1. the live session — handled by `requireTenant`'s revalidation, because the
 *     session is a sealed cookie with nothing server-side to revoke;
 *  2. the front door — handled by `provisionTenant` refusing to resolve a
 *     deactivated membership, so they cannot simply sign in again;
 *  3. an outstanding invitation they never accepted, closed here.
 *
 * The grace clock keeps running throughout (R70) because expiry is DERIVED from
 * dates rather than ticked, so absence needs no special handling at all.
 */

export interface DeactivationOutcome {
  /** Invitations closed because they were never accepted (R65, R75). */
  invitationsClosed: number;
  /** Cases in flight that became invalid (R71), retained as history (R72). */
  casesInvalidated: number;
  /** The pool the released seat returned to (R77). */
  seatReleased: 'staff' | 'candidate';
}

/**
 * Deactivate one member of one organisation.
 *
 * Runs in a transaction: a member whose session is ended but whose invitation
 * stays open, or whose cases are invalidated without the status moving, is a
 * half-closed door.
 */
export async function deactivateMember(
  db: Db,
  tenant: TenantContext,
  membership: { id: string; userId: string; orgId: string; role: string },
): Promise<DeactivationOutcome> {
  const invalidated: Array<{
    id: string;
    toolId: string;
    locationId: string | null;
    namedAssessorUserId: string | null;
  }> = [];
  let invitationsClosed = 0;
  let candidateName = 'A candidate';

  await db.transaction(async (tx) => {
    await tx
      .update(schema.memberships)
      .set({ status: DEACTIVATED_STATUS })
      .where(eq(schema.memberships.id, membership.id));

    /*
      R65/R75: an invitation does not lapse with time — it stays open until it
      is accepted. So one held by somebody who has gone would stand open
      indefinitely unless deactivation closes it. Marked accepted-by-nobody
      rather than deleted, so the record of having invited them survives.
    */
    const user = await tx.query.users.findFirst({ where: eq(schema.users.id, membership.userId) });
    if (user?.name) candidateName = user.name;
    if (user?.email) {
      const open = await tx.query.invites.findMany({
        where: and(
          eq(schema.invites.orgId, membership.orgId),
          eq(schema.invites.email, user.email),
          isNull(schema.invites.acceptedAt),
        ),
      });
      for (const invite of open) {
        await tx.update(schema.invites).set({ expiresAt: new Date() }).where(eq(schema.invites.id, invite.id));
        invitationsClosed++;
      }
    }

    /*
      R71/R72: a case in flight becomes invalid and is RETAINED as history along
      with anything already signed on it — whether or not the person ever
      returns. A reactivated candidate begins that assessment as a new case
      rather than resuming this one (R74).
    */
    const inFlight = await tx.query.assessmentCases.findMany({
      where: and(
        eq(schema.assessmentCases.orgId, membership.orgId),
        eq(schema.assessmentCases.candidateUserId, membership.userId),
        eq(schema.assessmentCases.state, 'open'),
      ),
    });
    for (const openCase of inFlight) {
      await tx
        .update(schema.assessmentCases)
        // Terminal, so `closedAt` means something — it dates the abandonment.
        // Nobody will work this case again; only its OUTCOME differs from a
        // case that finished, and the state value is what says so.
        .set({ state: 'invalidated', closedAt: new Date() })
        .where(eq(schema.assessmentCases.id, openCase.id));
      invalidated.push({
        id: openCase.id,
        toolId: openCase.toolId,
        locationId: openCase.locationId,
        // R73 notifies the named assessor too, where the case names one. A case
        // created by automatic assignment names none, which is why the notice
        // reaches the eligible pool rather than an individual.
        namedAssessorUserId: openCase.assessorUserId,
      });
    }
  });

  /*
    R73: every assessor eligible for that tool at the case's Location is told,
    and the named assessor too where the case names one. A case created by
    automatic assignment names none, which is why the notice reaches a POOL
    rather than an individual.

    Outside the transaction and fail-soft: a notification that cannot be sent
    must not roll back a deactivation somebody has already decided on.
  */
  for (const c of invalidated) {
    try {
      await notifyPoolOfInvalidatedCase(db, membership.orgId, {
        toolId: c.toolId,
        locationId: c.locationId,
        candidateName,
        namedAssessorUserId: c.namedAssessorUserId,
      });
    } catch {
      // Best-effort, matching the sender's own posture.
    }
  }

  await recordAudit(db, tenant, {
    action: 'Deactivated member',
    target: membership.userId,
    category: 'team',
    icon: 'user-minus',
  });

  return {
    invitationsClosed,
    casesInvalidated: invalidated.length,
    // R77: the pool the membership's access level drew on.
    seatReleased: membership.role === 'candidate' ? 'candidate' : 'staff',
  };
}

export interface ReactivationOutcome {
  /** True where they had never accepted their invitation and need a fresh one (R76). */
  needsFreshInvitation: boolean;
  /** The pool the consumed seat came from (R78). */
  seatConsumed: 'staff' | 'candidate';
}

/**
 * Bring a returner back (R68, R69, R76).
 *
 * DOES ALMOST NOTHING, and that is the design. The profile, the documents, the
 * competencies and the assessment history reappear because nothing ever removed
 * them (R63); competencies still inside their expiry are valid immediately
 * without reassessment (R69) because nothing revoked them and expiry is derived
 * from dates; and one that lapsed while they were away reads as expired rather
 * than revoked (R66).
 *
 * THE STATUS WRITE IS THE CALLER'S, not this function's. The seat the returner
 * claims and the row going `active` must land as one indivisible step under the
 * seat lock (R78/R86), or two returners racing one free seat both pass a count
 * neither has changed yet. So the route flips the status inside its transaction;
 * this settles everything that write does not — whether a fresh invitation is
 * needed (R76), the audit, and the outcome.
 */
export async function reactivateMember(
  db: Db,
  tenant: TenantContext,
  membership: { id: string; userId: string; orgId: string; role: string },
): Promise<ReactivationOutcome> {
  /*
    R76: somebody who had already accepted their invitation needs none reissued
    — their credentials still work and the front door is open again. Somebody
    deactivated BEFORE they ever accepted is invited again, because R65 closed
    the invitation they were holding.
  */
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, membership.userId) });
  const accepted = user?.email
    ? await db.query.invites.findMany({
        where: and(
          eq(schema.invites.orgId, membership.orgId),
          eq(schema.invites.email, user.email),
          // acceptedByUserId is a uuid column: a "has been accepted" test is
          // IS NOT NULL, never `<> ''` — an empty string is not a valid uuid
          // literal and Postgres rejects the comparison outright.
          isNotNull(schema.invites.acceptedByUserId),
        ),
      })
    : [];

  await recordAudit(db, tenant, {
    action: 'Reactivated member',
    target: membership.userId,
    category: 'team',
    icon: 'user-plus',
  });

  return {
    // No password hash means they never completed a signup, so they never
    // accepted; a set one means they did and need nothing fresh.
    needsFreshInvitation: !user?.passwordHash && accepted.length === 0,
    seatConsumed: membership.role === 'candidate' ? 'candidate' : 'staff',
  };
}

/** Cases invalidated for one person, for the history R72 keeps retrievable. */
export async function invalidatedCasesFor(db: Db, orgId: string, userId: string) {
  return db.query.assessmentCases.findMany({
    where: and(
      eq(schema.assessmentCases.orgId, orgId),
      eq(schema.assessmentCases.candidateUserId, userId),
      inArray(schema.assessmentCases.state, ['invalidated']),
    ),
  });
}
