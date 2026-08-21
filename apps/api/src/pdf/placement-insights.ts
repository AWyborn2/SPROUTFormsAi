/**
 * Aggregating stored placement outcomes into the placement loop's read models —
 * the auto-place hit-rate metric, the recurring shape clusters, and the weekly
 * trend that says whether a tuning PR moved the rate. Pure and DB-free so it is
 * testable without a database; the route hands it the rows it loaded. The
 * placement analogue of `correction-insights.ts`.
 *
 * The shape is the privacy boundary (see `placementShapeOf`): everything here
 * keys and counts by content-free shape, method and tier, so the same
 * aggregation is safe to widen to a cross-org platform view later without
 * exposing any one paper's layout.
 */
import { placementShapeOf, type PlacementEvent, type PlacementOutcomes } from '@formai/shared';

/** One stored outcome row, narrowed to the columns the aggregation reads. */
export interface PlacementOutcomeRow {
  documentType: string | null;
  createdAt: Date | string;
  /** The `PlacementOutcomes` jsonb. */
  outcomes: unknown;
  proposalsAttempted: number;
  autoConfirmed: number;
  acceptedAsIs: number;
  adjusted: number;
  rejected: number;
  noMatch: number;
  manualDraws: number;
  retargets: number;
}

/** The hit-rate for one derivation method within a document type. */
export interface PlacementMethodMetric {
  method: string;
  attempted: number;
  autoConfirmed: number;
  hitRate: number;
}

/** The KTD4 rates for one document type, summed across its sessions. */
export interface PlacementTypeMetric {
  documentType: string;
  /** Rows folded in — each is one saved placement slice. */
  sessions: number;
  proposalsAttempted: number;
  autoConfirmed: number;
  acceptedAsIs: number;
  adjusted: number;
  rejected: number;
  noMatch: number;
  manualDraws: number;
  retargets: number;
  /** `autoConfirmed / proposalsAttempted`. */
  hitRate: number;
  /** Attempts that tiered needs-review, over attempts. */
  needsReviewRate: number;
  /** `noMatch / proposalsAttempted`. */
  noMatchRate: number;
  /** `adjusted / (autoConfirmed + acceptedAsIs)` — over fields placed via a proposal. */
  adjustmentRate: number;
  /** Per derivation family, folded from the jsonb events — the unit tuning PRs change. */
  byMethod: PlacementMethodMetric[];
}

/** A recurring placement shape, with how often it was seen. */
export interface PlacementShapeCluster {
  documentType: string;
  shape: string;
  count: number;
}

/** One ISO week's hit and adjustment rates — the before/after-PR comparison. */
export interface PlacementTrendPoint {
  /** ISO week, e.g. `2026-W34`. */
  week: string;
  sessions: number;
  proposalsAttempted: number;
  autoConfirmed: number;
  hitRate: number;
  adjusted: number;
  adjustmentRate: number;
}

