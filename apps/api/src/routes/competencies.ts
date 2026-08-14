import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { competencyCurrency, countsAsHeld, expiryNote, expiryOf, standingOf } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { findOwnedCompetency, grantCompetency, syncHolderCount } from '../lib/competency-grant.js';
import {
  competencyDto,
  competencyValidityFields,
  createCompetency,
  createCompetencyBody,
  optionalCompetencyCode,
} from '../lib/competency-create.js';
import {
  recommendedCompetencyIdsByUser,
  recommendedCompetencyIdsFor,
  requiredCompetencyIdsByUser,
  requiredCompetencyIdsFor,
} from '../lib/standing.js';
import { awardingToolByCompetency } from '../lib/requirement-links.js';
import { permissionScope } from '../lib/permissions.js';
import { db } from '../db.js';

/**
 * Competencies, who holds them, and the rules gating a form section behind one.
 * All routes are gated behind the `competencyGating` plan feature (Business and
 * Enterprise) — it moved down from Enterprise-only when multi-part assessments
 * shipped, because assessor eligibility per tool reads these records.
 */
export const competenciesRouter: Router = Router();
export const competencyRulesRouter: Router = Router();

/*
  WHO MAY WRITE THE REGISTER (KTD8). Competencies stopped being a private
  gating list the round Role requirements started pointing at them: a rename
  now relabels every Role that requires it, and a delete would cascade through
  the links table. So creation and editing take the assessments-edit tier —
  owner/admin/assessor, the same population that authors assessments and works
  the register — and NOT the builder/reviewer/viewer/candidate tiers, whose
  form-side permissions never implied authority over the competency taxonomy.
  Note this is the access-level ROLE on the membership, not the permission
  matrix: DEFAULT_ROLE_PERMISSIONS gates profile reads, not taxonomy writes.
*/
function canAuthorCompetencies(role: string): boolean {
  return role === 'owner' || role === 'admin' || role === 'assessor';
}

/** DELETE is narrower still (KTD8): destroying a register entry is admin work. */
function isAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

competenciesRouter.get(
  '/',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.competencies.findMany({
      where: eq(schema.competencies.orgId, tenant.orgId),
      orderBy: (c, { desc }) => [desc(c.createdAt)],
    });
    res.json(
      rows.map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code,
        holders: c.holders,
        // Null on both means this qualification never expires — the state every
        // competency starts in, and what an admin reviews to change.
        validForMonths: c.validForMonths,
        gracePeriodDays: c.gracePeriodDays,
      })),
    );
  }),
);

/**
 * The caller's OWN recommended competencies (U7 — R12, R14, KTD6).
 *
 * SELF-SCOPE, like the training-request POST it feeds: the subject is always
 * the caller, so no matrix check applies and no role is refused the read — a
 * candidate seeing what their Roles recommend is the entire point (R12).
 *
 * REGISTERED AHEAD OF THE PARAMETERISED SIBLINGS deliberately. Express matches
 * in registration order, and although no bare `GET /:id` exists today, one
 * added later would swallow `/recommended` as an id — this ordering makes the
 * route immune to that regression rather than dependent on nobody adding one.
 *
 * Each row resolves `requestableToolId` through the KTD2 resolver — the SAME
 * resolution assignment and compliance use, so the tool this offers to request
 * is exactly the tool an approval would assign. Null means evidence-only (R7):
 * nothing bookable awards it, so there is nothing to self-start.
 *
 * `selfStartEnabled` rides the payload because the affordance needs BOTH facts
 * (toggle ON and a requestable tool, R14/AE5) and the org toggle lives on a
 * surface a candidate has no other read for.
 */
