import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Icon, Select } from '@formai/ui';
import { useTaxonomy, useTrainingSummary } from '../../lib/data/hooks.js';
import { TONE_BAR, TONE_TEXT } from './tone-styles.js';
import {
  DONUT_RADIUS,
  compliancePct,
  donutDash,
  gapDeltaChip,
  groupBars,
  scopeLabel,
  signOffDeltaChip,
  topGapsBars,
  trendGeometry,
  weeklyBars,
  type DeltaChip,
  type GroupBand,
} from './training-summary-view.js';

/**
 * The training summary (U6) — the one-page KPI roll-up of the standing data
 * the matrix (U5) shows cell by cell, shaped to be read in a minute and
 * printed for the toolbox meeting. All derivation and chart geometry lives in
 * `training-summary-view.ts`; this file only renders it. Charts are
 * hand-rolled SVG/divs — no chart library.
 */

/* The trend chart's fixed internal geometry (viewBox units). */
const TREND_W = 560;
const TREND_H = 160;

const BAND_BAR: Record<GroupBand, string> = TONE_BAR;
const BAND_TEXT: Record<GroupBand, string> = TONE_TEXT;

const CHIP_TEXT: Record<DeltaChip['tone'], string> = {
  success: 'text-success-text',
  danger: 'text-danger-text',
};

/*
  Print styles, per the CHC intake precedent: state/media rules inline styles
  cannot express, every selector prefixed `tsum-` so nothing leaks into the
  shell. The visibility trick prints ONLY this screen's content — the app
  shell around it (sidebar, header) is not this screen's DOM to add classes
  to — and `print-color-adjust: exact` keeps the chart colours the report is
  read by from being ink-saved away.
*/
const TRAINING_SUMMARY_PRINT_CSS = `
@media print {
  body * { visibility: hidden; }
  .tsum-print, .tsum-print * { visibility: visible; }
  .tsum-print { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; }
  .tsum-print * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .tsum-no-print { display: none !important; }
}
`;

