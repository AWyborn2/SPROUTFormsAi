import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { FormContainer, FormField } from '@formai/shared';
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

formsRouter.get('/:id', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
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
    versions: versions.map((v) => ({
      id: v.id,
      label: v.versionLabel,
      state: v.state,
      fieldCount: v.fields.length,
      publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
      publishedByName: v.publishedBy ? (nameById.get(v.publishedBy) ?? null) : null,
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
  res.status(201).json(dto);
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
  if (template.status !== 'draft') {
    res.status(409).json({ error: 'form_not_draft' });
    return;
  }
  // Drafts CAN have submissions (authed members may fill pre-publish), and
  // submissions.templateId is ON DELETE RESTRICT — pre-check so the caller
  // gets a typed 409 instead of a raw FK error.
  const [submissionsCount] = await db
    .select({ count: count() })
    .from(schema.submissions)
    .where(eq(schema.submissions.templateId, template.id));
  if ((submissionsCount?.count ?? 0) > 0) {
    res.status(409).json({ error: 'form_has_submissions' });
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
      action: 'Deleted form',
      target: template.name,
      category: 'forms',
      icon: 'trash-2',
    });
  });

  res.status(204).end();
}));
