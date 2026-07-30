import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', [
  'owner',
  'admin',
  'builder',
  'reviewer',
  'viewer',
  'assessor',
  'candidate',
]);

export const membershipStatusEnum = pgEnum('membership_status', [
  'active',
  'invited',
  'suspended',
]);

export const formSourceTypeEnum = pgEnum('form_source_type', [
  'pdf_import',
  'built_from_scratch',
]);

export const templateStatusEnum = pgEnum('template_status', ['draft', 'published', 'archived']);

export const versionStateEnum = pgEnum('version_state', ['draft', 'published']);

export const submissionStatusEnum = pgEnum('submission_status', [
  'draft',
  'submitted',
  'reviewed',
  'complete',
  'approved',
  'review',
  'rejected',
  'pending',
]);

export const assessmentPathwayEnum = pgEnum('assessment_pathway', [
  'experienced',
  'new',
  'rpl',
]);

export const partOutcomeEnum = pgEnum('part_outcome', ['satisfactory', 'not_satisfactory']);

export const nsDispositionEnum = pgEnum('ns_disposition', [
  'retry',
  'coaching_then_retry',
  'change_pathway',
  'not_yet_competent',
]);

export const assessmentCaseStateEnum = pgEnum('assessment_case_state', [
  'open',
  /*
    Every required part has passed; the assessor has not yet approved. NOT
    terminal — `closedAt` stays null here, and `isTerminalCaseState` is what
    decides that, rather than a comparison against 'open'.

    Added by migration 0022 alongside the sign-off columns. That is safe because
    no migration WRITES this value: PostgreSQL's restriction (55P04) is on using
    a new enum value in the transaction that added it, not on adding it beside
    other DDL. If a future migration ever needs to backfill rows TO this value,
    that backfill must be its own migration — drizzle runs all pending ones in a
    single transaction.
  */
  'awaiting_sign_off',
  'competent',
  'closed',
]);

export const auditCategoryEnum = pgEnum('audit_category', [
  'forms',
  'submissions',
  'team',
  'settings',
  'security',
  'general',
]);
