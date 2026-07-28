import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  ASSESSMENT_PATHWAYS,
  NS_DISPOSITIONS,
  caseProgress,
  isCaseCompetent,
  markTheory,
  orderedParts,
  requiredParts,
  totalLoggedHours,
  validateAnswerKeys,
  validateManifest,
  type AssessmentPathway,
  type AssessmentToolManifest,
  type AttemptFact,
  type FormField,
  type RepeatingRowValue,
  type SubmissionValue,
} from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission, permissionScope } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { db } from '../db.js';

/**
 * Multi-part assessment cases.
 *
 * Three ideas carry this router.
 *
 * 1. ATTEMPTS ARE ROWS. A retry allocates the next attempt number and leaves
 *    the failed row untouched. Nothing here ever mutates a resolved attempt, so
 *    the audit trail keeps every failure while the evidence document renders
 *    the passing one.
 *
 * 2. PROGRESS IS DERIVED. Part state comes from `caseProgress` over the attempt
 *    rows, never from a stored status column. A stored copy is a second source
 *    of truth that can disagree with the rows it summarises.
 *
 * 3. THE SYSTEM RECORDS DECISIONS, IT DOES NOT MAKE THEM. Every discretionary
 *    branch — a not-satisfactory disposition, starting a demonstration below an
 *    hours minimum, proceeding past an unmet prerequisite — demands a recorded
 *    reason and then does what the assessor asked. The one exception is a
 *    theory outcome, which is computed from the answer key and reviewed rather
 *    than entered.
 */
export const assessmentToolsRouter: Router = Router();
export const assessmentCasesRouter: Router = Router();

const GATE = [requireTenant, requirePlanFeature('assessments')] as const;

/** The column a logbook part's duration lives in. */
const DURATION_COLUMN = 'duration';

// ── shared helpers ──────────────────────────────────────────────────────────

type Database = NonNullable<typeof db>;

async function loadTool(database: Database, toolId: string, orgId: string) {
  return (
    (await database.query.assessmentTools.findFirst({
      where: and(eq(schema.assessmentTools.id, toolId), eq(schema.assessmentTools.orgId, orgId)),
    })) ?? null
  );
}

async function loadCase(database: Database, caseId: string, orgId: string) {
  return (
    (await database.query.assessmentCases.findFirst({
      where: and(eq(schema.assessmentCases.id, caseId), eq(schema.assessmentCases.orgId, orgId)),
    })) ?? null
  );
}

async function attemptsFor(database: Database, caseId: string) {
  return database.query.assessmentPartAttempts.findMany({
    where: eq(schema.assessmentPartAttempts.caseId, caseId),
    orderBy: (a, { asc }) => [asc(a.partKey), asc(a.attemptNumber)],
  });
}

/** The fields of the version this attempt is pinned to. */
async function fieldsForVersion(database: Database, versionId: string): Promise<FormField[]> {
  const version = await database.query.formTemplateVersions.findFirst({
    where: eq(schema.formTemplateVersions.id, versionId),
  });
  return version?.fields ?? [];
}

/**
 * Competency ids the user does NOT hold, from a required list.
 *
 * Returned as warnings, never as a refusal — an out-of-date competency record
 * is far more common than an unqualified person, and blocking on it would stop
 * real assessments over stale data entry. The unmet list is recorded on the
 * case so the gap is visible afterwards.
 */
async function unmetPrerequisites(
  database: Database,
  orgId: string,
  userId: string | null,
  requiredIds: readonly string[],
): Promise<string[]> {
  if (!userId || requiredIds.length === 0) return [];
  const held = await database.query.competencyHolders.findMany({
    where: and(
      eq(schema.competencyHolders.userId, userId),
      eq(schema.competencyHolders.orgId, orgId),
    ),
  });
  const heldIds = new Set(held.map((h) => h.competencyId));
  return requiredIds.filter((id) => !heldIds.has(id));
}

function toAttemptFacts(rows: { partKey: string; attemptNumber: number; outcome: string | null }[]): AttemptFact[] {
  return rows.map((r) => ({
    partKey: r.partKey,
    attemptNumber: r.attemptNumber,
    outcome: (r.outcome as AttemptFact['outcome']) ?? null,
  }));
}

// ── assessment tools ────────────────────────────────────────────────────────

