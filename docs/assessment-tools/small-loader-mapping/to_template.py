"""mapping.json (top-left points, 1-based pages) → the app's FormField[] with PageBox geometry
(bottom-left origin, 0-based pages, column/row bands), plus manifest hints. Writes template.json
and re-renders every box from the FINAL shape as a coordinate-flip check."""
import json, pathlib, statistics
from cells import Page, overlay
HERE = pathlib.Path(__file__).parent
OUT = HERE / 'out'; OUT.mkdir(exist_ok=True)

m = json.load(open(HERE / 'mapping.json'))
PAGES = {p['page']: p for p in m['pages']}
def fid(key): return 'sl-' + key.replace('_', '-')
def flip(page, rect):
    h = PAGES[page]['height']; x0, y0, x1, y1 = rect
    return {'page': page - 1, 'x': round(x0, 2), 'y': round(h - y1, 2), 'width': round(x1 - x0, 2), 'height': round(y1 - y0, 2),
            'pageWidth': PAGES[page]['width'], 'pageHeight': h}
def field(key, type_, label, **extra):
    f = {'id': fid(key), 'type': type_, 'label': label, 'required': False, 'source': 'imported'}
    f.update(extra); return f

out = []
for f in m['fields']:
    k, t, segs = f['key'], f['type'], f['segments']
    extra = {}
    if f.get('description'): extra['description'] = f['description']
    if t == 'section_header':
        out.append(field(k, t, f['label'], **extra)); continue
    if t == 'radio':  # theory question: ring the letter, target its ✓/✗ box
        boxes = []
        for s in segs:
            b = flip(s['page'], s['rect']); b['optionKey'] = s['optionKey']; b['markStyle'] = {'glyph': 'ring'}; boxes.append(b)
        out.append(field(k, 'radio', f['label'], options=f['options'], outcomeTarget={'fieldId': fid(f['outcomeTarget'])}, geometry={'segments': boxes}))
        continue
    if t == 'repeating_group' and k == 'methods':  # the Assessment Methods checklist: one box, bands per printed row
        page = segs[0]['page']; p = Page(page); h = PAGES[page]['height']
        ticks = sorted(segs, key=lambda s: s['rect'][1])  # top-left y ascending = printed order
        pitch = statistics.median([b['rect'][1] - a['rect'][1] for a, b in zip(ticks, ticks[1:])])
        label_cell = p.cell_at(300, (ticks[0]['rect'][1] + ticks[0]['rect'][3]) / 2)
        bx0, bx1 = ticks[0]['rect'][0] - 3, ticks[0]['rect'][2] + 3  # tick band: mark lands exactly on the printed box
        rows = []
        for i, s in enumerate(ticks):
            bottom = h - s['rect'][3] - 3
            rows.append({'key': f'row:{i}', 'start': round(bottom, 2), 'end': round(bottom + pitch, 2)})
        y_lo = min(r['start'] for r in rows); y_hi = max(r['end'] for r in rows)
        box = {'page': page - 1, 'x': round(label_cell[0], 2), 'y': y_lo, 'width': round(bx1 - label_cell[0], 2),
               'height': round(y_hi - y_lo, 2), 'pageWidth': PAGES[page]['width'], 'pageHeight': h,
               'columnBands': [{'key': 'method', 'start': round(label_cell[0], 2), 'end': round(bx0, 2)},
                               {'key': 'tick', 'start': round(bx0, 2), 'end': round(bx1, 2)}],
               'rowBands': rows}
        out.append(field(k, 'repeating_group', f['label'],
                         columns=[{'key': 'method', 'label': 'Method', 'type': 'text'}, {'key': 'tick', 'label': '✓', 'type': 'checkbox'}],
                         fixedRows=f['fixedRows'], geometry={'segments': [box]}))
        continue
    if t == 'repeating_group' and k.startswith('p') and k.endswith('_log'):  # open logbook: one box, column + row bands
        page = segs[0]['page']; p = Page(page); h = PAGES[page]['height']
        xl = min(s['rect'][0] for s in segs); xr = max(s['rect'][2] for s in segs); top = min(s['rect'][1] for s in segs)
        first = min(segs, key=lambda s: s['rect'][0])['rect']  # row rules are per cell: read them off the first column
        ys = sorted({round(st[0], 1) for st in p.hs if st[0] >= top - 1 and st[1] <= first[0] + 1 and st[2] >= first[2] - 1})
        gaps = [b - a for a, b in zip(ys, ys[1:])]; pitch = statistics.median(gaps)
        ys = [ys[0]] + [y for y, g in zip(ys[1:], gaps) if g < pitch * 1.6]  # drop the page footer rule
        cols = [{'key': s['columnKey'], 'start': round(s['rect'][0], 2), 'end': round(s['rect'][2], 2)} for s in sorted(segs, key=lambda s: s['rect'][0])]
        rows = [{'key': f'r{i+1}', 'start': round(h - ys[i+1], 2), 'end': round(h - ys[i], 2)} for i in range(len(ys) - 1)]
        rows.sort(key=lambda r: -r['start'])  # printed order: top row first
        rows = [{**r, 'key': f'r{i+1}'} for i, r in enumerate(rows)]
        box = {'page': page - 1, 'x': cols[0]['start'], 'y': rows[-1]['start'], 'width': round(cols[-1]['end'] - cols[0]['start'], 2),
               'height': round(rows[0]['end'] - rows[-1]['start'], 2), 'pageWidth': PAGES[page]['width'], 'pageHeight': h,
               'columnBands': cols, 'rowBands': rows}
        columns = []
        for c in f['columns']:
            col = dict(c)
            if c['type'] == 'date': col['autoStamp'] = True
            columns.append(col)
        out.append(field(k, 'repeating_group', f['label'], columns=columns, geometry={'segments': [box]}, **extra))
        print(f"{k}: {len(rows)} rows, {len(cols)} columns")
        continue
    if t == 'repeating_group':  # practical sub-section: header + one ✓/✗ per criterion + its N/A box
        sec = k  # e.g. p2_s1
        out.append(field(sec, 'section_header', f['label'].split(' — ')[0], description='During the demonstration, did the Candidate:'))
        by_row = {}
        for s in segs: by_row.setdefault(s['rowIndex'], {})[s['columnKey']] = s
        for i, label in enumerate(f['fixedRows']):
            r = by_row[i]
            out.append(field(f'{sec}_r{i}', 'check_cross', label, geometry={'segments': [flip(r['tick']['page'], r['tick']['rect'])]}))
            out.append(field(f'{sec}_r{i}_na', 'checkbox', 'N/A', geometry={'segments': [flip(r['na']['page'], r['na']['rect'])]}))
        continue
    # scalar fields
    if k in ('candidate_name', 'candidate_signature'): extra['required'] = True
    if k == 'licence_box': t = 'check_cross'  # a prerequisite verdict lands in a ✓/✗ box
    out.append(field(k, t, f['label'], geometry={'segments': [flip(s['page'], s['rect']) for s in segs]}, **extra))

