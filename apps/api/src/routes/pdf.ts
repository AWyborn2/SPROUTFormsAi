import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { FormField, SubmissionValue } from '@formai/shared';
import { db } from '../db.js';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { getAnthropic } from '../anthropic.js';
import { extractForm, roundTripExport } from '../pdf/index.js';
import { getStorageClient } from '../storage/index.js';
import { env } from '../env.js';

/**
 * PDF pipeline routes, behind the tenant boundary. All work is org-scoped
 * via `req.tenant`.
 *
 * `/extract` and `/round-trip` accept a PDF either as inline base64 or as a
 * previously-uploaded `assetId` (mutually exclusive). `/upload` is this
 * router's own addition, not explicitly named in the rollout plan's U12 —
 * something has to upload bytes and hand the caller back an `assetId`
 * before the `assetId` path on the other two routes is reachable at all.
 * Which storage backend actually receives the bytes is decided by
 * `storage/index.ts` (`env.STORAGE_PROVIDER`), not by this file.
 */
export const pdfRouter: Router = Router();

const uploadBody = z.object({
  pdfBase64: z.string().min(1),
});

pdfRouter.post(
  '/upload',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const parsed = uploadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    const bytes = Buffer.from(parsed.data.pdfBase64, 'base64');
    const assetId = await client.upload(tenant.orgId, bytes);
    res.status(201).json({ assetId });
  }),
);

// ── GET /pdf/asset/* ──────────────────────────────────────────────────────
// Streams the stored original PDF back for the review-screen renderer.
// Asset ids are org-prefixed and contain a slash (e.g. org-id/uuid.pdf), so
// a wildcard is used instead of :assetId.
pdfRouter.get(
  '/asset/*',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const assetId = req.params[0] as string;
    const downloaded = await client.download(tenant.orgId, assetId);
    if (!downloaded) {
      res.status(404).json({ error: 'asset_not_found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.send(downloaded);
  }),
);

const extractBody = z
  .object({
    fileName: z.string().min(1),
    /** Base64-encoded PDF bytes. Mutually exclusive with `assetId`. */
    pdfBase64: z.string().min(1).optional(),
    /** An id returned by `POST /pdf/upload`. Mutually exclusive with `pdfBase64`. */
    assetId: z.string().min(1).optional(),
  })
  .refine((v) => (v.pdfBase64 ? 1 : 0) + (v.assetId ? 1 : 0) === 1, {
    message: 'exactly one of pdfBase64 or assetId is required',
  });

pdfRouter.post(
  '/extract',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const parsed = extractBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    let bytes: Buffer;
    if (parsed.data.assetId) {
      const client = getStorageClient();
      if (!client) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const downloaded = await client.download(tenant.orgId, parsed.data.assetId);
      if (!downloaded) {
        res.status(404).json({ error: 'asset_not_found' });
        return;
      }
      bytes = downloaded;
    } else {
      bytes = Buffer.from(parsed.data.pdfBase64!, 'base64');
    }

    try {
      const anthropic = getAnthropic() ?? undefined;
      const result = await extractForm(bytes, {
        fileName: parsed.data.fileName,
        anthropic,
        model: env.ANTHROPIC_EXTRACTION_MODEL,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'extraction_failed';
      // Flat PDFs with no configured key surface as a 422, not a 500.
      const status = message.startsWith('extraction_unavailable') ? 422 : 500;
      res.status(status).json({ error: message });
    }
  }),
);

/**
 * The export takes a submission id and NOTHING else.
 *
 * It used to take `fields` and `values` straight off the request body as
 * `z.custom` passthroughs — which perform no runtime validation whatsoever.
 * That made two forgeries trivial for any authenticated caller: post the
 * form's own field list with `visibleWhen` stripped and the PDF renders a
 * hidden section's answers; or post values matching no stored submission at
 * all and the PDF renders those. A filled PDF is read in incident
 * investigations as evidence of what was RECORDED, so both fields and values
 * are now loaded server-side from the submission and its pinned version, and
 * the visibility filter is applied to those (U11).
 *
 * There is deliberately no ad-hoc "render these fields" variant: nothing in
 * apps/web needs one (the only caller is `store.exportSubmissionPdf`). If one
 * is ever needed it belongs on a separate, clearly non-evidentiary route —
 * never on this one, whose whole value is that its output cannot be steered.
 */
const exportBody = z.object({
  submissionId: z.string().min(1),
});

pdfRouter.post(
  '/round-trip',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = exportBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;

    // Org-scoped: a submission from another tenant is indistinguishable from
    // one that does not exist.
    const submission = await db.query.submissions.findFirst({
      where: and(
        eq(schema.submissions.id, parsed.data.submissionId),
        eq(schema.submissions.orgId, tenant.orgId),
      ),
    });
    if (!submission) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // The PINNED version — the form as the filler actually saw it — supplies
    // both the field definitions (including their conditions) and the source
    // PDF the values are overlaid onto.
    const version = await db.query.formTemplateVersions.findFirst({
      where: eq(schema.formTemplateVersions.id, submission.templateVersionId),
    });
    const fields: FormField[] = Array.isArray(version?.fields) ? (version.fields as FormField[]) : [];
    if (!version?.sourcePdfAssetId) {
      // Built-from-scratch (or AI-extracted) forms have no original page to
      // draw on. Well-formed request, unprocessable subject: 422.
      res.status(422).json({ error: 'no_source_pdf' });
      return;
    }

    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const original = await client.download(tenant.orgId, version.sourcePdfAssetId);
    if (!original) {
      res.status(404).json({ error: 'asset_not_found' });
      return;
    }

    const values = (submission.values ?? {}) as Record<string, SubmissionValue>;

    try {
      // `roundTripExport` applies the visibility filter itself, so the drawn
      // page and the stored record cannot disagree.
      const out = await roundTripExport({ originalPdf: original, fields, values });
      res.setHeader('Content-Type', 'application/pdf');
      res.send(Buffer.from(out));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'round_trip_failed';
      res.status(500).json({ error: message });
    }
  }),
);
