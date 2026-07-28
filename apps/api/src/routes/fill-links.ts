import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { PLAN_CONFIG, schema } from '@formai/db';
import type { PlanTier } from '@formai/db';
import type { FormField } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { db } from '../db.js';
import {
  incompleteRowsByField,
  missingRequiredFields,
  resolveTheme,
  stripHiddenValues,
} from '@formai/shared';
// The authed POST /submissions validates with the same runtime schema —
// single SubmissionValue contract, two doors.
import { submissionValueSchema } from './submissions.js';
import { storeAttachment } from './uploads.js';
// Smart Fill's authed door owns the mapper wiring and the transcript cap; this
// file adds only the second, session-less way in.
import { respondSmartFill, smartFillTranscriptSchema } from './voice.js';

/**
 * Fill links — public distribution of a form template.
 *
 * Two surfaces:
 *  - `formFillLinksRouter` (mounted under /forms, requireTenant): create,
 *    list, and revoke links for the caller's org's template.
 *  - `publicFillRouter` (mounted at /fill, NO auth): token-addressed form
 *    fetch and submission. The token is the only credential.
 *
 * A link resolves the template's LATEST PUBLISHED version at request time —
 * publishing a fix propagates to every distributed link. Auditability is
 * preserved because a submission pins the exact version the visitor filled
 * (the client echoes the `versionId` it was served).
 *
 * Residual risk (documented, deliberately out of scope for this unit): no rate
 * limiting on the public GET or on the public submit. That was written when
 * every public route cost a lookup and an insert; `POST /:token/smart-fill`
 * spends money per request, so it carries its own limit below rather than
 * inheriting the gap.
 */
export const formFillLinksRouter: Router = Router();
export const publicFillRouter: Router = Router();

/** URL-safe crypto-random token, 32 chars base64url (24 random bytes). */
function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

function linkDto(row: typeof schema.fillLinks.$inferSelect) {
  return {
    id: row.id,
    token: row.token,
    /** Path only — the web layer prefixes its own origin. */
    url: `/fill/${row.token}`,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The matrix has no `forms.share`/`forms.manage` action (see
 * `PermissionAction` in @formai/shared), so link create/revoke gates on
 * `forms.edit` — distributing or cutting off a form is a form-management
 * act (owner/admin/builder: true; reviewer/viewer: false by default).
 * Mirrors submissions.ts's `canApproveSubmissions`.
 */
const canManageFillLinks = (tenant: { orgId: string; role: string }) =>
  hasPermission(tenant, 'forms', 'edit');

const createFillLinkBody = z.object({
  /** Optional hard expiry (ISO 8601 with offset); null/omitted = never. */
  expiresAt: z.string().datetime({ offset: true }).nullish(),
});

formFillLinksRouter.post('/:id/fill-links', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canManageFillLinks(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = createFillLinkBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }

  const template = await db.query.formTemplates.findFirst({
    where: and(eq(schema.formTemplates.id, req.params.id!), eq(schema.formTemplates.orgId, tenant.orgId)),
  });
  if (!template) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // An archived form keeps serving its EXISTING links (the public path never
  // reads template status), but minting new distribution for it conflicts
  // with being out of circulation: 409, distinct from form_not_published so
  // the web layer can say "restore this form" instead of "publish it".
  if (template.status === 'archived') {
    res.status(409).json({ error: 'form_archived' });
    return;
  }
  // A link is only mintable against a published current version: 409 (not
  // 400) because the request is well-formed — the *template's state*
  // conflicts with it. `currentVersionId` may point at an unpublished v1
  // draft, so the version's own state is what gets checked.
  const current = template.currentVersionId
    ? await db.query.formTemplateVersions.findFirst({
        where: eq(schema.formTemplateVersions.id, template.currentVersionId),
      })
    : undefined;
  if (!current || current.state !== 'published') {
    res.status(409).json({ error: 'form_not_published' });
    return;
  }

  const [row] = await db
    .insert(schema.fillLinks)
    .values({
      token: generateToken(),
      orgId: tenant.orgId,
      templateId: template.id,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    })
    .returning();
  if (!row) throw new Error('fill_link_create_failed: insert returned no row');

  await recordAudit(db, tenant, {
    action: 'Created fill link',
    target: template.name,
    category: 'forms',
    icon: 'link',
  });

  res.status(201).json(linkDto(row));
}));