competenciesRouter.get(
  '/recommended',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const [org, recommended] = await Promise.all([
      db.query.organizations.findFirst({ where: eq(schema.organizations.id, tenant.orgId) }),
      // Non-withdrawn roles only — heldRolesByUser filters withdrawn rows (R52).
      recommendedCompetencyIdsFor(db, tenant.orgId, tenant.userId),
    ]);
    const selfStartEnabled = org?.candidateSelfStartRecommended ?? false;
    if (recommended.size === 0) {
      res.json({ selfStartEnabled, items: [] });
      return;
    }

    const ids = [...recommended];
    const [rows, grants, awarding] = await Promise.all([
      db.query.competencies.findMany({
        where: and(eq(schema.competencies.orgId, tenant.orgId), inArray(schema.competencies.id, ids)),
      }),
      // The caller's live grants of these — revoked confers nothing (R107).
      db.query.competencyHolders.findMany({
        where: and(
          eq(schema.competencyHolders.orgId, tenant.orgId),
          eq(schema.competencyHolders.userId, tenant.userId),
          inArray(schema.competencyHolders.competencyId, ids),
          isNull(schema.competencyHolders.revokedAt),
        ),
      }),
      awardingToolByCompetency(db, tenant.orgId, ids),
    ]);
    const competencyById = new Map(rows.map((c) => [c.id, c]));
    const grantsByCompetency = new Map<string, (typeof grants)[number][]>();
    for (const g of grants) {
      const list = grantsByCompetency.get(g.competencyId) ?? [];
      list.push(g);
      grantsByCompetency.set(g.competencyId, list);
    }

    // One instant for the whole response; the candidate window, because this
    // is someone reading their own record (same posture as /held).
    const now = new Date();
    const items = ids
      .flatMap((competencyId) => {
        const competency = competencyById.get(competencyId);
        // A recommendation of a competency the org no longer defines has
        // nothing to show and nothing to request — dropped rather than named
        // by raw id.
        if (!competency) return [];
        const held = (grantsByCompetency.get(competencyId) ?? []).some((g) =>
          countsAsHeld(competencyCurrency(g, competency, now, 'candidate')),
        );
        return [
          {
            competencyId,
            name: competency.name,
            code: competency.code,
            held,
            requestableToolId: awarding.get(competencyId) ?? null,
          },
        ];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ selfStartEnabled, items });
  }),
);

/*
  `createCompetencyBody`, the validity bounds, and the insert itself live in
  lib/competency-create.ts — the bulk seeder writes through the same schema and
  the same defaults rather than hand-rolling an insert that would bypass them.
*/

/** Everything on a competency an admin may change after creating it. */
const updateCompetencyBody = z.object({
  name: z.string().min(1).optional(),
  /*
    Optional in two senses, and both are needed. Omitting `code` leaves it
    alone; sending it blank or null CLEARS it, which is how a competency wrongly
    given an invented code gets corrected. `optionalCompetencyCode` folds blank
    to null so the cleared state has one spelling.

    `.optional()` on the outside is what keeps "not sent" distinguishable from
    "sent empty" — without it every PATCH would silently wipe the code.
  */
  code: optionalCompetencyCode.optional(),
  ...competencyValidityFields,
});

competenciesRouter.post(
  '/',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!canAuthorCompetencies(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = createCompetencyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await createCompetency(db, tenant.orgId, parsed.data);
    res.status(201).json(competencyDto(row));
  }),
);

/**
 * Change a competency — including how long it stays valid.
 *
 * This is the route that makes expiry real. Every qualification starts with no
 * validity and therefore never expires; setting one here applies IMMEDIATELY to
 * every existing grant of it, because expiry is derived from each grant's own
 * date rather than frozen when it was made. So an admin setting "36 months" on
 * ATO - Track Dozer instantly gives every holder a real expiry counted from
 * when they actually earned it — which is what reviewing the backlog means.
 *
 * Clearing it back to null makes the qualification perpetual again and un-lapses
 * everyone. That is a real action an admin might need, so it is expressible.
 */
