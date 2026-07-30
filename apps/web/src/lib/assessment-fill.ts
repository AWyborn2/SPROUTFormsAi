import type { FormField, SubmissionValue } from '@formai/shared';

/**
 * The bits of an attempt that decide which of its fields apply.
 *
 * Narrower than the full view on purpose: this is the whole input, so a test
 * can state a case in two lines.
 */
export interface StreamSeed {
  /** The case's declared stream, e.g. "Mining". Null when never recorded. */
  locationStream: string | null;
  /** The manifest question that stream answers. Null when the tool has none. */
  locationStreamFieldId: string | null;
  /**
   * The stream question itself, for condition lookup. Usually lives OUTSIDE the
   * part being filled — on the cover checklist — so it has to travel separately
   * from the part's own fields.
   */
  streamField: FormField | null;
}

export interface PartVisibility {
  /** Answers the visibility rules are evaluated against. */
  answers: Record<string, SubmissionValue>;
  /** Extra condition sources, looked up but never rendered. */
  sources: FormField[];
}

/**
 * Resolve how a part's fields should be gated by the case's location stream.
 *
 * The stream is folded in as an ANSWER to the manifest's stream question rather
 * than applied as a filter over fields. That is the same move the evidence
 * exporter makes, and it matters: one mechanism decides which sections apply,
 * so what a candidate is shown and what the exported document renders cannot
 * drift apart.
 *
 * Answer and source are returned TOGETHER, from one decision, because supplying
 * one without the other inverts the outcome:
 *
 *  - source but no answer → the condition is fully determined and FAILS, so
 *    every location section hides and the candidate is silently shown a
 *    shortened assessment;
 *  - answer but no source → the condition dangles and falls open, so every
 *    location section renders.
 *
 * The second is the safe direction, and it is what this returns whenever the
 * stream is not fully known. Showing too much makes for a longer assessment;
 * hiding content nobody chose to hide would drop questions the candidate is
 * meant to answer, and neither they nor the assessor would see it happen.
 *
 * The stream is seeded LAST so the case wins. If a saved draft carries a
 * different answer to the stream question, the case record is what the
 * candidate was actually enrolled against.
 */
export function partVisibility(
  values: Record<string, SubmissionValue>,
  seed: StreamSeed,
): PartVisibility {
  const { locationStream, locationStreamFieldId, streamField } = seed;
  if (!locationStream || !locationStreamFieldId) return { answers: values, sources: [] };

  return {
    answers: { ...values, [locationStreamFieldId]: locationStream },
    // Only offered when it is the question we just answered. A source for some
    // other field would gate on an answer nobody supplied.
    sources: streamField && streamField.id === locationStreamFieldId ? [streamField] : [],
  };
}
