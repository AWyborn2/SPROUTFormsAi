import { Router, type Response } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { FormField } from '@formai/shared';
import { resolveVoiceInput } from '@formai/shared';
import { db } from '../db.js';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { getAnthropic } from '../anthropic.js';
import { SmartFillError, mapTranscriptToFields } from '../voice/map.js';

/**
 * Smart Fill — the paid tier of voice-to-text, where one spoken description of
 * the whole form is mapped onto many fields at once.
 *
 * This router is the AUTHED door (builder preview, mobile inspection screen):
 * `requireTenant` establishes the org and `requirePlanFeature` checks its
 * entitlement. The public door is `POST /fill/:token/smart-fill` in
 * fill-links.ts, which has no session at all and must resolve org and plan
 * from the link token itself — it shares `respondSmartFill` below so the two
 * surfaces cannot drift on what a mapping, or a failure, looks like.
 *
 * On-device dictation into a single field is FREE at every tier and never
 * touches this route: no transcript leaves the browser for that path.
 */
export const voiceRouter: Router = Router();

/**
 * Transcript cap. Smart Fill is one person describing one form out loud, so a
 * few thousand characters is minutes of speech. The cap is what stops either
 * door — one of which is credentialed by nothing but a link token — being used
 * to pump unbounded text into the model.
 */
export const SMART_FILL_TRANSCRIPT_MAX_CHARS = 4000;

/** Both doors accept the same transcript, so they cap it with the same rule. */
export const smartFillTranscriptSchema = z
  .string()
  .trim()
  .min(1)
  .max(SMART_FILL_TRANSCRIPT_MAX_CHARS);

const authedSmartFillBody = z.object({
  templateVersionId: z.string().min(1),
  transcript: smartFillTranscriptSchema,
});

/**
 * Run the mapper over server-loaded fields and write the response. Field
 * definitions are ALWAYS resolved by the caller from the database — accepting
 * them from a request body would let anyone hand the model an arbitrary form
 * to answer.
 */
export async function respondSmartFill(
  res: Response,
  input: { fields: FormField[]; transcript: string },
): Promise<void> {
  try {
    const result = await mapTranscriptToFields({
      transcript: input.transcript,
      fields: input.fields,
      anthropic: getAnthropic(),
    });
    res.json(result);
  } catch (err) {
    // No configured key is a well-formed request this deployment cannot serve
    // — 422, exactly as the flat-PDF path answers for the same cause.
    if (err instanceof SmartFillError && err.code === 'smart_fill_unavailable') {
      res.status(422).json({ error: err.code });
      return;
    }
    console.error('smart fill error:', err);
    res.status(500).json({ error: 'smart_fill_failed' });
  }
}

voiceRouter.post(
  '/smart-fill',
  requireTenant,
  requirePlanFeature('smartFill'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = authedSmartFillBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;

    const version = await db.query.formTemplateVersions.findFirst({
      where: eq(schema.formTemplateVersions.id, parsed.data.templateVersionId),
    });
    // Versions carry no orgId — their template does. A version belonging to
    // another org is indistinguishable from one that does not exist.
    const template = version
      ? await db.query.formTemplates.findFirst({
          where: and(
            eq(schema.formTemplates.id, version.templateId),
            eq(schema.formTemplates.orgId, tenant.orgId),
          ),
        })
      : undefined;
    if (!version || !template) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // The voice off-switch, checked AFTER the plan gate: `requirePlanFeature`
    // answers "does the plan include it", this answers "is voice off for THIS
    // form" — the template's own override first, then the workspace default
    // (`resolveVoiceInput`). Enforced here as well as on the public door so a
    // disabled form's own builders cannot keep spending model calls from the
    // preview that respondents can no longer make.
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, tenant.orgId),
    });
    if (!resolveVoiceInput(template.voiceInput, org?.branding)) {
      res.status(403).json({ error: 'voice_disabled' });
      return;
    }

    // Draft versions are deliberately allowed: this door serves the builder's
    // own preview, where nothing is published yet.
    const fields: FormField[] = Array.isArray(version.fields) ? version.fields : [];
    await respondSmartFill(res, { fields, transcript: parsed.data.transcript });
  }),
);
