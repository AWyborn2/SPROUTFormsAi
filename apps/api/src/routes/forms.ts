import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { FormContainer, FormField, ThemeTokens } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { db } from '../db.js';

/**
 * Form templates + versions, behind the tenant boundary. All queries are
 * scoped by `req.tenant.orgId` — the enforced multi-tenant boundary.
 *
 * Response DTOs are deliberately raw (ISO timestamps, `submissionsCount`,
 * `currentVersionLabel` rather than a display-formatted "2 days ago" string
 * or a decorative icon) — display formatting is a web-layer concern handled
 * by `apps/web/src/lib/data/store.ts`.
 */
export const formsRouter: Router = Router();

function versionLabelFor(existingVersionCount: number): string {
  return `v${existingVersionCount + 1}`;
}

async function summaryDto(templateId: string) {
  if (!db) throw new Error('db_unavailable');
  const template = await db.query.formTemplates.findFirst({
    where: eq(schema.formTemplates.id, templateId),
  });
  if (!template) return null;
  const currentVersion = template.currentVersionId
    ? await db.query.formTemplateVersions.findFirst({
        where: eq(schema.formTemplateVersions.id, template.currentVersionId),
      })
    : undefined;
  const [submissionsCount] = await db
    .select({ count: count() })
    .from(schema.submissions)
    .where(eq(schema.submissions.templateId, templateId));
  return {
    id: template.id,
    name: template.name,
    dept: template.dept ?? '',
    sourceType: template.sourceType,
    status: template.status,
    currentVersionId: template.currentVersionId,
    currentVersionLabel: currentVersion?.versionLabel ?? null,
    submissionsCount: submissionsCount?.count ?? 0,
    updatedAt: template.updatedAt.toISOString(),
  };
}

formsRouter.get('/', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'view'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const templates = await db.query.formTemplates.findMany({
    where: eq(schema.formTemplates.orgId, tenant.orgId),
    orderBy: (t, { desc: descOrder }) => [descOrder(t.updatedAt)],
  });
  if (templates.length === 0) {
    res.json([]);
    return;
  }

  const templateIds = templates.map((t) => t.id);
  const versionIds = templates.map((t) => t.currentVersionId).filter((id): id is string => !!id);
  const versions = versionIds.length
    ? await db.query.formTemplateVersions.findMany({
        where: inArray(schema.formTemplateVersions.id, versionIds),
      })
    : [];
  const versionById = new Map(versions.map((v) => [v.id, v]));

  const counts = await db
    .select({ templateId: schema.submissions.templateId, count: count() })
    .from(schema.submissions)
    .where(inArray(schema.submissions.templateId, templateIds))
    .groupBy(schema.submissions.templateId);
  const countByTemplate = new Map(counts.map((c) => [c.templateId, c.count]));

  /*
    The library filters by OWNER — the person who published the version a form
    currently serves. Resolved here in one batch because a name is the only
    identity the list can show; a draft that has never been published has no
    publisher and stays null rather than guessing at its creator, which the
    template row does not record.
  */
  const publisherIds = [
    ...new Set(versions.map((v) => v.publishedBy).filter((id): id is string => !!id)),
  ];
  const publishers = publisherIds.length
    ? await db.query.users.findMany({ where: inArray(schema.users.id, publisherIds) })
    : [];
  const publisherNameById = new Map(publishers.map((u) => [u.id, u.name || u.email]));

  res.json(
    templates.map((t) => ({
      id: t.id,
      name: t.name,
      dept: t.dept ?? '',
      sourceType: t.sourceType,
      status: t.status,
      currentVersionId: t.currentVersionId,
      currentVersionLabel: t.currentVersionId
        ? (versionById.get(t.currentVersionId)?.versionLabel ?? null)
        : null,
      owner: (() => {
        const publishedBy = t.currentVersionId
          ? versionById.get(t.currentVersionId)?.publishedBy
          : null;
        return publishedBy ? (publisherNameById.get(publishedBy) ?? null) : null;
      })(),
      submissionsCount: countByTemplate.get(t.id) ?? 0,
      updatedAt: t.updatedAt.toISOString(),
    })),
  );
}));

