---
title: Fix Split-Group Reading Order — Fillable
type: fix
date: 2026-07-23
topic: split-group-order
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Fix Split-Group Reading Order - Plan

## Goal Capsule

- **Objective:** When a reviewer splits one flattened checklist into its N printed side-by-side groups (U9 of the faithful-round-trip plan), each group must contain the items of **one printed column, top to bottom** — not a scramble of items drawn from all columns.
- **Root cause:** U9's split deals items out with a fixed stride (`i % groups`) on the assumption that extraction flattened the table **across-then-down** (row-major). The AI extractor's order is not stable: on the live `ADMN-FRM-111` smoke it came out **down-then-across** (column-major), so the stride scrambled the groups. No single hardcoded stride can be right while the flattening order is a coin-flip.
- **Two-part fix:** (1) pin the extraction order to a known contract in the prompt — read *down* each column, left group first — so the default split is correct by construction; (2) give the reviewer a live preview of the resulting groups plus a mode toggle, so a still-wrong order is corrected on the spot rather than published.
- **What this is not:** geometry-based auto-detection of the reading order from the text layer. That is the robust end-state and is deferred to Open Questions; this plan makes the common case correct and the uncommon case recoverable.

---

## Product Contract

### Problem Frame

`splitTableGroups` (`apps/web/src/lib/data/import-session.ts`) distributes a checklist's `fixedRows` into `groups` new fields with `items.filter((_item, i) => i % groups === g)`. That stride is only correct when item `i` prints at row `floor(i / groups)`, column `i % groups` — i.e. when extraction flattened the printed table **across each row, then down**.

On the live `ADMN-FRM-111` smoke the extractor instead read **down each column, then across**:

```
Extraction order (18 items):
  Engine oil level, Engine coolant level, Power steering fluid level,
  Steering, Locking pins on Tray, Collision Avoidance System,   ← left column, top-to-bottom
  Tyre Condition/Wheel nuts, Park brake, Foot brake, Seat belts,
  2-way radio, Horn,                                            ← middle column
  Brake & indicator lights, Headlights, Flashing light, Flag,
  Fire extinguisher, Reverse Alarm                              ← right column
```

Run a stride of 3 over that column-major list and group 1 becomes `Engine oil level, Steering, Tyre Condition, Seat belts, Brake & indicator lights, Flag` — two items from each of the three printed columns. The reviewer then cannot line that group's grid up against any single printed column, and a confirmed grid would draw ticks against the wrong printed rows on export.

The deeper fact is that the flattening order is **not deterministic** — an earlier measurement of the same document came out row-major. The plan that shipped U9 already named this ("extraction is already inconsistent between runs on the same document"). A fixed distribution rule therefore cannot be correct on its own; the order must either be pinned upstream or chosen by the reviewer.

### Requirements

- R1. The extraction prompt instructs the model that a fixed-item checklist printed as N side-by-side column groups is emitted **column-major** — every item of the leftmost printed column top-to-bottom, then the next column, and so on — so `fixedRows` arrives in a declared, consistent order. *(This governs behaviour the deterministic tests cannot assert; verified by a real re-extraction smoke.)*
- R2. When the extractor can see the side-by-side structure, it records the printed **group count** as a reviewer-facing hint (a proposal, never trusted — parent R16), so the split control can pre-fill that count.
- R3. `splitTableGroups` supports two interleave modes — **down columns** (contiguous blocks) and **across rows** (the existing stride) — and defaults to *down columns*, matching the order R1 pins. Down-columns with G groups over R-row columns assigns group `g = items[g·R … (g+1)·R)`.
- R4. Before the split commits, the reviewer sees a **preview** of each resulting group's item list for the chosen count and mode.
- R5. The reviewer can **toggle** the interleave mode and the preview updates live, so an extraction that still arrives in the other order is corrected without leaving the review screen.
- R6. Split output stays a set of **proposals**: each group is independently confirmable and none inherits the source's confirmed geometry, acceptance carries only as U9 already defines (parent R8, R18). This plan must not weaken that.

### Acceptance Examples

