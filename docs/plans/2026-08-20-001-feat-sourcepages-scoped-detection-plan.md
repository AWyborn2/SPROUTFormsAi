---
title: "feat: sourcePages-scoped placement detection — the extraction window as a soft prior in the geometry engine"
date: 2026-08-20
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
origin: geometry findings brief 2026-08-20, gap #3
---

# feat: sourcePages-scoped placement detection

## Product Contract

### Summary

Every AI-extracted field already carries `sourcePages` — the 1-based inclusive
page range of the 4-page extraction batch that produced it, stamped in code and
never asked of the model. The browser-side geometry engine never reads it: its
document-wide scans refuse whenever a second page matches anywhere in the
document, and its table picker lands character-identical repeated parts on the
first page that fits. This plan threads `sourcePages` through to the `FormField`
the placement screens actually hold, and teaches the three cross-page derivers
to use it as a **soft prior**: a document-wide ambiguity with exactly one hit
inside the field's window becomes a *needs-review placement with a note naming
the excluded pages*, instead of a refusal — and repeated practical parts each
propose on their own pages. Ambiguity **inside** a window still refuses. Fields
with no window (legacy extractions, AcroForm, built fields) behave byte-
identically.

### Problem Frame

The engine's refusal discipline is right — a wrong-page placement on a
competency record is worse than no placement — but it currently refuses with
one eye closed. Two concrete failures on real papers:

- **Refusal on ambiguity the window already resolves.** The dozer paper prints
  "Wearing correct PPE" under several parts. `deriveOptionCellsAcrossPages`
  (`apps/web/src/screens/import/inspector/geometry-actions.ts:1575`) and
  `deriveMatchAnchorsAcrossPages` (`:1622`) scan every page and return null the
  moment a second page matches — even when the field's extraction batch was
  pages 5–8 and the competing hits sit on pages 12 and 17. The pipeline knows
  which pages the model was looking at; the engine throws that fact away and
  hands the reviewer a manual placement.
- **First-page capture of repeated parts.** Parts 2, 4 and 6 of a duplicated-
  checklist paper print the identical practical checklist on three different
  pages. `deriveAcrossPages` (`geometry-actions.ts:196`) picks the best (in
  practice, first) match, so all three parts' boxes land on Part 2's page — the
  exact tedium `retargetPageChanges` (`:1535`) and the section-move tool were
  built to clean up after. The three fields' windows (5–8, 9–12, 13–16) already
  say which copy is whose.

