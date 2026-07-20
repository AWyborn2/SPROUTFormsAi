import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { RepeatingRowValue, SubmissionValue } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { db } from '../db.js';

/**
 * Submissions — filled instances of a template's current version, created
 * by authed org members (fill screen, mobile inspection). The external,
 * unauthenticated path writes to the same table via the public fill-link
 * routes (see fill-links.ts), which reuse this file's `submissionValueSchema`.
 */
export const submissionsRouter: Router = Router();

function rowDto(
  row: typeof schema.submissions.$inferSelect,
  formName: string,
  submitterUser?: { id: string; name: string } | null,
) {
  // Server-verified identity (users join) takes display precedence over the
  // free-text submitterName; legacy/public rows fall back to the claimed name.
  const submittedBy = row.submittedByUserId
    ? { userId: row.submittedByUserId, name: submitterUser?.name ?? row.submitterName }
    : null;
  return {
    id: row.id,
    formId: row.templateId,
    form: formName,
    who: submittedBy?.name ?? row.submitterName,
    email: row.submitterEmail,
    status: row.status,
    flag: row.flag,
    createdAt: row.createdAt.toISOString(),
    submittedBy,
  };
}

submissionsRouter.get('/', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  const rows = await db.query.submissions.findMany({
    where: eq(schema.submissions.orgId, tenant.orgId),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });
  if (rows.length === 0) {
    res.json([]);
    return;
  }

  const templateIds = [...new Set(rows.map((r) => r.templateId))];
  const templates = await db.query.formTemplates.findMany({
    where: inArray(schema.formTemplates.id, templateIds),
  });
  const nameById = new Map(templates.map((t) => [t.id, t.name]));

  const submitterIds = [...new Set(rows.map((r) => r.submittedByUserId).filter((id): id is string => !!id))];
  const submitters = submitterIds.length
    ? await db.query.users.findMany({ where: inArray(schema.users.id, submitterIds) })
    : [];
  const userById = new Map(submitters.map((u) => [u.id, u]));

  res.json(
    rows.map((r) =>
      rowDto(r, nameById.get(r.templateId) ?? '', r.submittedByUserId ? userById.get(r.submittedByUserId) : null),
    ),
  );
}));

submissionsRouter.get('/:id', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  const row = await db.query.submissions.findFirst({
    where: and(eq(schema.submissions.id, req.params.id!), eq(schema.submissions.orgId, tenant.orgId)),
  });
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // The pinned version carries the round-trip export handles: the stored
  // source-PDF asset and the frozen fields (whose `sourcePosition`s decide
  // whether the client may offer "Export filled PDF" at all).
  const [template, version, submitterUser] = await Promise.all([
    db.query.formTemplates.findFirst({ where: eq(schema.formTemplates.id, row.templateId) }),
    db.query.formTemplateVersions.findFirst({ where: eq(schema.formTemplateVersions.id, row.templateVersionId) }),
    row.submittedByUserId
      ? db.query.users.findFirst({ where: eq(schema.users.id, row.submittedByUserId) })
      : Promise.resolve(null),
  ]);

  res.json({
    ...rowDto(row, template?.name ?? '', submitterUser),
    templateVersionId: row.templateVersionId,
    values: row.values,
    sourcePdfAssetId: version?.sourcePdfAssetId ?? null,
    fields: version?.fields ?? [],
  });
}));

/** One row of a repeating group: column key -> primitive value. */
const repeatingRowValueSchema: z.ZodType<RepeatingRowValue> = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

/**
 * Runtime mirror of the `SubmissionValue` union in @formai/shared. A
 * `z.custom<SubmissionValue>()` performs NO runtime check — this schema
 * actually rejects nested objects and other non-values, keeping arbitrary
 * JSON out of the `values` JSONB column. Shared with the public fill-link
 * submit route (fill-links.ts).
 */
export const submissionValueSchema: z.ZodType<SubmissionValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(repeatingRowValueSchema),
  z.null(),
]);

const submissionStatuses = [
  'draft',
  'submitted',
  'reviewed',
  'complete',
  'approved',
  'review',
  'rejected',
  'pending',
] as const;

