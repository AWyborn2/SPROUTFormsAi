---
title: Tighten Derived Row Bands at the Table's End
type: fix
date: 2026-07-23
topic: geometry-overlay-tighten
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Tighten Derived Row Bands at the Table's End - Plan

## Goal Capsule

- **Objective:** A derived grid should cover only the table's own rows. Today the last row band runs one row too far, absorbing the *next* section's heading line, so the overlay visibly leaks into the following table and a split table reports one extra row (7/3/2 against a printed 6/2/2 on `ADMN-FRM-111`).
- **Root cause:** row derivation keeps every baseline beneath the header that shares the label margin, bounded only by the next detected header. A between-tables section heading (`Category 'B' faults: …`) prints at the same left margin as the item labels, so it passes the margin filter and is counted as a final row.
- **Shape of the fix:** teach row derivation to stop at the last genuine item row by recognising a section-heading / prose line geometrically — it runs wide, across the option-column region, where a real item label stays confined to the label column. Tighten only; never drop a real row.
- **Why it is low-risk but not cosmetic:** the extra row is visible, not a wrong mark, so nothing mis-exports today. But it makes the overlay read as imprecise and inflates split row counts, and the same wide-line signal is a clean, measurable discriminator worth having.

---

## Product Contract

### Problem Frame

`rowBands` (`apps/web/src/lib/pdf-geometry.ts`, ~line 500-525) builds the row set from the baselines beneath the header that share the label margin:

```
below = rows beneath header, filtered to |item.x − labelLeft| ≤ LABEL_MARGIN_TOLERANCE, sorted top-down
… merge wrapped continuation lines …
each baseline → a band spanning to its neighbours' midpoints
```

The floor is the next detected header (`proposeTableSegments`, `headers[index+1].row.y`). Between the last Category A item and the Category B header sits the line `Category 'B' faults: The machine MUST NOT be operated…`. It begins at the label margin (`x ≈ 37.5`), so it passes the margin filter and becomes an extra baseline — hence a 7th row band on a 6-row table. The overlay (`BandGrid` in `apps/web/src/screens/import/PdfViewer.tsx`) draws that band, so the green grid bleeds into the next section's heading.

The distinguishing fact is geometric and already in hand: an **item label** is confined to the label column (its option cells above are blank), while a **section heading / instruction line** runs across the page, well past where the option columns start. Width, not wording, separates them — consistent with the module's doctrine of keying on geometry, never characters (parent KTD4).

### Requirements

- R1. Row-band derivation stops at the last genuine item row. A section-heading or instruction line printed at the label margin between two tables is not counted as a row, even though it shares the margin.
- R2. The discriminator is geometric: a line whose horizontal extent runs into or past the option-column region (a threshold calibrated across ≥3 library documents) is treated as non-item and ends the row set.
- R3. The change only ever *removes* a trailing non-item row. No document in the surveyed library loses a real item row, proven by re-running the library sweep against the U7/U8 baseline.

### Acceptance Examples

- AE1. **Covers R1.** Given `ADMN-FRM-111` Category A (6 printed item rows) followed by the `Category 'B' faults:` heading at the label margin, when the grid is derived, then it has 6 row bands and none covers the heading line.
- AE2. **Covers R1.** Given the same table split into 3 groups, when the split runs, then the groups have 6/2/2 items — the previously extra row is gone.
- AE3. **Covers R3.** Given the eight surveyed documents, when the sweep is re-run, then every document's proposal and row counts match the U7/U8 baseline except the intended tightening.

### Scope Boundaries

Not in this plan: the split-order fix (`2026-07-23-001`) and the drag/snap/glyph work (`2026-07-23-003`). This plan touches only row-band derivation and its overlay consequence.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Discriminate by horizontal extent, not text.** A row is an item row when its content stays within the label column; it is a heading/prose line when it runs into or past the option-column region. The option columns' left edge is already known to the derivation (the anchor/band positions), so "runs past the label column into the options" is a measurable, character-free test — the same doctrine that keeps header detection off glyph identity.
- KTD2. **Stop, don't skip.** Once a wide non-item line appears beneath the last item, the table has ended; terminate the row set there rather than skipping the line and continuing — a genuine item never follows the next section's heading, and continuing risks pulling in the next table's rows.
- KTD3. **Calibrate the width threshold across ≥3 documents, or refuse to add it.** Consistent with the parent plan's calibration rule. If a single measurable threshold cannot separate item labels from headings across at least three library documents, this fix is not shipped as written and the finding is recorded instead.
- KTD4. **Prove the tightening by an unchanged sweep.** The library sweep is the regression guard: every count must equal the U7/U8 baseline except the deliberate `ADMN-FRM-111` reduction. A drop anywhere else means the discriminator is too aggressive.