const createFormBody = z.object({
  name: z.string().min(1),
  dept: z.string().optional(),
  sourceType: z.enum(['pdf_import', 'built_from_scratch']),
  fields: z.array(z.custom<FormField>()),
  container: z.custom<FormContainer>().optional(),
  sourcePdfAssetId: z.string().optional(),
  /** Creates the first version already published, not a draft. Defaults to false. */
  publish: z.boolean().optional(),
});

formsRouter.post('/', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const parsed = createFormBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'create'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const { name, dept, sourceType, fields, container, sourcePdfAssetId, publish } = parsed.data;
  const now = new Date();

  const [template] = await db
    .insert(schema.formTemplates)
    .values({
      orgId: tenant.orgId,
      name,
      dept: dept ?? null,
      sourceType,
      status: publish ? 'published' : 'draft',
    })
    .returning();
  if (!template) throw new Error('form_create_failed: template insert returned no row');

  const [version] = await db
    .insert(schema.formTemplateVersions)
    .values({
      templateId: template.id,
      versionLabel: versionLabelFor(0),
      state: publish ? 'published' : 'draft',
      fields,
      ...(container ? { container } : {}),
      sourcePdfAssetId: sourcePdfAssetId ?? null,
      publishedAt: publish ? now : null,
      publishedBy: publish ? tenant.userId : null,
    })
    .returning();
  if (!version) throw new Error('form_create_failed: version insert returned no row');

  await db
    .update(schema.formTemplates)
    .set({ currentVersionId: version.id, updatedAt: now })
    .where(eq(schema.formTemplates.id, template.id));

  res.status(201).json({
    id: template.id,
    name: template.name,
    dept: template.dept ?? '',
    sourceType: template.sourceType,
    status: publish ? 'published' : 'draft',
    currentVersionId: version.id,
    currentVersionLabel: version.versionLabel,
    submissionsCount: 0,
    updatedAt: now.toISOString(),
  });
}));

/*
  THIS RESPONSE CARRIES ANSWER KEYS. `fields` below is the published version's
  field list verbatim, and a theory question's `answerKey` lives on the field.
  The two surfaces a candidate legitimately reads — the part-fill payload and a
  public fill link — both launder it through `stripMarkingSecrets`; this one
  cannot, because the builder and the placement editor need the whole field.

  So the gate IS the protection. A candidate's forms matrix is entirely false,
  which is what excludes them. Do not relax this to `requireTenant` alone: org
  membership is not the boundary here, the answers to a safety assessment are.
*/
formsRouter.get('/:id', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'view'))) {
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

  const versions = await db.query.formTemplateVersions.findMany({
    where: eq(schema.formTemplateVersions.templateId, template.id),
    orderBy: (v, { desc: descOrder }) => [descOrder(v.createdAt)],
  });
  const current =
    versions.find((v) => v.id === template.currentVersionId) ?? versions[0];

  const [submissionsCount] = await db
    .select({ count: count() })
    .from(schema.submissions)
    .where(eq(schema.submissions.templateId, template.id));

  const publisherIds = [...new Set(versions.map((v) => v.publishedBy).filter((id): id is string => !!id))];
  const publishers = publisherIds.length
    ? await db.query.users.findMany({ where: inArray(schema.users.id, publisherIds) })
    : [];
  const nameById = new Map(publishers.map((u) => [u.id, u.name]));

  res.json({
    id: template.id,
    name: template.name,
    dept: template.dept ?? '',
    sourceType: template.sourceType,
    status: template.status,
    currentVersionId: template.currentVersionId,
    currentVersionLabel: current?.versionLabel ?? null,
    submissionsCount: submissionsCount?.count ?? 0,
    updatedAt: template.updatedAt.toISOString(),
    fields: current?.fields ?? [],
    container: current?.container,
    /** Sparse per-form patch over the org theme; null when never restyled. */
    themeOverride: template.themeOverride ?? null,
    /**
     * The brand this form is presented in — usually a client's. Null means the
     * org's own theme, which is the fallback for a form nobody has assigned,
     * NOT a claim that the form is ours.
     */
    brandId: template.brandId ?? null,
    /** Per-form voice override; null means inherit the workspace default. */
    voiceInput: template.voiceInput ?? null,
    versions: versions.map((v) => ({
      id: v.id,
      label: v.versionLabel,
      state: v.state,
      fieldCount: v.fields.length,
      publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
      publishedByName: v.publishedBy ? (nameById.get(v.publishedBy) ?? null) : null,
      /** The paper document's revision identity — null on plain-form versions. */
      revisionIdentity: v.revisionIdentity ?? null,
      note: v.revisionIdentity?.note ?? null,
    })),
  });
}));

