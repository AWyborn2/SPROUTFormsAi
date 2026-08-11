import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Icon } from '@formai/ui';
import { ASSESSMENT_PATHWAYS, type AssessmentPathway } from '@formai/shared';
import { CaseStateBadge } from '../statusBadges.js';
import type { AssessmentToolSummary } from '../../lib/data/assessments.js';
import {
  useAssessmentCases,
  useAssessmentTools,
  useCreateAssessmentCase,
  useMembers,
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
        <div className="flex flex-none items-center gap-2">
          {/* The answer to "who is waiting on what" lives one click away rather
              than in this table: it needs a column per part and a meter per
              logbook, which would crowd out the case list's own job. */}
          <Link
            to="/app/assessments/progress"
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-border px-3 py-2 text-[13px] font-semibold text-text-secondary hover:bg-surface-hover"
          >
            <Icon name="gauge" size={15} />
            {isCandidate ? 'My progress' : 'Progress'}
          </Link>
          {!isCandidate && (
            <Button
              variant="secondary"
              leadingIcon="plus"
              onClick={() => setCreating(true)}
              disabled={!tools?.length}
            >
              New case
            </Button>
          )}
          {/*
            The way a tool comes into existence at all. Until this screen
            offered it, authoring one meant a node script run against the
            database with the answer key on somebody's laptop — so the entry
            point sat outside the product entirely.
          */}
          {!isCandidate && (
            <Button leadingIcon="sparkles" onClick={() => navigate('/app/assessments/builder')}>
              Assessment builder
            </Button>
          )}
        </div>
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

      {/*
        The way into the workflow builder. On the case list rather than buried
        in settings, because "who fills what" is a question that comes up while
        looking at cases — and until this link existed the screen was reachable
        only by typing its URL.
      */}
      {!isCandidate && tools && tools.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-card p-4">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-text-tertiary">
            Assessment workflows
          </span>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {tools.map((t) => (
              <Link
                key={t.id}
                to={`/app/assessments/tools/${t.id}/workflow`}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-text-accent hover:underline"
              >
                <Icon name="workflow" size={13} />
                {t.name}
              </Link>
            ))}
          </div>
          <span className="text-[11.5px] text-text-tertiary">
            Set who fills each section, and the order the work happens in.
          </span>
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
                return (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/app/assessments/${c.id}`)}
                    className="cursor-pointer border-b border-border-subtle last:border-0 hover:bg-surface-hover"
                  >
                    <td className="p-[11px_14px] font-semibold">{c.toolName}</td>
                    {!isCandidate && (
                      <td className="p-[11px_14px] text-text-secondary">
                        {c.candidateName}
                      </td>
                    )}
                    <td className="p-[11px_14px] text-text-secondary">{PATHWAY_LABELS[c.pathway]}</td>
                    <td className="p-[11px_14px]">
                      <CaseStateBadge state={c.state} />
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
  /*
    The whole summary, not just {id, name}. The form needs each tool's
    `locationStreams` to know whether this assessment's assessor requirements
    depend on where it happens — and narrowing the prop is what hid that.
  */
  tools: AssessmentToolSummary[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateAssessmentCase();
  const { data: members } = useMembers();
  /*
    Only accepted members can be a candidate: a pending invite has no user row
    yet, and its `userId` is null. Filtering them out here is what stops the
    picker offering a name the API would then reject as not-in-org.
  */
  const candidates = (members ?? []).filter(
    (m): m is typeof m & { userId: string } => !!m.userId && m.status === 'active',
  );
  const [toolId, setToolId] = useState(tools[0]?.id ?? '');
  const [candidateUserId, setCandidateUserId] = useState('');
  const [pathway, setPathway] = useState<AssessmentPathway>('new');
  const [locationId, setLocationId] = useState('');
  const [rplJustification, setRplJustification] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** The organisation's Locations, offered as a closed list (R77). */
  const locations = tools.find((t) => t.id === toolId)?.locations ?? [];

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
        ...(locationId ? { locationId } : {}),
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
          <label htmlFor="nc-candidate" className={label}>Candidate</label>
          <select
            id="nc-candidate"
            value={candidateUserId}
            onChange={(e) => setCandidateUserId(e.target.value)}
            className={`${field} mt-1`}
          >
            <option value="">Choose a candidate…</option>
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name || m.email} · {m.role}
              </option>
            ))}
          </select>
          {candidates.length === 0 && (
            <p className="mt-1 text-xs text-text-tertiary">
              Nobody has accepted an invitation yet. Invite the candidate from Team first — a pending
              invite has no user to record an assessment against.
            </p>
          )}
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

        {/*
          THE LOCATION DECIDES WHO MAY ASSESS THIS.

          Q50071833 authorises mine assessments and Q50073293 authorises raw
          materials, so a tool that distinguishes them cannot check its assessor
          without knowing which site this is. The Location is chosen from the
          organisation's managed list, never typed (R77), so it cannot be a
          near-miss of the site the assessor rule checks (R79). It stays optional
          — a tool may carry no location-specific rule, and a case left with no
          Location has that half of the assessor check skipped, and says so.
        */}
        <div>
          <label htmlFor="nc-location" className={label}>
            Location (optional)
          </label>
          <select
            id="nc-location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className={`${field} mt-1`}
          >
            <option value="">Not set</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {locations.length === 0 && (
            <p className="mt-1 text-xs text-text-tertiary">
              No Locations yet — add them in Locations &amp; roles. The
              location-specific half of the assessor check is not applied when no
              Location is chosen.
            </p>
          )}
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
