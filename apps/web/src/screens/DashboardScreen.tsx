import { useNavigate } from 'react-router-dom';
import { Badge, Icon } from '@formai/ui';
import { useDashboard, useForms } from '../lib/data/hooks.js';
import { FORM_ICON_STYLE } from '../lib/data/fixtures.js';
import { useOnboarding } from '../lib/onboarding.js';
import { MOD_LABEL } from '../lib/keyboard/platform.js';

/**
 * Dashboard. Renders the populated view when the workspace has forms (stat
 * cards, "your forms", recent activity); falls back to the first-run empty
 * state otherwise. Stats come from `GET /dashboard` — only counts the API
 * can honestly compute (the prototype's fabricated deltas and compliance
 * score are gone, not faked).
 */
export function DashboardScreen() {
  const navigate = useNavigate();
  const { orgName } = useOnboarding();
  const { data: forms = [] } = useForms();
  const { data: dash } = useDashboard();

  if (forms.length === 0 || !dash) return <EmptyDashboard orgName={orgName} navigate={navigate} />;

  const stats = [
    { label: 'Active forms', icon: 'folder', iconColor: 'var(--accent)', value: dash.activeForms },
    { label: 'Submissions', icon: 'inbox', iconColor: 'var(--info)', value: dash.submissionsTotal },
    { label: 'Needs review', icon: 'flag', iconColor: 'var(--warning)', value: dash.pendingReview },
  ];

  return (
    <div className="fai-rise mx-auto max-w-[1120px] p-[30px_28px_60px]">
      {/* Stat cards */}
      <div className="mb-[22px] grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-surface-card p-[18px_20px] shadow-xs">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
                {s.label}
              </span>
              <Icon name={s.icon} size={16} color={s.iconColor} />
            </div>
            <div className="font-heading text-[30px] font-bold tracking-tight">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.7fr_1fr]">
        {/* Your forms */}
        <div className="rounded-lg border border-border bg-surface-card shadow-xs">
          <div className="flex items-center justify-between border-b border-border-subtle p-[18px_22px]">
            <span className="font-heading text-[15px] font-bold">Your forms</span>
            <button onClick={() => navigate('/app/forms')} className="text-[12.5px] font-semibold text-text-accent">
              View all
            </button>
          </div>
          <div>
            {forms.slice(0, 4).map((f) => {
              const style = FORM_ICON_STYLE[f.icon] ?? { bg: 'var(--surface-sunken)', color: 'var(--text-secondary)' };
              return (
                <button
                  key={f.id}
                  onClick={() => navigate(f.status === 'draft' ? '/app/forms/build' : '/app/forms')}
                  className="fai-row flex w-full items-center gap-[14px] border-b border-border-subtle p-[14px_22px] text-left last:border-b-0 hover:bg-surface-hover"
                >
                  <span className="grid h-9 w-9 flex-none place-items-center rounded-[9px]" style={{ background: style.bg }}>
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
                  <span className="w-[52px] text-right font-heading text-[15px] font-bold">{f.submissions}</span>
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
