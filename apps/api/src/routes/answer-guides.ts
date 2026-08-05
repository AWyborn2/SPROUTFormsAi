import { Router } from 'express';
import { z } from 'zod';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { getAnthropic } from '../anthropic.js';
import { getStorageClient } from '../storage/index.js';
import { matchAnswerGuide } from '../pdf/answer-guide.js';
import { env } from '../env.js';

/**
 * POST /answer-guides/match — read an answer guide PDF against known questions.
 *
 * BEHIND THE TENANT BOUNDARY, like every other model-backed route here. The
 * guide is the complete answer key to a safety-critical assessment; the door it
 * comes through has to be the authenticated, org-scoped one, and the bytes are
 * fetched from org-scoped storage by the same `assetId` contract `/pdf/extract`
 * already uses.
 *
 * THE QUESTIONS COME FROM THE CALLER, and that is deliberate rather than lazy.
 * The builder holds the author's edited field list — types corrected, questions
 * excluded, matching sides authored — and a guide has to be read against THAT,
 * not against a re-extraction of the original document that would disagree with
 * what the author is looking at. The route does no marking and stores nothing;
 * it returns proposals the builder seeds as unverified.
 */
export const answerGuidesRouter: Router = Router();

const matchBody = z
  .object({
    assetId: z.string().min(1).optional(),
    pdfBase64: z.string().min(1).optional(),
    questions: z
      .array(
        z.object({
          fieldId: z.string().min(1),
          label: z.string(),
          // A question with no options cannot be keyed from a guide, and
          // sending one is a caller bug worth surfacing rather than absorbing.
          options: z.array(z.string()).min(1),
          section: z.string().optional(),
        }),
      )
      .min(1)
      .max(500),
  })
  .refine((b) => !!b.assetId !== !!b.pdfBase64, {
    message: 'Provide exactly one of assetId or pdfBase64.',
  });

answerGuidesRouter.post(
  '/match',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const parsed = matchBody.safeParse(req.body);
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
      const result = await matchAnswerGuide(bytes, parsed.data.questions, {
        anthropic,
        model: env.ANTHROPIC_EXTRACTION_MODEL,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'guide_match_failed';
      // A missing key is a configuration state, not a fault — same mapping as
      // the extraction path's `extraction_unavailable`.
      const status = message.startsWith('guide_match_unavailable') ? 422 : 500;
      res.status(status).json({ error: message });
    }
  }),
);
