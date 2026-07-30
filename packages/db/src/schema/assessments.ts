import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { AssessmentToolManifest, SubmissionValue } from '@formai/shared';
import {
  assessmentCaseStateEnum,
  assessmentPathwayEnum,
  nsDispositionEnum,
  partOutcomeEnum,
} from './enums.ts';
import { organizations, users } from './organizations.ts';
import { formTemplates, formTemplateVersions } from './forms.ts';

/**
 * An assessment tool — the part structure laid over a form template.
 *
 * Kept beside the template rather than inside it because the manifest is
 * authored ONCE per tool and edited independently of the fields: a template
 * version is immutable after publishing, so storing part boundaries there would
 * mint a new form version every time someone corrected a part label.
 */
export const assessmentTools = pgTable(
  'assessment_tools',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    templateId: uuid()
      .notNull()
      .references(() => formTemplates.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Ordered parts, their kinds, pathways and start fields. */
    manifest: jsonb().$type<AssessmentToolManifest>().notNull(),
    /** Competency ids a CANDIDATE must hold. Warned on, never blocking. */
    candidatePrerequisiteIds: jsonb('candidate_prerequisite_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Competency ids an ASSESSOR must hold to assess this tool. */
    assessorCompetencyIds: jsonb('assessor_competency_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    /*
      Competency ids this tool AWARDS on sign-off. The tool declared what a
      candidate must bring and what an assessor must hold, but never what
      passing it confers — so a competent case updated its own state and the
      register it exists to maintain stayed empty, and prerequisite chains could
      never be built out of the product's own assessments.

      jsonb of ids with no FK, matching the two above. Not laziness: competency
      delete has no dependency check, so `restrict` turns a routine tidy-up into
      an unhandled 500, `cascade` would delete the assessment tool, and
      `set null` would silently disarm the award with nothing to notice it.
      This degrades exactly the way prerequisites already do.
    */
    awardedCompetencyIds: jsonb('awarded_competency_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /** One tool per template — the manifest describes that template's parts. */
    uniqueIndex('assessment_tools_template_uq').on(t.templateId),
    index('assessment_tools_org_idx').on(t.orgId),
  ],
);

/**
 * One candidate's journey through one assessment tool.
 *
 * The case carries the CURRENT template version; each attempt pins the version
 * it was assessed under. Republishing the tool advances this pointer only, so a
 * candidate mid-pathway moves to the new version for work not yet done while
 * completed evidence keeps saying what it was actually assessed against.
 */
export const assessmentCases = pgTable(
  'assessment_cases',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    toolId: uuid()
      .notNull()
      .references(() => assessmentTools.id, { onDelete: 'restrict' }),
    candidateUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assessorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    pathway: assessmentPathwayEnum().notNull(),
    /** Which location-specific content applies, e.g. 'mining'. */
    locationStream: text('location_stream'),
    state: assessmentCaseStateEnum().notNull().default('open'),
    currentVersionId: uuid('current_version_id')
      .notNull()
      .references(() => formTemplateVersions.id, { onDelete: 'restrict' }),
    /**
     * The case this one appeals. The later outcome supersedes for display while
     * both remain queryable — `restrict` because an appeal that lost its
     * original is an audit trail with a hole in it.
     */
    appealOfCaseId: uuid('appeal_of_case_id').references((): AnyPgColumn => assessmentCases.id, {
      onDelete: 'restrict',
    }),
    appealReason: text('appeal_reason'),
    /** Required when pathway is 'rpl' — why the logged hours were waived. */
    rplJustification: text('rpl_justification'),
    /** Unmet prerequisites recorded at creation. Warnings, never blockers. */
    prerequisiteWarnings: jsonb('prerequisite_warnings')
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp({ withTimezone: true }),

    /*
      THE CERTIFICATION. Written once, by the assessor, at the manual sign-off
      step — the last thing that happens on an assessment.

      Held on the CASE and not derived from the attempts, because the attempt
      columns cannot carry it honestly: `assessorName` there defaults to '' and
      is optional on the outcome body, while `signedAt` is stamped on EVERY
      attempt resolution. Sourcing a certificate from those would print a blank
      name against a real timestamp on the document that certifies a person is
      safe to operate a machine.
    */
    signedOffAt: timestamp('signed_off_at', { withTimezone: true }),
    signedOffByUserId: uuid('signed_off_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The assessor's printed name, as they signed it. */
    signedOffName: text('signed_off_name').notNull().default(''),
    /** PNG data URL, as SignaturePad emits. One per case; 5-40KB. */
    signedOffSignature: text('signed_off_signature').notNull().default(''),
  },
  (t) => [
    index('assessment_cases_org_idx').on(t.orgId),
    index('assessment_cases_candidate_idx').on(t.candidateUserId),
    index('assessment_cases_assessor_idx').on(t.assessorUserId),
    index('assessment_cases_tool_idx').on(t.toolId),
  ],
);

/**
 * One attempt at one part.
 *
 * Attempts are rows, never mutated in place: a retry allocates the next
 * `attemptNumber` and leaves the failed row intact. The evidence document
 * renders the latest attempt whose outcome is satisfactory; the audit trail
 * keeps every attempt including the failures. That split is the whole reason
 * this table exists rather than a status column on the case.
 */
export const assessmentPartAttempts = pgTable(
  'assessment_part_attempts',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    caseId: uuid()
      .notNull()
      .references(() => assessmentCases.id, { onDelete: 'cascade' }),
    /** Manifest part key this attempt belongs to. */
    partKey: text('part_key').notNull(),
    /** 1-based; unique per case and part. */
    attemptNumber: integer('attempt_number').notNull().default(1),
    /** The version this attempt was assessed under. Never rewritten. */
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => formTemplateVersions.id, { onDelete: 'restrict' }),
    /** This part's slice of the document's answers. */
    values: jsonb().$type<Record<string, SubmissionValue>>().notNull().default({}),
    /** Null while the attempt is still open. */
    outcome: partOutcomeEnum(),
    /** Required alongside a not_satisfactory outcome. */
    disposition: nsDispositionEnum(),
    /** The assessor's mandatory reason for the disposition. */
    dispositionReason: text('disposition_reason'),
    /** Set when a demonstration was run below its logbook hours minimum. */
    belowThresholdReason: text('below_threshold_reason'),
    /** Set once, when a logbook part first reaches its minimum hours. */
    thresholdNotifiedAt: timestamp('threshold_notified_at', { withTimezone: true }),
    /**
     * When the candidate handed this attempt in.
     *
     * Exists because "has answers but no outcome" cannot distinguish someone
     * halfway through from someone who finished a week ago and is waiting — the
     * exact gap that made the paper process untrackable after the theory stage.
     *
     * Not an outcome and not a lock: the candidate can reopen it themselves
     * while it is still unmarked, because nothing has been assessed yet. Only
     * marking makes an attempt permanent.
     */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    assessorUserId: uuid('assessor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Printed name as signed, kept even if the user record later changes. */
    assessorName: text('assessor_name').notNull().default(''),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('assessment_attempts_case_part_number_uq').on(
      t.caseId,
      t.partKey,
      t.attemptNumber,
    ),
    index('assessment_attempts_case_idx').on(t.caseId),
    index('assessment_attempts_org_idx').on(t.orgId),
  ],
);

export const assessmentToolsRelations = relations(assessmentTools, ({ one, many }) => ({
  org: one(organizations, {
    fields: [assessmentTools.orgId],
    references: [organizations.id],
  }),
  template: one(formTemplates, {
    fields: [assessmentTools.templateId],
    references: [formTemplates.id],
  }),
  cases: many(assessmentCases),
}));

export const assessmentCasesRelations = relations(assessmentCases, ({ one, many }) => ({
  org: one(organizations, {
    fields: [assessmentCases.orgId],
    references: [organizations.id],
  }),
  tool: one(assessmentTools, {
    fields: [assessmentCases.toolId],
    references: [assessmentTools.id],
  }),
  candidate: one(users, {
    fields: [assessmentCases.candidateUserId],
    references: [users.id],
  }),
  currentVersion: one(formTemplateVersions, {
    fields: [assessmentCases.currentVersionId],
    references: [formTemplateVersions.id],
  }),
  attempts: many(assessmentPartAttempts),
}));

export const assessmentPartAttemptsRelations = relations(
  assessmentPartAttempts,
  ({ one }) => ({
    case: one(assessmentCases, {
      fields: [assessmentPartAttempts.caseId],
      references: [assessmentCases.id],
    }),
    version: one(formTemplateVersions, {
      fields: [assessmentPartAttempts.templateVersionId],
      references: [formTemplateVersions.id],
    }),
  }),
);
