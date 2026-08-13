import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATEGORIES,
  ROLES,
  bestCurrency,
  competencyCurrency,
  countsAsHeld,
  needsAttention,
  type PermissionMatrix,
  type Role,
} from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission, permissionScope } from '../lib/permissions.js';
import { requiredCompetencyIdsByUser } from '../lib/standing.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { recordAudit } from '../audit/record.js';
import { sendInviteEmail } from '../email/resend.js';
import { env } from '../env.js';
import { checkSeatAvailability, lockOrgForSeats, poolFor, seatLimitError } from '../lib/seats.js';
import { recordExpansion, seatOrExpand, type SeatExpansion } from '../lib/seat-blocks.js';
import { readPlacement, writePlacement } from '../lib/membership-placement.js';
import { assignForMembership } from '../lib/assignment.js';
import { identifyMember, loadDisplayIdentities } from '../lib/display-identity.js';
import { profileTierOrg } from '../lib/profile-access.js';
import { deactivateMember, reactivateMember } from '../lib/deactivation.js';
import { db } from '../db.js';

export const teamRouter: Router = Router();

const canViewTeam = (tenant: { orgId: string; role: string }) => hasPermission(tenant, 'team', 'view');

const permissionActions = [
  'view',
  'create',
  'edit',
  'delete',
  'export',
  'invite',
  'manage',
  'approve',
] as const;

const canManageTeam = (tenant: { orgId: string; role: string }) => hasPermission(tenant, 'team', 'manage');

/**
 * Per-member competency counts for the Team list (oversight round).
 *
 * `requiredCurrent` measures eligibility (held, expiring or grace);
 * `requiredAttention` measures urgency (expiring, grace or expired) — an
 * expiring required competency deliberately counts in BOTH, mirroring how the
 * record shows it as simultaneously valid and flagged. `optionalLapsed` is
 * fully expired optional grants only; grace still counts as current everywhere.
 * A required competency never held appears in neither number — that gap is the
 * compliance report's `neverHeld`, not a row chip.
 */
interface MemberCompetencyCounts {
  requiredCurrent: number;
  requiredAttention: number;
  optionalLapsed: number;
}

