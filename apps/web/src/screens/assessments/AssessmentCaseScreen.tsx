import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Icon } from '@formai/ui';
import { NS_DISPOSITIONS, type NotSatisfactoryDisposition, type PartState } from '@formai/shared';
import {
  useAssessmentCase,
  useOpenAttempt,
  useRecordOutcome,
  useSession,
} from '../../lib/data/hooks.js';
import type { CasePartView } from '../../lib/data/assessments.js';

/**
 * One assessment case: every part, its state, and the controls to resolve it.
 *
 * PART STATE IS THE SERVER'S. `locked`, `open`, `satisfactory` and
 * `not_satisfactory` are derived from the attempt rows by the API on every
 * read. This screen renders them and never computes them — duplicating the
 * unlock rules here would mean two implementations that can disagree, and the
 * disagreement would show a candidate a part the API refuses to open.
 */

const PART_STATE: Record<PartState, { bg: string; fg: string; icon: string; label: string }> = {
  locked: { bg: 'var(--surface-2)', fg: 'var(--text-tertiary)', icon: 'lock', label: 'Locked' },
  open: { bg: 'var(--accent-soft)', fg: 'var(--accent-text)', icon: 'circle-dot', label: 'Open' },
  satisfactory: { bg: 'var(--success-soft)', fg: 'var(--success-text)', icon: 'circle-check', label: 'Satisfactory' },
  not_satisfactory: { bg: 'var(--danger-soft)', fg: 'var(--danger)', icon: 'circle-x', label: 'Not satisfactory' },
};

const DISPOSITION_LABELS: Record<NotSatisfactoryDisposition, string> = {
  retry: 'Retry now',
  coaching_then_retry: 'More coaching, then retry',
  change_pathway: 'Move to the longer pathway',
  not_yet_competent: 'Close — not yet competent',
};

const KIND_HINT: Record<string, string> = {
  theory: 'Auto-marked from the answer key. The outcome is computed, not entered.',
  practical: 'Observed demonstration. The assessor records the outcome.',
  logbook: 'Hours accumulate over weeks until the minimum is reached.',
};

export function AssessmentCaseScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: c, isLoading, error } = useAssessmentCase(id);
  const openAttempt = useOpenAttempt(id ?? '');

  const isCandidate = session?.role === 'candidate';

  if (isLoading) return <div className="p-[30px_28px]"><p className="text-[13.5px] text-text-tertiary">Loading case…</p></div>;
  if (error || !c) {
    return (
      <div className="p-[30px_28px]">
        <p role="alert" className="text-[13.5px] text-danger">
          This case could not be found.
        </p>
        <button onClick={() => navigate('/app/assessments')} className="mt-2 text-[13.5px] text-text-tertiary">
          Back to cases
        </button>
      </div>
    );
  }

  const done = c.parts.filter((p) => p.state === 'satisfactory').length;

  return (
    <div className="fai-rise p-[30px_28px_60px]">
      <button
        onClick={() => navigate('/app/assessments')}
        className="mb-3 inline-flex items-center gap-1 text-[13px] text-text-tertiary hover:text-text-secondary"
      >
        <Icon name="arrow-left" size={14} />
        All cases
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-[23px] font-bold">{c.toolName}</h1>
          <p className="mt-1 text-[13.5px] text-text-tertiary">
            {done} of {c.parts.length} parts satisfactory
            {c.locationStream ? ` · ${c.locationStream}` : ''}
          </p>
        </div>
        <CaseStateBadge state={c.state} />
      </div>

      {c.prerequisiteWarnings.length > 0 && (
        <div
          className="mt-4 rounded-md border p-[12px_14px]"
          style={{ background: 'var(--warning-soft)', borderColor: 'var(--border-warning)' }}
        >
          <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--warning-text)' }}>
            <Icon name="alert-triangle" size={15} />
            Prerequisites not confirmed
          </div>
          <ul className="mt-1.5 list-disc pl-5 text-[12.5px]" style={{ color: 'var(--warning-text)' }}>
            {c.prerequisiteWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px]" style={{ color: 'var(--warning-text)' }}>
            Recorded at the time the case was opened. These never block the assessment.
          </p>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2.5">
        {c.parts.map((part) => (
          <PartCard
            key={part.key}
            caseId={c.id}
            part={part}
            readOnly={isCandidate}
            attempts={c.attempts.filter((a) => a.partKey === part.key)}
            onOpen={() => openAttempt.mutate(part.key)}
            opening={openAttempt.isPending}
          />
        ))}
      </div>
    </div>
  );
}

