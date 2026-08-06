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
import { requiredCompetencyIdsByUser, requiredCompetencyIdsFor } from '../lib/standing.js';
import { db } from '../db.js';

/**
 * Competencies, who holds them, and the rules gating a form section behind one.
 * All routes are gated behind the `competencyGating` plan feature (Business and
 * Enterprise) — it moved down from Enterprise-only when multi-part assessments
 * shipped, because assessor eligibility per tool reads these records.
 */
export const competenciesRouter: Router = Router();
export const competencyRulesRouter: Router = Router();

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

/*
  `validForMonths` and `gracePeriodDays` are both optional and both default to
  NULL — never expires. That is deliberate: a qualification does not start
  lapsing because someone created it, only because someone stated how long it
  lasts. 600 months is a sanity ceiling, not a policy.
*/
const validityFields = {
  validForMonths: z.number().int().positive().max(600).nullable().optional(),
  gracePeriodDays: z.number().int().nonnegative().max(365).nullable().optional(),
};

const createCompetencyBody = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  holders: z.number().int().nonnegative().optional(),
  ...validityFields,
});

/** Everything on a competency an admin may change after creating it. */
const updateCompetencyBody = z.object({
  name: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  ...validityFields,
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
    const parsed = createCompetencyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    const [row] = await db
      .insert(schema.competencies)
      .values({
        orgId: tenant.orgId,
        name: parsed.data.name,
        code: parsed.data.code,
        holders: parsed.data.holders ?? 0,
        validForMonths: parsed.data.validForMonths ?? null,
        gracePeriodDays: parsed.data.gracePeriodDays ?? null,
      })
      .returning();
    if (!row) throw new Error('competency_create_failed: insert returned no row');
    res.status(201).json({
      id: row.id,
      name: row.name,
      code: row.code,
      holders: row.holders,
      validForMonths: row.validForMonths,
      gracePeriodDays: row.gracePeriodDays,
    });
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
    const parsed = updateCompetencyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
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
      target: `${row.code}: ${Object.keys(patch).join(', ') || 'no change'}`,
      category: 'settings',
      icon: 'award',
    });

    res.json({
      id: row.id,
      name: row.name,
      code: row.code,
      holders: row.holders,
      validForMonths: row.validForMonths,
      gracePeriodDays: row.gracePeriodDays,
    });
  }),
);

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
    const row = await db.query.competencies.findFirst({
      where: and(eq(schema.competencies.id, req.params.id!), eq(schema.competencies.orgId, tenant.orgId)),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await db.delete(schema.competencies).where(eq(schema.competencies.id, row.id));
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
    const parsed = grantBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;

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
    const parsed = revokeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
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
      target: `${competency.code} → ${req.params.userId}`,
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

    // Standing per holder: is THIS competency one their held Roles require
    // (R108)? Batched into one query path rather than per holder.
    const requiredByUser = await requiredCompetencyIdsByUser(db, tenant.orgId, holderUserIds);

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
        grantedAt: r.grantedAt.toISOString(),
        expiresAt: expiry ? expiry.toISOString() : null,
        status: currency.status,
        revoked: currency.revoked,
        standing: standingOf(competency.id, requiredByUser.get(r.userId) ?? new Set()),
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
    const URGENCY = { expired: 0, grace: 1, expiring: 2, held: 3 } as const;
    const rankOf = (h: { status: keyof typeof URGENCY; revoked: boolean }) =>
      h.revoked ? 4 : URGENCY[h.status];
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
    // oblige them to hold. Resolved once for the whole record. Revoked rows were
    // already excluded above, so `current` never has to fold revocation in here.
    const required = await requiredCompetencyIdsFor(db, tenant.orgId, req.params.userId!);

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
          evidenceRef: r.evidenceRef,
          status: currency.status,
          /** Required or optional for this person, from their held Roles (R108). */
          standing: standingOf(r.competencyId, required),
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