const partSchema = z.object({
  key: z.string().min(1),
  ordinal: z.number().int().positive(),
  label: z.string().min(1),
  kind: z.enum(['theory', 'practical', 'logbook']),
  pathways: z.array(z.enum(ASSESSMENT_PATHWAYS)).min(1),
  startFieldId: z.string().min(1),
  minimumHours: z.number().positive().optional(),
  checklistFieldId: z.string().optional(),
  mandatorySectionFieldId: z.string().optional(),
});

const toolBody = z.object({
  templateId: z.string().uuid(),
  name: z.string().min(1),
  manifest: z.object({ parts: z.array(partSchema).min(1) }),
  candidatePrerequisiteIds: z.array(z.string().uuid()).optional(),
  assessorCompetencyIds: z.array(z.string().uuid()).optional(),
});

/**
 * Create an assessment tool over a published template.
 *
 * The manifest is validated against the template's ACTUAL fields, not accepted
 * on trust: a part whose start field is not a section header in that version
 * would contribute no values and export as a silently blank part.
 */
assessmentToolsRouter.post(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'create'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = toolBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { templateId, name, manifest } = parsed.data;

    const template = await db.query.formTemplates.findFirst({
      where: and(
        eq(schema.formTemplates.id, templateId),
        eq(schema.formTemplates.orgId, tenant.orgId),
      ),
    });
    if (!template?.currentVersionId) {
      res.status(404).json({ error: 'template_not_found' });
      return;
    }

    const fields = await fieldsForVersion(db, template.currentVersionId);
    const problems = [
      ...validateManifest(manifest as AssessmentToolManifest, fields),
      ...validateAnswerKeys(fields),
    ];
    if (problems.length > 0) {
      res.status(400).json({ error: 'invalid_manifest', problems });
      return;
    }

    const [row] = await db
      .insert(schema.assessmentTools)
      .values({
        orgId: tenant.orgId,
        templateId,
        name,
        manifest: manifest as AssessmentToolManifest,
        candidatePrerequisiteIds: parsed.data.candidatePrerequisiteIds ?? [],
        assessorCompetencyIds: parsed.data.assessorCompetencyIds ?? [],
      })
      .returning();
    if (!row) throw new Error('tool_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Created assessment tool',
      target: name,
      category: 'forms',
      icon: 'clipboard-check',
    });

    res.status(201).json({ id: row.id, name: row.name, templateId: row.templateId });
  }),
);

assessmentToolsRouter.get(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const rows = await db.query.assessmentTools.findMany({
      where: eq(schema.assessmentTools.orgId, tenant.orgId),
    });
    res.json(
      rows.map((t) => ({
        id: t.id,
        name: t.name,
        templateId: t.templateId,
        parts: orderedParts(t.manifest).map((p) => ({ key: p.key, label: p.label, kind: p.kind })),
      })),
    );
  }),
);

// ── cases ───────────────────────────────────────────────────────────────────

const createCaseBody = z.object({
  toolId: z.string().uuid(),
  candidateUserId: z.string().uuid(),
  assessorUserId: z.string().uuid().optional(),
  pathway: z.enum(ASSESSMENT_PATHWAYS),
  locationStream: z.string().optional(),
  rplJustification: z.string().min(1).optional(),
});

assessmentCasesRouter.post(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'create'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = createCaseBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { toolId, candidateUserId, pathway, locationStream, rplJustification } = parsed.data;
    const assessorUserId = parsed.data.assessorUserId ?? tenant.userId;

    // RPL waives the logged-hours parts, so the reason it was granted is the
    // only record of WHY they were skipped. Without it the case looks
    // indistinguishable from an experienced one.
    if (pathway === 'rpl' && !rplJustification) {
      res.status(400).json({ error: 'rpl_justification_required' });
      return;
    }

    const tool = await loadTool(db, toolId, tenant.orgId);
    if (!tool) {
      res.status(404).json({ error: 'tool_not_found' });
      return;
    }

    const template = await db.query.formTemplates.findFirst({
      where: eq(schema.formTemplates.id, tool.templateId),
    });
    if (!template?.currentVersionId) {
      res.status(409).json({ error: 'template_not_published' });
      return;
    }

    const [candidateGaps, assessorGaps] = await Promise.all([
      unmetPrerequisites(db, tenant.orgId, candidateUserId, tool.candidatePrerequisiteIds),
      unmetPrerequisites(db, tenant.orgId, assessorUserId, tool.assessorCompetencyIds),
    ]);
    const warnings = [
      ...candidateGaps.map((id) => `candidate missing competency ${id}`),
      ...assessorGaps.map((id) => `assessor missing competency ${id}`),
    ];

    const [row] = await db
      .insert(schema.assessmentCases)
      .values({
        orgId: tenant.orgId,
        toolId,
        candidateUserId,
        assessorUserId,
        pathway,
        locationStream: locationStream ?? null,
        currentVersionId: template.currentVersionId,
        rplJustification: rplJustification ?? null,
        prerequisiteWarnings: warnings,
      })
      .returning();
    if (!row) throw new Error('case_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Opened assessment case',
      target: `${tool.name} → ${candidateUserId}`,
      category: 'submissions',
      icon: 'clipboard-check',
    });

    res.status(201).json({
      id: row.id,
      pathway: row.pathway,
      state: row.state,
      prerequisiteWarnings: warnings,
      parts: requiredParts(tool.manifest, pathway).map((p) => p.key),
    });
  }),
);

