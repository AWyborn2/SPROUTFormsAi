---
title: Assessment Builder — Implementation Plan
type: feat
date: 2026-08-05
topic: assessment-builder
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: claude-design-handoff
execution: code
target_repo: AWyborn2/SPROUTFormsAi
source_prototype: project/Assessment Builder.dc.html (Claude Design handoff, 2026-08-04)
---

# Assessment Builder — Implementation Plan

## Goal Capsule

- **Objective** — Replace the out-of-band authoring path for a multi-part competency assessment tool (a two-hour manual placement session, a JSON answer key kept outside the repo, and a `--write` node script run against the production database) with a seven-step in-app builder that takes a never-seen assessment PDF from upload to a published, enrollable assessment tool.
- **Product authority** — Ash Wyborn (Charles Hull Contracting / BBM). The prototype in `project/Assessment Builder.dc.html` and the seventeen-round chat transcript in `chats/chat1.md` are the product contract; where this plan and the prototype disagree, the prototype is the target and the reasoning is stated.
- **Starting point** — `AWyborn2/SPROUTFormsAi` @ `b893169`. Most of the *machinery* the prototype fakes already exists and is well-tested: extraction, geometry, marking, manifests, workflow, case runtime, evidence export. What does not exist is an **authoring surface** for the three artifacts a tool needs — the part manifest, the answer keys, and the response/outcome placements — and the two content shapes the extractor still drops on the floor: matching questions and cover-page prerequisites.
- **Open blockers** — None blocking implementation. Four decisions are recorded as Outstanding Questions; each has a stated default so no unit is gated on an answer.

---

## Product Contract

### Summary

An assessment coordinator uploads a printed competency assessment PDF and walks seven steps: **Upload** (AI reads the document and asks a short set of setup questions), **Generate** (edit the structure and page through a live preview of the whole webform), **Design chat** (tweak the artifact conversationally), **Units & gating** (order the parts, declare pathways and prerequisites), **Answer key** (upload a guide or key each question, including matching pairs), **PDF mapping** (drag each field onto the real printed page and choose the glyph it prints), and **Workflow** (who fills what, in what order, and which values autofill). Publishing produces a template version, an assessment tool manifest and answer keys — the same three artifacts the `author-track-dozer-tool.mjs` script writes today — with no script, no database URL and no file of answers on anybody's laptop.

### Problem Frame

`docs/runbooks/track-dozer-first-end-to-end.md` in the target repo is an honest description of the current authoring path, and it is the problem this work solves:

1. **The manifest is authored by a script.** `packages/db/scripts/author-track-dozer-tool.mjs` anchors parts by heading text, maps answer-key letters onto extracted options, derives outcome targets, and upserts the `assessment_tools` row. It is heuristic by its own admission, dry-run by default, refuses to write unless it finds exactly 31 question/outcome pairs and 6 part anchors, and needs `DATABASE_URL` plus a built `@formai/shared`. There is no UI anywhere in `apps/web` that writes a manifest.
2. **The answer key is a file.** It is keyed by section and question *number* — a number no published field carries — so the script consumes pairs positionally and refuses on an off-by-one. The runbook's own gap table says it "moves to the DB once upload-at-import exists". It does not exist.
3. **Placement is a two-hour manual session** in the import review step, and its 300-odd boxes are navigated with no filter, no grouping and no per-question pairing. The prototype adds a second box per theory question (the candidate's *response*, not just the outcome), which the current model cannot express as an authored intent at all.
4. **Matching questions are extracted as unanswerable text.** `packages/shared/src/matching.ts` has a complete, tested model for them (`buildMatchingQuestion`, exact-set marking over pairing options) and `FieldRenderer` already renders them grouped — but nothing populates it. `validateManifest` explicitly names this: a matching question sitting in a mandatory section with no answer key "silently unmarked", called out as a hard problem in the source.
5. **The cover page's prerequisite row is dropped.** The document's driver's-licence prerequisite (`Q50001782`, class C or higher) is a gating fact that never reaches the model — the extraction profile has no rule for it.
6. **Nothing in the product shows an author what the digital form will look like** before publishing. The import review screen is a field list; the artifact preview is new.

### Key Decisions

**KD1 — The builder is a new surface over the existing pipeline, not a second pipeline.** Every step reuses what is already proven: `/pdf/extract` and the `assessment` document profile for reading the document; `FieldGeometry`/`PageBox` for placement; `answerKey` + `outcomeTarget` + `markTheory` for marking; `AssessmentToolManifest` for parts and pathways; `AssessmentWorkflow` for roles. The prototype's `extractor.js` is a *specification of what the extraction still misses*, not a replacement for `apps/api/src/pdf/extract.ts` — see KTD1.

**KD2 — Extraction never runs in the browser.** The prototype calls `window.claude.complete` from the page, which puts a model key in the client and the full document text on the wire from an untrusted origin. The repo's own rule is "AI: Claude API (server-side only)". The builder calls `POST /pdf/extract`, which already exists, is tenant-scoped, and carries the tuned assessment profile.

**KD3 — A builder session is a server-side draft, not `localStorage`.** The prototype persists the extraction, keys and placements to `localStorage` and the PDF bytes to IndexedDB. An assessment tool is authored over days by a person who may switch machines, and its answer key is a safety-critical secret. The session becomes an `assessment_tool_drafts` row alongside the existing `import_drafts`, which already carries a 40 MB JSON body and a resume UI.

**KD4 — Matching questions keep the repo's model; the prototype supplies the missing authoring and rendering.** `lefts`/`rights`/`pairKey` in the prototype and `options: ["left -> right", …]` + exact-set `answerKey` in the repo describe the same question. The pair builder authors `MatchingQuestion`; `buildMatchingQuestion` converts; marking, export and the fill surface need no change. Draw-a-line and drag-to-match are *presentations* of that field, chosen per question and stored as a render hint — never as a second data model.

**KD5 — A theory question maps two locations, and both are geometry on the same field.** The prototype's "response" box is geometry on the *question* field (a ring around the chosen option, or the chosen letter as text); the "outcome" box is geometry on the `check_cross` field the question's `outcomeTarget` names. The exporter already draws exactly this (`drawCheckboxOptions` rings the chosen option green/red; the outcome cell gets a vector tick/cross). The prototype's contribution is making the pair visible and placeable as one unit of work — not a new export path.

**KD6 — Glyph style becomes authored data, with a safe default per field type.** Today the exporter derives the mark from the field type alone. The prototype offers eleven styles, three inks and three sizes per box. A `MarkStyle` on the geometry segment, absent by default and resolving to today's behaviour, keeps every existing placement bit-for-bit identical while letting an author say "print a date stamp here" — see KTD4 for what the exporter will and will not honour.

**KD7 — The prototype's chat is the last thing built, and it is honest about what it does.** In the prototype, three of the four chat chips apply real state changes and free text returns a canned reply. Shipping a chat that claims to edit a form schema and does not would be worse than shipping none. Phase H builds it against a defined, small set of real operations, or ships the step as a labelled "coming soon" panel beside the live artifact.

**KD8 — Publishing from the builder is the existing publish, plus two writes.** `POST /forms/:id/versions/:versionId/publish` already mints the immutable version. The builder then writes the manifest and the tool row through `POST /assessment-tools` (which already validates via `validateManifest` and `validateAnswerKeys`). No new publish semantics.

### Actors

| Actor | What they do in the builder |
|---|---|
| **Assessment coordinator / training authority** | Runs all seven steps; owns the answer key and verifies it. The prototype's "Verified by Training authority" toggle is this person's attestation. |
| **Assessor** | Consumes the result: marks practicals, signs off cases. Sees the builder only if their access level permits. |
| **Candidate** | Never sees the builder. Sees the *artifact* it generates — which is why Step 2/3's preview matters: it is the only place the author sees what the candidate will. |

### Key Flows

**F1 — Upload to bank.** Coordinator opens Assessments → **Assessment builder** → drops a PDF → the file uploads to `/pdf/upload`, extraction runs server-side with the `assessment` profile → the builder shows pages/parts/fields/questions, an AI summary, five setup questions, and the extracted question bank with per-question include toggles and type badges.

**F2 — Structure and preview.** The extracted fields are grouped into sections. The coordinator reorders sections and fields, renames sections, sets 1/2/3-column layouts and per-field spans, marks a section "own page", groups selected fields into a new section, and corrects any field's type. A pager beside it renders every section as a page, in the edited order, exactly as the candidate will see it.

**F3 — Units, pathways, gating.** Sections become parts: kind (theory/practical/logbook), pathway membership (New / Experienced / RPL), logbook minimum hours and duration column, mandatory question set, and the cover-page prerequisites the extraction found. Reordering changes process order, never printed order.

**F4 — Answer key.** Either upload a guide (PDF → server-side Claude matching, or JSON in the repo's own `track-dozer.answer-key.json` shape) or key by hand. Every question shows its type, which the coordinator can correct; a matching question opens the pair builder. Each question can be marked verified.

**F5 — Placement.** The real PDF renders page by page. The field list is grouped, counted and filterable. Dragging a field onto the page places it; a placed box can be picked up and moved, nudged with the arrow keys, deleted, and given a glyph, ink and size. Each theory question shows its two boxes — response and outcome — as one row of work.

**F6 — Workflow and publish.** Per-section role access (Hidden/View/Fill), per-field value source (Entry/Prefill/Auto) and datapoint mapping. Publish validates, mints a version, writes the manifest and keys, and returns to Assessments with the tool marked Published.

### Requirements

Numbered so units can cite them.

**Upload & extraction**
- R1 — A coordinator can start a builder session from the Assessments screen and from the form library.
- R2 — Extraction runs server-side; no model key or document text leaves the client to any origin but the API.
- R3 — The extraction reports pages, parts, fields and theory questions, and names which path produced it (AcroForm / AI).
- R4 — The cover page always resolves into exactly three sections: *Candidate declaration*, *Pathway & prerequisites*, *Assessor feedback & declaration*. Every prerequisite row (licence, permit, qualification) is captured verbatim and never dropped.
- R5 — Every matching question is extracted with **both** sides (`left`, `right`); a matching question with one side or none is reported as needing the pair builder rather than emitted as a choice question with wrong options.
- R6 — The session survives a reload, a new browser and a different machine.

**Setup questions & bank**
- R7 — The setup questions are drafted from what was found (pathways, streams/sets, pass rule, rendering, thresholds) and their answers seed the manifest defaults in Step 4 and the workflow defaults in Step 7.
- R8 — The question bank lists every extracted theory question with its type and option/pair count; excluding one leaves it off the digital form and out of marking, and says so.

**Structure & preview**
- R9 — Sections and fields can be reordered, renamed, grouped, split onto their own page, and laid out over 1–3 columns with per-field spans.
- R10 — A field's type can be corrected, including to Yes/No, Criterion ✓/✗/NA, Response and Outcome.
- R11 — The preview renders **every** part and section as its own page, in the edited order, with the right presentation per kind (cover rows, theory questions, practical criteria, logbook table, result & sign-off).
- R12 — Structure edits drive the preview immediately; a reset restores the extracted order.

**Units & gating**
- R13 — Parts carry kind, ordinal, pathway membership, start field, mandatory question set, and (logbooks) minimum hours + duration column.
- R14 — Reordering units changes process order only. The printed document never moves.
- R15 — Prerequisites detected on the cover page are surfaced as declared prerequisites on the tool, not as free text.

**Answer key**
- R16 — A key can be uploaded as PDF (matched by the model, server-side) or JSON (both the repo's sectioned shape and a flat `{"answers": {"General:4": ["b","c"]}}` shape), or authored by hand.
- R17 — Keying is exact-set match, matching the existing `markTheory` rule; the UI says so and shows the current key.
- R18 — A question's type can be corrected in the key step, and correcting it to Matching opens the pair builder.
- R19 — The pair builder authors statements and their correct matches, seeding from whichever sides the extraction captured, and marks either side as images with an upload slot per row.
- R20 — A question can be marked verified, with who and when.
- R21 — The answer key is never served to a fill surface (the existing `stripMarkingSecrets` rule).

**Placement**
- R22 — Each theory question presents two placements: **response** (default ring; typed letter or match-line as alternatives) and **outcome** (✓/✗).
- R23 — A placed box can be dragged to a new position, nudged 1px with the arrow keys (10px with Shift), and deleted with Delete/Backspace.
- R24 — A box carries a glyph style, ink and size; the default per field type reproduces today's export exactly.
- R25 — The field list is grouped by part/page with counts, collapsible, and filterable by label or question text.
- R26 — The inspector states in words what the box will print, including the response/outcome distinction and the matching case.

**Workflow & publish**
- R27 — Per-section access per role, per-field overrides, and per-field value source with a datapoint picker (case record, marking, sign-off, prior answers).
- R28 — Publish refuses on a manifest or key-set that fails the existing validators and names every problem at once.
- R29 — A published tool appears on the Assessments screen as Published and is enrollable.

**Fill-surface interactivity** (Phase G)
- R30 — A matching question renders as an interactive: draw-a-line or drag-to-match, chosen per question, with image slots on whichever side is images.
- R31 — Theory renders one question per screen when the tool's setup said so, with optional progress bar.

### Acceptance Examples

- **AE1** — Upload an assessment PDF the system has never seen. Within the extraction budget the builder reports its real title, document control number, version, part count, question count and field count, and the cover page is split into the three named sections with the licence prerequisite present.
- **AE2** — A document containing two matching questions reaches Step 5 with both showing a pair builder pre-filled from the extracted sides, and after saving, both are keyable and both render as interactives in the preview.
- **AE3** — Reordering "Theory" above "Cover" in the structure editor makes Theory Section 1 in both the Step 2 and Step 3 pagers, and the cover page's chip is titled from the sections it actually contains.
- **AE4** — Setting a section to 3 columns and giving its fourth field span 3/3 renders three fields across one row and one full-width field beneath, in the editor grid *and* the live artifact.
- **AE5** — Dropping the repo's `track-dozer.answer-key.json` into Step 5 seeds 31 answers as keyed-and-verified and the banner says how many matched; unmatched questions stay for manual keying.
- **AE6** — A theory question's response box, placed over its option column with the ring glyph, prints a green ring around the chosen option when it matches the key and a red one when it does not — the behaviour `round-trip.ts` already has, now reachable from the builder.
- **AE7** — Dragging a placed box moves it; arrow keys nudge it 1px; Shift+arrow 10px; Delete removes it. No delete-and-retry.
- **AE8** — Publishing a tool whose manifest names a mandatory question with no answer key is refused, with that question named — the existing `validateManifest` rule, surfaced in the UI.
- **AE9** — Closing the browser mid-Step-6 and reopening on another machine restores the same document, the same 180 placements and the same keys.

### Scope Boundaries

**In scope** — the seven builder steps; server-side extraction improvements for cover sections, prerequisites and matching sides; answer-key authoring and upload; manifest authoring; placement UX and authored glyphs; workflow authoring inside the builder; publish; the matching interactive on the fill surface.

**Out of scope** — replacing the existing 3-step import wizard (the builder is a *sibling* entry point for assessment documents; the generic import path stays); the case runtime, sign-off, competency grants and evidence export (all exist and are not changed except where a new glyph or a new field shape reaches them); billing/plan gating (assessments already sit behind `requirePlanFeature('assessments')`); the org-settings taxonomy work planned in `2026-08-04-002`.

**Explicitly deferred** — SCORM packaging; question shuffling per candidate (a prototype chat chip, no runtime); the "Outcome & appeals" unit tray (appeals exist server-side already); auto-detect of placements from the builder (the existing placement screen's auto-detect is reused as-is, not re-implemented).

### Dependencies / Assumptions

- The target repo's `assessments` and `competencyGating` plan features are enabled for the org running the builder (the runbook's own caveat).
- `pnpm --filter @formai/shared build` remains a prerequisite for anything running outside Vite.
- Extraction of an 18-page document takes 1–3 minutes (measured in the prototype). The builder must show phase progress and must not block on it.
- The prototype's visual language is already the repo's: same green accent ramp (`--accent` → `#3a9c66`), same Sora/Inter/JetBrains Mono stack, same 14px card radius, same badge tones. Rebuilding in Tailwind token classes is a translation, not a redesign.

### Outstanding Questions

Each has a working default so nothing is blocked.

- **OQ1 — Does the builder replace the import wizard for assessment documents, or sit beside it?** *Default: beside it.* The builder is entered from Assessments and creates a form + tool; `/app/import` keeps working for every other document class.
- **OQ2 — Where do answer keys live?** *Default: on the template version's fields* (`answerKey`), which is where marking already reads them, plus a `verifiedBy`/`verifiedAt` pair on the draft for the attestation. This retires the JSON file in git.
- **OQ3 — How many glyph styles does the exporter actually honour at v1?** *Default: five* — hand tick, block tick, hand cross, ring, typed text — plus signature and date stamp which already exist in substance. Highlight, PASS/N-A stamps, initials and match-line are authored and previewed but land in Phase E.2 (see KTD4).
- **OQ4 — Should Step 3's chat be shipped at all in v1?** *Default: no.* Phase H is separable and last; if it slips, Step 3 ships as the live artifact with the structure panel and a labelled placeholder rail.

### Sources / Research

- `project/Assessment Builder.dc.html` — 3,439 lines; the seven steps, the state machine, every glyph definition and the matching engine.
- `project/extractor.js` — 237 lines; the prototype's extraction contract (`SCHEMA_NOTE`), heuristic fallback and `buildModel` field manifest. Reviewed in full below.
- `project/support.js` — 1,911 lines; the Claude Design runtime (`dc-runtime`). Reviewed in full below: **it contains nothing to port.**
- `project/image-slot.js` — 1,225 lines; the design tool's image-drop custom element. Its persistence sidecar is design-tool-specific and must be replaced by real uploads.
- `chats/chat1.md` — the 17-round design conversation; the source of the fixed-3-section cover rule, the two-location mapping requirement, the drag/nudge fix and the matching-engine requirement.
- Target repo: `packages/shared/src/{assessment,marking,matching,workflow,geometry,form-field,extraction,outcome-links}.ts`; `apps/api/src/pdf/{extract,round-trip,case-export,document-profiles,tool-schema}.ts`; `apps/api/src/routes/assessments.ts`; `apps/web/src/screens/import/*`; `apps/web/src/screens/assessments/*`; `docs/runbooks/track-dozer-first-end-to-end.md`; `packages/db/scripts/author-track-dozer-tool.mjs`.

---

## Review of the handoff's JavaScript

The brief asked specifically for a review of `extractor.js` and `support.js`. Both were read in full.

### `support.js` — the Claude Design runtime. Port nothing.

`support.js` is the generated `dc-runtime` bundle (its first line says so: *"GENERATED from dc-runtime/src/*.ts — do not edit"*). It is a miniature React framework that exists to make a single `.dc.html` file interactive inside the design tool:

- **`parse.ts` / `boot.ts`** — pull the `<x-dc>` template and the `<script data-dc-script>` logic out of the document, mount a React root, and stream updates in from the design tool's editor.
- **`compile.ts`** — compiles the template's `{{ expr }}` holes, `<sc-for list as>` and `<sc-if value>` control flow, `style-hover="…"` pseudo-class attributes, and `<x-import>` external component mounts into React elements.
- **`expr.ts`** — a deliberately tiny expression resolver: property paths, array indexing, `!`, `==`/`===`, literals. No function calls, no arithmetic. This is why the prototype's logic file computes *every* style string in JavaScript and passes it down as a prop — `style="{{ st.circleStyle }}"` rather than a conditional in the template.
- **`logic.ts` / `component.ts`** — `DCLogic` (aliased `StreamableLogic`): a class with `state`, `setState`, the React lifecycle hooks, and a `renderVals()` method that returns the flat object the template renders against. `Component` in the prototype extends this.
- **`external.ts`, `helmet.ts`, `pseudo.ts`, `cdn.ts`** — CDN React loading with SRI, `<helmet>` head management, a dynamic stylesheet for pseudo-class rules, and `x-import` module loading via `new Function(...)`.

**Consequences for the implementation, which are the reason it was worth reading:**

1. **`renderVals()` is the porting seam.** The prototype's `vals1()`…`vals7()` are not view code — they are *view-model builders*. Each returns a flat bag of primitives, style strings and callbacks. In React these become derived values inside the step component or a `useMemo`; the callbacks become handlers. The mapping is mechanical and the plan's units name it explicitly.
2. **Every `style="…"` string in the prototype is a computed literal**, because the expression language cannot branch. When porting, these collapse to Tailwind token classes and conditional `className`s — which is why the port is smaller than the prototype, not larger.
3. **Two prototype bugs are runtime artifacts, not product bugs.** The chat records "`display:flex` was being dropped because it followed the `margin` shorthand" and "a data URL's `;base64` was read as a declaration separator". Both are `cssToObj` in `encode.ts` splitting on `;` and `:` naïvely. Neither reproduces in React and neither needs a workaround carried across. The blob-URL page rendering the prototype settled on is still the right call for a different reason (memory), and the repo's `PdfViewer` already does it.
4. **`window.claude.complete` is a design-tool affordance and has no production equivalent.** Everything that calls it moves server-side (KD2).

### `extractor.js` — a specification of the extraction gaps

`extractor.js` is 237 lines: `pagesFromPdf` (pdf.js text extraction, rows bucketed by rounded Y and sorted by X), `claudeExtract` (one prompt, `SCHEMA_NOTE`, model `claude-sonnet-4-5`, 24k max tokens with an 8k fallback, brace-slice JSON parse), `heuristicExtract` (a regex fallback: `^PART \d`, `^\d{1,2}[.)]`, `^[a-h][.)]`), `buildModel` (turns the extraction into a bank + a flat field manifest + units), and an IndexedDB buffer store.

**It is weaker than the repo's extraction in every respect except three**, and those three are exactly what should be lifted:

| | `extractor.js` | `apps/api/src/pdf/extract.ts` | Verdict |
|---|---|---|---|
| Where it runs | Browser, `window.claude` | Server, tenant-scoped, AcroForm path first | **Repo wins** (KD2) |
| Output contract | Free JSON, `JSON.parse(raw.slice(a,b+1))` | Forced tool call (`extract_form_fields`) with a JSON Schema mirroring `ExtractedField` | **Repo wins** — a brace-slice parse of a 24k-token response is a coin flip |
| Field model | 4-tuples `[id, label, questionText, kind]` | `FormField` with geometry, columns, answer sets, fixed rows, visibility, confidence | **Repo wins** decisively |
| Question ↔ outcome pairing | Positional (`fx_qr_…` / `fx_q_…` naming) | `questionRef` printed-reference matching + `linkOutcomeTargets` | **Repo wins** — the prototype's scheme is the exact failure mode the repo's doc comment warns about |
| Repeating tables | `logColumns: string[]` | `repeating_group` + `columns` + `answerSets` + `fixedRows` + `columnGroups` | **Repo wins** |
| **Cover-page structure** | **Always exactly 3 named sections, prerequisites never omitted** | No rule at all | **Prototype wins — lift verbatim** |
| **Matching questions** | **`left[]` + `right[]` required on every `type:"match"`** | Not extracted; `matching.ts` exists with nothing feeding it | **Prototype wins — lift verbatim** |
| **Part-level reading** | `parts[]` with `kind`, `pages`, `criteria[]` | Inferred later from `section_header` fields | **Prototype's framing is useful** — it maps directly onto `AssessmentPart` and should seed the manifest |
| Heuristic fallback | Regex parser when the model is unreachable | None (the AcroForm path is the deterministic one) | **Neither** — a regex fallback that mis-reads a safety assessment is worse than a clear failure. Do not port. |

**Two defects in `extractor.js` worth naming so they are not carried across:**

- `buildModel` sets `nq = bank.length` for *every* theory part, so a document with two theory parts reports the whole bank against each. The manifest path must count a part's own questions.
- The `applyXdoc` migration that injects response fields does `it[0].replace('fx_q_', 'fx_qr_') + (it[0].indexOf('fx_q_') === 0 ? '' : '_r')` — if a field id ever contains `fx_q_` other than as a prefix, it mints a colliding id silently. Ids in the port come from extraction and are never string-surgeried.

**What to lift, concretely:** the `SCHEMA_NOTE` rules for `coverSections` (the fixed three, prerequisites verbatim as `check`) and for `match` (both sides always) become additions to `ASSESSMENT_PROFILE` in `apps/api/src/pdf/document-profiles.ts` and new properties on `extractFormFieldsTool` in `apps/api/src/pdf/tool-schema.ts`. That is Unit U3.

---

## Planning Contract

### Key Technical Decisions

**KTD1 — Extend the extraction profile and tool schema; do not add a second extractor.** `document-profiles.ts` gains cover-section and matching rules; `tool-schema.ts` gains `matchLeft` / `matchRight` array properties and a `coverSection` enum on the field. `ExtractedField` in `@formai/shared` gains the same three optional properties. Everything downstream of `ExtractionResult` is untouched.

**KTD2 — A matching question is stored as the repo already models it.** At the point the pair builder saves, the builder calls `buildMatchingQuestion({lefts, rights, correct})` and writes the resulting `options` + `answerKey` onto a `checkbox_group` field with `selectionType: 'multiple'`. The *presentation* (`'line' | 'drag'`, and which side is images, and the image asset ids) is a new optional `matchPresentation` on `FormField` — render-only, never read by marking or export. This is what makes AE2 work without touching `markTheory`.

**KTD3 — The builder draft is one row and one shape.** `assessment_tool_drafts`: `{ id, orgId, createdBy, name, assetId, extraction, setupAnswers, structure, manifestDraft, keyDraft, placements, workflowDraft, step, updatedAt }`. It mirrors `import_drafts` (same 40 MB JSON body limit, same tenant scoping, same list/open/discard UI) rather than inventing a session concept. Placements live in the draft until publish, then land on the version's fields as `FieldGeometry` — which keeps the "only confirmed geometry is ever published" property that `geometry.ts` documents.

**KTD4 — Glyph style is `MarkStyle` on `PageBox`, optional, with a resolver.** `{ glyph?: GlyphKind; ink?: 'default' | 'blue' | 'ink'; size?: 's' | 'm' | 'l' }`. Absent resolves to today's per-type behaviour, so every existing placement is unchanged. `round-trip.ts` gains a `resolveMarkStyle(field, segment)` seam; v1 honours tick/cross/ring/text/signature/date (all of which it can already draw), and the decorative styles (PASS / N-A stamps, initials, highlight, match-line) are authored and previewed in the builder but explicitly listed as not-yet-drawn in the inspector until E.2 adds them. **Naming a style the exporter silently ignores is exactly the class of failure this codebase refuses elsewhere — so the inspector says so.**

**KTD5 — Structure is a builder-time model, not a stored one.** The prototype's `structModel()` (sections with `cols`, `page`, per-field `span`) becomes `BuilderStructure` in the draft. At publish it resolves into: field *order* on the version, `section_header` fields where a section starts, and `colSpan` on each field (which `FormField` already carries). Nothing new is stored on the published version that the fill surface does not already understand.

**KTD6 — The artifact preview is the real renderer, not a mock.** Step 2/3's pager renders through the existing `FieldRenderer` and `FormLayoutFrame` in read-only mode, paginated by section. The prototype hand-draws each page shape; reusing the real renderer is both less code and the only way the preview can be trusted. Where the real renderer lacks a presentation (matching interactives), Phase G adds it *to the renderer*, so preview and fill stay identical by construction.

**KTD7 — Step 6 extends `GeometryEditorScreen` rather than forking it.** That screen already has the PDF viewer, proposal tiering, band editing, keyboard nudge on band edges and the confirm gate. The builder step mounts the same component with a builder-scoped data source, and the new work — whole-box drag/nudge/delete, the grouped/filterable field list, the response/outcome pair rows, the glyph inspector — lands in it, benefiting the standalone placement screen too.

**KTD8 — Publish is a transaction of three existing writes.** Version publish → `POST /assessment-tools` (manifest + prerequisites + assessor/awarded competencies) → answer keys already on the version's fields. If the tool write fails, the version stays draft. This retires `author-track-dozer-tool.mjs`, which becomes a thin wrapper over the same code path or is deleted.

### High-Level Technical Design

```
apps/web/src/screens/assessments/builder/
  BuilderScreen.tsx          route shell, stepper, step routing, Back/Next
  BuilderChrome.tsx          full header vs compact in-artifact bar (steps 2/3)
  steps/
    UploadStep.tsx           R1–R3, R7, R8
    GenerateStep.tsx         R9–R12  (StructurePanel + ArtifactPager)
    DesignChatStep.tsx       Phase H  (ArtifactPager + chat rail)
    UnitsStep.tsx            R13–R15
    AnswerKeyStep.tsx        R16–R21 (KeySourceChooser, PairBuilder, KeyEditor)
    PlacementStep.tsx        R22–R26 (mounts GeometryEditorScreen, builder-scoped)
    WorkflowStep.tsx         R27–R29 (mounts WorkflowBuilder, builder-scoped)
  StructurePanel.tsx         section/field editing, drag, spans, type palette
  ArtifactPager.tsx          section→page pagination over the real renderer
  PairBuilder.tsx            MatchingQuestion authoring + image slots
  builder-draft.ts           draft state, actions, autosave (mirrors import-session.ts)
  builder-structure.ts       pure: BuilderStructure model + resolve-to-fields
  builder-pages.ts           pure: structure → pager pages (secKind/artPages port)

packages/shared/src/
  builder.ts                 BuilderDraft, BuilderStructure, SetupAnswers, MarkStyle
  matching.ts                + matchPresentation type (render hint only)
  form-field.ts              + matchPresentation?, PageBox + markStyle?
  extraction.ts              + matchLeft/matchRight/coverSection on ExtractedField

apps/api/src/
  pdf/document-profiles.ts   + cover 3-section rule, + prerequisite rule, + match sides
  pdf/tool-schema.ts         + matchLeft/matchRight/coverSection properties
  pdf/round-trip.ts          + resolveMarkStyle seam (KTD4)
  routes/builder-drafts.ts   CRUD over assessment_tool_drafts
  routes/answer-guides.ts    POST /answer-guides/match  (server-side key matching)
  routes/assessments.ts      publish path already exists; no new endpoint

packages/db/src/schema/
  builder-drafts.ts          assessment_tool_drafts
```

**Data flow at publish**

```
BuilderDraft ──resolveStructure──▶ FormField[] (order, colSpan, section_headers)
     │                                  │
     │                            + answerKey / outcomeTarget  (from keyDraft)
     │                            + geometry (from placements, with markStyle)
     │                            + matchPresentation           (render hint)
     │                                  ▼
     │                     POST /forms/:id/versions  →  publish
     │
     └──resolveManifest──▶ AssessmentToolManifest ──▶ POST /assessment-tools
                            (validateManifest + validateAnswerKeys gate it)
```

### Assumptions

- `POST /pdf/extract` accepts a `documentType` and the builder always sends `assessment`. (Confirmed: `ImportUploadScreen` already passes it.)
- The 40 MB JSON body limit already configured for `/import-drafts` is enough for a builder draft carrying ~300 placements and an extraction. (An 18-page extraction plus 300 boxes measures well under 2 MB.)
- `FieldRenderer` in read-only mode is safe to render outside a fill context. To be verified in U8; if not, a `preview` prop is added there rather than a second renderer being written.

### Risks & Dependencies

| Risk | Consequence | Mitigation |
|---|---|---|
| Extraction quality varies by document | The builder's whole premise ("upload one I've never seen") fails on a bad read | Every step is *correctable*: types, sides, structure, keys and placements are all editable. This is already the prototype's design and it is the right one. |
| A 300-field placement session is long | Author abandons mid-way | Server-side draft (KTD3) + grouped/filterable list + the existing auto-place pass |
| Authored glyphs the exporter ignores | A mark that never prints on a competency record | KTD4: the inspector states which styles draw at v1; nothing is silently dropped |
| `matchPresentation` leaking into marking | Two sources of truth for a question's verdict | It is render-only by type: `markTheory` reads `answerKey` and nothing else. Enforced by a test. |
| The builder and the import wizard drift | Two placement UIs to maintain | KTD7: one component, two mount points |
| Chat step over-promises | Trust damage | KD7/OQ4: last phase, or shipped as a labelled placeholder |

### Open Questions (deferred to implementation)

- Whether the builder should create the form template up-front (so the asset and version exist from Step 1) or only at publish. *Leaning: up-front as a draft version* — it makes the placement step reuse `GeometryEditorScreen` unchanged.
- Whether setup answers should be stored on the tool for later re-reading, or consumed once as defaults. *Leaning: stored*, so re-opening a published tool explains why it is shaped the way it is.

---

## Implementation Units

Phases are ordered so each one leaves the product better than it found it. Phase A is independently reviewable.

### Phase A — Builder spine and Step 1

#### U1. Shared builder types
- **Goal:** One vocabulary for the draft, the structure model, setup answers and mark styles.
- **Requirements:** R6, R9, R24
- **Dependencies:** none
- **Files:** `packages/shared/src/builder.ts`, `packages/shared/src/index.ts`, `packages/shared/src/form-field.ts`, `packages/shared/src/builder.test.ts`
- **Approach:** Add `BuilderDraft`, `BuilderStructure` (`{ key, label, cols: 1|2|3, ownPage, cover, fields: { id, span }[] }`), `SetupAnswers`, `GlyphKind`, `MarkStyle`. Add optional `markStyle?: MarkStyle` to `PageBox` and optional `matchPresentation?` to `FormField`. Every addition optional, so no stored record changes meaning.
- **Patterns to follow:** `assessment.ts`'s doc-comment style — state *why* a shape is the shape, and what the absent case means.
- **Test scenarios:** absent `markStyle` resolves to the type default; `BuilderStructure` with a span greater than its section's `cols` clamps rather than overflowing.
- **Verification:** `pnpm typecheck`; `pnpm --filter @formai/shared test`.

#### U2. `assessment_tool_drafts` schema, migration and routes
- **Goal:** A builder session that survives a reload, a machine and a colleague.
- **Requirements:** R6
- **Dependencies:** U1
- **Files:** `packages/db/src/schema/builder-drafts.ts`, `packages/db/src/schema/index.ts`, `packages/db/drizzle/*`, `apps/api/src/routes/builder-drafts.ts`, `apps/api/src/routes/builder-drafts.test.ts`, `apps/api/src/app.ts`
- **Approach:** Mirror `import_drafts` exactly — org-scoped, `jsonb` snapshot, list/get/put/delete, 40 MB JSON limit, `requireTenant`. No new auth concepts.
- **Patterns to follow:** `apps/api/src/routes/import-drafts.ts` end to end, including its error handling and its tests.
- **Test scenarios:** create/list/get/discard scoped to the org; a second org cannot read another's draft; oversized body rejected with a stated limit.
- **Verification:** `pnpm --filter @formai/api test`; `pnpm db:generate` produces exactly one migration.

#### U3. Extraction: cover sections, prerequisites and matching sides
- **Goal:** Close the two real gaps `extractor.js` identified (R4, R5).
- **Requirements:** R4, R5
- **Dependencies:** none (shippable on its own; improves the existing import wizard immediately)
- **Files:** `apps/api/src/pdf/document-profiles.ts`, `apps/api/src/pdf/tool-schema.ts`, `apps/api/src/pdf/extract.ts`, `packages/shared/src/extraction.ts`, plus the three existing test files
- **Approach:** Add rules 8–10 to `ASSESSMENT_PROFILE`, worded in the same imperative register as rules 1–7: **(8)** the cover/summary page always resolves into exactly three sections — *Candidate declaration*, *Pathway & prerequisites*, *Assessor feedback & declaration* — and every prerequisite row (licence class, permit, qualification) is emitted verbatim as its own field, never folded into a heading; **(9)** a matching question emits `matchLeft` and `matchRight` verbatim in printed order, describing each image where a side is photographs, and is never emitted as a choice question with the pairings pre-collapsed; **(10)** a `coverSection` marker on each cover field. Add the matching properties to `extractFormFieldsTool.input_schema` and to `ExtractedField`.
- **Patterns to follow:** the existing rules' voice and the comment above `ASSESSMENT_PROFILE` explaining *which real failure* produced each rule — add the same for these.
- **Test scenarios:** a fixture cover page yields three sections with the licence row present; a matching question yields both sides; a matching question the model returns one-sided is flagged, not silently emitted; existing extraction tests unchanged.
- **Verification:** `pnpm --filter @formai/api test`.

#### U4. Builder route, shell and stepper
- **Goal:** The seven-step chrome, reachable from Assessments.
- **Requirements:** R1
- **Dependencies:** U1, U2
- **Files:** `apps/web/src/lib/screens.ts`, `apps/web/src/router.tsx`, `apps/web/src/screens/assessments/builder/BuilderScreen.tsx`, `BuilderChrome.tsx`, `apps/web/src/screens/assessments/AssessmentCasesScreen.tsx`
- **Approach:** Register `assessment-builder` at `/app/assessments/builder` and `/app/assessments/builder/:draftId`. Port the stepper (7 circles, connecting bars, done/current/upcoming tones), the dismissible hint banner, the Back/Next footer with the prototype's per-step Next labels, and the compact in-artifact bar used on Steps 2/3 with its horizontally-scrollable mini-step pills. Add the green **Assessment builder** action and the Assessment tools card to the Assessments screen.
- **Patterns to follow:** `ImportStepper.tsx` for the stepper shape; `AppShell` for the page frame; token classes throughout — no raw hex.
- **Test scenarios:** the stepper renders in one row at 7 steps; step navigation is clickable and clamps; Next is disabled on Step 1 until extraction is ready; the mini-step rail is start-aligned so its overflow scrolls (the prototype's own fix).
- **Verification:** `pnpm --filter @formai/web test`; manual: the builder opens from Assessments and every step routes.

#### U5. Step 1 — upload, extraction and the question bank
- **Goal:** Upload → server extraction → stats, summary, setup questions, bank.
- **Requirements:** R1, R2, R3, R7, R8
- **Dependencies:** U2, U3, U4
- **Files:** `apps/web/src/screens/assessments/builder/steps/UploadStep.tsx`, `builder-draft.ts`, `apps/web/src/lib/data/hooks.ts`
- **Approach:** Reuse `FileDropzone`, `validateUploadFile` and `startExtraction`'s upload/extract sequence, forcing `documentType: 'assessment'`. Render the phase list against the real request lifecycle (upload → extract → build), never a timer. Stats strip from `ExtractionResult`. Setup questions drafted from what was found — pathway count, set count, whether any part is a logbook — with their answers written to the draft. Question bank built from the extracted choice fields, grouped by their `section_header`, with include toggles.
- **Patterns to follow:** `import-session.ts`'s run-token/abort discipline (`startExtraction`, `retryExtraction`) — the same reset semantics, so a second upload cannot be overtaken by the first.
- **Test scenarios:** a failed extraction shows the error and leaves the step re-runnable; excluding a question marks it excluded in the draft; setup answers persist across a reload; no `window.claude` reference exists anywhere in `apps/web`.
- **Verification:** `pnpm --filter @formai/web test`; manual: AE1 against a real unseen PDF.

### Phase B — Structure and preview (Step 2)

#### U6. `builder-structure.ts` — the structure model
- **Goal:** Pure functions for section/field ordering, grouping, spans and the resolve-to-fields step.
- **Requirements:** R9, R10, R12
- **Files:** `apps/web/src/screens/assessments/builder/builder-structure.ts` + test
- **Approach:** Port `structModel`/`commitModel`/`moveField` as pure reducers. Carry across the prototype's three hard-won drag fixes as *properties of the reducer*, not of the DOM: a move applies only when the resolved drop slot changes; the drag source is read from live state; an emptied section is kept, not deleted. `resolveStructure(structure, fields)` returns the published field order with `colSpan` and inserted `section_header`s (KTD5).
- **Test scenarios:** three `dragOver` events at one slot produce one move; a field dragged out of a section and back finds its section still there; span clamps to the section's `cols`; resolve is order-stable and id-preserving.
- **Verification:** `pnpm --filter @formai/web test`.

#### U7. `StructurePanel` — the editor
- **Goal:** The sticky, collapsible left panel: reorder, rename, columns, own-page, grouping, field types, spans.
- **Requirements:** R9, R10, R12
- **Dependencies:** U6
- **Files:** `StructurePanel.tsx`
- **Approach:** Section rows with ▲▼ and a chevron; expanded controls for rename / 1-2-3 col / own-page; field rows with grip, select checkbox, type-icon palette (the prototype's nine kinds mapped to `FormFieldType`), label and span cycle; a selection action bar with **Group into section**; a reset control. Collapses to a 44px vertical rail.
- **Test scenarios:** grouping two ticked fields creates an own-page section containing exactly them; reset restores extracted order; changing a field's type to Yes/No strips the trailing "No Yes" the extractor leaves in the label (the prototype's rule, kept).
- **Verification:** `pnpm --filter @formai/web test`; manual AE4.

#### U8. `ArtifactPager` — every section as a page
- **Goal:** The live preview, over the real renderer.
- **Requirements:** R11, R12
- **Dependencies:** U6
- **Files:** `ArtifactPager.tsx`, `builder-pages.ts` + tests; possibly a `preview` prop on `FieldRenderer`
- **Approach:** Port `secKind`/`artPages`/`pagePayload` as pure functions over `BuilderStructure` (`builder-pages.ts`), then render each page through `FieldRenderer` in read-only mode inside `FormLayoutFrame` (KTD6). Prev/next, "Section N of M", and a chip rail; consecutive cover sections not flagged own-page share one page, titled from the sections it actually contains (the prototype's fix for two identically-named chips).
- **Test scenarios:** a section per page in edited order; a cover run collapses and takes a composite title; a theory section renders its questions; a logbook renders its columns; the pager index clamps when sections are removed.
- **Verification:** `pnpm --filter @formai/web test`; manual AE3.

### Phase C — Answer key and the matching engine (Step 5)

*The highest-value phase: it is what retires the answer-key file and the authoring script.*

#### U9. Matching authoring model
- **Goal:** `MatchingQuestion` in, `checkbox_group` + `options` + `answerKey` out, plus a render hint.
- **Requirements:** R18, R19
- **Dependencies:** U1
- **Files:** `packages/shared/src/matching.ts` (+ `matchPresentation`), `apps/web/src/screens/assessments/builder/matching-authoring.ts` + tests
- **Approach:** A thin authoring layer over the existing `buildMatchingQuestion`: seed sides from the extraction (both, one, or none), split combined printed rows where only options exist (the prototype's three regexes, ported with their tests), and surface `MatchingQuestionError` messages verbatim — they are already written for a human.
- **Test scenarios:** both sides present → options and key built; one side present → builder seeds and says so; neither → blank rows; a duplicate statement is refused with the existing message; a side containing `->` is refused.
- **Verification:** `pnpm --filter @formai/shared test`, `pnpm --filter @formai/web test`.

#### U10. `PairBuilder`
- **Goal:** Author statements and matches, with images on either side.
- **Requirements:** R19
- **Dependencies:** U9
- **Files:** `PairBuilder.tsx`, plus an `ImageSlot` component
- **Approach:** Two-column rows with add/remove and a Save that writes through U9. Per-side "Statements are images" / "Matches are images" toggles reveal one upload slot per row. **`image-slot.js` is not ported** — its `.image-slots.state.json` sidecar is a design-tool mechanism. Slots use the repo's existing upload route and store asset ids on `matchPresentation`.
- **Test scenarios:** saving upgrades the question and immediately enables the key editor; toggling images left yields exactly one slot per statement and none on the right; the photo heuristic requires an actual image word (`photo`, `diagram`, `figure` …) so a bare "Warning sign" does not produce empty slots — the prototype's own correction.
- **Verification:** `pnpm --filter @formai/web test`.

#### U11. Answer-key editor
- **Goal:** Key every question, correct its type, verify it.
- **Requirements:** R17, R18, R20, R21
- **Dependencies:** U9, U10
- **Files:** `steps/AnswerKeyStep.tsx`, `KeyEditor.tsx`
- **Approach:** Set tabs, question list with keyed/unkeyed/verified icons, a progress bar, an option list that toggles single vs exact-set by type, the type switcher (TF / MC / MA / Matching / Fill the blank) writing back to the draft's field list, the pair key editor with its incomplete-pairs warning, the "on the printed PDF this draws …" explainer sourced from `markSentence`, and the verified toggle recording who and when.
- **Test scenarios:** an MA question accumulates a set; an MC question replaces; converting to Matching opens the builder and clears the stale key; verification records the actor; keys never appear in any payload a fill surface receives (asserted against `stripMarkingSecrets`).
- **Verification:** `pnpm --filter @formai/web test`.

#### U12. Answer-guide upload (JSON and PDF)
- **Goal:** Seed a key from a guide instead of typing 31 answers.
- **Requirements:** R16
- **Dependencies:** U11
- **Files:** `apps/api/src/routes/answer-guides.ts` + test, `KeySourceChooser.tsx`
- **Approach:** JSON parses client-side in both shapes the prototype accepts — the repo's `{"sections":{…}}` shape and a flat `{"answers":{"General:4":["b","c"]}}` — with flexible section-name matching and letter-or-index answers. PDF goes to a new server route that runs the same match prompt the prototype ran client-side, against the extracted questions, returning `{ answers: { fieldId: string[] } }`. Seeded answers land keyed **and** flagged as seeded-not-verified, so the coordinator still attests.
- **Test scenarios:** the repo's own `track-dozer.answer-key.json` seeds 31 answers (AE5); an unmatched section is reported, not silently dropped; a JSON with no matches errors with the expected shapes named; the PDF route refuses without tenant auth.
- **Verification:** `pnpm --filter @formai/api test`, `pnpm --filter @formai/web test`.

### Phase D — Units, pathways and gating (Step 4)

#### U13. Manifest authoring
- **Goal:** Build a valid `AssessmentToolManifest` in the UI.
- **Requirements:** R13, R14, R15, R28
- **Dependencies:** U6, U11
- **Files:** `steps/UnitsStep.tsx`, `builder-manifest.ts` + test
- **Approach:** Sections become parts: kind, ordinal (printed order, immutable), pathway membership chips, `startFieldId` from the section's first field, `mandatoryFieldIds` from the set the setup questions named, `minimumHours` + `durationColumnKey` for logbooks, and `checklistMark` where a method-tracking row exists. Prerequisite rows detected by U3 become `candidatePrerequisiteIds` proposals. `validateManifest` runs live and every problem is shown at once, in its own words.
- **Patterns to follow:** `author-track-dozer-tool.mjs`'s derivation logic is the reference implementation — port its rules, drop its heuristics where the UI can simply ask.
- **Test scenarios:** a logbook part with no duration column shows that exact problem; reordering changes process order and leaves `ordinal` alone; a mandatory question with no key surfaces the validator's message (AE8).
- **Verification:** `pnpm --filter @formai/web test`.

### Phase E — Placement and glyphs (Step 6)

#### U14. Whole-box drag, nudge and delete
- **Goal:** Fix the prototype's stated pain: "it snaps once and I can't edit it".
- **Requirements:** R23
- **Dependencies:** none (improves the standalone placement screen immediately)
- **Files:** `apps/web/src/screens/import/PdfViewer.tsx`, `GeometryEditorScreen.tsx`, `inspector/geometry-actions.ts` + tests
- **Approach:** Extend the existing band-edge nudge to whole boxes: pointer-drag to reposition a placed segment, arrow keys ±1pt (Shift ±10pt), Delete/Backspace to remove, all routed through the same `handleAdjustment` seam so there is still one movement path.
- **Test scenarios:** drag updates x/y only; nudge respects Shift; delete removes exactly the selected segment; a box cannot be dragged off the page.
- **Verification:** `pnpm --filter @formai/web test`; manual AE7.

#### U15. Grouped, filterable field list with response/outcome pairs
- **Goal:** Make 300 boxes navigable, and make the two-location requirement visible.
- **Requirements:** R22, R25
- **Dependencies:** U14
- **Files:** `GeometryEditorScreen.tsx`, `inspector/*`
- **Approach:** Group the list by part/page with counts and collapse; add a filter over label *and* question text; render each theory question as one row with two placement chips — **Response** and **Outcome** — where response is geometry on the question field and outcome is geometry on the field its `outcomeTarget` names (KD5). Show the question's text under the row, as the prototype does.
- **Test scenarios:** filtering matches question text; a question whose outcome target is unresolved says so rather than showing an unplaceable chip; placed counts per group are correct.
- **Verification:** `pnpm --filter @formai/web test`.

#### U16. Authored glyphs — inspector, preview and exporter seam
- **Goal:** Let an author choose the mark, and be honest about which choices draw.
- **Requirements:** R24, R26
- **Dependencies:** U1, U14
- **Files:** `inspector/GeometryInspector.tsx`, `apps/web/src/lib/mark-description.ts`, `apps/api/src/pdf/round-trip.ts` + tests
- **Approach:** A glyph grid, ink swatches and size toggle writing `markStyle` onto the segment. `resolveMarkStyle(field, segment)` in the exporter: absent → today's behaviour, exactly. v1 honours tick / cross / ring / typed / signature / date (KTD4, OQ3). Extend `markDescription` with the response/outcome and matching sentences the prototype wrote — they are good copy and they are correct.
- **Test scenarios:** a segment with no `markStyle` produces a byte-identical export to today (characterization test first); a `ring` style on an outcome cell draws a ring; a style not yet honoured is flagged in the inspector and drawn as its type default; `markDescription` distinguishes response from outcome.
- **Verification:** `pnpm --filter @formai/api test`, `pnpm --filter @formai/web test`.

#### U17. Placement step inside the builder
- **Goal:** Mount the placement screen against the builder draft.
- **Requirements:** R22–R26
- **Dependencies:** U14–U16
- **Files:** `steps/PlacementStep.tsx`, `GeometryEditorScreen.tsx` (data-source prop)
- **Approach:** Parameterise the screen's source: version-backed (today) or draft-backed (builder). One component, two mounts (KTD7).
- **Verification:** manual AE9 — reload mid-placement and confirm every box survives.

### Phase F — Workflow and publish (Step 7)

#### U18. Workflow step
- **Requirements:** R27
- **Dependencies:** U13
- **Files:** `steps/WorkflowStep.tsx`, `apps/web/src/screens/assessments/WorkflowBuilderScreen.tsx`
- **Approach:** Reuse `WorkflowBuilderScreen`'s access matrix and value-source controls against the draft manifest; add the datapoint picker modal (case record / theory marking / sign-off capture / prior answers) writing `fieldSource` + the mapping. `validateWorkflow`'s warnings render inline — including "nobody fills this section", which is the one an author most needs.

#### U19. Publish
- **Requirements:** R28, R29
- **Dependencies:** U13, U16, U18
- **Files:** `steps/WorkflowStep.tsx`, `apps/web/src/lib/data/hooks.ts`, `apps/api/src/routes/assessments.ts` (no new endpoint)
- **Approach:** Resolve structure → fields, write the version, publish it, then create/update the tool. Refuse on any validator problem, naming all of them. Show the prototype's publish summary (units, questions keyed, boxes placed, roles) and land back on Assessments with the tool marked Published. Retire `author-track-dozer-tool.mjs` in the same change, or reduce it to a wrapper — leaving both paths writing manifests is how they drift.

### Phase G — Interactive theory (fill surface)

#### U20. Matching interactive in `FieldRenderer`
- **Requirements:** R30
- **Dependencies:** U9, U10
- **Files:** `apps/web/src/screens/fields/FieldRenderer.tsx`, `MatchingField.tsx` + tests
- **Approach:** Render a matching `checkbox_group` per its `matchPresentation`: **draw-a-line** (colour-coded SVG connectors between dots, click-to-pair, click-to-clear) or **drag-to-match** (tray + drop slots), with image slots on whichever side is images. The *value* written is unchanged — the set of chosen pairing options — so marking, export and every existing test stand.
- **Test scenarios:** completing all pairs writes exactly the pairing options; clearing a pair removes exactly one; a pairing that reuses a target is allowed (the model permits non-bijections); the grouped-options fallback still renders when no presentation is set.

#### U21. One-question-per-screen theory player
- **Requirements:** R31
- **Dependencies:** U20
- **Approach:** A paged presentation of a theory part's questions with prev/next and an optional progress bar, chosen by the tool's setup answer. Presentation only — the attempt's values are unchanged.

### Phase H — Design chat (Step 3)

#### U22. Chat rail with a defined operation set
- **Requirements:** —
- **Dependencies:** U6, U8
- **Approach:** The chat performs a **closed set** of real operations against the draft — reorder a section, change a question's type, set a matching presentation, toggle the progress bar, change a field's label — each one a named function the model selects with arguments, applied through the same reducers the UI uses, and each one visible in the artifact immediately. Anything outside the set gets an honest "I can't do that here yet" rather than a canned success. Per KD7/OQ4, if this phase is not funded, Step 3 ships as the artifact plus a labelled placeholder rail.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Types | `pnpm typecheck` | all units |
| Shared tests | `pnpm --filter @formai/shared test` | U1, U9 |
| API tests | `pnpm --filter @formai/api test` | U2, U3, U12, U16 |
| Web tests | `pnpm --filter @formai/web test` | U4–U11, U13–U15, U17–U22 |
| Migration | `pnpm db:generate` produces exactly one migration; `pnpm db:migrate` applies clean | U2 |
| Export characterization | Round-trip export of an existing placed version is byte-identical before and after `markStyle` lands | U16 |
| Manual — AE1 | Upload an unseen assessment PDF; three cover sections, prerequisite present, both matching questions two-sided | U3, U5 |
| Manual — AE5 | Drop `track-dozer.answer-key.json`; 31 answers seeded, banner counts them | U12 |
| Manual — AE7 | Drag, nudge and delete a placed box | U14 |
| Manual — AE9 | Reload mid-Step-6 on another machine; document, placements and keys intact | U2, U17 |
| Manual — end to end | Build a tool from PDF to Published without touching a script or a database URL, then run a case through it and export the evidence PDF per the existing runbook's step 7 checks | U19 |

## Definition of Done

- A coordinator can take a never-seen assessment PDF from upload to a published, enrollable assessment tool entirely in the app.
- `author-track-dozer-tool.mjs` is retired or reduced to a wrapper over the same code path; no second manifest writer remains.
- No answer key exists as a file in any repository; keys live on the version's fields and are never served to a fill surface.
- The cover page always resolves into the three named sections, and no prerequisite row is dropped.
- Every matching question is keyable and renders as an interactive; none is left as unanswerable text.
- Every theory question can map both a response location and an outcome location, and the exported PDF shows the candidate's answer *and* whether it was correct.
- A placed box can be moved, nudged and deleted; nothing requires delete-and-retry.
- An authored glyph either draws as authored or is stated in the inspector as not-yet-drawn. Nothing is silently ignored.
- A builder session survives a reload, a new browser and a different machine.
- `pnpm typecheck` is clean and every package's tests are green.
- No dead-end or exploratory code from ruled-out approaches remains in the diff — in particular, no `window.claude` call, no `image-slot.js` sidecar, and no port of `heuristicExtract`.
