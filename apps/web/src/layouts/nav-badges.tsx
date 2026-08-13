import { useAssessorQueue, useDashboard, useWorkingList } from '../lib/data/hooks.js';

/**
 * Counts for the sidebar's work-queue badges (R5–R7, R9).
 *
 * The three reads are the SAME query keys their destination screens use
 * (KTD1): the badge and the screen share one cache entry, so a click-through
 * never refetches what the badge already loaded, and the shell adds no second
 * API surface to permission-audit.
 *
 * Each fetch is enabled by the GRANT the API actually checks, not merely by
 * nav visibility — the queue route admits `assessments.edit` holders
 * (owner/admin/assessor), while the nav's rank floor also admits builders and
 * reviewers, whose shell would otherwise fire a silent 403 on every render.
 * The submissions count rides the ungated dashboard read, which the server
 * already computes over the review states — no unbounded submissions list in
 * the shell, no second copy of the status set.
 */
export interface NavBadgeCounts {
  'assessment-queue': number | null;
  'working-list': number | null;
  submissions: number | null;
}

const QUEUE_ROLES = new Set(['owner', 'admin', 'assessor']);
const ADMIN_ROLES = new Set(['owner', 'admin']);

export function useNavBadgeCounts(
  /** Screen keys actually present in this reader's rendered nav. */
  visibleKeys: ReadonlySet<string>,
  role: string | undefined,
): NavBadgeCounts {
  const queueEligible = visibleKeys.has('assessment-queue') && QUEUE_ROLES.has(role ?? '');
  const workingEligible = visibleKeys.has('working-list') && ADMIN_ROLES.has(role ?? '');
  const submissionsEligible = visibleKeys.has('submissions');

  const queue = useAssessorQueue({ enabled: queueEligible });
  const working = useWorkingList({ enabled: workingEligible });
  const dash = useDashboard({ enabled: submissionsEligible });

  return {
    'assessment-queue': queueEligible ? (queue.data?.length ?? null) : null,
    'working-list': workingEligible ? (working.data?.length ?? null) : null,
    submissions: submissionsEligible ? (dash.data?.pendingReview ?? null) : null,
  };
}

/** What each badge is counting, for assistive tech — a bare numeral says nothing. */
export const BADGE_CONTEXT: Record<keyof NavBadgeCounts, string> = {
  'assessment-queue': 'unowned cases in the assessment queue',
  'working-list': 'unresolved working-list items',
  submissions: 'submissions awaiting review',
};

/** The pill's text: nothing at zero or unknown (R9), capped so 4 digits never stretch the nav. */
export function badgeLabel(count: number | null | undefined): string | null {
  if (!count || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

/** The count pill itself — rendered only when there is something to say. */
export function NavCountPill({
  count,
  context,
}: {
  count: number | null | undefined;
  context: string;
}) {
  const label = badgeLabel(count);
  if (label === null) return null;
  return (
    <span
      aria-label={`${count} ${context}`}
      className="ml-auto flex-none rounded-pill bg-[rgba(110,199,146,0.18)] px-[7px] py-px font-mono text-[11px] font-semibold text-[#8fd6ad]"
    >
      {label}
    </span>
  );
}