const addVersionBody = z.object({
  fields: z.array(z.custom<FormField>()),
  container: z.custom<FormContainer>().optional(),
  /** Replaces the inherited source PDF — set by re-extract, which imports an updated PDF. */
  sourcePdfAssetId: z.string().optional(),
  /** Publishes this version immediately and marks the template published. Defaults to false (fork a draft). */
  publish: z.boolean().optional(),
});

formsRouter.post('/:id/versions', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  // Creating a version can publish (flipping every live fill link) — the same
  // act the per-version publish endpoint gates, so both doors gate alike.
  if (!(await hasPermission(tenant, 'forms', 'edit'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = addVersionBody.safeParse(req.body);
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

  const { fields, container, sourcePdfAssetId, publish } = parsed.data;
  const now = new Date();
  const existingVersionCount = await db
    .select({ count: count() })
    .from(schema.formTemplateVersions)
    .where(eq(schema.formTemplateVersions.templateId, template.id));

  // Carry the round-trip export handle forward: republishing an imported form
  // must not orphan the stored source PDF (the new version inherits it from
  // the previous current version; forms that never had one stay null). The
  // body's sourcePdfAssetId overrides — re-extract carries a NEW pdf. The
  // container inherits the same way: the import wizard sends none, and a
  // re-extracted version must not reset builder-customized styling to the
  // DB default.
  const previousCurrent = template.currentVersionId
    ? await db.query.formTemplateVersions.findFirst({
        where: eq(schema.formTemplateVersions.id, template.currentVersionId),
      })
    : undefined;
  const inheritedContainer = container ?? previousCurrent?.container;

  const [version] = await db
    .insert(schema.formTemplateVersions)
    .values({
      templateId: template.id,
      versionLabel: versionLabelFor(existingVersionCount[0]?.count ?? 0),
      state: publish ? 'published' : 'draft',
      fields,
      ...(inheritedContainer ? { container: inheritedContainer } : {}),
      sourcePdfAssetId: sourcePdfAssetId ?? previousCurrent?.sourcePdfAssetId ?? null,
      publishedAt: publish ? now : null,
      publishedBy: publish ? tenant.userId : null,
    })
    .returning();
  if (!version) throw new Error('version_create_failed: insert returned no row');

  // A forked draft only replaces `currentVersionId` once it's actually
  // published — otherwise `GET /forms/:id` (and submission time, which pins
  // to `currentVersionId`) would start serving unfrozen, work-in-progress
  // fields in place of the still-live published version.
  await db
    .update(schema.formTemplates)
    .set({
      ...(publish ? { currentVersionId: version.id, status: 'published' as const } : {}),
      updatedAt: now,
    })
    .where(eq(schema.formTemplates.id, template.id));

  const dto = await summaryDto(template.id);
  // The new version's id, so a caller that forked a draft in order to edit it
  // can go straight there instead of guessing which version it just made.
  res.status(201).json({ ...dto, createdVersionId: version.id });
}));

/**
 * One version's own fields — the geometry editor's read side.
 *
 * `GET /forms/:id` serves the CURRENT version, which is the wrong answer while
 * editing a draft fork. This serves whichever version is asked for, plus the
 * source PDF handle, because placing boxes needs the page images to draw on.
 */
formsRouter.get('/:id/versions/:versionId', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'view'))) {
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
  const version = await db.query.formTemplateVersions.findFirst({
    where: eq(schema.formTemplateVersions.id, req.params.versionId!),
  });
  // The template scopes the org; this scopes the version to the template, so a
  // version id from another form is a miss rather than a cross-form read.
  if (!version || version.templateId !== template.id) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  res.json({
    id: version.id,
    templateId: version.templateId,
    label: version.versionLabel,
    state: version.state,
    isCurrent: template.currentVersionId === version.id,
    fields: version.fields ?? [],
    container: version.container,
    sourcePdfAssetId: version.sourcePdfAssetId,
    revisionIdentity: version.revisionIdentity ?? null,
  });
}));

