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

/**
 * Whether a taxonomy value (Location, Department, Role) may still be chosen.
 * Retiring keeps the value on existing records (R114) and blocks it for new
 * ones (R16); it is never a delete.
 */
export const taxonomyStatusEnum = pgEnum('taxonomy_status', ['active', 'retired']);

/**
 * A voluntary training request's lifecycle (U22). A person asks for an
 * assessment no Role obliges them to hold; it waits `pending` on the working
 * list until an Admin `approved` it (which assigns) or `declined` it.
 */
export const trainingRequestStateEnum = pgEnum('training_request_state', [
  'pending',
  'approved',
  'declined',
]);

/**
 * Which of the two workforce numbers the organisation shows beside a person's
 * name (R40). The numbers themselves live on the profile; this is only the
 * organisation's choice of which one identifies its people on screen.
 */
export const displayIdentifierEnum = pgEnum('display_identifier', [
  'employee_number',
  'swipe_card_number',
]);

/**
 * A competency document's place in its own history (KTD24, R31, R32, R52).
 *
 * `held` is the record's evidence — a competency may carry several (R28).
 * `pending` is a replacement a candidate supplied, waiting for approval; it is
 * NOT the record's evidence until accepted (R52). `superseded` is a document an
 * accepted replacement displaced, retained as evidence of what was sighted at
 * the time (R31). `rejected` is a replacement that was refused, kept as a record
 * of what was submitted and when. `removed` is the Admin-only, audited, reasoned
 * escape hatch for a document filed against the wrong person (R32).
 *
 * NOTHING here is a delete. Every state is retrievable; only `held` is current.
 */
export const documentStateEnum = pgEnum('document_state', [
  'held',
  'pending',
  'superseded',
  'rejected',
  'removed',
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

/**
 * WHO marked an attempt (U15, R70, KTD14). `automatic` is an answer-key mark
 * that no person made — its `assessorUserId` and `assessorName` stay null/empty
 * so the record never prints a submitter's name against a mark they did not
 * make. `person` is an assessor's judgement, named and attributed. Null while
 * the attempt is unmarked.
 */
export const attemptMarkerKindEnum = pgEnum('attempt_marker_kind', ['person', 'automatic']);

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
  /*
    Abandoned because the candidate was deactivated (R71), and RETAINED as
    history along with anything already signed on it (R72) — whether or not the
    person ever returns.

    TERMINAL, like `closed` and `competent` — nobody will work it again and
    `closedAt` dates the abandonment. It is a separate value rather than
    `closed` because `closed` reads as a case that finished, and a reactivated
    candidate begins that assessment as a NEW case rather than resuming this one
    (R74): the two must stay distinguishable in the history.

    Nothing backfills rows to this value, which keeps it clear of the 55P04
    restriction on using an enum value in the transaction that added it.
  */
  'invalidated',
]);

export const auditCategoryEnum = pgEnum('audit_category', [
  'forms',
  'submissions',
  'team',
  'settings',
  'security',
  'general',
  /*
    Member profile edits (R57), and the category R58's filter keys on: an entry
    covering a field the inventory marks sensitive is readable by Admin only, so
    a Reviewer keeps the audit read they hold today and stops seeing dates of
    birth and home addresses within it.

    Nothing backfills rows to this value, which keeps it clear of the 55P04
    restriction on using an enum value in the transaction that added it.
  */
  'profiles',
  /*
    A seat block added at the allocation boundary (R86). Its own category rather
    than `settings` because a moved integer on the organisation row is otherwise
    indistinguishable from an Admin editing the limit by hand, and this one costs
    the organisation money it did not ask to spend.

    Nothing backfills rows to this value, which keeps it clear of the 55P04
    restriction on using an enum value in the transaction that added it.
  */
  'billing',
]);

/**
 * What one row of a workforce import DID (U24, R171).
 *
 * The run report is DERIVED from these rather than from counters kept beside
 * the run: a stored tally and the rows it counts can disagree, and the rows are
 * the artifact an Admin needs anyway to correct the source file and re-import.
 *
 * `duplicate` is a second row for an address an earlier row already handled —
 * distinct from `merged`, which found an existing ACTIVE membership. The first
 * wrote nothing because the file repeated itself; the second wrote nothing
 * because the person was already here.
 */
export const importRowOutcomeEnum = pgEnum('import_row_outcome', [
  'created',
  'added_membership',
  'reactivated',
  'merged',
  'duplicate',
  'rejected',
]);
