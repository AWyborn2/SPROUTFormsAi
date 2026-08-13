import { useNavigate } from 'react-router-dom';
import { Badge, Button, Icon, useToast } from '@formai/ui';
import { isTerminalCaseState, type SessionInfo } from '@formai/shared';
import {
  useAssessmentCases,
  useAssessorQueue,
  useComplianceReport,
  useDashboard,
  useForms,
  useHeldCompetencies,
  useMyRecommended,
  useRequestTraining,
  useSession,
  useWorkingList,
} from '../lib/data/hooks.js';
import { FORM_ICON_STYLE } from '../lib/data/fixtures.js';
import { useOnboarding } from '../lib/onboarding.js';
import { MOD_LABEL } from '../lib/keyboard/platform.js';
import { CaseStateBadge } from './statusBadges.js';
import { complianceTileCounts, type ComplianceTileCounts } from './dashboard-compliance.js';

/**
 * Dashboard — one route, three shapes, chosen by WHO is looking.
 *
 * A candidate's day is their competencies and the assessments waiting on them;
 * an assessor's is the cases waiting on THEM; everyone running the workspace
 * gets the forms-and-submissions view. Splitting per audience here rather than
 * sprinkling role checks through one component keeps each dashboard honest
 * about the data it may actually read — a candidate cannot list the org's
 * forms, so the workspace view would render them a permanently empty shell.
 */
export function DashboardScreen() {
  const { data: session } = useSession();
  if (session?.role === 'candidate') return <CandidateDashboard session={session} />;
  if (session?.role === 'assessor') return <AssessorDashboard session={session} />;
  return <WorkspaceDashboard />;
}

/** Shared page chrome for the personal dashboards. */
function firstNameOf(session: SessionInfo): string {
  return session.userName?.trim().split(/\s+/)[0] || 'there';
}

/**
 * The one stat-card shape every dashboard uses. Static by default; passing
 * `onClick` makes it a button with the interactive affordances (lift, pointer,
 * trailing chevron) that distinguish "click me" cards from the plain counts
 * that share their silhouette.
 */
function StatCard({
  label,
  icon,
  iconColor,
  value,
  onClick,
}: {
  label: string;
  icon: string;
  iconColor: string;
  value: number | string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
          {label}
        </span>
        <Icon name={icon} size={16} color={iconColor} />
      </div>
      <div className="flex items-center justify-between">
        <span className="font-heading text-[30px] font-bold tracking-tight">{value}</span>
        {onClick && <Icon name="chevron-right" size={16} className="text-text-tertiary" />}
      </div>
    </>
  );
  const shell = 'rounded-lg border border-border bg-surface-card p-[18px_20px] shadow-xs';
  return onClick ? (
    <button onClick={onClick} className={`fai-lift cursor-pointer text-left hover:shadow-md ${shell}`}>
      {inner}
    </button>
  ) : (
    <div className={shell}>{inner}</div>
  );
}

/**
 * The candidate's day: what they hold, what is lapsing, and what is waiting on
 * them — the same three answers their record gives, surfaced on landing.
 */
