#!/usr/bin/env python3
"""Assemble an interactive, sandbox-safe SCORM slide-deck package from authored
content — the reusable core of the course-deck-builder skill.

Input: a deck directory containing
  deck.json          — metadata (see schema below)
  slides/*.html      — one authored <section>…</section> per content slide
  img/*              — images the slides reference (relative src="img/…")

Output (beside deck.json, unless --out given):
  package/           — the unpacked, uploadable course
  <slug>-course.zip  — the same, zipped for the Course-material uploader

The produced index.html is a SELF-CONTAINED slideshow: the engine (assets/
deck-engine.{css,js}) is inlined, no fetch/React/external runtime, so it runs
inside the host's `sandbox="allow-scripts"` opaque-origin iframe (see
references/host-contract.md for why that matters). The literal string
"deck-stage" is kept in a marker comment so the importer detects a deck and
counts its <section>s.

deck.json schema:
{
  "title": "Mine Site SME Operating Manual",
  "courseKey": "mine-site-sme",            // localStorage namespace (optional)
  "brand": {                                // all optional; sensible defaults
    "ink": "#3C4043", "grey": "#F4F3F1", "accent": "#EADA23",
    "accentInk": "#3C4043", "good": "#1a7a2e",
    "fontBody": "'Archivo','Arial Narrow',system-ui,sans-serif",
    "fontsHref": "https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800;900&display=swap"
  },
  "intro": ["title.html", "how-to.html"],   // optional; intro[0] gets a short beat
  "parts": [
    { "key": "A", "label": "MODULE A", "title": "Working Safely…",
      "blurb": "Safety focus · PPE · hazards", "divider": true,
      "slides": ["a-safety.html", "a-pmh.html"] }
  ],
  "completion": { "heading": "Induction Complete",
                  "body": "You have read every part…",
                  "logo": "img/cover.png" }   // optional
}

Interactive cards inside a content slide (the engine gates the slide's Next on
all of them being opened) — give each a unique data-touch:
  flip card:  <div class="flipcard" data-touch="rc0"> …front… …flipback… </div>
  expander:   <div class="expander" data-touch="pmh0"> … <p class="detail" style="display:none">…</p> <span class="closed-label">+ more</span></div>
  accordion:  add data-accordion="1" to expanders that should close their siblings
See references/authoring.md for the full card markup.

Usage:  python3 build_deck.py <deck-dir> [--out <dir>]
"""
import argparse
import html
import json
import re
import shutil
import zipfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
ENGINE_CSS = (SKILL_DIR / 'assets' / 'deck-engine.css').read_text(encoding='utf-8')
ENGINE_JS = (SKILL_DIR / 'assets' / 'deck-engine.js').read_text(encoding='utf-8')

DEFAULT_BRAND = {
    'ink': '#1D1D1B', 'grey': '#F4F3F1', 'accent': '#EADA23', 'accentInk': '#1D1D1B',
    'good': '#1a7a2e', 'fontBody': "'Archivo','Arial Narrow','Helvetica Neue',system-ui,sans-serif",
    'fontsHref': 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=Archivo+Narrow:wght@400;500;600;700&display=swap',
}

IMSMANIFEST = '''<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="COURSE_DECK" version="1.2"
    xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
    xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1"><title>__TITLE__</title>
      <item identifier="ITEM-1" identifierref="RES-1"><title>__TITLE__</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>
'''


