"""Derive every field + box on the blank Small Loader tool from the PDF's own grid.
Output: mapping.json (intermediate, PDF points, origin top-left, 1-based pages) + overlays."""
import json, pathlib, re
from cells import Page, overlay
HERE = pathlib.Path(__file__).parent
OUT = HERE / 'out'; OUT.mkdir(exist_ok=True)

QUESTIONS = [
 (1, "The loader must be isolated with a hasp and personnel lock attached prior to entering the footprint of the machine.", ["True", "False"]),
 (2, "3 points of contact is the safest way to access and egress the loader.", ["True", "False"]),
 (3, "What is the purpose of performing a walk around pre-start inspection of the loader prior to operating.", ["Inspect for damage", "Identify any faults with the loader", "Ensure that the loader is safe to operate", "All the above"]),
 (4, "What action would you take if there was an “Out of Service Tag” on the loader’s isolation switch.", ["Ignore the tag and operate the loader", "Remove the tag so you can operate the loader", "Do not operate the loader and report the tag to pit control"]),
 (5, "All working equipment at BBM is subject to a 40-metre exclusion zone.", ["True", "False"]),
 (6, "The hydraulic oil, transmission fluid and coolant level on the loader can be checked by sight glass.", ["True", "False"]),
 (7, "When travelling the loader, you should only use the service brake to control the loaders speed.", ["True", "False"]),
 (8, "The window on the right-hand side of the cab can be used as an emergency exit point if required.", ["True", "False"]),
 (9, "Prior to performing a hopper clean-up, what process would you follow.", ["Complete a Risk assessment (RAP)", "Authorisation gained from the duty production supervisor", "Communication with crusher control to have the orange light activated", "Notify pit control and a general broadcast put out to all haul truck operators, notifying them of the clean-up", "All of the above"]),
 (10, "Testing the park brake and service brake on the loader is completed in 3rd gear forward at 1700rpm.", ["True", "False"]),
 (11, "When loading the bucket with material, you should only operate the loader in 1st gear.", ["True", "False"]),
 (12, "Brake checks should be performed at the start of every shift, prior to leaving the park-up.", ["True", "False"]),
 (13, "What action would you take if the engine oil warning light stayed illuminated once the engine has started:", ["Shut the engine off", "Report the fault to pit control", "Tag the loader “out of service”", "All of the above"]),
 (14, "Failure to check that the quick hitch locking pins are fully inserted, could result in the bucket attachment coming off.", ["True", "False"]),
 (15, "The secondary steering system on the loader is battery operated", ["True", "False"]),
 (16, "If a fire was detected on the loader that you were operating, what action would you take.", ["Stop the loader and ground the bucket", "Select neutral and engage the park brake", "Activate the fire suppression system", "Call the emergency", "Evacuate the area", "All of the above"]),
]
LETTERS = 'abcdef'
fields = []
def add(key, type_, label, segments=None, **extra):
    f = {'key': key, 'type': type_, 'label': label, 'segments': segments or []}
    f.update(extra); fields.append(f); return f
def pad(r, dx=1, dy=1): return [r[0]-dx, r[1]-dy, r[2]+dx, r[3]+dy]
def seg(page, rect, **k): d = {'page': page, 'rect': [round(v, 1) for v in rect]}; d.update(k); return d
def below(p, text, dy=16, nth=0):
    b = p.phrase(text, nth=nth); assert b, text
    return p.cell_at((b[0]+b[2])/2, b[3]+dy)
def line_words(p, y0, y1, xmax=9999):
    return [w for w in p.words if w[1] >= y0-2 and w[3] <= y1+2 and w[2] <= xmax]

# ───────── page 1: cover ─────────
p = Page(1)
add('candidate_details', 'section_header', 'Candidate Details')
add('candidate_name', 'text', 'Candidate’s Name', [seg(1, below(p, 'Candidate’s Name'))], required=True)
add('company_name', 'text', 'Candidate’s Company Name', [seg(1, below(p, 'Candidate’s Company Name'))])
add('swipe_card', 'text', 'Employee Swipe card Number', [seg(1, below(p, 'Employee Swipe card Number'))])
add('candidate_declaration', 'section_header', 'Candidate Declaration',
    description='The assessment process undertaken with this exercise was explained to me in advance and I agree that I am ready to undertake this assessment.')
