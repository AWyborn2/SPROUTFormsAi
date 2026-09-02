"""Cell-grid helper over the blank PDF's vector geometry (PDF points, origin top-left)."""
import json, pathlib, re, pymupdf
HERE = pathlib.Path(__file__).parent
PDF = HERE.parent / 'small-loader.blank.pdf'

class Page:
    def __init__(self, pno):
        g = json.load(open(HERE / 'geom' / f'p{pno:02d}.json'))
        self.pno, self.w, self.h, self.words = pno, g['width'], g['height'], g['words']
        self.hs, self.vs, self.boxes = [], [], []
        for r in g['rects']:
            w, h = r[2] - r[0], r[3] - r[1]
            if h < 2.5 and w >= 2.5: self.hs.append(((r[1] + r[3]) / 2, r[0], r[2]))
            elif w < 2.5 and h >= 2.5: self.vs.append(((r[0] + r[2]) / 2, r[1], r[3]))
            elif 6 <= w <= 11 and 6 <= h <= 11: self.boxes.append(r)
        self.boxes.sort(key=lambda r: (round(r[1]), r[0]))

    def cell_at(self, x, y, tol=1.5):
        above = [s for s in self.hs if s[0] <= y and s[1] - tol <= x <= s[2] + tol]
        below = [s for s in self.hs if s[0] >= y and s[1] - tol <= x <= s[2] + tol]
        left = [s for s in self.vs if s[0] <= x and s[1] - tol <= y <= s[2] + tol]
        right = [s for s in self.vs if s[0] >= x and s[1] - tol <= y <= s[2] + tol]
        if not (above and below and left and right): return None
        return [max(s[0] for s in left), max(s[0] for s in above), min(s[0] for s in right), min(s[0] for s in below)]

    def phrase(self, text, after_y=0, nth=0):
        """bbox of consecutive words spelling `text` (whitespace-split), first match below after_y."""
        toks = text.split(); hits = []
        for i in range(len(self.words) - len(toks) + 1):
            seq = self.words[i:i + len(toks)]
            if all(seq[k][4] == toks[k] for k in range(len(toks))) and seq[0][1] >= after_y:
                # same line: y-overlap
                y0 = min(w[1] for w in seq); y1 = max(w[3] for w in seq)
                if y1 - y0 < 14:
                    hits.append([min(w[0] for w in seq), y0, max(w[2] for w in seq), y1])
        return hits[nth] if len(hits) > nth else None

    def words_like(self, regex):
        rx = re.compile(regex)
        return [w for w in self.words if rx.fullmatch(w[4])]

    def boxes_in(self, x0, y0, x1, y1):
        return [b for b in self.boxes if b[0] >= x0 and b[2] <= x1 and b[1] >= y0 and b[3] <= y1]

def overlay(pno, rects, out, labels=None, dpi=110):
    doc = pymupdf.open(PDF); page = doc[pno - 1]
    for i, r in enumerate(rects):
        page.draw_rect(pymupdf.Rect(*r), color=(1, 0, 0), width=0.7)
        if labels and i < len(labels) and labels[i]:
            page.insert_text((r[0] + 1, r[1] - 1.5), labels[i], fontsize=4.5, color=(0, 0, 1))
    page.get_pixmap(dpi=dpi).save(out)