/**
 * Cases the caller may see.
 *
 * An `own` scope filters SERVER-SIDE by candidate. Filtering in the client
 * would ship every case in the org to a candidate's browser and rely on the UI
 * to hide them, which is not access control.
 */
assessmentCasesRouter.get(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const scope = await permissionScope(tenant, 'assessments', 'view');
    if (scope === 'none') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const rows = await db.query.assessmentCases.findMany({
      where:
        scope === 'own'
          ? and(
              eq(schema.assessmentCases.orgId, tenant.orgId),
              eq(schema.assessmentCases.candidateUserId, tenant.userId),
            )
          : eq(schema.assessmentCases.orgId, tenant.orgId),
      orderBy: (c) => [desc(c.createdAt)],
    });

    const toolIds = [...new Set(rows.map((r) => r.toolId))];
    const tools = toolIds.length
      ? await db.query.assessmentTools.findMany({
          where: inArray(schema.assessmentTools.id, toolIds),
        })
      : [];
    const toolById = new Map(tools.map((t) => [t.id, t]));

    res.json(
      rows.map((c) => ({
        id: c.id,
        toolName: toolById.get(c.toolId)?.name ?? '',
        candidateUserId: c.candidateUserId,
        pathway: c.pathway,
        state: c.state,
        createdAt: c.createdAt,
      })),
    );
  }),
);

assessmentCasesRouter.get(
  '/:id',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const scope = await permissionScope(tenant, 'assessments', 'view');
    if (scope === 'none') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const row = await loadCase(db, req.params.id!, tenant.orgId);
    // A candidate asking for someone else's case gets 404, not 403: 403 would
    // confirm the case exists, which is itself a disclosure.
    if (!row || (scope === 'own' && row.candidateUserId !== tenant.userId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }

    const attempts = await attemptsFor(db, row.id);
    const progress = caseProgress(tool.manifest, row.pathway as AssessmentPathway, toAttemptFacts(attempts));

    res.json({
      id: row.id,
      toolId: tool.id,
      toolName: tool.name,
      candidateUserId: row.candidateUserId,
      assessorUserId: row.assessorUserId,
      pathway: row.pathway,
      locationStream: row.locationStream,
      state: row.state,
      currentVersionId: row.currentVersionId,
      prerequisiteWarnings: row.prerequisiteWarnings,
      appealOfCaseId: row.appealOfCaseId,
      parts: progress.map((p) => ({
        key: p.part.key,
        label: p.part.label,
        kind: p.part.kind,
        ordinal: p.part.ordinal,
        minimumHours: p.part.minimumHours ?? null,
        state: p.state,
        attempts: p.attempts,
        latestOutcome: p.latestOutcome,
      })),
      attempts: attempts.map((a) => ({
        id: a.id,
        partKey: a.partKey,
        attemptNumber: a.attemptNumber,
        outcome: a.outcome,
        disposition: a.disposition,
        dispositionReason: a.dispositionReason,
        templateVersionId: a.templateVersionId,
        signedAt: a.signedAt,
      })),
    });
  }),
);

const pathwayBody = z.object({
  pathway: z.enum(ASSESSMENT_PATHWAYS),
  reason: z.string().min(1),
  rplJustification: z.string().min(1).optional(),
});

/**
 * Change a case's pathway mid-flight.
 *
 * Completed attempts are left alone — moving an experienced candidate onto the
 * longer pathway must not discard the theory they already passed.
 */
