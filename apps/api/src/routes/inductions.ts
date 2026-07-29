import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  assessInductionReadiness,
  buildInductionCohorts,
  holidaysCoverThrough,
  nextBookableInductionDate,
  readStarterProfile,
  type AssessedStarter,
  type FormField,
  type StarterProfile,
} from '@formai/shared';
import { requireMachineOrTenant } from '../middleware/machine.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { db } from '../db.js';

/**
 * Inductions — the booking-shaped view of CHC intake submissions.
 *
 * This is the router an agent talks to, so two things are true of it that are
 * not true of the rest of the API. It is mounted with `requireMachineOrTenant`,
 * accepting an org-scoped API key as well as a session; and its payloads are
 * REDACTED by default — a booking needs a name, a mobile and an email, and the
 * rest of the intake (date of birth, home address, licence number, emergency
 * contact) is withheld unless a caller asks for it and holds the grant to
 * export submissions. The default is the safe one because these responses land
 * in a model's context window, which may be logged well outside this system.
 *
 * A submission is an induction candidate if its pinned version carries the CHC
 * intake field ids — the shape IS the detection. Matching on the template name
 * instead would break the moment somebody renames the form, and a renamed form
 * still collects the same answers.
 */
export const inductionsRouter: Router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** How many upcoming Mondays `GET /dates` returns when the caller doesn't say. */
const DEFAULT_DATE_COUNT = 4;
const MAX_DATE_COUNT = 26;

interface CandidateRow {
  submissionId: string;
  submittedAt: string;
  status: string;
  starter: Omit<StarterProfile, 'sensitive'>;
  readiness: AssessedStarter['readiness'];
  blockers: AssessedStarter['blockers'];
  warnings: AssessedStarter['warnings'];
}

/**
 * Splits the profile into what any caller may see and what only an explicit,
 * permitted request unlocks. Written as a destructure so a field added to
 * `sensitive` later is withheld by default rather than leaking until someone
 * remembers to update a list.
 */
function redact(profile: StarterProfile): Omit<StarterProfile, 'sensitive'> {
  const { sensitive: _sensitive, ...booking } = profile;
  return booking;
}

function candidateDto(
  starter: AssessedStarter,
  row: { id: string; createdAt: Date; status: string },
): CandidateRow {
  return {
    submissionId: row.id,
    submittedAt: row.createdAt.toISOString(),
    status: row.status,
    starter: redact(starter.profile),
    readiness: starter.readiness,
    blockers: starter.blockers,
    warnings: starter.warnings,
  };
}

type SubmissionRow = typeof schema.submissions.$inferSelect;

/**
 * Every induction candidate in the org, assessed against `today`.
 *
 * Rows whose pinned version is not the intake form are skipped rather than
 * erroring: an org runs many forms, and asking for its induction candidates is
 * not an assertion that every submission is one.
 */
async function loadAssessedStarters(
  orgId: string,
  today: Date,
): Promise<{ starter: AssessedStarter; row: SubmissionRow }[]> {
  if (!db) return [];
  const rows = await db.query.submissions.findMany({
    where: eq(schema.submissions.orgId, orgId),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });
  if (rows.length === 0) return [];

  const versionIds = [...new Set(rows.map((r) => r.templateVersionId))];
  const versions = await db.query.formTemplateVersions.findMany({
    where: inArray(schema.formTemplateVersions.id, versionIds),
  });
  const fieldsByVersion = new Map<string, FormField[]>(
    versions.map((v) => [v.id, Array.isArray(v.fields) ? (v.fields as FormField[]) : []]),
  );

  const assessed: { starter: AssessedStarter; row: SubmissionRow }[] = [];
  for (const row of rows) {
    const fields = fieldsByVersion.get(row.templateVersionId);
    if (!fields) continue;
    const profile = readStarterProfile(fields, row.values);
    if (!profile) continue;
    assessed.push({
      starter: {
        submissionId: row.id,
        profile,
        ...assessInductionReadiness(profile, { today }),
      },
      row,
    });
  }
  return assessed;
}

/** Reading inductions is reading submissions — the same grant governs both. */
async function canRead(tenant: { orgId: string; role: string }): Promise<boolean> {
  return hasPermission(tenant, 'submissions', 'view');
}

const listQuery = z.object({
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
  readiness: z.enum(['ready', 'blocked']).optional(),
});

