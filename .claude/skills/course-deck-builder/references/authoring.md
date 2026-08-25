# Authoring a deck from a PDF manual

How to turn a source PDF into the `deck.json` + `slides/` + `img/` that
`build_deck.py` consumes. The packager handles the chrome (menu, dividers,
completion, engine); your job is the content: extract it, split it into modules,
and write one `<section>` per slide.

## 1. Extract the PDF

No PDF tooling is in the base image. Use the bundled **`pdf` skill** for text
and image extraction, or install a library directly. A reliable one-shot with
PyMuPDF:

```bash
pip install pymupdf
python3 - <<'PY'
import fitz, pathlib
doc = fitz.open("manual.pdf")
out = pathlib.Path("deck/img"); out.mkdir(parents=True, exist_ok=True)
for pno, page in enumerate(doc):
    print(f"\n===== PAGE {pno+1} =====\n{page.get_text()}")
    for i, img in enumerate(page.get_images(full=True)):
        pix = fitz.Pixmap(doc, img[0])
        if pix.n > 4: pix = fitz.Pixmap(fitz.csRGB, pix)
        pix.save(out / f"p{pno+1:02d}-{i}.png")
PY
```

Read the text to understand the manual's structure, and keep the images you'll
actually use (diagrams, signage, equipment photos) in `deck/img/`. Re-encode
huge images down (a course zip should be tens of MB, not hundreds).

## 2. Plan the modules (hub-and-spoke)

The deck is a hub-and-spoke: an intro, a **Section Menu**, then several
**modules** the reader unlocks in order and returns to the menu between. Map the
manual's chapters to 4–8 modules, each with ~4–8 slides. (In `deck.json` the
modules live in the `parts` array — the key name is historical; what the reader
sees is "MODULE".) Give every module a `key` (short: `A`,`B`,… or a slug), a
`label` ("MODULE A"), a `title`, and a one-line `blurb`. Put a `divider:true`
on a module to get a generated title slide before its content.

Keep one idea per slide. A wall of text is worse than three focused slides —
the reading-beat timer scales with word count, so dense slides also make the
reader wait longer for Next.

## 3. Write each slide as a `<section>`

Slides render on a fixed **1920×1080** canvas, scaled to fit. Author a full
`<section>…</section>` with inline styles, using the theme CSS variables so a
brand change in `deck.json` re-colours everything:

`var(--ink)` `var(--grey)` `var(--paper)` `var(--accent)` `var(--accent-ink)`
`var(--good)`, and the type/spacing tokens `var(--type-title|subtitle|body|small)`,
`var(--pad-x|pad-top|pad-bottom)`.

```html
<section style="background:var(--grey); color:var(--ink); display:flex;
  flex-direction:column; padding:var(--pad-top) var(--pad-x); gap:28px;">
  <h1 style="font-size:var(--type-title); font-weight:800;">Slide title</h1>
  <p style="font-size:var(--type-body); line-height:1.5; color:#444;">Body…</p>
</section>
```

Content must fit the 1080px height — the canvas clips overflow (no scroll
inside a slide). Prefer a grid of cards over long paragraphs.

**Full-view images**: to show a whole diagram or sign uncropped, use
`object-fit:contain` on a padded tile rather than `cover` (which crops):
```html
<img src="img/sign.png" style="width:230px; height:140px; object-fit:contain;
  background:#fbfaf9; border:1px solid #eee; border-radius:8px; padding:10px;">
```

## 4. Interactive cards (the interaction gate)

A slide that contains any element with a `data-touch` attribute won't let the
reader advance until **every** such element has been opened — the nav bar shows
"Open all N cards — X of N viewed" and flips to a green tick when done. Use
this for recall and to make dense reference content active. Give each card a
unique `data-touch` value.

**Flip card** (front → back on click; good for term/definition, signal/meaning):
```html
<div class="flipcard" data-touch="rc0" style="min-height:180px;">
  <div class="flipinner">
    <div class="flipface" style="background:#fff; border:2px solid #ddd;">
      <span style="font-size:30px; font-weight:900;">PIT CONTROL</span>
      <span class="rc-hint" style="font-size:22px; color:#999;">tap to reveal</span>
    </div>
    <div class="flipface flipback" style="background:var(--ink); color:#fff;">
      <span style="font-size:23px; text-align:center;">Talk to the Pit Controller</span>
    </div>
  </div>
</div>
```

**Expander** (reveals hidden detail; good for hazard → control):
```html
<div class="expander" data-touch="pmh0" style="background:#4A4F53; padding:26px 30px;
  display:flex; flex-direction:column; gap:10px;">
  <h2 style="font-size:29px; font-weight:800; color:#fff;">Dropped objects</h2>
  <p class="detail" style="font-size:23px; color:#ccc; display:none;">Good housekeeping · exclusion zones</p>
  <span class="closed-label" data-shut="+ Controls" data-seen="✓ viewed — reopen"
        style="font-size:23px; color:#9aa;">+ Controls</span>
</div>
```
The engine toggles `.detail` display, swaps `.closed-label` text between its
`data-shut`/`data-seen` values, and marks the card viewed. Add
`data-accordion="1"` to expanders that should close their siblings when opened
(e.g. a tall list where only one detail should show at a time — keeps the slide
within 1080px).

