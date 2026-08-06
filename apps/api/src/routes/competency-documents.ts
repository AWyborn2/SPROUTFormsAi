import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { resolveProfileAccess } from '../lib/profile-access.js';
import { recordAudit } from '../audit/record.js';
import { getStorageClient } from '../storage/index.js';
import { ATTACHMENT_KEY_RE, EXT_CONTENT_TYPE, storeAttachment } from './uploads.js';
import { db } from '../db.js';

/**
 * Competency evidence — the documents a human opens to judge whether a ticket is
 * genuine (R25–R32).
 *
 * THE SERVING ROUTE IS THE POINT OF THIS FILE. `GET /uploads/file/*` checks
 * tenancy and the key namespace and nothing else, which is right for a
 * submission attachment and wrong for a licence image carrying a date of birth
 * and a photograph. R30 is the property enforced here: a key is not a
 * permission. Knowing a document's address is never on its own enough to open
 * it.
 *
 * IT RESOLVES `view_documents`, NOT `view` (R44, KTD26). An organisation that
 * restricts an access level's reach into profile FIELDS does not thereby
 * restrict its reach into documents, and gating this on `view` would collapse
 * the distinction the action exists for — making the new grant decorative.
 *
 * THE SUBJECT CANDIDATE NEEDS NO GRANT (R50). Their read of the documents held
 * on their own record is fixed, like their read of their own fields.
 */
export const competencyDocumentsRouter: Router = Router();

/** Owner holds everything Admin holds (R32, R54). */
function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

/**
 * Resolve the membership whose profile a competency grant belongs to.
 *
 * The grant is keyed on a USER, the access resolution on a MEMBERSHIP — one
 * person working for two customers has two, and only this organisation's is
 * relevant. Returns null where the holder is not a member here, which reads as
 * not-found rather than forbidden.
 */
async function subjectFor(orgId: string, holderUserId: string) {
  const membership = await db!.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, holderUserId)),
  });
  return membership ?? null;
}

const attachBody = z.object({
  fileBase64: z.string().min(1),
  mimeType: z.string().min(1),
  fileName: z.string().min(1).max(400),
});

// ── POST /competency-documents/:holderId ───────────────────────────────────

competencyDocumentsRouter.post(
  '/:holderId',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const holder = await db.query.competencyHolders.findFirst({
      where: and(
        eq(schema.competencyHolders.id, req.params.holderId!),
        eq(schema.competencyHolders.orgId, tenant.orgId),
      ),
    });
    if (!holder) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const subject = await subjectFor(tenant.orgId, holder.userId);
    if (!subject) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const access = await resolveProfileAccess(db, tenant, subject);
    // Attaching evidence to somebody's record is an edit of that record. The
    // candidate's own path is a REPLACEMENT that waits for approval (R52, U33),
    // not this one.
    if (access.isSubject || access.editableFields.length === 0) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (!attachBody.safeParse(req.body).success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    /*
      KTD23: the ONE validator, unchanged. Type, size and magic bytes are its
      rules, and the key it returns is server-minted — which is what the serving
      route's namespace check below can rely on.
    */
    const stored = await storeAttachment(tenant.orgId, req.body);
    if (!stored.ok) {
      res.status(stored.failure.status).json(stored.failure.body);
      return;
    }

    const [row] = await db
      .insert(schema.competencyDocuments)
      .values({
        orgId: tenant.orgId,
        competencyHolderId: holder.id,
        storageKey: stored.ref.key,
        fileName: stored.ref.fileName,
        contentType: stored.ref.contentType,
        // R28: a competency may carry several. Nothing is displaced by adding one.
        state: 'held',
        uploadedByUserId: tenant.userId,
      })
      .returning();

    res.status(201).json({ id: row!.id, fileName: row!.fileName });
  }),
);

// ── GET /competency-documents/:holderId ────────────────────────────────────