teamRouter.get(
  '/members',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    /*
      Gated at last. This list is every member's name, address and role — the
      matrix's `team.view` existed for exactly this read but was never applied,
      so any authenticated member could pull the roster. Tightened while the
      round adds competency data to the same response; the only product caller
      is the Team screen, which the nav already scopes to admins.
    */
    if (!(await canViewTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const [memberships, pendingInvites] = await Promise.all([
      db.query.memberships.findMany({ where: eq(schema.memberships.orgId, tenant.orgId) }),
      db.query.invites.findMany({
        where: and(eq(schema.invites.orgId, tenant.orgId), isNull(schema.invites.acceptedAt)),
      }),
    ]);
    const userIds = memberships.map((m) => m.userId);
    const users = userIds.length
      ? await db.query.users.findMany({ where: inArray(schema.users.id, userIds) })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    /*
      R24: a name alone is not an identification. Resolved live from the profile
      rather than stored on the membership, so a corrected number corrects itself
      here without a write (R61). Members with no profile yet keep the name this
      list already showed.
    */
    const identities = await loadDisplayIdentities(db, tenant.orgId, userIds);

    /*
      Competency counts ride the SAME two gates the record's competency section
      resolves: the plan tier that carries profiles at all, AND
      `profiles.view_competencies` at org scope (KTD4). The tier half matters as
      much as the matrix half — every dedicated competency surface refuses an
      organisation below the assessments tier, and the roster must not become
      the one read that leaks the same derived data past that boundary. Below
      either gate the field is null and the web renders no column.

      Batched: the standing resolver takes every userId at once, then one
      holders read and one competencies read cover the lot (R2 — never a
      per-member lookup). Inputs are ACTIVE members only — a suspended row's
      counts are nulled in the response, so computing them would be waste.
    */
    const activeUserIds = [
      ...new Set(memberships.filter((m) => m.status === 'active').map((m) => m.userId)),
    ];
    const countsScope = await permissionScope(tenant, 'profiles', 'view_competencies');
    const tierOrg =
      countsScope === 'all' && activeUserIds.length > 0
        ? await profileTierOrg(db, tenant.orgId)
        : null;
    let countsByUser: Map<string, MemberCompetencyCounts> | null = null;
    if (countsScope === 'all' && tierOrg && activeUserIds.length > 0) {
      const requiredByUser = await requiredCompetencyIdsByUser(db, tenant.orgId, activeUserIds);
      // The eligibility read: a revoked grant confers nothing, so it is
      // filtered here rather than carried and re-checked per status.
      const holders = await db.query.competencyHolders.findMany({
        where: and(
          eq(schema.competencyHolders.orgId, tenant.orgId),
          inArray(schema.competencyHolders.userId, activeUserIds),
          isNull(schema.competencyHolders.revokedAt),
        ),
      });
      const competencyIds = [...new Set(holders.map((h) => h.competencyId))];
      const competencies = competencyIds.length
        ? await db.query.competencies.findMany({
            where: and(
              eq(schema.competencies.orgId, tenant.orgId),
              inArray(schema.competencies.id, competencyIds),
            ),
          })
        : [];
      const competencyById = new Map(competencies.map((c) => [c.id, c]));

      const grantsByUser = new Map<string, typeof holders>();
      for (const h of holders) {
        const list = grantsByUser.get(h.userId) ?? [];
        list.push(h);
        grantsByUser.set(h.userId, list);
      }

      // One instant for the whole response, so two rows cannot disagree about
      // what "today" is.
      const now = new Date();
      countsByUser = new Map();
      for (const userId of activeUserIds) {
        const required = requiredByUser.get(userId) ?? new Set<string>();
        const grants = grantsByUser.get(userId) ?? [];
        // Currency per held competency, via the ONE shared derivation (R13).
        const currenciesByCompetency = new Map<string, ReturnType<typeof competencyCurrency>[]>();
        for (const g of grants) {
          const currency = competencyCurrency(g, competencyById.get(g.competencyId) ?? {}, now, 'assessor');
          const list = currenciesByCompetency.get(g.competencyId) ?? [];
          list.push(currency);
          currenciesByCompetency.set(g.competencyId, list);
        }

        /*
          Per competency, the person's standing is their BEST grant
          (`bestCurrency`) — a renewal leaves the superseded grant in place,
          and reading grants one by one would flag a renewed person forever on
          the strength of the old row. Eligibility and urgency still overlap on
          purpose: an expiring required competency is simultaneously valid and
          flagged (KTD5).
        */
        let requiredCurrent = 0;
        let requiredAttention = 0;
        for (const competencyId of required) {
          const currencies = currenciesByCompetency.get(competencyId) ?? [];
          const best = bestCurrency(currencies);
          if (best && countsAsHeld(best)) requiredCurrent += 1;
          if (needsAttention(currencies)) requiredAttention += 1;
        }

        let optionalLapsed = 0;
        for (const [competencyId, currencies] of currenciesByCompetency) {
          if (required.has(competencyId)) continue;
          // A genuine lapse only: the best grant has fully expired.
          if (bestCurrency(currencies)?.status === 'expired') optionalLapsed += 1;
        }

        countsByUser.set(userId, { requiredCurrent, requiredAttention, optionalLapsed });
      }
    }

    res.json([
      ...memberships.map((m) => {
        const u = userById.get(m.userId);
        const identified = identifyMember(identities, m.userId, u?.name ?? '');
        return {
          id: m.id,
          /*
            The USER id, distinct from the membership id above. Anything that
            records something against a person — an assessment case, a
            competency grant — keys on this, and it used to be resolved here
            and thrown away, so opening the first case meant querying the
            database by hand. A pending invite has no user yet, hence null.
          */
          userId: m.userId,
          name: identified.name,
          /** The organisation-assigned number shown beside the name; null until one is issued (R24). */
          identifier: identified.identifier,
          email: u?.email ?? '',
          role: m.role,
          status: m.status,
          /*
            Null when the caller may not read competencies (R4), and on rows
            that are not active — a suspended or deactivated member's lapses
            are nobody's attention item, and computing them would contradict
            the compliance report, which only reads active members.
          */
          counts: m.status === 'active' ? (countsByUser?.get(m.userId) ?? null) : null,
        };
      }),
      ...pendingInvites.map((i) => ({
        id: i.id,
        // Nobody has accepted yet, so there is no user to key anything to. A
        // caller that needs a person must skip these rather than fall back to
        // the invite id, which belongs to a different table.
        userId: null,
        // A QR-delivered invite has no email at all, so the recorded name is
        // the only way to tell pending rows apart.
        name: i.inviteeName || nameFromEmail(i.email ?? '') || i.email || 'Pending invite',
        /*
          Always null here: nobody has accepted, so there is no membership to
          carry a profile and no number to resolve. The key is present anyway so
          every row in this list has one shape for the caller to read.
        */
        identifier: null,
        email: i.email ?? '',
        role: i.role,
        status: 'invited' as const,
        // Nobody has accepted, so there is nobody to hold anything.
        counts: null,
      })),
    ]);
  }),
);