b = p.phrase('Candidate’s Signature:')
add('candidate_signature', 'signature', 'Candidate’s Signature', [seg(1, p.cell_at(b[2]+40, (b[1]+b[3])/2))], required=True)
add('assessment_summary', 'section_header', 'Assessment Summary')
bx = {round(r[1]): r for r in p.boxes}
def box_at(page, y, x=None):
    hits = [r for r in page.boxes if abs(r[1]-y) < 4 and (x is None or abs(r[0]-x) < 4)]
    assert len(hits) == 1, (page.pno, y, x, hits); return hits[0]
add('category_box', 'checkbox', 'Category of Assessment — Q50073331 ATO Small Loader', [seg(1, pad(box_at(p, 287.8)))])
add('licence_box', 'checkbox', 'Prerequisites — Q50001782 Driver’s Licence C or higher', [seg(1, pad(box_at(p, 305.8)))])
METHOD_ROWS = ['PART 1 and 2: Experienced candidates or Re-assessments', 'PART 1, 2, 3, 4, 5 and 6: New and inexperienced candidates',
               '1. Theory', '2. Practical Demonstration', '3. Direct Observation Log', '4. Minimal Supervision Practical Assessment',
               '5. Minimal Supervision Log', '6. Final Practical Assessment']
method_boxes = sorted([r for r in p.boxes if 335 < r[1] < 475], key=lambda r: r[1]); assert len(method_boxes) == 8
# The two pathway lines are standalone boxes (the export writes them as scalar marks);
# the six method rows form the fixed-row checklist that completion ticks by row index.
add('pathway_experienced', 'checkbox', METHOD_ROWS[0], [seg(1, pad(method_boxes[0]))])
add('pathway_new', 'checkbox', METHOD_ROWS[1], [seg(1, pad(method_boxes[1]))])
add('methods', 'repeating_group', 'Assessment Methods — methods used to assess competence',
    [seg(1, pad(r), rowIndex=i, columnKey='tick') for i, r in enumerate(method_boxes[2:])],
    columns=[{'key': 'tick', 'label': '✓', 'type': 'checkbox'}], fixedRows=METHOD_ROWS[2:])
# assessor comments: the two blank rows under the "Assessor’s comments:" line
b = p.phrase('Assessor’s comments:')
rows = sorted({round(s[0], 1) for s in p.hs if b[3] < s[0] < 530 and s[1] < 300 < s[2]})
print('p1 h-strokes under comments:', rows)
c1 = p.cell_at(370, rows[0]+3); c2 = p.cell_at(370, rows[1]+3) if len(rows) > 1 else c1
add('assessor_comments', 'textarea', 'Assessor’s comments on performance and feedback to the Candidate', [seg(1, [c1[0], c1[1], c2[2], c2[3]])])
add('coaching_no', 'checkbox', 'More coaching and/or training required? — No', [seg(1, pad(box_at(p, 527.9, 399.7)))])
add('coaching_yes', 'checkbox', 'More coaching and/or training required? — Yes', [seg(1, pad(box_at(p, 527.9, 443.9)))])
b = p.phrase('Detail further action:')
rows = sorted({round(s[0], 1) for s in p.hs if b[3] < s[0] < 575 and s[1] < 300 < s[2]})
print('p1 h-strokes under further action:', rows)
c1 = p.cell_at(370, rows[0]+3); c2 = p.cell_at(370, rows[1]+3) if len(rows) > 1 else c1
add('further_action', 'textarea', 'Detail further action', [seg(1, [c1[0], c1[1], c2[2], c2[3]])])
add('assessment_result', 'section_header', 'Assessment Result',
    description='The Candidate’s overall performance meets the requirements of the assessment method listed above? Sufficient performance evidence was made available during the assessment to satisfy evidence requirement of the outcome?')
add('not_competent', 'checkbox', 'Candidate not yet Competent', [seg(1, pad(box_at(p, 616.9, 352.4)))])
add('competent', 'checkbox', 'Candidate Competent', [seg(1, pad(box_at(p, 616.9, 556.0)))])
add('assessor_name', 'text', 'Name of Assessor [Print]', [seg(1, below(p, 'Name of Assessor [Print]', 22))])
add('assessor_signature', 'signature', 'Assessor Signature', [seg(1, below(p, 'Assessor Signature', 22))])
add('assessor_date', 'date', 'Date', [seg(1, below(p, 'Date', 22))])

