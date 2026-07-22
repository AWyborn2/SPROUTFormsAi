# Fix — import review inspector defects and accordion field editing

**Date:** 2026-07-22
**Review:** [docs/reviews/2026-07-22-001-review-imported-form-field-control.md](../reviews/2026-07-22-001-review-imported-form-field-control.md)
**Scope:** findings H1, M1, M2, L7 (+ L4, L6 as cheap riders). Web package only — no API,
no schema, no migration.
**Not in scope:** H2, H3, M3–M10. Those touch the persisted answer-set model and validation
semantics and need their own pass (see review §5).

---

## Problem

Two things are wrong with the import review screen, and they compound.

**Correctness.** The inspector lets a reviewer convert any field into a structural type the
builder deliberately forbids, producing an optionless `checkbox_group` or a columnless
`repeating_group` — a field that renders nothing but still blocks submit if required (H1).
It cannot edit the options of a `checkbox_group` that extraction legitimately produced, which
is the reviewed PDF's own `Shift` field (M1). And a type change leaves stale `columns` /
`answerSets` / `fixedRows` attached (M2).

**Interaction.** The inspector is a ~350px sticky panel floating above the list it edits.
It applies every change immediately but says so nowhere, has no close, and its only button is
**Delete field** — so it reads as a dead end. On a laptop viewport it covers most of the list
and overlays rows scrolling behind it (L7).

The interaction fix is not a Done button. The panel's problem is that it is *detached from
the thing it edits* — a Done button would confirm an edit whose target is off-screen. Moving
the editor **inside the row** makes the connection structural: the row you expanded is the
row you are editing, and collapsing it is the natural "I'm finished".

---

## Approach

Replace the floating panel with an **accordion**: each review row expands in place to reveal
the editor, one at a time, mounted only while open.

This falls out of the existing design rather than fighting it. `ImportReviewScreen` already
has exactly one `selectedFieldId`, shared with the PDF pane. Under the accordion,
**selected === expanded** — clicking a PDF highlight expands that row; collapsing deselects.
No second piece of state, and the PDF↔list sync keeps working unchanged.

"Lazy" is load-bearing, not just tidy: `FieldInspector` mounts `ColumnInspector` and
`ConditionEditor`, and `ConditionEditor` reads the whole session to derive its source list.
Mounting one instead of ten is a real saving on a large import.

### Before / after

```
BEFORE                                  AFTER
┌──────────────────────────┐            ┌──────────────────────────┐
│ 10 fields extracted      │            │ 10 fields extracted      │
├──────────────────────────┤            │              [Undo][Redo]│  ← sticky
│  [Undo] [Redo]           │  ← sticky  ├──────────────────────────┤
│ ┌──────────────────────┐ │    panel   │ ▸ Date          95% ✓   │
│ │  No field selected   │ │    covers  │   Required        [ on ] │
│ │  Pick a field…       │ │    the     ├──────────────────────────┤
│ └──────────────────────┘ │    list    │ ▾ Asset No      90% ✓   │  ← expanded
├──────────────────────────┤            │   Required        [ on ] │
│ Date            95% ✓   │            │   ┌────────────────────┐ │
│ Asset No        90% ✓   │            │   │ Label  [Asset No ] │ │
│ Site            90% ✓   │            │   │ Type   [Text     ] │ │
│ …                        │            │   │ Options / Columns  │ │
└──────────────────────────┘            │   │ Show this field    │ │
                                        │   │ Insert below       │ │
                                        │   │ Delete field       │ │
                                        │   └────────────────────┘ │
                                        ├──────────────────────────┤
                                        │ ▸ Site          90% ✓   │
                                        └──────────────────────────┘
```

The **"No field selected"** prompt disappears entirely. Its only job was holding layout for a
panel that no longer floats; with the editor inside the row, a chevron on every row already
says "there is more here".

---

## Stage 1 — Correctness (independent of the layout change)

Ship-able on its own; do this first so the fixes are not entangled with the redesign.

### 1.1 Stop offering structural types on the import side (H1)

`typeOptionsFor()` and `STRUCTURAL_TYPES` currently live in
`apps/web/src/screens/builder/BuilderScreen.tsx:67-83`. Move both to
`apps/web/src/lib/field-editor/reducer.ts` (which is already the shared home for
`FIELD_META` and `PALETTE`), export them, and consume from all three call sites:

| Call site | Change |
|---|---|
| `BuilderScreen.tsx:851` | import instead of defining locally |
| `inspector/FieldInspector.tsx:37` | replace raw `FORM_FIELD_TYPES.map` with `typeOptionsFor(field.type)` |
| `ImportReviewScreen.tsx:44` | same, for the low-confidence rescue dropdown |

`typeOptionsFor` already keeps a structural field's *own* type in its list, so an imported
table still shows "Repeating table" and is not silently mislabelled. That behaviour is what
we want on the import side too, unchanged.

### 1.2 Edit `checkbox_group` and `checkbox` options (M1)

`FieldInspector.tsx:82` — widen `isChoice`:

```ts
const isChoice = field.type === 'dropdown' || field.type === 'radio' || field.type === 'checkbox_group';
```

`checkbox` stays out: it is a single boolean, not an option list. Verify against
`FieldRenderer.tsx:164` that `checkbox_group` renders from `field.options` — it does.

### 1.3 Make `changeType` clean up after itself (M2)

`reducer.ts:202-212`. Currently it spreads the old field, overwrites `type`, and seeds
options for `dropdown`/`radio` only. Change to explicitly reconcile the type-specific payload:

- entering `dropdown` / `radio` / `checkbox_group` with no `options` → seed `['Option 1', 'Option 2']`
- leaving a choice type → drop `options`
- leaving `repeating_group` → drop `columns`, `answerSets`, `fixedRows`
- leaving `section_header` → nothing extra (it has no payload)

With 1.1 in place, *entering* `repeating_group` is unreachable from either editor, so this
only needs the leave-side clear. Keep it a pure `mutate` so undo/redo still snapshots
correctly.

### 1.4 Cheap riders

- **L4** — `RepeatingGroup.tsx:213`: suppress the required asterisk on columns that belong to
  a resolved answer set, since `requiredColumnsFilled` exempts them
  (`submission-validation.ts:133-138`). One-line guard using the existing `usableSets`.
- **L6** — `ConditionEditor.tsx`: drop `checkbox_group` from `conditionSources`. Its array
  answer hits `isNonScalarAnswer` and the condition can never match, so offering it authors a
  silent no-op.

### 1.5 Tests for stage 1

Extend `FieldInspector.test.ts` and `reducer.test.ts`:

- `typeOptionsFor('text')` excludes all three structural types; `typeOptionsFor('repeating_group')`
  includes `repeating_group` exactly once and no other structural type
- `checkbox_group` renders the options editor; `checkbox` does not
- `changeType` `repeating_group → text` drops `columns`/`answerSets`/`fixedRows`
- `changeType` `text → dropdown` seeds two options; `dropdown → text` drops them
- `changeType` round-trip `dropdown → text → dropdown` does not resurrect the old options

---

## Stage 2 — Accordion (L7)

### 2.1 Selection semantics

In `ImportReviewScreen`, `selectedFieldId` gains a second meaning: expanded. Three changes:

- `handleSelectField(id)` — when `id === selectedFieldId`, set `null` (toggle closed).
  Otherwise select and expand as today, keeping both `scrollIntoView` calls.
- PDF highlight click already routes through `handleSelectField`, so it expands the row for
  free. Keep the smooth scroll — it now scrolls to a row that is about to grow, so scroll
  **after** the state commit (a `useEffect` on `selectedFieldId` rather than inline in the
  handler) or the target lands short.
- `lowest` ("Lowest: Faults · 75%") also routes through `handleSelectField` and gains
  expand-on-jump, which is the behaviour you want there.

### 2.2 Move the inspector into the row

`ImportReviewScreen.tsx:242-269` — delete the sticky `<div>` wrapping `FieldInspector`.
Move `<Undo/Redo>` into the "10 fields extracted" summary card at line 203, which is already
at the top of the column; make **that** card sticky instead. It is short, so it does not
occupy the viewport the way the panel does.

`ReviewRow` gains `expanded: boolean` and renders `<FieldInspector>` at the end of its body,
inside the same bordered card, when `expanded` is true. Pass `index`/`count`/`onSelect`
through from the parent as the panel receives them today.

Because the inspector is only mounted for the expanded row, `inspectorMode`'s `'prompt'`
branch becomes dead. Delete the branch and narrow `FieldInspectorProps.field` from
`ReviewField | undefined` to `ReviewField`. Update `FieldInspector.test.ts` accordingly —
the two tests asserting the prompt state (nothing selected, selection deleted) are replaced
by one asserting that deleting the expanded field collapses the accordion.