competenciesRouter.patch(
  '/:id',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!canAuthorCompetencies(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = updateCompetencyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const existing = await findOwnedCompetency(db, req.params.id!, tenant.orgId);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Only what was SENT. `undefined` leaves a column alone; an explicit null
    // clears it, which is how "this no longer expires" is expressed.
    const patch: Record<string, unknown> = {};
    for (const key of ['name', 'code', 'validForMonths', 'gracePeriodDays'] as const) {
      if (parsed.data[key] !== undefined) patch[key] = parsed.data[key];
    }
    if (Object.keys(patch).length > 0) {
      await db.update(schema.competencies).set(patch).where(eq(schema.competencies.id, existing.id));
    }

    // The row as it now stands. No re-select: nothing on this table is computed
    // by the database, so the loaded row plus the patch just applied IS the new
    // row, and a second query would only be a slower way to learn that.
    const row = { ...existing, ...patch } as typeof existing;

    await recordAudit(db, tenant, {
      action: 'Updated competency',
      // Named by code where there is one, by name where there is not — an audit
      // line reading "null: code" identifies nothing.
      target: `${row.code ?? row.name}: ${Object.keys(patch).join(', ') || 'no change'}`,
      category: 'settings',
      icon: 'award',
    });

    res.json(competencyDto(row));
  }),
);

/**
 * Delete a competency — an EXPLICIT act with a dependency check, never a
 * cascade surprise (KTD8).
 *
 * The links table's competency FK cascades, so an unchecked delete would
 * silently strip a requirement from every Role naming it, disarm every tool
 * awarding it, and orphan every live grant of it. This route makes that
 * impossible to do by accident: it 409s while anything depends on the row,
 * NAMING each dependency kind so the admin knows exactly what to un-require
 * first. Force-delete is deliberately not offered — un-requiring is the exit.
 */
competenciesRouter.delete(
  '/:id',
  requireTenant,
  requirePlanFeature('competencyGating'),
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
    const row = await db.query.competencies.findFirst({
      where: and(eq(schema.competencies.id, req.params.id!), eq(schema.competencies.orgId, tenant.orgId)),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    /*
      THE CHECK AND THE DELETE SHARE ONE SNAPSHOT (KTD8). Run as separate
      statements, the dependency reads and the delete leave a window in which a
      Role can start requiring this competency — and the FK cascade the check
      exists to make unreachable fires anyway, stripping a requirement nobody
      was warned about. One transaction at REPEATABLE READ pins the reads and
      the delete to the same view of the world; a dependency created inside the
      window makes the delete conflict rather than silently cascade.

      The three reads are SEQUENTIAL, not `Promise.all`: a transaction is one
      pinned connection and serves one query at a time.
    */
    const verdict = await db.transaction(
      async (tx) => {
        // Both tiers in one read, split below — a recommendation is a real
        // dependency too (a Role's editor would show a dangling entry).
        const links = await tx.query.roleRequiredCompetencies.findMany({
          where: and(
            eq(schema.roleRequiredCompetencies.orgId, tenant.orgId),
            eq(schema.roleRequiredCompetencies.competencyId, row.id),
          ),
        });
        // `awardedCompetencyIds` is jsonb with no FK, so containment is
        // filtered in JS — the same way every award read in this codebase
        // treats it.
        const orgTools = await tx.query.assessmentTools.findMany({
          where: eq(schema.assessmentTools.orgId, tenant.orgId),
        });
        // Live grants only: a revoked grant is audit history, not a dependency
        // — it confers nothing and must not block a tidy-up forever.
        const liveGrants = await tx.query.competencyHolders.findMany({
          where: and(
            eq(schema.competencyHolders.competencyId, row.id),
            eq(schema.competencyHolders.orgId, tenant.orgId),
            isNull(schema.competencyHolders.revokedAt),
          ),
        });

        const roles = links.filter((l) => l.tier === 'required').length;
        const recommendedBy = links.filter((l) => l.tier === 'recommended').length;
        const tools = orgTools.filter((t) => (t.awardedCompetencyIds ?? []).includes(row.id)).length;
        const grants = liveGrants.length;
        if (roles + recommendedBy + tools + grants > 0) {
          return { deleted: false as const, roles, recommendedBy, tools, grants };
        }
        await tx.delete(schema.competencies).where(eq(schema.competencies.id, row.id));
        return { deleted: true as const };
      },
      { isolationLevel: 'repeatable read' },
    );
    if (!verdict.deleted) {
      // Counts, not ids: enough to say WHAT stands in the way and how much,
      // without this error payload becoming a second register read.
      const { roles, recommendedBy, tools, grants } = verdict;
      res.status(409).json({ error: 'competency_in_use', roles, recommendedBy, tools, grants });
      return;
    }

    await recordAudit(db, tenant, {
      action: 'Deleted competency',
      target: row.code ?? row.name,
      category: 'settings',
      icon: 'award',
    });
    res.status(204).end();
  }),
);

