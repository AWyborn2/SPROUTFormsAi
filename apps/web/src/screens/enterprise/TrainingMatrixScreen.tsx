import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Badge, Button, Card, Icon, Input, Select, Switch } from '@formai/ui';
import { useTaxonomy, useTrainingMatrix } from '../../lib/data/hooks.js';
import { exportCsv } from '../../lib/csv.js';
import type {
  TrainingMatrixCompetency,
  TrainingMatrixMember,
} from '../../lib/data/types.js';
import {
  DEFAULT_WINDOW,
  ROW_CHUNK,
  WINDOW_OPTIONS,
  cellDisplay,
  complianceBand,
  groupMembers,
  matrixCsvRows,
  memberCompliancePct,
  memberIssueChips,
  memberMatchesFilters,
  type CellDisplay,
  type ComplianceBand,
  type GroupAxis,
  type MatrixFilters,
  type MatrixGroup,
} from './training-matrix-view.js';

/**
 * The training matrix (U5) — the whole workforce against the whole competency
 * list on one screen, the wall chart every training office keeps. Two views of
 * the same filtered payload: the grid (people × competencies) and the grouped
 * roll-up (cards per department/location/role). All derivation lives in
 * `training-matrix-view.ts`; this file only renders it.
 */

const BAND_BAR: Record<ComplianceBand, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

const BAND_TEXT: Record<ComplianceBand, string> = {
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
};

/** The square itself — colours from the same tokens the Badge variants use. */
const CELL_STYLE: Record<CellDisplay['kind'], string> = {
  held: 'bg-success-soft text-success-text',
  expiring: 'bg-warning-soft text-warning-text',
  lapsed: 'bg-danger-soft text-danger-text',
  gap: 'border border-dashed border-danger bg-transparent',
  recommended: 'border border-dotted border-border-strong bg-transparent',
  none: 'bg-surface-sunken opacity-40',
};

/** The tooltip's state phrase — spelled out, because a 28px square cannot. */
function cellDetail(display: CellDisplay): string {
  switch (display.kind) {
    case 'held':
      return 'Held';
    case 'expiring':
      return `Expiring in ${display.days}d`;
    case 'lapsed':
      return 'Lapsed';
    case 'gap':
      return 'Required — not held';
    case 'recommended':
      return 'Recommended — not held';
    case 'none':
      return 'Not required';
  }
}

function MatrixCell({
  competency,
  display,
}: {
  competency: TrainingMatrixCompetency;
  display: CellDisplay;
}) {
  return (
    <div
      title={`${competency.name} — ${cellDetail(display)}`}
      className={`grid h-7 w-7 place-items-center rounded-sm text-[10px] font-semibold ${CELL_STYLE[display.kind]}`}
    >
      {display.kind === 'held' && <Icon name="check" size={13} />}
      {display.kind === 'expiring' && <span className="tabular-nums">{display.days}d</span>}
      {display.kind === 'lapsed' && '!'}
    </div>
  );
}

/** The KTD4 marker, worded exactly as ComplianceScreen words it. */
function UnplacedMarker() {
  return (
    <span
      className="text-warning-text"
      title="Cannot be scheduled — no location placement"
    >
      <Icon name="map-pin-off" size={12} />
    </span>
  );
}

