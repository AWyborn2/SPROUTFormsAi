---
title: "feat: Rect-derived checkbox columns — place a checklist's answer column where the printed squares are"
date: 2026-08-20
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
origin: geometry hit-rate investigation, gap #4 (findings brief 2026-08-20)
---

# feat: Rect-derived checkbox columns — place a checklist's answer column where the printed squares are

## Product Contract

### Summary

Teach the no-hands table derivation (`proposeTableSegments`) to use the vector
evidence the viewer already extracts — the closed printed rectangles pdf.js
yields for every checkbox square — so a checklist table's answer column lands
**on the printed squares** instead of "wherever the longest label happened to
end". `proposeRectGrid` already proves the technique: one band per square, at
the square's own extent, measured not inferred — but only inside a
reviewer-drawn box. This plan brings that measured quality to the automatic
path, in two forms: (1) **refinement** — a text-derived grid whose option
columns are corroborated by printed squares snaps its bands to the squares'
measured extents; and (2) **rect-anchored proposals** — a headerless checklist
("Observation/Practical Demonstration ☐" — no header glyphs, no anchors, so
today no proposal at all) gets an automatic grid derived from the square column
itself, paired with the label rows beside it. Where no rects exist, behavior is
byte-identical to today, and the reviewer-facing surface says which kind of
evidence placed the columns.

### Problem Frame

All placement geometry comes from the deterministic browser-side engine; the
LLM produces none. `proposeTableSegments`
(`apps/web/src/lib/pdf-geometry.ts:623`) finds columns by reading **header
glyphs** and rows by reading **label baselines**. That works on the dozer
family — tick / `/ ×` / `N/A` are printed text at exact coordinates — but a
checkbox column has no header and no text of its own. The module's own comment
(pdf-geometry.ts:793-805) admits the consequence: the derivation "finds the
labels, places a band where the words stop, and produces a grid whose answer
column is wherever the longest label happened to end". On the Mine Site SME
cover — five methods, five printed 9pt squares — there is no way to know
whether a mark will land in a printed square or beside it.

The measured answer already exists twice over:

- `extractRuleLines` (`apps/web/src/screens/import/PdfViewer.tsx:135-195`)
  walks `getOperatorList` with CTM tracking and returns, besides the 18pt-floor
  rule lines, **every closed axis-aligned rectangle on the page** — recognised
  by closure, not length, exactly so 8–10pt checkbox squares survive
  (`rectFromSubpath`, geometry-actions.ts:482). These travel on every
  `TextPage` as `rects` (PdfViewer.tsx:909-910), page-wide, already in the
  hands of the derivation dispatch (`deriveAcrossPages` receives `TextPage[]`).
- `proposeRectGrid` (pdf-geometry.ts:814) turns those rectangles into a grid —
  group by shared left edge (±2.5pt), demand ≥3 uniform-size squares, one row
  band per square at the square's own extent, confidence 1 because "nothing
  here was inferred". But it demands an author-drawn `within` box to scope the
  measurement to one table.

So the gap is purely one of scoping and marriage: the page-wide path never
looks at `rects`, and nothing marries text-derived rows to vector-derived
columns without a human drag. The drawn box existed to stop two structurally
identical tables bleeding into each other; the no-hands substitute for that
scoping is **row alignment** — a rect column belongs to a table exactly when
its squares pair one-to-one with that table's rows.

Two hard-won pieces of history constrain the design:

- **The rect extractor once silently returned zero on every document** (the
  pdf.js 6.x `constructPath` shape change, PdfViewer.tsx:84-103 — 0 rules
  before the fix, 349 after, and nothing said so). Rect evidence must therefore
  be a pure bonus: absent or empty `rects` degrades to today's text-only
  behavior exactly, and the reviewer-facing surface distinguishes "columns from
  printed boxes" from "columns inferred from header text" so a silent
  regression is at least visible as the measured wording disappearing.
- **Refusal over guessing** is the engine's house style (~20 refusal points,
  coded reasons, confidence penalties with notes). Mismatched square sizes,
  misaligned columns, and rect counts that disagree with the header column
  count must reduce confidence with a stated reason or refuse — never silently
  pick a side.

### Requirements

