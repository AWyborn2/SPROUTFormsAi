import { Badge, type BadgeVariant } from '@formai/ui';
import type { AssessmentCaseState, PartState, SubmissionStatus } from '@formai/shared';

const SUB_STATUS: Record<SubmissionStatus, { variant: BadgeVariant; label: string; dot?: boolean }> = {
  complete: { variant: 'success', label: 'Complete' },
  approved: { variant: 'success', label: 'Approved', dot: true },
  review: { variant: 'warning', label: 'Needs review' },
  rejected: { variant: 'danger', label: 'Rejected' },
  pending: { variant: 'info', label: 'Pending' },
  submitted: { variant: 'info', label: 'Submitted' },
  reviewed: { variant: 'success', label: 'Reviewed' },
  draft: { variant: 'neutral', label: 'Draft' },
};

export function SubmissionStatusBadge({ status }: { status: SubmissionStatus }) {
  const b = SUB_STATUS[status];
  return (
    <Badge variant={b.variant} dot={b.dot}>
      {b.label}
    </Badge>
  );
}

/**
 * Assessment outcomes, in the same badge vocabulary as submission statuses.
 *
 * A part's state and a case's state are separate maps even though both use
 * green for a pass: a part that is merely `locked` is ordinary, while a case
 * that is `closed` is a candidate who did not reach competence. Sharing one map
 * would force those two onto the same colour and flatten the distinction an
 * auditor reads the table for.
 */
const PART_STATE: Record<PartState, { variant: BadgeVariant; label: string }> = {
  locked: { variant: 'neutral', label: 'Locked' },
  open: { variant: 'info', label: 'In progress' },
  satisfactory: { variant: 'success', label: 'Satisfactory' },
  not_satisfactory: { variant: 'danger', label: 'Not satisfactory' },
};

/** Reads the part's own label when given no children — a compact chip when given one. */
export function PartStateBadge({ state, children }: { state: PartState; children?: React.ReactNode }) {
  const b = PART_STATE[state];
  return <Badge variant={b.variant}>{children ?? b.label}</Badge>;
}

/** The words for a part state, for tooltips and screen readers. */
export function partStateLabel(state: PartState): string {
  return PART_STATE[state].label;
}

const CASE_STATE: Record<AssessmentCaseState, { variant: BadgeVariant; label: string }> = {
  open: { variant: 'warning', label: 'In progress' },
  // Every required part has passed; the assessor has not yet approved. It must
  // NOT read as "in progress" — the candidate has finished and the case is
  // waiting on a person, which is the one thing an assessor opens this list to
  // find. This is also why the state is stored rather than derived.
  awaiting_sign_off: { variant: 'info', label: 'Awaiting assessor sign-off' },
  competent: { variant: 'success', label: 'Competent' },
  // Terminal but not a pass. "Closed" is the state name; "not yet competent" is
  // what it means to the person reading the row.
  closed: { variant: 'danger', label: 'Not yet competent' },
  /*
    Abandoned because the candidate was deactivated — no judgement about their
    competence, which is why it is neutral rather than `danger`. Reading it as
    "not yet competent" would put a failure against somebody's name for the
    single reason that they left.
  */
  invalidated: { variant: 'neutral', label: 'Discontinued' },
};

export function CaseStateBadge({ state, size }: { state: AssessmentCaseState; size?: 'sm' | 'md' }) {
  // Falls back rather than throwing on a state outside the union. The type says
  // that cannot happen, but these rows come from the API and are read by an
  // auditor — a mislabelled badge is recoverable, a blank screen is not. The two
  // screens this replaced both carried the same guard.
  const b = CASE_STATE[state] ?? CASE_STATE.open;
  return (
    <Badge variant={b.variant} size={size} dot>
      {b.label}
    </Badge>
  );
}

/**
 * The case list's Status cell: the state, plus what STAGE the case is at and
 * whether it is waiting on an ASSESSOR.
 *
 * The badge alone answered "passed or not". An assessor scanning the list also
 * needs "which part is it on" and "is it my turn":
 *  · the stage line names the current part while the case is still moving
 *    through them — a competent or discontinued case has no current part, and a
 *    closed one stopped at a part the detail screen names;
 *  · the flag calls out a case waiting on a person — a part handed in to mark.
 *    `awaiting_sign_off` already says so in its own badge, so the flag is not
 *    repeated there.
 */
export function CaseStatusCell({
  state,
  awaitingAssessor,
  currentPartLabel,
  currentPartIndex,
  requiredPartCount,
}: {
  state: AssessmentCaseState;
  awaitingAssessor: boolean;
  currentPartLabel: string | null;
  currentPartIndex: number | null;
  requiredPartCount: number;
}) {
  const showStage = state === 'open' && !!currentPartLabel;
  const showFlag = awaitingAssessor && state !== 'awaiting_sign_off';
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <CaseStateBadge state={state} />
        {showFlag && (
          <Badge variant="info" dot>
            Needs assessor
          </Badge>
        )}
      </div>
      {showStage && (
        <span className="text-[11.5px] text-text-tertiary">
          {currentPartIndex && requiredPartCount
            ? `Part ${currentPartIndex} of ${requiredPartCount} · ${currentPartLabel}`
            : currentPartLabel}
        </span>
      )}
    </div>
  );
}

/** The status tabs shown above the submissions table. */
export const SUBMISSION_TABS: Array<{ key: 'all' | SubmissionStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'review', label: 'Needs review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];
