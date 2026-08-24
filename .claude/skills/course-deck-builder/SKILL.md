---
name: course-deck-builder
description: >-
  Turn a PDF training manual (or other source material) into an interactive,
  sandbox-safe SCORM slide deck that uploads to FormAI's Course-material card
  and gates an assessment. Produces a self-contained slideshow — hub-and-spoke
  section menu, per-slide reading gate with a green tick and a live Next
  button, click-to-open interactive cards, full-view images, and a Start
  Assessment button at the end — packaged as a zip with imsmanifest.xml. Use
  this whenever someone wants to turn a manual, induction, procedure, handbook
  or SOP PDF into a course, e-learning module, interactive deck, or "course
  material" for an assessment; whenever they mention SCORM, an induction
  slideshow, pre-reading before an assessment, or getting a manual into FormAI;
  and whenever a course package renders as a scrolling page instead of a
  slideshow (that's the sandbox-CORS failure this skill's engine fixes). Prefer
  this over hand-building a deck — the bundled engine is already verified to
  work inside the player's sandboxed iframe.
---

# course-deck-builder

Turn a source manual into an interactive course deck FormAI can host in front
of an assessment. You extract the content and author the slides; a bundled,
content-agnostic engine and packager turn them into a **self-contained**
package that runs inside the course player's locked-down iframe, and a bundled
verifier proves it before you hand it over.

## Why this skill exists (read once)

FormAI runs a course package in a `sandbox="allow-scripts"` iframe whose origin
is opaque. Any package that boots by `fetch()`-ing its own files (React decks,
Claude-Design's `deck-stage.js`) is **CORS-blocked** there and silently
degrades to a stack of scrolling `<section>`s — no slideshow, dead buttons, a
permanently-locked menu. The engine here is plain inline JS with **no fetch and
no external runtime**, so it works in the sandbox. The full contract (the
postMessage bridge, the strict completion rule, the `deck-stage` detection
marker) is in `references/host-contract.md` — read it before changing the
engine or packager.

## What you produce

A `<slug>-course.zip` the user uploads via the workflow editor's **Course
material** card. Inside: a single `index.html` (all 52-ish slides + the inlined
engine), the images, and a SCORM 1.2 `imsmanifest.xml`. The reader gets a real
one-slide-at-a-time slideshow with animated transitions; a Section Menu that
unlocks parts in order and returns to itself between them; a Next button that
goes live after a reading beat sized to the slide *or* once every interactive
card is opened, with an animated green tick; and a Start Assessment button at
the end that sends them into the case.

## Workflow

Assemble everything under one **deck directory** (`deck/` with `deck.json`,
`slides/*.html`, `img/*`), then build and verify.

1. **Extract the PDF.** Get the text and the images you'll use into `deck/img/`.
   Use the `pdf` skill, or PyMuPDF directly — commands are in
   `references/authoring.md`. Read the text to understand the manual's chapters.

2. **Plan parts and slides.** Map chapters to 4–8 hub-and-spoke *parts*, each
   ~4–8 slides, one idea per slide. Decide which slides earn interactive cards
   (recall, dense reference tables) versus plain reading.

3. **Author the slides.** Write one full `<section>…</section>` per content
   slide on the 1920×1080 canvas, using the theme CSS variables so a brand
   change recolours everything. Card markup (flip / expander / accordion, each
   with a `data-touch`), the branding tokens, and full-view image handling are
   all in `references/authoring.md` — follow it; don't reinvent the card
   classes, the engine keys off them.

4. **Write `deck.json`** — title, brand, intro slides, parts, completion. Schema
   and an example are in `references/authoring.md` and the `build_deck.py`
   header. The menu, part dividers, and completion slide are generated from it.

5. **Build:**
   ```bash
   python3 .claude/skills/course-deck-builder/scripts/build_deck.py <deck-dir>
   ```
   Writes `<deck-dir>/package/` and `<deck-dir>/<slug>-course.zip`.

6. **Verify in the sandbox — do not skip.** This is the step that catches the
   failure mode the whole skill exists for. From a scratch directory:
   ```bash
   npm i playwright-core@1.49.1
   node .claude/skills/course-deck-builder/scripts/verify_deck.mjs <deck-dir>/package
   ```
   It serves the package, loads it in a real `sandbox="allow-scripts"` iframe,
   and drives the whole deck: boot, one-slide/no-scroll, menu gating, the
   interaction gate, honest reporting (every slide reported exactly once), and
   Start Assessment. Chromium is auto-detected under `/opt/pw-browsers`; pass
   `--chrome <path>` otherwise. Fix anything red before delivering — a deck that
   fails here will fail in the app.

7. **Deliver.** Send the zip. The user uploads it in the Course material card,
   ticks *Required before the assessment can start*, and relinks the tool to it
   (archiving any previous course). It imports as a new course; cases mid-read
   keep their recorded slides.

## Bundled resources

- `scripts/build_deck.py` — the packager (deck dir → self-contained zip). Reads
  the engine from `assets/`. Generates the menu, dividers, and completion slide.
- `scripts/verify_deck.mjs` — the sandbox verifier. Playwright + Chromium.
- `assets/deck-engine.js`, `assets/deck-engine.css` — the content-agnostic
  slideshow engine. It derives structure from the DOM (`data-part` on each
  `.slide`, `[data-touch]` for interactive cards, `data-quick` for short
  beats), so the same engine drives any deck. Edit here to change behaviour for
  all decks.
- `references/host-contract.md` — the FormAI player contract; the "why" behind
  every engine constraint. Read before changing the engine.
- `references/authoring.md` — PDF → slides: extraction, canvas rules, card
  markup, branding, `deck.json` schema.

## A worked example

`docs/courses/mine-site-sme-manual/` in this repo is a full deck built this
way (the Mine Site SME Operating Manual). Its `SME Induction Deck.dc.html` +
`build.py` predate this skill and are SME-specific, but it's the reference for
what a finished, branded, interactive deck looks like.
