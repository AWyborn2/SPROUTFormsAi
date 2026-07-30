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
  competent: { variant: 'success', label: 'Competent' },
  // Terminal but not a pass. "Closed" is the state name; "not yet competent" is
  // what it means to the person reading the row.
  closed: { variant: 'danger', label: 'Not yet competent' },
};

export function CaseStateBadge({ state, size }: { state: AssessmentCaseState; size?: 'sm' | 'md' }) {
  const b = CASE_STATE[state];
  return (
    <Badge variant={b.variant} size={size} dot>
      {b.label}
    </Badge>
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
