# Track Dozer: first end-to-end run

Getting from "all the machinery exists" to "a filled 18-page evidence PDF".

Everything below runs against the Replit dev database. Nothing here is
destructive to real records — but step 3 publishes a new template version, and
step 4 rewrites the assessment tool's manifest, so read each step's **check**
before moving on.

**Time:** the placement session (step 3) is the long one. Budget an hour or two
for a first pass, less once you know the rhythm. Everything else is minutes.

---

## Why a re-import comes first

The current template was extracted before the prompt learned about
`questionRef`, so none of its fields carry the printed question reference. That
reference is what pairs a question with its outcome cell, so without it:

- the 31 outcome cells stay unlinked, and no verdict is ever drawn on the
  exported PDF;
- the authoring script has to guess the pairing positionally, which it refuses
  to do unless it finds exactly 31 pairs.

A re-import is safe because **field ids are never referenced by hand**. The
answer key is keyed by question NUMBER, and `author-track-dozer-tool.mjs`
re-derives every id by matching text. Step 4 rebuilds the link.

---

## 0. Get the code

```bash
git checkout main && git pull
```

```bash
pnpm install && pnpm --filter @formai/shared build && pnpm db:migrate
```

All three, every time — not conditionally.

- **`db:migrate` is not optional.** `0022` adds the `awaiting_sign_off` enum
  value and the four `signed_off_*` columns, and the ORM selects them on every
  read — so without it the tool list and case list return 500 long before you
  reach sign-off. Nothing migrates on boot; that is a deliberate decision.
- **`shared build` is not optional either.** The authoring script in step 4 runs
  under plain `node`, which resolves `@formai/shared` to `dist/` — gitignored,
  and never populated by the dev servers. Skip it and step 4 dies with
  `ERR_MODULE_NOT_FOUND`.

**If the org is Business or Enterprise, skip this paragraph** — both enable
`assessments` and `competencyGating`, and Enterprise has no candidate seat cap.

On **individual or team** every assessment route is refused:
`requirePlanFeature('assessments')` is false on both, and they carry a candidate
seat limit of zero, so the tool list, the case list and the candidate picker all
come back empty or erroring. The web app discards the 403 body and renders
"Could not load assessment cases", which reads like a bug rather than a plan
gate — worth knowing before you go hunting. Settings → Billing to change it.

---

## 1. Record the starting point

```bash
cd packages/db && DATABASE_URL=postgresql://postgres:password@helium/heliumdb?sslmode=disable node scripts/inspect-template.mjs
```

Keep this output. It is your before-picture: 185 fields, `0/150` placed, 229
hand-drawn boxes across 128 fields.

**Check:** `PLACEMENT: 0/185`. If it is not zero, someone has already placed
geometry and you should find out what before overwriting it.

---

## 2. Re-import the PDF

In the app:

1. **Forms** → select **Authorised to Operate Track Dozer**
2. **Re-extract from PDF** (right-hand rail). This carries the form id in the
   URL, so the result becomes a **new version of the existing form** rather than
   a second form.
3. Upload the same PDF.
4. **Set the document type to `Assessment`.** This is the important one — it
   selects the extraction profile that emits questions as fields, keeps the
   practical checklists as tables, and now also asks for `questionRef`. Leaving
   it on `Generic` will collapse your 31 questions back into table rows and
   undo the whole thing.

**Check before leaving the review step:**

- Field count in the same ballpark as before (~185). A large drop means the
  profile did not apply.
- Roughly 31 `check_cross` fields.
- Questions appear **nested under their question** in the review list, with an
  "Outcome cell for Q1" caption. That nesting only renders when `questionRef`
  resolved — **if every outcome cell is still a separate top-level row, the
  references did not come through**, and steps 4 and 6 will not work. Stop and
  tell me.
- Read any warning banners about unpaired questions or orphan cells. Each one
  is a question whose verdict will never be drawn.

Do **not** publish yet — placement happens in this same review step.

---

## 3. Place the geometry

Still in the review step. Select a field on the left; its placement panel is on
the right; the PDF is in the middle. Placed boxes stay drawn on the page —
**solid green means confirmed, dashed amber means placed but not yet confirmed.**

Work in this order, because each group is cheaper than the last once the one
before it is done.

### 3a. Repeating tables — 22 fields, fully automatic

The practical checklists (`ai_98`–`ai_177`). Each should offer a detected grid.
Accept it, then check the grid lines sit on the printed rules before confirming.

### 3b. Practical criteria — ~23 fields, 46 boxes

`ai_129`–`ai_153`, options `✓ / ×` and `N/A`. These should offer **"Place all 2
boxes"** at full confidence — their options name the printed columns.