# ───────── pages 3–4: Part 1 theory ─────────
add('part1', 'section_header', 'PART 1 - THEORY', description='Written or Verbal Questions — the Candidate should answer the following questions to indicate underpinning knowledge.')
pages = {3: Page(3), 4: Page(4)}
for n, text, opts in QUESTIONS:
    p = pages[3 if n <= 9 else 4]
    num = [w for w in p.words if w[4] == f'{n}.' and w[0] < 50]; assert len(num) == 1, (n, num); num = num[0]
    nxt = [w for w in p.words if w[4] == f'{n+1}.' and w[0] < 50]
    y_end = nxt[0][1] if nxt else (p.h if n != 16 else 9999)
    letters = [w for w in p.words if re.fullmatch(r'[a-f]\)', w[4]) and num[1] <= w[1] < y_end and w[0] < 90]
    assert len(letters) == len(opts), (n, [w[4] for w in letters], opts)
    options = [f'{LETTERS[i]}) {o}' for i, o in enumerate(opts)]
    segs = [seg(p.pno, [w[0]-2.5, w[1]-1.5, w[2]+2.5, w[3]+1.5], optionKey=options[i]) for i, w in enumerate(letters)]
    hits = [r for r in p.boxes if abs(r[1] - (num[1]-2.1)) < 5 and r[0] > 500]
    if hits: obox = hits[0]
    else:
        obox = [545.2, num[1]-2.1, 553.0, num[1]+5.7]; print(f'Q{n}: no printed outcome box — synthesised at {obox}')
    add(f'q{n}', 'radio', f'{n}. {text}', segs, options=options, outcomeTarget=f'q{n}_outcome')
    add(f'q{n}_outcome', 'check_cross', f'Q{n} ✓/✗', [seg(p.pno, pad(obox))])
p = pages[4]
tail = sorted([r for r in p.boxes if r[1] > 560], key=lambda r: r[0]); assert len(tail) == 2, tail
add('part1_satisfactory', 'checkbox', 'PART 1 - The Candidate’s responses were: Satisfactory', [seg(4, pad(tail[0]))])
add('part1_not_satisfactory', 'checkbox', 'PART 1 - The Candidate’s responses were: Not Satisfactory', [seg(4, pad(tail[1]))])

# ───────── practical parts 2 / 4 / 6 ─────────
def practical(part, pages_, title):
    add(f'part{part}', 'section_header', title, description='Materials Required: Small Loader')
    sections = []  # (title, rows[(label, tickbox, nabox, page)])
    for pno in pages_:
        p = Page(pno)
        # section title lines: "N." then title words, no boxes on that line
        titles = []
        for w in p.words:
            if re.fullmatch(r'[1-6]\.', w[4]) and 150 < w[0] < 320:
                ws = line_words(p, w[1], w[3]); titles.append((w[1], ' '.join(x[4] for x in sorted(ws, key=lambda x: x[0])[1:])))
        rows = {}
        for r in p.boxes: rows.setdefault(round(r[1]), []).append(r)
        for y in sorted(rows):
            bs = sorted(rows[y], key=lambda r: r[0])
            if len(bs) != 2: continue
            ws = [w for w in line_words(p, bs[0][1]-4, bs[0][3]+4, xmax=500)]
            label = ' '.join(w[4] for w in sorted(ws, key=lambda w: w[0]))
            if not label or 'Candidate' in label and 'Competent' in label: continue
            above = [t for t in titles if t[0] < y]
            sec = above[-1][1] if above else (sections[-1][0] if sections else '?')
            if not sections or sections[-1][0] != sec: sections.append((sec, []))
            sections[-1][1].append((label, bs[0], bs[1], pno))
    for k, (title_, rows_) in enumerate(sections, 1):
        segs = []
        for i, (label, tb, nb, pno) in enumerate(rows_):
            segs.append(seg(pno, pad(tb), rowIndex=i, columnKey='tick')); segs.append(seg(pno, pad(nb), rowIndex=i, columnKey='na'))
        add(f'p{part}_s{k}', 'repeating_group', f'{k}. {title_} — During the demonstration, did the Candidate:', segs,
            columns=[{'key': 'tick', 'label': '√ / ×', 'type': 'check_cross'}, {'key': 'na', 'label': 'N/A', 'type': 'checkbox'}],
            fixedRows=[r[0] for r in rows_])
    # assessment block on the second page
    p = Page(pages_[1])
    tail = sorted([r for r in p.boxes if r[1] > 640 and not any(abs(r[1]-o[1]) < 4 and abs(r[0]-o[0]) < 4 and r is not o for o in [])], key=lambda r: r[1])
    last_y = max(r[1] for r in p.boxes); pair = sorted([r for r in p.boxes if abs(r[1]-last_y) < 4], key=lambda r: r[0]); assert len(pair) == 2, pair
    add(f'p{part}_assessment', 'section_header', f'Part {part} Assessment', description='The candidate’s overall performance meets the requirements of the assessment method listed above. Sufficient performance evidence was made available during the assessment to satisfy evidence requirement of the outcome.')
    add(f'p{part}_not_competent', 'checkbox', 'Candidate not yet Competent', [seg(p.pno, pad(pair[0]))])
    add(f'p{part}_competent', 'checkbox', 'Candidate Competent', [seg(p.pno, pad(pair[1]))])
    add(f'p{part}_assessor_name', 'text', 'Name of Assessor [Print]', [seg(p.pno, below(p, 'Name of Assessor [Print]', 22))])
    add(f'p{part}_assessor_signature', 'signature', 'Assessor Signature', [seg(p.pno, below(p, 'Assessor Signature', 22))])
    add(f'p{part}_date', 'date', 'Date', [seg(p.pno, below(p, 'Date', 22))])
    print(f'part {part}: sections', [(t, len(r)) for t, r in sections])

