/**
 * The decision layer between "a submission was written" and "fire the webhook".
 *
 * Kept out of the route so the route reads as one line. Everything here is
 * conditional and none of it is allowed to fail the write that triggered it.
 */
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import {
  assessInductionReadiness,
  readStarterProfile,
  type FormField,
  type TenantContext,
} from '@formai/shared';
import { recordAudit } from '../audit/record.js';
import { maskWebhookUrl, sendInductionWebhook } from './induction.js';

type SubmissionRow = typeof schema.submissions.$inferSelect;

/**
 * Notify the org's configured endpoint that an induction intake arrived.
 *
 * Fire-and-forget by design — the caller does `void notifyInductionIntake(...)`
 * and answers the filler immediately. Making a form submission wait on someone
 * else's HTTP endpoint would put a third party's uptime in the path of the
 * thing the user actually came to do, and there is nothing in the response the
 * filler needs.
 *
 * Whether a submission is an induction intake is decided by SHAPE, not by the
 * template's name: `readStarterProfile` returns null unless the pinned version
 * carries the CHC intake fields. That is the same detection the inductions
 * router uses, and it survives someone renaming the form.
 */
export async function notifyInductionIntake(
  db: Db,
  tenant: TenantContext,
  row: SubmissionRow,
  versionFields: FormField[],
): Promise<void> {
  // A draft is not a record. Notifying on one would announce a starter who may
  // still be half-entered, and the draft→submitted transition notifies anyway.
  if (row.status === 'draft') return;

  const profile = readStarterProfile(versionFields, row.values);
  if (!profile) return;

  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, row.orgId),
  });
  const url = org?.inductionWebhookUrl ?? '';
  if (!url) return;

  const verdict = assessInductionReadiness(profile, { today: new Date() });

  const outcome = await sendInductionWebhook(url, {
    event: 'induction_intake.submitted',
    submissionId: row.id,
    submittedAt: row.createdAt.toISOString(),
    submittedBy: {
      name: row.submitterName,
      email: row.submitterEmail,
      verified: row.submittedByUserId !== null,
    },
    starter: {
      fullName: profile.fullName,
      inductionDate: profile.inductionDate,
      department: profile.department,
      roles: profile.roles,
    },
    readiness: verdict.readiness,
    blockers: verdict.blockers,
    warnings: verdict.warnings,
  });

  // Audited either way. A webhook that silently stopped delivering is the
  // failure mode worth being able to see afterwards — "nobody was told" looks
  // identical to "no intake arrived" unless the attempt left a trace. The
  // target is masked: the query string is the credential.
  await recordAudit(db, tenant, {
    action: outcome.delivered
      ? 'Induction intake webhook delivered'
      : 'Induction intake webhook FAILED',
    target: outcome.delivered
      ? `${profile.fullName} → ${maskWebhookUrl(url)}`
      : `${profile.fullName} → ${maskWebhookUrl(url)} (${outcome.reason})`,
    category: 'settings',
    icon: outcome.delivered ? 'webhook' : 'alert-triangle',
  });
}