assessmentCasesRouter.patch(
  '/:id/pathway',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = pathwayBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (parsed.data.pathway === 'rpl' && !parsed.data.rplJustification) {
      res.status(400).json({ error: 'rpl_justification_required' });
      return;
    }

    await db
      .update(schema.assessmentCases)
      .set({
        pathway: parsed.data.pathway,
        ...(parsed.data.rplJustification ? { rplJustification: parsed.data.rplJustification } : {}),
      })
      .where(eq(schema.assessmentCases.id, row.id));

    await recordAudit(db, tenant, {
      action: 'Changed assessment pathway',
      target: `${row.id}: ${row.pathway} → ${parsed.data.pathway} (${parsed.data.reason})`,
      category: 'submissions',
      icon: 'route',
    });

    const tool = await loadTool(db, row.toolId, tenant.orgId);
    res.json({
      id: row.id,
      pathway: parsed.data.pathway,
      parts: tool ? requiredParts(tool.manifest, parsed.data.pathway).map((p) => p.key) : [],
    });
  }),
);

// ── attempts ────────────────────────────────────────────────────────────────

/**
 * Open an attempt at a part.
 *
 * Refuses a locked part — the sequence exists so a final demonstration cannot
 * happen before the hours it depends on are logged. A part that already passed
 * is also refused: re-opening it would put a second satisfactory attempt on the
 * record with nothing to say which is authoritative.
 */
assessmentCasesRouter.post(
  '/:id/parts/:partKey/attempts',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }

    const partKey = req.params.partKey!;
    const attempts = await attemptsFor(db, row.id);
    const progress = caseProgress(tool.manifest, row.pathway as AssessmentPathway, toAttemptFacts(attempts));
    const target = progress.find((p) => p.part.key === partKey);

    if (!target) {
      res.status(400).json({ error: 'part_not_in_pathway' });
      return;
    }
    if (target.state === 'locked') {
      res.status(409).json({ error: 'part_locked' });
      return;
    }
    if (target.state === 'satisfactory') {
      res.status(409).json({ error: 'part_already_satisfied' });
      return;
    }

    const mine = attempts.filter((a) => a.partKey === partKey);
    const open = mine.find((a) => a.outcome === null);
    if (open) {
      res.status(200).json({ id: open.id, attemptNumber: open.attemptNumber, reused: true });
      return;
    }

    const [created] = await db
      .insert(schema.assessmentPartAttempts)
      .values({
        orgId: tenant.orgId,
        caseId: row.id,
        partKey,
        attemptNumber: mine.length + 1,
        templateVersionId: row.currentVersionId,
      })
      .returning();
    if (!created) throw new Error('attempt_create_failed: insert returned no row');

    res.status(201).json({ id: created.id, attemptNumber: created.attemptNumber, reused: false });
  }),
);

const saveValuesBody = z.object({ values: z.record(z.string(), z.unknown()) });

/**
 * Save answers onto an open attempt.
 *
 * For a logbook part this is also where hours accumulate: the total is
 * recomputed from the rows and, the first time it crosses the part's minimum,
 * the assessor is told. Notification is marked on the attempt so it fires once
 * — a candidate adding a sixth week of entries should not re-alert anyone.
 */
assessmentCasesRouter.patch(
  '/:id/attempts/:attemptId',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const scope = await permissionScope(tenant, 'assessments', 'edit');
    if (scope === 'none') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = saveValuesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row || (scope === 'own' && row.candidateUserId !== tenant.userId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const attempt = await db.query.assessmentPartAttempts.findFirst({
      where: and(
        eq(schema.assessmentPartAttempts.id, req.params.attemptId!),
        eq(schema.assessmentPartAttempts.caseId, row.id),
      ),
    });
    if (!attempt) {
      res.status(404).json({ error: 'attempt_not_found' });
      return;
    }
    // A resolved attempt is evidence. Editing it would rewrite what an assessor
    // signed; a correction is a new attempt.
    if (attempt.outcome !== null) {
      res.status(409).json({ error: 'attempt_resolved' });
      return;
    }

    const values = parsed.data.values as Record<string, SubmissionValue>;
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    const part = tool ? orderedParts(tool.manifest).find((p) => p.key === attempt.partKey) : undefined;

    let hours: number | null = null;
    let thresholdReached = false;
    if (part?.kind === 'logbook') {
      const rows = Object.values(values).find(Array.isArray) as RepeatingRowValue[] | undefined;
      hours = totalLoggedHours(rows ?? [], DURATION_COLUMN);
      thresholdReached =
        part.minimumHours != null && hours >= part.minimumHours && attempt.thresholdNotifiedAt === null;
    }

    await db
      .update(schema.assessmentPartAttempts)
      .set({
        values,
        ...(thresholdReached ? { thresholdNotifiedAt: new Date() } : {}),
      })
      .where(eq(schema.assessmentPartAttempts.id, attempt.id));

    if (thresholdReached) {
      await recordAudit(db, tenant, {
        action: 'Logbook minimum reached',
        target: `${row.id} / ${attempt.partKey}: ${hours}h`,
        category: 'submissions',
        icon: 'clock',
      });
    }

    res.json({ id: attempt.id, hours, thresholdReached });
  }),
);