### 2.3 Drop the duplicated `Required` toggle

`Required` currently renders twice for a selected field — `ReviewRow` (line 508) and
`FieldInspector` (line 158) — with two different aria-labels (`Required: X` and
`Required (inspector): X`), which is how the duplication shows up in the tests.

Keep it **on the row**, remove it from the inspector. Required is a triage property worth
seeing at a glance across all ten fields without expanding any of them, and it is the one
control that already works on a collapsed row. Delete the `Required (inspector)` aria-label
and its test.

### 2.4 Affordance and accessibility

The current row is a `<div>` with `onClick` (`ImportReviewScreen.tsx:352-362`) — not
focusable, not keyboard-operable, no state announced. The accordion makes this worse, so fix
it in the same pass:

- Row header becomes a `<button>` with `aria-expanded` and `aria-controls` pointing at the
  inspector region; the region gets `role="region"` and `aria-labelledby` back to the header.
- Chevron (`chevron-right` → `chevron-down`) at the left of the header, rotating on expand.
- The header button wraps only the icon/label/confidence cluster — **not** the nested
  interactive content (`Required` switch, checklist inputs, rescue `Select`), which cannot be
  nested inside a button. Those keep their existing `stopPropagation` wrappers.
- Expanded row keeps the current `ring-2` selected treatment, so selection and expansion read
  as one state rather than two.

### 2.5 Tests for stage 2 — NOT WRITTEN (deliberate, 2026-07-22)

The plan assumed `apps/web` could render components. It cannot: `vitest.config.ts`
sets `environment: 'node'` and includes only `src/**/*.test.ts`, and the package has neither
`jsdom` nor `@testing-library/react` (only `packages/ui` does). Every assertion below needs a
DOM.

Offered and **declined**: adding those two devDependencies to `apps/web`, mirroring
`packages/ui`'s versions. **Stage 2 therefore ships with no automated coverage.**

What remains unverified — the list to walk by hand, and to re-walk after any change to
`ReviewRow`:

- clicking a row header expands it; clicking again collapses
- expanding row B collapses row A (one at a time)
- `FieldInspector` is not in the document for a collapsed row (the lazy-mount guarantee)
- selecting a PDF highlight expands the corresponding row
- deleting the expanded field collapses the accordion and leaves no inspector mounted
- header button exposes `aria-expanded` matching state
- `Required` renders exactly once per row, expanded or not

Stage 1's logic is fully covered (15 new tests) — the gap is Stage 2's rendering only.
`vitest.config.ts` already carries the note "switch to jsdom if component tests arrive
later", so the door is open whenever this is revisited.

---

## Risks

- ~~`FieldInspector` is shared with the builder~~ — **checked, it is not.** `BuilderScreen`
  imports only `ColumnInspector` (line 856) and `ConditionEditor` (line 863); `FieldInspector`
  has exactly one consumer, `ImportReviewScreen.tsx:263`. Stage 2's prop narrowing and toggle
  removal are import-only and cannot affect the builder. What *is* shared is the reducer,
  which stage 1.1 and 1.3 touch — so the builder's own type dropdown and retype behaviour
  must be re-tested even though no builder file changes in stage 2.
- **Sticky scroll interaction.** Expanding a row below the fold plus `scrollIntoView` plus a
  now-sticky summary card can fight each other. Verify in the browser at a laptop height
  (the reported viewport is ~900px), not just in tests.
- **Undo/redo across collapse.** `deleteField` currently calls `onSelect(null)`. Under the
  accordion that collapses the row; undoing the delete restores the field *collapsed*, which
  is acceptable but should be confirmed rather than assumed.

## Verification

1. `pnpm test` in `apps/web` and `packages/ui` — the suite was green at 511 tests as of
   2026-07-21; no API or shared changes here, so nothing else should move.
2. Manual, against the same `ADMN-FRM-111` PDF:
   - `Date` → Field type no longer offers Checkbox group / Repeating table / Yes-No
   - `Shift` (extracted as `checkbox_group`) → options `D` and `N` are editable
   - expand a Category A/B/C table → Columns and answer-set editors appear inside the row
   - collapse, publish, open the fill view → no invisible or unsatisfiable fields
