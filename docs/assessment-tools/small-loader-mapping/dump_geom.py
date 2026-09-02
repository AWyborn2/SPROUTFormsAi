"""Dump every page's vector rectangles (table borders, printed boxes) and word
positions from the blank PDF into geom/pNN.json — PDF points, origin top-left."""
import json, pathlib, pymupdf
HERE = pathlib.Path(__file__).parent
PDF = HERE.parent / 'small-loader.blank.pdf'
OUT = HERE / 'geom'; OUT.mkdir(exist_ok=True)
doc = pymupdf.open(PDF)
for i, page in enumerate(doc):
    rects, lines = [], []
    for d in page.get_drawings():
        for it in d['items']:
            if it[0] == 're':
                rc = it[1]; rects.append([round(rc.x0, 1), round(rc.y0, 1), round(rc.x1, 1), round(rc.y1, 1)])
            elif it[0] == 'l':
                p1, p2 = it[1], it[2]; lines.append([round(p1.x, 1), round(p1.y, 1), round(p2.x, 1), round(p2.y, 1)])
    words = [[round(w[0], 1), round(w[1], 1), round(w[2], 1), round(w[3], 1), w[4]] for w in page.get_text('words')]
    json.dump({'page': i + 1, 'width': page.rect.width, 'height': page.rect.height, 'rects': rects, 'lines': lines, 'words': words},
              open(OUT / f'p{i + 1:02d}.json', 'w'))
    print(f'page {i + 1}: {page.rect.width}x{page.rect.height}, {len(rects)} rects, {len(words)} words')
