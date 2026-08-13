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

/*
  HONEST LIMIT: these sets mirror the DEFAULT matrix's holders of the grants
  the two routes check (`assessments.edit`; admin-only working list), because
  the session carries no resolved permission matrix to read the real grant
  from. An org that customises the matrix drifts: a role granted queue access
  gets no badge (fails closed — the screen still works), and a role revoked
  mid-session fires one quiet 403 per shell load. Shipping the resolved grants
  on the session is the real fix, deferred with the other follow-ups.
*/
const QUEUE_ROLES = new Set(['owner', 'admin', 'assessor']);
const ADMIN_ROLES = new Set(['owner', 'admin']);

/*
  Counts are landing-page furniture, not the work surface — the shell rereads
  them on a five-minute horizon rather than the 30-second default, because the
  working-list read alone is a whole-org scan and the destination screens
  fetch fresh through the same keys the moment they mount.
*/
const BADGE_STALE_MS = 5 * 60 * 1000;

export function useNavBadgeCounts(
  /** Screen keys actually present in this reader's rendered nav. */
  visibleKeys: ReadonlySet<string>,
  role: string | undefined,
): NavBadgeCounts {
  const queueEligible = visibleKeys.has('assessment-queue') && QUEUE_ROLES.has(role ?? '');
  const workingEligible = visibleKeys.has('working-list') && ADMIN_ROLES.has(role ?? '');
  const submissionsEligible = visibleKeys.has('submissions');

  const queue = useAssessorQueue({ enabled: queueEligible, staleTime: BADGE_STALE_MS });
  const working = useWorkingList({ enabled: workingEligible, staleTime: BADGE_STALE_MS });
  const dash = useDashboard({ enabled: submissionsEligible, staleTime: BADGE_STALE_MS });

  return {
    'assessment-queue': queueEligible ? (queue.data?.length ?? null) : null,
    'working-list': workingEligible ? (working.data?.length ?? null) : null,
    submissions: submissionsEligible ? (dash.data?.pendingReview ?? null) : null,
  };
}

/**
 * The badged screen keys, derived from the counts shape so a key added there
 * cannot silently miss its badge — a second hand-written list compiled fine
 * while never rendering.
 */
export const BADGED_KEYS = Object.keys({
  'assessment-queue': true,
  'working-list': true,
  submissions: true,
} satisfies Record<keyof NavBadgeCounts, true>) as Array<keyof NavBadgeCounts>;

/** The count behind one nav entry, or null when the key carries no badge. */
export function badgeFor(counts: NavBadgeCounts | undefined, key: string): number | null {
  if (!counts) return null;
  return (BADGED_KEYS as readonly string[]).includes(key)
    ? counts[key as keyof NavBadgeCounts]
    : null;
}

/**
 * The sum a COLLAPSED group header shows for its children (R5–R7): badged
 * entries inside a closed group would otherwise be invisible in the sidebar's
 * default state, which defeats the reason badges exist.
 */
export function groupRollup(
  counts: NavBadgeCounts | undefined,
  screenKeys: readonly string[],
): number {
  return screenKeys.reduce((sum, key) => sum + (badgeFor(counts, key) ?? 0), 0);
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
