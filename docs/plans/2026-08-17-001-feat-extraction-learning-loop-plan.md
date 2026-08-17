---
title: "feat: Extraction learning loop — distil reviewer corrections into candidate prompt rules"
date: 2026-08-17
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
origin: PR #240 (feat/extraction-capture — Stage 2a capture)
---

# feat: Extraction learning loop — distil reviewer corrections into candidate prompt rules

## Product Contract

### Summary

Turn the way reviewers correct each PDF extraction into evidence that makes the
next extraction better — without ever mutating the prompt behind anyone's back.
Stage 2a (shipped, PR #240) stores the raw extraction. This plan adds **2b**:
compute the structured diff between the raw extraction and the reviewer-approved
form, store it, and cluster recurring corrections into org-agnostic *shapes*; and
**2c**: surface those shapes as *candidate* profile rules / few-shot examples a
human promotes through a normal, test-gated PR. The loop is closed by a person,
not by the model. The one thing it does autonomously is *notice* — it counts how
often the same mistake is corrected, and measures whether a promoted rule
actually reduced that count.

### Problem Frame

Extraction is a model reading a printed form, and it errs in patterned ways: an
open question read as a radio, an orphaned lettered choice emitted as its own
field, a checklist collapsed into questions, a single-answer question marked
`multiple`. The reviewer fixes each in the builder, and that correction is the
only record of what was wrong. Today the two things needed to learn from it are
split:

- **The raw extraction** (the "before") was discarded the moment it reached the
  client — now captured by 2a into `extraction_captures.result`.
- **The corrected form** (the "after") lives in the import review session and its
  snapshot (`ImportSnapshot`), which the API stores **opaque** on purpose
  (`import_drafts.snapshot`, owned by the review surface).

The decisive structural fact (verified in the scout pass): the client's
`ImportSnapshot` already carries **both sides** — `snapshot.extraction` (the
untouched `ExtractionResult`) and `snapshot.fields` (the reviewer's corrected
editor list), aligned by stable field id (`ai_1`, `ai_2`, … survive
`seedEditor`). So the diff can be computed **client-side, at publish**, where both
sides sit together — the server never has to decode the blob it deliberately
treats as opaque.

Three constraints shape the whole design, and all three point the same way —
away from an autonomous prompt:

- **The repo's own discipline forbids untested, overfit rules.**
  `document-profiles.test.ts` literally asserts the profile names no employer,
  site or ticket code, and the module's ethos is "honest empty beats invented
  rules nobody tested against a real document." A distilled example that overfits
  one org's paper is exactly what that guard exists to stop.
- **There is no live regression net here.** No `ANTHROPIC_API_KEY` is wired in
  the dev shell, so nothing can run the corpus before/after loop to catch a
  prompt change that regresses the whole document class before it ships.
- **Cross-org privacy.** Captures and corrections are org-scoped; a "general"
  rule distilled by reading many orgs' corrections must never carry one org's
  verbatim content into a shared prompt.

Hence: the loop distils and *proposes*; a human *promotes* via a PR the existing
tests gate. (Explicit user decision — human-gated, not auto-applied.)

### Requirements

- **R1.** The capture from 2a becomes addressable: `POST /pdf/extract` returns
  the new capture's id alongside the `ExtractionResult`, so a later correction
  record can link precisely to the raw extraction it corrects. Fallback when no
  id is echoed: pair by `(orgId, assetId)` and the latest capture preceding the
  publish.
- **R2.** A pure `diffExtraction(raw, reviewed)` in `@formai/shared` produces an
  `ExtractionCorrections` record, aligning fields by id and classifying each
  change as one of: `retype` (from→to type), `selection-type-changed`,
  `options-edited`, `fixed-rows-edited`, `answer-sets-changed`, `split`,
  `label-rewritten`, `question-ref-edited`, `deleted` (raw field the reviewer
  removed), `added` (field the reviewer inserted). It records raw signal; it does
  not interpret.
- **R3.** Geometry/placement edits and the `resolved`/confirm flags are **not**
  corrections. Placement is layout, not extraction-text quality; `resolved` is
  affirmation, not correction. The diff excludes both.
- **R4.** Corrections are computed and sent **only at publish** — the reviewer's
  committed final answer. An abandoned or deleted draft yields no correction: it
  has no ground truth. Sending is best-effort and can never block or fail a
  publish.
- **R5.** A new `extraction_corrections` table stores the structured diff,
  org-scoped, linked to its capture (R1) and to the published form/version (the
  "after"'s permanent home).
- **R6.** A distillation step clusters corrections across imports by **shape** —
  the correction type plus a coarse, content-free descriptor (e.g. "retype
  radio→textarea", "deleted a field whose label is a bare lettered option") —
  counted per `documentType`. Verbatim field text is never a cluster key.
- **R7.** A candidate-rules surface lists clustered shapes with their counts and
  links to a few example captures, for a human to review. It reads shape-level
  aggregates across orgs; any verbatim example it shows is drawn from the
  viewer's own org only.
- **R8.** Promotion is a **code change** — editing `ASSESSMENT_PROFILE` (or a new
  `LEARNED_EXAMPLES` appended block) — landed through a normal PR that the
  existing profile tests and the anti-forms guard gate. There is **no** code path
  that mutates the prompt from stored data at runtime.
- **R9.** A correction-rate metric per `documentType` over time (corrections per
  extracted field), so the loop's effect is measurable: a promoted rule should
  visibly lower the rate for the shape it targets on subsequent imports.
- **R10.** Fully generic. No customer name, site, code or competency is stored as
  a cluster key, surfaced in a shared view, or written into the prompt. The
  engine ships identical for every customer.

### Scope Boundaries

**In:** the pure diff engine; capture addressability (R1); the corrections table
and its best-effort write; the client-side publish-time emit; the cross-org
shape clustering; the correction-rate metric; the read-only candidate-rules
admin surface; the human promotion workflow (a tested `LEARNED_EXAMPLES` block).

**Out (not this loop's shape):**
- **Automatic prompt mutation of any kind** — no runtime read of stored
  corrections into the prompt, no per-org custom prompt. (R8, explicit user
  decision.)
- Capturing/diffing the `/audit` secondary pass — the primary `/extract` output
  is the "before" we learn from; the audit pass is a different signal (missed
  fields) and is its own future piece.
- Model fine-tuning / training on captures.

#### Deferred to Follow-Up Work

- **Retention/pruning** of `extraction_captures` and `extraction_corrections`.
  They accumulate one row per extraction/publish; a pruning policy is a decision
  for when volume bites, deliberately not baked into capture.
- **Auto few-shot injection** (per-org or global) — explicitly rejected for this
  round per the human-gated decision; revisit only once a live corpus regression
  loop exists to catch drift.
- A **capture id in the `/audit`** flow and audit-side corrections.

### Acceptance Examples

Illustrations only — none seeded; all shape-level.

- **AE1 (short-answer retype → rule 18 evidence).** Across many imports, reviewers
  repeatedly retype AI-produced `radio` fields whose options the reviewer then
  deletes into `textarea`. The distiller clusters "retype radio→textarea, options
  cleared" with a count and links three example captures. A human reads it as
  confirmation that rule 18 (short-answer) is earning its place, or as a prompt to
  strengthen it — and promotes any change via PR.
- **AE2 (orphan-option deletion → rule 19 evidence).** Reviewers repeatedly delete
  fields whose label is a bare lettered fragment ("c) …") sitting at the start of
  a `sourcePages` batch. The cluster "deleted field, label matches a bare lettered
  option, first field of a batch" quantifies exactly the batch-boundary failure
  rule 19 targets.
- **AE3 (single/multiple → rule 1b evidence).** Reviewers repeatedly change
  `checkbox_group` `selectionType` from `multiple` to `single`. The cluster points
  a human at rule 1's default.
- **AE4 (no ground truth, no signal).** A reviewer uploads a PDF, edits some
  fields, then abandons the draft without publishing. No correction record is
  written — the loop learns nothing from an uncommitted opinion.
- **AE5 (promotion is a gated PR).** A promoted few-shot example lands as a diff to
  a `LEARNED_EXAMPLES` array; the profile tests (including the "names no employer,
  site or ticket code" guard) run against it; CI green is the gate. No stored row
  ever reaches the model without passing through this.
- **AE6 (measured improvement).** After a rule promotion, the correction-rate
  metric for `assessment` imports shows the targeted correction shape's frequency
  falling on subsequent extractions — the honest form of "always improving".

---

## Planning Contract

Six phases. A–C are pure/back-end and independently testable; D wires the client;
E–F add the distillation and the human gate. Each unit lists its files, its
approach, and its tests.

### Phase A — The diff engine (`@formai/shared`, pure)

**U1 — `ExtractionCorrections` types.**
- Files: `packages/shared/src/extraction-corrections.ts` (new), exported from the
  shared barrel.
- A discriminated union `Correction` over the R2 kinds, each carrying the field
  id it concerns and the minimal before/after payload (e.g. `retype: {fieldId,
  from: FormFieldType, to: FormFieldType}`). An `ExtractionCorrections` wrapper
  carries `documentType`, `path`, `pageCount`, `captureId?`, and
  `corrections: Correction[]`, plus per-correction `sourcePages?` copied from the
  raw field so a batch-boundary correction is identifiable (AE2).
- Tests: type-only; exercised via U2.

**U2 — `diffExtraction(raw, reviewed)`.**
- Files: `packages/shared/src/extraction-corrections.ts`, `…test.ts`.
- Pure function. Inputs: `raw: ExtractedField[]` (from `capture.result.fields`)
  and `reviewed: FormField[]` (the published/editor fields). Align by id:
  - id in both, type differs → `retype`; `selectionType` differs →
    `selection-type-changed`; `options` differ → `options-edited`; `fixedRows`
    differ → `fixed-rows-edited`; `answerSets` differ → `answer-sets-changed`;
    `label` differs → `label-rewritten`; `questionRef` differs (read from
    `reviewMeta`, see U6) → `question-ref-edited`.
  - id in raw only → `deleted` (record `wasType`, `wasLabel`, `sourcePages`).
  - id in reviewed only → `added` (record `type`, `label`, and the id it follows).
  - **Split churn:** `splitTableGroups` mints new ids and labels the parts
    `"<label> (g of N)"`. Detect by that label pattern against a deleted source
    and emit one `split` correction rather than a delete + N adds, so the signal
    reads as "one table split into N", not "a field vanished and three appeared".
- The function records; it never judges which side is right. Exclude geometry and
  `resolved` (R3).
- Tests: one per correction kind (retype radio→textarea with options cleared;
  multiple→single; a deletion of a bare-lettered-option field carrying
  `sourcePages`; an addition; a split of a 6-item table into 3; a pure
  label rewrite; no-op when raw == reviewed → empty corrections).

### Phase B — Capture addressability

**U3 — `/extract` returns the capture id.**
- Files: `apps/api/src/pdf/capture.ts` (return the inserted id),
  `apps/api/src/routes/pdf.ts` (include `captureId` in the response),
  `packages/shared/src/extraction.ts` (add optional `captureId?: string` to
  `ExtractionResult`), `…/capture.test.ts`, route test.
- `captureExtraction` returns `string | null` (the row id, or null on the
  best-effort no-op/failure path — still never throws). The route spreads
  `{ ...result, captureId }` into the JSON. The client echoes it at publish (U6).
- Tests: capture returns the id on success and null on the swallow path; route
  test asserts `captureId` present when a db is wired, absent/undefined otherwise.

### Phase C — Corrections storage

**U4 — `extraction_corrections` table.**
- Files: `packages/db/src/schema/extraction-corrections.ts` (new), barrel export,
  `drizzle-kit generate` migration (**cut from current `origin/main` — the local
  main was stale last round and a migration collided; branch fresh and let the
  number fall after the latest applied one**).
- Columns: `id`; `orgId` → organizations cascade; `captureId` → extraction_captures
  `set null` (nullable — the fallback pairing may not resolve one); `assetId` text
  nullable; `documentType` text nullable; `formId`/`versionId` of the published
  "after" (nullable — a publish may target a new form); `corrections` jsonb (the
  `ExtractionCorrections`); `correctionCount` + `fieldCount` integers denormalised
  for the metric (R9) without opening the jsonb; `createdBy` → users set null;
  `createdAt`. Index on `(orgId, documentType)` for the metric and clustering.
- Tests: schema compiles; migration creates only this table.

**U5 — `POST /pdf/corrections`.**
- Files: `apps/api/src/routes/pdf.ts` (or a sibling `corrections` router),
  `…test.ts`.
- Body: `{ captureId?, assetId?, documentType?, formId?, versionId?, corrections }`
  validated with zod; `corrections` validated against the U1 shape. Org-scoped via
  `requireTenant`. Resolves `captureId` (R1 fallback if absent). Writes one row.
  Best-effort in spirit but this is an explicit client call, so it returns 201/400
  normally — it simply must not be on the publish critical path (U7).
- Tests: writes a row from a well-formed body; 400 on malformed corrections; org
  scoping (a caller can only attach to their own capture/asset).

### Phase D — Client emit at publish

**U6 — Compute corrections from the session snapshot.**
- Files: `apps/web/src/lib/data/import-session.ts` (a `captureImportCorrections()`
  reading `session.extraction.fields` as raw and `editor.fields` + `reviewMeta`
  (for `questionRef`) as reviewed, calling shared `diffExtraction`), `…test.ts`.
- Note the `questionRef` subtlety: it rides in `reviewMeta`, not on the editor
  `FormField`, so the reviewed side must fold it back in before diffing (mirror of
  `derivedReviewFields`). `captureId` comes from `session.extraction.captureId`
  (U3).
- Tests: a session where the reviewer retyped one field and deleted another yields
  exactly those two corrections; an untouched session yields none.

**U7 — Send at publish, never blocking it.**
- Files: the publish action in the import flow (the route that creates the form
  version from the reviewed fields) + its caller.
- After a successful publish, fire `POST /pdf/corrections` **fire-and-forget**
  (no await gating the user's navigation; failures are logged, never surfaced) —
  the same best-effort contract as the capture, on the client side. Only publish
  triggers it (R4); abandon/delete never does (AE4).
- Tests: publishing calls the corrections endpoint once with the computed body; a
  corrections-endpoint failure does not fail or block the publish; abandoning does
  not call it.

### Phase E — Distillation & metric

**U8 — Shape clustering.**
- Files: `packages/shared/src/correction-shapes.ts` (pure `shapeOf(correction):
  string` — the content-free cluster key, e.g. `retype:radio→textarea`,
  `deleted:bare-lettered-option@batch-start`), `apps/api/src/routes/…` read
  endpoint or a script that groups `extraction_corrections` by `(documentType,
  shape)` with counts and a few sample `captureId`s.
- `shapeOf` is the privacy boundary (R6/R10): it maps a correction to a key built
  only from types, structural predicates and `sourcePages` position — never field
  text. Predicates like "label is a bare lettered option" are regex on shape, and
  the *matched* text never enters the key.
- Tests: `shapeOf` is stable and content-free (two corrections differing only in
  label text share a shape); the grouping counts correctly over a fixture set.

**U9 — Correction-rate metric.**
- Files: a read endpoint / query returning, per `documentType` and time bucket,
  `sum(correctionCount)/sum(fieldCount)` and the top shapes.
- Tests: metric math over a fixture window; buckets align.

### Phase F — The human gate (2c)

**U10 — Candidate-rules read surface.**
- Files: an admin-only endpoint returning U8 clusters (shape, count, trend from
  U9, sample captures) with verbatim examples restricted to the caller's own org
  (R7); a minimal admin screen listing them.
- Tests: endpoint authz (admin only); cross-org rows appear as shape+count but
  carry no other org's verbatim text.

**U11 — Promotion workflow (the tested `LEARNED_EXAMPLES` block).**
- Files: `apps/api/src/pdf/document-profiles.ts` — an optional, per-`documentType`
  `LEARNED_EXAMPLES` array appended to the profile by `profileFor`, each entry a
  general {shape → correct reading} illustration written by a human; extend
  `document-profiles.test.ts` with the anti-forms guard over `LEARNED_EXAMPLES`
  too, and a test that an empty block leaves the profile byte-identical.
- This is the ONLY path from evidence to prompt, and it is a human editing code in
  a PR (R8/AE5). The candidate-rules surface produces the evidence; a person
  writes the general rule; CI gates it.
- Tests: appended examples show up in `profileFor('assessment')`; the anti-forms
  guard (`MUST BE BBM`, ticket codes, site names) runs over the examples;
  `profileFor` for a type with no learned examples is unchanged.

### Testing strategy

- Phases A/E are pure functions — exhaustive unit tests, the bulk of the
  confidence, and the same mocked/golden discipline the extraction tests already
  use (no API key required).
- Phases B/C/D/F ride existing route/store test patterns.
- The whole loop is provable **without** a live model: the diff, the shapes, the
  metric and the gate are all deterministic. The only thing a live key would add
  is AE6's end-to-end "did the promoted rule lower the rate" measurement over real
  re-extractions — worth wiring when a key lands, not a blocker for building the
  loop.

### Risks & mitigations

- **Id-churn in the diff (split/add/delete).** The split heuristic (U2) can
  misread an unusual manual rebuild as delete+adds. Mitigation: it records raw
  signal; a mis-split degrades a cluster's precision, never corrupts a form. The
  distiller tolerates noise because it thresholds on counts.
- **Cross-org leakage.** Guarded by `shapeOf` being the only cross-org key (U8)
  and verbatim examples being own-org-only (U10). Tested (R10).
- **Scope creep toward auto-apply.** Explicitly out (R8); the `LEARNED_EXAMPLES`
  block is the deliberate, minimal, tested seam so the temptation has a safe home.
- **Migration numbering collision.** Cut U4's branch from fresh `origin/main`
  (last round's `0059` collided from a stale local main).