- AE1. **Covers R3.** Given a column-major 18-item checklist split into 3 down-columns groups, when the split runs, then group 1 is exactly the printed left column (`Engine oil level, Engine coolant level, Power steering fluid level, Steering, Locking pins on Tray, Collision Avoidance System`).
- AE2. **Covers R3, R5.** Given a row-major 18-item checklist, when the reviewer selects *across rows*, then the three groups again each equal one printed column.
- AE3. **Covers R4.** Given the split control open with count 3 and mode *down columns*, when the reviewer looks at the preview before clicking Split, then the three groups' item lists are shown as they will be created.
- AE4. **Covers R6.** Given a source table with a confirmed grid, when it is split, then no resulting group reports confirmed geometry and each must be confirmed on its own.
- AE5. **Covers R1** *(smoke).* Given a real `ADMN-FRM-111` re-extraction after the prompt change, when the Category A checklist is inspected, then its `fixedRows` are in column-major order.

### Scope Boundaries

Not in this plan:

- **Geometry-based order auto-detection** — reconstructing each item's true (x, y) from the text layer so the split needs neither a pinned order nor a toggle. This is the robust end-state; see Open Questions. Deferred because it depends on fuzzy label-to-glyph matching and is a larger change than the reviewer-driven fix the smoke showed is needed now.
- The overlay row-count-one-high leak and the drag/snap/glyph work — their own plans (`2026-07-23-002`, `2026-07-23-003`).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Fix the order at the source, keep the toggle as the safety net.** The extractor already proved it can read a table column-major; the defect is that nothing *tells* it which order to use, so it varies. Pinning the order in the prompt makes the default split correct without any reviewer action. The toggle + preview exist because a prompt cannot *guarantee* the order on every document — so the reviewer keeps a one-click correction, and the doctrine that a human confirms geometry (parent R8) is preserved.
- KTD2. **Down-columns is contiguous slicing, across-rows is the existing stride.** Two named modes over the same `fixedRows`, not a new data model. The default flips to *down columns* to agree with R1. The stride path is retained verbatim as *across rows* so a row-major extraction is still handled.
- KTD3. **The group-count hint is a proposal, not a trusted value.** Extraction may emit a `columnGroups` count; the split control pre-fills it but the reviewer owns the final number. An absent or wrong hint costs nothing — the reviewer still chooses. This keeps extraction a pure proposer (parent R16) and never lets a model count decide structure unreviewed.
- KTD4. **The preview is derived from the same distribution function the commit uses.** The preview must show exactly what Split will create, so both call one pure `distributeGroups(items, groups, mode)` helper. A preview that computed membership differently from the commit would be worse than none.

---

## Implementation Units

### U1. Pin the checklist reading order in the extraction prompt

- **Goal:** Make `fixedRows` arrive column-major for a multi-group checklist, and record the group count when visible.
- **Requirements:** R1, R2
- **Dependencies:** none
- **Files:** `apps/api/src/pdf/tool-schema.ts`, `apps/api/src/pdf/extract.ts`, `apps/api/src/pdf/extract.test.ts`
- **Approach:** Extend the tool description at `tool-schema.ts:14` and the `fixedRows` field description at `:88`. Today they say to emit labels "in order" / "in row order" — ambiguous, which is the root cause. State the contract explicitly: when a checklist prints as several side-by-side column groups sharing one header, emit every item of the **leftmost** printed column top-to-bottom, then the next column, and so on (column-major); and add an optional `columnGroups` integer on the field for the number of side-by-side groups seen. Normalise `columnGroups` in `extract.ts` the way `fixedRows` is (drop when absent or `< 2`). Add a `designNote` when a multi-group checklist is detected so the reviewer is pointed at the split control.
- **Execution note:** The prompt's effect on real output is not unit-testable. Assert the schema/normalisation path (a `columnGroups` value passes through and normalises; `fixedRows` order is preserved), then verify the behaviour by re-extracting `ADMN-FRM-111` (AE5) and confirming column-major order before calling this done.
- **Patterns to follow:** the existing `fixedRows` normalisation and its tests in `extract.test.ts` (the `fixedRows normalization` describe block); the `required`-flag-drop precedent for model-emitted fields the client owns.
- **Test scenarios:**
  - `columnGroups: 3` on a checklist field passes through to the extracted field.
  - `columnGroups` absent, `0`, or `1` normalises to undefined.
  - A multi-group checklist yields a `designNote` mentioning the side-by-side split.
  - `fixedRows` order is preserved end-to-end (guard against reordering).
- **Verification:** `pnpm --filter @formai/api test` passes; a real `ADMN-FRM-111` extraction returns Category A items column-major.

### U2. Add interleave modes to the split, defaulting to down-columns