const patchVersionBody = z.object({ fields: z.array(z.custom<FormField>()) });

/**
 * Rewrite a DRAFT version's fields.
 *
 * This exists so geometry can be placed on an existing form without
 * re-importing it. Re-importing re-extracts, which re-assigns every field id —
 * and an assessment tool's manifest, answer keys and outcome targets are all
 * keyed to those ids, so a re-import silently invalidates the lot. Forking the
 * published version into a draft preserves the ids; only placement changes.
 *
 * A PUBLISHED version is refused outright. Submissions pin to a version, so
 * rewriting one rewrites what already-signed records render against — the same
 * rule the schema states on `fields`. Publish the draft instead, which is an
 * ordinary new version and leaves the old one intact.
 */
formsRouter.patch('/:id/versions/:versionId', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'edit'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = patchVersionBody.safeParse(req.body);
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
  const version = await db.query.formTemplateVersions.findFirst({
    where: eq(schema.formTemplateVersions.id, req.params.versionId!),
  });
  if (!version || version.templateId !== template.id) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (version.state === 'published') {
    res.status(409).json({ error: 'version_published' });
    return;
  }

  await db
    .update(schema.formTemplateVersions)
    .set({ fields: parsed.data.fields })
    .where(eq(schema.formTemplateVersions.id, version.id));

  await db
    .update(schema.formTemplates)
    .set({ updatedAt: new Date() })
    .where(eq(schema.formTemplates.id, template.id));

  res.json({ id: version.id, state: version.state, fieldCount: parsed.data.fields.length });
}));

formsRouter.post('/:id/versions/:versionId/publish', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'edit'))) {
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
  const version = await db.query.formTemplateVersions.findFirst({
    where: and(
      eq(schema.formTemplateVersions.id, req.params.versionId!),
      eq(schema.formTemplateVersions.templateId, template.id),
    ),
  });
  if (!version) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (version.state === 'published') {
    res.status(409).json({ error: 'version_already_published' });
    return;
  }

  const now = new Date();
  await db
    .update(schema.formTemplateVersions)
    .set({ state: 'published', publishedAt: now, publishedBy: tenant.userId })
    .where(eq(schema.formTemplateVersions.id, version.id));
  // Publishing on an archived template restores it — deliberate (blocking
  // would strand builder and re-extract sessions); the web layer warns.
  await db
    .update(schema.formTemplates)
    .set({ currentVersionId: version.id, status: 'published', updatedAt: now })
    .where(eq(schema.formTemplates.id, template.id));

  await recordAudit(db, tenant, {
    action: 'Published version',
    target: `${template.name} ${version.versionLabel}`,
    category: 'forms',
    icon: 'rocket',
  });

  const dto = await summaryDto(template.id);
  res.json(dto);
}));

/**
 * Per-form theme override (R14). A sparse patch over the org theme where an
 * absent key means inherit; `null` clears the override entirely and returns
 * the form to the org theme.
 *
 * Deliberately a template-level mutation rather than a new version: restyling
 * a live form should take effect immediately, not wait for a republish, and
 * should not fork the field content into a new version row.
 */