formFillLinksRouter.get('/:id/fill-links', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  // The listed rows include each link's token — a bearer credential for the
  // public submit path — so listing is a form-management act, gated on
  // `forms.edit` exactly like create/revoke (owner/admin/builder: true).
  if (!(await canManageFillLinks(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const template = await db.query.formTemplates.findFirst({
    where: and(eq(schema.formTemplates.id, req.params.id!), eq(schema.formTemplates.orgId, tenant.orgId)),
  });
  if (!template) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const rows = await db.query.fillLinks.findMany({
    where: and(eq(schema.fillLinks.templateId, template.id), eq(schema.fillLinks.active, true)),
    orderBy: [desc(schema.fillLinks.createdAt)],
  });
  res.json(rows.map(linkDto));
}));

formFillLinksRouter.delete('/:id/fill-links/:linkId', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canManageFillLinks(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const template = await db.query.formTemplates.findFirst({
    where: and(eq(schema.formTemplates.id, req.params.id!), eq(schema.formTemplates.orgId, tenant.orgId)),
  });
  if (!template) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const link = await db.query.fillLinks.findFirst({
    where: and(
      eq(schema.fillLinks.id, req.params.linkId!),
      eq(schema.fillLinks.templateId, template.id),
      eq(schema.fillLinks.orgId, tenant.orgId),
    ),
  });
  if (!link) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Revoke = flip `active` off (DELETE verb, soft row). The row survives so
  // the org's history stays auditable; publicly the token 404s from now on.
  await db.update(schema.fillLinks).set({ active: false }).where(eq(schema.fillLinks.id, link.id));

  await recordAudit(db, tenant, {
    action: 'Revoked fill link',
    target: template.name,
    category: 'forms',
    icon: 'link-2-off',
  });

  res.json(linkDto({ ...link, active: false }));
}));

/**
 * Resolves an active, unexpired link by token, or null. Unknown, revoked,
 * and expired tokens are DELIBERATELY indistinguishable to the caller (same
 * 404 body) so a token can't be probed for "exists but revoked".
 */
async function resolveLiveLink(token: string) {
  if (!db) return null;
  const link = await db.query.fillLinks.findFirst({
    where: eq(schema.fillLinks.token, token),
  });
  if (!link || !link.active) return null;
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) return null;
  return link;
}

/**
 * Whether the link's org offers Smart Fill: the PLAN must include it AND the
 * org must not have switched voice input off (`branding.voiceInput`, absent
 * meaning on — see BrandingKit).
 *
 * Both public doors read the answer through here so the GET that decides
 * whether to OFFER the mic and the POST that answers it cannot disagree: an
 * entry point that 403s on press is worse than one that was never drawn. An
 * unset or unrecognised tier falls back exactly as `requirePlanFeature` does.
 */
function orgSmartFillEnabled(
  org: { planTier?: string | null; branding?: { voiceInput?: boolean } | null } | undefined,
): boolean {
  if (org?.branding?.voiceInput === false) return false;
  const tier = (org?.planTier ?? 'business') as PlanTier;
  return (PLAN_CONFIG[tier] ?? PLAN_CONFIG.business).features.smartFill;
}

