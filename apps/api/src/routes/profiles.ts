import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  PROFILE_FIELDS,
  displayIdentityOf,
  indigenousStatusOf,
  profileField,
  validateProfileFields,
} from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { membershipForProfile, resolveProfileAccess } from '../lib/profile-access.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { recordAudit } from '../audit/record.js';
import { db } from '../db.js';

/**
 * A member's profile — the organisation's workforce record for that person
 * (R1, R2).
 *
 * THE FIRST ENFORCEMENT of the `profiles` permission category. It has shipped
 * and governed nothing; every read and write here resolves through
 * `resolveProfileAccess`, which is the single place the subject branch and the
 * matrix branch are told apart.
 *
 * SERVES EVERY MEMBER. An assessor's and an administrator's record is this one.
 * The only candidate-specific rules are the fixed own-record read and the three
 * writable fields, and both live in the resolution rather than here.
 *
 * The profile is addressed by MEMBERSHIP id, because R1 keys it there — one
 * person working for two customers has two, and only the one in this
 * organisation is reachable.
 */
export const profilesRouter: Router = Router();

/*
  The unreachable mark is Admin-only and is NOT resolved through the matrix.
  `profiles.edit` governs the record's fields; this is a note about the world
  beside the record, and an organisation that lets a Reviewer correct a surname
  has not thereby said a Reviewer may declare somebody uncontactable.
*/
function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

/** Every entered field, from the inventory — so the body shape cannot drift from the record. */
const enteredKeys = PROFILE_FIELDS.filter(
  (f) => f.storedOn === 'profile' && f.editableBy.length > 0,
).map((f) => f.key);

const profileBody = z.object(
  Object.fromEntries(enteredKeys.map((k) => [k, z.string().optional()])),
) as z.ZodType<Record<string, string | undefined>>;

/** Strip the keys nobody may write, then the keys THIS caller may not (R51, R53). */
function permittedWrites(
  body: Record<string, string | undefined>,
  editableFields: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (!editableFields.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The record as a reader sees it, assembled per grant (R44, R41).
 *
 * Each section resolves against its OWN grant rather than one `view`, which is
 * what lets an organisation restrict fields while leaving documents open — the
 * configuration R44 exists to allow, and one a single grant would render as a
 * blank page.
 */
function profileDto(
  profile: typeof schema.memberProfiles.$inferSelect,
  displayIdentifier: 'employee_number' | 'swipe_card_number',
) {
  const identity = displayIdentityOf(profile, displayIdentifier);
  return {
    membershipId: profile.membershipId,
    firstName: profile.firstName,
    middleName: profile.middleName,
    lastName: profile.lastName,
    /** Derived, never stored (R3, KTD19). */
    displayName: identity.displayName,
    identifier: identity.identifier,
    gender: profile.gender,
    ethnicity: profile.ethnicity,
    /** Derived from the ethnicity answer and entered by nobody (R15). */
    indigenousStatus: indigenousStatusOf(profile.ethnicity),
    dateOfBirth: profile.dateOfBirth,
    addressStreet: profile.addressStreet,
    suburb: profile.suburb,
    postcode: profile.postcode,
    mobile: profile.mobile,
    emergencyContactName: profile.emergencyContactName,
    emergencyContactPhone: profile.emergencyContactPhone,
    starterType: profile.starterType,
    employeeNumber: profile.employeeNumber,
    swipeCardNumber: profile.swipeCardNumber,
    inductionDate: profile.inductionDate,
    /*
      The address is still here beside the mark, because R16 requires a profile
      to carry an address rather than a working one. A reader sees both: the
      address on file, and that mail to it bounces.
    */
    emailUnreachableAt: profile.emailUnreachableAt?.toISOString() ?? null,
  };
}

// ── GET /profiles/:membershipId ────────────────────────────────────────────

profilesRouter.get(
  '/:membershipId',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const membership = await membershipForProfile(db, tenant.orgId, req.params.membershipId!);
    // Not-found rather than forbidden for a membership in another organisation,
    // so a probe cannot tell an existing record elsewhere from one that is absent.
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const access = await resolveProfileAccess(db, tenant, membership);
    if (!access.canView) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const [profile, org, user] = await Promise.all([
      db.query.memberProfiles.findFirst({
        where: eq(schema.memberProfiles.membershipId, membership.id),
      }),
      db.query.organizations.findFirst({ where: eq(schema.organizations.id, tenant.orgId) }),
      db.query.users.findFirst({ where: eq(schema.users.id, membership.userId) }),
    ]);
    if (!profile) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.json({
      profile: {
        ...profileDto(profile, org?.displayIdentifier ?? 'employee_number'),
        /*
          The inventory lists Email as a required field, but it is stored on
          `users` — unique product-wide and the person-record lookup key (R16),
          which is exactly why it is not on the profile row. Read from there so
          the record renders it rather than showing the field blank; it is not
          writable through this route, and `editableFields` already says so.
        */
        email: user?.email ?? null,
      },
      /*
        The PERSON behind the membership. Competency grants and assessment cases
        are recorded against the user, not the membership, so a screen showing
        both needs this — and deriving it client-side would mean a second lookup
        for something this call already holds.
      */
      userId: membership.userId,
      /*
        What this reader may do, so the screen renders the sections it is
        admitted to rather than guessing and 403ing on click.
      */
      access: {
        canViewDocuments: access.canViewDocuments,
        canViewCompetencies: access.canViewCompetencies,
        canApprove: access.canApprove,
        editableFields: access.editableFields,
        isSubject: access.isSubject,
      },
    });
  }),
);

// ── POST /profiles/:membershipId ───────────────────────────────────────────