/** "sam.lee@x.io" → "Sam Lee" */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function generateInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Inviting someone.
 *
 * `email` is OPTIONAL because many candidates have no work address — their
 * invite is delivered as a printed QR code instead. When it is omitted a name
 * is required, so a pending invite is still identifiable in the member list.
 */
const postMemberBody = z
  .object({
    email: z.string().trim().email().optional(),
    role: z.enum(ROLES),
    name: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.email || v.name), {
    message: 'an invite needs an email address or a name',
  });

teamRouter.post(
  '/members',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = postMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { role, name } = parsed.data;
    const normalizedEmail = parsed.data.email?.toLowerCase() ?? null;
    const displayName =
      name ?? (normalizedEmail ? nameFromEmail(normalizedEmail) || normalizedEmail : 'Invited');

    /*
      NO SEAT CHECK REFUSES HERE (U37, R79, R80).

      A pending invitation reserves nothing — creating one is not taking a seat,
      and an organisation may hold far more outstanding invitations than it has
      free seats. Refusing to ISSUE one on a full pool therefore blocked an
      action that costs nothing, and the seat is genuinely settled at acceptance,
      where the check holds the row lock.

      For the candidate pool the refusal is gone entirely: a full pool expands at
      acceptance rather than stranding whoever holds the link (R86). For the
      STAFF pool the seat is still finite and acceptance will still refuse, so
      the check is kept as a non-blocking WARNING — the dialog can say the pool
      is full without preventing an invitation somebody may well intend to send
      before freeing a seat.
    */
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, tenant.orgId),
    });
    let seatWarning: ReturnType<typeof seatLimitError> | null = null;
    if (org && poolFor(role) === 'staff') {
      const check = await checkSeatAvailability(db, org, role);
      if (!check.ok) seatWarning = seatLimitError(check, org.planTier);
    }

    // Duplicate check: already a member of this org. Only possible when an
    // address was given — a QR invite has nobody to match against yet.
    const candidates = normalizedEmail
      ? await db.query.users.findMany({
          where: sql`lower(${schema.users.email}) = ${normalizedEmail}`,
        })
      : [];
    if (candidates.length) {
      const existingMembership = await db.query.memberships.findFirst({
        where: and(
          inArray(
            schema.memberships.userId,
            candidates.map((u) => u.id),
          ),
          eq(schema.memberships.orgId, tenant.orgId),
        ),
      });
      if (existingMembership) {
        res.status(409).json({ error: 'already_member' });
        return;
      }
    }

    let invite;
    try {
      [invite] = await db
        .insert(schema.invites)
        .values({
          orgId: tenant.orgId,
          email: normalizedEmail,
          inviteeName: name ?? '',
          role,
          token: generateInviteToken(),
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'already_invited' });
        return;
      }
      throw err;
    }
    if (!invite) throw new Error('invite_failed: invite insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Invited member',
      target: normalizedEmail ?? displayName,
      category: 'team',
      icon: 'user-plus',
    });

    // Only attempt delivery when there is somewhere to deliver to. A QR invite
    // reports emailSent:false, which the UI already reads as "share the link".
    let emailSent = false;
    try {
      if (!invite.email) throw new Error('no_email_delivery');
      const [org, inviter] = await Promise.all([
        db.query.organizations.findFirst({ where: eq(schema.organizations.id, tenant.orgId) }),
        db.query.users.findFirst({ where: eq(schema.users.id, tenant.userId) }),
      ]);
      emailSent = await sendInviteEmail({
        to: invite.email!,
        orgName: org?.name ?? 'your team',
        inviterName: inviter?.name ?? 'A teammate',
        acceptUrl: `${env.WEB_ORIGIN}/invite/${invite.token}`,
      });
    } catch {
      emailSent = false;
    }

    res.status(201).json({
      id: invite.id,
      name: displayName,
      email: invite.email ?? '',
      role: invite.role,
      status: 'invited',
      emailSent,
      /**
       * The acceptance link, returned so the admin can print it as a QR or
       * hand it over directly. This is the invite's whole credential, which is
       * why only a team manager reaches this route at all.
       */
      acceptPath: `/invite/${invite.token}`,
      /**
       * Present only where the STAFF pool is full (R80). The invitation was
       * issued regardless — this tells the Admin that acceptance will be refused
       * until a seat frees, which is a thing to know rather than a thing to be
       * stopped by. The candidate pool never sets this: it expands instead.
       */
      ...(seatWarning ? { seatWarning } : {}),
    });
  }),
);

