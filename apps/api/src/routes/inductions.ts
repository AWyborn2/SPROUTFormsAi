import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@formai/db';
import {
  assessInductionReadiness,
  buildInductionCohorts,
  CHC_FIELD_IDS,
  holidaysCoverThrough,
  isIsoDate,
  ISO_DATE_PATTERN,
  nextBookableInductionDate,
  isFileRef,
  readStarterProfile,
  dispositionForSubmission,
  seedProfileFromStarter,
  type AssessedStarter,
  type FormField,
  type StarterProfile,
} from '@formai/shared';
import { requireMachineOrTenant } from '../middleware/machine.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { tierCarriesProfiles } from '../lib/profile-access.js';
import { recordAudit } from '../audit/record.js';
import { sealSession, unsealSession } from '../auth/replit-auth.js';
import { getStorageClient } from '../storage/index.js';
import { ATTACHMENT_KEY_RE, EXT_CONTENT_TYPE } from './uploads.js';
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

/** The date shape @formai/shared stores and compares — never a second copy. */
const ISO_DATE = ISO_DATE_PATTERN;

/** How many upcoming Mondays `GET /dates` returns when the caller doesn't say. */
const DEFAULT_DATE_COUNT = 4;
const MAX_DATE_COUNT = 26;

/**
 * Who lodged the intake, as distinct from who it is about.
 *
 * The two are routinely different people — HR, a supervisor or a coordinator
 * fills the form for a starter — and both of them need the booking
 * confirmation. Without this, the only address on the payload is the starter's,
 * and the requester finds out what was booked by being told separately or not
 * at all.
 *
 * `verified` is the load-bearing field. On an authenticated submit the API
 * stamps identity from the session and ignores any claim in the body, so the
 * address is the org's own record of that user. A public fill link has no
 * session: the name and address are whatever the filler typed. An agent about
 * to put a confirmation in front of a human should be able to tell those apart,
 * because "email the person who submitted this" is a very different act when
 * the address is self-asserted.
 */
interface SubmittedBy {
  name: string;
  email: string;
  verified: boolean;
}

interface CandidateRow {
  submissionId: string;
  submittedAt: string;
  status: string;
  submittedBy: SubmittedBy;
  starter: Omit<StarterProfile, 'sensitive'>;
  readiness: AssessedStarter['readiness'];
  blockers: AssessedStarter['blockers'];
  warnings: AssessedStarter['warnings'];
  /**
   * Whether this starter's booked seat has been confirmed — the Thursday
   * gate-check decision, recorded per seat. Absent when the starter has no
   * booking yet: "unconfirmed" is a state a BOOKING can be in, and reporting it
   * on an unbooked candidate would read as a chase-this signal for a seat that
   * does not exist.
   */
  bookingConfirmed?: boolean;
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
  row: {
    id: string;
    createdAt: Date;
    status: string;
    submitterName: string;
    submitterEmail: string;
    submittedByUserId: string | null;
  },
  bookingConfirmed?: boolean,
): CandidateRow {
  return {
    submissionId: row.id,
    submittedAt: row.createdAt.toISOString(),
    status: row.status,
    submittedBy: {
      name: row.submitterName,
      email: row.submitterEmail,
      verified: row.submittedByUserId !== null,
    },
    starter: redact(starter.profile),
    readiness: starter.readiness,
    blockers: starter.blockers,
    warnings: starter.warnings,
    ...(bookingConfirmed === undefined ? {} : { bookingConfirmed }),
  };
}

type SubmissionRow = typeof schema.submissions.$inferSelect;

/**
 * The pinned field list for each submission's version.
 *
 * Both the listing path and the booking path need it, and both need it as one
 * batched read rather than a query per row.
 */
async function pinnedFieldsFor(rows: SubmissionRow[]): Promise<Map<string, FormField[]>> {
  if (!db || rows.length === 0) return new Map();
  const versions = await db.query.formTemplateVersions.findMany({
    where: inArray(
      schema.formTemplateVersions.id,
      [...new Set(rows.map((r) => r.templateVersionId))],
    ),
  });
  return new Map(
    versions.map((v) => [v.id, Array.isArray(v.fields) ? (v.fields as FormField[]) : []]),
  );
}

/**
 * The submissions already covered by a booking, each with its seat's
 * confirmation state.
 *
 * Scoped by submission id rather than org because the ids handed in are always
 * already org-filtered — every caller of this reached them through a query
 * that filtered on `orgId` first.
 */
