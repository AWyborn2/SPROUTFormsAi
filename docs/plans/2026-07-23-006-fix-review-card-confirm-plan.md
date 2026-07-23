---
title: A Plain Confirm Action and Type-Appropriate Suggestions on the Review Card
type: fix
date: 2026-07-23
topic: review-card-confirm
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Review-Card Confirm and Type-Appropriate Suggestions - Plan

## Goal Capsule

- **Objective:** A field flagged for review should offer a plain **"this is correct"** confirm action, and its correction suggestion should fit the field's type. Today the flagged-field card offers only **"Remap to Signature"** or a type dropdown — there is no way to simply affirm the field, and "Remap to Signature" is offered even for a repeating table, where it is nonsensical.
- **Source:** live review smoke on `ADMN-FRM-111` — a low-confidence `FAULTS` repeating table showed "Remap to Signature" as its only suggested action, with no confirm-as-is button.
- **Shape:** a contained review-UX change in `apps/web/src/screens/import/ImportReviewScreen.tsx`, wiring the existing confirm action and gating the remap suggestion by type.

---

## Product Contract

### Problem Frame

The flagged-field triage card in `apps/web/src/screens/import/ImportReviewScreen.tsx` presents, for a low-confidence field, a **"Remap to Signature"** button plus a type dropdown. Two problems:

- **No plain confirm.** A reviewer who has looked at a flagged field and judged it correct has no single action to say so. The session already has the action — a confirm path sets the field `resolved` (e.g. `confirmTable` / `setMeta({ resolved: true })`) — but the card does not surface a generic "looks right" button. The "1 need review" flag then nags indefinitely even after a human has verified the field.
- **The suggestion ignores field type.** "Remap to Signature" is the correction for a *text* field the model should have typed as a signature. Offering it on a `repeating_group` (or any non-text field) is a suggestion that makes no sense and, worse, is the *only* prominent action shown.

### Requirements

- R1. A flagged field offers a plain **confirm / "looks right"** action that marks it resolved (clearing it from the review-needed count) without changing its type.
- R2. The **"Remap to Signature"** suggestion appears only where it is meaningful — a `text`-typed field (the case it was built for) — and never on a repeating table or other non-text type.
- R3. Confirming a field is a review-metadata change only: it sets `resolved`, never alters the published field shape (parity with the existing confirm actions).
- R4. The type dropdown remains available for genuine type corrections; only the nonsensical standalone remap suggestion is gated.

### Acceptance Examples

- AE1. **Covers R1.** Given a low-confidence repeating table, when the reviewer clicks the confirm action, then the field is marked resolved and the "needs review" count drops by one, with the field's type unchanged.
- AE2. **Covers R2.** Given a flagged repeating table, when its card renders, then no "Remap to Signature" action is shown; given a flagged `text` field, then it still is.
- AE3. **Covers R3.** Given a confirmed field, when the review is published via `reviewedToFields`, then the published field is identical to before confirming (no `resolved`/metadata leakage).

### Scope Boundaries

Not in this plan: the glyph rule (`2026-07-23-005`), the draw-by-hand tool (`2026-07-23-004`), and the derivation collision fix (`2026-07-23-007`). This plan changes only the flagged-field card's actions — the confirm affordance and the type-gating of the remap suggestion.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Wire the confirm action that already exists; don't invent state.** The import session already exposes confirm/resolve actions that set `resolved` in `reviewMeta` (the same mechanism `confirmTable`/`setType` use). The card just needs a button that calls the generic one for the selected field. `resolved` already reads as `ok` in `reviewStatus`, so the count updates for free.
- KTD2. **Gate the remap by field type at the card.** "Remap to Signature" is meaningful only for a `text` field; render it conditionally on `field.type === 'text'` (mirroring the existing `isChoice`/`isTable` type-branching already used in the inspector). Everything else keeps the type dropdown for genuine corrections.
- KTD3. **Confirm is metadata-only, matching the publish boundary.** Setting `resolved` must not touch the published field — `reviewedToFields` already strips review metadata (`note`, `resolved`), so confirming stays invisible downstream (R3), exactly as `confirmTable` does today.

---

## Implementation Units

### U1. Add a confirm action and type-gate the remap suggestion

- **Goal:** Every flagged field can be confirmed as-is, and "Remap to Signature" only shows for text fields.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** none
- **Files:** `apps/web/src/screens/import/ImportReviewScreen.tsx`, `apps/web/src/screens/import/inspector/FieldInspector.test.ts` (or the nearest review-logic test), and the import-session action surface in `apps/web/src/lib/data/import-session.ts` if a generic confirm action needs exposing.
- **Approach:** In the flagged-field card, add a primary **"Looks right"** (confirm) button that resolves the selected field via the existing confirm/resolve action (set `resolved: true` in `reviewMeta`); if only table-specific confirm exists today, generalise it to any field type. Wrap the "Remap to Signature" button in a `field.type === 'text'` condition. Leave the type dropdown as-is.
- **Patterns to follow:** the existing `confirmTable`/`remapSignature`/`setType` actions and their `setMeta({ resolved: true })` usage in `import-session.ts`; the `isTable`/`isChoice` type-branch pattern in `FieldInspector.tsx`; the `reviewStatus` mapping of `resolved → ok`.
- **Test scenarios:**
  - `Covers AE1.` confirming a repeating table sets `resolved` and the field reads as `ok` in `reviewStatus`, type unchanged.
  - `Covers AE2.` the remap suggestion is present for a `text` field and absent for a `repeating_group` (assert via the card's render condition or a small pure predicate).
  - `Covers AE3.` a confirmed field publishes identically through `reviewedToFields` (no `resolved`/`note` on the published field).
  - confirming an already-resolved field is idempotent.
- **Verification:** `pnpm --filter @formai/web test` passes; on the app, a flagged table can be confirmed and drops out of the review count, and shows no signature-remap suggestion.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Types | `pnpm typecheck` | U1 |
| Web tests | `pnpm --filter @formai/web test` | U1 |

## Definition of Done

- A flagged field of any type can be confirmed as correct, clearing it from the review-needed count without changing its type.
- "Remap to Signature" appears only for text fields.
- Confirming changes nothing that publishes.
- `pnpm typecheck` clean; web suite green.

## Open Questions

- Exact label/placement of the confirm button on the card — resolve during U1 for visual fit; the requirement only fixes that a plain confirm exists and updates the count.
