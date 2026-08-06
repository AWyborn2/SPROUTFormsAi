import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import { BUILDER_STEPS, RETIRED_BUILDER_STEPS, resolveBuilderStep } from '@formai/shared';
import { db } from '../db.js';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';

/**
 * Assessment tool drafts — the seven-step builder's working state, server-side.
 *
 * Org-scoped throughout, like every other route behind the tenant boundary, and
 * deliberately NOT scoped to the person who saved it: authoring a tool is
 * explicitly work a colleague may pick up — the answer key is usually confirmed
 * by somebody other than whoever mapped the pages.
 *
 * THE STATE CARRIES ANSWER KEYS, which is why the org filter is in every WHERE
 * clause rather than checked after loading. A draft read across a tenant
 * boundary would hand over the complete key to another organisation's
 * safety-critical assessment.
 */
export const builderDraftsRouter: Router = Router();

/*
  The state is stored and returned OPAQUE, the same contract `import-drafts`
  keeps and for the same reason: its shape belongs to the builder, which
  evolves faster than this route, and a shape validated here would mean a
  client-side addition silently failing to save until a migration caught up.

  What IS checked is that it is an object at all, so a malformed body fails at
  the boundary rather than as a database error — and that `step` is one of the
  seven, because it is read back to decide which screen opens and an unknown
  value there is a blank builder rather than a resumed one.
*/
const draftBody = z.object({
  name: z.string().min(1).max(120),
  assetId: z.string().min(1),
  step: z
    .string()
    .refine(
      (v) => (BUILDER_STEPS as readonly string[]).includes(v) || v in RETIRED_BUILDER_STEPS,
      'not a builder step',
    )
    .optional(),
  state: z.record(z.string(), z.unknown()),
  formId: z.string().uuid().nullish(),
  versionId: z.string().uuid().nullish(),
});

/** Everything but the state — enough to list and choose from. */
function summarise(row: typeof schema.assessmentToolDrafts.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    assetId: row.assetId,
    step: row.step,
    formId: row.formId,
    versionId: row.versionId,
    savedByUserId: row.savedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Save, or overwrite the one with this name.
 *
 * An upsert on (org, name), matching `import-drafts`: that is what "save" means
 * everywhere else, and the alternative accumulates a new row every time the
 * builder autosaves.
 */
builderDraftsRouter.post(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = draftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    const name = parsed.data.name.trim();
    if (!name) {
      res.status(400).json({ error: 'invalid_request', detail: 'A draft needs a name.' });
      return;
    }

    const [row] = await db
      .insert(schema.assessmentToolDrafts)
      .values({
        orgId: tenant.orgId,
        name,
        assetId: parsed.data.assetId,
        step: resolveBuilderStep(parsed.data.step),
        state: parsed.data.state,
        formId: parsed.data.formId ?? null,
        versionId: parsed.data.versionId ?? null,
        savedByUserId: tenant.userId,
      })
      .onConflictDoUpdate({
        target: [schema.assessmentToolDrafts.orgId, schema.assessmentToolDrafts.name],
        set: {
          assetId: parsed.data.assetId,
          step: resolveBuilderStep(parsed.data.step),
          state: parsed.data.state,
          formId: parsed.data.formId ?? null,
          versionId: parsed.data.versionId ?? null,
          savedByUserId: tenant.userId,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('builder_draft_save_failed: upsert returned no row');

    /*
      Audited on CREATE only.

      The builder autosaves as an author works, so auditing every write would
      bury the trail under hundreds of "Saved assessment tool draft" entries for
      one afternoon's work — and the audit log's job here is to say a tool was
      started and by whom, which the create says once.
    */
    if (row.createdAt.getTime() === row.updatedAt.getTime()) {
      await recordAudit(db, tenant, {
        action: 'Started an assessment tool',
        target: name,
        category: 'forms',
        icon: 'clipboard-check',
      });
    }

    res.status(201).json(summarise(row));
  }),
);

/** Every draft in this org, most recently touched first. */
builderDraftsRouter.get(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.assessmentToolDrafts.findMany({
      where: eq(schema.assessmentToolDrafts.orgId, tenant.orgId),
      orderBy: [desc(schema.assessmentToolDrafts.updatedAt)],
    });
    /*
      Summaries only. A state carries an entire extraction, every field, every
      key and every placement — megabytes — and none of it is needed to choose
      which draft to open. The state travels on the single-draft read.
    */
    res.json(rows.map(summarise));
  }),
);

/** One draft, with its state — what resuming actually loads. */
builderDraftsRouter.get(
  '/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const row = await db.query.assessmentToolDrafts.findFirst({
      // Org in the WHERE, not checked after loading: the state carries the
      // answer key, so a read across the tenant boundary hands another
      // organisation the answers to their own assessment.
      where: and(
        eq(schema.assessmentToolDrafts.id, req.params.id!),
        eq(schema.assessmentToolDrafts.orgId, tenant.orgId),
      ),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ...summarise(row), state: row.state });
  }),
);

/** Discard a draft. */
builderDraftsRouter.delete(
  '/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const row = await db.query.assessmentToolDrafts.findFirst({
      where: and(
        eq(schema.assessmentToolDrafts.id, req.params.id!),
        eq(schema.assessmentToolDrafts.orgId, tenant.orgId),
      ),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    await db.delete(schema.assessmentToolDrafts).where(eq(schema.assessmentToolDrafts.id, row.id));
    await recordAudit(db, tenant, {
      action: 'Discarded an assessment tool draft',
      target: row.name,
      category: 'forms',
      icon: 'trash-2',
    });

    res.status(204).end();
  }),
);
