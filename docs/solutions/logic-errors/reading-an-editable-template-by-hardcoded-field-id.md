---
title: Reading an editable template by hard-coded field id silently loses answers
date: 2026-08-05
category: logic-errors
module: induction
problem_type: logic_error
component: service_object
symptoms:
  - "A question answered on the intake form arrives at the MCP as an empty string"
  - "A starter disappears from list_induction_candidates entirely, with nothing logged"
  - "Consumers cannot tell an unanswered question from one the form never asked"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components: [mcp-inductions, form-builder, submissions-api]
tags: [template-versioning, field-ids, editable-template, silent-data-loss, chc-intake]
---

# Reading an editable template by hard-coded field id silently loses answers

## Problem

The CHC induction intake collected a starter's Ethnicity, but the MCP returned
`ethnicity: ""`. A BISTrainer profile built from that payload recorded nothing
where the person had actually answered. In a worse variant of the same fault, a
starter vanished from every induction tool with no error anywhere.

## Symptoms

- `get_induction_candidate` / `list_induction_candidates` return a blank for a
  field the form visibly asks for and the submission visibly contains.
- A submission that *should* be an intake is absent from the candidate list, and
  no log line, audit entry, or error explains the absence.
- Downstream consumers treat the blank as "the starter skipped it" and write a
  default (`Unknown`) into an external system.

## What Didn't Work

- **Suspecting the shared reader's logic.** `readStarterProfile` and its unit
  tests were correct and passing — against `chcIntakeFields()`, the *canonical*
  field list. The bug only exists when the stored template differs from it, and
  every test supplied the canonical one.
- **Suspecting `stripHiddenValues` of eating the answer.** It leaves ids with no
  matching field alone, by design and by comment. A submitted `ethnicity` key
  survives even against a template that has no such field.
- **Suspecting the web form's mapping.** `chcSubmissionValues` writes the right
  key, and a test already asserted it.

Each was ruled out by tracing the value forward from the browser rather than
backward from the symptom. The mistake was assuming the two ends of the pipe
agreed on ids because both imported the same constant — the *stored template
version in between* imports nothing.

## Solution

Resolve each canonical question to the id actually carrying it in that
submission's pinned template version, instead of reading `values[CONSTANT]`.

```ts
// Before — assumes the stored template still uses the preset's ids
const ethnicity = text(values, CHC_FIELD_IDS.ethnicity);

// After — resolve against the version the submission is pinned to
const at = resolveChcIntakeFields(fields);
const ethnicity = text(values, at.get(CHC_FIELD_IDS.ethnicity));
```

`resolveChcIntakeFields` matches by exact id first, then falls back to the
question's **option list** for choice fields — the part an administrator
reproducing a question copies verbatim, while the id is assigned for them.

The fallback refuses rather than guesses:

| Situation | Resolves to | Why |
|---|---|---|
| Preset id present | itself | An authored id is never overridden |
| Exactly one field with matching options | that field | The question, under a new name |
| Options were edited | nothing | Changed vocabulary is a different question |
| Two fields, identical options | nothing | Nothing says which one owns the answer |
| Text/date question re-created | nothing | An answer shape cannot identify a renamed text box |

Detection uses the same resolution, which is what fixes the disappearing
starter: `department` is one of the ids `readStarterProfile` detects an intake
on, and the routes skip an undetected submission silently.

Finally, a question the version never carried is now named rather than blanked:

```ts
notCollected: expected.filter((id) => !at.has(id)),
```

with an `intake_incomplete` warning on the verdict. A warning, not a blocker —
a seat is bookable without an ethnicity; the registration that follows is not.

## Why This Works

The bug is a disagreement about what a field id *is*. Two surfaces import
`CHC_FIELD_IDS` and therefore agree. Between them sits a
`form_template_versions` row — a **snapshot copy** of the fields taken when an
administrator created the form, which imports nothing and never updates. Two
ordinary, supported actions make that snapshot disagree with the constant:

1. **Editing the form in the builder.** New fields get generated ids (`b7`), so
   a question added or re-created there never carries the preset id. This is
   working as intended — the preset explicitly produces "an ordinary unsaved
   draft" that can be edited freely.
2. **Time.** A template published before a question was added to
   `chcIntakeFields()` keeps its old field list forever. Nothing re-publishes it.

Ethnicity was maximally exposed to both: it was *added* to the form after the
template was first published, so it is the question most likely to be either
absent from the stored version or present under a builder id.

Matching on the option list works because that is the part a human reproducing
a question copies exactly, while the id is machine-assigned. Refusing on
ambiguity works because the alternative — picking one of two candidates — writes
an invented fact about a person into a compliance record.

## Prevention

- **Never read a user-editable template's answers by a hard-coded id.** If the
  product lets administrators edit a form, its ids are data, not API. Resolve
  through a lookup that can fail loudly.
- **Test the reader against a *drifted* template, not only the canonical one.**
  Unit tests that build fixtures from the same function the production code
  imports can never catch this class — both sides share the assumption:

  ```ts
  // The test that would have caught it
  const edited = chcIntakeFields().map((f) =>
    f.id === CHC_FIELD_IDS.ethnicity ? { ...f, id: 'b7' } : f,
  );
  expect(readStarterProfile(edited, values)!.ethnicity).toBe('Aboriginal');
  ```

- **Distinguish "not asked" from "not answered" in any payload crossing a system
  boundary.** An empty string collapses two facts with different remedies; only
  one of them can be chased up with the person.
- **Treat "the routes skip it silently" as a defect multiplier.** Detection that
  returns null and callers that `continue` on null turn a small mismatch into a
  total disappearance. Where silence is unavoidable, make the skip observable.
- **Audit discarded values on every write door, not just the untrusted one.** The
  public fill-link route recorded stripped ids; the authenticated route did not,
  so the same data loss was traceable through one door and invisible through the
  other.

## Related Issues

- `AWyborn2/SPROUTFormsAi#115` — the fix
- `AWyborn2/SPROUTFormsAi#80` — added the Ethnicity question and warned about the
  same silent-disappearance mode from the other direction (`in_beakon` in
  `REQUIRED_SHAPE`)
- `docs/induction-mcp.md` — operator-facing description of `notCollected` and the
  `intake_incomplete` warning
