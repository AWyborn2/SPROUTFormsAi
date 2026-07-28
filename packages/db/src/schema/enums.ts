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
