import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  applyCalcs,
  ASSESSMENT_PATHWAYS,
  NS_DISPOSITIONS,
  caseProgress,
  fieldsInPart,
  fieldsInSection,
  isCaseCompetent,
  logbookRows,
  markTheory,
  orderedParts,
  requiredParts,
  totalLoggedHours,
  stripMarkingSecrets,
  validateAnswerKeys,
  validateManifest,
  type AssessmentPart,
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
import { CaseExportError, exportCasePdf } from '../pdf/index.js';
import { getStorageClient } from '../storage/index.js';
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

/** The repeating table a logbook part totals its hours from, on one version. */
async function logbookTableId(
  database: Database,
  versionId: string,
  startFieldId: string,
): Promise<string | undefined> {
  const fields = await fieldsForVersion(database, versionId);
  return fieldsInSection(fields, startFieldId).find((f) => f.type === 'repeating_group')?.id;
}

/** The rows to carry into a retry, read by the one shared rule. */
async function logbookRowsOf(
  database: Database,
  attempt: { values: Record<string, SubmissionValue>; templateVersionId: string },
  part: AssessmentPart,
): Promise<RepeatingRowValue[]> {
  const fields = await fieldsForVersion(database, attempt.templateVersionId);
  return logbookRows(fields, part, attempt.values);
}

/**
 * The rows and threshold stamp a new logbook attempt inherits from the last one.
 *
 * Returns nothing at all — not an empty map — for any part that is not a
 * logbook, for a first attempt, and whenever the table cannot be resolved on
 * BOTH versions. Carrying nothing leaves a visibly empty logbook a candidate
 * can refill; carrying rows under a key the new version does not declare would
 * strand them where no surface reads them, which looks like the same empty
 * logbook while quietly making the data unreachable.
 *
 * The table id is resolved per VERSION because a retry pins to the case's
 * current version, which can differ from the one the previous attempt was taken
 * against. The rows move from the old id to the new one.
 *
 * `thresholdNotifiedAt` travels with them. The carried attempt is born above the
 * minimum, and without the stamp its first save would announce "logbook minimum
 * reached" a second time for a threshold crossed weeks earlier.
 */
async function carryForwardLogbook(
  database: Database,
  input: {
    part: AssessmentPart;
    previous: readonly { attemptNumber: number; values: Record<string, SubmissionValue>; templateVersionId: string; thresholdNotifiedAt: Date | null }[];
    toVersionId: string;
  },
): Promise<{ values: Record<string, SubmissionValue>; thresholdNotifiedAt: Date | null } | undefined> {
  if (input.part.kind !== 'logbook') return undefined;

  const last = [...input.previous].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  if (!last) return undefined;

  // Read by the SHARED rule so the rows carried forward are exactly the rows the
  // threshold counted and the dashboard reports. Written under the NEW version's
  // table id, which is why only the destination needs resolving here.
  const [rows, toId] = await Promise.all([
    logbookRowsOf(database, last, input.part),
    logbookTableId(database, input.toVersionId, input.part.startFieldId),
  ]);
  if (!toId || rows.length === 0) return undefined;

  return { values: { [toId]: rows }, thresholdNotifiedAt: last.thresholdNotifiedAt ?? null };
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
  durationColumnKey: z.string().optional(),
  checklistFieldId: z.string().optional(),
  mandatoryFieldIds: z.array(z.string()).optional(),
});

const toolBody = z.object({
  templateId: z.string().uuid(),
  name: z.string().min(1),
  manifest: z.object({
    parts: z.array(partSchema).min(1),
    locationStreamFieldId: z.string().optional(),
  }),
  candidatePrerequisiteIds: z.array(z.string().uuid()).optional(),
  assessorCompetencyIds: z.array(z.string().uuid()).optional(),
});

/**
 * Create an assessment tool over a published template.
 *
 * The manifest is validated against the template's ACTUAL fields, not accepted
 * on trust: a part anchored to a field that version does not contain would
 * contribute no values and export as a silently blank part.
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

/**
 * Hours logged against one logbook part, from its attempt rows.
 *
 * Read from the HIGHEST-NUMBERED attempt rather than summed across all of them.
 * A retried logbook re-enters its entries on the new attempt, so summing would
 * count the same weeks twice and report more experience than the candidate has
 * — the one error direction that matters when the figure is measured against a
 * safety threshold. It is also the attempt the threshold notification fired on
 * and the one the evidence document renders, so the dashboard agrees with both.
 *
 * Every array in the attempt's values is totalled rather than the one table the
 * manifest names, because naming it needs the pinned version's field list — a
 * read per attempt version that this endpoint otherwise never makes. A part's
 * values hold only that part's fields and only its logbook table carries the
 * duration column, so the wider sum reaches the same number.
 */
