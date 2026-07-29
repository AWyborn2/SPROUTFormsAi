import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Icon } from '@formai/ui';
import { ASSESSMENT_PATHWAYS, type AssessmentPathway } from '@formai/shared';
import {
  useAssessmentCases,
  useAssessmentTools,
  useCreateAssessmentCase,
  useSession,
} from '../../lib/data/hooks.js';

/**
 * Assessment cases.
 *
 * ONE SCREEN, TWO AUDIENCES. An assessor sees every case in the org; a
 * candidate sees only their own. That difference is enforced server-side by the
 * permission scope, so this screen renders whatever it is given rather than
 * filtering — a client-side filter would mean the browser had been sent the
 * rest and merely hidden it.
 */

const PATHWAY_LABELS: Record<AssessmentPathway, string> = {
  experienced: 'Experienced',
  new: 'New / inexperienced',
  rpl: 'Recognition of prior learning',
};

const STATE_STYLE: Record<string, { bg: string; fg: string; icon: string; label: string }> = {
  open: { bg: 'var(--warning-soft)', fg: 'var(--warning-text)', icon: 'clock', label: 'In progress' },
  competent: { bg: 'var(--success-soft)', fg: 'var(--success-text)', icon: 'circle-check', label: 'Competent' },
  closed: { bg: 'var(--danger-soft)', fg: 'var(--danger)', icon: 'circle-x', label: 'Not yet competent' },
};