async function bookedSeatsBySubmission(
  submissionIds: string[],
): Promise<Map<string, { confirmedAt: Date | null }>> {
  if (!db || submissionIds.length === 0) return new Map();
  const rows = await db.query.inductionBookingStarters.findMany({
    where: inArray(schema.inductionBookingStarters.submissionId, submissionIds),
  });
  return new Map(rows.map((r) => [r.submissionId, { confirmedAt: r.confirmedAt ?? null }]));
}

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
  allowLateNotice = false,
): Promise<{ starter: AssessedStarter; row: SubmissionRow; bookingConfirmed?: boolean }[]> {
  if (!db) return [];
  const rows = await db.query.submissions.findMany({
    where: eq(schema.submissions.orgId, orgId),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });
  if (rows.length === 0) return [];

  const fieldsByVersion = await pinnedFieldsFor(rows);
  const booked = await bookedSeatsBySubmission(rows.map((r) => r.id));

  const assessed: { starter: AssessedStarter; row: SubmissionRow; bookingConfirmed?: boolean }[] =
    [];
  for (const row of rows) {
    const fields = fieldsByVersion.get(row.templateVersionId);
    if (!fields) continue;
    const profile = readStarterProfile(fields, row.values);
    if (!profile) continue;
    const seat = booked.get(row.id);
    assessed.push({
      starter: {
        submissionId: row.id,
        profile,
        ...assessInductionReadiness(profile, {
          today,
          alreadyBooked: booked.has(row.id),
          allowLateNotice,
        }),
      },
      row,
      ...(seat ? { bookingConfirmed: seat.confirmedAt !== null } : {}),
    });
  }
  return assessed;
}

/** Reading inductions is reading submissions — the same grant governs both. */
async function canRead(tenant: { orgId: string; role: string }): Promise<boolean> {
  return hasPermission(tenant, 'submissions', 'view');
}

/**
 * The operator's notice override, as a query flag.
 *
 * Express hands query values through as strings, so this matches the
 * `includeSensitive` convention rather than inventing a second coercion.
 */
const allowLateNoticeFlag = z.enum(['true', 'false']).optional();
const isOn = (flag?: string) => flag === 'true';

const listQuery = z.object({
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
  readiness: z.enum(['ready', 'blocked']).optional(),
  allowLateNotice: allowLateNoticeFlag,
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

  const assessed = await loadAssessedStarters(
    tenant.orgId,
    new Date(),
    isOn(parsed.data.allowLateNotice),
  );
  const matching = assessed.filter(({ starter }) => {
    const date = starter.profile.inductionDate;
    if (from && (!isIsoDate(date) || date < from)) return false;
    if (to && (!isIsoDate(date) || date > to)) return false;
    if (readiness && starter.readiness !== readiness) return false;
    return true;
  });

  res.json({
    candidates: matching.map(({ starter, row, bookingConfirmed }) =>
      candidateDto(starter, row, bookingConfirmed),
    ),
    holidaysCoverThrough: holidaysCoverThrough(),
  });
}));

