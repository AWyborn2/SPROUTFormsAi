# Extraction-prompt tuning — corpus-driven

A handoff for a **fresh session** whose job is to improve PDF extraction across
**all** assessment papers, from a corpus of real documents — not to tune one
paper. Read this first, then work against the corpus.

## Goal

Make the extraction **generally** better. Every change should help the whole
document class, judged against a spread of papers, never a rule that fits one
form and breaks the next. If a fix only helps the Scraper, it is the wrong fix.

## The pipeline (where everything lives)

- `apps/api/src/pdf/extract.ts` — the two paths. **AcroForm** PDFs (real
  fillable fields) are read deterministically, no AI. **Flat** PDFs go to the
  model via a forced `extract_form_fields` tool call. Long papers are split into
  **4-page batches** (`EXTRACTION_PAGE_BATCH_SIZE`), run concurrently
  (`EXTRACTION_BATCH_CONCURRENCY`), then merged. `normalizeField` coerces each
  tool result into an `ExtractedField`.
- `apps/api/src/pdf/tool-schema.ts` — the `extract_form_fields` tool
  `input_schema` (mirrors `ExtractedField`), and the secondary-pass tool
  `report_missed_fields`.
- `apps/api/src/pdf/document-profiles.ts` — the per-type profiles **appended**
  to the base prompt. `ASSESSMENT_PROFILE` is the 17-rule set for competency
  papers. This is the main lever.
- `apps/api/src/pdf/audit.ts` — the opt-in secondary pass ("Check for missed
  boxes") that re-reads a PDF for inputs the first pass missed.
- `packages/shared/src/extraction.ts` — `ExtractedField` / `ExtractionResult`.

## Known failure modes to generalize away

Observed on real papers; each is a **general** slip, so fix it as a general
rule, not a paper-specific one:

1. **An answer option emitted as its own field.** After a question set changes
   layout (often at a batch boundary), the model can turn each lettered choice
   into a separate field instead of putting them in the question's `options`.
   Rule 1 forbids the inverse (questions-as-rows) but never says "an option is
   never its own field". Add that.
2. **Over-eager `selectionType: "multiple"`.** Default should be one-answer
   (`radio`); use `checkbox_group`/multiple only where the stem explicitly says
   select-multiple. Reinforce the default-single bias.
3. **False-positive matching.** Rule 10 turns anything read as two-sided into a
   `checkbox_group`/multiple with empty `options`. It fires too readily. Tighten
   it: a stem with ordinary lettered choices is never matching. (The builder now
   has a "Not matching" escape hatch for the survivors, but reducing them at
   source is better.)

### The batching interaction

Each 4-page batch is a separate call that cannot see the others, so
question-set formatting, a legend printed once, or a governing heading is often
out of view — the root of failure mode 1. Rules 11 and 13 already fight
versions of this. Levers to weigh: an explicit anti-pattern rule (cheap, safe,
try first); a wider batch or a one-page overlap (more context, more tokens);
or a "formatting precedent" hint.

## How to test a change

- **Golden/unit tests, no AI:** `apps/api/src/pdf/extract.test.ts` and
  `document-profiles.test.ts` mock the Anthropic client, so they pin parsing,
  normalization and profile wiring deterministically. Keep these green.
- **Real-PDF loop:** run extraction against the corpus with a live key. The
  cleanest harness is a small script that calls `extractForm(bytes, { … })`
  from `apps/api/src/pdf` for each corpus file and dumps the fields, so you can
  diff before/after a prompt change across the whole spread at once. (A key +
  the agent proxy are needed; see `/root/.ccr/README.md`.)
- **Judge broadly:** a prompt change is only good if it holds across the corpus.
  Note any paper it regresses.

## The corpus (do NOT commit it)

The assessment PDFs are **real, safety-critical documents**. Keep them out of
git — **drop them into the fresh session directly** (attach/upload), or place
them under `corpus/` (gitignored). Never commit the papers, and never surface
the answer-key files (`docs/assessment-tools/*.answer-key.json`) in extraction
work — they are authoring-staff-only.

A useful layout, per paper: the PDF plus a one-line note of its quirks
(multi-column choices, matching lists, checklists whose legend prints once,
character-identical repeated parts, back-matter that looks like a form). Those
quirks are the variation the prompt has to survive.

## Definition of done

- The `ASSESSMENT_PROFILE` (and/or base prompt) reads better across the corpus,
  with the three failure modes measurably reduced.
- Existing golden tests still pass; new deterministic tests cover the anti-
  patterns you added (e.g. an option is not emitted as its own field).
- No rule that only fits one paper.