/**
 * Issue a one-time link that lets a member set their OWN password.
 *
 * Deliberately does NOT set a password. An admin who could choose a candidate's
 * password could sign in as them, and the same admins mark the assessments
 * those candidates sit — so a signed "satisfactory" would no longer prove the
 * candidate was ever there. The admin gets a link to hand over; the candidate
 * chooses the secret.
 */
teamRouter.post(
  '/members/:id/password-reset',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    // Scoped to a membership in the CALLER's org — the id is a membership id,
    // so an admin cannot raise a reset against a user in someone else's tenant.
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const [reset] = await db
      .insert(schema.passwordResets)
      .values({
        userId: membership.userId,
        orgId: tenant.orgId,
        token: generateInviteToken(),
        issuedByUserId: tenant.userId,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      })
      .returning();
    if (!reset) throw new Error('password_reset_failed: insert returned no row');

    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, membership.userId),
    });

    await recordAudit(db, tenant, {
      action: 'Issued password reset',
      target: user?.email ?? user?.name ?? membership.userId,
      category: 'team',
      icon: 'key-round',
    });

    res.status(201).json({
      resetPath: `/reset-password/${reset.token}`,
      expiresAt: reset.expiresAt.toISOString(),
      name: user?.name ?? '',
    });
  }),
);

/** Long enough to hand a printed code over on site, short enough to expire. */
const PASSWORD_RESET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Placement (R21, R22) — the same act for every member, whatever level ─────

const placementBody = z.object({
  locationIds: z.array(z.string().uuid()),
  departmentIds: z.array(z.string().uuid()),
  roleIds: z.array(z.string().uuid()),
});

teamRouter.get(
  '/members/:id/placement',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canViewTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(await readPlacement(db, membership.id));
  }),
);

teamRouter.put(
  '/members/:id/placement',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = placementBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const result = await writePlacement(db, tenant.orgId, membership.id, parsed.data);
    if (!result.ok) {
      res.status(400).json({ error: 'invalid_placement', code: result.error.code, subjectId: result.error.subjectId });
      return;
    }
    await recordAudit(db, tenant, {
      action: 'Placed member',
      target: membership.id,
      category: 'team',
      icon: 'map-pin',
    });
    // Placement is one of the four triggers that assign (U11, R47, R51):
    // changing the Roles a person holds gives them their new Roles' required
    // assessments, and the run is idempotent so no case is duplicated.
    await assignForMembership(db, tenant.orgId, membership.id);
    res.json(await readPlacement(db, membership.id));
  }),
);

const patchMemberBody = z.object({ role: z.enum(ROLES) });

