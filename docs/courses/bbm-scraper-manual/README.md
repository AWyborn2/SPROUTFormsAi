# BBM Scraper — Operating Manual course

Interactive SCORM course deck built from the BBM Scraper operating manual, in
the South32 Worsley Alumina look. Candidates work through five modules before
their Authority to Operate (scraper) assessment in FormAI.

## Source

This deck is authored for the shared **course-deck-builder** skill
(`.claude/skills/course-deck-builder/`), so the source is data + slide
fragments rather than a bespoke builder:

- `deck.json` — brand (South32 navy `#2B3A42` / amber `#F5B301`, `logo-header.png`),
  module map, and the ordered slide list.
- `slides/*.html` — one `<section>` per slide. Content slides carry
  `data-title` (the title shows in the navy header, not the slide body); the
  hero (`title.html`) keeps its in-body `<h1>`.
- `img/*` — photos, the South32 wordmark (`logo.png`), and the transparent
  header logo (`logo-header.png`).

## Build

From this directory:

```bash
python3 ../../../.claude/skills/course-deck-builder/scripts/build_deck.py .
```

That regenerates `package/` and `bbm-scraper-operating-manual-course.zip`
(both git-ignored — build artifacts, not source). Upload the `.zip` in FormAI
to host the course and gate the theory assessment on its completion.

To sanity-check the packaged deck in a sandboxed iframe (the same environment
FormAI serves it in):

```bash
node ../../../.claude/skills/course-deck-builder/scripts/verify_deck.mjs package
```
