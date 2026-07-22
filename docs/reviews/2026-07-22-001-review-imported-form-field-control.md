# Code review — imported form field control (PDF import review pipeline)

**Date:** 2026-07-22
**Branch:** `claude/pdf-form-field-customization-c517ab` (merged) vs `main`
**Scope:** 18 commits, 50 files, +6391/−183
**Plan under review:** [docs/plans/2026-07-21-003-feat-imported-form-field-control-plan.md](../plans/2026-07-21-003-feat-imported-form-field-control-plan.md)
**Trigger:** manual testing of the PDF import review screen (ADMN-FRM-111 Light Vehicle Pre-start Checklist)

---

## 1. What the branch does

Three capabilities land together, and most of the defects below live where they meet:

1. **A field inspector before publish.** Imported fields could previously only be triaged
   (confidence, remap-to-signature, checklist items). They can now be renamed, retyped,
   reordered, deleted and extended — through the *same* reducer the builder uses
   (`apps/web/src/lib/field-editor/reducer.ts`, moved out of `screens/builder/`).
2. **Answer sets.** A repeating table's columns can be grouped into a set that must carry
   exactly one answer per row (the OK / N/A / Fault triple). Extraction *proposes* the
   grouping; a reviewer accepts it. New model in `packages/shared/src/answer-set.ts`.
3. **Answer-driven visibility.** A field or section can be shown conditionally on an earlier
   answer, enforced across all four consumers (fill, mobile, validation, round-trip export).
   New model in `packages/shared/src/visibility.ts`.

**Overall assessment.** The architecture is sound and unusually well-documented — the
"one reducer, two hosts" decision is correct and the module headers explain *why* rather
than *what*. Test coverage is genuinely good (`round-trip.test.ts` asserts on decoded glyph
x-positions; `visibility.test.ts` covers fail-open on every unevaluatable path).

The defects cluster in one place: **the boundary between what extraction/authoring can
produce and what validation and rendering can consume.** Several modules independently
decide whether an answer-set column is "answered", and they disagree. That is the theme of
findings H2, M5, M6, M8 and L1.

Two things the design gets *right* that are easy to get wrong, both verified:

- A required field hidden by a visibility condition does **not** block submission.
  `missingRequiredFields` routes through `visibleFields`, which correctly expands section
  scope.
- `stripHiddenValues` iterates to a fixpoint and provably terminates (`kept` shrinks
  monotonically), so a hidden field's answer never reaches the record.

---

## 2. Findings

20 findings: 3 high, 10 medium, 7 low.

### High

---

**H1 — Import inspector offers structural field types the builder deliberately forbids**
`apps/web/src/screens/import/inspector/FieldInspector.tsx:37`, `apps/web/src/screens/import/ImportReviewScreen.tsx:44`
Severity: **high** · Found in manual testing