teamRouter.patch(
  '/members/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = patchMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      const invite = await db.query.invites.findFirst({
        where: and(
          eq(schema.invites.id, req.params.id!),
          eq(schema.invites.orgId, tenant.orgId),
          isNull(schema.invites.acceptedAt),
        ),
      });
      if (!invite) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const nextInviteRole = parsed.data.role;

      /*
        NO SEAT CHECK ON A PENDING INVITATION (U37, R80).

        This check existed to stop "create a viewer invite, then PATCH it to
        candidate" walking around the creation-time check. That check is gone
        too, and for the same reason: a pending invitation reserves nothing, so
        neither one was guarding a seat. The seat is settled at acceptance, under
        the row lock, where a full candidate pool expands and a full staff pool
        refuses.
      */
      await db.update(schema.invites).set({ role: nextInviteRole }).where(eq(schema.invites.id, invite.id));
      if (invite.role !== nextInviteRole) {
        await recordAudit(db, tenant, {
          action: 'Changed role',
          target: `${invite.email}: ${invite.role} → ${nextInviteRole} (pending invite)`,
          category: 'team',
          icon: 'shield',
        });
      }
      res.json({
        id: invite.id,
        name: invite.inviteeName || nameFromEmail(invite.email ?? '') || invite.email || 'Pending invite',
        email: invite.email ?? '',
        role: nextInviteRole,
        status: 'invited',
      });
      return;
    }
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, membership.userId) });
    const previousRole = membership.role;
    const nextRole = parsed.data.role;

    // ── Seat limit check ──────────────────────────────────────────────────
    // A role change only consumes a seat when it CROSSES pools. Promoting an
    // operator who now runs their own inductions (candidate → assessor) moves
    // them out of the candidate pool and into the staff one, which is a new
    // staff seat; viewer → builder moves nobody and can never breach a limit,
    // so a full pool it is not joining must not refuse it. Crossing the other
    // way frees a seat and is always allowed.
    //
    // The member is not in the target pool yet, so the plain `used < limit`
    // asks the right question. A non-active membership is in NEITHER pool —
    // the count is of active rows — so re-roling a suspended member consumes
    // nothing and is not gated.
    //
    // Transaction and row lock for the same reason invite acceptance has
    // them: the count and the UPDATE it guards must be one indivisible step,
    // or two admins promoting two candidates at once both pass a count that
    // neither of them has changed yet. See lib/seats.ts.
    const consumesSeat = membership.status === 'active' && poolFor(previousRole) !== poolFor(nextRole);
    const outcome = await db.transaction(async (tx) => {
      let expansion: SeatExpansion | null = null;
      if (consumesSeat) {
        const org = await lockOrgForSeats(tx, tenant.orgId);
        if (org) {
          const check = await checkSeatAvailability(tx, org, nextRole);
          /*
            THE ONE CHECK IN THIS FILE THAT STAYS (U37, R81, R86). It guards a
            real seat: this membership is active, so the change moves a person
            between two pools that are both being counted.

            A full CANDIDATE pool now expands rather than refusing — moving
            somebody to Candidate takes a candidate seat and releases a staff
            one, and R81 says that goes through. A full staff pool still refuses,
            because no rule has been written for expanding it.

            The expansion happens INSIDE this transaction, holding the lock the
            count was taken under. Outside it, two admins promoting two people at
            once would each see a full pool and each buy a block.
          */
          const resolved = await seatOrExpand(tx, org, check);
          expansion = resolved.expansion;
          if (!check.ok && !expansion) return { refusal: seatLimitError(check, org.planTier) };
        }
      }
      await tx.update(schema.memberships).set({ role: nextRole }).where(eq(schema.memberships.id, membership.id));
      return { expansion };
    });
    if (outcome.refusal) {
      res.status(403).json(outcome.refusal);
      return;
    }
    if (outcome.expansion) {
      await recordExpansion(db, tenant, outcome.expansion, `access level changed to ${nextRole}`);
    }

    if (previousRole !== nextRole) {
      await recordAudit(db, tenant, {
        action: 'Changed role',
        target: `${user?.name ?? user?.email ?? 'Member'}: ${previousRole} → ${nextRole}`,
        category: 'team',
        icon: 'shield',
      });
    }

    res.json({ id: membership.id, name: user?.name ?? '', email: user?.email ?? '', role: nextRole, status: membership.status });
  }),
);