const createSubmissionBody = z.object({
  templateId: z.string().min(1),
  /**
   * The version the client actually rendered — echoed back so the submission
   * pins to what the filler saw, not whatever `currentVersionId` points at by
   * the time the POST lands (mirrors the public fill-link route).
   */
  versionId: z.string().min(1),
  submitterName: z.string().optional(),
  submitterEmail: z.string().optional(),
  values: z.record(z.string(), submissionValueSchema),
  status: z.enum(submissionStatuses).optional(),
  flag: z.string().optional(),
});

submissionsRouter.post('/', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const parsed = createSubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }
  const tenant = req.tenant!;
  // `submitterName`/`submitterEmail` in the body are deliberately ignored on
  // this authed path: identity is server-verified, stamped from the session
  // (AE3 — a client cannot spoof who submitted).
  const { templateId, versionId, values, status, flag } = parsed.data;

  const template = await db.query.formTemplates.findFirst({
    where: and(eq(schema.formTemplates.id, templateId), eq(schema.formTemplates.orgId, tenant.orgId)),
  });
  if (!template) {
    res.status(404).json({ error: 'form_not_found' });
    return;
  }
  if (!template.currentVersionId) {
    res.status(422).json({ error: 'form_not_published' });
    return;
  }

  // The echoed version must be a real version of THIS template. It need not
  // be the current one: a filler who loaded the form before a newer publish
  // may still submit against the version they actually saw (that's the whole
  // point of pinning — AE2). A version of some other template, or a
  // fabricated id, conflicts: 409 (mirrors fill-links.ts).
  const version = await db.query.formTemplateVersions.findFirst({
    where: eq(schema.formTemplateVersions.id, versionId),
  });
  if (!version || version.templateId !== template.id) {
    res.status(409).json({ error: 'version_mismatch' });
    return;
  }

  const sessionUser = await db.query.users.findFirst({
    where: eq(schema.users.id, tenant.userId),
  });
  if (!sessionUser) {
    // Sealed session references a user row that no longer exists — the
    // account is gone, so the session no longer authenticates anyone.
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }

  const [row] = await db
    .insert(schema.submissions)
    .values({
      orgId: tenant.orgId,
      templateId: template.id,
      templateVersionId: version.id,
      submittedByUserId: sessionUser.id,
      submitterName: sessionUser.name,
      submitterEmail: sessionUser.email,
      values,
      status: status ?? 'submitted',
      flag: flag ?? '',
    })
    .returning();
  if (!row) throw new Error('submission_create_failed: insert returned no row');

  res.status(201).json(rowDto(row, template.name, sessionUser));
}));

/**
 * The matrix has no `submissions.approve` action (see `PermissionAction` in
 * @formai/shared), so status transitions gate on `submissions.delete` — the
 * only mutating submissions action in the default matrix (owner/admin: true,
 * builder/reviewer/viewer: false). Mirrors team.ts's `canManageTeam`.
 */
const canApproveSubmissions = (tenant: { orgId: string; role: string }) =>
  hasPermission(tenant, 'submissions', 'delete');

const patchSubmissionBody = z.object({ status: z.enum(['approved', 'rejected']) });

submissionsRouter.patch('/:id', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canApproveSubmissions(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = patchSubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }
  const row = await db.query.submissions.findFirst({
    where: and(eq(schema.submissions.id, req.params.id!), eq(schema.submissions.orgId, tenant.orgId)),
  });
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [template, submitterUser] = await Promise.all([
    db.query.formTemplates.findFirst({ where: eq(schema.formTemplates.id, row.templateId) }),
    row.submittedByUserId
      ? db.query.users.findFirst({ where: eq(schema.users.id, row.submittedByUserId) })
      : Promise.resolve(null),
  ]);
  const { status } = parsed.data;

  await db.update(schema.submissions).set({ status }).where(eq(schema.submissions.id, row.id));

  await recordAudit(db, tenant, {
    action: status === 'approved' ? 'Approved submission' : 'Rejected submission',
    target: template?.name ? `${template.name}: ${row.id}` : row.id,
    category: 'submissions',
    icon: status === 'approved' ? 'check-circle-2' : 'x-circle',
  });

  res.json(rowDto({ ...row, status }, template?.name ?? '', submitterUser));
}));
