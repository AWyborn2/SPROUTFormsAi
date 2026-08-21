/**
 * The outcome events of one PLACEMENT session — what the geometry engine
 * proposed for each field, and what the reviewer then did about it — and the
 * pure fold from those events to the denormalised tallies the hit-rate metric
 * reads. The placement analogue of `extraction-corrections.ts`: it RECORDS; it
 * never judges which side was right, and it never clusters — clustering into
 * content-free shapes is `placement-shapes.ts`'s job.
 * See docs/plans/2026-08-20-003-feat-placement-learning-loop-plan.md.
 *
 * WHY A PURE MODULE IN SHARED. The events are accumulated client-side (the
 * placement session lives entirely in `GeometryEditorScreen`'s local state) and
 * stored server-side, and the server RECOMPUTES the tallies from the events it
 * was sent rather than trusting client counters — so the jsonb and the counters
 * agree by construction. One fold, used on both sides, is what makes that
 * recomputation trustworthy.
 *
 * WHAT AN EVENT CARRIES. Field ids and structural descriptors only — method,
 * tier, adjustment kind, coarse magnitude bucket, page-delta bucket, field-type
 * class. Never label text, never option text, never coordinates, never absolute
 * page numbers: the events are the org-scoped raw record, and the shape keys
 * derived from them (`placementShapeOf`) are the cross-org privacy boundary,
 * so nothing reversible to a layout is allowed in either.
 */
import type { DocumentType } from './extraction.js';

/**
 * The event kinds, one per way a placement session touches the engine.
 *
 * A runtime array (not just a type) so the store route can validate an incoming
 * event's `kind` against it without re-listing the set and drifting — the same
 * contract `CORRECTION_KINDS` carries for the text loop.
 */
export const PLACEMENT_EVENT_KINDS = [
  'proposed',
  'accepted',
  'adjusted',
  'rejected',
  'manual-draw',
  'retargeted',
] as const;
export type PlacementEventKind = (typeof PLACEMENT_EVENT_KINDS)[number];

/**
 * The three derivation families `deriveProposal` dispatches between — the unit
 * a tuning PR actually changes, so the hit-rate is read per method.
 */
export const DERIVATION_METHODS = ['match-anchor', 'option-cells', 'table'] as const;
export type DerivationMethod = (typeof DERIVATION_METHODS)[number];

/**
 * The proposal tiers, mirroring `classifyProposalTier`'s `ProposalTier` in
 * apps/web (geometry-actions.ts) value-for-value. Spelled out here rather than
 * imported because shared cannot depend on the web app; the recorder's own
 * typing is what keeps the two from drifting.
 */
export const PLACEMENT_PROPOSAL_TIERS = ['auto-confirm', 'needs-review', 'no-match'] as const;
export type PlacementProposalTier = (typeof PLACEMENT_PROPOSAL_TIERS)[number];

/** How an accepted proposal reached the record. */
export const ACCEPT_VIAS = ['auto', 'confirm', 'confirm-all'] as const;
export type AcceptVia = (typeof ACCEPT_VIAS)[number];