/** A stat card in the dashboard `StatCard` silhouette, with free-form body. */
function SummaryCard({
  label,
  icon,
  iconColor,
  onClick,
  children,
}: {
  label: string;
  icon: string;
  iconColor: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const inner = (
    <>
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
          {label}
        </span>
        <span className="flex items-center gap-1.5">
          <Icon name={icon} size={16} color={iconColor} />
          {onClick && <Icon name="chevron-right" size={14} className="text-text-tertiary" />}
        </span>
      </div>
      {children}
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

function DeltaChipSpan({ chip }: { chip: DeltaChip | null }) {
  if (!chip) return null;
  return (
    <span className={`text-[12px] font-semibold tabular-nums ${CHIP_TEXT[chip.tone]}`}>
      {chip.text}
    </span>
  );
}

export function TrainingSummaryScreen() {
  const navigate = useNavigate();
  const { data: taxonomy } = useTaxonomy();

  // 'org' | 'location:<id>' | 'department:<id>' — one control, three scopes.
  const [scopeSel, setScopeSel] = useState('org');
  const [axis, setAxis] = useState<'location' | 'department' | 'role'>('department');

  const params = useMemo(() => {
    const [kind, id] = scopeSel.split(':');
    return {
      ...(kind === 'location' && id ? { location: id } : {}),
      ...(kind === 'department' && id ? { department: id } : {}),
      axis,
    };
  }, [scopeSel, axis]);

  const { data: summary, isLoading, isError } = useTrainingSummary(params);

  const scopeOptions = [
    { label: 'Org-wide', value: 'org' },
    ...(taxonomy?.locations ?? []).map((l) => ({ label: l.name, value: `location:${l.id}` })),
    ...(taxonomy?.departments ?? []).map((d) => ({ label: d.name, value: `department:${d.id}` })),
  ];

  const generatedOn = useMemo(
    () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
    [],
  );

  const pct = summary ? compliancePct(summary.compliance.compliantCount, summary.compliance.memberCount) : 0;
  const trend = useMemo(
    () => (summary ? trendGeometry(summary.trend.points, TREND_W, TREND_H) : null),
    [summary],
  );
  const gaps = summary ? topGapsBars(summary.gaps.byCompetency) : [];
  const groups = summary ? groupBars(summary.complianceByGroup.groups) : [];
  const weeks = summary ? weeklyBars(summary.signOffs.weeks) : [];

  return (
    <div className="tsum-print fai-rise mx-auto max-w-[1100px] p-[30px_28px_60px]">
      <style>{TRAINING_SUMMARY_PRINT_CSS}</style>

      {/* Header row */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
            Reporting
          </div>
          <h2 className="font-heading text-xl font-bold">Training summary</h2>
          <p className="mt-1 text-sm text-text-tertiary">
            {summary ? scopeLabel(summary.scope) : '…'}
            {summary && ` · ${summary.compliance.memberCount} people`} · generated {generatedOn}
          </p>
        </div>
        <div className="tsum-no-print flex flex-wrap items-center gap-2.5">
          <div className="w-[200px]">
            <Select
              aria-label="Report scope"
              options={scopeOptions}
              value={scopeSel}
              onChange={(e) => setScopeSel(e.target.value)}
            />
          </div>
          <Button size="sm" leadingIcon="download" onClick={() => window.print()}>
            Export PDF
          </Button>
        </div>
      </div>

      {isLoading && <div className="p-6 text-sm text-text-tertiary">Loading…</div>}
      {isError && <div className="p-6 text-sm text-danger-text">Could not load the summary.</div>}

      {summary && (
        <>
          {/* KPI row */}
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard label="Overall compliance" icon="shield-check" iconColor="var(--success)">
              <div className="flex items-center gap-4">
                <span className="relative h-[84px] w-[84px] flex-none">
                  <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
                    <circle
                      cx="60"
                      cy="60"
                      r={DONUT_RADIUS}
                      fill="none"
                      stroke="var(--surface-sunken)"
                      strokeWidth="13"
                    />
                    {pct > 0 && (
                      <circle
                        cx="60"
                        cy="60"
                        r={DONUT_RADIUS}
                        fill="none"
                        stroke="var(--success)"
                        strokeWidth="13"
                        strokeLinecap="round"
                        strokeDasharray={donutDash(pct)}
                      />
                    )}
                  </svg>
                  <span className="absolute inset-0 grid place-items-center font-heading text-[19px] font-bold tabular-nums">
                    {pct}%
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="block font-heading text-[17px] font-bold tabular-nums">
                    {summary.compliance.compliantCount} / {summary.compliance.memberCount}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-text-tertiary">
                    people fully compliant for every held role
                  </span>
                </span>
              </div>
            </SummaryCard>

            <SummaryCard
              label="Expiring soon"
              icon="calendar-clock"
              iconColor="var(--warning)"
              onClick={() => navigate('/app/compliance?status=expiring')}
            >
              <div className="flex items-end gap-4">
                {(
                  [
                    { days: 30, count: summary.expiring.in30, tone: 'text-danger-text' },
                    { days: 60, count: summary.expiring.in60, tone: 'text-warning-text' },
                    { days: 90, count: summary.expiring.in90, tone: 'text-text-secondary' },
                  ] as const
                ).map((w) => (
                  <span key={w.days} className="min-w-0">
                    <span className={`block font-heading text-[24px] font-bold tabular-nums ${w.tone}`}>
                      {w.count}
                    </span>
                    <span className="block text-[11px] text-text-tertiary">≤{w.days}d</span>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11.5px] leading-snug text-text-tertiary">
                grants lapsing without renewal
              </p>
            </SummaryCard>

            <SummaryCard
              label="Open gaps"
              icon="alert-triangle"
              iconColor="var(--danger)"
              onClick={() => navigate('/app/compliance?status=expired')}
            >
              <div className="flex items-baseline gap-2.5">
                <span className="font-heading text-[30px] font-bold tabular-nums">
                  {summary.gaps.total}
                </span>
                <DeltaChipSpan chip={gapDeltaChip(summary.trend.gapDelta)} />
              </div>
              <p className="mt-2 text-[11.5px] leading-snug text-text-tertiary">
                {summary.gaps.evidenceOnly} are evidence-based (no awarding assessment)
              </p>
            </SummaryCard>

            <SummaryCard label="Sign-offs this week" icon="pen-line" iconColor="var(--accent)">
              <div className="flex items-baseline gap-2.5">
                <span className="font-heading text-[30px] font-bold tabular-nums">
                  {summary.signOffs.currentWeek}
                </span>
                <DeltaChipSpan
                  chip={signOffDeltaChip(summary.signOffs.currentWeek, summary.signOffs.priorFullWeek)}
                />
              </div>
              <p className="mt-2 text-[11.5px] leading-snug text-text-tertiary">
                assessment outcomes recorded this week
              </p>
            </SummaryCard>
          </div>

          {/* Charts grid */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Compliance trend */}
            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="font-ui text-sm font-semibold">Compliance trend</h3>
                {summary.scope.type !== 'org' && <Badge variant="neutral">org-wide</Badge>}
              </div>
              {trend && trend.empty ? (
                <div className="grid h-[160px] place-items-center px-6 text-center text-sm text-text-tertiary">
                  Trend accrues from daily snapshots — check back soon
                </div>
              ) : (
                trend && (
                  <>
                    {/* overflow-visible: the terminal dot sits ON the edge of the viewBox */}
                    <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} className="w-full overflow-visible">
                      {/* 100 / 50 / 0 % gridlines */}
                      {[0, TREND_H / 2, TREND_H].map((y) => (
                        <line
                          key={y}
                          x1="0"
                          y1={y}
                          x2={TREND_W}
                          y2={y}
                          stroke="var(--border-subtle)"
                          strokeWidth="1"
                        />
                      ))}
                      {trend.area && <path d={trend.area} fill="var(--surface-accent-soft)" />}
                      {trend.line && (
                        <path
                          d={trend.line}
                          fill="none"
                          stroke="var(--accent)"
                          strokeWidth="2.5"
                          strokeLinejoin="round"
                        />
                      )}
                      <circle cx={trend.dot.x} cy={trend.dot.y} r="4" fill="var(--accent)" />
                    </svg>
                    <p className="mt-2 text-[11.5px] text-text-tertiary">
                      % of people fully compliant, daily · latest{' '}
                      <span className="font-semibold tabular-nums text-text-secondary">
                        {trend.latestPct}%
                      </span>
                    </p>
                  </>
                )
              )}
            </Card>

            {/* Gaps by competency */}
            <Card className="p-5">
              <h3 className="mb-3 font-ui text-sm font-semibold">Gaps by competency</h3>
              {gaps.length === 0 ? (
                <div className="grid h-[160px] place-items-center text-sm text-text-tertiary">
                  No open gaps — nothing required is missing.
                </div>
              ) : (
                <div className="grid gap-2.5">
                  {gaps.map((g) => (
                    <div key={g.competencyId} className="grid grid-cols-[minmax(0,160px)_1fr_auto] items-center gap-3">
                      <span className="truncate text-[12.5px] text-text-secondary" title={g.name}>
                        {g.name}
                      </span>
                      <span className="h-2.5 overflow-hidden rounded-pill bg-surface-sunken">
                        <span
                          className="block h-full rounded-pill bg-danger"
                          style={{ width: `${g.widthPct}%` }}
                        />
                      </span>
                      <span className="w-6 text-right text-[12.5px] font-semibold tabular-nums">
                        {g.count}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Compliance by group */}
            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="font-ui text-sm font-semibold">
                  Compliance by {summary.complianceByGroup.axis}
                </h3>
                <div className="tsum-no-print w-[150px]">
                  <Select
                    aria-label="Group axis"
                    options={[
                      { label: 'By location', value: 'location' },
                      { label: 'By department', value: 'department' },
                      { label: 'By role', value: 'role' },
                    ]}
                    value={axis}
                    onChange={(e) => setAxis(e.target.value as 'location' | 'department' | 'role')}
                  />
                </div>
              </div>
              {groups.length === 0 ? (
                <div className="grid h-[160px] place-items-center text-sm text-text-tertiary">
                  Nobody is placed on this axis yet.
                </div>
              ) : (
                <div className="grid gap-2.5">
                  {groups.map((g) => (
                    <div key={g.id} className="grid grid-cols-[minmax(0,160px)_1fr_auto] items-center gap-3">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={`h-2 w-2 flex-none rounded-pill ${BAND_BAR[g.band]}`} />
                        <span className="truncate text-[12.5px] text-text-secondary" title={g.name}>
                          {g.name}
                        </span>
                      </span>
                      <span className="h-2.5 overflow-hidden rounded-pill bg-surface-sunken">
                        <span
                          className={`block h-full rounded-pill ${BAND_BAR[g.band]}`}
                          style={{ width: `${g.pct}%` }}
                        />
                      </span>
                      <span className={`w-10 text-right text-[12.5px] font-semibold tabular-nums ${BAND_TEXT[g.band]}`}>
                        {g.pct}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Assessment throughput */}
            <Card className="p-5">
              <h3 className="mb-3 font-ui text-sm font-semibold">Assessment throughput</h3>
              <div className="flex h-[130px] items-end gap-2">
                {weeks.map((w) => (
                  <div key={w.weekStart} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1">
                    <span
                      title={`Week of ${w.weekStart} — ${w.count} sign-off${w.count === 1 ? '' : 's'}`}
                      className={`block w-full rounded-t-sm ${w.current ? 'bg-accent' : 'bg-surface-accent-soft'}`}
                      style={{ height: `${w.heightPct}%` }}
                    />
                    <span
                      className={`text-center text-[10.5px] tabular-nums ${
                        w.current ? 'font-semibold text-text-accent' : 'text-text-tertiary'
                      }`}
                    >
                      {w.label}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11.5px] text-text-tertiary">sign-offs per week</p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