- **R1.** `ProposeInput` accepts the page's printed rectangles
  (`rects?: readonly PrintedRect[]`), with the `TextPage` convention preserved:
  `undefined` means NOT MEASURED. When `rects` is `undefined` **or** empty, or
  no rect column row-aligns with a proposal, `proposeTableSegments` output is
  **byte-identical to today** — same segments, same bands, same confidence,
  same notes. Rect evidence only ever raises accuracy or confidence; it never
  reorders or renames bands for documents without matching rects.
- **R2.** A shared, pure rect-column finder extracts the grouping logic
  `proposeRectGrid` already trusts (shared x within `RECT_COLUMN_X_TOLERANCE`,
  uniform size within `RECT_SIZE_TOLERANCE`, at least `RECT_COLUMN_MIN`
  squares), so both derivers measure columns the same way. `proposeRectGrid`'s
  observable behavior does not change (its whole test file stays green
  untouched).
- **R3.** Page-wide use adds a vertical-gap split: one x-run of squares whose
  baseline gaps contain an outlier jump (two stacked checklists sharing an x)
  splits into separate candidate columns, so no drawn box is needed to keep
  neighbouring tables apart. The split is opt-in and OFF on the
  `proposeRectGrid` path (R2).
- **R4 (refinement).** When a text-derived proposal's option columns can be put
  in **bijection** with row-aligned rect columns — one candidate column per
  option band, assigned by centre-x containment, order-preserving, each
  column's squares pairing one-per-row with the proposal's row bands — each
  matched column band snaps to the measured extent of its squares (min x to
  max x+width). Provenance is recorded (R7).
- **R5 (measured evidence lifts inference penalties).** A column position that
  was inferred from pitch (−0.3) or a header that went uncorroborated (−0.2)
  stops being a guess once printed squares independently confirm the grid: on a
  full bijection those two penalties and their notes are lifted, replaced by
  the measured-columns note. The merged-anchor penalty (−0.3/merge) is **not**
  lifted — merging says the header itself was misread, which squares cannot
  exonerate. Confidence never drops below its text-only value except under R6.
- **R6 (conflict is a signal, not a tiebreak).** When at least one rect column
  row-aligns with the proposal's rows but the set of row-aligned columns does
  **not** biject onto the option bands (count disagrees with the header column
  count, or x-assignment is inconsistent), the text bands are kept, confidence
  drops by 0.2 (floor 0), and a note tells the reviewer printed squares were
  found that do not line up with the inferred columns. Squares that fail size
  uniformity or the ≥3 minimum are simply not columns (R2) and add no noise.