Optional: a `.chev` span inside an expander shows `+` → `−`/`✓` as it toggles.

**Checkbox list** (turn a dot-point list into "tick every box to continue" —
good for obligations, responsibilities, a pre-start checklist the reader must
actively acknowledge). Each item is a `.checkitem` with its own `data-touch`;
the slide's Next unlocks once all are ticked. Ticking is one-way (an
acknowledgement), so the visual always matches the gate:
```html
<div style="display:flex; flex-direction:column; gap:20px;">
  <div class="checkitem" data-touch="ck0"><span class="box"></span>
    <span style="font-size:26px; line-height:1.4;">Provides hazardous substance information (SDS)</span></div>
  <div class="checkitem" data-touch="ck1"><span class="box"></span>
    <span style="font-size:26px; line-height:1.4;">Provides a register of hazardous substances</span></div>
</div>
```
Use a checklist to make a required list active; keep it to a handful of items
so the whole list stays on the 1080px slide.

**Image hotspots** (numbered markers over a screenshot/diagram that open a
detail popover — good for walking through a software screen, a piece of
equipment, or a site photo). Wrap an image in `.hotspots`, place `.hotspot`
markers with `left`/`top` percentages, and give each a matching
`.hotspot-detail[data-for]`. Each marker is a `data-touch` card, so Next
unlocks once every point has been explored; markers pulse until explored, then
turn green. One detail shows at a time; a `.hotspot-close` button dismisses it.
```html
<section style="background:var(--ink); color:#fff; display:flex; flex-direction:column;
  padding:56px var(--pad-x) 44px; gap:20px;">
  <h1 style="font-size:var(--type-title); font-weight:800;">Finding a Substance in ChemAlert</h1>
  <p style="font-size:var(--type-small); color:#bbb;">Click each numbered point to explore it.</p>
  <div class="hotspots" style="flex:1;">
    <img src="img/chemalert.png" style="width:100%; height:100%; object-fit:contain;">
    <button class="hotspot" data-touch="hs0" style="left:53%; top:30%;">1</button>
    <div class="hotspot-detail" data-for="hs0">
      <button class="hotspot-close" aria-label="Close">×</button>
      <h3>Properties</h3>
      <p style="font-size:24px; line-height:1.5;">Physical &amp; chemical properties of the substance.</p>
    </div>
    <button class="hotspot" data-touch="hs1" style="left:62%; top:30%;">2</button>
    <div class="hotspot-detail" data-for="hs1">
      <button class="hotspot-close" aria-label="Close">×</button>
      <h3>Modules</h3>
      <p style="font-size:24px; line-height:1.5;">Stock register and inventory records.</p>
    </div>
  </div>
</section>
```
A `.hotspot-detail` may contain an `<img>` too (e.g. a zoomed crop). Position
markers as percentages so they track the image as the slide scales.

## Mixing card types

All three interactive types (flip, expander, checkbox, hotspot) share one gate
— a slide's Next waits until every `data-touch` element on it is activated — so
a slide can mix them, but keeping one interaction style per slide reads more
clearly. Give every interactive element on a slide a unique `data-touch`.

## 5. deck.json

```json
{
  "title": "Mine Site SME Operating Manual",
  "courseKey": "mine-site-sme",
  "brand": { "ink": "#3C4043", "grey": "#F4F3F1", "accent": "#EADA23",
             "accentInk": "#3C4043", "good": "#1a7a2e",
             "fontBody": "'Archivo','Arial Narrow',system-ui,sans-serif",
             "fontsHref": "https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800;900&display=swap" },
  "intro": ["title.html", "how-to.html"],
  "parts": [
    { "key": "A", "label": "MODULE A", "title": "Working Safely", "blurb": "PPE · hazards",
      "divider": true, "slides": ["a-ppe.html", "a-hazards.html"] }
  ],
  "completion": { "heading": "Induction Complete",
                  "body": "You have read every module. You can now begin.",
                  "logo": "img/cover.png" }
}
```

Notes:
- `intro[0]` (usually the title slide) gets a short reading beat; write it as a
  full-bleed hero.
- The **Section Menu**, part **dividers**, and the **completion** slide (with a
  Start Assessment CTA) are generated from this JSON — don't author them.
- Match the brand to the manual's owner; pull an accent from its logo. Keep a
  real font fallback stack.
- Don't reproduce document-control watermark text (manual numbers, version
  stamps, owner/deploy footers) on the slides — it reads as clutter in a
  learner deck.