function CaseStateBadge({ state }: { state: string }) {
  const map: Record<string, { bg: string; fg: string; icon: string; label: string }> = {
    open: { bg: 'var(--warning-soft)', fg: 'var(--warning-text)', icon: 'clock', label: 'In progress' },
    competent: { bg: 'var(--success-soft)', fg: 'var(--success-text)', icon: 'circle-check', label: 'Competent' },
    closed: { bg: 'var(--danger-soft)', fg: 'var(--danger)', icon: 'circle-x', label: 'Not yet competent' },
  };
  const s = map[state] ?? map.open!;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[13px] font-semibold"
      style={{ background: s.bg, color: s.fg }}
    >
      <Icon name={s.icon} size={15} />
      {s.label}
    </span>
  );
}

function PartCard({
  caseId,
  part,
  attempts,
  readOnly,
  onOpen,
  opening,
}: {
  caseId: string;
  part: CasePartView;
  attempts: {
    id: string;
    attemptNumber: number;
    outcome: string | null;
    submittedAt: string | null;
    dispositionReason: string | null;
  }[];
  readOnly: boolean;
  onOpen: () => void;
  opening: boolean;
}) {
  const style = PART_STATE[part.state];
  const openAttempt = attempts.find((a) => a.outcome === null);
  const resolved = attempts.filter((a) => a.outcome !== null);

  return (
    <div className="rounded-md border border-border bg-surface-card p-[14px_16px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-heading text-[15px] font-bold">{part.label}</div>
          <div className="mt-0.5 text-[12.5px] text-text-tertiary">
            {KIND_HINT[part.kind]}
            {part.minimumHours ? ` Minimum ${part.minimumHours} hours.` : ''}
          </div>
        </div>
        <span
          className="inline-flex flex-none items-center gap-1.5 rounded-pill px-2.5 py-1 text-[12px] font-semibold"
          style={{ background: style.bg, color: style.fg }}
        >
          <Icon name={style.icon} size={13} />
          {style.label}
        </span>
      </div>

      {/* Every attempt stays visible, including the failures. The document
          renders only the passing one, but the trail is the record. */}
      {resolved.length > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1 border-t border-border-subtle pt-2.5 text-[12.5px]">
          {resolved.map((a) => (
            <li key={a.id} className="flex items-start gap-2">
              <Icon
                name={a.outcome === 'satisfactory' ? 'circle-check' : 'circle-x'}
                size={14}
                className={a.outcome === 'satisfactory' ? 'mt-0.5 flex-none text-success-text' : 'mt-0.5 flex-none text-danger'}
              />
              <span className="text-text-secondary">
                {/* Readable after the fact, never editable — the fill screen
                    locks a marked attempt. A candidate who failed should be
                    able to see what they actually answered. */}
                <Link
                  to={`/app/assessments/${caseId}/attempts/${a.id}`}
                  className="underline decoration-dotted underline-offset-2"
                >
                  Attempt {a.attemptNumber}
                </Link>{' '}
                — {a.outcome === 'satisfactory' ? 'satisfactory' : 'not satisfactory'}
                {a.dispositionReason ? `: ${a.dispositionReason}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {part.state !== 'locked' && part.state !== 'satisfactory' && (
        <div className="mt-3 flex flex-col gap-3 border-t border-border-subtle pt-3">
          {/* Answering is available to BOTH sides while an attempt is open —
              the candidate does the work, and the assessor needs to read it to
              mark it. Only the marking control below is assessor-only. */}
          {/* The whole point of the hand-in signal: an assessor can see which
              parts are waiting on them without opening each one. */}
          {openAttempt?.submittedAt && !readOnly && (
            <p className="inline-flex w-fit items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12.5px] font-semibold"
              style={{ background: 'var(--warning-soft)', color: 'var(--warning-text)' }}>
              <Icon name="inbox" size={14} />
              Handed in — ready to mark
            </p>
          )}

          {openAttempt && (
            <Link
              to={`/app/assessments/${caseId}/attempts/${openAttempt.id}`}
              className="inline-flex w-fit items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-white"
              style={{ background: 'var(--accent)' }}
            >
              <Icon name="pen-line" size={15} />
              {readOnly ? (openAttempt.submittedAt ? 'Review my answers' : 'Answer questions') : 'Open answers'}
            </Link>
          )}

          {!readOnly && openAttempt && (
            <OutcomeForm caseId={caseId} attemptId={openAttempt.id} kind={part.kind} />
          )}

          {!readOnly && !openAttempt && (
            <Button onClick={onOpen} disabled={opening} leadingIcon="play">
              {opening ? 'Opening…' : attempts.length > 0 ? 'Start another attempt' : 'Start this part'}
            </Button>
          )}

          {/* A candidate cannot release a part to themselves — starting one is
              the assessor's call, so say who they are waiting on rather than
              showing a control that would 403. */}
          {readOnly && !openAttempt && (
            <p className="text-[12.5px] text-text-tertiary">
              {attempts.length > 0
                ? 'Your assessor will open another attempt if one is needed.'
                : 'Your assessor will start this part when you’re ready.'}
            </p>
          )}
        </div>
      )}

      {part.state === 'locked' && (
        <p className="mt-2.5 border-t border-border-subtle pt-2.5 text-[12.5px] text-text-tertiary">
          Unlocks once the previous part is satisfactory.
        </p>
      )}
    </div>
  );
}

/**
 * Resolving an attempt.
 *
 * A theory attempt takes no outcome control at all: the API computes it from
 * the answer key and the assessor reviews the result. Offering a satisfactory /
 * not-satisfactory choice here would imply a judgement the assessor does not
 * actually make, and the API would ignore it.
 */
function OutcomeForm({ caseId, attemptId, kind }: { caseId: string; attemptId: string; kind: string }) {
  const record = useRecordOutcome(caseId);
  const [outcome, setOutcome] = useState<'satisfactory' | 'not_satisfactory' | ''>('');
  const [disposition, setDisposition] = useState<NotSatisfactoryDisposition>('coaching_then_retry');
  const [reason, setReason] = useState('');
  const [assessorName, setAssessorName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isTheory = kind === 'theory';
  const needsReason = outcome === 'not_satisfactory';

  async function submit() {
    setError(null);
    if (!isTheory && !outcome) {
      setError('Record the outcome of this demonstration.');
      return;
    }
    if (needsReason && !reason.trim()) {
      setError('A not-satisfactory outcome needs a recorded reason — it is the further action on the record.');
      return;
    }
    try {
      await record.mutateAsync({
        attemptId,
        ...(isTheory ? {} : { outcome: outcome as 'satisfactory' | 'not_satisfactory' }),
        ...(needsReason ? { disposition, reason: reason.trim() } : {}),
        ...(assessorName.trim() ? { assessorName: assessorName.trim() } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the outcome.');
    }
  }

  const field = 'w-full rounded-md border border-border bg-surface-card p-[8px_10px] text-[13px]';

  return (
    <div className="flex flex-col gap-2.5">
      {isTheory ? (
        <p className="text-[12.5px] text-text-tertiary">
          Marking is computed from the answer key once the candidate’s answers are saved. Recording the
          outcome marks every question and decides the part.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {(['satisfactory', 'not_satisfactory'] as const).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setOutcome(o)}
              aria-pressed={outcome === o}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-semibold"
              style={{
                borderColor: outcome === o ? (o === 'satisfactory' ? 'var(--success-text)' : 'var(--danger)') : 'var(--border)',
                background: outcome === o ? (o === 'satisfactory' ? 'var(--success-soft)' : 'var(--danger-soft)') : 'transparent',
                color: outcome === o ? (o === 'satisfactory' ? 'var(--success-text)' : 'var(--danger)') : 'var(--text-secondary)',
              }}
            >
              <Icon name={o === 'satisfactory' ? 'circle-check' : 'circle-x'} size={14} />
              {o === 'satisfactory' ? 'Satisfactory' : 'Not satisfactory'}
            </button>
          ))}
        </div>
      )}

      {needsReason && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <div>
            <label htmlFor={`disp-${attemptId}`} className="block text-[12.5px] font-semibold text-text-secondary">
              What happens next
            </label>
            <select
              id={`disp-${attemptId}`}
              value={disposition}
              onChange={(e) => setDisposition(e.target.value as NotSatisfactoryDisposition)}
              className={`${field} mt-1`}
            >
              {NS_DISPOSITIONS.map((d) => (
                <option key={d} value={d}>{DISPOSITION_LABELS[d]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`reason-${attemptId}`} className="block text-[12.5px] font-semibold text-text-secondary">
              Reason (required)
            </label>
            <input
              id={`reason-${attemptId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Blade control inconsistent on grade"
              className={`${field} mt-1`}
            />
          </div>
        </div>
      )}

      {!isTheory && (
        <div>
          <label htmlFor={`name-${attemptId}`} className="block text-[12.5px] font-semibold text-text-secondary">
            Assessor name (as signed)
          </label>
          <input
            id={`name-${attemptId}`}
            value={assessorName}
            onChange={(e) => setAssessorName(e.target.value)}
            className={`${field} mt-1 sm:max-w-[280px]`}
          />
        </div>
      )}

      {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}

      <div>
        <Button onClick={submit} disabled={record.isPending}>
          {record.isPending ? 'Recording…' : 'Record outcome'}
        </Button>
      </div>
    </div>
  );
}