competencyDocumentsRouter.get(
  '/:holderId',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const holder = await db.query.competencyHolders.findFirst({
      where: and(
        eq(schema.competencyHolders.id, req.params.holderId!),
        eq(schema.competencyHolders.orgId, tenant.orgId),
      ),
    });
    if (!holder) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const subject = await subjectFor(tenant.orgId, holder.userId);
    if (!subject) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const access = await resolveProfileAccess(db, tenant, subject);
    if (!access.canViewDocuments) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const rows = await db.query.competencyDocuments.findMany({
      where: eq(schema.competencyDocuments.competencyHolderId, holder.id),
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        contentType: r.contentType,
        /** Every state is retrievable; only `held` is the record's evidence (KTD24). */
        state: r.state,
        approvedAt: r.approvedAt?.toISOString() ?? null,
        rejectedAt: r.rejectedAt?.toISOString() ?? null,
        rejectedReason: r.rejectedReason,
        uploadedAt: r.uploadedAt.toISOString(),
      })),
    );
  }),
);

// ── GET /competency-documents/file/:id ─────────────────────────────────────

competencyDocumentsRouter.get(
  '/file/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    /*
      EVERY refusal below is the SAME 404. A caller must not be able to tell a
      document they may not open from one that does not exist — otherwise the
      route becomes an oracle for which members hold which tickets.
    */
    const notFound = () => res.status(404).json({ error: 'not_found' });

    const row = await db.query.competencyDocuments.findFirst({
      where: eq(schema.competencyDocuments.id, req.params.id!),
    });
    if (!row || row.orgId !== tenant.orgId) return void notFound();
    // The namespace check the attachment route applies, on the same shape,
    // before any storage call.
    if (!ATTACHMENT_KEY_RE.test(row.storageKey)) return void notFound();
    if (!row.storageKey.startsWith(`${tenant.orgId}/`)) return void notFound();

    const holder = await db.query.competencyHolders.findFirst({
      where: eq(schema.competencyHolders.id, row.competencyHolderId),
    });
    if (!holder) return void notFound();
    const subject = await subjectFor(tenant.orgId, holder.userId);
    if (!subject) return void notFound();

    const access = await resolveProfileAccess(db, tenant, subject);
    // R44: the DOCUMENT grant, not the field grant. R50 admits the subject
    // candidate through `canViewDocuments` without any matrix grant at all.
    if (!access.canViewDocuments) return void notFound();

    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const bytes = await client.download(tenant.orgId, row.storageKey);
    if (!bytes) return void notFound();

    const ext = row.storageKey.slice(row.storageKey.lastIndexOf('.') + 1).toLowerCase();
    res.setHeader('Content-Type', EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream');
    // Identical posture to the attachment route: never let a browser sniff its
    // way to a scriptable type, and never let a PDF run as an active document.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // Private: a licence image must never sit in a shared cache.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  }),
);

// ── DELETE /competency-documents/:id ───────────────────────────────────────

const removeBody = z.object({ reason: z.string().min(1) });

competencyDocumentsRouter.delete(
  '/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    /*
      R32: Admin-only, whatever the matrix says. It exists for the document
      uploaded to the WRONG person's record — not as a way to tidy a record, and
      not something an approver reaches by holding `approve`.
    */
    if (!isAdmin(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = removeBody.safeParse(req.body);
    if (!parsed.success) {
      // The reason is not optional — an unexplained removal is what the audit
      // line exists to prevent.
      res.status(400).json({ error: 'reason_required' });
      return;
    }

    const row = await db.query.competencyDocuments.findFirst({
      where: and(
        eq(schema.competencyDocuments.id, req.params.id!),
        eq(schema.competencyDocuments.orgId, tenant.orgId),
      ),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    /*
      A STATE CHANGE, not a delete (KTD24). The row and the stored object both
      stay: R31 keeps a superseded document as evidence of what was sighted, and
      nothing about removal should make that harder to honour.
    */
    await db
      .update(schema.competencyDocuments)
      .set({
        state: 'removed',
        removedByUserId: tenant.userId,
        removedAt: new Date(),
        removedReason: parsed.data.reason,
      })
      .where(eq(schema.competencyDocuments.id, row.id));

    await recordAudit(db, tenant, {
      action: 'Removed competency document',
      target: `${row.fileName || row.id}: ${parsed.data.reason}`,
      category: 'profiles',
      icon: 'file-x',
    });

    res.status(204).end();
  }),
);