const outcomeBody = z.object({
  outcome: z.enum(['satisfactory', 'not_satisfactory']).optional(),
  disposition: z.enum(NS_DISPOSITIONS).optional(),
  reason: z.string().min(1).optional(),
  assessorName: z.string().min(1).optional(),
  belowThresholdReason: z.string().min(1).optional(),
});

/**
 * Resolve an attempt.
 *
 * A theory attempt's outcome is COMPUTED from the answer key and the assessor
 * reviews it; every other part's is recorded by the assessor. A
 * not-satisfactory outcome demands a disposition and a reason, which is the
 * "further action" the paper form asks for.
 */
assessmentCasesRouter.post(
  '/:id/attempts/:attemptId/outcome',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = outcomeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const row = await loadCase(db, req.params.id!, tenant.orgId);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const attempt = await db.query.assessmentPartAttempts.findFirst({
      where: and(
        eq(schema.assessmentPartAttempts.id, req.params.attemptId!),
        eq(schema.assessmentPartAttempts.caseId, row.id),
      ),
    });
    if (!attempt) {
      res.status(404).json({ error: 'attempt_not_found' });
      return;
    }
    if (attempt.outcome !== null) {
      res.status(409).json({ error: 'attempt_resolved' });
      return;
    }
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }
    const part = orderedParts(tool.manifest).find((p) => p.key === attempt.partKey);
    if (!part) {
      res.status(409).json({ error: 'part_missing_from_manifest' });
      return;
    }

    let outcome = parsed.data.outcome ?? null;
    let derivedValues = attempt.values;

    if (part.kind === 'theory') {
      const fields = await fieldsForVersion(db, attempt.templateVersionId);
      const marked = markTheory({ fields, values: attempt.values, part });
      outcome = marked.outcome;
      derivedValues = marked.derivedValues;
    } else if (!outcome) {
      res.status(400).json({ error: 'outcome_required' });
      return;
    }

    if (outcome === 'not_satisfactory' && !(parsed.data.disposition && parsed.data.reason)) {
      res.status(400).json({ error: 'disposition_and_reason_required' });
      return;
    }

    await db
      .update(schema.assessmentPartAttempts)
      .set({
        outcome,
        values: derivedValues,
        disposition: outcome === 'not_satisfactory' ? (parsed.data.disposition ?? null) : null,
        dispositionReason: outcome === 'not_satisfactory' ? (parsed.data.reason ?? null) : null,
        belowThresholdReason: parsed.data.belowThresholdReason ?? null,
        assessorUserId: tenant.userId,
        assessorName: parsed.data.assessorName ?? '',
        signedAt: new Date(),
      })
      .where(eq(schema.assessmentPartAttempts.id, attempt.id));

    // Recompute case state from the rows rather than incrementing a counter.
    const attempts = await attemptsFor(db, row.id);
    const progress = caseProgress(tool.manifest, row.pathway as AssessmentPathway, toAttemptFacts(attempts));
    const competent = isCaseCompetent(progress);
    const closing = outcome === 'not_satisfactory' && parsed.data.disposition === 'not_yet_competent';

    const nextState = competent ? 'competent' : closing ? 'closed' : 'open';
    if (nextState !== row.state) {
      await db
        .update(schema.assessmentCases)
        .set({ state: nextState, ...(nextState === 'open' ? {} : { closedAt: new Date() }) })
        .where(eq(schema.assessmentCases.id, row.id));
    }

    await recordAudit(db, tenant, {
      action: 'Recorded part outcome',
      target: `${row.id} / ${attempt.partKey} #${attempt.attemptNumber}: ${outcome}`,
      category: 'submissions',
      icon: outcome === 'satisfactory' ? 'circle-check' : 'circle-x',
    });

    res.json({
      id: attempt.id,
      outcome,
      caseState: nextState,
      parts: progress.map((p) => ({ key: p.part.key, state: p.state })),
    });
  }),
);