const themeOverrideBody = z.object({
  themeOverride: z.custom<ThemeTokens>().nullable(),
});

formsRouter.patch('/:id/theme', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'edit'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = themeOverrideBody.safeParse(req.body);
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

  await db
    .update(schema.formTemplates)
    .set({ themeOverride: parsed.data.themeOverride, updatedAt: new Date() })
    .where(eq(schema.formTemplates.id, template.id));

  await recordAudit(db, tenant, {
    action: parsed.data.themeOverride ? 'Updated form theme' : 'Reset form theme',
    target: template.name,
    category: 'forms',
    icon: 'settings',
  });

  res.json({ id: template.id, themeOverride: parsed.data.themeOverride });
}));

/**
 * The brand a form is presented in. Same shape and same reasoning as the theme
 * override above — on the mutable template so a rebrand reaches live fill links
 * without a republish — with one addition: the brand must belong to THIS org.
 *
 * That check is the whole reason this is a route of its own rather than another
 * key on the theme body. A brand id is a foreign key an attacker supplies, and
 * without the check a caller could point their form at another org's brand and
 * read that org's client colours and logo straight off their own fill page.
 * `set null` on delete makes the column forgiving; it does not make it open.
 */
const brandBody = z.object({
  brandId: z.string().uuid().nullable(),
});

formsRouter.patch('/:id/brand', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'edit'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = brandBody.safeParse(req.body);
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

  let brandName: string | null = null;
  if (parsed.data.brandId) {
    const brand = await db.query.formBrands.findFirst({
      where: and(
        eq(schema.formBrands.id, parsed.data.brandId),
        eq(schema.formBrands.orgId, tenant.orgId),
      ),
    });
    if (!brand) {
      // Deliberately the same 404 an unknown id gets: another org's brand and
      // a brand that does not exist must be indistinguishable from here, or
      // this endpoint becomes a way to enumerate who else uses the product.
      res.status(404).json({ error: 'brand_not_found' });
      return;
    }
    brandName = brand.name;
  }

  await db
    .update(schema.formTemplates)
    .set({ brandId: parsed.data.brandId, updatedAt: new Date() })
    .where(eq(schema.formTemplates.id, template.id));

  await recordAudit(db, tenant, {
    action: brandName ? `Set form brand to ${brandName}` : 'Cleared form brand',
    target: template.name,
    category: 'forms',
    icon: 'palette',
  });

  res.json({ id: template.id, brandId: parsed.data.brandId });
}));

/**
 * Per-form voice-input override — the same shape as the theme override above:
 * on the mutable template (live links react immediately, no republish), null
 * meaning "inherit the workspace default". Enforcement reads it through
 * `resolveVoiceInput`; this endpoint only stores the choice.
 */
const voiceInputBody = z.object({
  voiceInput: z.boolean().nullable(),
});

formsRouter.patch('/:id/voice-input', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'edit'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = voiceInputBody.safeParse(req.body);
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

  await db
    .update(schema.formTemplates)
    .set({ voiceInput: parsed.data.voiceInput, updatedAt: new Date() })
    .where(eq(schema.formTemplates.id, template.id));

  await recordAudit(db, tenant, {
    action:
      parsed.data.voiceInput === null
        ? 'Reset form voice input to workspace default'
        : parsed.data.voiceInput
          ? 'Enabled voice input for form'
          : 'Disabled voice input for form',
    target: template.name,
    category: 'forms',
    icon: 'settings',
  });

  res.json({ id: template.id, voiceInput: parsed.data.voiceInput });
}));

