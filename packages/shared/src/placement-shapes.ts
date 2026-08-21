/**
 * Cluster key for one placement event — the CROSS-ORG PRIVACY BOUNDARY of the
 * placement learning loop, mirroring `correction-shapes.ts`'s `shapeOf`.
 *
 * A stored `PlacementOutcomes` record carries field ids, because it is
 * org-scoped and the org's own maintainer can be shown its own sessions. But
 * recurring placement failures are read ACROSS sessions (and, in a later
 * platform view, across orgs) — and a cluster key aggregated that widely must
 * never carry one org's content. `placementShapeOf` is what enforces that: the
 * key is built ONLY from the derivation method, the tier, the adjustment kind,
 * the coarse magnitude bucket, the page-delta bucket, and the field-type class.
 * No label text, no option text, no coordinates, no absolute page numbers, and
 * never a field id.
 *
 * The key names STRUCTURE, never content: two different orgs' papers that both
 * needed a table's answer-column band dragged more than 4pt produce the
 * identical string `adjusted:column-band:>4pt`, carrying nothing from either
 * paper. That recurrence is the whole signal.
 */
import type { PlacementEvent, PlacementEventKind } from './placement-outcomes.js';

/**
 * The content-free cluster key for a placement event. Stable and deterministic:
 * the same shape of outcome always yields the same string.
 *
 * A `no-match` proposal keys as its own family (`no-match:<method>`) rather
 * than `proposal:<method>:no-match` — how often each derivation family REFUSES
 * per document class is exactly the number a tuning round needs, and it reads
 * as its own cluster rather than a tier of successful proposals.
 */
export function placementShapeOf(event: PlacementEvent): string {
  switch (event.kind) {
    case 'proposed':
      return event.tier === 'no-match'
        ? `no-match:${event.method}`
        : `proposal:${event.method}:${event.tier}`;
    case 'accepted':
      return `accepted:${event.method}:${event.via}`;
    case 'adjusted':
      return `adjusted:${event.adjustment}:${event.bucket}`;
    case 'rejected':
      return `rejected:${event.method}`;
    case 'manual-draw':
      return `manual-draw:${event.fieldTypeClass}`;
    case 'retargeted':
      return `retargeted-page:${event.pageDeltaBucket}`;
    default: {
      // Exhaustiveness guard: a new PlacementEvent kind must add a case above.
      const never: never = event;
      return `unknown:${(never as { kind: PlacementEventKind }).kind}`;
    }
  }
}

/** Every distinct shape in a batch of events, with how often each occurs. */
export function tallyPlacementShapes(events: readonly PlacementEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const shape = placementShapeOf(event);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return counts;
}