export function AssessmentCasesScreen() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: cases, isLoading, error } = useAssessmentCases();
  const { data: tools } = useAssessmentTools();
  const [creating, setCreating] = useState(false);

  const isCandidate = session?.role === 'candidate';

  return (
    <div className="fai-rise p-[30px_28px_60px]">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-[23px] font-bold">
            {isCandidate ? 'My assessments' : 'Assessment cases'}
          </h1>
          <p className="mt-1 text-[13.5px] text-text-tertiary">
            {isCandidate
              ? 'Your competency assessments and what you need to complete next.'
              : 'Every candidate’s progress through a multi-part competency assessment.'}
          </p>
        </div>
        {!isCandidate && (
          <Button leadingIcon="plus" onClick={() => setCreating(true)} disabled={!tools?.length}>
            New case
          </Button>
        )}
      </div>

      {creating && tools && (
        <NewCaseForm tools={tools} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/app/assessments/${id}`)} />
      )}

      {!isCandidate && tools && tools.length === 0 && (
        <div className="rounded-md border border-border bg-surface-card p-5 text-[13.5px] text-text-tertiary">
          No assessment tools yet. An assessment tool is a published form with its parts, pathways and
          answer key declared — import the assessment PDF, then author its tool.
        </div>
      )}

      {isLoading && <p className="text-[13.5px] text-text-tertiary">Loading cases…</p>}
      {error && (
        <p role="alert" className="text-[13.5px] text-danger">
          Could not load assessment cases.
        </p>
      )}

      {cases && cases.length === 0 && !isLoading && (
        <div className="rounded-md border border-border bg-surface-card p-5 text-[13.5px] text-text-tertiary">
          {isCandidate
            ? 'You have no assessments yet. Your assessor will start one when you begin.'
            : 'No cases yet. Create one to start a candidate on an assessment.'}
        </div>
      )}

      {cases && cases.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border bg-surface-card">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="border-b border-border text-left text-[12.5px] text-text-tertiary">
                <th className="p-[10px_14px] font-semibold">Assessment</th>
                {!isCandidate && <th className="p-[10px_14px] font-semibold">Candidate</th>}
                <th className="p-[10px_14px] font-semibold">Pathway</th>
                <th className="p-[10px_14px] font-semibold">Status</th>
                <th className="p-[10px_14px] font-semibold">Started</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const style = STATE_STYLE[c.state] ?? STATE_STYLE.open!;
                return (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/app/assessments/${c.id}`)}
                    className="cursor-pointer border-b border-border-subtle last:border-0 hover:bg-surface-hover"
                  >
                    <td className="p-[11px_14px] font-semibold">{c.toolName}</td>
                    {!isCandidate && (
                      <td className="p-[11px_14px] font-mono text-[12px] text-text-tertiary">
                        {c.candidateUserId.slice(0, 8)}…
                      </td>
                    )}
                    <td className="p-[11px_14px] text-text-secondary">{PATHWAY_LABELS[c.pathway]}</td>
                    <td className="p-[11px_14px]">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[12px] font-semibold"
                        style={{ background: style.bg, color: style.fg }}
                      >
                        <Icon name={style.icon} size={13} />
                        {style.label}
                      </span>
                    </td>
                    <td className="p-[11px_14px] text-text-tertiary">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Opening a case.
 *
 * The RPL justification field appears only for that pathway and is required
 * there, because RPL waives the logged-hours parts and the reason they were
 * waived is the only record of why. The API enforces this too; asking here just
 * saves a round trip.
 */
function NewCaseForm({
  tools,
  onClose,
  onCreated,
}: {
  tools: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateAssessmentCase();
  const [toolId, setToolId] = useState(tools[0]?.id ?? '');
  const [candidateUserId, setCandidateUserId] = useState('');
  const [pathway, setPathway] = useState<AssessmentPathway>('new');
  const [locationStream, setLocationStream] = useState('');
  const [rplJustification, setRplJustification] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!toolId || !candidateUserId.trim()) {
      setError('Choose an assessment and name the candidate.');
      return;
    }
    if (pathway === 'rpl' && !rplJustification.trim()) {
      setError('RPL waives the logged-hours parts — record why it was granted.');
      return;
    }
    try {
      const res = await create.mutateAsync({
        toolId,
        candidateUserId: candidateUserId.trim(),
        pathway,
        ...(locationStream ? { locationStream } : {}),
        ...(pathway === 'rpl' ? { rplJustification: rplJustification.trim() } : {}),
      });
      onCreated(res.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the case.');
    }
  }

  const field = 'w-full rounded-md border border-border bg-surface-card p-[9px_11px] text-[13.5px]';
  const label = 'block text-[12.5px] font-semibold text-text-secondary';

  return (
    <div className="mb-5 rounded-md border border-border-accent bg-surface-card p-[18px_20px]">
      <h2 className="font-heading text-[16px] font-bold">Start an assessment</h2>

      <div className="mt-3.5 grid gap-3.5 sm:grid-cols-2">
        <div>
          <label htmlFor="nc-tool" className={label}>Assessment</label>
          <select id="nc-tool" value={toolId} onChange={(e) => setToolId(e.target.value)} className={`${field} mt-1`}>
            {tools.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="nc-candidate" className={label}>Candidate user id</label>
          <input
            id="nc-candidate"
            value={candidateUserId}
            onChange={(e) => setCandidateUserId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            className={`${field} mt-1 font-mono text-[12px]`}
          />
        </div>

        <div>
          <label htmlFor="nc-pathway" className={label}>Pathway</label>
          <select
            id="nc-pathway"
            value={pathway}
            onChange={(e) => setPathway(e.target.value as AssessmentPathway)}
            className={`${field} mt-1`}
          >
            {ASSESSMENT_PATHWAYS.map((p) => (
              <option key={p} value={p}>{PATHWAY_LABELS[p]}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-text-tertiary">
            {pathway === 'new'
              ? 'All six parts, including both logbooks.'
              : 'Theory and the first practical demonstration only.'}
          </p>
        </div>

        <div>
          <label htmlFor="nc-stream" className={label}>Location stream (optional)</label>
          <input
            id="nc-stream"
            value={locationStream}
            onChange={(e) => setLocationStream(e.target.value)}
            placeholder="mining / raw_materials"
            className={`${field} mt-1`}
          />
        </div>

        {pathway === 'rpl' && (
          <div className="sm:col-span-2">
            <label htmlFor="nc-rpl" className={label}>Why RPL was granted</label>
            <textarea
              id="nc-rpl"
              value={rplJustification}
              onChange={(e) => setRplJustification(e.target.value)}
              rows={2}
              className={`${field} mt-1`}
            />
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button onClick={onClose} className="text-[13.5px] text-text-tertiary">Cancel</button>
        <Button onClick={submit} disabled={create.isPending}>
          {create.isPending ? 'Starting…' : 'Start assessment'}
        </Button>
      </div>
    </div>
  );
}
