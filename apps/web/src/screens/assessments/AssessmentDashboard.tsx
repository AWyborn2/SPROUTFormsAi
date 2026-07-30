import { useNavigate } from 'react-router-dom';
import { Icon } from '@formai/ui';
import type { AssessmentPathway } from '@formai/shared';
import { useAssessmentProgress, useSession } from '../../lib/data/hooks.js';
import type { CaseProgressPart, CaseProgressRow } from '../../lib/data/assessments.js';
import { CaseStateBadge, PartStateBadge, partStateLabel } from '../statusBadges.js';

/**
 * Progress across every open case, without opening any of them (R21).
 *
 * WHY THIS SCREEN EXISTS SEPARATELY FROM THE CASE LIST: the list answers "which
 * cases are there", and answering "who is waiting on what" from it meant opening
 * each case in turn — the gap that made the paper process untrackable past the
 * theory stage. One request returns every case's current part, each part's
 * standing and the hours logged against each threshold.
 *
 * NOTHING HERE IS COMPUTED. Part states, the current part and the hours are all
 * derived server-side from the attempt rows on each read. Recomputing any of it
 * in the browser would be a second implementation of the unlock and threshold
 * rules, and the two would eventually disagree — with this screen the one people
 * trust to tell them where a candidate stands.
 *
 * ONE SCREEN, TWO AUDIENCES, as with the case list: an assessor's request
 * returns the org's cases and a candidate's returns only their own, because the
 * API scopes the read. This renders whatever it is given rather than filtering.
 */

const PATHWAY_LABELS: Record<AssessmentPathway, string> = {
  experienced: 'Experienced',
  new: 'New / inexperienced',
  rpl: 'Prior learning',
};

export function AssessmentDashboard() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: rows, isLoading, error } = useAssessmentProgress();

  const isCandidate = session?.role === 'candidate';

  return (
    <div className="fai-rise p-[30px_28px_60px]">
      <button
        onClick={() => navigate('/app/assessments')}
        className="mb-3 inline-flex items-center gap-1 text-[13px] text-text-tertiary hover:text-text-secondary"
      >
        <Icon name="arrow-left" size={14} />
        All cases
      </button>

      <div className="mb-5">
        <h1 className="font-heading text-[23px] font-bold">
          {isCandidate ? 'My progress' : 'Progress tracking'}
        </h1>
        <p className="mt-1 text-[13.5px] text-text-tertiary">
          {isCandidate
            ? 'Where you are up to in each assessment, and the hours logged against each minimum.'
            : 'Every candidate’s current part, each part’s outcome, and hours against each logbook minimum.'}
        </p>
      </div>

      {isLoading && <p className="text-[13.5px] text-text-tertiary">Loading progress…</p>}
      {error && (
        <p role="alert" className="text-[13.5px] text-danger">
          Could not load assessment progress.
        </p>
      )}

      {rows && rows.length === 0 && !isLoading && (
        <div className="rounded-md border border-border bg-surface-card p-5 text-[13.5px] text-text-tertiary">
          {isCandidate
            ? 'You have no assessments yet. Your assessor will start one when you begin.'
            : 'No cases yet. Start a candidate on an assessment and their progress appears here.'}
        </div>
      )}

      {rows && rows.length > 0 && (
        /* The parts and hours columns are wide by nature — a six-part tool with
           two logbooks does not compress. Scrolling the table beats truncating
           the one thing the screen is for. */
        <div className="overflow-x-auto rounded-md border border-border bg-surface-card">
          <table className="w-full min-w-[860px] text-[13.5px]">
            <thead>
              <tr className="border-b border-border text-left text-[12.5px] text-text-tertiary">
                {!isCandidate && <th className="p-[10px_14px] font-semibold">Candidate</th>}
                <th className="p-[10px_14px] font-semibold">Assessment</th>
                <th className="p-[10px_14px] font-semibold">Up to</th>
                <th className="p-[10px_14px] font-semibold">Parts</th>
                <th className="p-[10px_14px] font-semibold">Logged hours</th>
                <th className="p-[10px_14px] font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ProgressRow
                  key={row.id}
                  row={row}
                  showCandidate={!isCandidate}
                  onOpen={() => navigate(`/app/assessments/${row.id}`)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProgressRow({
  row,
  showCandidate,
  onOpen,
}: {
  row: CaseProgressRow;
  showCandidate: boolean;
  onOpen: () => void;
}) {
  const logbooks = row.parts.filter((p) => p.minimumHours !== null);

  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-b border-border-subtle align-top last:border-0 hover:bg-surface-hover"
    >
      {showCandidate && (
        <td className="p-[11px_14px]">
          {/* The name when the user record resolves, the id when it does not —
              an unresolvable candidate must still be identifiable, not blank. */}
          <div className="font-semibold">{row.candidateName || `${row.candidateUserId.slice(0, 8)}…`}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{PATHWAY_LABELS[row.pathway]}</div>
        </td>
      )}
      <td className="p-[11px_14px] text-text-secondary">{row.toolName}</td>

      <td className="p-[11px_14px]">
        {row.currentPartLabel ? (
          <span className="text-text-secondary">{row.currentPartLabel}</span>
        ) : (
          /* No current part means every required part has passed. Saying so
             beats an empty cell, which reads as missing data. */
          <span className="text-[12.5px] text-text-tertiary">All parts complete</span>
        )}
      </td>

      <td className="p-[11px_14px]">
        <div className="flex flex-wrap items-center gap-1">
          {row.parts.map((p) => (
            /* Chips carry the part NUMBER, with the label and outcome in the
               accessible name: a row of six full labels is unreadable across
               thirty candidates, and the ordinal is how the printed paper
               refers to them anyway. */
            <span key={p.key} title={`${p.label} — ${partStateLabel(p.state)}`}>
              <PartStateBadge state={p.state}>
                <span className="sr-only">{`${p.label} — ${partStateLabel(p.state)}`}</span>
                <span aria-hidden="true">
                  {p.ordinal}
                  {p.attempts > 1 ? `·${p.attempts}` : ''}
                </span>
              </PartStateBadge>
            </span>
          ))}
        </div>
      </td>

      <td className="p-[11px_14px]">
        {logbooks.length === 0 ? (
          <span className="text-[12.5px] text-text-tertiary">—</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {logbooks.map((p) => (
              <HoursMeter key={p.key} part={p} />
            ))}
          </div>
        )}
      </td>

      <td className="p-[11px_14px]">
        <CaseStateBadge state={row.state} />
      </td>
    </tr>
  );
}

/**
 * Hours logged against one logbook minimum.
 *
 * The bar is capped at the minimum but the FIGURE is not: a threshold notifies
 * and never blocks, so a candidate at 64 of 50 hours is a normal state of
 * affairs and the number has to keep saying 64. Clamping the number instead
 * would make "past the minimum" indistinguishable from "exactly at it".
 */
function HoursMeter({ part }: { part: CaseProgressPart }) {
  const logged = part.loggedHours ?? 0;
  const minimum = part.minimumHours ?? 0;
  const met = minimum > 0 && logged >= minimum;
  const fraction = minimum > 0 ? Math.min(1, logged / minimum) : 0;

  return (
    <div className="min-w-[130px]">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-text-tertiary">Part {part.ordinal}</span>
        <span className={met ? 'font-semibold text-success-text' : 'text-text-secondary'}>
          {logged} / {minimum} h
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-surface-sunken">
        <div
          className="h-full rounded-pill"
          style={{
            width: `${fraction * 100}%`,
            background: met ? 'var(--success)' : 'var(--accent)',
          }}
        />
      </div>
    </div>
  );
}