**Check:** the two boxes land in the tick and N/A columns down the right of the
page, not next to the criterion text.

### 3c. Theory questions — ~33 fields, ~115 boxes

`ai_29`–`ai_93`. Their answers print inline, so the boxes anchor on each
answer's own `a)` / `b)` marker.

**The number to watch is the confidence:**

- **1.0** — the checkboxes are real glyphs in the text layer and the boxes are
  exact.
- **0.5** — the checkboxes are vector strokes this module cannot read, so the
  boxes are *estimated* beside each answer. Check these against the page before
  confirming; the note says so too.

Q1 is the one to try first. It failed to match before the wrap fix, so it is the
canary: if Q1 proposes, the fix worked.

### 3d. Outcome cells — draw one, the other 30 are offered

Their labels are names the extractor invented and appear nowhere on the page, so
nothing can locate them from the document. But they are all the same box in the
same column, one per question row — so:

1. Draw the **first** outcome cell by hand, on the printed tick/cross box beside
   its question, and **confirm it**. Confirmation is what makes it an exemplar:
   it is the signal a human checked it against the page, and an unconfirmed box
   would propagate a guess thirty times over.
2. Every other outcome cell then offers **Use this box** — the same column and
   size, with the row derived from its own question's printed label, at
   confidence 0.75.

**Check:** each offered box sits on **its own question's row**, not the one above
or below. The confirm gate is per box, so a mistake here is a mark in the wrong
cell of a competency record — the one error class worth slowing down for.

If a cell offers nothing, its question's label could not be matched on the page —
too short, or printed more than once. Draw that one by hand and carry on.

### 3e. Scalars — ~35 boxes, mostly by hand

Names, dates, signatures, textareas.

**Some are now offered.** A single-line **text, date, number or time** caption
sitting in a bordered cell gets a measured box — the panel says what it measured
("… bounded on all four sides by printed lines") with a **Use this box** button.
Every edge comes from a printed stroke, including the height.

It declines, with a stated reason, for:

- **signatures and textareas** — always by hand;
- labels under 12 characters ("Date", "Name") — too short to identify a place;
- any caption printed more than once across the 18 pages;
- any caption not inside a bordered cell.

So expect a mix. Where it declines it says why, which is the difference between
"this looked and refused" and "nothing ran".

**Check before publishing:** sweep each page and confirm every field you meant
to place is drawn — placed boxes stay visible on every page, so gaps are
findable by eye. There is no counter on this screen; step 5's script is the
authoritative number and it only runs after publish. Publishing short is the
designed safe failure: an unplaced field exports as recorded data rather than a
mark, which is visibly incomplete, and the fix is a draft fork that keeps every
field id.

---

## 4. Publish, then rebuild the assessment tool

Publish from the review step's third tab. This creates a new **published**
version and makes it current.

Then re-derive the manifest, answer keys and outcome targets against the new
field ids:

The answer key is no longer kept in this repository. Point the script at wherever
you keep it with `--key` (or set `ANSWER_KEY_PATH`):

```bash
cd packages/db && DATABASE_URL=postgresql://postgres:password@helium/heliumdb?sslmode=disable node scripts/author-track-dozer-tool.mjs --key ~/track-dozer.answer-key.json
```

**This is a dry run. Read the report.** It echoes which answer key it loaded,
the six part anchors it found, and the 31 question/outcome pairs it mapped.

**Check three things:**

1. Exactly **31 pairs** and **6 part anchors**. Anything else and the script
   refuses to write, which is correct — it means the re-import shifted
   something and the mapping would be wrong. The report now names the questions
   that have no outcome box, so you can see where.
2. The pairing breakdown: ideally **"31 from the published questionRef link, 0
   inferred from document order"**. A pair read off the printed reference is one
   the extraction confirmed; an inferred one rests on layout order. A few
   inferred are survivable, but a high count means the references did not
   extract and you should look at the import before writing.
3. The key path echoed at the top is the one you meant.

Then, only once the report looks right:

```bash
cd packages/db && DATABASE_URL=postgresql://postgres:password@helium/heliumdb?sslmode=disable node scripts/author-track-dozer-tool.mjs --key ~/track-dozer.answer-key.json --write
```

---

## 5. Confirm the placement actually landed

```bash
cd packages/db && DATABASE_URL=postgresql://postgres:password@helium/heliumdb?sslmode=disable node scripts/inspect-template.mjs
```

