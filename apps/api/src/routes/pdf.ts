import { Router } from 'express';
import { z } from 'zod';
import type { FormField, SubmissionValue } from '@formai/shared';
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

const exportBody = z
  .object({
    pdfBase64: z.string().min(1).optional(),
    assetId: z.string().min(1).optional(),
    fields: z.array(z.custom<FormField>()),
    values: z.record(z.string(), z.custom<SubmissionValue>()),
  })
  .refine((v) => (v.pdfBase64 ? 1 : 0) + (v.assetId ? 1 : 0) === 1, {
    message: 'exactly one of pdfBase64 or assetId is required',
  });

pdfRouter.post(
  '/round-trip',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const parsed = exportBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    let original: Buffer;
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
      original = downloaded;
    } else {
      original = Buffer.from(parsed.data.pdfBase64!, 'base64');
    }

    try {
      const out = await roundTripExport({
        originalPdf: original,
        fields: parsed.data.fields,
        values: parsed.data.values,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.send(Buffer.from(out));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'round_trip_failed';
      res.status(500).json({ error: message });
    }
  }),
);
