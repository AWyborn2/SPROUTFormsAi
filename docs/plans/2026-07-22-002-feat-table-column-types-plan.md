# Table column types — check/cross and author-defined dropdown

**Date:** 2026-07-22
**Branch:** `feat/table-column-types` (off `main` @ `435b51b`)
**Asked for:** a ✓/✗ column for audit tables, and a text dropdown column with author-defined
options.

---

## What already exists (checked, not assumed)

Most of this is built. The gaps are narrow.

| Capability | State |
|---|---|
| `RepeatingColumn.options?: string[]` | **exists** (`form-field.ts:99`) |
| `<select>` cell for `dropdown`/`radio` columns | **exists** (`RepeatingGroup.tsx:593`) |
| Two mutually-exclusive buttons in ONE cell, clearing to `null` | **exists** — `explicitYesNo` (`RepeatingGroup.tsx:545`) |
| Tri-state validation: explicit `true` OR `false` answered, `null` not | **exists** for `boolean_yes_no` (`submission-validation.ts:23-27`) |
| Authoring surface for either | **missing** |

So the tri-state that makes "cross = an explicit false, not a blank" work is already correct
and already exempt from review finding H2. This does **not** need the H2/H3 validation pass
first.

## Blocking defect found while scoping

**An explicit `false` exports to the PDF as an empty string.**
`apps/api/src/pdf/round-trip.ts:20`:

```ts
if (typeof value === 'boolean') return value ? 'X' : '';
```

A recorded ✗ is stored correctly in the database and then vanishes from the exported PDF —
indistinguishable from never-answered. For a competency record read as evidence, "assessed
as failing" and "never assessed" become the same artefact. This is adjacent to review
findings M8/M9 but distinct: it applies to every boolean, grouped or not.

It is rarely hit today because `boolean_yes_no` columns cannot be authored. **The moment a
✓/✗ column exists for auditing, every recorded cross disappears from the export.** Fixing it
is part of this feature, not a follow-up — it is the feature's whole point.

### Open question — what does a cross DRAW?

`round-trip.ts:46` embeds `StandardFonts.Helvetica`, which is **WinAnsi**. `✓` (U+2713) and
`✗` (U+2717) are not in WinAnsi and cannot be drawn with it. PR #15's spike found the same
thing from the other side: the dozer form's own tick is a `U+F0FC` Private-Use glyph.

Three routes:

1. **ASCII fallback** — true → `X`, false → `—` (WinAnsi 0x97) or `N`. Zero new
   infrastructure; preserves the true/false distinction; does not look like a tick.
2. **Embed a glyph font** — real ✓/✗ on the page, at the cost of a bundled font asset and
   a larger export.
3. **Draw them as vector strokes** — a tick is two line segments, a cross is two. No font,
   no encoding limits, looks like the printed form. Most work in `round-trip.ts`, but that
   file is being rewritten by PR #15's U3 anyway.

**Needs a decision before the export half is built.** The rest is not blocked.

---

## Design

Its own type, `check_cross`, routed through `boolean_yes_no`'s validated semantics.

Making it a distinct type makes the audit intent explicit in the stored data (a reviewer,
an export, or a future analysis can tell "✓/✗ assessment" from "Yes/No question"). Routing
its *answered-ness* through the existing branch means one validated code path, not two to
keep in sync — which is the cost a separate type usually carries.

It mirrors `boolean_yes_no` exactly on authorability: selectable as a **column** type, not
as a standalone field type (it joins `STRUCTURAL_TYPES` in the reducer). It stores a real
`boolean`, so exports and any downstream analysis get `true`/`false`, not a glyph string
they must interpret.

## Stages

**1 — Shared model.** Add `check_cross` to `FORM_FIELD_TYPES`. In `scalarAnswered`, join the
`boolean_yes_no` branch so explicit `true` **and** `false` count as answered and `null` does
not. Add to `STRUCTURAL_TYPES` and `FIELD_META` in the reducer.

**2 — Cell rendering.** Generalise `explicitYesNo` into a labelled two-option control so it
serves both types (Yes/No vs ✓/✗), and ungate it from `fixedMode` — an open table's
`check_cross` column currently falls through to a plain checkbox and loses the ability to
record an explicit false.

**3 — Authoring.** Add both `Check / Cross` and `Dropdown` to `COLUMN_TYPE_OPTIONS`, and add
a per-column options editor to `ColumnInspector` with a `setColumnOptions` action wired to
both hosts (import session and builder), matching the existing `ColumnActions` contract.

**4 — Export.** Fix `scalarText` so an explicit `false` draws something, per the decision
above. Add the round-trip test that pins it.

**5 — Extraction (optional).** Let the model propose `check_cross` for a ✓/✗ column. Deferred
unless wanted — the authoring surface is enough to correct any table by hand, and PR #15's
spike showed header-glyph detection is its own problem.

## Risks

- **Answer sets.** `resolveAnswerSets` places no type constraint on members (finding H2), so
  nothing stops two `check_cross` columns being grouped into a set — which would be
  incoherent, since each already carries its own true/false. Stage 1 should exclude
  `check_cross` from set membership, which is a narrow slice of the H2 fix.
- **`explicitYesNo` ungating** changes how an existing `boolean_yes_no` column renders in an
  open table (checkbox → two buttons). That is a fix, but it is a visible change to
  already-published forms.