---

## Implementation Units

### U1. Stop row derivation at the last item row

- **Goal:** Exclude a between-tables heading/prose line from the derived row set.
- **Requirements:** R1, R2
- **Dependencies:** none
- **Files:** `apps/web/src/lib/pdf-geometry.ts`, `apps/web/src/lib/pdf-geometry.test.ts`
- **Approach:** In `rowBands`, after the margin filter and before banding, cut the baseline list at the first line whose horizontal extent crosses into the option-column region (its rightmost extent reaches at/beyond the leftmost option anchor, minus a small tolerance). Item labels stay left of the options; the section heading spans across them. Derive the threshold from the option anchors the function already has, and calibrate the tolerance against `ADMN-FRM-111` plus at least two more documents with trailing prose (the dozer family and one other).
- **Execution note:** Proof-first. Add the `ADMN-FRM-111` Category A rows (6 item rows + the wide `Category 'B' faults:` line) as a failing test asserting 6 bands, then implement the cut.
- **Patterns to follow:** the existing margin filter and wrapped-line merge in `rowBands`; the measured-fixture testing style in `pdf-geometry.test.ts` (real coordinates, not synthetic).
- **Test scenarios:**
  - `Covers AE1.` 6 item rows at the label margin followed by a wide heading line yield 6 bands; none covers the heading.
  - a table whose last item is genuinely the final line on the page still yields all its rows (no false cut).
  - a wrapped continuation line (still within the label column) is merged as today, not treated as a heading.
  - a heading line flush at the label margin but running full-width is excluded regardless of its text.
- **Verification:** `pnpm --filter @formai/web test` passes; `ADMN-FRM-111` derives 6 Category A rows.

### U2. Re-run the library sweep and confirm no regression

- **Goal:** Prove the tightening removes only the intended row.
- **Requirements:** R3
- **Dependencies:** U1
- **Files:** *(no source changes; verification unit)* sweep harness at the scratchpad `library-smoke.mjs`, fixtures in `E:\Claude Code\Claude Designs\brand-form-ai-assessment-templates\project\uploads` plus `ADMN-FRM-111`.
- **Approach:** Rebuild the module bundle (esbuild, `--alias:@formai/shared=…/packages/shared/src/index.ts`, pdfjs by absolute `file://`) and run the sweep. Compare proposal counts and average row counts against the U7/U8 baseline: Dozer 24, Small Loader 16, Scraper 5, Grader 1, Small Excavator 1, Tip Head 0, Escort 0, SME Theory 0. Any document whose counts fall (other than `ADMN-FRM-111` losing its trailing row) means the discriminator over-reached — return to U1.
- **Test expectation:** none (verification-only unit); the assertion is the sweep diff.
- **Verification:** sweep matches the baseline except the intended `ADMN-FRM-111` tightening; the split now reports 6/2/2 (AE2).

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Types | `pnpm typecheck` | U1 |
| Web tests | `pnpm --filter @formai/web test` | U1 |
| Library sweep | bundle + `library-smoke.mjs` across all eight documents | U2 |

## Definition of Done

- The `ADMN-FRM-111` Category A grid derives 6 row bands; the overlay no longer covers the `Category 'B'` heading.
- Splitting Category A reports 6/2/2 items.
- The library sweep is unchanged from the U7/U8 baseline except the intended tightening.
- `pnpm typecheck` clean; web suite green.

## Open Questions

- If no single width threshold separates item labels from headings across ≥3 documents (KTD3), this fix is refused as written; the fallback is to end the row set at the next detected header's *preceding* line only when that line also fails a boldness/spacing check — recorded here rather than built speculatively.