teamRouter.delete(
  '/members/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      const invite = await db.query.invites.findFirst({
        where: and(
          eq(schema.invites.id, req.params.id!),
          eq(schema.invites.orgId, tenant.orgId),
          isNull(schema.invites.acceptedAt),
        ),
      });
      if (!invite) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await db.delete(schema.invites).where(eq(schema.invites.id, invite.id));
      await recordAudit(db, tenant, {
        action: 'Revoked invite',
        target: invite.email ?? (invite.inviteeName || invite.id),
        category: 'team',
        icon: 'user-minus',
      });
      res.status(204).end();
      return;
    }
    if (membership.role === 'owner') {
      // Count only owners who can still act. A suspended owner cannot sign in
      // (R65), so counting them would let an org deactivate its one remaining
      // ACTIVE owner and lose all owner-level control — the guard must see the
      // same live set the front door does.
      const owners = await db.query.memberships.findMany({
        where: and(
          eq(schema.memberships.orgId, tenant.orgId),
          eq(schema.memberships.role, 'owner'),
          eq(schema.memberships.status, 'active'),
        ),
      });
      if (owners.length <= 1) {
        res.status(403).json({ error: 'cannot_remove_last_owner' });
        return;
      }
    }
    /*
      DEACTIVATION, NOT DELETION (R62, R63).

      This route used to `DELETE` the membership row, which took the person's
      placement with it on cascade and left the competency evidence that
      certified them pointing at a membership that no longer existed. R62 makes
      leaving a deactivation and R63 retains every record indefinitely and with
      no expiry — which is the whole reason a returning worker keeps
      competencies that are still in date (R69).

      What it ends instead is REACH: the live session, the front door, and an
      invitation they never accepted. See `lib/deactivation.ts`.
    */
    const outcome = await deactivateMember(db, tenant, membership);

    res.status(200).json(outcome);
  }),
);

teamRouter.get(
  '/permissions',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.rolePermissions.findMany({
      where: eq(schema.rolePermissions.orgId, tenant.orgId),
    });
    const stored = new Map(rows.map((r) => [r.role, r.matrix]));
    // Return EVERY access level (R28), falling back to the product default for
    // one the org never customised — so Assessor and Candidate show the
    // capabilities they already hold rather than reading as all-off, matching
    // what the enforcement side (permissions.ts matrixFor) resolves.
    const result: Partial<Record<Role, PermissionMatrix>> = {};
    for (const role of ROLES) {
      result[role] = stored.get(role) ?? DEFAULT_ROLE_PERMISSIONS[role];
    }
    res.json(result);
  }),
);

const patchPermissionsBody = z.object({
  role: z.enum(ROLES),
  category: z.enum(PERMISSION_CATEGORIES),
  action: z.enum(permissionActions),
  allowed: z.boolean().optional(),
});