# The practical parts' verdict pair: one radio over the two printed boxes, so the
# checklist derivation can write it (verdictPairOf) once it is locked `auto`.
merged = []
i = 0
while i < len(out):
    f = out[i]
    if f['id'].endswith('-not-competent') and f['id'] != 'sl-not-competent':
        yes = out[i + 1]; assert yes['id'].endswith('-competent'), yes['id']
        part = f['id'].split('-')[1]
        no_box = f['geometry']['segments'][0]; yes_box = yes['geometry']['segments'][0]
        merged.append(field(f'{part}_verdict', 'radio', f'Part {part[1:]} Assessment — the candidate’s overall performance',
                            options=['Candidate not yet Competent', 'Candidate Competent'],
                            geometry={'segments': [{**no_box, 'optionKey': 'Candidate not yet Competent'}, {**yes_box, 'optionKey': 'Candidate Competent'}]}))
        i += 2; continue
    merged.append(f); i += 1
out = merged

hints = {
    'candidateName': 'sl-candidate-name', 'companyName': 'sl-company-name', 'swipeCard': 'sl-swipe-card',
    'candidateSignature': 'sl-candidate-signature', 'declarationAnchor': 'sl-candidate-declaration',
    'assessorSignature': 'sl-assessor-signature', 'assessorName': 'sl-assessor-name', 'signedDate': 'sl-assessor-date',
    'overallSatisfactory': 'sl-competent', 'overallNotSatisfactory': 'sl-not-competent',
    'coachingYes': 'sl-coaching-yes', 'coachingNo': 'sl-coaching-no', 'licenceBox': 'sl-licence-box',
    'categoryBox': 'sl-category-box', 'methodsTable': 'sl-methods', 'assessorComments': 'sl-assessor-comments',
    'furtherAction': 'sl-further-action',
    'parts': {
        'p1-theory': {'outcomeSatisfactory': 'sl-part1-satisfactory', 'outcomeNotSatisfactory': 'sl-part1-not-satisfactory'},
        'p2-practical': {'verdict': 'sl-p2-verdict', 'assessorName': 'sl-p2-assessor-name', 'signedDate': 'sl-p2-date', 'assessorSignature': 'sl-p2-assessor-signature'},
        'p4-practical': {'verdict': 'sl-p4-verdict', 'assessorName': 'sl-p4-assessor-name', 'signedDate': 'sl-p4-date', 'assessorSignature': 'sl-p4-assessor-signature'},
        'p6-practical': {'verdict': 'sl-p6-verdict', 'assessorName': 'sl-p6-assessor-name', 'signedDate': 'sl-p6-date', 'assessorSignature': 'sl-p6-assessor-signature'},
    },
}
ids = [f['id'] for f in out]; assert len(ids) == len(set(ids)), 'duplicate ids'
for v in [v for v in hints.values() if isinstance(v, str)] + [x for p in hints['parts'].values() for x in p.values()]:
    assert v in ids, v
tpl = {'name': 'Authorised to Operate Small Loader', 'pdf': 'small-loader.blank.pdf',
       'pages': [{'index': p['page'] - 1, 'width': p['width'], 'height': p['height']} for p in m['pages']],
       'hints': hints, 'fields': out}
json.dump(tpl, open(HERE.parent / 'small-loader.template.json', 'w'), indent=1, ensure_ascii=False)
segs = sum(len(f.get('geometry', {}).get('segments', [])) for f in out)
print('fields', len(out), 'segments', segs, 'types', {t: sum(1 for f in out if f['type'] == t) for t in sorted({f['type'] for f in out})})

# Flip-check: draw every FINAL box (and its bands) back in top-left space.
for pno in range(1, 13):
    rects, labels = [], []
    for f in out:
        for b in f.get('geometry', {}).get('segments', []):
            if b['page'] != pno - 1: continue
            h = b['pageHeight']
            rects.append([b['x'], h - b['y'] - b['height'], b['x'] + b['width'], h - b['y']]); labels.append(f['id'][3:])
            for cb in b.get('columnBands', []):
                for rb in b.get('rowBands', []):
                    rects.append([cb['start'], h - rb['end'], cb['end'], h - rb['start']]); labels.append('')
    if rects: overlay(pno, rects, str(OUT / f'final-p{pno:02d}.png'), labels)