function loggedHoursFor(
  part: AssessmentPart,
  attempts: readonly {
    attemptNumber: number;
    values: Record<string, SubmissionValue>;
    templateVersionId: string;
  }[],
  fieldsByVersion: ReadonlyMap<string, FormField[]>,
): number | null {
  if (part.kind !== 'logbook' || !part.durationColumnKey) return null;
  // Picked by attempt number rather than by position, so the answer does not
  // depend on the order the caller happened to hand them over in. The latest
  // attempt is authoritative because a logbook retry CARRIES its rows forward,
  // so the newest row already holds every hour logged.
  const latest = attempts.reduce<(typeof attempts)[number] | undefined>(
    (best, a) => (!best || a.attemptNumber > best.attemptNumber ? a : best),
    undefined,
  );
  if (!latest) return 0;

  // The same rule the threshold notification and the retry carry-forward use.
  // Three copies of "which rows are the logbook" disagreed; this is the one.
  const rows = logbookRows(fieldsByVersion.get(latest.templateVersionId) ?? [], part, latest.values);
  return totalLoggedHours(rows, part.durationColumnKey);
}

/**
 * Where every candidate stands, without opening a single case (R21).
 *
 * DERIVED ON EVERY READ, like the rest of this router. Part state, the current
 * part and the logged hours all come from the attempt rows. A stored progress
 * summary would be a second source of truth that goes stale the moment an
 * attempt is marked by a path that forgot to update it — and this is the screen
 * a supervisor trusts to tell them who is waiting.
 *
 * REGISTERED BEFORE `/:id`. Express matches in declaration order, so with the
 * id route first the whole dashboard would resolve as "the case whose id is
 * progress" and answer 404.
 */