- **Goal:** Make the split produce one-printed-column groups by default and support the other order explicitly.
- **Requirements:** R3, R6
- **Dependencies:** none (independent of U1; U1 makes the default correct on real data)
- **Files:** `apps/web/src/lib/data/import-session.ts`, `apps/web/src/lib/data/import-session.test.ts`
- **Approach:** Introduce a pure `distributeGroups(items, groups, mode)` where `mode` is `'down-columns' | 'across-rows'`. *down-columns* returns contiguous, near-equal slices (remainder to the earlier groups, mirroring today's remainder rule); *across-rows* returns the current `i % groups` stride. Give `splitTableGroups(id, groups, mode = 'down-columns')` the new parameter and route through the helper. Every existing invariant (fresh ids, geometry/`sourcePosition` dropped from parts, acceptance carry, one undo step, refusal below 2 groups / above item count / on empty rows) stays exactly as shipped.
- **Patterns to follow:** the existing `splitTableGroups` body and its `splitField` reducer action; keep the helper pure and colocated so the preview (U3) can import it.
- **Test scenarios:**
  - `Covers AE1.` down-columns over a column-major 18-item list yields the three printed columns.
  - `Covers AE2.` across-rows over a row-major 18-item list yields the three printed columns.
  - down-columns with an indivisible count puts the remainder in the earlier groups and loses no item.
  - across-rows still reproduces the previously shipped stride result (regression lock).
  - `Covers AE4.` a confirmed source grid does not carry onto any group under either mode.
  - Split-into-1 and more-groups-than-items are still refused under both modes.
- **Verification:** `pnpm --filter @formai/web test` passes; both modes reproduce clean printed columns for their matching extraction order.

### U3. Split preview and mode toggle in the inspector

- **Goal:** Let the reviewer see the resulting groups and flip the order before committing.
- **Requirements:** R2, R4, R5
- **Dependencies:** U2
- **Files:** `apps/web/src/screens/import/inspector/FieldInspector.tsx`, `apps/web/src/screens/import/inspector/FieldInspector.test.tsx` *(add if absent)*
- **Approach:** Extend the existing `SplitGroups` control. Pre-fill the group count from the field's `columnGroups` hint when present (else default 2). Add a *down columns / across rows* toggle. Render a live preview — the item list of each resulting group — by calling `distributeGroups` from U2 with the current count and mode, so the preview is exactly what Split will create (KTD4). Splitting passes the chosen mode to `splitTableGroups`.
- **Patterns to follow:** the current `SplitGroups` component and its `Select` + `Split` button; keep the preview read-only and compact (labels only).
- **Test scenarios:**
  - `Covers AE3.` the preview lists each group's items for the current count and mode.
  - toggling the mode re-renders the preview with the other membership.
  - the count pre-fills from `columnGroups` when the field carries it.
  - clicking Split commits with the previewed mode, and the created fields match the preview.
- **Verification:** `pnpm --filter @formai/web test` passes; on the live app the preview matches the created groups and the toggle recovers a mis-ordered extraction.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Types | `pnpm typecheck` | every unit |
| Web tests | `pnpm --filter @formai/web test` | U2, U3 |
| API tests | `pnpm --filter @formai/api test` | U1 |
| Real re-extraction smoke | import `ADMN-FRM-111`, split Category A | U1, U3 (AE1, AE5) |

## Definition of Done

- Splitting the live `ADMN-FRM-111` Category A checklist into 3 groups yields the three printed columns, each top-to-bottom, with no reviewer action beyond choosing 3.
- The reviewer can preview groups and toggle the order before committing.
- All parent-plan U9 invariants (proposals only, per-field confirmation, geometry not inherited) still hold.
- `pnpm typecheck` clean across all five projects; web and api suites green.

## Open Questions

- **Geometry-based order auto-detection (deferred, robust end-state).** The text layer holds each item label's real (x, y); matching `fixedRows` back to those positions would let the split reconstruct the true 2-D layout and pick the order itself, making both the prompt contract and the toggle unnecessary. Deferred because label-to-glyph matching is fuzzy (duplicate/near-duplicate labels, wrapped lines) and is a larger change than the smoke showed is needed now. Revisit if pinned order + toggle prove insufficient on more documents.
- Should `columnGroups` ever *drive* the split automatically rather than only pre-fill the count? Kept manual here to preserve reviewer authority (KTD3); revisit if reviewers find the pre-fill reliable.