profilesRouter.post(
  '/:membershipId',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const membership = await membershipForProfile(db, tenant.orgId, req.params.membershipId!);
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const access = await resolveProfileAccess(db, tenant, membership);
    // Creating a record is an edit grant; the subject never creates their own.
    if (access.isSubject || access.editableFields.length === 0) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const parsed = profileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error' });
      return;
    }
    const values = permittedWrites(parsed.data, access.editableFields);

    // R12/R13/R14: required presence and the closed option sets, from the one
    // inventory the screen renders from.
    const validation = validateProfileFields(values);
    if (!validation.ok) {
      res.status(400).json({ error: 'validation_error', failures: validation.failures });
      return;
    }

    try {
      const [created] = await db
        .insert(schema.memberProfiles)
        .values({ orgId: tenant.orgId, membershipId: membership.id, ...values } as never)
        .returning();
      await recordAudit(db, tenant, {
        action: 'Created profile',
        target: membership.id,
        category: 'profiles',
        icon: 'user',
      });
      res.status(201).json({ membershipId: created!.membershipId });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Either a second profile for this membership (R1) or a workforce
        // number already issued in the organisation (R7).
        res.status(409).json({ error: 'conflict' });
        return;
      }
      throw err;
    }
  }),
);

// ── PATCH /profiles/:membershipId ──────────────────────────────────────────

profilesRouter.patch(
  '/:membershipId',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const membership = await membershipForProfile(db, tenant.orgId, req.params.membershipId!);
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const access = await resolveProfileAccess(db, tenant, membership);
    if (access.editableFields.length === 0) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const parsed = profileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error' });
      return;
    }
    /*
      Silently DROPS the fields this caller may not write rather than refusing
      the request. A candidate submitting the whole form saves their three and
      leaves the rest alone (R51) — refusing outright would make the fixed
      protection read as a broken form.
    */
    const values = permittedWrites(parsed.data, access.editableFields);
    if (Object.keys(values).length === 0) {
      res.status(400).json({ error: 'nothing_to_update' });
      return;
    }

    const existing = await db.query.memberProfiles.findFirst({
      where: eq(schema.memberProfiles.membershipId, membership.id),
    });
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const merged = { ...existing, ...values } as Record<string, unknown>;
    const validation = validateProfileFields(merged);
    if (!validation.ok) {
      res.status(400).json({ error: 'validation_error', failures: validation.failures });
      return;
    }

    try {
      await db
        .update(schema.memberProfiles)
        .set({ ...values, updatedAt: new Date() } as never)
        .where(eq(schema.memberProfiles.membershipId, membership.id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'conflict' });
        return;
      }
      throw err;
    }

    /*
      R57: one entry PER CHANGED FIELD, carrying the old and the new value and
      naming the field. One entry per field rather than per request is what makes
      R58's filter expressible — a single entry covering a date of birth and a
      mobile number would have to be hidden or shown whole.
    */
    for (const [key, next] of Object.entries(values)) {
      const before = (existing as Record<string, unknown>)[key];
      if (String(before ?? '') === String(next)) continue;
      await recordAudit(db, tenant, {
        action: `Changed ${profileField(key)?.label ?? key}`,
        target: `${membership.id}: ${String(before ?? '')} → ${next}`,
        category: 'profiles',
        field: key,
        icon: 'user',
      });
    }

    res.json({ membershipId: membership.id });
  }),
);

// ── PUT /profiles/:membershipId/unreachable ────────────────────────────────

const unreachableBody = z.object({ unreachable: z.boolean() });

/**
 * Mark the member's address as reaching nobody, or clear that mark (R16).
 *
 * Its OWN route rather than a field on the PATCH above, because it is not an
 * edit to the record: the address is untouched, the profile stays valid and
 * nothing goes outstanding on it. It is a note about the world beside the
 * record — mail to this person bounces — and it is Admin-only, whereas the
 * PATCH is open to a candidate for three of their own fields.
 *
 * Idempotent in both directions. An Admin who marks an already-marked address
 * has not made a mistake, and re-stamping the date would misreport when the
 * bouncing was discovered.
 */
profilesRouter.put(
  '/:membershipId/unreachable',
  requireTenant,
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
    const membership = await membershipForProfile(db, tenant.orgId, req.params.membershipId!);
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const parsed = unreachableBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error' });
      return;
    }

    const existing = await db.query.memberProfiles.findFirst({
      where: eq(schema.memberProfiles.membershipId, membership.id),
    });
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const wasMarked = Boolean(existing.emailUnreachableAt);
    const { unreachable } = parsed.data;
    if (wasMarked === unreachable) {
      // Already where the caller is asking for. Nothing written, nothing
      // audited — an audit trail of no-ops is noise over the entries that matter.
      res.json({ membershipId: membership.id, unreachable });
      return;
    }

    await db
      .update(schema.memberProfiles)
      .set({
        emailUnreachableAt: unreachable ? new Date() : null,
        emailUnreachableBy: unreachable ? tenant.userId : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.memberProfiles.membershipId, membership.id));

    await recordAudit(db, tenant, {
      action: unreachable ? 'Marked address unreachable' : 'Cleared unreachable address',
      target: membership.id,
      category: 'profiles',
      /*
        No `field`: this is not a change to an inventory field, so R58's
        sensitivity filter has nothing to compare it against. It also names no
        value — the address is not repeated into the entry, which keeps the mark
        readable by anyone who may read the audit without exposing the address
        itself.
      */
      icon: 'mail-x',
    });

    res.json({ membershipId: membership.id, unreachable });
  }),
);

/** The membership the caller is the subject of, for their own-record read (R49). */
profilesRouter.get(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const membership = await db.query.memberships.findFirst({
      where: and(eq(schema.memberships.orgId, tenant.orgId), eq(schema.memberships.userId, tenant.userId)),
    });
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ membershipId: membership.id });
  }),
);
