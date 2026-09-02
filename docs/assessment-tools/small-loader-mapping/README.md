# Small Loader — how the mapped template was made

`../small-loader.template.json` is not hand-drawn. Every field and every box on
all 13 pages of `../small-loader.blank.pdf` is derived from the PDF's own
vector grid — the table borders Word exported as thin rectangles, the printed
☐ boxes, and the word positions of labels and option letters — so a box lands
on the cell it belongs to by construction rather than by eye.

```bash
pip install pymupdf
python3 dump_geom.py          # geom/pNN.json — rectangles + words per page (top-left points)
python3 map_small_loader.py   # mapping.json — fields with reference boxes, out/map-pNN.png overlays
python3 to_template.py        # ../small-loader.template.json — the app's FormField[] + PageBox
                              #   geometry (bottom-left origin, 0-based pages, column/row bands)
                              #   and the manifest hints; out/final-pNN.png re-renders every box
```

Inspect `out/final-pNN.png` — each red box is exactly what the app will draw
into. The author script (`packages/db/scripts/author-small-loader-tool.mjs
--seed`) turns the template into a published form and the assessment tool.

What each script decides:

- `cells.py` — the grid helper: thin rectangles become horizontal/vertical
  strokes, `cell_at(x, y)` is the cell those strokes bound around a point,
  `phrase()` finds a printed label, `boxes` are the printed ☐ squares.
- `map_small_loader.py` — one entry per printed thing: cover cells below their
  headers, a ring box around each option letter, the ✓/✗ column box per
  question (Q15's is synthesised — the paper forgot to print one), a ✓/✗ and
  an N/A box per practical criterion, the logbook columns and rows.
- `to_template.py` — the app's shapes: bottom-left origin, `optionKey` +
  `markStyle: ring` on option boxes, ONE box with `columnBands`/`rowBands` per
  table (the six method rows keyed `row:n`, the logbooks positional), a
  verdict radio over each practical's two printed boxes, and the `hints` the
  author script reads instead of guessing from labels.