const detailQuery = z.object({
  includeSensitive: z.enum(['true', 'false']).optional(),
  allowLateNotice: allowLateNoticeFlag,
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

  const booked = await bookedSeatsBySubmission([row.id]);
  const seat = booked.get(row.id);
  const assessed: AssessedStarter = {
    submissionId: row.id,
    profile,
    ...assessInductionReadiness(profile, {
      today: new Date(),
      alreadyBooked: booked.has(row.id),
      allowLateNotice: isOn(parsed.data.allowLateNotice),
    }),
  };
  const body = candidateDto(assessed, row, seat ? seat.confirmedAt !== null : undefined);

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

/**
 * What a submission would seed onto a member profile, and whether it may (U40).
 *
 * A READ, not a write. It answers the two questions the Admin's create screen
 * needs — what the record would say, and whether this person already has one —
 * and leaves the creating to the profile route the screen already calls. That
 * keeps ONE create path: a second one here would need its own validation, its
 * own seat check and its own audit line, and would drift from all three.
 *
 * R89/R90: a submission for somebody who already holds a record creates
 * NOTHING. It goes to an Admin, who is told the record exists and — where they
 * were deactivated — asked whether they should be reactivated. Reactivation
 * takes a seat and may buy a block (R78, R86), so it is not a decision to take
 * automatically off the back of a form submission.
 *
 * The address match is U28's, read for a different inbound path rather than
 * re-implemented, so a person entering through an import and through an
 * induction cannot end up with two records.
 */
inductionsRouter.get('/candidates/:id/profile-seed', requireMachineOrTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  // Seeding a record is an Admin act — it is the entry point to creating one.
  if (!(await hasPermission(tenant, 'profiles', 'edit'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  /*
    And the TIER gate every other profile surface applies: an organisation below
    the tier that carries assessments holds no profiles at all, so this route
    must not be its way in. The permission check above reads the matrix, which
    knows nothing about the plan.
  */
  const seedOrg = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, tenant.orgId),
  });
  if (!seedOrg || !tierCarriesProfiles(seedOrg.planTier)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const row = await db.query.submissions.findFirst({
    where: and(eq(schema.submissions.id, req.params.id!), eq(schema.submissions.orgId, tenant.orgId)),
  });
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

  /*
    R94 needs the organisation's CURRENT lists, because the check is whether a
    historical answer still exists as an option. Retired values are excluded:
    a retired Department is exactly one the answer may no longer be written to.
  */
  const [departments, jobRoles] = await Promise.all([
    db.query.departments.findMany({ where: eq(schema.departments.orgId, tenant.orgId) }),
    db.query.jobRoles.findMany({ where: eq(schema.jobRoles.orgId, tenant.orgId) }),
  ]);
  const seed = seedProfileFromStarter(profile, {
    departments: departments.filter((d) => d.status !== 'retired').map((d) => d.name),
    roles: jobRoles.filter((r) => r.status !== 'retired').map((r) => r.name),
  });

  // The address match, U28's, read here rather than re-implemented.
  const existingUser = seed.email
    ? await db.query.users.findFirst({ where: eq(schema.users.email, seed.email.toLowerCase()) })
    : undefined;
  const membership = existingUser
    ? await db.query.memberships.findFirst({
        where: and(
          eq(schema.memberships.orgId, tenant.orgId),
          eq(schema.memberships.userId, existingUser.id),
        ),
      })
    : undefined;
  const disposition = dispositionForSubmission({
    hasMembership: Boolean(membership),
    membershipStatus: membership?.status,
  });

  res.json({
    submissionId: row.id,
    disposition,
    seed,
    /** Set on a repeat, so the Admin can open the record rather than retype it. */
    membershipId: membership?.id ?? null,
  });
}));

const cohortQuery = z.object({
  date: z.string().regex(ISO_DATE).optional(),
  allowLateNotice: allowLateNoticeFlag,
});

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

  const assessed = await loadAssessedStarters(
    tenant.orgId,
    new Date(),
    isOn(parsed.data.allowLateNotice),
  );
  const byId = new Map(assessed.map((entry) => [entry.starter.submissionId, entry]));
  const cohorts = buildInductionCohorts(assessed.map(({ starter }) => starter)).filter(
    (c) => !parsed.data.date || c.date === parsed.data.date,
  );

  res.json({
    cohorts: cohorts.map((cohort) => ({
      date: cohort.date,
      seats: cohort.seats,
      readyCount: cohort.readyCount,
      blockedCount: cohort.blockedCount,
      starters: cohort.starters.map((starter) => {
        const entry = byId.get(starter.submissionId)!;
        return candidateDto(starter, entry.row, entry.bookingConfirmed);
      }),
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

/* ── Bookings ────────────────────────────────────────────────────────────── */

/**
 * Recording a booking is acting on submission data, so it gates on the same
 * grant exporting does. The permission matrix has no booking action, and
 * inventing a category for one consumer would leave every org's stored matrix
 * needing a migration; `submissions.export` is the existing action meaning "may
 * take this data out of the system and do something with it", which is exactly
 * what a booking is the record of. (Mirrors the reasoning behind
 * `canApproveSubmissions` in submissions.ts.)
 */
async function canBook(tenant: { orgId: string; role: string }): Promise<boolean> {
  return hasPermission(tenant, 'submissions', 'export');
}

function bookingDto(
  booking: typeof schema.inductionBookings.$inferSelect,
  starters: { submissionId: string; starterName: string; confirmedAt?: Date | null }[],
) {
  return {
    id: booking.id,
    date: booking.inductionDate,
    seats: booking.seats,
    externalReference: booking.externalReference,
    note: booking.note,
    noticeOverrideReason: booking.noticeOverrideReason,
    bookedByUserId: booking.bookedByUserId,
    bookedByApiKeyId: booking.bookedByApiKeyId,
    createdAt: booking.createdAt.toISOString(),
    /** A booking reads as confirmed only when every seat on it is. */
    confirmed: starters.length > 0 && starters.every((s) => s.confirmedAt != null),
    starters: starters.map((s) => ({
      submissionId: s.submissionId,
      starterName: s.starterName,
      confirmedAt: s.confirmedAt ? s.confirmedAt.toISOString() : null,
    })),
  };
}

const createBookingBody = z.object({
  date: z.string().regex(ISO_DATE),
  submissionIds: z.array(z.string().min(1)).min(1).max(50),
  externalReference: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
  /**
   * Required only when a starter on this booking is inside the notice window.
   * Free text on purpose — the site's reasons for absorbing short notice are
   * not an enum anybody could enumerate in advance.
   */
  noticeOverrideReason: z.string().min(1).max(500).optional(),
});

inductionsRouter.post('/bookings', requireMachineOrTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canBook(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = createBookingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }
  const { date, submissionIds, externalReference, note, noticeOverrideReason } = parsed.data;
  const wanted = [...new Set(submissionIds)];

  const rows = await db.query.submissions.findMany({
    where: and(eq(schema.submissions.orgId, tenant.orgId), inArray(schema.submissions.id, wanted)),
  });
  // A submission in another org is simply absent from this result, so a
  // cross-tenant booking attempt reads as "not found" rather than as a hint
  // that the id exists somewhere.
  if (rows.length !== wanted.length) {
    const found = new Set(rows.map((r) => r.id));
    res.status(404).json({ error: 'not_found', submissionIds: wanted.filter((id) => !found.has(id)) });
    return;
  }

  const fieldsByVersion = await pinnedFieldsFor(rows);

  const starters: { submissionId: string; starterName: string }[] = [];
  const lateNotice: string[] = [];
  for (const row of rows) {
    const profile = readStarterProfile(fieldsByVersion.get(row.templateVersionId) ?? [], row.values);
    if (!profile) {
      res.status(400).json({ error: 'not_an_induction_candidate', submissionId: row.id });
      return;
    }
    // One booking covers one date — that is how the site books it, one
    // transaction with N seats. A starter requesting a different Monday
    // belongs to a different booking, not this one.
    if (profile.inductionDate !== date) {
      res.status(400).json({
        error: 'date_mismatch',
        submissionId: row.id,
        inductionDate: profile.inductionDate,
      });
      return;
    }
    // Assessed with the override ON so a short-notice starter surfaces as a
    // `notice_overridden` warning rather than a blocker — that warning is
    // exactly the signal that a recorded reason is owed below.
    const verdict = assessInductionReadiness(profile, { allowLateNotice: true });
    if (verdict.warnings.includes('notice_overridden')) lateNotice.push(row.id);
    starters.push({ submissionId: row.id, starterName: profile.fullName });
  }

  // A short-notice booking is allowed, but never silently. Refusing without a
  // reason is what keeps the exception in the record instead of in somebody's
  // memory — the same "record the decision, don't make it" rule the assessment
  // workflow follows elsewhere.
  if (lateNotice.length > 0 && !noticeOverrideReason) {
    res.status(400).json({
      error: 'notice_override_required',
      submissionIds: lateNotice,
      detail: `${lateNotice.length} starter${lateNotice.length === 1 ? ' is' : 's are'} past the Thursday booking cutoff for that date. Pass noticeOverrideReason to record why the site accepted the booking anyway.`,
    });
    return;
  }

  const alreadyBooked = await bookedSeatsBySubmission(wanted);
  if (alreadyBooked.size > 0) {
    // A retried tool call must not consume a second seat for the same person.
    res.status(409).json({ error: 'already_booked', submissionIds: [...alreadyBooked.keys()] });
    return;
  }

  const [booking] = await db
    .insert(schema.inductionBookings)
    .values({
      orgId: tenant.orgId,
      inductionDate: date,
      seats: starters.length,
      externalReference: externalReference ?? '',
      note: note ?? '',
      // Only stored when it was actually needed, so a non-empty value always
      // means "this booking waived the notice rule".
      noticeOverrideReason: lateNotice.length > 0 ? (noticeOverrideReason ?? '') : '',
      bookedByUserId: tenant.userId,
      bookedByApiKeyId: req.apiKeyId ?? null,
    })
    .returning();
  if (!booking) throw new Error('induction_booking_create_failed: insert returned no row');

  await db
    .insert(schema.inductionBookingStarters)
    .values(starters.map((s) => ({ bookingId: booking.id, ...s })));

  await recordAudit(db, tenant, {
    action: lateNotice.length > 0
      ? 'Recorded induction booking with notice override'
      : req.apiKeyId
        ? 'Recorded induction booking via API key'
        : 'Recorded induction booking',
    target: `${date} — ${starters.length} seat${starters.length === 1 ? '' : 's'}${lateNotice.length > 0 ? ` — notice waived: ${noticeOverrideReason}` : ''}`,
    category: 'submissions',
    icon: 'calendar-check',
  });

  res.status(201).json(bookingDto(booking, starters));
}));

const listBookingsQuery = z.object({ date: z.string().regex(ISO_DATE).optional() });

inductionsRouter.get('/bookings', requireMachineOrTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canRead(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = listBookingsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }

  const bookings = await db.query.inductionBookings.findMany({
    where: parsed.data.date
      ? and(
          eq(schema.inductionBookings.orgId, tenant.orgId),
          eq(schema.inductionBookings.inductionDate, parsed.data.date),
        )
      : eq(schema.inductionBookings.orgId, tenant.orgId),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
  });
  if (bookings.length === 0) {
    res.json({ bookings: [] });
    return;
  }

  const starterRows = await db.query.inductionBookingStarters.findMany({
    where: inArray(
      schema.inductionBookingStarters.bookingId,
      bookings.map((b) => b.id),
    ),
  });
  const startersByBooking = new Map<string, { submissionId: string; starterName: string }[]>();
  for (const row of starterRows) {
    const bucket = startersByBooking.get(row.bookingId);
    if (bucket) bucket.push(row);
    else startersByBooking.set(row.bookingId, [row]);
  }

  res.json({ bookings: bookings.map((b) => bookingDto(b, startersByBooking.get(b.id) ?? [])) });
}));

const confirmBookingBody = z.object({
  /** Which seats to confirm. Absent means every starter on the booking. */
  submissionIds: z.array(z.string().min(1)).min(1).max(50).optional(),
});

/**
 * Records the Thursday gate-check decision, per seat.
 *
 * A booking is tentative until a human has checked the starter is ready and
 * the seat stands; this route stores that decision and nothing else — what was
 * checked stays the operator's own checklist, outside the product. Confirming
 * asserts an external fact about the booking, the same class of act as
 * recording it, so it gates on `canBook` above.
 *
 * Idempotent by design: a seat already confirmed keeps its first timestamp and
 * actor, and the response separates newly-confirmed from already-confirmed, so
 * a retried tool call reads as a no-op rather than an error.
 */
inductionsRouter.post('/bookings/:id/confirm', requireMachineOrTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await canBook(tenant))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = confirmBookingBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }

  const booking = await db.query.inductionBookings.findFirst({
    where: and(
      eq(schema.inductionBookings.id, req.params.id!),
      eq(schema.inductionBookings.orgId, tenant.orgId),
    ),
  });
  // A booking in another org is NOT FOUND, not FORBIDDEN — same cross-tenant
  // reasoning as the candidate detail route.
  if (!booking) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const starterRows = await db.query.inductionBookingStarters.findMany({
    where: eq(schema.inductionBookingStarters.bookingId, booking.id),
  });

  const wanted = parsed.data.submissionIds ? [...new Set(parsed.data.submissionIds)] : null;
  if (wanted) {
    const onBooking = new Set(starterRows.map((r) => r.submissionId));
    const strays = wanted.filter((id) => !onBooking.has(id));
    if (strays.length > 0) {
      res.status(400).json({ error: 'not_on_booking', submissionIds: strays });
      return;
    }
  }

  const targets = wanted
    ? starterRows.filter((r) => wanted.includes(r.submissionId))
    : starterRows;
  const newly = targets.filter((r) => r.confirmedAt == null);
  const already = targets.filter((r) => r.confirmedAt != null);

  const confirmedAt = new Date();
  if (newly.length > 0) {
    await db
      .update(schema.inductionBookingStarters)
      .set({
        confirmedAt,
        confirmedByUserId: tenant.userId,
        confirmedByApiKeyId: req.apiKeyId ?? null,
      })
      .where(
        inArray(
          schema.inductionBookingStarters.id,
          newly.map((r) => r.id),
        ),
      );

    await recordAudit(db, tenant, {
      action: req.apiKeyId
        ? 'Confirmed induction booking via API key'
        : 'Confirmed induction booking',
      target: `${booking.inductionDate} — ${newly.map((r) => r.starterName).join(', ')}`,
      category: 'submissions',
      icon: 'calendar-check',
    });
  }

  const newlyIds = new Set(newly.map((r) => r.id));
  const starters = starterRows.map((r) => (newlyIds.has(r.id) ? { ...r, confirmedAt } : r));
  res.json({
    ...bookingDto(booking, starters),
    newlyConfirmed: newly.map((r) => r.submissionId),
    alreadyConfirmed: already.map((r) => r.submissionId),
  });
}));

