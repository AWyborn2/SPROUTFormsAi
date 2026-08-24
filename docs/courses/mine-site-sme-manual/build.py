#!/usr/bin/env python3
"""Assemble the Mine Site SME Manual course package zip from this directory.

The deck source (`SME Induction Deck.dc.html`) is the file to EDIT — slides,
copy, the reading-gate logic in its `data-dc-script`. This script derives the
uploadable package from it:

  index.html      = the deck source with the course-host bridge and vendored
                    React scripts injected ahead of support.js
  vendor/react*.js  copied out of the repo's node_modules (React 18 UMD —
                    the exact version support.js pins), so the package works
                    offline and inside the player's sandboxed iframe
  + deck-stage.js, support.js, img/, imsmanifest.xml verbatim

Usage:  python3 docs/courses/mine-site-sme-manual/build.py
Output: mine-site-sme-manual-course.zip beside this script — upload it in the
workflow editor's Course material card.

The bridge injected below is load-bearing for the FormAI player:
 - it forwards deck-stage's slide-change broadcasts to the hosting player as
   {type:'course-slide'} messages, SKIPPING any index beyond the deck's own
   reading gate (window.__courseAllowedMax) so a refused jump never counts;
 - it accepts a {type:'course-progress-seed'} message from the player so a
   reopened course resumes at the recorded frontier;
 - it shims localStorage/sessionStorage, which throw in a sandboxed iframe.
"""
from pathlib import Path
import shutil
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
SOURCE = HERE / 'SME Induction Deck.dc.html'
OUT_DIR = HERE / 'package'
ZIP = HERE / 'mine-site-sme-manual-course.zip'

REACT = REPO / 'node_modules/.pnpm/react@18.3.1/node_modules/react/umd/react.production.min.js'
REACT_DOM = (
    REPO / 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/umd/react-dom.production.min.js'
)

BRIDGE = """<script>
(function () {
  function memoryStore() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
      clear: function () { m = {}; },
      key: function (i) { return Object.keys(m)[i] || null; },
      get length() { return Object.keys(m).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = false;
    try { window[name].getItem; ok = true; } catch (e) {}
    if (!ok) {
      try { Object.defineProperty(window, name, { value: memoryStore(), configurable: true }); } catch (e) {}
    }
  });
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source === window.parent && e.source !== window && d && d.type === 'course-progress-seed' && Array.isArray(d.visited)) {
      window.__courseSeedVisited = d.visited.filter(function (n) { return typeof n === 'number'; });
      try { window.dispatchEvent(new CustomEvent('course-seed')); } catch (err) {}
      return;
    }
    if (e.source !== window) return;
    if (!d || typeof d.slideIndexChanged !== 'number') return;
    var max = window.__courseAllowedMax;
    if (typeof max === 'number' && d.slideIndexChanged > max) return;
    try {
      window.parent.postMessage({
        type: 'course-slide',
        index: d.slideIndexChanged,
        total: typeof d.deckTotal === 'number' ? d.deckTotal : null,
        skipped: Array.isArray(d.deckSkipped) ? d.deckSkipped : []
      }, '*');
    } catch (err) {}
  });
})();
</script>
<script src="./vendor/react.production.min.js"></script>
<script src="./vendor/react-dom.production.min.js"></script>
"""

NEEDLE = '<script src="./support.js"></script>'


def main() -> None:
    src = SOURCE.read_text(encoding='utf-8')
    assert src.count(NEEDLE) == 1, 'support.js script tag not found exactly once'

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    (OUT_DIR / 'vendor').mkdir(parents=True)

    (OUT_DIR / 'index.html').write_text(src.replace(NEEDLE, BRIDGE + NEEDLE), encoding='utf-8')
    for name in ['deck-stage.js', 'support.js', 'imsmanifest.xml']:
        shutil.copy(HERE / name, OUT_DIR / name)
    shutil.copytree(HERE / 'img', OUT_DIR / 'img')
    shutil.copy(REACT, OUT_DIR / 'vendor/react.production.min.js')
    shutil.copy(REACT_DOM, OUT_DIR / 'vendor/react-dom.production.min.js')

    if ZIP.exists():
        ZIP.unlink()
    with zipfile.ZipFile(ZIP, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(OUT_DIR.rglob('*')):
            if path.is_file():
                zf.write(path, path.relative_to(OUT_DIR).as_posix())
    print(f'wrote {ZIP} ({ZIP.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