function CandidateDashboard({ session }: { session: SessionInfo }) {
  const navigate = useNavigate();
  const held = useHeldCompetencies(session.userId);
  const { data: cases } = useAssessmentCases();

  const rows = held.data ?? [];
  const current = rows.filter((c) => c.current).length;
  const attention = rows.filter((c) => c.status !== 'held');
  const due = (cases ?? []).filter((c) => !isTerminalCaseState(c.state));

  const stats = [
    { label: 'Current competencies', icon: 'award', iconColor: 'var(--accent)', value: current },
    { label: 'Need attention', icon: 'alert-triangle', iconColor: 'var(--warning)', value: attention.length },
    { label: 'Assessments open', icon: 'clipboard-check', iconColor: 'var(--info)', value: due.length },
  ];

  return (
    <div className="fai-rise mx-auto max-w-[900px] p-[30px_28px_60px]">
      <div className="mb-[22px] flex items-center justify-between gap-4">
        <div>
          <h2 className="font-heading text-[21px] font-bold">Welcome back, {firstNameOf(session)}</h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Your competencies and what&rsquo;s coming up.
          </p>
        </div>
        <Button variant="outline" size="sm" leadingIcon="user" onClick={() => navigate('/app/profile')}>
          My record
        </Button>
      </div>

      <div className="mb-[22px] grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <StatCard key={s.label} {...s} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-card p-5 shadow-xs">
          <div className="mb-3 font-heading text-[15px] font-bold">Assessments due</div>
          {due.length === 0 ? (
            <p className="text-[12.5px] text-text-tertiary">Nothing due — you&rsquo;re up to date.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {due.map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate(`/app/assessments/${c.id}`)}
                  className="fai-row flex w-full items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2 text-left hover:bg-surface-hover"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold">{c.toolName}</span>
                    <span className="block text-[11.5px] text-text-tertiary">
                      Started {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  <CaseStateBadge state={c.state} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border bg-surface-card p-5 shadow-xs">
          <div className="mb-3 font-heading text-[15px] font-bold">Expiring &amp; expired</div>
          {attention.length === 0 ? (
            <p className="text-[12.5px] text-text-tertiary">
              Every competency you hold is in date.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {attention.map((c) => (
                <div
                  key={c.competencyId}
                  className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold">{c.name}</span>
                    {c.note && (
                      <span className="block text-[11.5px] text-text-tertiary">{c.note}</span>
                    )}
                  </span>
                  <Badge variant={c.status === 'expired' ? 'danger' : 'warning'}>{c.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <RecommendedTrainingCard />
      </div>
    </div>
  );
}

/**
 * Unheld recommendations on the candidate's landing page (U7, R12). Absent —
 * not an empty shell — when every recommendation is held or none exists.
 * "Request this training" needs BOTH facts (R14, AE5): the org's self-start
 * toggle ON and a bookable awarding tool from the KTD2 resolver; toggle OFF
 * leaves the recommendation visible with no start action, and an evidence-only
 * entry names evidence as the route. The request posts the existing voluntary
 * `{ toolId }` body and waits on an admin (R94, R96).
 */
function RecommendedTrainingCard() {
  const { toast } = useToast();
  const { data } = useMyRecommended();
  const request = useRequestTraining();
  const unheld = (data?.items ?? []).filter((r) => !r.held);
  if (unheld.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface-card p-5 shadow-xs lg:col-span-2">
      <div className="mb-3 font-heading text-[15px] font-bold">Recommended for your roles</div>
      <div className="flex flex-col gap-1.5">
        {unheld.map((r) => (
          <div
            key={r.competencyId}
            className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-semibold">{r.name}</span>
              {r.code && (
                <span className="flex-none font-mono text-[10.5px] uppercase tracking-wide text-text-tertiary">
                  {r.code}
                </span>
              )}
            </span>
            {data?.selfStartEnabled && r.requestableToolId ? (
              <Button
                size="sm"
                variant="outline"
                disabled={request.isPending}
                onClick={() =>
                  request.mutate(r.requestableToolId!, {
                    onSuccess: () =>
                      toast({ variant: 'success', message: `Requested training for ${r.name}.` }),
                    onError: () =>
                      toast({ variant: 'danger', message: 'Could not send the request.' }),
                  })
                }
              >
                Request this training
              </Button>
            ) : (
              <span className="flex-none text-[11px] text-text-tertiary">
                {r.requestableToolId
                  ? 'Ask your supervisor'
                  : 'Evidence-based — ask your supervisor'}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The assessor's day: the cases waiting on their judgement, then the shared
 * queue they could pull from. Their forms-and-submissions numbers are noise —
 * assessing is the job this level exists for.
 */
function AssessorDashboard({ session }: { session: SessionInfo }) {
  const navigate = useNavigate();
  const { data: cases } = useAssessmentCases();
  const { data: queue } = useAssessorQueue();

  const open = (cases ?? []).filter((c) => !isTerminalCaseState(c.state));
  const awaiting = open.filter((c) => c.state === 'awaiting_sign_off');

  const stats = [
    { label: 'Open cases', icon: 'clipboard-check', iconColor: 'var(--info)', value: open.length },
    { label: 'Awaiting sign-off', icon: 'flag', iconColor: 'var(--warning)', value: awaiting.length },
    { label: 'In the shared queue', icon: 'inbox', iconColor: 'var(--accent)', value: queue?.length ?? 0 },
  ];

  return (
    <div className="fai-rise mx-auto max-w-[900px] p-[30px_28px_60px]">
      <div className="mb-[22px] flex items-center justify-between gap-4">
        <div>
          <h2 className="font-heading text-[21px] font-bold">Welcome back, {firstNameOf(session)}</h2>
          <p className="mt-0.5 text-sm text-text-secondary">The cases waiting on you.</p>
        </div>
        <div className="flex flex-none gap-2.5">
          <Button variant="outline" size="sm" leadingIcon="inbox" onClick={() => navigate('/app/assessments/queue')}>
            Queue
          </Button>
          <Button size="sm" leadingIcon="clipboard-check" onClick={() => navigate('/app/assessments')}>
            All cases
          </Button>
        </div>
      </div>

      <div className="mb-[22px] grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <StatCard key={s.label} {...s} />
        ))}
      </div>

      <div className="rounded-lg border border-border bg-surface-card p-5 shadow-xs">
        <div className="mb-3 font-heading text-[15px] font-bold">Open cases</div>
        {open.length === 0 ? (
          <p className="text-[12.5px] text-text-tertiary">No open cases — check the shared queue.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {/* Sign-off-ready first: those are waiting on a PERSON, which is
                the one thing an assessor opens this page to find. */}
            {[...awaiting, ...open.filter((c) => c.state !== 'awaiting_sign_off')].map((c) => (
              <button
                key={c.id}
                onClick={() => navigate(`/app/assessments/${c.id}`)}
                className="fai-row flex w-full items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2 text-left hover:bg-surface-hover"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">{c.toolName}</span>
                  <span className="block text-[11.5px] text-text-tertiary">{c.candidateName}</span>
                </span>
                <CaseStateBadge state={c.state} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The workspace view — forms, submissions, activity. Renders the populated
 * view when the workspace has forms (stat cards, "your forms", recent
 * activity); falls back to the first-run empty state otherwise. Stats come
 * from `GET /dashboard` — only counts the API can honestly compute (the
 * prototype's fabricated deltas and compliance score are gone, not faked).
 */
function WorkspaceDashboard() {
  const navigate = useNavigate();
  const { orgName } = useOnboarding();
  const { data: session } = useSession();
  const { data: forms = [] } = useForms();
  const { data: dash } = useDashboard();

  /*
    The compliance tile (R10–R12): admin/owner on the assessments tier only,
    absent — not zeroed — everywhere else, and rendered ABOVE the forms-based
    empty-state return: an admin with compliance duties and no forms yet still
    has a workforce to oversee. The fetches are gated the same way, because
    the compliance and working-list reads 403 below admin.
  */
  const showTile =
    (session?.role === 'admin' || session?.role === 'owner') &&
    session?.features?.assessments === true;
  const TILE_STALE_MS = 5 * 60 * 1000;
  const compliance = useComplianceReport({ enabled: showTile, staleTime: TILE_STALE_MS });
  const cases = useAssessmentCases({ enabled: showTile, staleTime: TILE_STALE_MS });
  const working = useWorkingList({ enabled: showTile, staleTime: TILE_STALE_MS });
  const tile = showTile
    ? complianceTileCounts(compliance.data, cases.data, working.data)
    : null;
  const tileErrored =
    showTile && !tile && (compliance.isError || cases.isError || working.isError);

  if (forms.length === 0 || !dash) {
    return (
      <div>
        {(tile || tileErrored) && (
          <div className="mx-auto max-w-[1120px] px-[28px] pt-[30px]">
            {tile ? <ComplianceTile counts={tile} navigate={navigate} /> : <ComplianceTileError />}
          </div>
        )}
        <EmptyDashboard orgName={orgName} navigate={navigate} />
      </div>
    );
  }

  const stats = [
    { label: 'Active forms', icon: 'folder', iconColor: 'var(--accent)', value: dash.activeForms },
    { label: 'Submissions', icon: 'inbox', iconColor: 'var(--info)', value: dash.submissionsTotal },
    { label: 'Needs review', icon: 'flag', iconColor: 'var(--warning)', value: dash.pendingReview },
  ];

  return (
    <div className="fai-rise mx-auto max-w-[1120px] p-[30px_28px_60px]">
      {/* Header actions — same create/import entry points as the form library,
          so a workspace that already has forms can still start a new one without
          detouring through the library or the empty state. */}
      <div className="mb-[22px] flex items-center justify-between gap-4">
        <p className="text-sm text-text-secondary">Your workspace at a glance.</p>
        <div className="flex flex-none gap-2.5">
          <Button
            variant="outline"
            size="sm"
            leadingIcon="file-up"
            onClick={() => navigate('/app/import')}
          >
            Import PDF
          </Button>
          <Button size="sm" leadingIcon="plus" onClick={() => navigate('/app/forms/build')}>
            New form
          </Button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="mb-[22px] grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <StatCard key={s.label} {...s} />
        ))}
      </div>

      {(tile || tileErrored) && (
        <div className="mb-[22px]">
          {tile ? <ComplianceTile counts={tile} navigate={navigate} /> : <ComplianceTileError />}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.7fr_1fr]">
        {/* Your forms */}
        <div className="rounded-lg border border-border bg-surface-card shadow-xs">
          <div className="flex items-center justify-between border-b border-border-subtle p-[18px_22px]">
            <span className="font-heading text-[15px] font-bold">Your forms</span>
            <button
              onClick={() => navigate('/app/forms')}
              className="text-[12.5px] font-semibold text-text-accent"
            >
              View all
            </button>
          </div>
          <div>
            {forms.slice(0, 4).map((f) => {
              const style = FORM_ICON_STYLE[f.icon] ?? {
                bg: 'var(--surface-sunken)',
                color: 'var(--text-secondary)',
              };
              return (
                <button
                  key={f.id}
                  onClick={() => navigate(f.status === 'draft' ? '/app/forms/build' : '/app/forms')}
                  className="fai-row flex w-full items-center gap-[14px] border-b border-border-subtle p-[14px_22px] text-left last:border-b-0 hover:bg-surface-hover"
                >
                  <span
                    className="grid h-9 w-9 flex-none place-items-center rounded-[9px]"
                    style={{ background: style.bg }}
                  >
                    <Icon name={f.icon} size={18} color={style.color} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-ui text-sm font-semibold">{f.name}</span>
                    <span className="block text-xs text-text-tertiary">
                      {f.dept} · {f.version} · {f.updated}
                    </span>
                  </span>
                  {f.status === 'published' ? (
                    <Badge variant="success" dot>
                      Live
                    </Badge>
                  ) : (
                    <Badge variant="neutral">Draft</Badge>
                  )}
                  <span className="w-[52px] text-right font-heading text-[15px] font-bold">
                    {f.submissions}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Recent activity */}
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-surface-card p-5 shadow-xs">
            <div className="mb-[14px] font-heading text-[15px] font-bold">Recent activity</div>
            {dash.activity.length === 0 ? (
              <div className="text-[12.5px] text-text-tertiary">No activity yet</div>
            ) : (
              <div className="flex flex-col gap-[14px]">
                {dash.activity.map((a) => (
                  <div key={a.id} className="flex gap-[11px]">
                    <span className="grid h-7 w-7 flex-none place-items-center rounded-full bg-surface-sunken">
                      <Icon name={a.icon} size={14} className="text-text-secondary" />
                    </span>
                    <div className="flex-1 text-[12.5px] leading-snug">
                      <span className="text-text-primary">
                        {a.actor} · {a.action}
                        {a.target ? ` · ${a.target}` : ''}
                      </span>
                      <span className="mt-px block text-[11.5px] text-text-tertiary">{a.time}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The four compliance numbers, each a way in (R10, R11).
 *
 * Interactive on purpose where the stat row above is not: hover lift, pointer
 * and a trailing chevron distinguish "click me" cards from the static counts
 * that share their shape — four identical-looking but secretly clickable divs
 * would leave the click-through undiscovered.
 */
function ComplianceTile({
  counts,
  navigate,
}: {
  counts: ComplianceTileCounts;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const cards = [
    {
      // Grace included: past the date but still counting is the most urgent
      // booking of all, and the compliance read files it in the same bucket.
      label: 'Expiring or in grace',
      icon: 'calendar-clock',
      iconColor: 'var(--warning)',
      value: counts.expiringMembers,
      to: '/app/compliance?status=expiring',
    },
    {
      label: 'Required expired',
      icon: 'clock-alert',
      iconColor: 'var(--danger)',
      value: counts.expiredMembers,
      to: '/app/compliance?status=expired',
    },
    {
      label: 'Awaiting sign-off',
      icon: 'flag',
      iconColor: 'var(--info)',
      value: counts.awaitingSignOff,
      to: '/app/assessments',
    },
    {
      label: 'Working list',
      icon: 'list-checks',
      iconColor: 'var(--accent)',
      value: counts.workingListSize,
      to: '/app/working-list',
    },
  ];

  return (
    <div>
      <div className="mb-2 font-mono text-[10.5px] uppercase tracking-wider text-text-tertiary">
        Workforce compliance
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <StatCard
            key={c.label}
            label={c.label}
            icon={c.icon}
            iconColor={c.iconColor}
            value={c.value}
            onClick={() => navigate(c.to)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Absence must not be ambiguous. The tile disappears for a reader it does not
 * apply to — but for an eligible admin whose reads FAILED, the same absence
 * would silently hide the numbers they steer by (`retry: false` means nothing
 * re-fires while they stay on the page). One quiet line names the difference.
 */
function ComplianceTileError() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-card p-4 text-[12.5px] text-text-tertiary">
      <Icon name="alert-triangle" size={14} className="text-warning" />
      Workforce compliance numbers couldn&rsquo;t load — refresh to retry.
    </div>
  );
}

function EmptyDashboard({
  orgName,
  navigate,
}: {
  orgName: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <div className="fai-rise mx-auto mt-[26px] max-w-[840px] text-center">
      <span className="mb-5 inline-grid h-[60px] w-[60px] place-items-center rounded-2xl bg-surface-accent-soft">
        <Icon name="sparkles" size={28} className="text-accent" />
      </span>
      <h2 className="mb-2 text-[29px]">Welcome to {orgName}</h2>
      <p className="mx-auto mb-[34px] max-w-[520px] text-[17px] leading-relaxed text-text-secondary">
        Your workspace is ready. Bring an existing PDF across, or start a fresh form — either way
        you'll have something live in minutes.
      </p>
      <div className="grid grid-cols-1 gap-[18px] text-left sm:grid-cols-2">
        <button
          onClick={() => navigate('/app/import')}
          className="fai-lift rounded-lg border border-border bg-surface-card p-[26px] shadow-sm"
        >
          <span className="mb-4 grid h-[46px] w-[46px] place-items-center rounded-[11px] bg-brand-slate">
            <Icon name="file-up" size={22} color="#8fd6ad" />
          </span>
          <div className="mb-[5px] font-heading text-[17px] font-bold">Import a PDF</div>
          <div className="text-[13.5px] leading-normal text-text-secondary">
            Upload an existing form. Our extraction maps every field — you review and publish.
          </div>
        </button>
        <button
          onClick={() => navigate('/app/forms/build')}
          className="fai-lift rounded-lg border border-border bg-surface-card p-[26px] shadow-sm"
        >
          <span className="mb-4 grid h-[46px] w-[46px] place-items-center rounded-[11px] bg-surface-accent-soft">
            <Icon name="layout-template" size={22} className="text-accent" />
          </span>
          <div className="mb-[5px] font-heading text-[17px] font-bold">Build from scratch</div>
          <div className="text-[13.5px] leading-normal text-text-secondary">
            Drag fields onto a canvas. Configure validation, logic and branding as you go.
          </div>
        </button>
      </div>
      <div className="mt-[26px] flex items-center justify-center gap-2 text-[12.5px] text-text-tertiary">
        <span className="kbd">{MOD_LABEL}K</span> anywhere to jump around · press{' '}
        <span className="kbd">?</span> for shortcuts
      </div>
    </div>
  );
}