/**
 * Per-org ceiling on the session-less Smart Fill door.
 *
 * This is the first endpoint in the product that spends money with no session
 * behind it: a fill link is a bearer token meant to be emailed, printed on a
 * noticeboard or QR-coded, `expiresAt` may be null forever, and each accepted
 * request bills the distributing org for one model call whose input carries a
 * tool variant per form field. Without a counter, anyone the URL ever reaches
 * can loop it — draining that org's budget and, because the whole deployment
 * shares one memoized Anthropic client, pushing every other tenant's PDF
 * extraction into 429s alongside it.
 *
 * Keyed on the link's ORG, not the caller. `req.ip` is worthless here — the app
 * runs behind `trust proxy: true`, so the client picks its own value — and the
 * token is attacker-chosen key space that would grow this map without bound.
 * The org id is neither: it comes from a row the caller had to hold a live
 * token to reach, and the org is the party actually being billed.
 *
 * The ceiling is deliberately far above real use (one press per respondent per
 * form, spread over the minutes it takes to speak) so a busy crew never meets
 * it, and a 429 degrades to the client's transient branch — the mic stays and
 * the respondent types. Deliberately in-process, matching `scanRateLimited`:
 * this API runs as a single instance today.
 */
const SMART_FILL_WINDOW_MS = 60_000;
export const SMART_FILL_MAX_PER_WINDOW = 30;
const smartFillHits = new Map<string, number[]>();

function smartFillRateLimited(orgId: string, now = Date.now()): boolean {
  const recent = (smartFillHits.get(orgId) ?? []).filter((t) => now - t < SMART_FILL_WINDOW_MS);
  if (recent.length >= SMART_FILL_MAX_PER_WINDOW) {
    smartFillHits.set(orgId, recent);
    return true;
  }
  recent.push(now);
  smartFillHits.set(orgId, recent);
  return false;
}

publicFillRouter.get('/:token', withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const link = await resolveLiveLink(req.params.token!);
  if (!link) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Template and org depend only on the link — fetch together (this is the
  // route every anonymous form load hits).
  const [template, org] = await Promise.all([
    db.query.formTemplates.findFirst({ where: eq(schema.formTemplates.id, link.templateId) }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, link.orgId) }),
  ]);
  // Current published version, resolved NOW — not frozen at link creation.
  const version = template?.currentVersionId
    ? await db.query.formTemplateVersions.findFirst({
        where: eq(schema.formTemplateVersions.id, template.currentVersionId),
      })
    : undefined;
  // A template whose current version stopped being published (or vanished)
  // serves the same opaque 404 as a bad token — nothing to fill.
  if (!template || !version || version.state !== 'published') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Deliberately narrow payload: name + branding + the form itself. No org
  // ids, members, or anything else internal — and `smartFillEnabled` is a bare
  // yes/no, never the tier or the feature map, because it exists only so the
  // anonymous page can decide whether to draw a control, not to describe the
  // org's plan to a stranger.
  //
  // The theme is resolved server-side (org theme <- this form's override) so
  // the public page receives one already-merged object and never has to apply
  // the precedence rule itself.
  //
  // Only included when something actually sets it. An org that has never
  // themed anything keeps the exact payload it had before theming existed —
  // the client resolves absent to defaults either way, so emitting a fully
  // populated theme for every form would be pure wire weight and a silent
  // contract change on the most-hit anonymous route in the product.
  const orgTheme = org?.branding?.theme;
  const formOverride = template.themeOverride;
  const orgBranding = org?.branding
    ? orgTheme || formOverride
      ? { ...org.branding, theme: resolveTheme(orgTheme, formOverride) }
      : org.branding
    : null;

  res.json({
    formName: template.name,
    orgName: org?.name ?? '',
    orgBranding,
    versionId: version.id,
    fields: version.fields,
    container: version.container,
    smartFillEnabled: orgSmartFillEnabled(org),
  });
}));