formsRouter.post('/:id/archive', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'edit'))) {
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
  if (template.status === 'archived') {
    res.status(409).json({ error: 'form_archived' });
    return;
  }

  // Metadata-only status flip: currentVersionId and version rows stay
  // untouched, which is what keeps existing fill links serving (the public
  // fill path checks only the version's state, never template status).
  await db
    .update(schema.formTemplates)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(schema.formTemplates.id, template.id));

  await recordAudit(db, tenant, {
    action: 'Archived form',
    target: template.name,
    category: 'forms',
    icon: 'archive',
  });

  const dto = await summaryDto(template.id);
  res.json(dto);
}));

formsRouter.post('/:id/restore', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'edit'))) {
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
  if (template.status !== 'archived') {
    res.status(409).json({ error: 'form_not_archived' });
    return;
  }

  // Restore returns the form to its prior effective status, inferred from
  // the current version's state (never-published forms go back to draft).
  const current = template.currentVersionId
    ? await db.query.formTemplateVersions.findFirst({
        where: eq(schema.formTemplateVersions.id, template.currentVersionId),
      })
    : undefined;
  const nextStatus = current?.state === 'published' ? ('published' as const) : ('draft' as const);

  await db
    .update(schema.formTemplates)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(schema.formTemplates.id, template.id));

  await recordAudit(db, tenant, {
    action: 'Restored form',
    target: template.name,
    category: 'forms',
    icon: 'archive-restore',
  });

  const dto = await summaryDto(template.id);
  res.json(dto);
}));

formsRouter.delete('/:id', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'forms', 'delete'))) {
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
  /*
    WHAT MAKES A FORM UNDELETABLE IS ITS RECORDS, NOT ITS STATUS.

    This used to refuse anything that was not a draft. That was stricter than
    the danger warrants and it had no way out: a published form could only be
    archived, and an ARCHIVED form offered only Restore — so a form published
    once was permanent, and a workspace doing repeated end-to-end runs
    accumulated test forms it could never clear.

    The real hazards are the two below, and both are already enforced by the
    database — `submissions.templateId` and `assessmentCases.toolId` are each
    ON DELETE RESTRICT. They are pre-checked here only so the caller gets a
    sentence instead of a foreign-key violation.

    What is LOST rather than refused: a fill link stops resolving, because
    `formFillLinks` cascades. That is visible before the fact (the library
    shows a form's fill count) and the confirm dialog says so, which is the
    right trade for a form nobody has filled. Archive remains for keeping one.
  */
  const [submissionsCount] = await db
    .select({ count: count() })
    .from(schema.submissions)
    .where(eq(schema.submissions.templateId, template.id));
  if ((submissionsCount?.count ?? 0) > 0) {
    res.status(409).json({ error: 'form_has_submissions' });
    return;
  }

  /*
    An assessment CASE is a competency record — attempts, marks, sign-offs.
    `assessmentTools.templateId` cascades from this row, so deleting the
    template would take the tool, and the case's `restrict` would abort the
    whole statement. Refusing here names the reason instead.
  */
  const [casesCount] = await db
    .select({ count: count() })
    .from(schema.assessmentCases)
    .innerJoin(schema.assessmentTools, eq(schema.assessmentCases.toolId, schema.assessmentTools.id))
    .where(eq(schema.assessmentTools.templateId, template.id));
  if ((casesCount?.count ?? 0) > 0) {
    res.status(409).json({ error: 'form_has_assessment_cases' });
    return;
  }

  const actor = await db.query.users.findFirst({ where: eq(schema.users.id, tenant.userId) });
  // The one irreversible mutation in this router: the delete and its audit
  // entry commit together or not at all (recordAudit needs the root Db, so
  // the entry is inserted directly — mirrors the public-submit precedent).
  await db.transaction(async (tx) => {
    await tx.delete(schema.formTemplates).where(eq(schema.formTemplates.id, template.id));
    await tx.insert(schema.auditLogEntries).values({
      orgId: tenant.orgId,
      actorId: tenant.userId,
      actorName: actor?.name ?? 'System',
      action: template.status === 'draft' ? 'Deleted draft form' : 'Deleted form',
      target: template.name,
      category: 'forms',
      icon: 'trash-2',
    });
  });

  res.status(204).end();
}));
