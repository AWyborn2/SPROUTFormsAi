---
title: "feat: Placement learning loop — capture auto-place outcomes and measure the hit-rate"
date: 2026-08-20
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
origin: geometry hit-rate investigation 2026-08-20 (findings brief, gap #5)
---

# feat: Placement learning loop — capture auto-place outcomes and measure the hit-rate

## Product Contract

### Summary

Give the geometry/placement engine the same evidence discipline the text-extraction
learning loop already has. Today the corrections loop deliberately excludes geometry
(`extraction-corrections.ts:19-22`, R3 of the 2026-08-17 plan: placement is layout,
not extraction-text quality) — a correct boundary for *that* signal, but it leaves
the ~2500-line heuristic placement engine with **zero usage signal**: reviewers fix
placement on every import, and nothing counts it, clusters it, or measures whether a
tuning change helped. This plan adds (a) shape-level capture of placement outcomes —
per-field proposal tier (auto-confirm / needs-review / no-match) and what the
reviewer then did with it (accepted as-is, adjusted and how: band moved, box moved
or resized, page retargeted; or rejected for a manual draw) — and (b) an
**auto-place hit-rate metric** per document (auto-confirmed vs needs-review vs
no-match, plus adjustment rate), surfaced next to the existing extraction insights.
Exactly like the text loop, the loop is closed by a person: evidence feeds
human-written PRs that change the engine's heuristics and constants, and the metric
says whether the change worked. Nothing tunes itself at runtime.

### Problem Frame

The placement engine (`apps/web/src/lib/pdf-geometry.ts` and the decision layer in
`apps/web/src/screens/import/inspector/geometry-actions.ts`) proposes geometry for
every unplaced field, tiers each proposal (`classifyProposalTier`,
geometry-actions.ts:1478-1483: `confidence === 1` → auto-confirm, `< 1` →
needs-review, `null` → no-match), and hands the reviewer a queue. The reviewer's
subsequent behaviour is the ground truth the engine never sees:

- **Accept as-is** — the proposal was right; the tier boundary and the derivation
  earned their confidence.
- **Adjust then accept** — right neighbourhood, wrong measurement: a column band
  dragged 6pt (`onBandEdge`), a box nudged or resized (`moveOverlayBox`), a whole
  section re-stamped onto another page (`retargetPageChanges` — the
  duplicated-checklist symptom gap #3 describes).
- **Reject and draw by hand** — the derivation was wrong enough that redrawing beat
  correcting.
- **No-match, then a manual draw** — the engine refused (its ~20 refusal points are
  a feature), but *how often* it refuses per document class is exactly the number a
  tuning round needs.

All of this happens in **one component with two mounts**:
`GeometryEditorScreen.tsx`, mounted standalone (route) and embedded by the
assessment builder's `PlacementStep.tsx` (one engine, two mounts — verified). The
outcomes live in that screen's local state (`proposalPreviews`, `edited`, `dirty`)
and evaporate when it unmounts. So heuristic changes to the engine — the checkbox
column fix (gap #4), sourcePages-aware page targeting (gap #3), any confidence
penalty retuning — are today judged by anecdote against the one Track Dozer paper
the profile was tuned on.

The predecessor loop (docs/plans/2026-08-17-001-feat-extraction-learning-loop-plan.md,
shipped through PR #250) already built the pattern this plan reuses wholesale:
best-effort capture that never blocks the user's real action; org-scoped storage of
the raw record; **content-free shape keys** as the cross-org privacy boundary
(`correction-shapes.ts` `shapeOf`); a pure DB-free aggregator
(`correction-insights.ts`); an org/admin read surface
(`ExtractionInsightsScreen.tsx`); and a **human-gated** promotion path — evidence
in, reviewed PR out, no runtime mutation ever. The same three constraints hold
here and point the same way: the engine's style is measured-not-inferred with
tested refusal codes (an auto-tuned constant is untested by definition); there is
no live regression corpus loop; and cross-org aggregation must never carry one
org's field text.

One deliberate difference from the text loop: the text loop's commit point is
*publish*, because an import draft is an uncommitted opinion. Placement's commit
point is **Save placement** — geometry reaches the version record at save
(`save.mutate(fields)` → `onSaved`), the embedded mount has no publish button at
all (the builder host publishes its own copy later), and an unsaved placement
session is exactly the abandoned draft the text loop refuses to learn from. Same
principle — "only a committed final answer is ground truth" — applied to this
surface's own commit gate.

### Requirements

- **R1.** A pure, testable **placement recorder** accumulates outcome events during
  a placement session: for each field the engine was asked about, the proposal
  tier and derivation method; whether a needs-review proposal was accepted as-is,
  adjusted first (and how), or rejected; adjustments made to already-applied
  proposals; page retargets; and manual draws on fields the engine refused or the
  reviewer rejected. It records; it never judges.
- **R2.** The derivation **method** is recorded per field, derived from the same
  dispatch `deriveProposal` uses (match-anchor / option-cells / table), so a
  hit-rate can be read per derivation family — the unit tuning PRs actually change.
- **R3.** Adjustments are recorded as **kind + coarse magnitude bucket** (e.g.
  band-moved ≤2pt / ≤4pt / >4pt; page retargeted by ±n pages bucketed), never as
  raw coordinates or field text. The buckets are the shape vocabulary.
- **R4.** Events are sent **only on a successful Save placement** — the surface's
  committed final answer — as a fire-and-forget POST after `save.mutate` succeeds.
  A session abandoned without saving sends nothing. Sending is best-effort and can
  never block, fail, or slow a save; each event is sent at most once (the recorder
  drains on send).
- **R5.** A new org-scoped **`placement_outcomes` table** stores one row per
  save: the event payload (jsonb) plus denormalised tallies (proposals attempted,
  auto-confirmed, accepted as-is, adjusted, rejected, no-match, manual draws,
  retargets) so the metric never opens the jsonb. Linked to `formId`/`versionId`
  as plain ids (same rationale as `extraction_corrections`: the record outlives
  the form) and carrying `documentType` when the host knows it.
- **R6.** Shape keys are **content-free** (`placementShapeOf`), mirroring
  `shapeOf`: built only from method, tier, adjustment kind, magnitude bucket, page
  delta bucket, and field-type class. Examples:
  `proposal:table:needs-review`, `adjusted:column-band-moved:>4pt`,
  `rejected:option-cells:manual-draw`, `retargeted-page:+2..4`,
  `no-match:option-cells`. No label text, no option text, no coordinates, no
  absolute page numbers.
- **R7.** The **auto-place hit-rate metric**: per `documentType` (and per
  derivation method), `autoConfirmed / proposalsAttempted`, alongside
  needs-review rate, no-match rate, and adjustment rate
  (`adjusted / placedViaProposal`), plus a per-week trend so a tuning PR's effect
  is visible on subsequent imports. Computed by a pure, DB-free aggregator over
  the denormalised tallies (rate math) and the jsonb (shape clusters), exactly
  like `aggregateCorrectionRows`.
- **R8.** The metric and the recurring shapes surface on the **existing insights
  screen** (`ExtractionInsightsScreen`), as a placement section beside the
  extraction candidates — one place where "is the import pipeline getting better"
  is answered. Endpoint admin-gated like `/pdf/corrections/candidates`.
- **R9.** Both mounts are covered identically: the standalone route and the
  builder's `PlacementStep` capture through the same recorder inside
  `GeometryEditorScreen`, with `documentType` threaded as an optional prop
  (`PlacementStep` passes `'assessment'`; standalone records null).
- **R10.** **Human-gated, no auto-tuning.** No code path reads stored outcomes
  into the engine. Promotion is a person changing `pdf-geometry.ts` /
  `geometry-actions.ts` heuristics or constants in a tested PR, judged before and
  after by R7's metric — the exact analogue of `LEARNED_EXAMPLES`.
- **R11.** Fully generic and cross-org safe: rows are org-scoped; any future
  cross-org view aggregates only shape keys and tallies (R6 is the boundary).
  The engine ships identical for every customer.

### Scope Boundaries

**In:** the pure recorder and its event model; the content-free
`placementShapeOf`; the `placement_outcomes` table and migration; the
`POST /pdf/placements` best-effort write and `GET /pdf/placements/insights`
read; recorder wiring into `GeometryEditorScreen` (both mounts) with
send-on-save; the `documentType` prop threading from `PlacementStep`; the
placement section on `ExtractionInsightsScreen`.

**Out (not this loop's shape):**

- **Runtime mutation of engine constants or heuristics of any kind** — no
  auto-tuned `SNAP_RANGE`, no learned confidence penalties, no per-org engine
  behaviour. Evidence feeds human PRs; the metric judges them (R10, mirroring
  the predecessor's R8).
- **Fixing the placement heuristics themselves** — gaps #3 (sourcePages-aware
  page targeting) and #4 (vector-derived checkbox columns) are their own rounds;
  this plan builds the instrument that will score them.
- Capturing placement events from any surface other than `GeometryEditorScreen`
  (e.g. the import review flow's own geometry panel in `import-session.ts`) —
  the geometry editor is where the auto-place engine runs and where the two
  mounts converge; other surfaces can adopt the same recorder later.
- Recording candidate/filler-side behaviour — this is a reviewer-time signal only.

#### Deferred to Follow-Up Work

- **Retention/pruning** of `placement_outcomes` — same posture as
  `extraction_captures`/`extraction_corrections`: a decision for when volume
  bites, deliberately not baked into capture.
- A **cross-org platform view** of placement shapes — R6/R11 make it safe to add;
  the org/admin view ships first, like the text loop did.
- **Correlating placement outcomes back to captures** — placement happens on
  version fields, possibly long after import and repeatedly; a best-effort
  `captureId` join (via the version's import provenance) is a later enrichment,
  not a keying requirement (see KTD2).
- Recorder coverage for future bulk placement actions (sweeps, exemplar-seeded
  proposals surfaced as their own tier) — the recorder API is the seam; new
  actions call it as they land.

### Acceptance Examples

Illustrations only — none seeded; all shape-level.

- **AE1 (hit-rate on a big paper).** A ~300-field assessment is auto-placed:
  180 fields tier auto-confirm, 60 needs-review (40 confirmed as-is, 15 adjusted
  then confirmed, 5 rejected and hand-drawn), 60 no-match. The reviewer saves.
  One `placement_outcomes` row lands with those tallies; the insights screen
  shows hit-rate 0.60, adjustment rate 15/235, no-match rate 0.20 for
  `assessment` — the baseline the next tuning PR is measured against.
- **AE2 (retarget cluster → gap #3 evidence).** On duplicated-checklist papers,
  reviewers repeatedly use Move section to re-stamp Parts 4 and 6 onto their own
  pages. The shape `retargeted-page:+2..4` clusters with a count. A human reads
  it as the quantified case for threading `sourcePages` into page targeting —
  and lands that as a normal engine PR.
- **AE3 (band-moved cluster → gap #4 evidence, then measured).** Table proposals
  keep needing their answer-column band dragged right:
  `adjusted:column-band-moved:>4pt` clusters under method `table`. After the
  vector-derived checkbox-column PR merges, the adjustment rate for `table`
  falls in the weekly trend — the honest form of "the tuning worked".
- **AE4 (no save, no signal).** A reviewer opens the geometry editor, auto-places,
  adjusts a few bands, then navigates away without saving. Nothing is sent —
  an uncommitted placement session is not ground truth.
- **AE5 (send never blocks save).** The placements POST fails (network, 503).
  The save has already succeeded and the toast already shown; the failure is
  logged and swallowed. Repeated saves in one session send each event once.
- **AE6 (content-free shapes).** Two different orgs' papers both produce
  `adjusted:column-band-moved:>4pt` on `table` proposals. The shapes are
  identical strings carrying no text from either paper; a future cross-org view
  could count them together without exposing what either document said.

---

## Planning Contract

### Key Technical Decisions

- **KTD1 — Accumulate client-side in the screen, emit on successful save.**
  The placement session lives entirely in `GeometryEditorScreen` local state
  across both its mounts, so the recorder lives beside that state (a `useRef` —
  events never drive render). Emission happens in `save.mutate`'s `onSuccess`,
  fire-and-forget, mirroring `sendImportCorrections`' contract (import-session.ts:1670-1690).
  **Why save, not publish:** save is this surface's commit gate — geometry
  reaches the version record at save, and the embedded mount has no publish
  button (the builder host publishes its own copy later, from `onSaved`'s
  hand-back). Emitting at publish would need host participation in both mounts
  and would still miss the standalone screen's embedded-host case. Emitting on
  draft-keystrokes would violate "only a committed final answer is ground truth".
  Multiple saves per session are fine: the recorder **drains** on each send, so
  every event is stored exactly once, and rows sum correctly.
- **KTD2 — A new `placement_outcomes` table, not an extension of
  `extraction_corrections`.** The lifecycles differ in every dimension that
  matters: placement happens on **version fields**, possibly repeatedly and long
  after import (the screen exists precisely so placement can be fixed without
  re-importing); the text loop keys on `captureId`, which a placement session
  frequently does not have (a form placed months after import, or built in the
  builder); and the denormalised counters mean different things (corrections per
  extracted field vs proposal outcomes per attempt). Extending the corrections
  table would overload `correctionCount`/`fieldCount` semantics and force every
  aggregation to branch on a row-kind discriminator. The new table **reuses the
  pattern**, not the rows: org-scoped, jsonb payload, denormalised tallies,
  plain-id `formId`/`versionId` provenance, best-effort write.
- **KTD3 — `placementShapeOf` in `@formai/shared` is the privacy boundary,
  exactly like `shapeOf`.** Keys are built only from: derivation method
  (match-anchor / option-cells / table — the three `deriveProposal` branches),
  tier, outcome, adjustment kind, magnitude bucket (≤2pt / ≤4pt / >4pt), page
  delta bucket (+1 / +2..4 / +5+ and negatives), and field-type class. Field
  ids appear in the org-scoped jsonb payload (same as the text loop's
  correction records) but never in a shape key. Magnitude buckets are chosen to
  be diagnostic (≤2pt ≈ cosmetic snap-distance, >4pt ≈ the derivation measured
  the wrong thing — DRAW_SNAP_RANGE is 4) without ever being reversible to a
  layout.
- **KTD4 — Metric definition.** Per `documentType` × derivation method:
  `proposalsAttempted` = fields whose **latest** derive produced any tier
  (re-runs of Scan/auto-place update a field's entry rather than double-count);
  `hitRate = autoConfirmed / proposalsAttempted`;
  `needsReviewRate`, `noMatchRate` likewise;
  `adjustmentRate = adjusted / (autoConfirmed + acceptedFromReview)` (adjusted
  counts a field once, whether the tweak came before or after accept).
  A weekly trend (ISO week off `createdAt`) makes before/after PR comparisons
  readable. Rates read the denormalised tallies; shape clusters open the jsonb —
  the same split `aggregateCorrectionRows` uses.
- **KTD5 — Surface: extend the existing insights screen, not a new one.**
  `ExtractionInsightsScreen` (route `extraction-insights`, admin-gated in
  `screens.ts`) gains a placement section: the per-type metric strip and the
  recurring placement shapes with suggestions (a `SUGGESTIONS`-style map naming
  the engine seam each shape points at, e.g. band-moved → column derivation,
  retargeted → page targeting). One screen answers "is import getting better";
  the nav label generalises to "Import insights" but the key/path stay stable.
- **KTD6 — `documentType` threading.** Forms carry no `documentType` in the DB;
  the extraction capture does, but the geometry editor doesn't load it. Rather
  than a speculative join, `GeometryEditorScreenProps` gains an optional
  `documentType`; `PlacementStep` passes `'assessment'` (the builder hard-codes
  that today, use-builder-draft.ts:673); the standalone mount records null and
  the aggregator buckets it as `unspecified` — the same posture as
  `extraction_corrections.documentType`.
- **KTD7 — Migration numbering:** cut the migration branch from **fresh
  `origin/main`** and let drizzle-kit assign the next number (this worktree sees
  0063 as latest; the number falls wherever main is when the branch cuts —
  the 0059 collision came from a stale local main).

Five phases, mirroring the predecessor: A is pure/shared, B storage, C API
write, D client emit, E metric + surface. Units are ordered so each lands
green on its own.

### Phase A — Event model and shapes (`@formai/shared`, pure)

**U1 — `PlacementOutcomes` types and the tally.**
- Goal: the wire/storage shape of one placement session's outcomes, and the pure
  fold from events to denormalised tallies.
- Requirements: R1, R2, R3, R5.
- Files: `packages/shared/src/placement-outcomes.ts` (new), exported from the
  shared barrel (`packages/shared/src/index.ts`);
  `packages/shared/src/placement-outcomes.test.ts` (new).
- Approach: a discriminated union `PlacementEvent` over the event kinds —
  `proposed` (fieldId, method: `'match-anchor' | 'option-cells' | 'table'`,
  tier: reuse the `ProposalTier` string union values), `accepted` (fieldId,
  via: `'auto' | 'confirm' | 'confirm-all'`), `adjusted` (fieldId, kind:
  `'column-band' | 'row-band' | 'box-moved' | 'box-resized'`, bucket:
  `'≤2pt' | '≤4pt' | '>4pt'`, phase: `'preview' | 'placed'`), `rejected`
  (fieldId), `manual-draw` (fieldId, fieldTypeClass), `retargeted` (fieldId,
  pageDeltaBucket). A `PlacementOutcomes` wrapper carries `documentType?`,
  `formId?`, `versionId?`, `context: 'standalone' | 'builder'`, `fieldCount`
  (fields on the version — the eligibility universe), and `events:
  PlacementEvent[]`. A pure `tallyPlacementOutcomes(events)` returns the R5
  counter block — `proposalsAttempted`, `autoConfirmed`, `acceptedAsIs`,
  `adjusted`, `rejected`, `noMatch`, `manualDraws`, `retargets` — computed
  **latest-tier-per-field** for the attempt counters (KTD4) and
  once-per-field for `adjusted`.
- Test scenarios: a field proposed twice (needs-review then, after a page-scoped
  Scan, auto-confirm) counts one attempt with the latest tier; adjusted-then-
  accepted counts in both `adjusted` and accepted; a rejected field that later
  gets a manual draw counts one rejection and one manual draw; empty events →
  all-zero tally.
- Verification: `pnpm typecheck`; shared package tests
  (`pnpm --filter @formai/shared test`).

**U2 — `placementShapeOf` (the privacy boundary).**
- Goal: the content-free cluster key for a placement event.
- Requirements: R6, R11.
- Files: `packages/shared/src/placement-shapes.ts` (new), barrel export,
  `packages/shared/src/placement-shapes.test.ts` (new).
- Approach: mirror `correction-shapes.ts` exactly — a `placementShapeOf(event):
  string` switch with an exhaustiveness guard, plus `tallyPlacementShapes` for
  callers. Keys per KTD3: `proposal:<method>:<tier>`,
  `accepted:<method>:<via>`, `adjusted:<kind>:<bucket>`,
  `rejected:<method>:manual-draw` when a manual draw followed a rejection
  (derived by the caller joining events; the shape function itself stays
  per-event: `rejected:<method>` and `manual-draw:<fieldTypeClass>` are the
  primitive keys), `retargeted-page:<deltaBucket>`, `no-match:<method>`.
  Module doc restates the boundary: the key names structure, never content.
- Test scenarios: two events differing only in fieldId share a shape; every
  event kind produces a stable documented key; no key ever contains a field id
  (regex guard test over a generated corpus of events).
- Verification: `pnpm typecheck`; `pnpm --filter @formai/shared test`.

### Phase B — Storage

**U3 — `placement_outcomes` table.**
- Goal: the org-scoped store, one row per save.
- Requirements: R5, R11.
- Files: `packages/db/src/schema/placement-outcomes.ts` (new),
  `packages/db/src/schema/index.ts` barrel export, drizzle-kit generated
  migration (**cut from fresh `origin/main`, KTD7**).
- Approach: columns — `id` uuid pk; `orgId` → organizations cascade;
  `formId`/`versionId` text nullable (plain ids, not FKs — same rationale and
  comment as `extraction_corrections.formId`); `documentType` text nullable;
  `context` text not null (`standalone`/`builder`); `outcomes` jsonb not null
  (the `PlacementOutcomes` record verbatim); denormalised integers
  `proposalsAttempted`, `autoConfirmed`, `acceptedAsIs`, `adjusted`,
  `rejected`, `noMatch`, `manualDraws`, `retargets`, `fieldCount`;
  `createdByUserId` → users set null; `createdAt` timestamptz. Index
  `(orgId, documentType)` (the metric slice) and `(orgId, createdAt)` (the
  weekly trend). Module doc explains the save-commit lifecycle and why rows
  are per-save, not per-session (KTD1: drain-on-send makes summing correct).
- Test scenarios: schema compiles; migration creates only this table and its
  indexes (inspect the generated SQL in review, per repo practice).
- Verification: `pnpm typecheck`; `pnpm --filter @formai/api test` (schema
  import paths); migration reviewed by eye.

### Phase C — The write endpoint

**U4 — `POST /pdf/placements`.**
- Goal: accept one session-slice of outcomes, validate at the boundary, write
  one row.
- Requirements: R4 (server half), R5, R11.
- Files: `apps/api/src/routes/pdf.ts` (new route beside `/corrections`),
  `apps/api/src/routes/pdf.test.ts` (or the corrections route's test file
  sibling — follow where the `/pdf/corrections` tests live).
- Approach: zod body mirroring the corrections route's posture — event `kind`
  validated against a runtime `PLACEMENT_EVENT_KINDS` array (add it to U1),
  per-event payload passthrough (the fine shape belongs to U1, not a second
  copy); top-level `formId?`, `versionId?`, `documentType?` (enum
  `DOCUMENT_TYPES`), `context`, `fieldCount`, `events`. `requireTenant`;
  tallies computed **server-side** via `tallyPlacementOutcomes` (never trust
  client counters — the jsonb and the counters must agree by construction).
  503 without db, 400 on malformed, 201 with the row id.
- Test scenarios: well-formed body writes a row whose denormalised counters
  match a hand-computed tally; malformed event kind → 400; row lands under the
  caller's org; missing optional ids stored null.
- Verification: `pnpm typecheck`; `pnpm --filter @formai/api test`.

### Phase D — Client capture and emit

**U5 — The pure recorder.**
- Goal: the session accumulator `GeometryEditorScreen` calls — pure, DOM-free,
  exhaustively testable.
- Requirements: R1, R2, R3.
- Files: `apps/web/src/screens/import/inspector/placement-recorder.ts` (new),
  `…/placement-recorder.test.ts` (new).
- Approach: `createPlacementRecorder()` returning an object with narrow
  methods: `proposed(fieldId, method, tier)` (upserts the field's latest tier —
  KTD4's re-run rule lives HERE, so the tally stays a dumb fold);
  `accepted(fieldId, via)`; `previewAdjusted(fieldId, kind, deltaPts)` and
  `placedAdjusted(fieldId, kind, deltaPts)` (bucket the magnitude internally —
  callers pass raw points, the recorder is the only place buckets are
  computed); `rejected(fieldId)`; `manualDraw(fieldId, fieldTypeClass)`
  (recorded only for fields with a prior `rejected` or `no-match` entry —
  a hand-draw on a never-proposed field is not engine feedback);
  `retargeted(fieldIds, pageDelta)`; and `drain(): PlacementEvent[]` (returns
  the events and clears the buffer — R4's send-once guarantee). Method
  derivation for a field reuses `deriveProposal`'s dispatch predicates
  (`isMatchAnchorField` / `isPerOptionField` / `repeating_group`) — export a
  small `derivationMethodOf(field)` from `geometry-actions.ts` so the recorder
  and the screen cannot disagree with the dispatcher.
- Test scenarios: upsert-on-re-propose; magnitude bucketing at the 2pt/4pt
  boundaries; manual draw ignored without a prior refusal/rejection; drain
  empties (second drain returns []); events round-trip through
  `tallyPlacementOutcomes` to the expected counters.
- Verification: `pnpm typecheck`; `pnpm --filter @formai/web test`.

**U6 — Wire the recorder into `GeometryEditorScreen`; send on save.**
- Goal: every placement action feeds the recorder; a successful save drains and
  posts, fire-and-forget; both mounts covered.
- Requirements: R1, R4, R9.
- Files: `apps/web/src/screens/import/GeometryEditorScreen.tsx`;
  `apps/web/src/screens/assessments/builder/steps/PlacementStep.tsx`
  (pass `documentType="assessment"`); `apps/web/src/lib/data/placement-outcomes.ts`
  (new — `sendPlacementOutcomes(payload): void`, the fire-and-forget POST
  mirroring `sendImportCorrections`, import-session.ts:1670-1690);
  `apps/web/src/screens/import/GeometryEditorScreen.test.tsx` (extend).
- Approach: hold the recorder in a `useRef`. Call sites (all existing
  functions, one recorder line each):
  `selectField` and `autoPlaceRemaining` → `proposed(...)` per derive, plus
  `accepted(id, 'auto')` on the auto-confirm branch;
  `confirmProposed` → `accepted(id, 'confirm')`; `confirmAllProposed` →
  `accepted(id, 'confirm-all')` per entry; `rejectProposed` → `rejected(id)`;
  `onBandEdge` / `moveOverlayBox` → `previewAdjusted`/`placedAdjusted` with the
  axis delta in points, kind chosen from the handle (band vs boundary vs whole
  box); `moveBoxesToPage` → `retargeted(fieldIds, page - currentPage)`;
  the draw handlers (`setOptionBox`, `setTableBox`, `setScalarBox`,
  `distributeOptions`, `setRowBox`) → `manualDraw(id, class)` (the recorder's
  own prior-refusal guard decides whether it counts). In the save button's
  `onSuccess`, build `PlacementOutcomes` from `drain()` + props
  (`documentType`, `formId`, `versionId`, `context: embedded ? 'builder' :
  'standalone'`, `fieldCount: fields.length`) and call
  `sendPlacementOutcomes` — **after** `setDirty(false)`/`onSaved`, never
  awaited, empty-events → no send. New optional `documentType` prop on
  `GeometryEditorScreenProps` with a doc comment (KTD6).
- Test scenarios (extending the existing jsdom suite, which already mocks
  `useSaveVersionFields` and stubs `PdfViewer`/derivations): auto-place then
  save → `sendPlacementOutcomes` (mocked) called once with a payload whose
  events include the stubbed field's `proposed` + `accepted:auto`; confirm and
  reject from the review queue produce their events; save with no recorded
  events does not call send; a failing send (mock rejects) does not break the
  save toast; a second save after more edits sends only the new events.
- Verification: `pnpm typecheck`; `pnpm --filter @formai/web test`.

### Phase E — Metric and surface

**U7 — Aggregator and `GET /pdf/placements/insights`.**
- Goal: the hit-rate read model.
- Requirements: R7, R8 (server half), R11.
- Files: `apps/api/src/pdf/placement-insights.ts` (new — pure, DB-free,
  mirroring `correction-insights.ts`), `…/placement-insights.test.ts` (new),
  `apps/api/src/routes/pdf.ts` (the GET route), route test.
- Approach: `aggregatePlacementRows(rows)` over
  `{documentType, context, createdAt, outcomes, proposalsAttempted, …tallies}`
  returns `{ metrics, shapes, trend }`: `metrics` per documentType (and per
  method, folded from the jsonb events) with the KTD4 rates; `shapes` —
  `placementShapeOf` clusters with counts, most frequent first; `trend` —
  ISO-week buckets of hit/adjustment rates. A `SUGGESTIONS`-style map
  (`placementSuggestionFor(shape)`) names the engine seam each recurring shape
  points at (band-moved → column derivation in `proposeTableSegments`;
  retargeted-page → page targeting / sourcePages threading; no-match on
  option-cells → marker-glyph matching) — a suggestion, never an instruction,
  same contract as `suggestionFor`. Route: `requireTenant` + admin/owner gate
  (same check as `/corrections/candidates`), 5000-row cap with the same
  comment, org-scoped query.
- Test scenarios: rate math over a fixture set (hand-checked hit/adjustment/
  no-match rates); per-method fold; weekly bucketing across a month of rows;
  non-admin → 403; shapes carry no field text.
- Verification: `pnpm typecheck`; `pnpm --filter @formai/api test`.

**U8 — The placement section on the insights screen.**
- Goal: surface R7 beside the extraction candidates.
- Requirements: R8.
- Files: `apps/web/src/lib/data/types.ts` (the `PlacementInsights` DTO),
  `apps/web/src/lib/data/store.ts` (`getPlacementInsights()`),
  `apps/web/src/lib/data/hooks.ts` (`usePlacementInsights`, keyed like
  `useCorrectionCandidates`),
  `apps/web/src/screens/enterprise/ExtractionInsightsScreen.tsx` (extend),
  `apps/web/src/lib/screens.ts` (label → "Import insights"; key and path
  unchanged), `…/ExtractionInsightsScreen.test.tsx` (extend).
- Approach: below the candidate-rules card, a "Placement" card: a metric strip
  per documentType (hit rate, adjustment rate, no-match rate, sessions counted)
  and a table of recurring placement shapes (`×count`, shape, suggested seam,
  document type) in the same visual grammar as the extraction card. Explanatory
  copy states the contract: nothing here changes the engine; a maintainer acts
  on a shape by changing the engine in a reviewed PR, and these numbers say
  whether it worked. Empty state mirrors the existing one.
- Test scenarios: renders metrics and shapes from a mocked hook; empty data →
  empty state; error → admin-only message (same pattern as the existing tests).
- Verification: `pnpm typecheck`; `pnpm --filter @formai/web test`.

### Testing strategy

- Phases A and the aggregator half of E are pure functions — exhaustive unit
  tests carry the bulk of the confidence, no browser, no DB, no API key,
  exactly like the text loop's `diffExtraction`/`shapeOf`/`aggregateCorrectionRows`
  suites.
- U5's recorder is the risky seam (session semantics: upsert-on-re-propose,
  drain-once, prior-refusal guard) and is deliberately pure so those rules are
  tested without React; U6's component test then only checks the wiring routes
  through it — the same split `GeometryEditorScreen.test.tsx` already documents
  for the batching fix ("the pure function is the regression coverage; the
  component test is the does-the-wiring-route-through-it check").
- Route tests follow the `/pdf/corrections` patterns (org scoping, 400/503,
  server-side tally recomputation).
- The whole loop is provable without a live model or a real PDF: proposals are
  stubbed in the component suite, and every downstream stage is deterministic.
  What only production traffic can prove is AE3's "the tuning PR moved the
  rate" — which is the point of building the instrument first.
- Gates per unit as listed; full sweep before PR: `pnpm typecheck`,
  `pnpm --filter @formai/web test`, `pnpm --filter @formai/api test`.

### Risks & mitigations

- **Recorder blind spots.** A placement action that forgets its recorder call
  degrades coverage silently (metrics undercount, never corrupt a form —
  telemetry is never load-bearing). Mitigation: `derivationMethodOf` and the
  recorder calls live beside the dispatch/actions they observe; a comment at
  `deriveProposal` and in `geometry-actions.ts` says new placement actions must
  feed the recorder; U6's component test enumerates the call sites.
- **Double-counting across saves or re-runs.** Drain-on-send (R4/KTD1) makes
  rows sum correctly; latest-tier-per-field upsert (KTD4, tested in U1/U5)
  stops a page-scoped Scan re-run inflating attempts.
- **Lost events on send failure.** Accepted: this is telemetry with the same
  best-effort contract as `captureExtraction` — a dropped row biases the metric
  slightly, it never breaks a save. The alternative (persisting a retry queue)
  buys precision the metric doesn't need at real complexity.
- **Cross-org leakage.** `placementShapeOf` is the only cross-org-safe key
  (KTD3/R6), tested content-free (U2); rows themselves stay org-scoped and the
  read endpoint admin-gated (U7).
- **Scope creep toward auto-tuning.** Explicitly out (R10); the suggestions map
  in U7 is the deliberate, minimal seam — it points a human at an engine file,
  it never touches one.
- **Migration numbering collision.** Cut U3's branch from fresh `origin/main`
  (KTD7 — the 0059 collision came from a stale local main).