/**
 * The anonymous door to attachment upload. Mirrors `POST /uploads` exactly —
 * same `storeAttachment`, same limits, same magic-number check — with the link
 * token standing in for the session, as it does for `GET /:token` and the
 * submit below.
 *
 * The org is taken from the LINK, never from the request body: a respondent
 * chooses a file, not a tenant. `resolveLiveLink` also means a revoked or
 * expired link stops accepting uploads at the same moment it stops accepting
 * submissions, rather than leaving a write primitive open behind it.
 *
 * There is deliberately no matching public GET. An anonymous respondent
 * previews their own file from the `File` object the browser already holds, so
 * nothing here hands out a way to read attachments back without a session.
 */
publicFillRouter.post('/:token/uploads', withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const link = await resolveLiveLink(req.params.token!);
  if (!link) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const result = await storeAttachment(link.orgId, req.body);
  if (!result.ok) {
    res.status(result.failure.status).json(result.failure.body);
    return;
  }
  res.status(201).json(result.ref);
}));

const publicSubmitBody = z.object({
  /** The versionId echoed from GET /fill/:token — pins what was filled. */
  versionId: z.string().min(1),
  submitterName: z.string().optional(),
  submitterEmail: z.string().optional(),
  values: z.record(z.string(), submissionValueSchema),
});

publicFillRouter.post('/:token/submissions', withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const link = await resolveLiveLink(req.params.token!);
  if (!link) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const parsed = publicSubmitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }
  const { versionId, submitterName, submitterEmail, values } = parsed.data;

  // Independent lookups — issued together; the 404/409 precedence below is
  // unchanged because both checks run only after both resolve.
  const [template, version] = await Promise.all([
    db.query.formTemplates.findFirst({ where: eq(schema.formTemplates.id, link.templateId) }),
    db.query.formTemplateVersions.findFirst({ where: eq(schema.formTemplateVersions.id, versionId) }),
  ]);
  if (!template) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // The echoed version must be a real version of THIS template. It need not
  // be the current one: a visitor who loaded the form before a newer publish
  // may still submit against the version they actually saw (that's the whole
  // point of pinning). But the public serve side is published-only, so only
  // PUBLISHED versions are honored — a never-published draft was never
  // served to any visitor, so an echoed draft id can only be fabricated. A
  // version of some other template, a fabricated id, or a draft conflicts:
  // 409.
  if (!version || version.templateId !== link.templateId || version.state !== 'published') {
    res.status(409).json({ error: 'version_mismatch' });
    return;
  }

  // Required enforcement (KTD4) against the PINNED version's fields — the
  // form this visitor was actually served. The public path has no draft
  // state: every submit is final, so the gate always runs. Same shared
  // helper as the authed route, so the two doors cannot drift.
  const versionFields = Array.isArray(version.fields) ? version.fields : [];
  const missing = missingRequiredFields(versionFields, values);
  if (missing.length > 0) {
    const incompleteRows = incompleteRowsByField(versionFields, values);
    res.status(400).json({
      error: 'required_fields_missing',
      fields: missing,
      ...(Object.keys(incompleteRows).length > 0 ? { incompleteRows } : {}),
    });
    return;
  }

  // Conditional visibility is enforced HERE, not by the browser (U11). This
  // door's only credential is a link token, so the posted body is the least
  // trusted input in the product: a caller can send answers for a section the
  // form never showed, and an honest filler's draft can carry stale answers
  // from before they changed the source question. Neither reaches the record.
  const { values: recordedValues, discarded } = stripHiddenValues(versionFields, values);

  // The submission row and its audit entry commit together or not at all: a
  // crash between two separate awaits would otherwise record a submission with
  // no audit, or — on a client retry after an audit-only failure — a duplicate
  // submission. One transaction closes both windows (mirrors account.ts's U11).
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.submissions)
      .values({
        orgId: link.orgId,
        templateId: link.templateId,
        templateVersionId: version.id,
        // No session on this public path — no server-verified identity. The
        // claimed free-text name/email below are kept as unverified input.
        submittedByUserId: null,
        submitterName: submitterName ?? '',
        submitterEmail: submitterEmail ?? '',
        values: recordedValues,
        status: 'submitted',
        flag: '',
      })
      .returning();
    if (!inserted) throw new Error('public_submission_create_failed: insert returned no row');

    // recordAudit resolves an actor from tenant.userId — there is no tenant on
    // this path, so insert directly with an honest attribution: no actorId,
    // actorName marks the unauthenticated door; the submitter's claimed name
    // goes in the target (it is unverified input, not an actor).
    //
    // When stripping actually threw something away, the discarded ids are
    // appended to the target. Without that line, a stripping BUG and a filler
    // who simply never answered are indistinguishable in the record — both
    // leave an absence. An audit reader can only investigate what was written
    // down. The suffix is omitted entirely when nothing was discarded, so the
    // overwhelmingly common entry is byte-identical to what it was before.
    const baseTarget = submitterName ? `${template.name}: ${submitterName}` : template.name;
    await tx.insert(schema.auditLogEntries).values({
      orgId: link.orgId,
      actorId: null,
      actorName: 'External fill link',
      action: 'Received external submission',
      target:
        discarded.length > 0
          ? `${baseTarget} (hidden fields not recorded: ${discarded.join(', ')})`
          : baseTarget,
      category: 'submissions',
      icon: 'inbox',
    });

    return inserted;
  });

  res.status(201).json({
    id: row.id,
    status: row.status,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  });
}));

