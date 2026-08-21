import type {
  TrainingSummaryGapCompetency,
  TrainingSummaryGroup,
  TrainingSummaryScope,
  TrainingSummaryTrendPoint,
  TrainingSummaryWeek,
} from '../../lib/data/types.js';

/**
 * The training summary's derivation and chart geometry (U6), kept apart from
 * the screen so they test without rendering — the `training-matrix-view.ts`
 * pattern. The server serves COUNTS only; every percentage, path, and bar
 * width is computed here, and nothing here re-derives domain semantics the
 * payload already settled (who is compliant, what counts as a gap).
 */

/** The donut's fixed geometry — r=52 inside a 120×120 viewBox with stroke room. */
export const DONUT_RADIUS = 52;
export const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

/**
 * A percentage from counts that can BOTH be zero. 0/0 reads as 0% — a scope
 * with nobody in it has nobody compliant, and NaN must never reach a
 * stroke-dasharray or a width style.
 */
export function compliancePct(compliantCount: number, memberCount: number): number {
  if (memberCount <= 0) return 0;
  return Math.round((compliantCount / memberCount) * 100);
}

/** `stroke-dasharray` for the donut's filled arc: `<filled> <circumference>`. */
export function donutDash(pct: number): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = (clamped / 100) * DONUT_CIRCUMFERENCE;
  return `${filled.toFixed(2)} ${DONUT_CIRCUMFERENCE.toFixed(2)}`;
}

export type TrendGeometry =
  | { empty: true }
  | {
      empty: false;
      /** SVG path for the compliance line; '' when only one snapshot exists. */
      line: string;
      /** Closed path under the line for the area fill; '' for a single point. */
      area: string;
      /** The most recent snapshot's position — the single-point dot lives here too. */
      dot: { x: number; y: number };
      /** Compliance % at the most recent snapshot. */
      latestPct: number;
    };

/**
 * The compliance-trend chart from daily snapshots. One polyline through the
 * points that exist — x positioned by capture DATE, not index, so a gap in
 * the snapshot record stretches rather than lies. `empty: true` when there
 * are no points (the feature accrues history from its ship date); a single
 * point yields a dot and no paths, because a line needs two ends.
 */
