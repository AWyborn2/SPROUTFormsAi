import { Badge, type BadgeVariant } from '@formai/ui';
import type { SubmissionStatus } from '@formai/shared';

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

/** The status tabs shown above the submissions table. */
export const SUBMISSION_TABS: Array<{ key: 'all' | SubmissionStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'review', label: 'Needs review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];
