# Mine Site SME Operating Manual — course package source

The interactive induction slideshow uploaded to FormAI as the course material
for the Mine Site SME theory assessment (Training Manual 00117938 v18.0,
Boddington Bauxite Mine / South32).

## What's here

| File | Role |
| --- | --- |
| `SME Induction Deck.dc.html` | The slide **content** — all 52 slides. Edit copy and imagery here. |
| `build.py` | Assembles the uploadable, self-contained slideshow zip from the content. |
| `img/` | Slide imagery extracted from the source manual. |

`build.py` writes a `package/` folder and `mine-site-sme-manual-course.zip`
beside itself; both are build artifacts and are git-ignored / not committed.

## Why it's a hand-rolled slideshow

The FormAI course player runs the package inside a **`sandbox="allow-scripts"`
iframe**, whose origin is opaque (`null`). The original Claude-Design deck
booted its viewer by `fetch(location.href)` + `fetch('./deck-stage.js')`, and
both are **CORS-blocked** from an opaque origin — so in the player the deck
never became a slideshow: it rendered all 52 `<section>`s stacked and just
scrolled (tap-to-begin dead, menu all-locked, cards unflipped).

`build.py` keeps every slide `<section>` verbatim but drives them with a tiny
**inlined vanilla engine** — no `fetch`, no React, no external runtime — so it
works inside the sandbox. The six formerly data-bound slides (menu, PMH,
radio, horn, signage, completion) are regenerated as static HTML with
`data-touch` hooks the engine reads.

## What the engine does

- A real one-slide-at-a-time slideshow, scaled to fit, with animated
  transitions (respecting `prefers-reduced-motion`).
- A **hub-and-spoke Section Menu**: parts unlock in order (Part A first);
  finish a part's slides and you return to the menu to start the next; the
  menu shows locked / available / complete per part and a progress bar.
- A **live Next button** that unlocks after a reading beat (timed to the
  slide's text length, ~1.5–11 s) **or** once every interactive card on the
  slide has been opened, with an animated **green tick** on completion.
- Full-view sign images on the signage slide (thumb + a large copy when a
  row is expanded).
- A **Start Assessment** button on the final slide that posts
  `{type:'course-start-assessment'}` to the host player, which navigates the
  reader to the assessment case.

## Host contract

- Reports each completed slide as `{type:'course-slide', index, total:52}`,
  **only up to the reading frontier** — a bounced/blocked navigation is never
  reported, so the server's completion count stays honest.
- Accepts `{type:'course-progress-seed', visited:[…]}` from the player to
  resume a part-read course at the recorded frontier.
- Keeps the literal string `deck-stage` in a marker comment so the importer
  still detects the package as a deck and counts its 52 slides.

## Rebuilding after an edit

```bash
python3 docs/courses/mine-site-sme-manual/build.py
```

Upload the resulting `mine-site-sme-manual-course.zip` in the workflow
editor's **Course material** card. It imports as a *new* course — relink the
tool to it and archive the previous one. Cases mid-read keep their recorded
slides and resume.
