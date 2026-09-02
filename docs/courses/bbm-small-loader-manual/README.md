# BBM Small Loader — Manual course (with the in-deck theory)

Interactive SCORM course deck built from the **BBM Small Loader Manual**
(01026626 v3.0) in the South32 Worsley Alumina look. Candidates work through
six modules before their *Authorised to Operate Small Loader* practical; the
tool's **sixteen Part 1 theory questions are embedded in the deck**, one module
at a time, and graded server-side as they are answered (Option B —
`course.assessmentInDeck`).

## Source

Authored for the shared **course-deck-builder** skill
(`.claude/skills/course-deck-builder/`):

- `deck.json` — brand (South32 navy `#2B3A42` / amber `#F5B301`), the module
  map, the ordered slide list, and each module's **graded `questions`**.
- `slides/*.html` — one `<section>` per slide, `data-title` in the header.
- `img/` — the South32 wordmark and transparent header logo. The manual has no
  content photographs, so the deck is typographic.

## Module map ↔ paper questions

| Module | Manual sections | Paper questions |
| --- | --- | --- |
| A — Authority, Access & Isolation | §4–§5, §6.2, isolation & tags (SME manual / practical) | Q1, Q2, Q4 |
| B — Pre-start & Machine Condition | §10, §10.1, fluids & warning lights | Q3, Q6, Q13 |
| C — Start-up, Interlocks & Checks | §6, §6.1, §7, §8.1 | Q10, Q12, Q15 |
| D — Moving Off, Travel & Braking | §8, §9, §9.1 | Q5, Q7, Q11 |
| E — Hazards, Attachments & Special Tasks | §11–§15 | Q14 |
| F — Hopper Clean-up, Incidents & Emergencies | §16, §17, fire / emergency exit | Q8, Q9, Q16 |

The question `number` in `deck.json` is the number printed on the paper — it is
the join key the author script uses (below). Answers are **never** in this
directory; the key lives in `docs/assessment-tools/small-loader.answer-key.json`
(sensitive) and is written to the tool by the author script.

## The ids are the tool's real ids

Each graded card carries the field id of its question on the **seeded**
template (`sl-q1` … `sl-q16`, from `docs/assessment-tools/small-loader.template.json`)
and posts the question's real option strings (`a) True`, `d) All of the above`,
…), which is what the tool's `answerKey` matches. The host grades a
`course-answer` by exactly those, so the zip built from this directory is the
one to upload — no reconciliation step.

If the tool is ever re-authored against a template imported by hand (different
ids), the author script's `--deck` step rewrites the cards from the pairing:

```bash
cd packages/db
DATABASE_URL=… node scripts/author-small-loader-tool.mjs \
  --key ../../docs/assessment-tools/small-loader.answer-key.json \
  --deck ../../docs/courses/bbm-small-loader-manual          # dry run: rewrites deck.json only
```

Against the seeded template it reports "Deck already matches" and touches
nothing. After a rewrite, rebuild.

## Build

From this directory:

```bash
python3 ../../../.claude/skills/course-deck-builder/scripts/build_deck.py .
```

That regenerates `package/` and `bbm-small-loader-manual-course.zip` (both
git-ignored — build artifacts, not source). Upload the `.zip` in FormAI's
Course-material card, tick *Required before the assessment can start*, and link
the tool to it with the assessment **in the deck** (or pass `--course-id` to
the author script with `--write`).

To sanity-check the packaged deck in a sandboxed iframe (the same environment
FormAI serves it in):

```bash
node ../../../.claude/skills/course-deck-builder/scripts/verify_deck.mjs package
```
