import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { PLAN_CONFIG, schema, type PlanTier } from '@formai/db';
import {
  WORKFORCE_IMPORT_TEMPLATE,
  parseWorkforceCsv,
  validateWorkforceImport,
  type ImportContext,
  type ValidatedImport,
} from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { loadHeldIdentifiers, previewImportCost } from '../lib/member-create.js';
import {
  readActiveRunReport,
  readRunReport,
  startImportRun,
} from '../lib/workforce-import-run.js';
import { db } from '../db.js';

/**
 * Bulk workforce import (U23 part 2, U24).
 *
 * THE ONE PATH INTO THE PRODUCT THAT DOES NOT GO THROUGH A SCREEN, which is why
 * every row goes through the SAME validator the team screen calls rather than a
 * second implementation. Two implementations of one rule disagree silently and
 * at volume: an import could land a placement the screen refuses, or reject one
 * it accepts.
 *
 * FOUR STEPS, and the separation is the design (R144). The template says what
 * the file must look like; validation reads a filled one and prices it without
 * writing anything; the run happens only once an Admin has seen that price and
 * confirmed; and the report outlives the tab, because the rejection list is what
 * an Admin needs to correct the source file and re-import.
 *
 * VALIDATION IS REDONE ON THE RUN. The client sends the same file back rather
 * than a "this was already approved" payload — trusting a client-supplied list
 * of valid rows would let anyone who can call this route land whatever they
 * liked, and the taxonomy may have moved between the two calls anyway.
 */
export const workforceImportRouter: Router = Router();

/** Admin-only, and Owner as the level holding everything Admin holds (R139). */
function isAdmin(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

const GATE = [requireTenant, requirePlanFeature('assessments')] as const;

const fileBody = z.object({
  /** The filled template, as text. */
  csv: z.string().min(1),
});

/**
 * Whether this tier carries candidate seats at all (R167).
 *
 * THREE STATES, and collapsing any two of them breaks a tier. `candidateSeatLimit`
 * is `number | null`, where `null` is the UNLIMITED sentinel — the same sentinel
 * `limitFor`/`checkSeatAvailability` read as "no cap". It is NOT a missing value,
 * so it must not be defaulted with `??`: `(limit ?? 0) !== 0` reads Enterprise's
 * unlimited null as zero seats and rejects EVERY Candidate row on the tier that
 * has the most of them. A tier absent from `PLAN_CONFIG` is the genuinely missing
 * case and is refused, because an unreadable config is not an unlimited one.
 */
export function tierAllowsCandidates(planTier: string): boolean {
  const limit = PLAN_CONFIG[planTier as PlanTier]?.candidateSeatLimit;
  if (limit === undefined) return false; // unknown tier — no config to allow it
  return limit === null || limit > 0; // null = unlimited; 0 = none (R83)
}

/**
 * Everything the validator resolves names against — the organisation's ACTIVE
 * taxonomy and its competency register.
 *
 * Only ACTIVE values are loaded, which is what makes "names a retired
 * Department" a rejection rather than a silent success: the name simply is not
 * in the map. The import creates no taxonomy under any circumstance (R169), so
 * an unknown name has nowhere to go but the rejection list.
 */
async function loadImportContext(
  orgId: string,
  planTier: string,
  dateFormat: 'dmy' | 'mdy',
): Promise<ImportContext> {
  const database = db!;
  const [locations, departments, jobRoles, competencies] = await Promise.all([
    database.query.locations.findMany({ where: eq(schema.locations.orgId, orgId) }),
    database.query.departments.findMany({ where: eq(schema.departments.orgId, orgId) }),
    database.query.jobRoles.findMany({ where: eq(schema.jobRoles.orgId, orgId) }),
    database.query.competencies.findMany({ where: eq(schema.competencies.orgId, orgId) }),
  ]);

  const active = <T extends { status?: string }>(rows: T[]) =>
    rows.filter((r) => r.status !== 'retired');
  const activeDepartments = active(departments);
  const activeRoles = active(jobRoles);

  const held = await loadHeldIdentifiers(database, orgId);

  return {
    locationsByName: new Map(active(locations).map((l) => [l.name.toLowerCase(), l.id])),
    departmentsByName: new Map(activeDepartments.map((d) => [d.name.toLowerCase(), d.id])),
    rolesByDeptAndName: new Map(
      activeRoles.map((r) => [`${r.departmentId}|${r.name.toLowerCase()}`, r.id]),
    ),
    /*
      R167, AMENDED: a competency line names a competency that EXISTS in this
      organisation's register. It previously had to be one SOME assessment tool
      awards, on this reasoning:

        "One nothing awards cannot be earned in the product either, so importing
         it would create a holding nobody could ever renew."

      That reasoning still describes the state accurately; what changed is that
      the state is now accepted as TEMPORARY rather than refused. A customer
      migrating a decade of tickets has them before it has the tools that will
      one day renew them, and refusing the grant until the tool exists loses the
      qualification history rather than protecting it — the same conclusion R153
      reached for a grant with no date.

      The awardedness half was also the ONE place this import was STRICTER than
      the screen it is required to mirror. `grantCompetency` has never checked
      awardedness, so an Admin could always record exactly these grants by hand,
      one person at a time, through `POST /competencies/:id/holders` — the
      control that exists precisely for a ticket earned with a previous
      employer. A rule the manual path does not apply is not a safeguard the
      bulk path should invent, and this file's own opening note is that two
      implementations of one rule disagree silently and at volume.

      NOTHING ELSE MOVED. The register is still read, never written: a name that
      is not in it is still `unknown_competency` and still creates nothing, so
      R169 is untouched and the curation stays a deliberate human act. Linking
      the tool later needs no backfill — the skip rule and standing both read
      grants by competency id, so adding the id to a tool's awarded list makes
      every imported grant count at once.
    */
    competenciesByName: new Map(competencies.map((c) => [c.name.toLowerCase(), c.id])),
    placement: {
      departments: activeDepartments.map((d) => ({
        id: d.id,
        allowsMultipleRoles: d.allowsMultipleRoles,
      })),
      roles: activeRoles.map((r) => ({ id: r.id, departmentId: r.departmentId })),
    },
    // R167: a Candidate row cannot land on a tier that allocates none.
    candidateSeatsAllowed: tierAllowsCandidates(planTier),
    heldEmployeeNumbers: held.employeeNumbers,
    heldSwipeCardNumbers: held.swipeCardNumbers,
    dateFormat,
  };
}

/** Parse and validate one submitted file against the org's live taxonomy. */
async function validateSubmitted(
  orgId: string,
  csv: string,
): Promise<{ validated: ValidatedImport; org: typeof schema.organizations.$inferSelect } | null> {
  const org = await db!.query.organizations.findFirst({
    where: eq(schema.organizations.id, orgId),
  });
  if (!org) return null;
  const ctx = await loadImportContext(orgId, org.planTier, org.dateFormat);
  return { validated: validateWorkforceImport(parseWorkforceCsv(csv), ctx), org };
}

// ── GET /workforce-import/template ─────────────────────────────────────────

/**
 * The blank template (R141).
 *
 * Served as a file rather than described in prose, because the two-section shape
 * is the part somebody gets wrong by hand — and the parser reads exactly this.
 */
workforceImportRouter.get(
  '/template',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!isAdmin(req.tenant!.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="workforce-import-template.csv"');
    res.send(WORKFORCE_IMPORT_TEMPLATE);
  }),
);