export function trendGeometry(
  points: readonly TrainingSummaryTrendPoint[],
  width: number,
  height: number,
): TrendGeometry {
  if (points.length === 0) return { empty: true };

  const pctOf = (p: TrainingSummaryTrendPoint) => compliancePct(p.compliantCount, p.memberCount);
  const yOf = (p: TrainingSummaryTrendPoint) =>
    Number((height - (pctOf(p) / 100) * height).toFixed(2));

  const last = points[points.length - 1]!;
  if (points.length === 1) {
    // The one snapshot sits at the "today" edge, where the line would end.
    return { empty: false, line: '', area: '', dot: { x: width, y: yOf(last) }, latestPct: pctOf(last) };
  }

  const t0 = new Date(points[0]!.capturedOn).getTime();
  const t1 = new Date(last.capturedOn).getTime();
  const span = Math.max(1, t1 - t0);
  const xOf = (p: TrainingSummaryTrendPoint) =>
    Number((((new Date(p.capturedOn).getTime() - t0) / span) * width).toFixed(2));

  const coords = points.map((p) => ({ x: xOf(p), y: yOf(p) }));
  const line = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x} ${c.y}`)
    .join(' ');
  const area = `${line} L${coords[coords.length - 1]!.x} ${height} L${coords[0]!.x} ${height} Z`;
  return {
    empty: false,
    line,
    area,
    dot: coords[coords.length - 1]!,
    latestPct: pctOf(last),
  };
}

/** A zero week still draws a sliver — an invisible bar reads as missing data. */
export const MIN_BAR_PCT = 4;

export interface WeeklyBar {
  weekStart: string;
  label: string;
  count: number;
  /** Height as % of the tallest week, floored at MIN_BAR_PCT. */
  heightPct: number;
  current: boolean;
}

/**
 * The throughput columns: heights normalised to the busiest week, labelled
 * W1..W7 in order with the current (week-to-date) column labelled "now".
 */
export function weeklyBars(weeks: readonly TrainingSummaryWeek[]): WeeklyBar[] {
  const max = Math.max(0, ...weeks.map((w) => w.count));
  return weeks.map((w, i) => ({
    weekStart: w.weekStart,
    label: w.currentWeek ? 'now' : `W${i + 1}`,
    count: w.count,
    heightPct: max === 0 ? MIN_BAR_PCT : Math.max(MIN_BAR_PCT, Math.round((w.count / max) * 100)),
    current: w.currentWeek === true,
  }));
}

export interface DeltaChip {
  text: string;
  tone: 'success' | 'danger';
}

/**
 * The sign-offs card's week-over-week chip. Comparing a week-to-date against
 * a full prior week, so "no change yet" (0) shows nothing rather than a
 * misleading arrow. More sign-offs is the good direction.
 */
export function signOffDeltaChip(currentWeek: number, priorFullWeek: number): DeltaChip | null {
  const delta = currentWeek - priorFullWeek;
  if (delta === 0) return null;
  // Week-to-date zero against a real prior week is Monday morning, not a
  // collapse — a full-red "▼ N vs last wk" minutes into the week is exactly
  // the misleading arrow the zero rule above exists to prevent.
  if (currentWeek === 0 && priorFullWeek > 0) return null;
  return delta > 0
    ? { text: `▲ ${delta} vs last wk`, tone: 'success' }
    : { text: `▼ ${-delta} vs last wk`, tone: 'danger' };
}

/**
 * The open-gaps card's 30-day movement chip. FEWER gaps is the good
 * direction, so a negative delta wears success. Null (no snapshot that old)
 * and zero both show nothing.
 */
export function gapDeltaChip(gapDelta: number | null): DeltaChip | null {
  if (gapDelta === null || gapDelta === 0) return null;
  return gapDelta < 0
    ? { text: `▼ ${-gapDelta} vs 30d ago`, tone: 'success' }
    : { text: `▲ ${gapDelta} vs 30d ago`, tone: 'danger' };
}

export interface GapBar {
  competencyId: string;
  name: string;
  count: number;
  /** Width as % of the biggest gap count. */
  widthPct: number;
}

/**
 * The gaps-by-competency bars: top 6 by count desc, ties stable by name so
 * the chart never reshuffles between renders, widths normalised to the
 * largest count. Sorted defensively even though the API serves top-6 desc.
 */
export function topGapsBars(byCompetency: readonly TrainingSummaryGapCompetency[]): GapBar[] {
  const sorted = [...byCompetency].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
  const top = sorted.slice(0, 6);
  const max = Math.max(0, ...top.map((g) => g.count));
  return top.map((g) => ({
    competencyId: g.competencyId,
    name: g.name,
    count: g.count,
    widthPct: max === 0 ? 0 : Math.max(MIN_BAR_PCT, Math.round((g.count / max) * 100)),
  }));
}

export type GroupBand = 'success' | 'warning' | 'danger';

/** ≥90 green, ≥85 amber, else red — the prototype's summary bands. */
export function groupBand(pct: number): GroupBand {
  if (pct >= 90) return 'success';
  if (pct >= 85) return 'warning';
  return 'danger';
}

export interface GroupBar {
  id: string;
  name: string;
  memberCount: number;
  pct: number;
  band: GroupBand;
}

/**
 * The compliance-by-group bars: per-group % (0/0 → 0, same rule as the
 * headline) with its colour band, sorted % desc, ties stable by name.
 */
export function groupBars(groups: readonly TrainingSummaryGroup[]): GroupBar[] {
  return groups
    .map((g) => {
      const pct = compliancePct(g.compliantCount, g.memberCount);
      return { id: g.id, name: g.name, memberCount: g.memberCount, pct, band: groupBand(pct) };
    })
    .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
}

/** The subtitle's scope phrase — names only, never ids; org reads as org-wide. */
export function scopeLabel(scope: TrainingSummaryScope): string {
  return scope.type === 'org' ? 'Org-wide' : scope.name;
}