**Check:** `PLACEMENT` is now near `150/150`, and `PLACEMENT WORK REMAINING`
lists only what you knowingly skipped. This reads the **published** version, so
if it still says `0/185` the placement did not publish — that is the failure mode
to catch here, not later.

---

## 6. Run a case end to end

In the app:

1. **Assessments** → **New case**. Pick the Track Dozer tool, a candidate, and
   the **New and inexperienced** pathway (that is the six-part programme).
2. Open the case → **Part 1 Theory** → **Start this part**.
3. **Open answers**, fill the 31 theory questions, **Hand in for marking**.
4. Back on the case, record the outcome. Theory shows no
   satisfactory/not-satisfactory control — the server computes it from the
   answer key, which is the point.

**Check:** the computed outcome matches what you expect from the answers you
gave. Deliberately get one mandatory question wrong on a second attempt and
confirm it comes back **not satisfactory** — and that the case stays open with
"more coaching required" rather than refusing to record it.

---

## 6.5 Sign the case off

**Do not skip this.** Marking the last part no longer makes a case competent —
it moves it to **Awaiting assessor sign-off**. Only an assessor approving it
reaches `competent`, because that is the state the printed record's name,
signature and date attest to, and none of them exist until a person supplies
them. Skip this step and the case parks forever and the certificate exports
with its front page blank.

1. Pass every part the pathway requires. The badge should change to
   **Awaiting assessor sign-off**.
2. Top right: **Sign off and certify**.
3. Type your name as it should print, and draw your signature. The date is
   stamped by the server and is not asked for — a certification date is a claim
   about when a judgement was made.

**Check three things:**

- The badge now reads **Competent**.
- The toast names the competency granted: **ATO - Track Dozer** (`Q34666893`).
  If it names none, that competency is not recorded in this org — step 4's dry
  run says so. The case is still competent and the certificate still prints;
  only the register is untouched. Create it and re-run step 4 with `--write`;
  the grant is an upsert, so re-running is safe.
- Try signing off a case with an outstanding part: it refuses with the parts
  named, and there is no override.

---

## 7. Export the evidence PDF

On the case, top right: **Export evidence PDF**. It downloads named for the tool,
the candidate and the date, so it stays identifiable months later on a shared
drive.

Available in any case state, not only once competent — a part that has not passed
prints blank, which is what the paper form looks like mid-programme.

Candidates do not see the button: the route refuses them, so offering it would
only produce a 403 they cannot act on.

If it fails, the message names the cause **and** the remedy. The six failures are
deliberately distinct — no source PDF, a manifest that no longer fits its form, an
attempt against an undeclared part, a missing tool, a storage fault, no permission
— because each wants a different next step. The manifest-mismatch case also says
plainly that nothing was drawn.

**Check the PDF itself** — this is the whole point of the exercise:

- 18 pages, the original form, with answers overlaid in place.
- Each answered theory question has a **ring** around the answer given: green if
  correct, red if not. Only the answer given is ringed, never the correct one.
- Each outcome cell has a **tick or a cross** — not the letter `X`, and not
  blank for an incorrect answer.
- Parts outside the pathway print blank. That is correct, and mirrors the paper.

**And the front page, which is what makes it a certificate rather than a marked
paper.** Every one of these is written only if step 4 resolved a pointer for it,
so a blank here means the manifest did not name the field — check step 4's
report before assuming the export is broken:

- **The candidate's name.** If this is blank the document certifies a verdict
  for nobody, which is the one omission an auditor cannot work around.
- The assessor's **name**, **signature** and the **sign-off date**.
- The **satisfactory** tick, and exactly one of the **more coaching required**
  Yes/No pair — never both, never neither on a finished case.
- Each part's own assessor name and date box, where the paper prints them.

If a mark is in the wrong cell, note which field and which page. That is the one
error class worth stopping for: a mark in the wrong cell of a competency record
is a statement that somebody was assessed on something nobody checked.

## Known gaps you will hit

| Gap | Effect |
|---|---|
| No location-stream question on the paper | Mining vs Raw Materials content is not gated per candidate; every candidate sees both sets. Fail-open by design. |
| Answer key lives in git | `docs/assessment-tools/track-dozer.answer-key.json` is the complete key to a safety-critical assessment. Moves to the DB once upload-at-import exists. |
| Rings sized from your box | If they read too tight or too loose against the printed letters, `RING_PAD` / `RING_MIN_RADIUS` in `apps/api/src/pdf/round-trip.ts` are the dials. |

---

## If something looks wrong

Report the **field id, the page, and what you expected** — that is enough to
reproduce it in a test. The proposal rules all refuse rather than guess, so a
missing proposal is the designed behaviour and a *wrong* proposal is a bug.
