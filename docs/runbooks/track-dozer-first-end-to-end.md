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
pnpm install
```

No migration needed — the schema is unchanged since `0020`.

**Check:** `git log --oneline -1` shows commit `7af82ad` or later.

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

### 3d. Outcome cells — 31 boxes, propagated from one you draw

These have no automatic rule — their labels are names the extractor invented and
appear nowhere on the page. So:

1. Draw the **first** outcome cell by hand, on the printed tick/cross box beside
   question 1.
2. Every subsequent one is offered as that same box on its own question's row,
   at confidence **0.75** — the column is yours, the row is derived.

**Check:** each proposed cell sits on its own question's row, not the row above
or below. If they are consistently a few points high or low, tell me the
direction — the offset is measured from your exemplar, so a systematic drift
means the measurement is off.

### 3e. Scalars — ~35 boxes, all by hand

Names, dates, signatures, textareas. No rule covers these; draw each one.

**Check before publishing:** the header counter reads close to `150/150`. A
field left unplaced exports as recorded data rather than a mark on the page —
visibly incomplete, which is the safe failure, but you want to know which.

---

## 4. Publish, then rebuild the assessment tool

Publish from the review step's third tab. This creates a new **published**
version and makes it current.

Then re-derive the manifest, answer keys and outcome targets against the new
field ids:

```bash
cd packages/db && DATABASE_URL=postgresql://postgres:password@helium/heliumdb?sslmode=disable node scripts/author-track-dozer-tool.mjs
```

**This is a dry run. Read the report.** It shows the six part anchors it found
and the 31 question/outcome pairs it mapped.

**Check:** exactly **31 pairs** and **6 part anchors**. If the pair count is
anything else the script refuses to write, which is correct — it means the
re-import shifted something and the mapping would be wrong.

Then, only once the report looks right:

```bash
cd packages/db && DATABASE_URL=postgresql://postgres:password@helium/heliumdb?sslmode=disable node scripts/author-track-dozer-tool.mjs --write
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
confirm it comes back not satisfactory.

---

## 7. Export the evidence PDF

**There is no button for this yet.** The route exists and is tested, but nothing
in the UI calls it. So from a shell, with a session cookie:

```bash
curl -sS -X POST "http://localhost:5000/assessment-cases/<CASE_ID>/export" -H "cookie: fai_session=<YOUR_SESSION>" -o dozer-evidence.pdf && ls -l dozer-evidence.pdf
```

Get `<CASE_ID>` from the case URL. Get `<YOUR_SESSION>` from the `fai_session`
cookie in your browser devtools.

**Check the PDF itself** — this is the whole point of the exercise:

- 18 pages, the original form, with answers overlaid in place.
- Each answered theory question has a **ring** around the answer given: green if
  correct, red if not. Only the answer given is ringed, never the correct one.
- Each outcome cell has a **tick or a cross** — not the letter `X`, and not
  blank for an incorrect answer.
- Parts outside the pathway print blank. That is correct, and mirrors the paper.

If a mark is in the wrong cell, note which field and which page. That is the one
error class worth stopping for: a mark in the wrong cell of a competency record
is a statement that somebody was assessed on something nobody checked.

---

## Known gaps you will hit

| Gap | Effect |
|---|---|
| No export button | Step 7 needs curl. Small to add — say the word. |
| No location-stream question on the paper | Mining vs Raw Materials content is not gated per candidate; every candidate sees both sets. Fail-open by design. |
| Answer key lives in git | `docs/assessment-tools/track-dozer.answer-key.json` is the complete key to a safety-critical assessment. Moves to the DB once upload-at-import exists. |
| Rings sized from your box | If they read too tight or too loose against the printed letters, `RING_PAD` / `RING_MIN_RADIUS` in `apps/api/src/pdf/round-trip.ts` are the dials. |

---

## If something looks wrong

Report the **field id, the page, and what you expected** — that is enough to
reproduce it in a test. The proposal rules all refuse rather than guess, so a
missing proposal is the designed behaviour and a *wrong* proposal is a bug.