/*
  `syncHolderCount` and `findOwnedCompetency` moved to lib/competency-grant.ts
  when the signed-off assessment became a second granter. They were
  module-private here, and a second copy over there is exactly how the
  denormalised `holders` count drifts out of agreement with its own join table.
*/

const grantBody = z.object({
  userId: z.string().uuid(),
  evidenceRef: z.string().max(200).optional(),
  /*
    A LICENCE IS RECORDED HERE, not as profile fields (R33, R34). Class and
    number on the grant, its expiry as `expiresAt`, its document as a
    `competency_documents` row — which is what gives it expiry, grace periods,
    revocation and a place in every prerequisite check for free (R35, R36).
    Absent on an ordinary competency.
  */
  licenceClass: z.string().max(20).optional(),
  licenceNumber: z.string().max(60).optional(),
  /** An explicit end date, for a licence whose expiry does not follow the qualification's validity. */
  expiresAt: z.string().datetime().optional(),
});

/**
 * Why a competency was taken away. Optional because a DELETE may carry no body
 * at all — an existing caller sending nothing must keep working — but stored
 * either way, since the revocation itself outlives the person who did it.
 */
const revokeBody = z.object({
  reason: z.string().max(500).optional(),
});

/** Grant a competency to a person. Idempotent — re-granting is a no-op. */
competenciesRouter.post(
  '/:id/holders',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    /*
      THE SAME GATE THE DEFINITION CARRIES (KTD8), and for a sharper reason.
      Authoring a competency only describes a ticket; HOLDING one is what
      `standingOf` reads and what closes a role's required gap (R5, R10), so an
      ungated grant let any member self-certify into compliance — the register
      would say the Dozer operator holds their licence because they said so.
      Owner/admin/assessor only, matching POST '/' and PATCH '/:id' above.

      The two automatic grants are unaffected: sign-off and the workforce
      import call `grantCompetency` in lib directly and never pass through
      this route.
    */
    if (!canAuthorCompetencies(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = grantBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }

    /*
      One implementation, shared with the automatic grant a signed-off
      assessment performs. Two copies is how `holders` drifts: it is a
      denormalised count and the only holder figure any screen shows, so a
      writer that forgot to resync it would leave the register disagreeing with
      itself, silently.

      This is now an UPSERT. The old body guarded with `if (!existing)` and did
      nothing when a row was already present, so a re-grant discarded the new
      evidenceRef and the surviving row kept pointing at whatever earned it
      first — with no room for a second row, since (competencyId, userId) is
      unique.
    */
    const result = await grantCompetency(db, tenant, {
      competencyId: req.params.id!,
      userId: parsed.data.userId,
      evidenceRef: parsed.data.evidenceRef ?? null,
      licenceClass: parsed.data.licenceClass ?? null,
      licenceNumber: parsed.data.licenceNumber ?? null,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    });
    if (!result.ok) {
      // Kept distinct: an admin granting by hand needs to know whether they
      // picked the wrong competency or the wrong person.
      res.status(404).json({ error: result.reason === 'user_not_in_org' ? 'user_not_in_org' : 'not_found' });
      return;
    }

    res
      .status(result.outcome.created ? 201 : 200)
      .json({ competencyId: result.outcome.competencyId, holders: result.outcome.holders });
  }),
);

