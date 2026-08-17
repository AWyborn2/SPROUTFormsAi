/**
 * Aggregating stored correction diffs into the learning loop's read models — the
 * correction-rate metric, the recurring shape clusters, and the human-facing
 * candidate rules. Pure and DB-free so it is testable without a database; the
 * routes hand it the rows they loaded.
 *
 * The shape is the privacy boundary (see `shapeOf`): everything here keys and
 * counts by content-free shape, so the same aggregation is safe to widen to a
 * cross-org platform view later without exposing any one paper's text.
 */
import { shapeOf, type ExtractionCorrections } from '@formai/shared';

/** One stored correction row, narrowed to the columns the aggregation reads. */
export interface CorrectionRow {
  documentType: string | null;
  correctionCount: number;
  fieldCount: number;
  /** The `ExtractionCorrections` jsonb. */
  corrections: unknown;
  captureId: string | null;
}

/** Corrections per extracted field, for one document type. */
export interface TypeMetric {
  documentType: string;
  corrections: number;
  fields: number;
  rate: number;
}

/** A recurring correction shape, with a few example captures from this org. */
export interface ShapeCluster {
  documentType: string;
  shape: string;
  count: number;
  sampleCaptureIds: string[];
}

/** At most this many example captures per shape — enough to spot-check, no more. */
const MAX_SAMPLES = 5;

/**
 * Fold correction rows into per-type rates and per-shape clusters in one pass.
 * The rate reads the denormalised counts (no jsonb needed); the clusters open
 * each row's payload and key every correction through `shapeOf`.
 */
export function aggregateCorrectionRows(rows: readonly CorrectionRow[]): {
  metrics: TypeMetric[];
  shapes: ShapeCluster[];
} {
  const metricByType = new Map<string, { corrections: number; fields: number }>();
  const shapeByKey = new Map<string, ShapeCluster>();

  for (const row of rows) {
    const documentType = row.documentType ?? 'unspecified';
    const metric = metricByType.get(documentType) ?? { corrections: 0, fields: 0 };
    metric.corrections += row.correctionCount;
    metric.fields += row.fieldCount;
    metricByType.set(documentType, metric);

    const diff = row.corrections as ExtractionCorrections | null;
    for (const correction of diff?.corrections ?? []) {
      const shape = shapeOf(correction);
      const key = `${documentType}::${shape}`;
      const entry = shapeByKey.get(key) ?? { documentType, shape, count: 0, sampleCaptureIds: [] };
      entry.count += 1;
      if (
        row.captureId &&
        entry.sampleCaptureIds.length < MAX_SAMPLES &&
        !entry.sampleCaptureIds.includes(row.captureId)
      ) {
        entry.sampleCaptureIds.push(row.captureId);
      }
      shapeByKey.set(key, entry);
    }
  }

  const metrics = [...metricByType.entries()]
    .map(([documentType, m]) => ({
      documentType,
      corrections: m.corrections,
      fields: m.fields,
      rate: m.fields > 0 ? m.corrections / m.fields : 0,
    }))
    .sort((a, b) => b.rate - a.rate);
  const shapes = [...shapeByKey.values()].sort((a, b) => b.count - a.count);
  return { metrics, shapes };
}

/**
 * A human-readable pointer from a recurring shape to the rule that would prevent
 * it — the bridge from evidence to a candidate a person can act on. Deliberately
 * a SUGGESTION, not an instruction: promotion is always a person writing a
 * general example in a reviewed PR (`LEARNED_EXAMPLES`), never this string.
 *
 * Keyed by exact shape where a known failure mode maps to a named rule; anything
 * else gets the generic prompt to look. These reference RULE NUMBERS and printed
 * shapes only — no customer content — so the map ships identical for everyone.
 */
const SUGGESTIONS: Record<string, string> = {
  'retype:radio→textarea':
    'Open questions read as multiple-choice. Reinforce rule 18 (a question with no printed choices is one free-text field).',
  'options-edited:cleared':
    'Options invented for a question that printed none — often paired with a radio→textarea retype. See rule 18.',
  'deleted:orphan-option':
    'Bare lettered choices emitted as their own fields at a page-batch boundary. See rule 19.',
  'selection-type:multiple→single':
    'Single-answer questions marked as multiple. See rule 1 (default single unless the stem says otherwise).',
  'selection-type:single→multiple':
    'Multi-answer questions marked as single. Check rule 1 recognises the "(more than one answer)" phrasings.',
};

/** The rule suggestion for a shape, or a generic prompt to review it. */
export function suggestionFor(shape: string): string {
  return (
    SUGGESTIONS[shape] ??
    'A recurring correction — review whether a general profile rule (or a promoted LEARNED_EXAMPLE) would prevent it.'
  );
}

/** A recurring shape surfaced as an actionable candidate rule. */
export interface CandidateRule extends ShapeCluster {
  suggestion: string;
}

/**
 * The candidate rules from a set of shape clusters: those recurring at least
 * `minCount` times, each carried with its rule suggestion, most frequent first.
 * A shape seen once or twice is noise, not yet a pattern worth a rule.
 */
export function candidateRules(shapes: readonly ShapeCluster[], minCount: number): CandidateRule[] {
  return shapes
    .filter((s) => s.count >= minCount)
    .map((s) => ({ ...s, suggestion: suggestionFor(s.shape) }));
}
