---
title: "feat: Assessor feedback & declaration completed at sign-off"
date: 2026-09-09
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# feat: Assessor feedback & declaration completed at sign-off

## Product Contract

### Summary

The assessor's closing block on a competency paper — "Assessor's Feedback",
the assessor declaration ticks — is completed **at sign-off**, in the same
dialog as the assessor's name and signature, rather than as a part of the
assessment that has to be attempted, handed in and marked. The manifest's
existing `signOff` block gains a list of *sign-off fields*; the case row
stores the answers; the exporter prints them beside the name, signature, date
and verdict it already writes at sign-off.

### Problem Frame

On Track Dozer the "Assessor's Feedback and Declaration" block was published
as a part. Parts complete in two ways only: a person marks them, or (for a
declaration) hand-in completes them once every required field in the slice is
filled. Neither fits the assessor's closing block. The hand-in route refuses
because a required field in the slice is not the assessor's to write; the
marking kit makes no sense for a block with nothing to mark. The case can
never reach `awaiting_sign_off`, because sign-off refuses while any required
part is not satisfactory. The experienced pathway shows it first because it
has fewer parts and this one is the last thing standing.

The sign-off route already writes the assessor's printed block from the case
row: `signedOffName`, `signedOffSignature`, `signedOffAt`, the Competent /
Not Yet Competent pair and the coaching pair. Feedback and the assessor
declaration are the same kind of thing — the assessor's attestation, made
once, at the end — so they belong on the same row and in the same act.

Verified facts that shape the design:

- `fieldsInPart` slices from a part's anchor to the next part's anchor, and
  the LAST part runs to the end of the document. A closing block printed after
  the last part falls inside that part's slice unless something excludes it.
  The prerequisite boxes already set the precedent: `manifest.prerequisiteChecks`
  is filtered out of every slice "wherever it prints".
- The tool PATCH route's zod schema SILENTLY STRIPS any manifest key it does
  not list. A new `signOff` property must be added to `signOffSchema` or the
  workflow editor's next save erases it.
- Publish derives `signOff` from the extraction's `assessor_declaration` cover
  slice; `composeRevisionManifest` grafts seeded pointers per key so a
  republish never clobbers an author's mapping.
- Tools that already published the block as a part (Track Dozer) cannot have
  a part removed through the PATCH route — parts change only through a
  revision republish, which runs through the builder's Units step.

### Requirements

- **R1.** `AssessmentToolManifest.signOff.fieldIds?: string[]` names the
  fields the assessor completes at sign-off. They belong to NO part: every
  consumer of `fieldsInPart` (fill surface, hand-in completeness, marking,
  export of attempts, publish warnings) stops seeing them.
- **R2.** The case row stores the answers (`sign_off_values` jsonb, `{}` by
  default). Written once, by the sign-off route, in the same transaction as
  the certification.
- **R3.** The sign-off route accepts `values`, refuses ids outside the
  manifest's sign-off fields, and refuses (`400 sign_off_incomplete`, naming
  the boxes) when a required, visible sign-off field is empty. A tool with no
  sign-off fields behaves exactly as today.
- **R4.** The case detail carries the sign-off fields (marking secrets
  stripped, document order) and the stored values, so the dialog renders the
  real fields with the real renderer and the case screen can show what was
  signed.
- **R5.** The sign-off dialog renders each sign-off field with `FieldInput`
  above the name and signature, checks required fields locally, and sends
  `values`. After signing, the case screen shows the feedback read-only.
- **R6.** The exporter writes sign-off field values into the printed values
  ONLY once the case is signed — the same gate as the name, signature and
  Competent tick — so a mid-programme export prints the block blank.
- **R7.** Builder, new tools: the fillable fields of the extraction's
  `assessor_declaration` cover slice that are not the name / signature / date /
  verdict pointers become `signOff.fieldIds` automatically.
- **R8.** Builder, any tool: in Units & gating a section can be marked
  **Sign-off block**. It stops being a part; its fillable fields become
  `signOff.fieldIds`. A revision draft of a tool whose manifest already names
  sign-off fields opens with that section shown as the sign-off block.
- **R9.** Republish keeps an author's sign-off fields the same way it keeps
  the pointers: the derivation wins when it names any, otherwise seeded ids
  that still resolve are carried.
- **R10.** Validation: every sign-off field id must exist in the version and
  must not be one of the system-written pointers or marks (name, signature,
  date, verdict pair, coaching pair) — those are written by the sign-off, not
  typed.

### Non-goals

- Editing `signOff.fieldIds` from the published-tool workflow editor. The
  PATCH schema carries the key (R3's stripping rule), but no picker is added:
  moving a block out of a part is a republish, and the Units step is where
  that decision is made.
- Candidate-visible feedback. The values are shown on the case screen to
  whoever can see the case; no notification, no candidate sign-back.
- Migrating existing Track Dozer cases' attempt data for the old part. Once
  the tool is republished without that part, open cases simply stop requiring
  it; a stood-down or unmarked attempt at the old part stays in the trail.

## Increments

### U1 — Shared: the sign-off field set (R1, R10)

- `signOff.fieldIds?: string[]` on the manifest type, documented.
- `fieldsInPart` excludes them alongside `prerequisiteChecks`.
- `signOffFields(fields, manifest)` — document order.
- `missingSignOffFields(fields, manifest, values)` — required, visible,
  empty; shares its emptiness rule with `missingDeclarationFields`.
- `validateManifest` and `validateSignOffMarks` check existence and the
  no-overlap rule.
- Tests in `assessment.test.ts`.

### U2 — Storage and API (R2, R3, R4, R6)

- `assessmentCases.signOffValues` jsonb, migration 0072.
- `signOffSchema` gains `fieldIds`.
- Sign-off route: `values` accepted, foreign ids refused, required check,
  stored. Case detail returns `signOffFields` + `signOffValues`. Export
  route passes `values` into `signOff`; `assembleCaseValues` writes them
  inside the signed gate.
- Tests: route (stores, refuses foreign, refuses incomplete, no-fields tool
  unchanged), export (written only when signed).

### U3 — Case screen (R5)

- Client + hook accept `values`; detail type gains the two fields.
- `SignOffDialog` renders sign-off fields with `FieldInput`, local required
  check, sends values, maps `sign_off_incomplete`.
- Read-only "Assessor's sign-off" block on a signed case.
- Tests in `AssessmentCaseScreen.test.tsx`.

### U4 — Builder (R7, R8, R9)

- `DerivedPart.signOffBlock?: boolean` (bookkeeping, never stored).
- `buildManifest` drops sign-off-block parts and folds their fillable fields,
  plus the cover's leftover assessor-declaration fields, into
  `signOff.fieldIds`.
- Units step: a "Sign-off block" choice in the kind select; the card explains
  itself and hides pathway toggles.
- `overridesFromManifest` marks a section as sign-off block when every
  fillable field in it is a sign-off field; `composeRevisionManifest` grafts
  `fieldIds`.
- Tests: `builder-manifest.test.ts`, `UnitsStep.test.tsx`,
  `builder-publish.test.ts`, `revision-seed` where it has tests.

## Rollout

- Migration 0072 to both ledgers before deploy (additive, defaulted).
- Track Dozer: start a revision, mark "Assessor's Feedback and Declaration"
  as Sign-off block in Units & gating, republish. Open cases pick the change
  up on the next read.