- **R7 (provenance the reviewer can see).** `TableProposal` carries
  `columnEvidence: 'printed-boxes' | 'header-text'`, and the geometry panel
  renders it ("columns measured from printed boxes" / "columns inferred from
  header text"). Notes remain warnings-only — a clean text derivation keeps
  `notes: []` exactly as today (the pdf-geometry.test.ts:173 contract).
- **R8 (rect-anchored proposals).** For a table with exactly **one** option
  column, when a candidate rect column (post R3 split) is not already claimed
  by a header-derived proposal, and each of its squares pairs with a distinct
  label row — rows sharing a left margin (`LABEL_MARGIN_TOLERANCE`), every
  label run ending left of the column, baseline within the square's vertical
  reach — `proposeTableSegments` emits a proposal with the column band at the
  measured x-extent and one row band per square at the square's own y-extent
  (the `proposeRectGrid` quality, no hands). Row keys use this function's
  existing `r0…rN-1` convention. The segment box is the union of the label
  rows' extents and the bands, and passes `resolveGeometry` before shipping
  (R15 discipline).
- **R9.** Rect-anchored proposals carry confidence **0.95** — deliberately
  below the auto-confirm threshold (`classifyProposalTier` auto-confirms only
  at 1) — with the note naming what was measured and that no printed header
  corroborates it. First release is human-gated at needs-review; raising it is
  a later, corpus-informed decision. Multi-option-column headerless tables
  refuse (yield nothing), for `proposeRectGrid`'s own reason: without a header,
  nothing on the page says which printed column is which option key.
- **R10 (wiring).** The evidence actually reaches the derivation:
  `deriveForField` gains an optional trailing `rects` parameter,
  `deriveAcrossPages` threads `page.rects` through, and `subdivideBox` accepts
  the page's rects filtered to the drawn box by the centre test
  `proposeRectGrid` uses. The auto-place bulk pass and the page-scoped
  derivation (`GeometryEditorScreen.tsx:544` already blanks `rects` on other
  pages) inherit the behavior with no further change.
- **R11.** Every currently green test stays green. Pure functions with unit
  tests in the pdf-geometry test style — fixtures measured from real documents
  (the Mine Site SME square column at x=1231, 9pt sides, 28.4pt pitch; dozer
  page 7), never evenly-spaced synthetic convenience data.

### Scope Boundaries

**In:** the shared rect-column finder + gap split; band snapping and penalty
lifts on text-derived proposals; the conflict penalty; the single-answer-column
rect-anchored proposal path; `columnEvidence` provenance and its panel caption;
threading `rects` through `deriveForField` / `deriveAcrossPages` /
`subdivideBox`.

**Out (not this round's shape):**
- **Headerless multi-option-column derivation.** Keying K>1 printed square
  columns to option keys without header text is a guess about column order;
  the checklist corpus this targets is single-column. Refuse (R9).
- **Changing `proposeRectGrid`'s behavior or UI.** The drawn-box path stays the
  authoritative manual recourse, byte-identical (R2).
- **Radio/option-cell derivations** (`proposeFieldOptionCells`,
  `proposeInlineOptionCells`) learning from rects — a separate marriage with
  its own anchor semantics.
- **Auto-confirm (confidence 1) for rect-anchored proposals** — deferred until
  the needs-review tier has accumulated corpus evidence (R9).
- **Distinguishing "extractor regressed" from "page prints no rectangles".**
  `extractRuleLines`' guarded catch returns `[]`, so the two are
  indistinguishable at this layer; both degrade identically (R1) and the
  provenance caption is the tell.

#### Deferred to Follow-Up Work

- Rect corroboration feeding the placement hit-rate metric (gap #5's loop) —
  once placement telemetry exists, "measured vs inferred" is a natural axis.
- Snapping **row** bands of multi-column header tables to per-cell rects
  (bordered dozer-style tables) — this round tightens columns only, where the
  admission of error is.

### Acceptance Examples

- **AE1 (the Mine Site SME cover, no hands).** Five method labels sharing a
  left margin; five 9pt squares at x=1231, 28.4pt pitch; one answer column
  declared; no header glyphs — today, no proposal. Now: one rect-anchored
  proposal whose single column band is [1231, 1240], five row bands each at its
  square's own y-extent, confidence 0.95 (needs-review), note saying the grid
  was measured from printed checkbox squares with no printed header,
  `columnEvidence: 'printed-boxes'`.
- **AE2 (the dozer, no rects — nothing changes).** Page 7's measured fixture
  with `rects: undefined` and with `rects: []` yields proposals deep-equal to
  today's: same bands, confidence 1, `notes: []`,
  `columnEvidence: 'header-text'`.
- **AE3 (refinement).** A header-derived three-column grid over a page that
  also prints a row-aligned square column under each option header: each
  column band snaps to its squares' measured extent, confidence stays 1, and
  the panel says columns were measured from printed boxes.
- **AE4 (measurement rescues an inference).** The Small Loader shape — tick
  glyph missing from the text layer, so one column inferred at −0.3 — plus
  printed squares confirming all three columns: the inference penalty and its
  note are lifted, bands sit on the squares, confidence returns to 1.
- **AE5 (conflict penalised, never silently resolved).** Squares row-align with
  the table's four rows but sit 60pt left of the inferred bands and only two
  columns are found for three declared: text bands kept, confidence −0.2, note
  flags the disagreement for the reviewer.
- **AE6 (stacked twins refuse).** Two identical five-row checklists stacked in
  one x-run of ten squares: the gap split yields two candidate columns, two
  structurally identical proposals, and `selectByRowCount`'s near-equal band
  refuses rather than guessing table identity — the existing recourse
  (ordinal, drawn box) applies.
- **AE7 (extractor regression is survivable).** Every page reporting
  `rects: []` (the historic pdf.js failure mode) produces exactly today's
  proposals; nothing throws, and the "measured" caption simply never appears.

---

## Planning Contract

### Key Technical Decisions

- **KTD1 — Row alignment is the no-hands substitute for the drawn box.**
  `proposeRectGrid`'s `within` exists to stop adjacent tables bleeding into
  each other. Page-wide, the same scoping falls out of pairing: a rect column
  is *this* table's evidence only when its squares map one-per-row onto this
  table's rows. A column of ten squares never corroborates a four-row table.
- **KTD2 — Extract, don't duplicate, the column test.** The grouping /
  uniformity / minimum-count logic moves out of `proposeRectGrid` into a shared
  pure helper; `proposeRectGrid` keeps its own selection ("largest column, on a
  tie the smallest boxes") and stays behavior-identical. The page-wide gap
  split is an option the drawn-box path does not enable.
- **KTD3 — Provenance rides a field, not a note.** Notes are warnings (why
  confidence dropped); `columnEvidence` is provenance. This keeps
  `notes: []` for clean text derivations (an asserted contract,
  pdf-geometry.test.ts:173) while still giving the reviewer the
  measured-vs-inferred distinction — and makes the pdf.js-regression failure
  mode visible as the measured caption vanishing rather than as noise on every
  square-less document.
- **KTD4 — Measured evidence lifts exactly the penalties it answers.** Squares
  bijecting onto the grid independently confirm column positions (lifts
  inferred-column −0.3) and cross-check the header (lifts uncorroborated
  −0.2). They cannot vouch that a merged over-segmented header was read
  correctly, so the merge penalty stays.
- **KTD5 — Rect-anchored proposals ship needs-review.** Confidence 0.95, not
  1: a brand-new heuristic does not get auto-confirm on day one, matching the
  repo's human-gated instinct. Note that 0.95 vs a 1.0 rival on the same row
  count falls inside `NEAR_EQUAL_CONFIDENCE` (0.15) and refuses — refusal over
  guessing, accepted and tested.
- **KTD6 — Row keys follow the host function.** `proposeTableSegments` keys
  rows `r0…` while `proposeRectGrid` keys `r1…`; rect-anchored proposals flow
  through `proposeTableSegments`' selection and exporters, so they use `r0…`,
  asserted by test.

### Phase A — Shared rect-column evidence (pure, `pdf-geometry.ts`)

**U1 — `findRectColumns`: the column test, extracted.**
- **Goal:** One pure helper both derivers trust for "these rectangles form a
  printed column of one repeated control."
- **Requirements:** R2, R3.
- **Files:** `apps/web/src/lib/pdf-geometry.ts`,
  `apps/web/src/lib/pdf-geometry-rect-grid.test.ts` (unchanged — the guard),
  new tests in `apps/web/src/lib/pdf-geometry-rect-columns.test.ts`.
- **Approach:** `findRectColumns(rects, { splitOnRowGap = false })` returns
  `PrintedRect[][]`: sort by x, group runs within `RECT_COLUMN_X_TOLERANCE`
  (the existing loop at pdf-geometry.ts:894-906), drop groups smaller than
  `RECT_COLUMN_MIN` or failing `RECT_SIZE_TOLERANCE` uniformity (the checks at
  :926-949, made per-group). With `splitOnRowGap: true`, sort each group
  top-down and split at baseline-gap outlier jumps using the same
  largest-ratio-jump technique `rowPitch` (:514) uses — a gap ≥ the split
  ratio times the group's typical gap starts a new column; each fragment is
  re-checked against `RECT_COLUMN_MIN`. `proposeRectGrid` is refactored to
  call the helper with the split OFF and then apply its own
  largest-then-smallest selection and refusals verbatim — its outcomes,
  refusal codes and details must not change.
- **Test scenarios:** the drawn-box suite passes untouched; helper-level:
  mixed checkboxes + ruled cells separate into two groups; a non-uniform group
  is dropped; ten squares in one x-run with a 3× gap in the middle split into
  two five-square columns under `splitOnRowGap`; nine evenly-pitched squares
  do not split; fewer than three survivors yields no column.
- **Verification:** `pnpm typecheck`; `pnpm --filter @formai/web test` (the
  rect-grid file green with zero edits is the acceptance).

**U2 — `matchRectColumnsToGrid`: rows scope, bands assign.**
- **Goal:** The pure association between candidate rect columns and a
  text-derived grid — KTD1 as a function.
- **Requirements:** R4, R6 (the classification it feeds).
- **Files:** `apps/web/src/lib/pdf-geometry.ts`, tests in
  `pdf-geometry-rect-columns.test.ts`.
- **Approach:** Given candidate columns, the proposal's `rowBands` and option
  `columnBands`, return
  `{ matched: Map<bandKey, PrintedRect[]>; conflicting: boolean }`:
  1. *Row alignment:* a column qualifies when its square count equals the row
     count and each square's centre-y falls in a distinct row band.
  2. *Assignment:* each qualifying column goes to the option band containing
     its centre-x; a column outside every band goes unassigned. When two
     qualifying columns contend for one band, the smaller-area one wins (the
     checkbox beats the ruled cell around it — `proposeRectGrid`'s own
     tie-break) and the loser is discarded as furniture, not conflict.
  3. *Bijection or conflict:* every option band matched exactly once and no
     qualifying column left unassigned → `matched`; any qualifying column
     unassigned, or bands only partially covered → `conflicting: true`
     (partial snapping is refused — half-measured columns would mix evidence
     regimes inside one grid).
  Columns qualifying with no row alignment at all are ignored entirely — they
  belong to another table or to furniture, exactly what KTD1 predicts.
- **Test scenarios:** clean bijection for a three-column grid; checkbox column
  beats same-x ruled-cell column by area; a ten-square column ignores a
  four-row table; two columns for three bands → conflicting; one row-aligned
  column 60pt outside every band → conflicting; column with squares two-per-row
  does not qualify.
- **Verification:** `pnpm typecheck`; `pnpm --filter @formai/web test`.

### Phase B — Derivation (`proposeTableSegments`)

**U3 — Refinement: snap text-derived bands to measured squares.**
- **Goal:** A header-derived grid whose columns the page corroborates in ink
  gets bands at the squares' own extents, penalties answered by measurement
  lifted, and honest provenance.
- **Requirements:** R1, R4, R5, R6, R7 (the field; the caption is U6).
- **Files:** `apps/web/src/lib/pdf-geometry.ts`,
  `apps/web/src/lib/pdf-geometry.test.ts` (new describe blocks only).
- **Approach:** `ProposeInput` gains
  `rects?: readonly PrintedRect[] | undefined`; `TableProposal` gains
  `columnEvidence: 'printed-boxes' | 'header-text'` (defaulted
  `'header-text'` everywhere a proposal is built today, including
  `proposeFromExemplar`'s and `proposeRectGrid`'s literals — `proposeRectGrid`
  reports `'printed-boxes'`). Inside the per-header loop, after
  `centresToBands` and before the confidence arithmetic: run U1 (split ON)
  over `input.rects ?? []`, then U2 against the candidate bands/rows. On
  bijection: replace each matched band's `start`/`end` with min-x / max-(x+width)
  of its squares; suppress the inferred-column and uncorroborated-header
  penalties and their notes (KTD4), keep the merge penalty; push the note
  `'answer columns measured from printed checkbox squares'` only when a
  penalty was lifted (a clean grid that merely snapped keeps `notes: []` — the
  caption carries provenance); set `columnEvidence: 'printed-boxes'`. On
  `conflicting`: bands untouched, `confidence -= 0.2`, note that printed
  squares on these rows do not line up with the header-derived columns. On
  neither: nothing changes. The snapped segment still passes the existing
  `resolveGeometry` gate — bands may now start left of `labelRight`'s clamp,
  so the segment's `x`/`width` union must absorb the measured extents the same
  way `proposeRectGrid`'s union does (:981-986).
- **Test scenarios:** AE2 as a deep-equality property (fixtures with
  `rects: undefined` and `rects: []` equal today's snapshot, `notes: []`
  preserved); AE3 band-on-square exactness (band start === square x, end ===
  x+width); AE4 penalty lift (the `withoutTick` Small Loader fixture + three
  square columns → confidence 1, no inferred note); AE5 conflict (−0.2 and the
  note, bands unchanged); ruled-cell column alongside checkbox column snaps to
  the checkbox; validator still accepts a snapped segment whose squares sit
  left of the header text.
- **Verification:** `pnpm typecheck`; `pnpm --filter @formai/web test` — every
  pre-existing `proposeTableSegments` test green unmodified.

**U4 — Rect-anchored proposals for headerless checklists.**
- **Goal:** The Mine Site SME shape auto-places: no header glyphs, one option
  column, a printed square column paired with its label rows.
- **Requirements:** R8, R9.
- **Files:** `apps/web/src/lib/pdf-geometry.ts`, tests in
  `pdf-geometry.test.ts` (or a sibling `pdf-geometry-rect-anchored.test.ts`
  mirroring the rect-grid file's fixture style).
- **Approach:** After the header loop in `proposeTableSegments`, when
  `optionColumns.length === 1` and `input.rects` yielded candidates: for each
  candidate column (split ON) whose centre does not fall inside any
  already-emitted proposal's segment (header evidence outranks; no double
  proposals over one table), attempt label pairing against `toRows(items)`:
  each square pairs with the row whose leftmost run sits at a shared left
  margin (`LABEL_MARGIN_TOLERANCE` across the paired rows, the `rowBands`
  discipline) and whose baseline lies within the square's vertical extent
  padded by half a square height; require a perfect one-to-one pairing and
  every paired run's right edge left of the column start (the
  `OPTION_INTRUSION_TOLERANCE` idea — a run crossing under the squares is a
  heading, not a row). On success emit a `TableProposal`: `columnBands` =
  one band at the measured x-extent keyed to the option column; `rowBands` =
  one per square at the square's own y-extent, keyed `r0…` top-down (KTD6);
  segment = union of paired label runs and bands, gated by `resolveGeometry`;
  `confidence: 0.95`; `anchorsLocated: squares`, `anchorsInferred: 0`;
  `columnEvidence: 'printed-boxes'`; note
  `'grid measured from printed checkbox squares — no printed header row
  corroborates it, so review the row pairing'`. On any pairing failure the
  candidate is skipped silently — this path only ever adds proposals, never
  subtracts or warns (the page simply stays as refusable as today).
- **Test scenarios:** AE1 verbatim from the measured fixture (five bands on
  five squares, band == square extent, keys `r0..r4`, confidence 0.95,
  evidence field, note); a square column beside label rows with a heading run
  crossing under the squares → no proposal; squares without a shared label
  margin → no proposal; two option columns declared → no proposal; a page
  where a header-derived proposal already covers the squares emits no
  duplicate; AE6 stacked twins → two proposals whose downstream
  `selectByRowCount` refuses (asserted at the geometry-actions level in U5);
  emitted segment passes `resolveGeometry`.
- **Verification:** `pnpm typecheck`; `pnpm --filter @formai/web test`.

### Phase C — Wiring and the reviewer surface

**U5 — Thread `rects` through the decision layer.**
- **Goal:** The evidence the viewer already ships on every `TextPage` actually
  reaches derivation — page-wide, cross-page, and inside a drawn box.
- **Requirements:** R10.
- **Files:** `apps/web/src/screens/import/inspector/geometry-actions.ts`,
  `apps/web/src/screens/import/inspector/geometry-actions.test.ts`,
  `apps/web/src/screens/import/GeometryEditorScreen.tsx` (the `subdivideBox`
  call site only).
- **Approach:** `deriveForField` gains an optional trailing
  `rects?: readonly PrintedRect[]` (positional callers and every existing test
  compile unchanged) and forwards it to `proposeTableSegments`.
  `deriveAcrossPages` passes `page.rects` — the page-scoped blanking in
  `GeometryEditorScreen.tsx:544` already nulls `rects` alongside `items`, so
  single-page derivation and `autoPlaceRemaining` inherit correct scoping for
  free. `SubdivideInput` gains `rects?`; `subdivideBox` filters them to the
  drawn box with the same centre-containment test `proposeRectGrid` uses
  (:875-879) before forwarding, and its call site passes
  `textPages[box.page]?.rects`.
- **Test scenarios:** `deriveAcrossPages` over a two-page fixture where only
  page 2 carries the AE1 squares places the checklist on page 2;
  `deriveForField` without the new argument behaves exactly as before (the
  existing suite is that assertion); AE6 at this level — stacked twins on one
  page → `selectByRowCount` returns null; a rect-anchored 0.95 proposal
  classifies `needs-review` via `classifyProposalTier`; `subdivideBox` given
  box-external squares does not snap to them.
- **Verification:** `pnpm typecheck`; `pnpm --filter @formai/web test`.

**U6 — Provenance caption in the geometry panel.**
- **Goal:** The reviewer can always tell measured from inferred (R7), and the
  historic silent-zero failure mode has a visible tell (AE7).
- **Requirements:** R7, R1's "say so" clause.
- **Files:** `apps/web/src/screens/import/GeometryEditorScreen.tsx` (the
  proposal panel around :1907), `geometry-actions.ts` if the `proposed` panel
  state is where the string is composed,
  `GeometryEditorScreen.test.tsx` / geometry-actions tests as fits the
  existing test seams.
- **Approach:** The `proposed` panel state carries `columnEvidence` through
  from the `TableProposal`; the panel renders a one-line caption above the
  notes list: `'columns measured from printed boxes'` for `'printed-boxes'`,
  `'columns inferred from header text'` for `'header-text'`. Existing notes
  rendering is untouched. No caption for non-table proposals (field/option
  cells), whose provenance story is out of scope.
- **Test scenarios:** a snapped proposal surfaces the measured caption; a
  text-only proposal surfaces the inferred caption; notes list renders
  unchanged beneath either.
- **Verification:** `pnpm typecheck`; `pnpm --filter @formai/web test`.

### Testing strategy

- **Pure-function first.** Phases A and B are pure `pdf-geometry.ts` code —
  the bulk of confidence is vitest unit tests with **measured fixtures**, per
  the file's own discipline ("evenly-spaced synthetic data passes a derivation
  that would fail on every real document"): the Mine Site SME square column
  (x=1231, 9×9pt, 28.4pt pitch — already measured in
  `pdf-geometry-rect-grid.test.ts`) and dozer page 7's verbatim text runs are
  the two anchors; new fixtures compose these rather than inventing tidy
  grids.
- **Regression as a property.** The strongest single test is AE2/AE7: run
  every existing `proposeTableSegments` fixture with `rects: undefined` and
  `rects: []` and deep-compare against the no-argument result — byte-identical
  output is R1 made executable, and it encodes the pdf.js-regression story
  permanently.
- **`proposeRectGrid` as the refactor guard.** U1's acceptance criterion is
  its entire existing test file passing with zero edits.
- **No live PDF in the loop.** Everything here is deterministic over
  positioned fixtures; `extractRuleLines` itself is not touched, so no
  pdf.js-dependent test is needed.
- **Gates:** `pnpm typecheck` and `pnpm --filter @formai/web test` green on
  every unit; the whole suite green before merge.

### Risks & mitigations

- **Coincidental furniture squares row-aligning with a real table** (bullet
  glyph boxes, decorative borders). Mitigated in depth: ≥3 uniform squares
  (U1), exact one-per-row pairing (U2/KTD1), shared label margin and
  no-intrusion checks on the headerless path (U4), and the rect-anchored tier
  capped at needs-review (KTD5) so a false positive is reviewed, never
  auto-confirmed.
- **Bordered tables: ruled cells masquerading as the answer column.** The cell
  rectangle around each row row-aligns as well as the checkbox inside it. The
  smallest-area tie-break (U2, inherited from `proposeRectGrid`'s "the cell is
  furniture around the control") picks the square; tested explicitly.
- **The 0.95 tier interacting with `selectByRowCount`.** A 0.95 rect-anchored
  proposal against a 1.0 text rival on the same row count sits inside
  `NEAR_EQUAL_CONFIDENCE` and refuses. That is the intended failure direction
  (refuse over guessing) but it can suppress a good proposal on busy pages;
  the ordinal and drawn-box recourses remain, and the constant's documented
  penalty-separation analysis (geometry-actions.ts:36-52) must be extended to
  mention the new 0.05 separation so the next tuner sees it.
- **Refactor regression in `proposeRectGrid`** (U1 extraction subtly changing
  grouping order or tie-breaks). Mitigation: the helper returns groups; all
  selection and every refusal stays in `proposeRectGrid` verbatim, and the
  untouched test file is the gate.
- **Notes-contract breakage.** Existing tests assert `notes: []` on clean
  derivations; provenance therefore rides the `columnEvidence` field (KTD3)
  and the measured note appears only when it explains a confidence change.
  U3's property test pins this.
- **Snapped bands escaping the segment box.** Measured square extents can sit
  left of `labelRight` or right of the last text-derived edge; a segment that
  no longer contains its own bands is silently dropped by the validator.
  U3 unions the measured extents into the segment exactly as
  `proposeRectGrid` does, with a dedicated test.
