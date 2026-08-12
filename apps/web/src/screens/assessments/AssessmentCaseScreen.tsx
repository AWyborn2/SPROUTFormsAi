import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CaseStateBadge } from '../statusBadges.js';
import { Button, Icon, SignaturePad, useToast } from '@formai/ui';
import { NS_DISPOSITIONS, type NotSatisfactoryDisposition, type PartState } from '@formai/shared';
import { ApiError } from '../../lib/data/api-client.js';
import {
  useAssessmentCase,
  useExportCasePdf,
  useOpenAttempt,
  useRecordOutcome,
  useSession,
  useSignOffCase,
} from '../../lib/data/hooks.js';
import { caseExportFilename, caseExportProblem } from '../../lib/case-export-problem.js';
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
  const exportPdf = useExportCasePdf();
  const { toast } = useToast();
  const [signingOff, setSigningOff] = useState(false);

  const isCandidate = session?.role === 'candidate';

  /**
   * Download the case as a filled copy of the original assessment.
   *
   * Offered whatever state the case is in, not only once competent. A part that
   * has not passed prints blank, which is exactly what the paper form looks like
   * mid-programme — and an auditor asking "where is this candidate up to" is a
   * real question that wants a document, not a screenshot.
   */
  function onExport() {
    if (!id || !c) return;
    exportPdf.mutate(id, {
      onSuccess: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = caseExportFilename(c.toolName, c.candidateName || c.candidateUserId);
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast({ variant: 'success', message: 'Evidence PDF exported.' });
      },
      onError: (err) => {
        // Six distinct failures, each with its own next step — see
        // `caseExportProblem`. Collapsing them into one message would leave a
        // training officer stuck on the document they need for an audit.
        const problem = caseExportProblem(err);
        toast({
          variant: 'danger',
          message: [problem.message, problem.remedy, ...problem.problems]
            .filter(Boolean)
            .join(' '),
        });
      },
    });
  }

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
            {c.locationName ? ` · ${c.locationName}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {/* Shown only once every part has passed and nobody has signed. The
              route recomputes that itself and refuses otherwise, so this is a
              convenience rather than the guard. */}
          {!isCandidate && c.state === 'awaiting_sign_off' && (
            <Button leadingIcon="circle-check" onClick={() => setSigningOff(true)}>
              Sign off and certify
            </Button>
          )}
          {/* Candidates have no export permission — the route refuses them, so
              showing the control would only produce a 403 they cannot act on. */}
          {!isCandidate && (
            <Button
              variant="outline"
              leadingIcon="file-down"
              onClick={onExport}
              disabled={exportPdf.isPending}
            >
              {exportPdf.isPending ? 'Building…' : 'Export evidence PDF'}
            </Button>
          )}
          {/* A pooled case names no assessor — it sits in the shared queue (U13). */}
          {!isCandidate && c.assessorUserId == null && c.state === 'open' && (
            <span className="rounded-full border border-border bg-surface-sunken px-2.5 py-1 text-[11px] font-medium text-text-tertiary">
              Unassigned — in the shared queue
            </span>
          )}
          <CaseStateBadge state={c.state} size="md" />
        </div>
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
            onOpen={() =>
              openAttempt.mutate(part.key, {
                // The server authorises per workflow: a candidate may open the
                // steps handed to THEM, and a part that is the assessor's says
                // so instead of failing silently.
                onError: () =>
                  toast({
                    variant: 'warning',
                    message: isCandidate
                      ? 'This step is opened by your assessor.'
                      : 'Couldn’t open an attempt for this part.',
                  }),
              })
            }
            opening={openAttempt.isPending}
          />
        ))}
      </div>

      {signingOff && (
        <SignOffDialog caseId={c.id} toolName={c.toolName} onClose={() => setSigningOff(false)} />
      )}
    </div>
  );
}

/**
 * The assessor's final approval.
 *
 * Deliberately more ceremony than a confirm button. What this writes is a
 * person's name and signature on a document stating that a candidate is safe to
 * operate a machine — so the assessor types their own name and draws their own
 * signature rather than having either inferred from the session. The date is
 * server-stamped and never sent: it is a claim about when a judgement was made,
 * and the only moment we can vouch for is when the request arrived.
 */
const SIGN_OFF_ERRORS: Record<string, string> = {
  prerequisites_unsatisfied: 'The candidate has unsatisfied prerequisite competencies.',
  case_closed: 'This case is already closed.',
  candidate_cannot_sign_off: 'A candidate cannot sign off their own assessment.',
  tool_missing: 'The assessment tool for this case no longer exists.',
  parts_incomplete: 'Not all required parts are satisfactory yet.',
};

function signOffErrorMessage(body: Record<string, unknown>): string {
  const code = typeof body.error === 'string' ? body.error : '';
  const base = SIGN_OFF_ERRORS[code] ?? `Sign-off refused (${code || 'unknown'}).`;
  if (code === 'prerequisites_unsatisfied' && typeof body.detail === 'string') {
    return `${base} ${body.detail}`;
  }
  if (code === 'parts_incomplete' && Array.isArray(body.outstanding)) {
    return `${base} Outstanding: ${(body.outstanding as string[]).join(', ')}.`;
  }
  return base;
}

function SignOffDialog({
  caseId,
  toolName,
  onClose,
}: {
  caseId: string;
  toolName: string;
  onClose: () => void;
}) {
  const signOff = useSignOffCase(caseId);
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [signature, setSignature] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError('Type your name as it should appear on the certificate.');
      return;
    }
    if (!signature) {
      setError('Draw or type your signature — it prints on the record.');
      return;
    }
    try {
      const res = await signOff.mutateAsync({ assessorName: name.trim(), signature });
      const granted = res.granted?.length
        ? ` Competency recorded: ${res.granted.join(', ')}.`
        : '';
      toast({ variant: 'success', message: `${toolName} is now competent.${granted}` });
      // Anything that did not stop the sign-off still has to be seen — an
      // assessor missing a competency of their own, or a grant that failed.
      for (const w of res.warnings ?? []) {
        toast({ variant: 'warning', message: w });
      }
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === 'object') {
        const b = e.body as Record<string, unknown>;
        const reason = signOffErrorMessage(b);
        setError(reason);
      } else {
        setError(e instanceof Error ? e.message : 'Could not sign this case off.');
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgb(0 0 0 / 0.45)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Sign off and certify"
    >
      <div className="w-full max-w-[460px] rounded-lg border border-border bg-surface-card p-[20px_22px]">
        <h2 className="font-heading text-[17px] font-bold">Sign off and certify</h2>
        <p className="mt-1.5 text-[13px] text-text-tertiary">
          Every part of {toolName} is satisfactory. Your name, signature and today’s date print on
          the assessment record, and this is what makes the case competent.
        </p>

        <label htmlFor="so-name" className="mt-4 block text-[12.5px] font-semibold text-text-secondary">
          Your name, as it should print
        </label>
        <input
          id="so-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-surface-card p-[9px_11px] text-[13.5px]"
        />

        <span className="mt-3.5 block text-[12.5px] font-semibold text-text-secondary">
          Your signature
        </span>
        <div className="mt-1">
          <SignaturePad value={signature} onChange={setSignature} aria-label="Assessor signature" />
        </div>

        {error && (
          <p className="mt-3 text-[12.5px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={signOff.isPending}>
            Cancel
          </Button>
          <Button leadingIcon="circle-check" onClick={submit} disabled={signOff.isPending}>
            {signOff.isPending ? 'Signing…' : 'Sign off'}
          </Button>
        </div>
      </div>
    </div>
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
    markerKind: 'person' | 'automatic' | null;
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
                {/* An automatic mark was made by nobody — say so distinctly (U15). */}
                {a.markerKind === 'automatic' && (
                  <span className="ml-1.5 rounded-sm bg-surface-sunken px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-text-tertiary">
                    auto-marked
                  </span>
                )}
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
            <OutcomeForm caseId={caseId} attemptId={openAttempt.id} kind={part.kind} selfMarking={part.selfMarking} />
          )}

          {/* Both sides get the button now: the server authorises per
              workflow, so a candidate opening a step handed to them succeeds
              and a step that is the assessor's answers with a message rather
              than a control that lies. */}
          {!openAttempt && (
            <Button onClick={onOpen} disabled={opening} leadingIcon="play">
              {opening
                ? 'Opening…'
                : attempts.length > 0
                  ? readOnly
                    ? 'Try again'
                    : 'Start another attempt'
                  : 'Start this part'}
            </Button>
          )}
        </div>
      )}

      {part.state === 'locked' && (
        <p className="mt-2.5 border-t border-border-subtle pt-2.5 text-[12.5px] text-text-tertiary">
          {/* The gate may be the printed sequence or the workflow's own
              dependencies — either way the server decided, so stay general. */}
          Unlocks once the steps before it are satisfactory.
        </p>
      )}
    </div>
  );
}

/**
 * Resolving an attempt.
 *
 * `selfMarking` comes from the API's `isSelfMarking()` — true when every
 * question in the part has an answer key AND an outcome target. When true, the
 * API computes the outcome from the answer key; no outcome selector is shown.
 * When false (verbal questions, parts whose verdicts were stripped by a zod
 * bug, etc.), the assessor must choose satisfactory/not-satisfactory manually.
 */
function OutcomeForm({ caseId, attemptId, kind, selfMarking }: { caseId: string; attemptId: string; kind: string; selfMarking: boolean }) {
  const record = useRecordOutcome(caseId);
  const [outcome, setOutcome] = useState<'satisfactory' | 'not_satisfactory' | ''>('');
  const [disposition, setDisposition] = useState<NotSatisfactoryDisposition>('coaching_then_retry');
  const [reason, setReason] = useState('');
  const [assessorName, setAssessorName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const needsReason = outcome === 'not_satisfactory';

  async function submit() {
    setError(null);
    if (!selfMarking && !outcome) {
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
        ...(selfMarking ? {} : { outcome: outcome as 'satisfactory' | 'not_satisfactory' }),
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
      {selfMarking ? (
        <p className="text-[12.5px] text-text-tertiary">
          Marking is computed from the answer key once the candidate’s answers are saved. Recording the
          outcome marks every question and decides the part. Anything under 100% is recorded as more
          coaching required, and the candidate sits it again — it does not close the case.
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

      {!selfMarking && (
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
