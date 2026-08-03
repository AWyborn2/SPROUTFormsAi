import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import { db } from '../db.js';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';

/**
 * Named, saved imports — a mapping in progress that outlives the browser.
 *
 * The wizard already autosaves locally, and that covers an interruption. This
 * covers the things a browser copy cannot: a laptop that dies, a form one
 * person starts and another finishes, and a mapping parked for a fortnight
 * while the paper document goes through a revision.
 *
 * Org-scoped throughout, like every other route behind the tenant boundary.
 * Deliberately NOT scoped to the person who saved it: a draft is explicitly
 * something a colleague may pick up, which is most of the reason it exists, so
 * `savedByUserId` records whose work it is rather than who may read it.
 */
export const importDraftsRouter: Router = Router();

/*
  The snapshot is stored and returned OPAQUE.

  Its shape belongs to the review surface, it carries its own version, and the
  client discards a version it does not understand rather than migrating it. So
  there is nothing useful for this route to validate — and validating a shape it
  does not own would mean a client-side change to the review state silently
  failing to save here, which is the worst of both.

  What IS checked is that it is an object at all, so a malformed body fails at
  the boundary rather than as a database error.
*/
const draftBody = z.object({
  name: z.string().min(1).max(120),
  assetId: z.string().min(1),
  snapshot: z.record(z.string(), z.unknown()),
});

/** Everything but the snapshot — enough to list and choose from. */
function summarise(row: typeof schema.importDrafts.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    assetId: row.assetId,
    savedByUserId: row.savedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Save, or overwrite the one with this name.
 *
 * An upsert on (org, name) because that is what "save" means everywhere else.
 * Without it a reviewer saving "Track Dozer" each afternoon accumulates seven
 * of them, and the list becomes useless at exactly the point it matters.
 */
importDraftsRouter.post(
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
      .insert(schema.importDrafts)
      .values({
        orgId: tenant.orgId,
        name,
        assetId: parsed.data.assetId,
        snapshot: parsed.data.snapshot,
        savedByUserId: tenant.userId,
      })
      .onConflictDoUpdate({
        target: [schema.importDrafts.orgId, schema.importDrafts.name],
        set: {
          assetId: parsed.data.assetId,
          snapshot: parsed.data.snapshot,
          savedByUserId: tenant.userId,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('import_draft_save_failed: upsert returned no row');

    await recordAudit(db, tenant, {
      action: 'Saved import draft',
      target: name,
      category: 'forms',
      icon: 'save',
    });

    res.status(201).json(summarise(row));
  }),
);

/** Every saved draft in this org, most recently touched first. */
importDraftsRouter.get(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.importDrafts.findMany({
      where: eq(schema.importDrafts.orgId, tenant.orgId),
      orderBy: [desc(schema.importDrafts.updatedAt)],
    });
    /*
      Summaries only. A snapshot is an entire extraction plus every placement —
      megabytes — and a list of ten would be a response nobody needs in order to
      choose one. The snapshot travels on the single-draft read.
    */
    res.json(rows.map(summarise));
  }),
);

/** One draft, with its snapshot — what resuming actually loads. */
importDraftsRouter.get(
  '/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const row = await db.query.importDrafts.findFirst({
      // Org in the WHERE, not checked after loading: without it any org could
      // read another's mapping — and a snapshot carries the whole document.
      where: and(
        eq(schema.importDrafts.id, req.params.id!),
        eq(schema.importDrafts.orgId, tenant.orgId),
      ),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ...summarise(row), snapshot: row.snapshot });
  }),
);

/** Discard a saved draft. */
importDraftsRouter.delete(
  '/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const row = await db.query.importDrafts.findFirst({
      where: and(
        eq(schema.importDrafts.id, req.params.id!),
        eq(schema.importDrafts.orgId, tenant.orgId),
      ),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    await db.delete(schema.importDrafts).where(eq(schema.importDrafts.id, row.id));
    await recordAudit(db, tenant, {
      action: 'Discarded import draft',
      target: row.name,
      category: 'forms',
      icon: 'trash-2',
    });

    res.status(204).end();
  }),
);
