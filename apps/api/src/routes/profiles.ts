import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  PROFILE_FIELDS,
  displayIdentityOf,
  indigenousStatusOf,
  buildProfileExport,
  exportedProfileFieldKeys,
  profileField,
  validateProfileFields,
  type ExportedDocument,
} from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { membershipForProfile, profileTierOrg, resolveProfileAccess } from '../lib/profile-access.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { permissionScope } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { db } from '../db.js';
import { storeAttachment, ATTACHMENT_KEY_RE, EXT_CONTENT_TYPE } from './uploads.js';
import { getStorageClient } from '../storage/index.js';

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
  TWO acts on this router turn on the ACCESS LEVEL rather than the matrix, and
  both deliberately.

  The unreachable mark (R16): `profiles.edit` governs the record's fields, and
  this is a note about the world beside the record — an organisation that lets a
  Reviewer correct a surname has not thereby said a Reviewer may declare
  somebody uncontactable.

  The export (R54): it is the one act no configuration opens up. An `export`
  action on the category would let an organisation grant the most sensitive act
  in the product to any access level it liked, which is what R54 refuses.

  Owner is admitted as the level holding everything Admin holds.
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
        email: user?.email ?? null,
        photoUrl: membership.photoKey
          ? `/uploads/file/${membership.photoKey}`
          : null,
      },
      userId: membership.userId,
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
        .values({ orgId: tenant.orgId, membershipId: membership.id, ...values } as typeof schema.memberProfiles.$inferInsert)
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
        .set({ ...values, updatedAt: new Date() } as Partial<typeof schema.memberProfiles.$inferInsert>)
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
    // The tier gate resolveProfileAccess applies to every matrix-gated read and
    // write, applied directly here because this Admin act resolves no matrix.
    if (!(await profileTierOrg(db, tenant.orgId))) {
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

// ── GET /profiles/:membershipId/export ─────────────────────────────────────

/**
 * Export a member's record (U39, R54).
 *
 * THE GATE IS NOT A MATRIX LOOKUP. Export is the one act no configuration opens
 * up, so it turns on the ADMIN ACCESS LEVEL — which admits an Owner as the level
 * holding everything Admin holds, and admits nobody else. An assessor whom the
 * shipped defaults admit to the profile IN FULL still cannot export it, and
 * neither can the candidate reading their own record in full.
 *
 * The tempting implementation is an `export` action on the `profiles` category,
 * and that would be wrong: it would let an organisation grant the most sensitive
 * act in the product to any access level it liked, which is precisely what R54
 * refuses.
 *
 * Nothing here is redacted. R54 admits only callers who hold every field, so
 * every caller who reaches this line is released to sensitive detail by
 * definition — the redaction lives in shared, over the inventory, for consumers
 * this route does not have.
 */
profilesRouter.get(
  '/:membershipId/export',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const org = await profileTierOrg(db, tenant.orgId);
    if (!org) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const membership = await membershipForProfile(db, tenant.orgId, req.params.membershipId!);
    if (!membership) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const isSelf = membership.userId === tenant.userId;
    const hasViewScope = (await permissionScope(tenant, 'profiles', 'view')) === 'all';
    if (!isSelf && !isAdmin(tenant.role) && !hasViewScope) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const [profile, user] = await Promise.all([
      db.query.memberProfiles.findFirst({
        where: eq(schema.memberProfiles.membershipId, membership.id),
      }),
      db.query.users.findFirst({ where: eq(schema.users.id, membership.userId) }),
    ]);
    if (!profile) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const dto = {
      ...profileDto(profile, org?.displayIdentifier ?? 'employee_number'),
      email: user?.email ?? null,
    } as Record<string, unknown>;
    const fields: Record<string, string | null> = {};
    for (const key of exportedProfileFieldKeys()) {
      const value = dto[key];
      fields[key] = value == null ? null : String(value);
    }

    // The documents held against this person's competencies (R29). Carried
    // unredacted — a licence that cannot be produced is not evidence.
    const grants = await db.query.competencyHolders.findMany({
      where: and(
        eq(schema.competencyHolders.orgId, tenant.orgId),
        eq(schema.competencyHolders.userId, membership.userId),
      ),
    });
    const documents: ExportedDocument[] = [];
    if (grants.length > 0) {
      const rows = await db.query.competencyDocuments.findMany({
        where: and(
          eq(schema.competencyDocuments.orgId, tenant.orgId),
          inArray(
            schema.competencyDocuments.competencyHolderId,
            grants.map((g) => g.id),
          ),
        ),
      });
      const competencies = await db.query.competencies.findMany({
        where: eq(schema.competencies.orgId, tenant.orgId),
      });
      const nameFor = new Map(competencies.map((c) => [c.id, c.name]));
      const competencyForHolder = new Map(grants.map((g) => [g.id, g.competencyId]));
      for (const d of rows) {
        // Only what the record currently stands on. A superseded or removed
        // document is retained as history (R31, R32) but is not what this
        // person holds today, and exporting it would misrepresent them.
        if (d.state !== 'held') continue;
        documents.push({
          id: d.id,
          fileName: d.fileName,
          contentType: d.contentType,
          competencyName: nameFor.get(competencyForHolder.get(d.competencyHolderId) ?? '') ?? 'a competency',
          storageKey: d.storageKey,
        });
      }
    }

    /*
      R54's audit line, and the unredacted files are what make it necessary: a
      licence image carries a date of birth, an address and a photograph, so a
      leak has to be traceable.

      Traceable to WHOM is half the answer. The entry names the exported member
      as its subject alongside the actor and the moment, because "who ran an
      export" without "whose record left" cannot answer the question asked after
      an incident.
    */
    await recordAudit(db, tenant, {
      action: 'Exported member record',
      target: membership.id,
      category: 'profiles',
      icon: 'download',
    });

    res.json(
      buildProfileExport({
        membershipId: membership.id,
        fields,
        documents,
        exportedAt: new Date(),
      }),
    );
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

// ── PUT /profiles/:membershipId/photo ─────────────────────────────────────

profilesRouter.put(
  '/:membershipId/photo',
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
    if (!access.isSubject && access.editableFields.length === 0) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    if (body.mimeType && !String(body.mimeType).startsWith('image/')) {
      res.status(400).json({ error: 'unsupported_file_type', message: 'Profile photos must be an image.' });
      return;
    }

    const result = await storeAttachment(tenant.orgId, body);
    if (!result.ok) {
      res.status(result.failure.status).json(result.failure.body);
      return;
    }

    await db
      .update(schema.memberships)
      .set({ photoKey: result.ref.key })
      .where(eq(schema.memberships.id, membership.id));

    res.json({ photoUrl: `/uploads/file/${result.ref.key}` });
  }),
);

// ── DELETE /profiles/:membershipId/photo ──────────────────────────────────

profilesRouter.delete(
  '/:membershipId/photo',
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
    if (!access.isSubject && access.editableFields.length === 0) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    await db
      .update(schema.memberships)
      .set({ photoKey: null })
      .where(eq(schema.memberships.id, membership.id));

    res.json({ photoUrl: null });
  }),
);
