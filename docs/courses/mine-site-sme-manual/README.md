# Mine Site SME Operating Manual — course package source

The interactive induction deck uploaded to FormAI as the course material for
the Mine Site SME theory assessment (Training Manual 00117938 v18.0,
Boddington Bauxite Mine / South32).

## What's here

| File | Role |
| --- | --- |
| `SME Induction Deck.dc.html` | **The source to edit** — all 52 slides plus the reading-gate logic in its `data-dc-script` block |
| `deck-stage.js` | The slide viewer web component (navigation, scaling, print) — generated, don't hand-edit |
| `support.js` | The reactive-template runtime the deck's script runs on — generated, don't hand-edit |
| `img/` | Slide imagery extracted from the source manual |
| `imsmanifest.xml` | SCORM 1.2 wrapper so the same zip also imports into a conventional LMS |
| `build.py` | Assembles the uploadable zip (injects the player bridge, vendors React from `node_modules`) |

## Reading gate (why the deck refuses to skip)

The deck enforces read-through order itself, and the FormAI player trusts it:

- Slides unlock strictly in sequence; the section menu only jumps into parts
  whose predecessors are complete, and shows locked / in-progress / complete
  per part.
- Slides with interactive content (PMH cards, radio-channel and horn-signal
  flip cards, the signage accordion) don't unlock the next slide until every
  element has been opened — a pill on the slide shows the remaining count.
- The injected bridge reports slide visits to the FormAI player **only up to
  the gate's frontier** (`window.__courseAllowedMax`), so a bounced jump never
  records reading, and accepts a seed of already-recorded slides so a
  reopened course resumes where it left off. The player's completion rule
  (every slide visited, judged server-side) is unchanged.

## Rebuilding after an edit

```bash
python3 docs/courses/mine-site-sme-manual/build.py
```

Upload the resulting `mine-site-sme-manual-course.zip` in the workflow
editor's **Course material** card (it imports as a new course — relink the
tool to it and archive the old one). `pnpm install` must have run first so
the React UMD files exist in `node_modules`.