/**
 * Revoke a competency from a person — WITHOUT ERASING THE RECORD.
 *
 * THIS USED TO HARD-DELETE THE ROW, and that contradicted every other
 * revocation in this codebase. `revokeGrantsFromCase` sets `revokedAt` and
 * keeps the row; the schema says so at the column: "A hard delete would leave
 * the register silently disagreeing with the audit log." So an appeal-driven
 * revocation preserved the record while an admin clicking revoke destroyed it —
 * two paths disagreeing about the same act, with the audit entry left pointing
 * at a row that no longer existed.
 *
 * Something that WAS true has to stay visible to the audit conversation about
 * it. The row survives, stops conferring anything (every eligibility read
 * filters `revokedAt IS NULL`, including the count), and can be re-granted:
 * `grantCompetency` upserts and clears the revocation, which is what
 * requalifying after an overturned result looks like.
 *
 * Still DELETE rather than PATCH — it is the destructive verb from the caller's
 * point of view, and the URL is unchanged.
 */
competenciesRouter.delete(
  '/:id/holders/:userId',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    // Same authority as granting: taking a ticket away moves someone OUT of
    // compliance, so it belongs to the same owner/admin/assessor population.
    if (!canAuthorCompetencies(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = revokeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const competency = await findOwnedCompetency(db, req.params.id!, tenant.orgId);
    if (!competency) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    await db
      .update(schema.competencyHolders)
      .set({
        revokedAt: new Date(),
        // Never null: a revocation with no stated reason is the one an auditor
        // most wants explained, so the default says at least how it happened.
        revokedReason: parsed.data.reason ?? 'Revoked by an administrator',
      })
      .where(
        and(
          eq(schema.competencyHolders.competencyId, competency.id),
          eq(schema.competencyHolders.userId, req.params.userId!),
          // Already-revoked rows are left alone: re-revoking would overwrite
          // the date and reason of the revocation that actually happened.
          isNull(schema.competencyHolders.revokedAt),
        ),
      );
    await recordAudit(db, tenant, {
      action: 'Revoked competency',
      target: `${competency.code ?? competency.name} → ${req.params.userId}`,
      category: 'settings',
      icon: 'award',
    });

    const holders = await syncHolderCount(db, competency.id);
    res.json({ competencyId: competency.id, holders });
  }),
);

/**
 * Who holds one competency, and whether each of them is still current.
 *
 * The inverse of `/held/:userId`, and the question an admin actually asks:
 * `competencies.holders` can say "12 people hold this" but never which twelve,
 * and — being a stored count of grants — it cannot say how many are still in
 * date. Nothing surfaced that until this route: an admin could set a validity
 * and then had no way to see who it had just lapsed.
 *
 * Always the ASSESSOR window (90 days). Everyone reading this is looking at
 * other people's records to plan reassessments; the 30-day candidate window is
 * for someone reading their own, which this route is not.
 *
 * Revoked grants are excluded. They are kept for the audit trail and confer
 * nothing, so listing them here would pad the register with people who are not
 * holders.
 */