/** A ratio that reads as zero rather than NaN when nothing has been counted yet. */
function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * The ISO-8601 week a timestamp falls in, as `YYYY-Www`. ISO weeks start on
 * Monday and belong to the year holding their Thursday, so the first days of
 * January can belong to the previous year's last week — the standard rule,
 * implemented the standard way (shift to the week's Thursday, count weeks from
 * that year's January 1st).
 */
export function isoWeekOf(at: Date | string): string {
  const d = new Date(at);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Sunday counts as 7 so Monday leads the week
  date.setUTCDate(date.getUTCDate() + 4 - day); // this week's Thursday
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Fold outcome rows into per-type metrics, per-shape clusters and the weekly
 * trend in one pass. The rates read the denormalised tallies (no jsonb
 * needed); the shape clusters and the per-method fold open each row's payload
 * — the same split `aggregateCorrectionRows` uses.
 */
export function aggregatePlacementRows(rows: readonly PlacementOutcomeRow[]): {
  metrics: PlacementTypeMetric[];
  shapes: PlacementShapeCluster[];
  trend: PlacementTrendPoint[];
} {
  type Counters = Omit<
    PlacementTypeMetric,
    'documentType' | 'hitRate' | 'needsReviewRate' | 'noMatchRate' | 'adjustmentRate' | 'byMethod'
  >;
  const metricByType = new Map<string, Counters & { byMethod: Map<string, { attempted: number; autoConfirmed: number }> }>();
  const shapeByKey = new Map<string, PlacementShapeCluster>();
  const weekByKey = new Map<string, PlacementTrendPoint>();
  /** Per week, fields placed via a proposal — the adjustment rate's denominator. */
  const placedByWeek = new Map<string, number>();

  for (const row of rows) {
    const documentType = row.documentType ?? 'unspecified';

    const metric = metricByType.get(documentType) ?? {
      sessions: 0,
      proposalsAttempted: 0,
      autoConfirmed: 0,
      acceptedAsIs: 0,
      adjusted: 0,
      rejected: 0,
      noMatch: 0,
      manualDraws: 0,
      retargets: 0,
      byMethod: new Map<string, { attempted: number; autoConfirmed: number }>(),
    };
    metric.sessions += 1;
    metric.proposalsAttempted += row.proposalsAttempted;
    metric.autoConfirmed += row.autoConfirmed;
    metric.acceptedAsIs += row.acceptedAsIs;
    metric.adjusted += row.adjusted;
    metric.rejected += row.rejected;
    metric.noMatch += row.noMatch;
    metric.manualDraws += row.manualDraws;
    metric.retargets += row.retargets;
    metricByType.set(documentType, metric);

    const outcomes = row.outcomes as PlacementOutcomes | null;
    for (const event of outcomes?.events ?? []) {
      const shape = placementShapeOf(event as PlacementEvent);
      const key = `${documentType}::${shape}`;
      const entry = shapeByKey.get(key) ?? { documentType, shape, count: 0 };
      entry.count += 1;
      shapeByKey.set(key, entry);

      // The per-method fold. Each row's recorder upserted a field's proposed
      // entry on re-derive, so within one row the proposed events are already
      // one-per-field at its latest tier — counting them directly is the same
      // latest-tier-per-field rule the tallies were computed under.
      if (event.kind === 'proposed') {
        const m = metric.byMethod.get(event.method) ?? { attempted: 0, autoConfirmed: 0 };
        m.attempted += 1;
        if (event.tier === 'auto-confirm') m.autoConfirmed += 1;
        metric.byMethod.set(event.method, m);
      }
    }

    const week = isoWeekOf(row.createdAt);
    const point = weekByKey.get(week) ?? {
      week,
      sessions: 0,
      proposalsAttempted: 0,
      autoConfirmed: 0,
      hitRate: 0,
      adjusted: 0,
      adjustmentRate: 0,
    };
    point.sessions += 1;
    point.proposalsAttempted += row.proposalsAttempted;
    point.autoConfirmed += row.autoConfirmed;
    point.adjusted += row.adjusted;
    weekByKey.set(week, point);
    placedByWeek.set(week, (placedByWeek.get(week) ?? 0) + row.autoConfirmed + row.acceptedAsIs);
  }

  // Rates are finalised after the fold, so partial sums never leak out.
  const trend = [...weekByKey.values()]
    .map((p) => ({
      ...p,
      hitRate: rate(p.autoConfirmed, p.proposalsAttempted),
      adjustmentRate: rate(p.adjusted, placedByWeek.get(p.week) ?? 0),
    }))
    .sort((a, b) => a.week.localeCompare(b.week));

  const metrics = [...metricByType.entries()]
    .map(([documentType, m]) => ({
      documentType,
      sessions: m.sessions,
      proposalsAttempted: m.proposalsAttempted,
      autoConfirmed: m.autoConfirmed,
      acceptedAsIs: m.acceptedAsIs,
      adjusted: m.adjusted,
      rejected: m.rejected,
      noMatch: m.noMatch,
      manualDraws: m.manualDraws,
      retargets: m.retargets,
      hitRate: rate(m.autoConfirmed, m.proposalsAttempted),
      needsReviewRate: rate(
        m.proposalsAttempted - m.autoConfirmed - m.noMatch,
        m.proposalsAttempted,
      ),
      noMatchRate: rate(m.noMatch, m.proposalsAttempted),
      adjustmentRate: rate(m.adjusted, m.autoConfirmed + m.acceptedAsIs),
      byMethod: [...m.byMethod.entries()]
        .map(([method, v]) => ({
          method,
          attempted: v.attempted,
          autoConfirmed: v.autoConfirmed,
          hitRate: rate(v.autoConfirmed, v.attempted),
        }))
        .sort((a, b) => b.attempted - a.attempted),
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const shapes = [...shapeByKey.values()].sort((a, b) => b.count - a.count);
  return { metrics, shapes, trend };
}

/**
 * A human-readable pointer from a recurring shape to the ENGINE SEAM it points
 * at — the bridge from evidence to a change a person can make. Deliberately a
 * SUGGESTION, not an instruction: promotion is always a person changing
 * `pdf-geometry.ts` / `geometry-actions.ts` heuristics or constants in a
 * reviewed PR, judged before and after by the hit-rate — never this string,
 * and never any runtime mutation.
 *
 * Keyed by shape PREFIX, because the magnitude and page-delta buckets vary
 * within one failure mode. These name engine functions and structural shapes
 * only — no customer content — so the map ships identical for everyone.
 */
const SUGGESTIONS: [prefix: string, suggestion: string][] = [
  [
    'adjusted:column-band',
    'Answer-column bands keep needing a drag — look at the column derivation in proposeTableSegments (vector-derived checkbox columns are the known gap).',
  ],
  [
    'adjusted:row-band',
    'Row bands keep needing a drag — look at row detection (toRows / rowBands pitch) in proposeTableSegments.',
  ],
  [
    'retargeted-page',
    'Boxes land on the wrong page and get re-stamped — look at page targeting: threading sourcePages into the across-pages derivations is the known gap.',
  ],
  [
    'no-match:option-cells',
    'Option-cell derivation refuses often here — look at marker-glyph matching in proposeFieldOptionCells / proposeInlineOptionCells.',
  ],
  [
    'no-match:table',
    'Table derivation refuses often here — look at table identity selection (selectByRowCount / selectByOrdinal) and header detection.',
  ],
  [
    'no-match:match-anchor',
    'Matching-anchor derivation refuses often here — look at entry anchoring in proposeMatchAnchorCells.',
  ],
  [
    'rejected:',
    'Reviewers reject these proposals outright — redrawing beat correcting, so the derivation is measuring the wrong thing for this shape of page.',
  ],
];

/** The engine-seam suggestion for a shape, or a generic prompt to review it. */
export function placementSuggestionFor(shape: string): string {
  for (const [prefix, suggestion] of SUGGESTIONS) {
    if (shape.startsWith(prefix)) return suggestion;
  }
  return 'A recurring placement outcome — review whether an engine heuristic or constant (changed in a reviewed PR) would improve it.';
}