def slugify(s: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') or 'course'


def read_section(deck_dir: Path, name: str) -> str:
    frag = (deck_dir / 'slides' / name).read_text(encoding='utf-8').strip()
    if '<section' not in frag:
        raise SystemExit(f'slide {name!r} must contain a <section>…</section>')
    return frag


def divider_section(part: dict) -> str:
    return (
        f'<section style="background:var(--ink); color:#fff; display:flex; flex-direction:column; '
        f'justify-content:center; padding:0 var(--pad-x); gap:22px;">\n'
        f'  <div style="width:120px; height:10px; background:var(--accent);"></div>\n'
        f'  <span style="font-size:38px; font-weight:800; letter-spacing:4px; color:var(--accent);">{html.escape(part["label"])}</span>\n'
        f'  <h1 style="font-size:96px; font-weight:900; line-height:1.03; letter-spacing:-2px;">{html.escape(part["title"])}</h1>\n'
        f'  <p style="font-size:var(--type-subtitle); color:#ccc; font-weight:500;">{html.escape(part.get("blurb",""))}</p>\n'
        f'</section>'
    )


def menu_section(parts: list) -> str:
    cards = []
    for p in parts:
        cards.append(
            f'      <div class="part-card" data-part="{html.escape(p["key"])}" style="background:#fff; padding:30px 34px; '
            f'display:flex; flex-direction:column; gap:10px; border-top:6px solid var(--ink);">\n'
            f'        <div style="display:flex; justify-content:space-between; align-items:center;">\n'
            f'          <span class="pc-tag" style="font-size:23px; font-weight:700; letter-spacing:2px;">{html.escape(p["label"])}</span>\n'
            f'          <span class="pc-tick" style="font-size:22px; font-weight:700;"></span>\n'
            f'        </div>\n'
            f'        <h2 style="font-size:29px; font-weight:800; line-height:1.1;">{html.escape(p["title"])}</h2>\n'
            f'        <p style="font-size:23px; line-height:1.35; color:#666; font-family:\'Archivo Narrow\';">{html.escape(p.get("blurb",""))}</p>\n'
            f'      </div>'
        )
    return (
        '<section style="background:var(--grey); color:var(--ink); display:flex; flex-direction:column; '
        'padding:64px var(--pad-x) 52px; gap:26px;">\n'
        '  <div style="display:flex; justify-content:space-between; align-items:flex-end;">\n'
        '    <h1 style="font-size:var(--type-title); font-weight:800; letter-spacing:-1px;">Module Menu</h1>\n'
        '    <div style="display:flex; align-items:center; gap:16px;">\n'
        '      <span class="menu-count" style="font-size:var(--type-small); color:#666;"></span>\n'
        '      <div style="width:220px; height:12px; background:#ddd; border-radius:6px; overflow:hidden;">'
        '<div class="menu-fill" style="height:100%; background:var(--good); width:0%; transition:width .4s;"></div></div>\n'
        '    </div>\n'
        '  </div>\n'
        '  <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:22px; flex:1;">\n'
        + '\n'.join(cards) + '\n'
        '  </div>\n'
        '  <p class="menu-foot" style="font-size:23px; color:#888; text-align:center;"></p>\n'
        '</section>'
    )


def completion_section(comp: dict) -> str:
    logo = comp.get('logo')
    logo_html = f'  <img src="{html.escape(logo)}" style="height:150px;">\n' if logo else ''
    heading = html.escape(comp.get('heading', 'Course Complete'))
    body = html.escape(comp.get('body', 'You have read every module of this course. Your reading is recorded against the assessment — you can now begin.'))
    return (
        '<section style="background:var(--ink); color:#fff; display:flex; flex-direction:column; '
        'justify-content:center; align-items:center; padding:0 var(--pad-x); gap:32px; text-align:center;">\n'
        + logo_html +
        f'  <h1 style="font-size:88px; font-weight:900; letter-spacing:-2px; line-height:1.05;">{heading}</h1>\n'
        f'  <p style="font-size:var(--type-body); color:#ccc; max-width:1200px; line-height:1.45;">{body}</p>\n'
        '  <div style="display:flex; gap:20px;">\n'
        '    <button class="cta" data-action="start" style="background:var(--accent); color:var(--accent-ink); border:0; '
        'padding:22px 52px; font-size:28px; font-weight:800; cursor:pointer; border-radius:6px; font-family:inherit;">Start Assessment →</button>\n'
        '    <button class="cta" data-action="menu" style="background:transparent; color:#fff; border:2px solid #555; '
        'padding:22px 40px; font-size:24px; font-weight:700; cursor:pointer; border-radius:6px; font-family:inherit;">Back to Module Menu</button>\n'
        '  </div>\n'
        '</section>'
    )


_THUMB = ('<svg viewBox="0 0 24 24"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57'
          '.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.96 7 8.46 7 9v10c0 1.1.9 2 2 2h9'
          'c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-1z"/></svg>')


def graded_section(q: dict) -> str:
    """A GRADED assessment question slide — keyless (no data-answer). The deck
    posts the selection to the host, which grades + records it server-side."""
    if 'fieldId' not in q or 'question' not in q:
        raise SystemExit(f'graded question needs fieldId and question: {q!r}')
    qtype = q.get('type', 'mc')
    if qtype not in ('tf', 'mc'):
        raise SystemExit(f'graded question type must be "tf" or "mc": {q!r}')
    fid = html.escape(str(q['fieldId']))
    title = html.escape(q.get('title', 'Assessment'))
    qno = html.escape(str(q.get('number', '')))
    qtext = html.escape(str(q['question']))
    if qtype == 'tf':
        sub = 'Choose True or False — this is a graded assessment question.'
        # A boolean field posts true/false. A printed "a) True / b) False" that
        # imported as a RADIO must post its real option strings — an author
        # script reconciles those in as exactly two `options` (true first);
        # the thumbs card is kept either way.
        tf_opts = q.get('options') or [{'val': 'true'}, {'val': 'false'}]
        if len(tf_opts) != 2:
            raise SystemExit(f'tf graded question with options needs exactly two (true, false): {q!r}')
        tv, fv = html.escape(str(tf_opts[0]['val'])), html.escape(str(tf_opts[1]['val']))
        opts = (
            '    <div class="qopts">\n'
            f'      <div class="qopt tf" data-val="{tv}">{_THUMB}<span class="lab">TRUE</span></div>\n'
            f'      <div class="qopt tf" data-val="{fv}"><svg viewBox="0 0 24 24" style="transform:rotate(180deg);">'
            f'{_THUMB[_THUMB.index(">") + 1:]}<span class="lab">FALSE</span></div>\n'
            '    </div>'
        )
    else:
        sub = 'Select the correct answer — this is a graded assessment question.'
        letters = 'ABCDEFGH'
        opts_list = q.get('options', [])
        if not opts_list:
            raise SystemExit(f'multiple-choice graded question needs options: {q!r}')
        rows = [
            f'      <div class="qopt mc" data-val="{html.escape(str(o["val"]))}">'
            f'<span class="letter">{letters[i] if i < len(letters) else i + 1}</span>'
            f'<span class="otext">{html.escape(str(o["text"]))}</span></div>'
            for i, o in enumerate(opts_list)
        ]
        opts = '    <div class="qopts mc">\n' + '\n'.join(rows) + '\n    </div>'
    return (
        f'<section data-title="{title}" data-graded="{qtype}" data-field-id="{fid}"\n'
        '  style="background:#fff; color:var(--ink); display:flex; flex-direction:column; '
        'padding:52px var(--pad-x) 40px; gap:24px;">\n'
        '  <div class="quiz">\n'
        f'    <div class="qhead"><span class="qno">{qno}</span><span class="qtext">{qtext}</span></div>\n'
        f'    <div class="qsub">{sub}</div>\n'
        f'{opts}\n'
        '  </div>\n'
        '</section>'
    )


def wrap(section: str, idx: int, part: str, quick: bool) -> str:
    q = ' data-quick="1"' if quick else ''
    return f'<div class="slide" data-idx="{idx}" data-part="{part}"{q}>\n{section}\n</div>'


def build(deck_dir: Path, out_dir: Path) -> None:
    spec = json.loads((deck_dir / 'deck.json').read_text(encoding='utf-8'))
    brand = {**DEFAULT_BRAND, **spec.get('brand', {})}
    parts = spec['parts']
    if not parts:
        raise SystemExit('deck.json needs at least one part')

    slides, idx = [], 0
    # intro (title first, gets a short beat)
    for i, name in enumerate(spec.get('intro', [])):
        slides.append(wrap(read_section(deck_dir, name), idx, 'intro', quick=(i == 0)))
        idx += 1
    # menu (generated)
    slides.append(wrap(menu_section(parts), idx, 'menu', quick=False)); idx += 1
    # parts: optional generated divider (quick) + content slides
    for p in parts:
        if p.get('divider'):
            slides.append(wrap(divider_section(p), idx, p['key'], quick=True)); idx += 1
        for name in p.get('slides', []):
            slides.append(wrap(read_section(deck_dir, name), idx, p['key'], quick=False)); idx += 1
        # graded assessment questions — generated, keyless, interleaved AFTER the
        # module's reading slides so the module gates on them being answered.
        for q in p.get('questions', []):
            slides.append(wrap(graded_section(q), idx, p['key'], quick=False)); idx += 1
    # completion (generated)
    slides.append(wrap(completion_section(spec.get('completion', {})), idx, 'done', quick=False)); idx += 1

    body = '\n'.join(slides)
    root_override = (
        ':root{'
        f'--ink:{brand["ink"]};--grey:{brand["grey"]};--accent:{brand["accent"]};'
        f'--accent-ink:{brand["accentInk"]};--good:{brand["good"]};'
        f'--font-body:{brand["fontBody"]};'
        '}'
    )
    course_key = json.dumps(spec.get('courseKey', slugify(spec.get('title', 'course'))))
    fonts_link = f'<link href="{html.escape(brand["fontsHref"])}" rel="stylesheet">' if brand.get('fontsHref') else ''
    logo = brand.get('logo')
    header_logo = f'<img class="logo" src="{html.escape(logo)}" alt="">' if logo else ''

    page = f'''<!doctype html>
<!-- deck-stage: self-contained course slideshow — no external runtime, no fetch (sandbox-safe) -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(spec.get("title", "Course"))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
{fonts_link}
<style>{ENGINE_CSS}</style>
<style>{root_override}</style>
</head>
<body>
<script>window.__courseKey = {course_key};</script>
<div id="topbar">{header_logo}<span class="title"></span><button id="help" type="button">HELP</button></div>
<div id="viewport"><div id="canvas">
{body}
</div></div>
<div id="bar">
  <button id="back" type="button" hidden>« Back</button>
  <span class="crumb"></span>
  <span class="status"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l6 6L20 6"/></svg></span><span class="msg"></span></span>
  <button id="next" disabled><span class="fill"></span><span class="lbl">Next »</span></button>
</div>
<div id="quizfb"><div class="card"><div class="badge fb-badge"></div><h3 class="fb-h"></h3><p class="fb-p"></p><button class="fbbtn" type="button">Continue</button></div></div>
<div id="helpov"><div class="card"><h3>Using this course</h3><p>Work through each module from the Module Menu. Read every slide, open every card, and answer each question — <strong>Next</strong> lights up once a slide is done. Use <strong>Back</strong> to revisit. Finish all modules to start your assessment.</p><button class="fbbtn" type="button">Got it</button></div></div>
<script>{ENGINE_JS}</script>
</body>
</html>'''
    assert '{{' not in page, 'unresolved placeholder in page'

    pkg = out_dir / 'package'
    if pkg.exists():
        shutil.rmtree(pkg)
    pkg.mkdir(parents=True)
    (pkg / 'index.html').write_text(page, encoding='utf-8')
    if (deck_dir / 'img').is_dir():
        shutil.copytree(deck_dir / 'img', pkg / 'img')
    (pkg / 'imsmanifest.xml').write_text(
        IMSMANIFEST.replace('__TITLE__', html.escape(spec.get('title', 'Course'))), encoding='utf-8')

    slug = slugify(spec.get('title', 'course'))
    zip_path = out_dir / f'{slug}-course.zip'
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(pkg.rglob('*')):
            if path.is_file():
                zf.write(path, path.relative_to(pkg).as_posix())
    # The host counts a deck's slides by matching THIS regex over index.html
    # (see deckSlideCount in apps/api courses route) and gates completion on the
    # engine reporting that many. The engine reports one per `.slide` wrapper, so
    # the two counts MUST agree: a stray "<section …>" anywhere else in the page
    # — an inlined CSS/JS comment, an example in the chrome — inflates the host's
    # total, so the reader can finish every slide and still sit one short, and
    # the assessment gate never opens. Fail the build rather than ship that.
    host_count = (len(re.findall(r'<section\b[^>]*>', page))
                  - len(re.findall(r'<section\b[^>]*\bdata-deck-skip\b[^>]*>', page)))
    n_slides = page.count('class="slide"')
    if host_count != n_slides:
        raise SystemExit(
            f'slide-count mismatch: the host would count {host_count} slides from '
            f'index.html but the engine drives {n_slides} (.slide wrappers). A stray '
            f'"<section" outside a slide (often an inlined comment) inflates the host '
            f'total and makes completion unreachable — remove it.')
    print(f'wrote {zip_path} ({zip_path.stat().st_size:,} bytes) — {n_slides} slides, index.html {len(page):,} bytes')


def main() -> None:
    ap = argparse.ArgumentParser(description='Build a course-deck package from a deck dir.')
    ap.add_argument('deck_dir', type=Path)
    ap.add_argument('--out', type=Path, default=None)
    args = ap.parse_args()
    build(args.deck_dir, args.out or args.deck_dir)


if __name__ == '__main__':
    main()