// ── POST /workforce-import/validate ────────────────────────────────────────

/**
 * Read a filled file and price it. WRITES NOTHING (R144).
 *
 * The cost is stated against BOTH pools separately, because each row names its
 * own access level and one figure would cover only part of what the file
 * spends. It counts SEATS rather than rows: a row merging onto an already-active
 * membership costs nothing, one matching a deactivated membership costs one, and
 * the same address twice costs one in total. A customer whose assessors already
 * hold logins is exactly the file this exists for, and a row count would
 * over-state their bill on precisely that file.
 */
workforceImportRouter.post(
  '/validate',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = fileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const outcome = await validateSubmitted(tenant.orgId, parsed.data.csv);
    if (!outcome) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const { validated, org } = outcome;

    const preview = await previewImportCost(db, org, validated.validProfiles);
    res.json({
      validRows: validated.validProfiles.length,
      competencyLines: validated.validCompetencies.length,
      rejected: validated.rejected,
      preview,
    });
  }),
);

// ── POST /workforce-import/run ─────────────────────────────────────────────

/**
 * Execute the import (R144's confirmation step).
 *
 * Re-validates the file rather than trusting anything the client says was
 * approved, then STARTS the run and returns its id — it does not wait for it.
 *
 * IT USED TO WAIT, and that is the bug this route exists to have fixed. A real
 * file of 191 people and 3,325 competency lines held this request open for
 * minutes at one transaction per row; the browser timed out, the screen fell
 * back to the upload form with a live confirm button, and the operator — who
 * had no way to tell a finished run from a lost one — came within a click of
 * running the whole thing a second time against production while the first was
 * still writing. The run was perfect. Everything around it was not.
 *
 * A SECOND RUN IS REFUSED, 409, while one is active, and the refusal names the
 * run already in flight so the screen can show its progress instead of an
 * upload form.
 */
workforceImportRouter.post(
  '/run',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = fileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const outcome = await validateSubmitted(tenant.orgId, parsed.data.csv);
    if (!outcome) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const started = await startImportRun(db, tenant, {
      validProfiles: outcome.validated.validProfiles,
      validCompetencies: outcome.validated.validCompetencies,
      rejected: outcome.validated.rejected,
    });
    if ('refused' in started) {
      // 409, not 400: the request is well-formed and would be accepted a minute
      // from now. The id is the useful half — it is what the screen polls.
      res.status(409).json({ error: 'import_already_running', runId: started.runId });
      return;
    }
    res.status(201).json({ runId: started.runId });
  }),
);

// ── GET /workforce-import/active ───────────────────────────────────────────

/**
 * The run this organisation has in flight, if any.
 *
 * ASKED ON LOAD, which is the half of the fix that lives on this side of the
 * wire: a page opened at any moment — after a timeout, a reload, from another
 * machine — can find out that an import is happening before it offers to start
 * one. Returns the full report, so the screen needs no second call to show
 * progress, and null once nothing is running.
 *
 * It is a separate path rather than `/runs/active` so that no run id can ever be
 * shadowed by a literal segment.
 */
workforceImportRouter.get(
  '/active',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    res.json({ run: await readActiveRunReport(db, tenant.orgId) });
  }),
);

// ── GET /workforce-import/runs/:id ─────────────────────────────────────────

/**
 * The run report (R171), readable long after the page was closed.
 *
 * Every figure is derived from the recorded rows rather than a tally kept beside
 * them, so the report and the rows an Admin acts on cannot disagree.
 */
workforceImportRouter.get(
  '/runs/:id',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!isAdmin(tenant.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const report = await readRunReport(db, tenant.orgId, req.params.id!);
    if (!report) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(report);
  }),
);