# ───────── logbooks 3 / 5 ─────────
def logbook(part, pno, title, note, cols):
    p = Page(pno)
    add(f'part{part}', 'section_header', title, description=note)
    segs = []; nrows = None
    for key, header, ctype in cols:
        hb = p.phrase(header); assert hb, header
        hc = p.cell_at((hb[0]+hb[2])/2, (hb[1]+hb[3])/2)
        ys = sorted({round(s[0], 1) for s in p.hs if s[0] > hc[3]-1 and s[1] <= hc[0]+1 and s[2] >= hc[2]-1})
        nrows = len(ys) - 1 if nrows is None else nrows
        segs.append(seg(pno, [hc[0], ys[0], hc[2], ys[-1]], columnKey=key, rows=len(ys)-1))
    add(f'p{part}_log', 'repeating_group', title, segs, columns=[{'key': k, 'label': h, 'type': t} for k, h, t in cols])
    print(f'part {part}: logbook rows', nrows)

practical(2, (5, 6), 'PART 2 – PRACTICAL DEMONSTRATION')
logbook(3, 7, 'PART 3 - DIRECT OBSERVATION LOG', 'New or inexperienced candidates will be required to complete a minimum of 10hrs directly supervised before assessment for Minimal Supervision can take place.',
        [('date', 'Date', 'date'), ('task', 'Task', 'text'), ('duration', 'Duration', 'number'), ('operator_name', 'Qualified Operators', 'text'), ('operator_signature', 'Qualified Operators Signature', 'signature')])
practical(4, (8, 9), 'PART 4 – MINIMAL SUPERVISION PRACTICAL DEMONSTRATION')
logbook(5, 10, 'PART 5 – MINIMAL SUPERVISION LOG', 'New or inexperienced candidates will be required to complete a minimum of 20hrs before final practical assessment can take place.',
        [('date', 'Date', 'date'), ('location', 'Location', 'text'), ('task', 'Task', 'text'), ('duration', 'Duration', 'number'), ('comments', 'Comments', 'text'), ('candidate_signature', 'Candidate’s Signature', 'signature')])
practical(6, (11, 12), 'PART 6 – FINAL PRACTICAL ASSESSMENT')

pages_meta = [{'page': i, 'width': Page(i).w, 'height': Page(i).h} for i in range(1, 14)]
json.dump({'pages': pages_meta, 'fields': fields}, open(HERE / 'mapping.json', 'w'), indent=1)
print('fields:', len(fields), 'segments:', sum(len(f['segments']) for f in fields))
for pno in range(1, 13):
    rects, labels = [], []
    for f in fields:
        for s in f['segments']:
            if s['page'] == pno:
                rects.append(s['rect']); labels.append(f['key'] + ('.' + str(s.get('optionKey', ''))[:2] if 'optionKey' in s else '') + (f"[{s['rowIndex']}]" if 'rowIndex' in s else '') + ('.' + s['columnKey'] if 'columnKey' in s and 'rowIndex' not in s else ''))
    if rects: overlay(pno, rects, str(OUT / f'map-p{pno:02d}.png'), labels)