competenciesRouter.get(
  '/:id/holders',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const competency = await findOwnedCompetency(db, req.params.id!, tenant.orgId);
    if (!competency) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // A revoked grant is KEPT and shown, marked — an admin auditing this
    // competency wants to see it was taken away, not have the holder vanish
    // (R108, "renders revocation as a mark"). The eligibility lookup at
    // `/held/:userId` is the one that filters it out; the register does not.
    const rows = await db.query.competencyHolders.findMany({
      where: and(
        eq(schema.competencyHolders.competencyId, competency.id),
        eq(schema.competencyHolders.orgId, tenant.orgId),
      ),
    });
    if (rows.length === 0) {
      res.json([]);
      return;
    }

    /*
      One query for every holder's identity rather than one per row. This list
      is people × one competency, so a per-row lookup would issue a query per
      holder on a screen whose whole purpose is showing all of them at once.
    */
    const holderUserIds = rows.map((r) => r.userId);
    const users = await db.query.users.findMany({
      where: inArray(schema.users.id, holderUserIds),
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    // A licence number is sensitive profile data (R34), gated by the same
    // `profiles.view_competencies` grant the profile surface uses — it must not
    // leak through this register just because a member can see who holds what.
    // A holder still sees their own licence on their own row.
    const licenceScope = await permissionScope(tenant, 'profiles', 'view_competencies');
    const canSeeLicence = (holderUserId: string) =>
      licenceScope === 'all' || holderUserId === tenant.userId;

    // Standing per holder: is THIS competency one their held Roles require —
    // or merely recommend (R108, R12)? Batched into one query path rather than
    // per holder; the recommended set rides beside the required one because
    // standingOf demands both (KTD7).
    const [requiredByUser, recommendedByUser] = await Promise.all([
      requiredCompetencyIdsByUser(db, tenant.orgId, holderUserIds),
      recommendedCompetencyIdsByUser(db, tenant.orgId, holderUserIds),
    ]);

    // One instant for the whole response, so two holders cannot disagree about
    // what "today" is and sort inconsistently.
    const now = new Date();
    const holders = rows.map((r) => {
      const currency = competencyCurrency(r, competency, now, 'assessor');
      const expiry = expiryOf(r, competency);
      const user = userById.get(r.userId);
      return {
        userId: r.userId,
        // A grant can outlive the user row it points at only if that row was
        // deleted out from under it; name it rather than rendering a blank.
        name: user?.name ?? 'Unknown user',
        email: user?.email ?? null,
        evidenceRef: r.evidenceRef,
        /** Null on an ordinary competency, or when the caller may not see it; set where this grant IS a licence (R34). */
        licenceClass: canSeeLicence(r.userId) ? r.licenceClass : null,
        licenceNumber: canSeeLicence(r.userId) ? r.licenceNumber : null,
        grantedAt: r.grantedAt ? r.grantedAt.toISOString() : null,
        expiresAt: expiry ? expiry.toISOString() : null,
        status: currency.status,
        revoked: currency.revoked,
        standing: standingOf(
          competency.id,
          requiredByUser.get(r.userId) ?? new Set(),
          recommendedByUser.get(r.userId) ?? new Set(),
        ),
        current: countsAsHeld(currency),
        // A revoked grant's date is moot; the revoked mark says all there is.
        note: currency.revoked ? null : expiryNote(currency.status, expiry, competency.name),
      };
    });

    /*
      SORTED BY WHAT NEEDS DOING, not alphabetically. The reason to open this
      list is to find who has lapsed and who is about to, so those come first;
      within a group the nearest date leads. A revoked grant needs nothing —
      it was deliberately taken away — so it sorts LAST, below even a current
      one. A name-sorted register would bury the two people who need booking
      among two hundred who do not.
    */
    // Undated ranks below a fully-dated 'held': nothing is expiring, but the
    // record itself needs finishing, so it should not read as identically settled.
    const URGENCY = { expired: 0, grace: 1, expiring: 2, held: 3, undated: 4 } as const;
    const rankOf = (h: { status: keyof typeof URGENCY; revoked: boolean }) =>
      h.revoked ? 5 : URGENCY[h.status];
    holders.sort((a, b) => {
      const byUrgency = rankOf(a) - rankOf(b);
      if (byUrgency !== 0) return byUrgency;

      /*
        DATED BEFORE UNDATED, then by date. A holder can lack an expiry while
        their neighbour has one — the competency carries no validity, but an
        individual grant carries an imported `expiresAt` — and an earlier
        version of this only compared dates when BOTH sides had one, falling
        through to the name otherwise. That makes the comparator intransitive:
        A before B by date, B before C by name, C before A by name, and the
        resulting order depends on the input order rather than the data.
      */
      if (a.expiresAt !== b.expiresAt) {
        if (!a.expiresAt) return 1;
        if (!b.expiresAt) return -1;
        return a.expiresAt < b.expiresAt ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    res.json(holders);
  }),
);

/**
 * What a user holds in this org, and whether each still counts.
 *
 * Returns a STATUS per competency rather than a bare list, because "holds a
 * row" and "is currently qualified" stopped being the same question once
 * qualifications gained a validity period. `held` and `expiring` are current;
 * `grace` is lapsed but still counts, flagged; `expired` does not count.
 *
 * The warning window depends on WHO IS ASKING. A candidate looking at their own
 * record gets 30 days — a prompt to act. Anyone looking at someone else's is
 * planning a reassessment around a training calendar and gets 90. Pass
 * `?audience=candidate` to ask for the short one; it is inferred otherwise.
 */
competenciesRouter.get(
  '/held/:userId',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.competencyHolders.findMany({
      where: and(
        eq(schema.competencyHolders.userId, req.params.userId!),
        eq(schema.competencyHolders.orgId, tenant.orgId),
        // This IS the eligibility lookup, so a revoked grant must not appear.
        // The row survives for the audit trail; it just stops conferring
        // anything, which is the entire point of revoking without deleting.
        isNull(schema.competencyHolders.revokedAt),
      ),
    });
    if (rows.length === 0) {
      res.json([]);
      return;
    }

    const competencies = await db.query.competencies.findMany({
      where: and(
        eq(schema.competencies.orgId, tenant.orgId),
        inArray(schema.competencies.id, rows.map((r) => r.competencyId)),
      ),
    });
    const byId = new Map(competencies.map((c) => [c.id, c]));

    // Someone reading their OWN record is the candidate case; reading another's
    // is the planning case. Explicit override for a surface that knows better.
    const audience =
      req.query.audience === 'candidate' || req.params.userId === tenant.userId
        ? 'candidate'
        : 'assessor';

    // Standing beside currency (R108): which of these the person's held Roles
    // oblige them to hold, and which they merely recommend (R12). Resolved once
    // for the whole record. Revoked rows were already excluded above, so
    // `current` never has to fold revocation in here.
    const [required, recommended] = await Promise.all([
      requiredCompetencyIdsFor(db, tenant.orgId, req.params.userId!),
      recommendedCompetencyIdsFor(db, tenant.orgId, req.params.userId!),
    ]);

    // Licence numbers are sensitive profile data (R34): a caller sees them on
    // someone else's record only with the `profiles.view_competencies` grant —
    // the same gate the profile surface applies — but always on their own.
    const canSeeLicence =
      req.params.userId === tenant.userId ||
      (await permissionScope(tenant, 'profiles', 'view_competencies')) === 'all';

    // One instant for the whole response, so two entries cannot disagree about
    // what "today" is.
    const now = new Date();
    res.json(
      rows.map((r) => {
        const competency = byId.get(r.competencyId);
        const validity = competency ?? {};
        const currency = competencyCurrency(r, validity, now, audience);
        const expiry = expiryOf(r, validity);
        return {
          competencyId: r.competencyId,
          /*
            The display name rides the row so the record never shows a raw id.
            Falls back to the id only where the competency row has vanished —
            a state the org cannot normally reach, but a blank would read as
            "holds nothing" which is worse than an ugly identifier.
          */
          name: competency?.name ?? r.competencyId,
          code: competency?.code ?? null,
          evidenceRef: r.evidenceRef,
          /** Null on an ordinary competency, or when the caller may not see it; set where this grant IS a licence (R34). */
          licenceClass: canSeeLicence ? r.licenceClass : null,
          licenceNumber: canSeeLicence ? r.licenceNumber : null,
          status: currency.status,
          /** Required, recommended or optional for this person, from their held Roles (R108, R12). */
          standing: standingOf(r.competencyId, required, recommended),
          /** True while it still satisfies a requirement — held, expiring or grace. */
          current: countsAsHeld(currency),
          expiresAt: expiry ? expiry.toISOString() : null,
          note: competency ? expiryNote(currency.status, expiry, competency.name) : null,
        };
      }),
    );
  }),
);

function ruleDto(
  row: typeof schema.competencyRules.$inferSelect,
  formName: string,
  competencyName: string,
) {
  return {
    id: row.id,
    templateId: row.templateId,
    form: formName,
    sectionRef: row.sectionRef,
    competencyId: row.competencyId,
    competency: competencyName,
    enabled: row.enabled,
  };
}

competencyRulesRouter.get(
  '/',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.competencyRules.findMany({
      where: eq(schema.competencyRules.orgId, tenant.orgId),
    });
    if (rows.length === 0) {
      res.json([]);
      return;
    }
    const templateIds = [...new Set(rows.map((r) => r.templateId))];
    const competencyIds = [...new Set(rows.map((r) => r.competencyId))];
    const [templates, competenciesList] = await Promise.all([
      db.query.formTemplates.findMany({ where: inArray(schema.formTemplates.id, templateIds) }),
      db.query.competencies.findMany({ where: inArray(schema.competencies.id, competencyIds) }),
    ]);
    const templateNameById = new Map(templates.map((t) => [t.id, t.name]));
    const competencyNameById = new Map(competenciesList.map((c) => [c.id, c.name]));

    res.json(
      rows.map((r) =>
        ruleDto(r, templateNameById.get(r.templateId) ?? '', competencyNameById.get(r.competencyId) ?? ''),
      ),
    );
  }),
);