/* ── Identity documents ──────────────────────────────────────────────────── */

/**
 * A capability to read exactly one stored document, for a few minutes.
 *
 * Sealed with the same AES-256-GCM helper the session cookie uses, so the token
 * is tamper-evident and carries its own expiry. It names the object directly
 * rather than the submission, so a link cannot be replayed against a different
 * starter after the answer changes.
 */
interface DocumentGrant {
  orgId: string;
  key: string;
}

/**
 * How long a minted link stays usable.
 *
 * Long enough for an agent to hand the URL to a browser and upload the file
 * somewhere; short enough that a link copied into a chat transcript is dead
 * before anyone reads the transcript back.
 */
const DOCUMENT_LINK_TTL_MS = 5 * 60 * 1000;

const DOCUMENT_FIELDS = {
  photo: CHC_FIELD_IDS.photo,
  driversLicence: CHC_FIELD_IDS.driversLicence,
} as const;

const documentParams = z.object({ kind: z.enum(['photo', 'driversLicence']) });

inductionsRouter.get(
  '/candidates/:id/documents/:kind',
  requireMachineOrTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    // An identity document is the most sensitive thing this router can reach,
    // so minting a link needs the same grant as exporting a submission — a
    // read-only viewer key can see that a photo exists and nothing more.
    if (!(await hasPermission(tenant, 'submissions', 'export'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = documentParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const row = await db.query.submissions.findFirst({
      where: and(eq(schema.submissions.id, req.params.id!), eq(schema.submissions.orgId, tenant.orgId)),
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Read the raw answer rather than the profile: `readStarterProfile`
    // deliberately drops the storage key, which is exactly what this route
    // needs and nothing else is allowed to see.
    const answer = row.values[DOCUMENT_FIELDS[parsed.data.kind]];
    if (!isFileRef(answer) || !answer.key.startsWith(`${tenant.orgId}/`)) {
      res.status(404).json({ error: 'document_not_found' });
      return;
    }

    const grant: DocumentGrant = { orgId: tenant.orgId, key: answer.key };
    const token = sealSession(grant, DOCUMENT_LINK_TTL_MS);

    await recordAudit(db, tenant, {
      action: req.apiKeyId
        ? 'Issued induction document link via API key'
        : 'Issued induction document link',
      target: `${parsed.data.kind}: ${answer.fileName}`,
      category: 'security',
      icon: 'link',
    });

    // A PATH, not a URL. The API is reached through a proxy that adds a prefix
    // it knows nothing about, so guessing an absolute URL here would produce a
    // link that 404s. The caller knows the base it used to get here.
    res.json({
      path: `/inductions/documents/${encodeURIComponent(token)}`,
      expiresAt: new Date(Date.now() + DOCUMENT_LINK_TTL_MS).toISOString(),
      fileName: answer.fileName,
      contentType: answer.contentType,
      size: answer.size,
    });
  }),
);

/**
 * Serves the bytes a minted link points at.
 *
 * Deliberately unauthenticated: the token IS the credential, which is what
 * makes the link usable by a plain browser or downloader that has no API key.
 * Every rejection is an identical 404 — an expired token, a forged one, and a
 * key that no longer exists must be indistinguishable, or the endpoint becomes
 * a way to probe what the storage holds.
 */
inductionsRouter.get(
  '/documents/:token',
  withErrorHandling(async (req, res) => {
    const grant = unsealSession<DocumentGrant>(req.params.token!);
    if (!grant || !ATTACHMENT_KEY_RE.test(grant.key) || !grant.key.startsWith(`${grant.orgId}/`)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const bytes = await client.download(grant.orgId, grant.key);
    if (!bytes) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const ext = grant.key.slice(grant.key.lastIndexOf('.') + 1).toLowerCase();
    res.setHeader('Content-Type', EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream');
    // Same hardening as the authenticated door: respondent-supplied bytes must
    // never be sniffed into a scriptable type or opened as an active document.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // The URL is a short-lived secret; a shared cache must not keep a copy of
    // what it returned.
    res.setHeader('Cache-Control', 'no-store');
    res.send(bytes);
  }),
);