The decisive structural fact (verified): **`sourcePages` does not survive into
`FormField`.** It lives on `ExtractedField`
(`packages/shared/src/extraction.ts:176`) only. The builder's `seedFields`
(`apps/web/src/screens/assessments/builder/use-builder-draft.ts:404`) does not
copy it; the import review's `seedEditor`
(`apps/web/src/lib/data/import-session.ts:152`) does not copy it; and the
publish whitelist `reviewedToFields` (`import-session.ts:1576`) would drop it
even if it did. This is the same hole that swallowed `questionRef` (gap #1).
`GeometryEditorScreen` — mounted standalone off `version.fields` fetched from
the server, and embedded by the builder's PlacementStep — only ever sees
`FormField`s, so threading the window through is a precondition of the engine
change, not an optional nicety.

Three constraints from the repo's own discipline shape the design:

- **The window is a batch artifact, not an exact page.** 1-based, inclusive, up
  to 4 pages; adjacent batches don't overlap, but a field's true page is
  anywhere in its window — and batch-boundary merges (the rule-19 orphan
  territory, continuation tables) can put a field's printed start one page
  outside it. Scoping must be a soft prior with boundary tolerance, never a
  hard trust.
- **Refusal semantics are sacred.** Two candidate pages inside one window is a
  question the document does not place; the engine keeps saying so. And a
  window-disambiguated placement is *more* confident than a refusal but *less*
  than a unique document-wide hit — it must not silently auto-confirm.
- **Pure-function style.** All window logic lands in `geometry-actions.ts` as
  pure, unit-tested code; `GeometryEditorScreen` and `GeometryInspector` only
  pass the field's window through.

### Requirements

- **R1.** `sourcePages` survives extraction → placement: an optional
  `sourcePages?: { from: number; to: number }` on `FormField`
  (`packages/shared/src/form-field.ts`, beside `sourcePosition`, its exact
  precedent — extraction-run metadata that publishes and round-trips). Copied
  by the builder's `seedFields`, the import review's `seedEditor`, and the
  `reviewedToFields` publish whitelist. Absent everywhere it isn't stamped:
  built fields, AcroForm-only extractions, pre-change data.
- **R2.** The three cross-page derivers — `deriveOptionCellsAcrossPages`,
  `deriveMatchAnchorsAcrossPages`, `deriveAcrossPages` — accept an optional
  window. With a window: a scan whose hits are ambiguous document-wide but
  unique **inside** the window returns that hit as a proposal instead of null.
- **R3.** Refusals preserved: two or more hits inside one window → null. Zero
  hits anywhere → null. Unchanged from today.
- **R4.** A hit unique document-wide behaves exactly as today when it falls
  inside the window (or when there is no window): same confidence, no window
  note — the window was not needed and must not leave fingerprints. A unique
  hit **outside** the window still places (soft prior never vetoes the only
  candidate) but is capped to needs-review with a note naming the window.
- **R5.** Every placement the window influenced says so: confidence capped
  strictly below 1 (never auto-confirm) and a reviewer-facing note in the
  proposal's existing `notes` channel, e.g. *"Matched on page 7; pages 12 and
  17 excluded by the extraction window (pages 5–8)."*
- **R6.** Fields without `sourcePages` take the existing code path
  byte-identically — including the early-exit-on-second-hit scan behavior.
  No behavioral or perf change for AcroForm, built, or legacy fields.
- **R7.** Window hygiene: converted 1-based→0-based once, **dilated by one page
  on each side** (batch-boundary tolerance), clamped to the document's page
  count; a malformed or wholly out-of-range window is treated as absent. All in
  one pure function so every deriver agrees.
- **R8.** The page-scoped bulk pass (`autoPlaceRemaining(onlyPage)`) does
  **not** consult the window: the author pointing at a page is a stronger
  signal than the batch prior, and today's behavior of that flow is preserved
  exactly (including auto-confirm of unique hits on the scoped page).
- **R9.** Tables: `deriveAcrossPages` prefers in-window candidates — when
  candidates exist both inside and outside the window, out-of-window ones are
  excluded and the pick is capped + noted per R5; when none are in-window, the
  existing best-pick runs and is capped + noted. The within-window tiebreakers
  (row-count distance, confidence, ordinal-first-page) are unchanged.

### Scope Boundaries

**In:** the `FormField.sourcePages` property and its threading (seeding,
publish whitelist, split inheritance verified); the pure window helpers; the
three window-aware derivers; wiring through `deriveProposal`,
`autoPlaceRemaining` (whole-document mode only) and `GeometryInspector`'s
derive call; tests for legacy no-op, refusal preservation, and notes.

**Out (not this change's shape):**
- Any extraction-side change — the window is already stamped
  (`apps/api/src/pdf/extract.ts:534-537`); nothing in `apps/api` moves. No DB
  migration: version fields are stored as jsonb and validated with
  `z.custom<FormField>()`, so a new optional property flows through.
- Gap #4 (vector-derived checkbox columns) and gap #5 (placement telemetry /
  learning-loop geometry signal) — separate rounds.
- Any UI for viewing or editing a field's window. It is engine input, not an
  authoring surface.
- Backfilling `sourcePages` onto already-published forms. Legacy stays legacy
  (R6); a republish that re-runs extraction picks the windows up for free.

#### Deferred to Follow-Up Work

- Using the window to **order** the scan for perf (scan in-window pages first
  and skip the rest when notes aren't needed) — `GeometryInspector` already
  flags the full-document scan cost; the window makes a targeted fix possible
  later without changing semantics.
- A window-aware **section move** suggestion ("Part 4's boxes sit outside its
  fields' windows — move to page 11?") layered on `retargetPageChanges`.

### Acceptance Examples

- **AE1 (repeated parts land apart).** Parts 2, 4, 6 print an identical
  checklist on pages 7, 11 and 15; their fields carry windows 5–8, 9–12,
  13–16. The bulk auto-place pass proposes each part's boxes on its own page,
  all needs-review, each noting the two excluded pages and its window.
  "Confirm all proposed" places all three parts — no `retargetPageChanges`
  cleanup.
- **AE2 (in-window ambiguity still refuses).** "Wearing correct PPE" prints on
  pages 6 AND 7; the field's window is 5–8. Both hits are in-window →
  refusal, exactly as today.
- **AE3 (legacy is byte-identical).** A field with no `sourcePages` and two
  document-wide hits refuses; with one hit it places at full confidence. A
  fixture asserts the returned proposal object is deep-equal to the
  pre-change output.
- **AE4 (window unused leaves no trace).** A field with window 5–8 matches
  only page 6 in the whole document → same confidence and notes as if no
  window existed; eligible for auto-confirm.
- **AE5 (out-of-window unique hit is flagged, not vetoed).** Window 5–8, the
  only hit is page 12 → placed, confidence capped, note *"Matched on page 12,
  outside the extraction window (pages 5–8) — check the page."*
- **AE6 (author's page scope outranks the window).** The author runs
  "Detect on this page" on page 11. Part 4's fields (window 9–12) auto-confirm
  from the scoped scan exactly as today — the window is not consulted, so a
  stale or boundary-shifted window cannot downgrade an explicit human choice.

---

## Planning Contract

### Key Technical Decisions

- **KTD1 — `sourcePages` lives on `FormField`, not in `reviewMeta`.**
  `questionRef` stayed review-side because publishing it would be wrong (the
  resolved `outcomeTarget` crosses the boundary instead). `sourcePages` has no
  derived form — the window itself is what placement needs — and the standalone
  `GeometryEditorScreen` mount reads `version.fields` fetched from the server,
  which review-side metadata never reaches. `sourcePosition` is the exact
  precedent: extraction metadata on `FormField`, whitelisted at both publish
  boundaries. Split parts inherit it via the `splitField` reducer's copy
  (correct — the groups came from the same batch), unlike `sourcePosition`,
  which splits deliberately drop because it describes the merged block.
- **KTD2 — one pure window-verdict function, shared by all derivers.** The scan
  collects hits with their pages; a single classifier decides
  place-unchanged / place-capped-with-note / refuse per R2–R5. Confidence cap
  constant `WINDOW_CONFIDENCE_CAP = 0.95` — strictly below the
  `classifyProposalTier` auto-confirm boundary (`=== 1`), so window-influenced
  proposals always park as needs-review and flow through the existing
  "Confirm all proposed" bulk action. No new tier, no new panel state.
- **KTD3 — the window is dilated by one page each side before use.** The batch
  boundary is an artifact of the splitter, not of the printed document:
  batch-start orphan merges and continuation tables put a field's printed
  start one page outside its stamped window. Dilation trades a little
  disambiguating power at boundaries (two parts whose dilated windows overlap
  on a shared page → refusal, the honest answer) for never excluding the true
  page.
- **KTD4 — legacy takes the untouched code path.** When no valid window is
  present the derivers run today's exact loop, early-exit included. The
  windowed path does a full scan (it needs the excluded pages for the note)
  but early-refuses the moment a second in-window hit appears. Perf cost lands
  only on fields that gain a capability.

### Phase A — Thread the window to the placement surfaces

**U1 — `sourcePages` on `FormField`.**
- **Goal:** the shared type carries the window, documented as a batch range.
- **Requirements:** R1.
- **Files:** `packages/shared/src/form-field.ts`.
- **Approach:** add `sourcePages?: { from: number; to: number }` directly
  below `sourcePosition` (line ~394), with a doc comment stating: 1-based
  inclusive extraction-batch range, stamped in code server-side, NOT a page
  the field is known to sit on — consumers treat it as a soft prior only, and
  absent means "extracted before the stamp existed, via AcroForm, or built by
  hand". No zod change needed: the API validates fields with
  `z.custom<FormField>()` (`apps/api/src/routes/forms.ts:132,286,420`,
  `assessments.ts:932`) and stores them as jsonb.
- **Test scenarios:** type-only; exercised by U2's tests.
- **Verification:** `pnpm typecheck`.

**U2 — Seed and publish the window everywhere fields are minted from an extraction.**
- **Goal:** an AI-extracted field's window reaches the draft version the
  builder places against and the fields the import flow publishes.
- **Requirements:** R1, R6.
- **Files:**
  `apps/web/src/screens/assessments/builder/use-builder-draft.ts` (`seedFields`
  :404), `apps/web/src/lib/data/import-session.ts` (`seedEditor` :160,
  `reviewedToFields` :1590), plus their tests
  (`use-builder-draft.test.ts`, `import-session.test.ts`).
- **Approach:** add `...(f.sourcePages ? { sourcePages: f.sourcePages } : {})`
  to all three mapping blocks, mirroring the `sourcePosition` line each already
  has. `splitTableGroups` needs no edit — the reducer copies the source field
  and the parts inherit the window correctly (verified: it only overrides
  `label`/`fixedRows`/`sourcePosition`). Revision flows need no edit either:
  a revision that replaces the PDF re-runs extraction through `seedFields`
  (fresh windows for the new document); a revision that carries fields keeps
  the same PDF (old windows stay valid); legacy versions simply lack the
  property (R6).
- **Test scenarios:** `seedFields` copies a stamped window and omits the key
  when absent; `seedEditor` same; `reviewedToFields` publishes it and a field
  split into 3 groups carries the source's window on every part; a field with
  no `sourcePages` publishes without the key.
- **Verification:** `pnpm typecheck`, `pnpm --filter @formai/web test`.

### Phase B — The pure window engine

**U3 — Window helpers in `geometry-actions.ts`.**
- **Goal:** one validated, dilated, clamped window representation and one
  verdict function, so every deriver agrees on semantics and wording.
- **Requirements:** R2–R5, R7.
- **Files:** `apps/web/src/screens/import/inspector/geometry-actions.ts`,
  `geometry-actions.test.ts`.
- **Approach:** pure additions:
  - `WINDOW_CONFIDENCE_CAP = 0.95` and `WINDOW_MARGIN_PAGES = 1`, each with a
    comment tying them to KTD2/KTD3.
  - `pageWindowOf(sourcePages: {from,to} | undefined, pageCount: number):
    { first: number; last: number } | null` — 1-based→0-based, dilate by
    `WINDOW_MARGIN_PAGES`, clamp to `[0, pageCount-1]`; null on undefined,
    `from > to`, non-positive values, or `from-1 > pageCount-1` (a window
    wholly past the end of the document — the "replaced with a shorter PDF"
    defense).
  - `windowVerdict(hits: { page: number }[], window): { kind: 'refuse' } |
    { kind: 'place'; page: number; windowed: false } | { kind: 'place';
    page: number; windowed: true; note: string }` implementing the R2–R5
    truth table: 1 in / 0 out → place unwindowed; 1 in / ≥1 out → place
    windowed with the "pages X, Y excluded by the extraction window (pages
    A–B)" note (1-based, undilated bounds in the copy — the note names what
    the extraction stamped, not the tolerance); ≥2 in → refuse; 0 in / 1 out →
    place windowed with the "outside the extraction window — check the page"
    note; 0 in / ≥2 out → refuse; 0 anywhere → refuse. Note strings are built
    here so all derivers share the exact reviewer-facing wording.
- **Test scenarios:** every truth-table row; dilation admits a hit one page
  before/after the stamped range; clamping at document edges; null on each
  malformed shape; note text golden-matched including page-number formatting.
- **Verification:** `pnpm --filter @formai/web test`.

**U4 — Window-aware option-cell and match-anchor scans.**
- **Goal:** the two refuse-on-ambiguity derivers place through the window.
- **Requirements:** R2–R6.
- **Files:** `geometry-actions.ts` (`deriveOptionCellsAcrossPages` :1575,
  `deriveMatchAnchorsAcrossPages` :1622), `geometry-actions.test.ts`.
- **Approach:** add an optional `window?: { first: number; last: number } |
  null` parameter (the U3 shape — callers resolve `pageWindowOf` once). When
  null: today's loop, verbatim, early exit at the second hit (R6/KTD4). When
  present: collect `{ page, proposal }` hits over the full scan, early-refusing
  as soon as two in-window hits exist; feed pages to `windowVerdict`; on a
  `windowed: true` placement return the chosen page's proposal with
  `confidence: Math.min(confidence, WINDOW_CONFIDENCE_CAP)` and the verdict's
  note appended to its `notes`. The underlying per-page proposers are
  untouched.
- **Test scenarios:** (AE1) three pages match, one in window → that page's
  proposal, capped, note lists the two excluded pages; (AE2) two in-window
  matches → null; (AE3) no window + two matches → null, no window + one match
  → deep-equal to pre-change output; (AE4) window present, single global hit
  in-window → confidence and notes untouched; (AE5) single global hit
  out-of-window → capped + "outside" note; match-anchor variants of the same
  set.
- **Verification:** `pnpm --filter @formai/web test`.

**U5 — Window-aware table selection.**
- **Goal:** repeated identical tables stop landing on the first matching page.
- **Requirements:** R2, R5, R6, R9.
- **Files:** `geometry-actions.ts` (`deriveAcrossPages` :196),
  `geometry-actions.test.ts`.
- **Approach:** same optional `window` parameter. When null: today's code,
  verbatim. When present: collect per-page candidates from `deriveForField`
  (both the ordinal and row-count paths); if any candidate's `segment.page`
  is in-window, drop the rest and run the existing tiebreak (row-count
  distance, then confidence; ordinal keeps first-in-window) over the
  survivors — capping + noting per U3 only when out-of-window candidates were
  actually excluded; if none are in-window, run the existing best-pick over
  everything and cap + note the result ("outside the extraction window").
  A two-page table is judged by its anchor page (`segment.page`), which the
  dilated window already tolerates at batch boundaries (KTD3).
- **Test scenarios:** identical table on pages 2 and 5, window covering 5 →
  page 5 wins, capped, note names excluded page 2 (would pick page 2 today —
  asserted as the contrast case with no window); window with two in-window
  identical candidates → existing first/best tiebreak applies with the cap
  (no refusal — the table path never refused on ambiguity and does not start
  to); no in-window candidate → best-pick + "outside" note; no window →
  deep-equal to pre-change output; ordinal path prefers first in-window page.
- **Verification:** `pnpm --filter @formai/web test`.

### Phase C — Wiring (the screens pass the window; nothing else changes)

**U6 — `deriveProposal`, the bulk pass, and the inspector.**
- **Goal:** every existing call site hands its field's window to the engine —
  except the author's explicit page-scoped scan.
- **Requirements:** R5 (notes visible), R6, R8.
- **Files:** `apps/web/src/screens/import/GeometryEditorScreen.tsx`
  (`deriveProposal` :1583, `selectField` :472, `autoPlaceRemaining` :519),
  `apps/web/src/screens/import/inspector/GeometryInspector.tsx` (:202),
  `GeometryEditorScreen.test.tsx`.
- **Approach:** `deriveProposal(field, textPages, window)` where callers
  compute `window = pageWindowOf(field.sourcePages, textPages.length)`.
  `selectField` and the whole-document `autoPlaceRemaining()` pass it;
  `autoPlaceRemaining(onlyPage)` passes `null` explicitly, with a comment
  citing R8/AE6 (the blanked-pages scope is the author's disambiguation — the
  window must not re-litigate it). `GeometryInspector`'s memoized
  `deriveAcrossPages` call passes the field's window the same way. No new UI:
  capped confidence already routes proposals into the needs-review queue and
  `panelState` already renders `notes`, so the window's reviewer-facing story
  ships through existing surfaces.
- **Test scenarios:** screen-level — a field with a window and a doc-wide
  ambiguity parks a needs-review preview (was: nothing) whose note names the
  excluded pages; a windowless field auto-confirms/refuses exactly as the
  existing tests assert (run unmodified); AE6 — page-scoped auto-place on a
  page outside the field's window still auto-confirms its unique scoped hit;
  a window-disambiguated field is never auto-confirmed even at underlying
  confidence 1.
- **Verification:** `pnpm typecheck`, `pnpm --filter @formai/web test`.

### Testing strategy

- Phases A and B are pure functions — the bulk of the confidence, no DOM, no
  pdfjs. U3's truth table is tested exhaustively; U4/U5 reuse the existing
  `geometry-actions.test.ts` fixtures (blank/withTable TextPages, option-cell
  pages) with windows layered on.
- **Legacy no-op is asserted, not assumed:** U4/U5 include deep-equality
  fixtures comparing no-window output against the pre-change behavior, and the
  existing `deriveAcrossPages` / screen tests run unmodified — any diff there
  is a regression by definition (R6).
- U6 rides the existing `GeometryEditorScreen.test.tsx` harness (fake text
  layer via `onTextLayer`).
- No live model, no PDF corpus needed: windows are plain data and every input
  is a synthetic TextPage. Gates: `pnpm typecheck`,
  `pnpm --filter @formai/web test`.

### Risks & mitigations

- **A stale window steering a wrong-but-plausible placement** (e.g. exotic
  field-carry paths after a PDF swap). Mitigated three ways: window-influenced
  placements are always needs-review with a page-naming note (a human looks at
  every one); wholly out-of-range windows are ignored (U3); and the two
  revision paths verified in U2 both keep window and document in step
  (re-extract restamps; carry keeps the same PDF).
- **Batch-boundary fields whose true page sits outside the stamped window.**
  KTD3's one-page dilation covers merges and continuations; the residual case
  (a hit two+ pages out) degrades to the R4 "outside the window" cap + note —
  flagged, never vetoed, never silently trusted.
- **Dilated windows of adjacent parts overlapping on a shared page**, turning
  a would-be disambiguation into ambiguity → refusal. Accepted: refusal is
  the engine's honest answer, and it is exactly today's behavior — the
  feature can only fail back to the status quo, never below it.
- **Behavior drift for legacy fields via shared code.** The no-window branch
  is the untouched original loop (KTD4), guarded by deep-equality fixtures and
  the unmodified existing test suites.
- **Perf of the full scan on windowed fields.** Bounded: early refusal at the
  second in-window hit, and the scan-ordering optimization is explicitly
  deferred with the semantics already fixed here.