const createRuleBody = z.object({
  templateId: z.string().min(1),
  competencyId: z.string().min(1),
  sectionRef: z.string().min(1),
});

competencyRulesRouter.post(
  '/',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = createRuleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    const { templateId, competencyId, sectionRef } = parsed.data;

    const [template, competency] = await Promise.all([
      db.query.formTemplates.findFirst({
        where: and(eq(schema.formTemplates.id, templateId), eq(schema.formTemplates.orgId, tenant.orgId)),
      }),
      db.query.competencies.findFirst({
        where: and(eq(schema.competencies.id, competencyId), eq(schema.competencies.orgId, tenant.orgId)),
      }),
    ]);
    if (!template) {
      res.status(404).json({ error: 'form_not_found' });
      return;
    }
    if (!competency) {
      res.status(404).json({ error: 'competency_not_found' });
      return;
    }

    const [row] = await db
      .insert(schema.competencyRules)
      .values({ orgId: tenant.orgId, templateId, competencyId, sectionRef, enabled: true })
      .returning();
    if (!row) throw new Error('rule_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Added gating rule',
      target: `${competency.name} → ${sectionRef}`,
      category: 'settings',
      icon: 'graduation-cap',
    });

    res.status(201).json(ruleDto(row, template.name, competency.name));
  }),
);