The builder filters `repeating_group`, `checkbox_group` and `boolean_yes_no` out of its type
dropdown for scalar fields, with a comment explaining why
([BuilderScreen.tsx:67-83](../../apps/web/src/screens/builder/BuilderScreen.tsx#L67)):
a structural field conjured from a text field has no columns and no options. Both import-side
type dropdowns build their options from the raw, unfiltered `FORM_FIELD_TYPES`.

`changeType` ([reducer.ts:202](../../apps/web/src/lib/field-editor/reducer.ts#L202)) seeds
default options only for `dropdown` and `radio`, so the produced field has none.
`FieldRenderer` maps over `field.options ?? []`
([FieldRenderer.tsx:164](../../apps/web/src/screens/fields/FieldRenderer.tsx#L164)) and
renders nothing.

*Failure scenario:* on the review screen, select the `Date` field and set Field type to
**Checkbox group**. The field keeps `required: true` and gains zero options. Publish. On the
fill screen the field renders as a label with no controls, and `missingRequiredFields`
reports it missing on every submit. The form cannot be submitted by anyone, and nothing in
review, publish or fill warns about it. Selecting **Repeating table** produces the
columnless equivalent — the exact case the builder's comment says must not exist.

The guard already exists. Import simply does not call it.

---

**H2 — Answer sets are accepted over columns of any type, but only boolean-ish values count as answered**
`packages/shared/src/answer-set.ts:60,157`, `apps/web/src/screens/import/inspector/column-actions.ts:85`
Severity: **high**

`resolveAnswerSets` places **no type constraint** on member columns, and neither does the
extraction tool schema (`apps/api/src/pdf/tool-schema.ts`) nor the web `groupColumns` action.
But `isChosen` (`answer-set.ts:157`) recognises only `true`, `'true'` and `1` — narrower
than `isCellAnswered` used everywhere else.

*Failure scenario:* the model extracts a Pass / Fail / N/A table and types the three columns
`text` (permitted). It proposes `answerSets: [{key:'status', columnKeys:['pass','fail','na']}]`.
All four resolver checks pass; the set is published. A filler types `✓` into Pass.
`selectedOption` → `isChosen('✓')` is false → `columnKey: null` → `isRowAnswered` false →
`missingRequiredFields` returns the field and `incompleteRowsByField` flags every row.
`POST /submissions` and the public `POST /fill/:token/submissions` return 400 **forever**,
with no input that clears it — the unclearable submit wall the module's own header says the
design prevents. The value is also silently dropped from the exported PDF (see M8).

The same root cause bites historical data: grouping columns on a table that already has
submissions recorded with `'X'` or `'Yes'` retroactively marks every past row unanswered.

Fix belongs in `resolveAnswerSets` (reject members whose `RepeatingColumn.type` is not
boolean-valued) so that extraction, authoring, fill, validation and export cannot disagree.

---

**H3 — Required columns are never enforced on an open repeating table**
`packages/shared/src/submission-validation.ts:148-163`
Severity: **high**

`requiredColumnsFilled` is reachable only via `isRowAnswered`, which is called only from
`incompleteFixedRowIndices` (fixed tables) and the answer-set / `openRowIndices` branches.
For a plain open table, `isFieldAnswered` short-circuits at `return value.length > 0`
(line 160) before any column rule runs.

*Failure scenario:* table `Defects` with `required: true`, no `fixedRows`, no `answerSets`,
columns `[item, fail, comment{required:true}]`. The filler adds one row and leaves every cell
blank. `value.length === 1` → `isFieldAnswered` true → `missingRequiredFields` returns `[]`
→ the submission is accepted with a mandatory column empty. Add `fixedRows` to the same
table and it is correctly rejected. Two table shapes, two different rules.

---

### Medium

---

**M1 — The inspector's options editor omits `checkbox_group` and `checkbox`**
`apps/web/src/screens/import/inspector/FieldInspector.tsx:82`
Severity: **medium**

`isChoice` is `field.type === 'dropdown' || field.type === 'radio'`. A `checkbox_group` has
options and needs them editable.

*Failure scenario:* the reviewed PDF's **Shift** field is extracted as a `checkbox_group`
with options `D` / `N` (the extraction notes say so explicitly). Select it in the inspector:
Label, Field type, Required and the condition editor render — but there is no way to see,
rename, add or remove `D` and `N`. The one correction most likely to be needed on that field
is the one the inspector cannot make. Publishing is the only way to reach an options editor.

---

**M2 — `changeType` neither clears nor seeds structural payload**
`apps/web/src/lib/field-editor/reducer.ts:202-212`
Severity: **medium**

The reducer spreads the old field and overwrites `type`. It seeds `options` for
`dropdown`/`radio`, but never clears `columns`, `answerSets` or `fixedRows` when converting
*away* from `repeating_group`, and never seeds them converting *to* it.

*Failure scenario:* a reviewer retypes an imported checklist table to **Text** to simplify it,
then changes their mind and retypes it back to **Repeating table**. The stale `columns` and
`answerSets` are still attached and reappear — including any answer set that was already
accepted. Conversely, a text field retyped to a table (see H1) carries `columns: undefined`
into `resolveAnswerSets`, whose `columns.length === 0` guard reads `undefined` and throws one
line later at `columns.map`.

---

**M3 — A blank row validates as complete when every answer set is `required: false`**
`packages/shared/src/submission-validation.ts:98-116`
Severity: **medium**

In the `sets.length > 0` branch the legacy `answerColumns(field).some(isCellAnswered)` floor
is skipped entirely, and `sets.filter(s => s.required !== false).every(...)` over an empty
array is vacuously `true`.

*Failure scenario:* columns `[item, ok, na, comment]`, one set `{ok,na}` with
`required: false`, `fixedRows` of 10 items, field `required: true`. The filler submits without
touching the table. `incompleteFixedRowIndices` returns `[]`, so a required 10-item checklist
reports complete with nothing ticked. Remove the answer set and the same submission is
correctly rejected — grouping columns *weakens* validation.

---

**M4 — `AnswerSet.required` is inert unless the containing field is required**
`packages/shared/src/form-field.ts:75` vs `submission-validation.ts:194,221`
Severity: **medium**

`AnswerSet.required` is documented as "Independent of the field's own `required`", but
`missingRequiredFields` and `incompleteRowsByField` both filter on `f.required` before any
row-level work runs.

*Failure scenario:* an optional `Pre-start checks` table carries a set `{ok,na}` marked
`required: true`. The filler leaves half the rows blank. Nothing is reported and no rows are
highlighted. The author set a flag that does nothing, and the UI gives no hint of it.

---

**M5 — Non-contiguous answer-set members misalign the rendered row**
`packages/ui/src/components/RepeatingGroup.tsx:275-292,217-234`
Severity: **medium**

The anchor cell uses `colSpan={memberColumns(set).length}` and every other member renders
`null` — which assumes members are adjacent in `columns`. `resolveAnswerSets` does not
require contiguity, so a non-adjacent proposal is accepted upstream.

*Failure scenario:* `columns = [item, ok, comment, na]` with set `{ok, na}`. The desktop
header row reads `Item | OK | Comment | N/A`; the body row renders `item`, then the answer
control with `colSpan 2`, then the comment input. The answer control sits under
`OK`+`Comment`, and the free-text comment box appears under the `N/A` header. Every row of
the table is mislabelled.

---

**M6 — `usableSets` (UI) and `resolveAnswerSets` (shared) disagree on duplicate keys**
`packages/ui/src/components/RepeatingGroup.tsx:104-122` vs `packages/shared/src/answer-set.ts:76-99`
Severity: **medium**

Shared rejects intra-set duplicates (`duplicate-membership`); the UI checks only
`keys.length < 2`, unknown columns, cross-set claims and the label column.

*Failure scenario:* `columnKeys: ['ok','ok']`. The UI accepts the set and `memberColumns`
filters it to one column, rendering a single-option radio the filler cannot meaningfully
answer. Shared drops the set, so validation falls back to the legacy any-cell rule and
`answerSetForColumn('ok')` returns `undefined`. The two packages describe the same table
differently, and the one the filler sees is the wrong one.

---

**M7 — Two divergent definitions of "is this field's section hidden"**
`packages/shared/src/visibility.ts:193-208` vs `210-231`
Severity: **medium**

`visibleFields` evaluates a section header through the fail-open `evaluate`; `isSectionHidden`
uses the shallow `evaluateSelf`, which lacks the hidden-source and hidden-section guards.

*Failure scenario:* fields `[H1{visibleWhen: Q equals 'yes'}, S, H2{visibleWhen: S equals 'x'}, F, G{visibleWhen: F notEquals 'v'}]`
with `Q='no'` and `F='v'`. `visibleFields` treats H2 as visible (its source `S` is
section-hidden → fail open), so `F` is shown and answered `'v'`, meaning `G` should be
hidden. But `evaluate(G.visibleWhen)` calls `isSectionHidden(F)` → `evaluateSelf(H2)` with
`S` unanswered → false → "section hidden" → `G` is forced visible. If `G` is required it
blocks the submit, and `stripHiddenValues` retains a value it should drop.

Direction is fail-open (over-collects rather than losing data), so this is not a data-loss
bug — but the two evaluators must not diverge.

---

**M8 — Grouped cells holding an unrecognised value are silently erased from the exported PDF**
`apps/api/src/pdf/round-trip.ts:131-140`
Severity: **medium**

Grouped columns are drawn *only* through `selectedOption`, and every grouped key is then
excluded from the ungrouped fallback (line 139).

*Failure scenario:* a submission recorded before the columns were grouped holds
`{ok: 'Y', na: null}`. On export, `isChosen('Y')` is false → the set reads unanswered →
nothing is drawn; the `cols.forEach` fallback skips `ok` because it is in `groupedKeys`. The
pre-branch code printed `Y`. The exported PDF — the artefact read as evidence of what was
recorded — is blank in a cell where the stored record has a value, with no warning anywhere.

---

**M9 — A contradictory row exports as a single clean tick**
`apps/api/src/pdf/round-trip.ts:130-135`
Severity: **medium**

`selectedOption(...).malformed` is computed and discarded.

*Failure scenario:* a non-required grouped table (validation's `isRowAnswered` is reached
only through `missingRequiredFields`, which filters on `f.required`) accepts
`{ok:true, na:true}`. The stored record says both OK and N/A; the exported PDF shows only
`X` under OK. Two artefacts of the same submission disagree, and the PDF is the one an
investigation reads.

---

**M10 — An unvalidated persisted field shape 500s the public fill-submit route**
`packages/shared/src/answer-set.ts:88`, reached via `apps/api/src/routes/forms.ts:107,231`
Severity: **medium**

The publish path types `fields` as `z.array(z.custom<FormField>())`, which is a no-op at
runtime. `resolveAnswerSets` assumes `columnKeys` and `columns` are arrays. Its own header
claims "every resolver here is total".

*Failure scenario:* a member with `forms.edit` publishes a version containing
`answerSets: [{key:'s', columnKeys:'okna'}]` (a string, not an array). Nothing rejects it.
On the next submit, `keys.some(...)` on a string is undefined → TypeError → `withErrorHandling`
returns 500. Every visitor to the **unauthenticated** `POST /fill/:token/submissions` gets
`internal_error` with no recovery path, and the round-trip export 500s too.

Either make the resolver total over unknown input as documented, or validate at publish.

---

### Low

**L1 — Answer-set `key` uniqueness is never enforced** · `apps/api/src/pdf/extract.ts:205-217`
`resolveAnswerSets` dedupes column *membership*, not keys. Two sets both keyed `"status"`
over disjoint columns both survive, and `ungroupAnswerSet(setKey)` then acts on the wrong one
(or both). Separately, `String(s.key)` on an object yields `"[object Object]"` as a persisted
identifier.

**L2 — `answerSets` is spread onto non-`repeating_group` fields** · `apps/api/src/pdf/extract.ts:261`
Harmless today (every consumer gates on `type === 'repeating_group'` first), but it makes the
persisted shape violate the invariant its own type comment states.

**L3 — A contradictory ad-hoc row appended after a fixed set is accepted** · `packages/shared/src/submission-validation.ts:66-83,178-186`
`incompleteFixedRowIndices` iterates only `i < fixedRows.length`, and `openRowIndices` is not
consulted for fixed tables. A row appended to a 10-item checklist with both `ok` and `na`
truthy passes. The one-answer-per-row invariant the grouping exists to enforce is not applied
to those rows.

**L4 — The required asterisk renders on grouped member columns that validation exempts** · `packages/ui/src/components/RepeatingGroup.tsx:213`
`requiredColumnsFilled` deliberately exempts grouped columns (`submission-validation.ts:133-138`),
but the header still shows `c.required`'s marker. An author who marks both `OK` and `N/A`
required produces `OK*` and `N/A*` — two markers the filler cannot both satisfy and that
validation ignores.

**L5 — Rows keyed by index while `AnswerSetCell` holds local state** · `packages/ui/src/components/RepeatingGroup.tsx:262`
Removing row 3 of 5 shifts row 4's data into the instance holding row 3's `focusIndex`, so the
roving tab stop lands on the wrong option. No data corruption — all inputs are prop-controlled.

**L6 — `checkbox_group` is offered as a condition source but can never match** · `ConditionEditor.tsx`
A multi-select answer is an array, which hits `isNonScalarAnswer` → always visible. The
authored condition silently does nothing, and the UI gives no indication.

**L7 — The inspector has no completion affordance** · `apps/web/src/screens/import/inspector/FieldInspector.tsx`
Every edit applies immediately and `Undo` is the escape hatch, but nothing communicates that.
There is no save cue, no close, and no way to deselect. **Delete field** is the only button in
the panel, so the panel reads as a dead end — this was the first thing manual testing reported.
Compounding it: the panel is `sticky top-0 z-10` and ~350px tall, so on a laptop viewport it
covers most of the list it edits and overlays rows as they scroll behind it. The `Required`
toggle also renders twice for every selected field (row and inspector), with two different
aria-labels (`Required: X` and `Required (inspector): X`) — a marker of the duplication.

---

## 3. Areas verified clean

- **Auth and tenant scoping on the rewritten `POST /pdf/round-trip`** (`routes/pdf.ts:157-220`).
  Submission lookup is `and(id, orgId)`; the version is reachable only through that org-scoped
  row; asset download is keyed by `tenant.orgId`. `requireTenant`-only matches its neighbours.
  Replacing the client-supplied `fields`/`values` passthrough with a server-side load is a
  genuine security improvement, and `store.ts:326` was updated in the same branch — no
  client/server contract break.
- **`stripHiddenValues` placement** across `submissions.ts:246,341` and `fill-links.ts:355`.
  Ordering relative to the required-fields gate is consistent at all three doors, the draft
  exemption is re-closed at `draft → approved`, and PATCH accepts only `approved`/`rejected`,
  so there is no bypass.
- **Hidden required fields do not block submission**, and hidden answers never reach the
  record. Both verified by reading the `visibleFields` expansion and the fixpoint bound.
- **Visibility recursion and loops.** `evaluate` → `evaluateSelf`/`isSectionHidden` is strictly
  one level deep. Self-reference and dangling `fieldId` both fail open without crashing.
- **Forward references.** Not blocked in `visibility.ts` itself, but the builder reducer's
  `pruneOrphanedConditions` runs on `move`/`reorder`/drag-drop, and `conditionSources` enforces
  earlier-only at authoring time. `remove` does not prune, but a dangling source fails open.
- **Round-trip coordinate and column mapping.** `colIndex` is built over the full `cols` array
  and `colWidth = pos.width / cols.length` uses the same denominator — grouped and ungrouped
  marks land on the same grid. No off-by-one.
- **No prop mutation in `RepeatingGroup`.** All cells controlled; no uncontrolled→controlled
  transition.

## 4. Test coverage

Strong overall. Notable: `round-trip.test.ts` asserts on decoded glyph x-positions rather than
mere presence; `visibility.test.ts` covers fail-open on every unevaluatable path plus
consecutive headers and end-of-form section scope; `submissions.test.ts` and
`fill-links.test.ts` assert "writes nothing" on every rejection path.

Gaps map onto the findings above:

| Missing test | Finding |
|---|---|
| Grouping non-checkbox columns | H2 |
| Required column on an open (non-fixed) table | H3 |
| Retyping a scalar field to a structural type | H1, M2 |
| All-sets-`required:false` blank row | M3 |
| Non-array `columnKeys` / `columns` reaching the resolver | M10 |
| Non-contiguous answer-set members | M5 |
| Duplicate-key set through the UI path | M6 |
| Grouped cell holding a non-boolean truthy value on export | M8 |
| What `malformed` should render | M9 — `round-trip.test.ts:275` currently pins the buggy behaviour as correct |

Note also that `visibility.test.ts` and `answer-set.test.ts` live under `apps/api/src/routes/`
despite testing `packages/shared` — `packages/shared` has no local test runner. Worth fixing
so shared logic is testable without the API harness.

## 5. Cross-check against PR #15 (`feat/faithful-pdf-round-trip`, U1+U2)

Checked before merging PR #15, to establish whether it resolves any finding above.

**It resolves none of the 20, and conflicts with none of them.** The file sets are disjoint:
PR #15 touches `apps/api/src/pdf/extract.ts` (AcroForm path only — `widgetPosition` /
`extractAcroForm`, not `toAnswerSets`), `packages/shared/src/form-field.ts` (purely additive:
`GeometryBand`, `PageBox`, `FieldGeometry`, `FormField.geometry`), `packages/shared/src/geometry.ts`
(new), `index.ts`, and test fixtures. No finding above lives in any of those lines, and the
fix plan's files are untouched by it.

Merge safety verified: PR #15 is stacked on top of #14 (`3409eac` is an ancestor of
`origin/feat/faithful-pdf-round-trip`), so merging it does not revert the field-customization
work. `FieldInspector.tsx`, `ImportReviewScreen.tsx` and `reducer.ts` on `origin/main` are
byte-identical to the versions reviewed here.

### Two findings independently corroborated

`geometry.ts` encountered the same two problems and solved them **in the new module only**,
citing the old code by name:

- **M10** — `resolveGeometry` guards with `Array.isArray(field.geometry?.segments)`, with the
  comment: *"the route that writes it validates fields with a bare `z.custom<FormField>()` —
  which accepts anything."* Identical root cause. `resolveAnswerSets` still has no such guard.
- **L1** — `bandsValid` rejects `duplicate-band-key` *"mirroring `resolveAnswerSets`, and for
  the same reason"* — but `resolveAnswerSets` dedupes column *membership*, not keys, so the
  behaviour it claims to mirror does not exist.

A second independent author reaching the same conclusions raises confidence in both, and
establishes the fix pattern to copy. Neither is resolved.

### Sequencing consequence for M8 and M9

`geometrySegments()` has **no production consumer** on PR #15 — U3 will wire it into the
exporter, rewriting `round-trip.ts`, which is where M8 and M9 live. **Fix M8/M9 as part of
U3, not before it**, or they will be written twice. Note that `round-trip.test.ts:275`
currently pins M9's behaviour as correct, so U3 must change that assertion deliberately
rather than treat it as a regression.

PR #15's own three residual P2s (page rotation/CropBox ignored, only the first widget
positioned, row-band keys not unique across segments) are recorded in its description and do
not affect the import-review work.

**Verdict: safe to merge; no interaction with the fix plan in either direction.**

## 6. Recommended sequencing

1. **H1, M1, M2 and L7** — web-only, self-contained, and the ones manual testing hits first.
   Planned in [docs/plans/2026-07-22-001-fix-import-inspector-defects-plan.md](../plans/2026-07-22-001-fix-import-inspector-defects-plan.md).
2. **H2** — one decision (constrain answer-set membership to boolean-valued columns in
   `resolveAnswerSets`) resolves H2, M8 and most of L1's blast radius. Needs its own pass;
   it touches the persisted model and wants a migration check for existing forms.
3. **H3, M3, M4** — validation semantics. These want a single deliberate pass over
   `submission-validation.ts` with a decision table, not three point fixes.
4. **M5–M7, M9, M10** and the Low findings — individually small, no ordering constraint.