/** What the reviewer moved: a grid band's edge, or the whole box. */
export const ADJUSTMENT_KINDS = ['column-band', 'row-band', 'box-moved', 'box-resized'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/**
 * The coarse magnitude vocabulary for an adjustment — diagnostic without being
 * reversible to a layout. ≤2pt is a cosmetic snap-distance tweak; >4pt (past
 * `DRAW_SNAP_RANGE`) means the derivation measured the wrong thing.
 */
export const MAGNITUDE_BUCKETS = ['≤2pt', '≤4pt', '>4pt'] as const;
export type MagnitudeBucket = (typeof MAGNITUDE_BUCKETS)[number];

/** Bucket a raw point delta. Direction is deliberately discarded — see above. */
export function magnitudeBucketOf(deltaPts: number): MagnitudeBucket {
  const abs = Math.abs(deltaPts);
  if (abs <= 2) return '≤2pt';
  if (abs <= 4) return '≤4pt';
  return '>4pt';
}

/**
 * How far a page retarget moved a field's boxes, bucketed. Never an absolute
 * page number — "+2..4" says "a few pages later" (the duplicated-checklist
 * symptom) without saying which pages this org's paper prints its parts on.
 */
export const PAGE_DELTA_BUCKETS = ['+1', '+2..4', '+5+', '-1', '-2..4', '-5+'] as const;
export type PageDeltaBucket = (typeof PAGE_DELTA_BUCKETS)[number];

/** Bucket a page delta, or null for zero — a move to the same page is not a move. */
export function pageDeltaBucketOf(delta: number): PageDeltaBucket | null {
  if (delta === 0 || !Number.isFinite(delta)) return null;
  const sign = delta > 0 ? '+' : '-';
  const abs = Math.abs(delta);
  if (abs === 1) return `${sign}1` as PageDeltaBucket;
  if (abs <= 4) return `${sign}2..4` as PageDeltaBucket;
  return `${sign}5+` as PageDeltaBucket;
}

/**
 * The structural class of a hand-drawn placement — which KIND of box the
 * reviewer drew, never which field. Coarser than `FormFieldType` on purpose:
 * the engine's manual fallbacks come in these four shapes.
 */
export const PLACEMENT_FIELD_CLASSES = ['option', 'scalar', 'table', 'row'] as const;
export type PlacementFieldClass = (typeof PLACEMENT_FIELD_CLASSES)[number];

interface PlacementEventBase {
  /** The field the event concerns. Org-scoped payload only — never in a shape key. */
  fieldId: string;
}

/**
 * One recorded placement event. `method` rides on `accepted`/`rejected` as well
 * as `proposed` — attached by the recorder from the field's own proposal — so
 * `placementShapeOf` can key each event on its own without joining the stream.
 */
export type PlacementEvent =
  /** The engine was asked about a field; this is the tier its LATEST derive settled on. */
  | (PlacementEventBase & {
      kind: 'proposed';
      method: DerivationMethod;
      tier: PlacementProposalTier;
    })
  /** A proposal reached the record — applied on sight, or confirmed from the queue. */
  | (PlacementEventBase & { kind: 'accepted'; method: DerivationMethod; via: AcceptVia })
  /**
   * The reviewer moved something the engine placed — a parked proposal
   * (`phase: 'preview'`, fine-tuned before confirming) or an already-applied
   * one (`phase: 'placed'`).
   */
  | (PlacementEventBase & {
      kind: 'adjusted';
      adjustment: AdjustmentKind;
      bucket: MagnitudeBucket;
      phase: 'preview' | 'placed';
    })
  /** A needs-review proposal the reviewer declined — redrawing beat correcting. */
  | (PlacementEventBase & { kind: 'rejected'; method: DerivationMethod })
  /** A hand draw on a field the engine refused or the reviewer rejected. */
  | (PlacementEventBase & { kind: 'manual-draw'; fieldTypeClass: PlacementFieldClass })
  /** A field's boxes re-stamped onto another page, same position. */
  | (PlacementEventBase & { kind: 'retargeted'; pageDeltaBucket: PageDeltaBucket });

/**
 * One session-slice of placement outcomes, as sent at Save placement and stored
 * verbatim in `placement_outcomes.outcomes`. `formId`/`versionId` are plain
 * ids; `fieldCount` is the fields on the version — the eligibility universe the
 * attempt counters are read against.
 */
export interface PlacementOutcomes {
  documentType?: DocumentType;
  formId?: string;
  versionId?: string;
  /** Which mount recorded the session — the standalone route or the builder's step. */
  context: 'standalone' | 'builder';
  fieldCount: number;
  events: PlacementEvent[];
}

/** The denormalised counter block one `placement_outcomes` row carries. */
export interface PlacementTally {
  /** Fields whose latest derive produced any tier — including `no-match`. */
  proposalsAttempted: number;
  /** Fields whose latest tier was `auto-confirm` — the hit-rate numerator. */
  autoConfirmed: number;
  /**
   * Fields accepted from the review queue (`confirm`/`confirm-all`), whether or
   * not the reviewer fine-tuned the parked proposal first — "as is" means the
   * PROPOSAL was taken rather than rejected or redrawn; per-field tweaks are
   * tallied separately in `adjusted`, so an adjusted-then-accepted field counts
   * in both (KTD4: `adjustmentRate = adjusted / (autoConfirmed + acceptedAsIs)`).
   */
  acceptedAsIs: number;
  /** Fields the reviewer adjusted, once per field — before or after accept alike. */
  adjusted: number;
  /** Fields whose needs-review proposal was rejected. */
  rejected: number;
  /** Fields whose latest tier was `no-match` — the engine refused. */
  noMatch: number;
  /** Fields hand-drawn after a refusal or rejection, once per field. */
  manualDraws: number;
  /** Page retargets — one per field moved, per move. */
  retargets: number;
}

/**
 * Fold a slice's events into its denormalised tallies.
 *
 * A dumb fold on purpose: the recorder already upserts a field's `proposed`
 * entry on re-derive (KTD4's re-run rule lives THERE), but the fold tolerates a
 * stream that carries several by keeping the LATEST tier per field — so a
 * hand-assembled or replayed stream tallies the same way a recorded one does,
 * and a page-scoped Scan re-run can never inflate `proposalsAttempted`.
 * Per-field once-only counters (`adjusted`, `rejected`, `manualDraws`,
 * `acceptedAsIs`) count distinct fields, not events.
 */
export function tallyPlacementOutcomes(events: readonly PlacementEvent[]): PlacementTally {
  const latestTier = new Map<string, PlacementProposalTier>();
  const accepted = new Set<string>();
  const adjusted = new Set<string>();
  const rejected = new Set<string>();
  const drawn = new Set<string>();
  let retargets = 0;

  for (const event of events) {
    switch (event.kind) {
      case 'proposed':
        latestTier.set(event.fieldId, event.tier);
        break;
      case 'accepted':
        // An auto-accept is already counted through its `auto-confirm` tier;
        // only a review-queue accept lands in `acceptedAsIs`.
        if (event.via !== 'auto') accepted.add(event.fieldId);
        break;
      case 'adjusted':
        adjusted.add(event.fieldId);
        break;
      case 'rejected':
        rejected.add(event.fieldId);
        break;
      case 'manual-draw':
        drawn.add(event.fieldId);
        break;
      case 'retargeted':
        retargets += 1;
        break;
      default: {
        // Exhaustiveness guard: a new PlacementEvent kind must add a case above.
        const never: never = event;
        void never;
      }
    }
  }

  let autoConfirmed = 0;
  let noMatch = 0;
  for (const tier of latestTier.values()) {
    if (tier === 'auto-confirm') autoConfirmed += 1;
    else if (tier === 'no-match') noMatch += 1;
  }

  return {
    proposalsAttempted: latestTier.size,
    autoConfirmed,
    acceptedAsIs: accepted.size,
    adjusted: adjusted.size,
    rejected: rejected.size,
    noMatch,
    manualDraws: drawn.size,
    retargets,
  };
}