const patchRuleBody = z.object({
  enabled: z.boolean().optional(),
});

competencyRulesRouter.patch(
  '/:id',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = patchRuleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    const row = await db.query.competencyRules.findFirst({
      where: and(eq(schema.competencyRules.id, req.params.id!), eq(schema.competencyRules.orgId, tenant.orgId)),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const nextEnabled = parsed.data.enabled ?? !row.enabled;
    await db
      .update(schema.competencyRules)
      .set({ enabled: nextEnabled })
      .where(eq(schema.competencyRules.id, row.id));

    const [template, competency] = await Promise.all([
      db.query.formTemplates.findFirst({ where: eq(schema.formTemplates.id, row.templateId) }),
      db.query.competencies.findFirst({ where: eq(schema.competencies.id, row.competencyId) }),
    ]);
    res.json(ruleDto({ ...row, enabled: nextEnabled }, template?.name ?? '', competency?.name ?? ''));
  }),
);

competencyRulesRouter.delete(
  '/:id',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const row = await db.query.competencyRules.findFirst({
      where: and(eq(schema.competencyRules.id, req.params.id!), eq(schema.competencyRules.orgId, tenant.orgId)),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await db.delete(schema.competencyRules).where(eq(schema.competencyRules.id, row.id));
    res.status(204).end();
  }),
);
