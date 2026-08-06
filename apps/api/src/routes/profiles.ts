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

    const [profile, org] = await Promise.all([
      db.query.memberProfiles.findFirst({
        where: eq(schema.memberProfiles.membershipId, membership.id),
      }),
      db.query.organizations.findFirst({ where: eq(schema.organizations.id, tenant.orgId) }),
    ]);
    if (!profile) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.json({
      profile: profileDto(profile, org?.displayIdentifier ?? 'employee_number'),
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