inductionsRouter.get('/candidates', requireMachineOrTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canRead(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }
  const { from, to, readiness } = parsed.data;

  const assessed = await loadAssessedStarters(tenant.orgId, new Date());
  const matching = assessed.filter(({ starter }) => {
    const date = starter.profile.inductionDate;
    if (from && (!ISO_DATE.test(date) || date < from)) return false;
    if (to && (!ISO_DATE.test(date) || date > to)) return false;
    if (readiness && starter.readiness !== readiness) return false;
    return true;
  });

  res.json({
    candidates: matching.map(({ starter, row }) => candidateDto(starter, row)),
    holidaysCoverThrough: holidaysCoverThrough(),
  });
}));

const detailQuery = z.object({
  includeSensitive: z.enum(['true', 'false']).optional(),
});

inductionsRouter.get('/candidates/:id', requireMachineOrTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canRead(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = detailQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }

  const row = await db.query.submissions.findFirst({
    where: and(eq(schema.submissions.id, req.params.id!), eq(schema.submissions.orgId, tenant.orgId)),
  });
  // A submission in another org is NOT FOUND, not FORBIDDEN: telling a caller
  // that an id exists elsewhere is itself a cross-tenant disclosure.
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const version = await db.query.formTemplateVersions.findFirst({
    where: eq(schema.formTemplateVersions.id, row.templateVersionId),
  });
  const fields = Array.isArray(version?.fields) ? (version.fields as FormField[]) : [];
  const profile = readStarterProfile(fields, row.values);
  if (!profile) {
    res.status(404).json({ error: 'not_an_induction_candidate' });
    return;
  }

  const assessed: AssessedStarter = {
    submissionId: row.id,
    profile,
    ...assessInductionReadiness(profile, { today: new Date() }),
  };
  const body = candidateDto(assessed, row);

  if (parsed.data.includeSensitive !== 'true') {
    res.json({ ...body, sensitiveOmitted: 'not_requested' });
    return;
  }
  // Denied requests still answer with the usable payload plus the reason. A
  // 403 would leave an agent with nothing and no way to tell an authorisation
  // problem from a missing record.
  if (!(await hasPermission(tenant, 'submissions', 'export'))) {
    res.json({ ...body, sensitiveOmitted: 'insufficient_permission' });
    return;
  }
  res.json({ ...body, sensitive: profile.sensitive });
}));

const cohortQuery = z.object({ date: z.string().regex(ISO_DATE).optional() });

inductionsRouter.get('/cohorts', requireMachineOrTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canRead(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = cohortQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }

  const assessed = await loadAssessedStarters(tenant.orgId, new Date());
  const byId = new Map(assessed.map(({ starter, row }) => [starter.submissionId, row]));
  const cohorts = buildInductionCohorts(assessed.map(({ starter }) => starter)).filter(
    (c) => !parsed.data.date || c.date === parsed.data.date,
  );

  res.json({
    cohorts: cohorts.map((cohort) => ({
      date: cohort.date,
      seats: cohort.seats,
      readyCount: cohort.readyCount,
      blockedCount: cohort.blockedCount,
      starters: cohort.starters.map((starter) => candidateDto(starter, byId.get(starter.submissionId)!)),
    })),
    holidaysCoverThrough: holidaysCoverThrough(),
  });
}));

const datesQuery = z.object({ count: z.coerce.number().int().min(1).max(MAX_DATE_COUNT).optional() });

inductionsRouter.get('/dates', requireMachineOrTenant, withErrorHandling(async (req, res) => {
  // The date rule needs no data, but the permission check does — without this
  // an unavailable database would answer 403 and read as an access problem.
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canRead(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = datesQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }

  const coverThrough = holidaysCoverThrough();
  const dates: { date: string; holidayListExpired: boolean }[] = [];
  // Each date seeds the search for the next: `nextBookableInductionDate`
  // measures notice from the date handed to it, so walking forward this way
  // yields successive bookable Mondays rather than the same one repeatedly.
  let cursor = new Date();
  for (let i = 0; i < (parsed.data.count ?? DEFAULT_DATE_COUNT); i++) {
    const iso = nextBookableInductionDate(cursor);
    dates.push({ date: iso, holidayListExpired: iso > coverThrough });
    cursor = new Date(`${iso}T00:00:00`);
  }

  res.json({ dates, holidaysCoverThrough: coverThrough });
}));