function ComplianceMeter({ pct }: { pct: number }) {
  const band = complianceBand(pct);
  return (
    <span className="flex items-center gap-2">
      <span className={`w-9 text-right text-[12px] font-semibold tabular-nums ${BAND_TEXT[band]}`}>
        {pct}%
      </span>
      <span className="h-1 w-14 overflow-hidden rounded-pill bg-surface-sunken">
        <span className={`block h-full rounded-pill ${BAND_BAR[band]}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

/** A member's headline standing: gaps beat expiring beats compliant. */
function memberStatusBadge(
  member: TrainingMatrixMember,
  windowDays: number,
  now: Date,
): { label: string; variant: 'success' | 'warning' | 'danger' } {
  let gaps = 0;
  let expiring = 0;
  for (const cell of member.cells) {
    const kind = cellDisplay(cell, windowDays, now).kind;
    if (kind === 'gap' || kind === 'lapsed') gaps += 1;
    else if (kind === 'expiring') expiring += 1;
  }
  if (gaps > 0) return { label: `${gaps} gap${gaps === 1 ? '' : 's'}`, variant: 'danger' };
  if (expiring > 0) return { label: `${expiring} expiring`, variant: 'warning' };
  return { label: 'Compliant', variant: 'success' };
}

const LEGEND: Array<{ label: string; className: string }> = [
  { label: 'Held', className: CELL_STYLE.held },
  { label: 'Expiring', className: CELL_STYLE.expiring },
  { label: 'Lapsed', className: CELL_STYLE.lapsed },
  { label: 'Gap', className: CELL_STYLE.gap },
  { label: 'Recommended', className: CELL_STYLE.recommended },
];

export function TrainingMatrixScreen() {
  const navigate = useNavigate();
  const { data: matrix, isLoading, isError } = useTrainingMatrix();
  const { data: taxonomy } = useTaxonomy();

  const [view, setView] = useState<'grid' | 'group'>('grid');
  const [axis, setAxis] = useState<GroupAxis>('department');
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_WINDOW);
  const [search, setSearch] = useState('');
  const [locationId, setLocationId] = useState('all');
  const [departmentId, setDepartmentId] = useState('all');
  const [chip, setChip] = useState<MatrixFilters['chip']>('all');
  const [showRecommended, setShowRecommended] = useState(true);
  const [shown, setShown] = useState(ROW_CHUNK);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // One instant for the whole render, so no two cells disagree about "today".
  const now = useMemo(() => new Date(), []);

  const competencies = matrix?.competencies ?? [];
  const members = matrix?.members ?? [];

  const filtered = useMemo(() => {
    const filters: MatrixFilters = { search, locationId, departmentId, chip };
    return members.filter((m) => memberMatchesFilters(m, filters, windowDays, now));
  }, [members, search, locationId, departmentId, chip, windowDays, now]);

  const groups: MatrixGroup[] = useMemo(
    () => (view === 'group' ? groupMembers(filtered, axis, windowDays, now) : []),
    [view, filtered, axis, windowDays, now],
  );

  const locationOptions = [
    { label: 'All locations', value: 'all' },
    ...(taxonomy?.locations ?? []).map((l) => ({ label: l.name, value: l.id })),
  ];
  const departmentOptions = [
    { label: 'All departments', value: 'all' },
    ...(taxonomy?.departments ?? []).map((d) => ({ label: d.name, value: d.id })),
  ];

  function toggleGroup(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="fai-rise mx-auto max-w-[1400px] p-[30px_28px_60px]">
      {/* Header row */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
            Training &amp; competency
          </div>
          <h2 className="font-heading text-xl font-bold">Training matrix</h2>
          <p className="mt-1 text-sm text-text-tertiary">
            {members.length} people · {competencies.length} competencies · expiring window{' '}
            {windowDays}d
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div
            className="flex overflow-hidden rounded-md border border-border"
            role="group"
            aria-label="Matrix view"
          >
            {(
              [
                { key: 'grid', label: 'Grid', icon: 'grid-3x3' },
                { key: 'group', label: 'By group', icon: 'users' },
              ] as const
            ).map((v) => {
              const active = view === v.key;
              return (
                <button
                  key={v.key}
                  onClick={() => setView(v.key)}
                  aria-pressed={active}
                  className={`flex items-center gap-1.5 px-3 py-1.5 font-ui text-[12.5px] font-semibold ${
                    active ? 'bg-surface-accent-soft text-text-accent' : 'bg-surface-card text-text-secondary'
                  }`}
                >
                  <Icon name={v.icon} size={13} />
                  {v.label}
                </button>
              );
            })}
          </div>
          <Button
            size="sm"
            variant="outline"
            leadingIcon="download"
            onClick={() =>
              exportCsv(
                'training-matrix.csv',
                matrixCsvRows(competencies, filtered, windowDays, now),
              )
            }
          >
            Export CSV
          </Button>
          <div className="w-[120px]">
            <Select
              aria-label="Expiring window"
              options={WINDOW_OPTIONS.map((d) => ({ label: `${d} days`, value: String(d) }))}
              value={String(windowDays)}
              onChange={(e) => setWindowDays(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      {/* Filter row */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-[210px]">
          <Input
            leadingIcon="search"
            placeholder="Search people…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search people"
          />
        </div>
        <div className="w-[180px]">
          <Select
            aria-label="Filter by location"
            options={locationOptions}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          />
        </div>
        <div className="w-[190px]">
          <Select
            aria-label="Filter by department"
            options={departmentOptions}
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
          />
        </div>
        <div className="flex gap-1.5">
          {(
            [
              { key: 'all', label: 'All people' },
              { key: 'gaps', label: 'Has gaps' },
              { key: 'expiring', label: `Expiring ≤${windowDays}d` },
            ] as const
          ).map((c) => {
            const active = chip === c.key;
            return (
              <button
                key={c.key}
                onClick={() => setChip(c.key)}
                aria-pressed={active}
                className="fai-chip-btn rounded-pill border px-3 py-1.5 font-ui text-[12.5px] font-semibold"
                style={{
                  borderColor: active ? 'var(--brand-slate)' : 'var(--border-default)',
                  background: active ? 'var(--brand-slate)' : 'var(--surface-card)',
                  color: active ? '#fff' : 'var(--text-secondary)',
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <Switch
          label="Show recommended"
          checked={showRecommended}
          onChange={(e) => setShowRecommended(e.target.checked)}
        />
        <span className="flex-1" />
        <div className="flex items-center gap-3">
          {LEGEND.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
              <span className={`h-3 w-3 rounded-sm ${l.className}`} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      {isLoading && <div className="p-6 text-sm text-text-tertiary">Loading…</div>}
      {isError && <div className="p-6 text-sm text-danger-text">Could not load the matrix.</div>}

      {matrix && view === 'grid' && (
        <>
          {/* Both axes scroll INSIDE this box, so the sticky person column and
              sticky competency header actually engage. */}
          <div className="max-h-[75vh] overflow-auto rounded-lg border border-border bg-surface-card shadow-xs">
            <table className="border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-30 min-w-[240px] border-b border-border bg-surface-card px-4 pb-2 pt-3 text-left font-ui text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                    Person
                  </th>
                  {competencies.map((c) => (
                    <th
                      key={c.id}
                      className="sticky top-0 z-20 h-[130px] border-b border-border bg-surface-card px-1 pb-2 align-bottom"
                      title={c.code ? `${c.name} (${c.code})` : c.name}
                    >
                      <span
                        className="mx-auto block max-h-[118px] overflow-hidden whitespace-nowrap font-ui text-[11px] font-medium text-text-secondary"
                        style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                      >
                        {c.name}
                      </span>
                    </th>
                  ))}
                  <th className="sticky top-0 z-20 border-b border-border bg-surface-card px-4 pb-2 text-right align-bottom font-ui text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                    Compliance
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, shown).map((m) => (
                  <tr
                    key={m.membershipId}
                    onClick={() => navigate(`/app/profile/${m.membershipId}`)}
                    className="cursor-pointer hover:bg-surface-sunken"
                    style={{ contentVisibility: 'auto' }}
                  >
                    <td className="sticky left-0 z-10 border-b border-border-subtle bg-surface-card px-4 py-1.5">
                      <span className="flex items-center gap-2.5">
                        <Avatar name={m.name} size="sm" />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[13px] font-semibold">{m.name}</span>
                            {m.noLocationPlacement && <UnplacedMarker />}
                          </span>
                          <span className="block truncate text-[11.5px] text-text-tertiary">
                            {m.role}
                            {m.roles.length > 0 && ` · ${m.roles.map((r) => r.name).join(', ')}`}
                          </span>
                        </span>
                      </span>
                    </td>
                    {competencies.map((c, i) => {
                      const display = cellDisplay(m.cells[i] ?? null, windowDays, now);
                      const shownDisplay =
                        display.kind === 'recommended' && !showRecommended
                          ? ({ kind: 'none' } as const)
                          : display;
                      return (
                        <td key={c.id} className="border-b border-border-subtle px-1 py-1.5">
                          <MatrixCell competency={c} display={shownDisplay} />
                        </td>
                      );
                    })}
                    <td className="border-b border-border-subtle px-4 py-1.5 text-right">
                      <ComplianceMeter pct={memberCompliancePct(m)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="p-6 text-sm text-text-tertiary">No people match these filters.</div>
            )}
          </div>
          <div className="flex items-center gap-3 px-1 pt-3 text-xs text-text-tertiary">
            <span>
              Showing {Math.min(shown, filtered.length)} of {filtered.length} people
            </span>
            {filtered.length > shown && (
              <Button size="sm" variant="outline" onClick={() => setShown((n) => n + ROW_CHUNK)}>
                Show more
              </Button>
            )}
          </div>
        </>
      )}

      {matrix && view === 'group' && (
        <div className="grid gap-3">
          <div className="w-[190px]">
            <Select
              aria-label="Group by"
              options={[
                { label: 'By department', value: 'department' },
                { label: 'By location', value: 'location' },
                { label: 'By role', value: 'role' },
              ]}
              value={axis}
              onChange={(e) => setAxis(e.target.value as GroupAxis)}
            />
          </div>
          {groups.length === 0 && (
            <div className="p-6 text-sm text-text-tertiary">No people match these filters.</div>
          )}
          {groups.map((g) => {
            const open = !collapsed.has(g.name);
            const heldOnly = g.held - g.expiring;
            const barTotal = Math.max(1, heldOnly + g.expiring + g.attention);
            return (
              <Card key={g.name} className="p-0">
                <button
                  onClick={() => toggleGroup(g.name)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <Icon
                    name="chevron-right"
                    size={15}
                    className={`text-text-tertiary transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <span className="font-ui text-sm font-semibold">{g.name}</span>
                  <span className="text-[12px] text-text-tertiary">
                    {g.memberCount} {g.memberCount === 1 ? 'person' : 'people'}
                  </span>
                  <span className="flex h-1.5 max-w-[220px] flex-1 overflow-hidden rounded-pill bg-surface-sunken">
                    <span className="h-full bg-success" style={{ width: `${(heldOnly / barTotal) * 100}%` }} />
                    <span className="h-full bg-warning" style={{ width: `${(g.expiring / barTotal) * 100}%` }} />
                    <span className="h-full bg-danger" style={{ width: `${(g.attention / barTotal) * 100}%` }} />
                  </span>
                  <span className={`text-[12.5px] font-semibold tabular-nums ${BAND_TEXT[complianceBand(g.compliancePct)]}`}>
                    {g.compliancePct}% compliant
                  </span>
                </button>
                {open && (
                  <div className="border-t border-border-subtle">
                    {g.members.map((m) => {
                      const badge = memberStatusBadge(m, windowDays, now);
                      const { chips, more } = memberIssueChips(m, competencies, windowDays, now);
                      return (
                        <button
                          key={m.membershipId}
                          onClick={() => navigate(`/app/profile/${m.membershipId}`)}
                          className="flex w-full items-center gap-3 border-b border-border-subtle px-4 py-2.5 text-left last:border-b-0 hover:bg-surface-sunken"
                        >
                          <Avatar name={m.name} size="sm" />
                          <span className="min-w-0 flex-none">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-[13px] font-semibold">{m.name}</span>
                              {m.noLocationPlacement && <UnplacedMarker />}
                            </span>
                            <span className="block truncate text-[11.5px] text-text-tertiary">{m.role}</span>
                          </span>
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                            {chips.map((chipItem) => (
                              <Badge key={chipItem.label} variant={chipItem.tone} size="sm">
                                {chipItem.label}
                              </Badge>
                            ))}
                            {more > 0 && (
                              <span className="text-[11.5px] text-text-tertiary">+{more} more</span>
                            )}
                          </span>
                          <Icon name="chevron-right" size={15} className="flex-none text-text-tertiary" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
