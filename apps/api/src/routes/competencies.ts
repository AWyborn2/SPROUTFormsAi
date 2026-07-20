import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { db } from '../db.js';

/**
 * Competencies and the rules gating a form section behind one. All routes
 * are gated behind the `competencyGating` plan feature (business → enterprise).
 */
export const competenciesRouter: Router = Router();
export const competencyRulesRouter: Router = Router();

competenciesRouter.get(
  '/',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.competencies.findMany({
      where: eq(schema.competencies.orgId, tenant.orgId),
      orderBy: (c, { desc }) => [desc(c.createdAt)],
    });
    res.json(rows.map((c) => ({ id: c.id, name: c.name, code: c.code, holders: c.holders })));
  }),
);

const createCompetencyBody = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  holders: z.number().int().nonnegative().optional(),
});

competenciesRouter.post(
  '/',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = createCompetencyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    const [row] = await db
      .insert(schema.competencies)
      .values({
        orgId: tenant.orgId,
        name: parsed.data.name,
        code: parsed.data.code,
        holders: parsed.data.holders ?? 0,
      })
      .returning();
    if (!row) throw new Error('competency_create_failed: insert returned no row');
    res.status(201).json({ id: row.id, name: row.name, code: row.code, holders: row.holders });
  }),
);

competenciesRouter.delete(
  '/:id',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const row = await db.query.competencies.findFirst({
      where: and(eq(schema.competencies.id, req.params.id!), eq(schema.competencies.orgId, tenant.orgId)),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await db.delete(schema.competencies).where(eq(schema.competencies.id, row.id));
    res.status(204).end();
  }),
);

function ruleDto(
  row: typeof schema.competencyRules.$inferSelect,
  formName: string,
  competencyName: string,
) {
  return {
    id: row.id,
    templateId: row.templateId,
    form: formName,
    sectionRef: row.sectionRef,
    competencyId: row.competencyId,
    competency: competencyName,
    enabled: row.enabled,
  };
}

competencyRulesRouter.get(
  '/',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.competencyRules.findMany({
      where: eq(schema.competencyRules.orgId, tenant.orgId),
    });
    if (rows.length === 0) {
      res.json([]);
      return;
    }
    const templateIds = [...new Set(rows.map((r) => r.templateId))];
    const competencyIds = [...new Set(rows.map((r) => r.competencyId))];
    const [templates, competenciesList] = await Promise.all([
      db.query.formTemplates.findMany({ where: inArray(schema.formTemplates.id, templateIds) }),
      db.query.competencies.findMany({ where: inArray(schema.competencies.id, competencyIds) }),
    ]);
    const templateNameById = new Map(templates.map((t) => [t.id, t.name]));
    const competencyNameById = new Map(competenciesList.map((c) => [c.id, c.name]));

    res.json(
      rows.map((r) =>
        ruleDto(r, templateNameById.get(r.templateId) ?? '', competencyNameById.get(r.competencyId) ?? ''),
      ),
    );
  }),
);

const createRuleBody = z.object({
  templateId: z.string().min(1),
  competencyId: z.string().min(1),
  sectionRef: z.string().min(1),
});

competencyRulesRouter.post(
  '/',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = createRuleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    const { templateId, competencyId, sectionRef } = parsed.data;

    const [template, competency] = await Promise.all([
      db.query.formTemplates.findFirst({
        where: and(eq(schema.formTemplates.id, templateId), eq(schema.formTemplates.orgId, tenant.orgId)),
      }),
      db.query.competencies.findFirst({
        where: and(eq(schema.competencies.id, competencyId), eq(schema.competencies.orgId, tenant.orgId)),
      }),
    ]);
    if (!template) {
      res.status(404).json({ error: 'form_not_found' });
      return;
    }
    if (!competency) {
      res.status(404).json({ error: 'competency_not_found' });
      return;
    }

    const [row] = await db
      .insert(schema.competencyRules)
      .values({ orgId: tenant.orgId, templateId, competencyId, sectionRef, enabled: true })
      .returning();
    if (!row) throw new Error('rule_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Added gating rule',
      target: `${competency.name} → ${sectionRef}`,
      category: 'settings',
      icon: 'graduation-cap',
    });

    res.status(201).json(ruleDto(row, template.name, competency.name));
  }),
);

const patchRuleBody = z.object({
  enabled: z.boolean().optional(),
});

competencyRulesRouter.patch(
  '/:id',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = patchRuleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const tenant = req.tenant!;
    const row = await db.query.competencyRules.findFirst({
      where: and(eq(schema.competencyRules.id, req.params.id!), eq(schema.competencyRules.orgId, tenant.orgId)),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const nextEnabled = parsed.data.enabled ?? !row.enabled;
    await db
      .update(schema.competencyRules)
      .set({ enabled: nextEnabled })
      .where(eq(schema.competencyRules.id, row.id));

    const [template, competency] = await Promise.all([
      db.query.formTemplates.findFirst({ where: eq(schema.formTemplates.id, row.templateId) }),
      db.query.competencies.findFirst({ where: eq(schema.competencies.id, row.competencyId) }),
    ]);
    res.json(ruleDto({ ...row, enabled: nextEnabled }, template?.name ?? '', competency?.name ?? ''));
  }),
);

competencyRulesRouter.delete(
  '/:id',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const row = await db.query.competencyRules.findFirst({
      where: and(eq(schema.competencyRules.id, req.params.id!), eq(schema.competencyRules.orgId, tenant.orgId)),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await db.delete(schema.competencyRules).where(eq(schema.competencyRules.id, row.id));
    res.status(204).end();
  }),
);