assessmentCasesRouter.get(
  '/progress',
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

    // Same server-side scope filter as the case list. A candidate reaching the
    // dashboard sees their own rows; filtering after the fact would mean the
    // aggregate had been computed over everyone's attempts and then trimmed.
    const cases = await db.query.assessmentCases.findMany({
      where:
        scope === 'own'
          ? and(
              eq(schema.assessmentCases.orgId, tenant.orgId),
              eq(schema.assessmentCases.candidateUserId, tenant.userId),
            )
          : eq(schema.assessmentCases.orgId, tenant.orgId),
      orderBy: (c) => [desc(c.createdAt)],
    });
    if (cases.length === 0) {
      res.json([]);
      return;
    }

    const toolIds = [...new Set(cases.map((c) => c.toolId))];
    const tools = await db.query.assessmentTools.findMany({
      where: inArray(schema.assessmentTools.id, toolIds),
    });
    const toolById = new Map(tools.map((t) => [t.id, t]));

    // Candidates by name, because a dashboard listing user ids is unreadable to
    // the supervisor who has to act on it.
    const candidateIds = [...new Set(cases.map((c) => c.candidateUserId))];
    const candidates = await db.query.users.findMany({
      where: inArray(schema.users.id, candidateIds),
    });
    const nameById = new Map(candidates.map((u) => [u.id, u.name]));

    // Every attempt in the org in ONE query, grouped by case in code. A query
    // per case is the N+1 this endpoint exists to replace: a site with three
    // hundred candidates would issue three hundred round trips to draw one
    // table. Rows for a case outside `visible` are DROPPED rather than grouped,
    // so an `own` caller cannot be shown another candidate's attempts even
    // though the org-scoped read touched them.
    const visible = new Set(cases.map((c) => c.id));
    const attemptRows = await db.query.assessmentPartAttempts.findMany({
      where: eq(schema.assessmentPartAttempts.orgId, tenant.orgId),
      orderBy: (a, { asc }) => [asc(a.partKey), asc(a.attemptNumber)],
    });
    const byCase = new Map<string, typeof attemptRows>();
    for (const row of attemptRows) {
      if (!visible.has(row.caseId)) continue;
      const bucket = byCase.get(row.caseId);
      if (bucket) bucket.push(row);
      else byCase.set(row.caseId, [row]);
    }

    /*
      The fields of every version the visible attempts are pinned to, loaded ONCE
      for the whole page.

      Needed because hours come from the part's DECLARED table, and finding that
      table means reading the version an attempt was taken against. Counting
      every array on the attempt instead — which this endpoint used to do — made
      it disagree with the threshold notification about the same candidate, with
      no retry involved. See `logbookRows`.

      Deduplicated by version rather than fetched per attempt: a cohort shares a
      handful of versions, and a read per attempt is the N+1 this endpoint exists
      to replace.
    */
    const versionIds = [
      ...new Set([...byCase.values()].flat().map((a) => a.templateVersionId)),
    ];
    const versions = versionIds.length
      ? await db.query.formTemplateVersions.findMany({
          where: inArray(schema.formTemplateVersions.id, versionIds),
        })
      : [];
    const fieldsByVersion = new Map<string, FormField[]>(
      versions.map((v) => [v.id, (v.fields ?? []) as FormField[]]),
    );

    res.json(
      cases.map((c) => {
        const tool = toolById.get(c.toolId);
        const attempts = byCase.get(c.id) ?? [];
        // A tool row cannot actually vanish — the case's FK is `restrict` — but
        // if one ever did, the candidate stays on the dashboard with no parts
        // rather than disappearing from it or failing the whole request.
        const progress = tool
          ? caseProgress(tool.manifest, c.pathway as AssessmentPathway, toAttemptFacts(attempts))
          : [];

        // The first required part that has not passed, in document order. Null
        // once every part has, which is what makes a competent case legible at a
        // glance beside a closed one: closed still names the part it stopped at.
        const current = progress.find((p) => p.state !== 'satisfactory');

        return {
          id: c.id,
          toolName: tool?.name ?? '',
          candidateUserId: c.candidateUserId,
          candidateName: nameById.get(c.candidateUserId) ?? '',
          pathway: c.pathway,
          state: c.state,
          currentPartKey: current?.part.key ?? null,
          currentPartLabel: current?.part.label ?? null,
          parts: progress.map((p) => ({
            key: p.part.key,
            label: p.part.label,
            kind: p.part.kind,
            ordinal: p.part.ordinal,
            state: p.state,
            latestOutcome: p.latestOutcome,
            attempts: p.attempts,
            minimumHours: p.part.minimumHours ?? null,
            /** Null for anything but a logbook — there is no threshold to meet. */
            loggedHours: loggedHoursFor(
              p.part,
              attempts.filter((a) => a.partKey === p.part.key),
              fieldsByVersion,
            ),
          })),
          createdAt: c.createdAt,
        };
      }),
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

    // Appeals AGAINST this case — the superseding record must be visible from
    // the superseded one, or a reviewer reading the original would take a
    // disputed outcome at face value. The extra in-code filter is a no-op on a
    // real database and keeps the predicate exact.
    const appeals = (
      await db.query.assessmentCases.findMany({
        where: and(
          eq(schema.assessmentCases.orgId, tenant.orgId),
          eq(schema.assessmentCases.appealOfCaseId, row.id),
        ),
      })
    ).filter((c) => c.appealOfCaseId === row.id);

    // Resolved for display and for the exported document's filename. An
    // evidence PDF gets emailed and filed, so a UUID in its name makes it a
    // document nobody can identify later.
    const candidate = await db.query.users.findFirst({
      where: eq(schema.users.id, row.candidateUserId),
    });

    res.json({
      id: row.id,
      toolId: tool.id,
      toolName: tool.name,
      appeals: appeals.map((c) => ({ id: c.id, state: c.state, createdAt: c.createdAt })),
      candidateUserId: row.candidateUserId,
      candidateName: candidate?.name ?? '',
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
        /** Null until the candidate hands it in — the "ready to mark" signal. */
        submittedAt: a.submittedAt,
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

    /*
      A LOGBOOK CARRIES ITS HOURS FORWARD. Every other kind of part starts a
      retry empty.

      A logbook is not really failed. The practice is that a candidate keeps
      logging and simply does not progress until an assessor judges them
      competent to — so `not_satisfactory` here means "not yet", and the hours
      already logged still count toward the minimum. Starting the new attempt
      empty told a candidate with 47 of 50 hours that they had none: a blank
      table asking for 50, zero on every surface, and nothing anywhere saying
      their recorded experience had just gone backwards.

      Copied at WRITE time rather than summed at read time. The exported evidence
      prints exactly ONE attempt per part (`authoritativeAttempt` in
      pdf/case-export.ts), so a summed figure would sit on the dashboard beside a
      printed logbook page totalling less, with nothing on the page to explain
      the difference. One authoritative attempt keeps the dashboard, the
      threshold and the PDF telling the same story.

      A practical retry is deliberately NOT carried: it is a fresh
      demonstration, and pre-filling it would show an assessor marks they never
      made.
    */
    const carried = await carryForwardLogbook(db, {
      part: target.part,
      previous: mine,
      toVersionId: row.currentVersionId,
    });

    const [created] = await db
      .insert(schema.assessmentPartAttempts)
      .values({
        orgId: tenant.orgId,
        caseId: row.id,
        partKey,
        attemptNumber: mine.length + 1,
        templateVersionId: row.currentVersionId,
        ...carried,
      })
      .returning();
    if (!created) throw new Error('attempt_create_failed: insert returned no row');

    res.status(201).json({ id: created.id, attemptNumber: created.attemptNumber, reused: false });
  }),
);

/**
 * The fillable surface for one attempt — what the candidate portal renders.
 *
 * MARKING SECRETS ARE STRIPPED AT THE DOOR. These fields carry the complete
 * answer key to the assessment the candidate is about to sit, and this route
 * serves them to that candidate. Nothing downstream is trusted to hide them:
 * they do not leave the process.
 *
 * Fields come from the version the ATTEMPT is pinned to, not the case's current
 * one. A candidate resuming an attempt started against an older version must
 * see the questions they were asked, not the ones the template has since grown.
 */
assessmentCasesRouter.get(
  '/:id/attempts/:attemptId',
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
    // Same rule as case detail: a candidate asking for someone else's work gets
    // 404, because 403 would confirm it exists.
    if (!row || (scope === 'own' && row.candidateUserId !== tenant.userId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const attempt = (await attemptsFor(db, row.id)).find((a) => a.id === req.params.attemptId);
    // An attempt id from another case is a miss, not a cross-case read.
    if (!attempt) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const tool = await loadTool(db, row.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }

    const manifest = tool.manifest as AssessmentToolManifest;
    const part = orderedParts(manifest).find((p) => p.key === attempt.partKey);
    if (!part) {
      res.status(409).json({ error: 'part_missing_from_manifest' });
      return;
    }

    const allFields = await fieldsForVersion(db, attempt.templateVersionId);

    res.json({
      id: attempt.id,
      partKey: attempt.partKey,
      partLabel: part.label,
      partKind: part.kind,
      attemptNumber: attempt.attemptNumber,
      outcome: attempt.outcome,
      submittedAt: attempt.submittedAt,
      templateVersionId: attempt.templateVersionId,
      /**
       * The case's stream and the field its answer belongs in, so the renderer
       * can seed visibility exactly the way the exporter does — by answering the
       * manifest's stream question, not by filtering fields itself.
       *
       * Either being null is fail-open: every location set renders rather than
       * none, because hiding content nobody chose to hide would silently shorten
       * the assessment.
       */
      locationStream: row.locationStream,
      locationStreamFieldId: manifest.locationStreamFieldId ?? null,
      /**
       * The stream question itself, sent as a lookup source because it often
       * lives OUTSIDE this part — on the cover checklist, typically. Without it
       * the renderer sees a dangling condition, falls open, and every location
       * set shows: the gating would silently never apply.
       */
      streamField: manifest.locationStreamFieldId
        ? (allFields.find((f) => f.id === manifest.locationStreamFieldId) ?? null)
        : null,
      minimumHours: part.minimumHours ?? null,
      durationColumnKey: part.durationColumnKey ?? null,
      fields: stripMarkingSecrets(fieldsInPart(allFields, manifest, attempt.partKey)),
      values: attempt.values ?? {},
    });
  }),
);

/**
 * Handing a part in, and taking it back.
 *
 * This is the signal that closes the tracking gap the paper process had: an
 * attempt with answers and no outcome cannot distinguish a candidate halfway
 * through from one who finished a week ago and is waiting. Submitting says
 * which.
 *
 * It is the CANDIDATE'S act — `edit` at `own` scope reaches it — and it is not
 * an outcome. Until an assessor marks the attempt nothing has been judged, so
 * the candidate can reopen it themselves rather than needing anyone's help to
 * undo a mis-tap. Marking is what makes an attempt permanent.
 */
async function setSubmitted(
  req: Parameters<Parameters<typeof withErrorHandling>[0]>[0],
  res: Parameters<Parameters<typeof withErrorHandling>[0]>[1],
  submitting: boolean,
) {
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

  const row = await loadCase(db, req.params.id!, tenant.orgId);
  // Same rule as everywhere else: someone else's work is 404, not 403.
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
  // Once marked, an attempt is evidence in both directions: handing it in again
  // is meaningless, and reopening it would let a candidate rewrite what an
  // assessor already judged.
  if (attempt.outcome !== null) {
    res.status(409).json({ error: 'attempt_resolved' });
    return;
  }

  // Idempotent. A double-tap must not restamp a later hand-in time than the
  // one the candidate actually made.
  if (submitting && attempt.submittedAt) {
    res.status(200).json({ id: attempt.id, submittedAt: attempt.submittedAt });
    return;
  }

  const submittedAt = submitting ? new Date() : null;
  await db
    .update(schema.assessmentPartAttempts)
    .set({ submittedAt })
    .where(eq(schema.assessmentPartAttempts.id, attempt.id));

  await recordAudit(db, tenant, {
    action: submitting ? 'Submitted assessment part' : 'Reopened assessment part',
    target: `${row.id} ${attempt.partKey} attempt ${attempt.attemptNumber}`,
    // 'submissions' to match the rest of this router — assessment activity is
    // filed there rather than under a category of its own.
    category: 'submissions',
    icon: submitting ? 'send' : 'undo-2',
  });

  res.status(200).json({ id: attempt.id, submittedAt });
}

assessmentCasesRouter.post(
  '/:id/attempts/:attemptId/submit',
  ...GATE,
  withErrorHandling((req, res) => setSubmitted(req, res, true)),
);

assessmentCasesRouter.post(
  '/:id/attempts/:attemptId/reopen',
  ...GATE,
  withErrorHandling((req, res) => setSubmitted(req, res, false)),
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
    // Handed in, not yet marked. Refusing here is what makes "submitted" mean
    // anything — otherwise the answers could keep moving while the assessor was
    // reading them. The candidate can reopen it themselves; nothing is lost.
    if (attempt.submittedAt) {
      res.status(409).json({ error: 'attempt_submitted' });
      return;
    }

    let values = parsed.data.values as Record<string, SubmissionValue>;
    const tool = await loadTool(db, row.toolId, tenant.orgId);
    const part = tool ? orderedParts(tool.manifest).find((p) => p.key === attempt.partKey) : undefined;

    let hours: number | null = null;
    let thresholdReached = false;
    if (part?.kind === 'logbook' && part.durationColumnKey) {
      // The duration column is recomputed SERVER-SIDE when it carries a calc.
      // Whatever the client sent for a derived cell is discarded: hours count
      // toward a safety threshold, so the meter arithmetic must not be
      // forgeable by editing a request body.
      const fields = await fieldsForVersion(db, attempt.templateVersionId);
      const table = fieldsInSection(fields, part.startFieldId).find(
        (f) => f.type === 'repeating_group',
      );

      const durationKey = part.durationColumnKey;
      values = Object.fromEntries(
        Object.entries(values).map(([k, v]) => {
          if (!Array.isArray(v) || (table && k !== table.id)) return [k, v];
          const rows = applyCalcs(table?.columns, v as RepeatingRowValue[]);
          return [k, rows];
        }),
      );

      // Shared with the progress dashboard and the retry carry-forward. The old
      // fallback here took the first array of ANY kind, which would have counted
      // a checkbox group's answers as logbook rows.
      const rows: RepeatingRowValue[] = logbookRows(fields, part, values);

      // A row whose duration is present but not a positive number is a
      // mis-entry (zero, negative, or meter readings that go backwards — a
      // calc writes '' for those). Refusing it keeps "hours that count" and
      // "rows on the record" the same set, so the exported logbook cannot
      // show entries the threshold quietly ignored.
      const bad = (rows ?? []).findIndex((r) => {
        const raw = r?.[durationKey];
        if (raw === undefined || raw === null) return false;
        const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
        return !(Number.isFinite(n) && n > 0);
      });
      if (bad >= 0) {
        res.status(400).json({
          error: 'invalid_logbook_row',
          row: bad,
          message: `Row ${bad + 1} has no positive ${durationKey} — check the start and finish readings.`,
        });
        return;
      }

      hours = totalLoggedHours(rows ?? [], durationKey);
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

/**
 * Regenerate the case's evidence document.
 *
 * Takes a case id and NOTHING else, for the same reason the submission export
 * does: a filled assessment paper is read as proof of what was recorded, so
 * every input — which attempts count, which fields exist, which page they land
 * on — is resolved server-side from the stored case. There is deliberately no
 * "render these values" variant.
 *
 * Export is gated on `export`, not `view`: a candidate may read their own case
 * without being able to mint the document that certifies them.
 */
assessmentCasesRouter.post(
  '/:id/export',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'export'))) {
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

    const version = await db.query.formTemplateVersions.findFirst({
      where: eq(schema.formTemplateVersions.id, row.currentVersionId),
    });
    if (!version?.sourcePdfAssetId) {
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

    const attempts = await attemptsFor(db, row.id);

    try {
      const out = await exportCasePdf({
        originalPdf: original,
        fields: (version.fields ?? []) as FormField[],
        manifest: tool.manifest,
        pathway: row.pathway as AssessmentPathway,
        locationStream: row.locationStream,
        attempts: attempts.map((a) => ({
          partKey: a.partKey,
          attemptNumber: a.attemptNumber,
          outcome: a.outcome,
          values: a.values,
        })),
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.send(Buffer.from(out));
    } catch (err) {
      // A mismatched manifest is a 409 rather than a 500: the request is well
      // formed and the server is healthy — the tool's part structure no longer
      // matches the version it is being exported against, which is a data
      // problem an author can fix.
      if (err instanceof CaseExportError) {
        res.status(409).json({ error: err.message, problems: err.problems });
        return;
      }
      throw err;
    }
  }),
);

const appealBody = z.object({
  assessorUserId: z.string().uuid(),
  reason: z.string().min(1),
});

/**
 * Appeal a case's outcome: a NEW case, linked to the disputed one, run by a
 * different assessor. The later outcome supersedes for display while both
 * cases remain queryable — the appeal does not edit or hide the original,
 * because a disputed record that vanishes is exactly what an audit cannot
 * accept.
 *
 * Two constraints carry the integrity:
 *
 * - Only an administrator may initiate. The source document gives this
 *   authority to the Training Supervisor; at Business tier that is an admin,
 *   and the distinct role arrives with the Enterprise panel work.
 * - The initiator must not be the assessor whose decision is disputed
 *   (R30/AE8). Without this, an admin who is also an assessor could
 *   adjudicate a dispute about their own assessment.
 *
 * The panel-review arm is Enterprise-only and deliberately NOT modelled here —
 * no endpoint exists, so there is nothing to gate. It arrives with panel
 * membership and per-member verdicts as its own unit of work.
 */
assessmentCasesRouter.post(
  '/:id/appeal',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = appealBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const disputed = await loadCase(db, req.params.id!, tenant.orgId);
    if (!disputed) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // The conflict constraint, both sides of it: the initiating admin must not
    // be the disputed assessor, and the appeal must go to a DIFFERENT assessor
    // — "an independent Assessor" in the source document's words.
    if (disputed.assessorUserId === tenant.userId) {
      res.status(409).json({
        error: 'appeal_conflict',
        message: 'The assessor whose decision is disputed cannot initiate the appeal.',
      });
      return;
    }
    if (parsed.data.assessorUserId === disputed.assessorUserId) {
      res.status(409).json({
        error: 'appeal_assessor_not_independent',
        message: 'An appeal must be assessed by someone other than the disputed assessor.',
      });
      return;
    }

    const tool = await loadTool(db, disputed.toolId, tenant.orgId);
    if (!tool) {
      res.status(409).json({ error: 'tool_missing' });
      return;
    }
    const template = await db.query.formTemplates.findFirst({
      where: eq(schema.formTemplates.id, tool.templateId),
    });
    if (!template?.currentVersionId) {
      res.status(409).json({ error: 'template_not_published' });
      return;
    }

    const [appeal] = await db
      .insert(schema.assessmentCases)
      .values({
        orgId: tenant.orgId,
        toolId: disputed.toolId,
        candidateUserId: disputed.candidateUserId,
        assessorUserId: parsed.data.assessorUserId,
        pathway: disputed.pathway,
        locationStream: disputed.locationStream,
        currentVersionId: template.currentVersionId,
        appealOfCaseId: disputed.id,
        appealReason: parsed.data.reason,
        rplJustification: disputed.rplJustification,
      })
      .returning();
    if (!appeal) throw new Error('appeal_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Opened appeal',
      target: `${disputed.id} → ${appeal.id}: ${parsed.data.reason}`,
      category: 'submissions',
      icon: 'scale',
    });

    res.status(201).json({
      id: appeal.id,
      appealOfCaseId: disputed.id,
      assessorUserId: parsed.data.assessorUserId,
      pathway: appeal.pathway,
    });
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