const publicSmartFillBody = z.object({
  /**
   * Transcript only. The form is identified by the token in the path, so a
   * caller cannot hand the model field definitions of its own choosing.
   */
  transcript: smartFillTranscriptSchema,
});

/**
 * Smart Fill on the public path — the paid tier, reached with no session.
 *
 * Plan enforcement is INLINE rather than `requirePlanFeature`, which reads
 * `req.tenant` and so cannot run here at all. The link's `orgId` is the
 * entitlement holder: the respondent is anonymous, but the org that
 * distributed the link is the one paying for the AI call.
 *
 * Fields come from the same version `GET /fill/:token` serves — resolved now,
 * not frozen at link creation — so a mapping's field ids are the ones the
 * respondent's page was rendered from. A client holding a version that has
 * since been replaced is safe by construction: the mapper drops every field id
 * it does not recognise.
 */
publicFillRouter.post('/:token/smart-fill', withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const link = await resolveLiveLink(req.params.token!);
  // Unknown, revoked and expired tokens answer identically to the sibling
  // routes — a probe must not learn that a token once existed.
  if (!link) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const parsed = publicSmartFillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }

  // Counted here, once the request is one that could actually reach the model:
  // a malformed body costs nothing to refuse, and charging it against the org
  // would let a stranger lock out real respondents with junk.
  if (smartFillRateLimited(link.orgId)) {
    res.setHeader('Retry-After', String(Math.ceil(SMART_FILL_WINDOW_MS / 1000)));
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, link.orgId),
  });
  if (!orgSmartFillEnabled(org)) {
    // Names the feature but NOT the tier, and carries no upgrade copy: the
    // authed 403 is addressed to someone who holds the plan, this one to an
    // anonymous respondent who does not. GET /fill/:token discloses the same
    // single boolean and no more, for the same reason.
    res.status(403).json({ error: 'feature_not_available', feature: 'smartFill' });
    return;
  }

  const template = await db.query.formTemplates.findFirst({
    where: eq(schema.formTemplates.id, link.templateId),
  });
  const version = template?.currentVersionId
    ? await db.query.formTemplateVersions.findFirst({
        where: eq(schema.formTemplateVersions.id, template.currentVersionId),
      })
    : undefined;
  // Nothing fillable is nothing to dictate into: same opaque 404 as GET.
  if (!template || !version || version.state !== 'published') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const fields: FormField[] = Array.isArray(version.fields) ? version.fields : [];
  await respondSmartFill(res, { fields, transcript: parsed.data.transcript });
}));
