---
title: Render the Chosen Answer's Own Glyph on Export
type: fix
date: 2026-07-23
topic: glyph-per-type-rendering
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Render the Chosen Answer's Own Glyph on Export - Plan

## Goal Capsule

- **Objective:** An exported PDF should draw, for each answered cell, the glyph that actually represents the chosen answer — a **checkmark** for a ticked checkbox (grouped OK/NA or independent), the real **tick/cross** for a check/cross column, and literal **Y/N** for a yes/no field. Today several of these wrongly draw a literal `"X"`, so an "OK" prints as "X" and reads as a fail on a compliance record.
- **Source:** live fill+export smoke on `ADMN-FRM-111` — the reviewer confirmed the rule: render what the input represents, per column type.
- **Shape:** a small, contained change in one export function, `drawRepeatingGroup` (`apps/api/src/pdf/round-trip.ts`), plus the scalar checkbox case.

---

## Product Contract

### Problem Frame

`drawRepeatingGroup` (`apps/api/src/pdf/round-trip.ts`) draws the wrong glyph for three of the four answer shapes:

- **Grouped answer-set columns** (the OK/NA house shape) draw a literal `"X"` for whichever member is selected (`mark(columnKey, 'X')`). Selecting **OK** prints "X" — indistinguishable from a fail, and not what the paper convention uses (a tick).
- **Independent checkbox columns** draw `"X"` for true as well.
- **`boolean_yes_no`** draws `"X"` for true and `"N"` for false. True should read as **Y**.
- **`check_cross`** already draws a real tick or cross via `drawMark` — correct, no change.

The reviewer's rule, stated on the smoke: the glyph always renders what the chosen input represents. A checkbox (grouped or independent) is a checkmark; a check/cross is its selected mark; a yes/no is Y or N.

The tick glyph cannot be drawn as font text — the page font is `StandardFonts.Helvetica` (WinAnsi), which has no `✓`. That is exactly why `check_cross` uses `drawMark` (vector line segments). The checkmark cases must therefore route through `drawMark('tick', …)`, not `drawText`.

### Requirements

- R1. A selected grouped answer-set member renders a **checkmark** (vector tick via `drawMark`), not `"X"`.
- R2. A ticked **independent checkbox** column renders a checkmark, by the same rule.
- R3. A `boolean_yes_no` column renders **Y** for true and **N** for false.
- R4. `check_cross` is unchanged — the selected tick or cross still renders.
- R5. An unanswered / blank cell stays blank in every case (no glyph drawn), exactly as today.
- R6. Every glyph is placed by the shared `markPlacement` so it lands where the review preview shows it (no placement regression).

### Acceptance Examples

- AE1. **Covers R1.** Given a row whose OK member of an OK/NA set is chosen, when exported, then a tick is drawn in the OK cell and the NA cell is blank.
- AE2. **Covers R2.** Given an independent checkbox column ticked true, when exported, then a tick is drawn.
- AE3. **Covers R3.** Given a `boolean_yes_no` column, when exported, then true draws `Y` and false draws `N`.
- AE4. **Covers R4.** Given a `check_cross` column, when exported, then true draws a tick and false a cross (unchanged).
- AE5. **Covers R5.** Given an unanswered cell of any type, when exported, then nothing is drawn there.

### Scope Boundaries

Not in this plan: the draw-by-hand geometry tool (`2026-07-23-004`), the derivation collision fix (`2026-07-23-007`), and the review-card confirm button (`2026-07-23-006`). This plan changes only which glyph the exporter draws per column type; it does not touch geometry, placement, or capture.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The rule is "render the chosen answer's own mark," keyed on column type.** Checkbox (grouped or independent) → tick; check/cross → its selected mark; yes/no → Y/N. One consistent principle, applied at the single point where the exporter chooses the glyph.
- KTD2. **Checkmarks use `drawMark('tick', …)`, not `drawText`.** The page font cannot render `✓`; `drawMark` already draws a vector tick for `check_cross` and takes the same `markPlacement` coordinates. Reuse it so the checkmark cases and `check_cross` produce an identical tick.
- KTD3. **Placement stays shared.** Every glyph — tick, cross, Y, N — is positioned via the `markPlacement` helper already used across export and the review preview, so this change never moves a mark, only swaps which glyph is drawn.

### Verification of coverage

The four answer shapes are exercised on the fixture already used by `round-trip.test.ts`; extend those cases rather than inventing synthetic geometry.

---

## Implementation Units

### U1. Draw the chosen answer's glyph per column type

- **Goal:** Grouped and independent checkboxes render a tick; yes/no renders Y/N; check/cross unchanged.
- **Requirements:** R1, R2, R3, R4, R5, R6
- **Dependencies:** none
- **Files:** `apps/api/src/pdf/round-trip.ts`, `apps/api/src/pdf/round-trip.test.ts`
- **Approach:** In `drawRepeatingGroup`: (1) the grouped answer-set path that currently calls `mark(columnKey, 'X')` instead draws a tick via `drawMark('tick', …)` at the column's `markPlacement`; (2) the `boolean_yes_no` (non-`check_cross` self-answering) path draws `Y` for true instead of `X` (keep `N` for false); (3) the independent-checkbox path (the non-self-answering `typeof raw === 'boolean'` branch that draws `'X'` for true) draws a tick via `drawMark` instead. Leave `check_cross` and all blank/unanswered handling exactly as they are. Confirm whether an independent `checkbox` column is in `SELF_ANSWERING`; whichever branch it currently takes, its true case must become a tick.
- **Execution note:** Characterize first — the existing `round-trip` tests assert specific drawn glyphs/positions; update them to the new rule deliberately (they are the specification of correct output), and confirm no *placement* assertion changes (only the glyph).
- **Patterns to follow:** the existing `check_cross` → `drawMark('tick'|'cross', …)` call and the shared `markPlacement`.
- **Test scenarios:**
  - `Covers AE1.` a chosen OK/NA member draws a tick (assert `drawMark` tick, not text `"X"`); the other member's cell is blank.
  - `Covers AE2.` an independent checkbox true draws a tick.
  - `Covers AE3.` `boolean_yes_no` true draws `Y`, false draws `N`.
  - `Covers AE4.` `check_cross` true/false still draw tick/cross (regression lock).
  - `Covers AE5.` unanswered cells of each type draw nothing.
  - a mark's position is unchanged from before (placement regression lock via `markPlacement`).
- **Verification:** `pnpm --filter @formai/api test` passes; a filled `ADMN-FRM-111` export shows ticks (not "X") on OK/NA rows.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Types | `pnpm typecheck` | U1 |
| API tests | `pnpm --filter @formai/api test` | U1 |
| Real smoke | fill + export `ADMN-FRM-111`, inspect glyphs | U1 |

## Definition of Done

- Grouped and independent checkboxes export a checkmark; `boolean_yes_no` exports Y/N; `check_cross` unchanged; blanks stay blank.
- No mark position changes — only the glyph.
- `pnpm typecheck` clean; api suite green.

## Open Questions

- None blocking. If an independent `checkbox` column turns out to share the `boolean_yes_no` branch, the tick rule still applies to it — confirm the branch in code and route both correctly.