teamRouter.patch(
  '/permissions',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = patchPermissionsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { role, category, action, allowed } = parsed.data;

    if (role !== 'owner') {
      const row = await db.query.rolePermissions.findFirst({
        where: and(eq(schema.rolePermissions.orgId, tenant.orgId), eq(schema.rolePermissions.role, role)),
      });
      // The matrix this change applies to: the stored one, or the product
      // default when the org never customised this level. Assessor and Candidate
      // are exactly the levels most likely to have no stored row, so without
      // this a toggle on either wrote nothing and returned 200 unchanged.
      const baseMatrix = row?.matrix ?? DEFAULT_ROLE_PERMISSIONS[role];

      // A scoped ('own') grant cannot be represented by this two-state control,
      // and the toggle below would read it as truthy and collapse it to `false`
      // — silently destroying the scope that keeps a candidate confined to their
      // own records. Refuse instead.
      if (baseMatrix[category]?.[action] === 'own') {
        res.status(409).json({
          error: 'scoped_permission',
          message: `${role}: ${category}.${action} is scoped to own records and cannot be toggled here.`,
        });
        return;
      }

      const nextAllowed = allowed ?? !(baseMatrix[category]?.[action] ?? false);
      const nextMatrix: PermissionMatrix = {
        ...baseMatrix,
        [category]: { ...baseMatrix[category], [action]: nextAllowed },
      };
      if (row) {
        await db
          .update(schema.rolePermissions)
          .set({ matrix: nextMatrix })
          .where(eq(schema.rolePermissions.id, row.id));
      } else {
        // Materialise the level's row from its default and insert (upsert), so
        // the write side and the read-side fallback in permissions.ts cannot
        // disagree.
        await db
          .insert(schema.rolePermissions)
          .values({ orgId: tenant.orgId, role, matrix: nextMatrix });
      }
      await recordAudit(db, tenant, {
        action: 'Updated permissions',
        target: `${role}: ${category}.${action} → ${nextAllowed ? 'allowed' : 'denied'}`,
        category: 'settings',
        icon: 'shield',
      });
    }

    const rows = await db.query.rolePermissions.findMany({
      where: eq(schema.rolePermissions.orgId, tenant.orgId),
    });
    const result: Partial<Record<Role, PermissionMatrix>> = {};
    for (const r of rows) result[r.role] = r.matrix;
    res.json(result);
  }),
);

/**
 * Bring a returner back (R68).
 *
 * Separate from the role PATCH because it is a different act: that one changes
 * what somebody may do, this one changes whether they are here at all. It
 * consumes a seat from the pool their access level draws on (R78) and proceeds
 * even where none is free — refusing a returning worker at the allocation
 * boundary would stop work on a site to settle a billing question, which is what
 * U37's automatic expansion exists to prevent.
 */
teamRouter.post(
  '/members/:id/reactivate',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await canManageTeam(tenant))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.id, req.params.id!), eq(schema.memberships.orgId, tenant.orgId)),
    });
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (membership.status === 'active') {
      // Idempotent rather than an error: a retried click is not a mistake.
      res.status(200).json({ needsFreshInvitation: false, seatConsumed: membership.role === 'candidate' ? 'candidate' : 'staff' });
      return;
    }

    /*
      R78 + R86: the returner takes a seat, and a full CANDIDATE pool buys a
      block rather than turning them away. Locked, because the count and the
      status write have to be one step — two reactivations arriving together
      against one free seat must buy one block between them, not two.

      A full STAFF pool still refuses: no rule has been written for expanding it,
      and quietly overrunning a finite allocation would be worse than saying so.
    */
    const seat = await db.transaction(async (tx) => {
      const org = await lockOrgForSeats(tx, tenant.orgId);
      if (org) {
        const check = await checkSeatAvailability(tx, org, membership.role as Role);
        const resolved = await seatOrExpand(tx, org, check);
        // Nothing has been written when this refuses — `seatOrExpand` writes
        // only where it expands — so returning here leaves the org untouched.
        if (!check.ok && !resolved.expansion) return { refusal: seatLimitError(check, org.planTier) };
        // The status write lives INSIDE the lock the count was taken under, so
        // the seat this returner just claimed is truly consumed before the lock
        // releases. Two returners racing one free seat must not both pass a
        // count neither has changed yet — the same reason the role PATCH above
        // writes inside its transaction. `reactivateMember` settles the rest.
        await tx.update(schema.memberships).set({ status: 'active' }).where(eq(schema.memberships.id, membership.id));
        return { expansion: resolved.expansion };
      }
      // No seat accounting configured: no gate, but the activation still lands.
      await tx.update(schema.memberships).set({ status: 'active' }).where(eq(schema.memberships.id, membership.id));
      return {};
    });
    if (seat.refusal) {
      res.status(403).json(seat.refusal);
      return;
    }

    const outcome = await reactivateMember(db, tenant, membership);
    if (seat.expansion) {
      await recordExpansion(db, tenant, seat.expansion, 'member reactivated');
    }
    res.status(200).json({
      ...outcome,
      ...(seat.expansion ? { seatsAdded: seat.expansion.seatsAdded } : {}),
    });
  }),
);
