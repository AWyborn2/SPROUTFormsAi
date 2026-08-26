# FormAI course-player contract

The rules a course package must obey to run correctly inside FormAI's course
player. Read this before changing the engine or the packager — most of these
constraints are why the deck is built the way it is.

## How the host runs the package

- A course is imported as one zip via the **Course material** card
  (`POST /courses`). The server unpacks it, stores every file, and records the
  file list as the serving allowlist. Launch page = `imsmanifest.xml`'s SCO,
  else `index.html`, else the only top-level HTML page.
- **Detection as a deck**: the importer calls `deckSlideCount(html)` on the
  launch page — it returns null unless the HTML contains the literal string
  `deck-stage`, otherwise it counts `<section>` elements (minus
  `data-deck-skip`). So the package MUST contain the string `deck-stage`
  (build_deck.py keeps it in a marker comment) and one `<section>` per slide,
  or the host treats it as plain HTML with no slide tracking.
- The player renders the launch page in an **iframe with
  `sandbox="allow-scripts"`** and serves content via a sealed, expiring
  capability token. Consequences that shape the engine:
  - **Opaque origin (`null`)**: any `fetch()` to the package's own files is
    CORS-blocked. A runtime that boots by fetching a component (React decks,
    Claude-Design's `deck-stage.js`) silently fails and the slides render as
    stacked scrolling HTML. → The engine is 100% inline: no fetch, no CDN, no
    external runtime.
  - **No cookies / no same-origin**: the package can't read the app or call
    the API. It communicates only by `postMessage` to its parent.
  - **`localStorage` may throw**: the engine wraps it and falls back to an
    in-memory store, so it must never assume storage exists.
  - External `<link>`/`<img>`/font loads still work (they're not CORS-gated
    for use), so Google Fonts + relative images are fine; give fonts a real
    fallback stack in case a network blocks them.

## postMessage bridge

The engine and the player (`CoursePlayerScreen.tsx`) speak this small protocol.

**Engine → player (posted to `window.parent`):**

| message | when | player does |
| --- | --- | --- |
| `{type:'course-slide', index, total}` | a slide is completed (read) | batches indexes, `PATCH /assessment-cases/:id/course-progress {visitedSlides}` |
| `{type:'course-start-assessment'}` | the final CTA is pressed | `navigate` back to the assessment case |
| `{type:'course-answer', fieldId, value}` | a **graded** in-deck question (`data-graded`) is submitted | relay to `POST /assessment-cases/:id/attempts/:attemptId/answer {fieldId,value}` — the server grades against the stored key **and records** the answer on the open attempt — then post the verdict back as `course-answer-result` |

**Player → engine (posted into the iframe):**

| message | when | engine does |
| --- | --- | --- |
| `{type:'course-progress-seed', visited:[…]}` | on iframe load, from the case's recorded reading | marks those slides complete so a reopened course resumes at its frontier |
| `{type:'course-answer-result', fieldId, correct, hint?}` | after the server grades a `course-answer` | shows the Correct/Incorrect modal; the slide completes **either way** (the answer is recorded; the overall outcome is marked later, at submit) |

**Graded questions (the in-deck assessment).** A `data-graded` slide carries
`data-field-id` (the server field to grade) and **no `data-answer`** — the key
never ships in the package. The candidate picks an option → Submit posts
`course-answer` → the host **must** relay it to the server (the deck has no
network of its own) and post the verdict back. This requires the theory attempt
to be **open** while the course is read (the host opens it at course start), and
the `POST …/answer` endpoint enforces the same write scope as the save route.
Grading is always server-side; only `{correct, hint?}` ever returns to the deck.

## Completion rule (why it's strict)

The server marks the course complete for a deck when
`unique(visitedSlides).length >= slideCount`. So **every slide `0…N-1` must be
reported exactly once** across a full run, or the assessment gate stays shut.
Two consequences the engine handles, and any change must preserve:

1. **Report only completed slides**, and never an index past the reading
   frontier — a blocked/bounced navigation must not pad the count.
2. **The final slide (`data-part="done"`) is marked complete on ARRIVAL**, not
   after a reading beat. Its "Start Assessment" button is live immediately, and
   a fast click would otherwise navigate away before the last slide is
   reported — leaving the course one slide short and the gate shut. (The menu
   slide is likewise marked complete on arrival.)
   Seeded slides are NOT re-reported — they're already recorded server-side.

## SCORM / LMS portability

`build_deck.py` also writes a minimal SCORM 1.2 `imsmanifest.xml` pointing at
`index.html` as the SCO, so the same zip imports into a conventional LMS. The
deck does not call the SCORM API (`window.API`); it's a self-paced reader, and
completion in FormAI is tracked via the postMessage bridge above. If a target
LMS requires `cmi.core.lesson_status=completed`, that's a future addition to
the engine, not something the current package asserts.

## The one-line reason the engine is vanilla

If you remember nothing else: **the sandbox's opaque origin CORS-blocks the
package from fetching its own files**, so everything the deck needs must be
inline in `index.html`. That single fact is why there's a hand-rolled engine
instead of a framework.
