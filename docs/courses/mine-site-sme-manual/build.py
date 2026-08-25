#!/usr/bin/env python3
"""Assemble the Mine Site SME Manual course package — a SELF-CONTAINED slideshow.

Why self-contained: the FormAI course player runs the package in a
`sandbox="allow-scripts"` iframe, whose origin is opaque ("null"). The old
Claude-Design deck booted by `fetch(location.href)` + `fetch('./deck-stage.js')`,
and both are CORS-blocked from an opaque origin — so the deck never became a
slideshow, it just rendered 52 stacked sections and scrolled. This build keeps
all 52 slide *sections* verbatim but drives them with a tiny vanilla engine
(inlined below): no fetch, no React, no external runtime, works in the sandbox.

The engine gives the reader:
  - a real one-slide-at-a-time slideshow, scaled to fit, animated transitions;
  - a hub-and-spoke Section Menu: parts unlock in order; finish a part's slides
    and you return to the menu to start the next;
  - a live Next button that unlocks after a reading beat (timed to the slide's
    length) OR once every interactive card on the slide has been opened, with an
    animated green tick when the slide completes;
  - full-view sign images on the signage slide;
  - a Start Assessment button at the end that asks the host to open the case.

It reports each completed slide to the host player as {type:'course-slide'} and
accepts {type:'course-progress-seed'} to resume — the same bridge contract the
player already speaks. The string "deck-stage" is kept in a marker comment so
the importer still detects the package as a deck and counts its 52 slides.

Usage:  python3 docs/courses/mine-site-sme-manual/build.py
Output: mine-site-sme-manual-course.zip beside this script.
"""
import re
import shutil
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'SME Induction Deck.dc.html'
OUT_DIR = HERE / 'package'
ZIP = HERE / 'mine-site-sme-manual-course.zip'

# ── Part structure: slide-index ranges (kept from the deck's own ordering) ────
PARTS = {'A': (3, 7), 'B': (8, 13), 'C': (14, 19), 'D': (20, 27), 'E': (28, 37), 'F': (38, 50)}
ORDER = ['A', 'B', 'C', 'D', 'E', 'F']


def part_of(i: int) -> str:
    if i in (0, 1):
        return 'intro'
    if i == 2:
        return 'menu'
    if i == 51:
        return 'done'
    for tag, (lo, hi) in PARTS.items():
        if lo <= i <= hi:
            return tag
    return 'intro'


# ── Content for the 6 regenerated (formerly data-bound) slides ────────────────
PART_DEFS = [
    ('A', 'MODULE A', 'Working Safely in the Active Mine Area', 'Safety focus · PPE · principal hazards · exclusion zones'),
    ('B', 'MODULE B', 'Communication', 'Two-way radio · emergency response · channels · blasting · pos-coms'),
    ('C', 'MODULE C', 'Access & Traffic Rules', 'Area access · pedestrians · CAS · phones · signage'),
    ('D', 'MODULE D', 'Operating SME', 'Isolation · horn signals · inspections · faults · blind spots'),
    ('E', 'MODULE E', 'Vehicle Interaction', 'Change outs · parking · refuelling · passing · breakdowns · public roads'),
    ('F', 'MODULE F', 'Hazardous Events, Ground & Health', 'Fires · lightning · powerlines · gradients · vibration · fatigue'),
]

PMH = [
    ('PMH 14', 'Dropped & Falling Objects', 'Good housekeeping · Exclusion zones'),
    ('PMH 16', 'Vehicle Accident BBM', 'Exclusion zones · Segregation · Positive communication · Training & qualifications · Vehicle inspections · CAS systems'),
    ('PMH 19', 'Explosive Detonation', 'Blasting exclusion zones · Clearance process · Restricted access · Training & qualification · Blasting Transport standard · Blast charging practices'),
    ('PMH 20', 'Falling from Height', 'Handrails & barricading · Training & qualifications · Safe systems of work'),
    ('PMH 24', 'Ground Movement', 'Exclusion zones · Tip head procedures · Training & qualification · Inspections'),
    ('PMH 31', 'Psychosocial Harm', 'Drug & alcohol testing · EAP programs · Code of Conduct training · Fatigue management'),
]

RADIO = [
    ('PIT CONTROL', 'Communication to and from the Pit Controller'),
    ('MARRA 1', 'Primary channel — haul roads and pit at Marradong'),
    ('MARRA 2', 'Secondary channel at Marradong for long conversation'),
    ('SADDLE 1', 'Primary channel — haul roads and pit at Saddleback'),
    ('SADDLE 2', 'Secondary channel at Saddleback for long conversation'),
    ('DEV 1 & 2', 'Development activities behind coordinator signs'),
    ('DRILLING', 'Drilling activities behind coordinator signs'),
    ('PLANT 1 & 2', 'BBM Fixed Plant and OBC; Plant 2 for long conversation'),
    ('MAINT', 'Maintenance activities — crane use, spotting, etc.'),
    ('ESO', 'Emergency services use, e.g. ERT training'),
    ('BBM–EMER', 'Emergency channel — activated by the orange button'),
    ('BLAST', 'Blasting activities — roadblocks, noise monitors'),
    ('SURVEY', 'Survey activities — roads and pits'),
]

HORN = [
    ('1', 'One blast', '“I am starting the engine”'),
    ('2', 'Two blasts', '“I am moving forwards”'),
    ('3', 'Three blasts', '“I am moving backwards”'),
]

SIGNS = [
    ('img/p10-yondr.png', 'Stop & Give Way', 'mandatory', 'A STOP sign means stop AND give way to other traffic in the intersection — simply pausing does not comply and can result in a catastrophic incident. Max site speed is 60 kph; lower limits are signposted. Traffic controls may change without warning and must always be obeyed.'),
    ('img/p04-ppe.png', 'Blue Mandatory Signs', 'must comply', 'Blue signage on a white background denotes a mandatory requirement, such as minimum PPE for the area.'),
    ('img/p11-sign-a.png', 'Yellow Caution Signs', 'proceed with caution', 'A hazard of some description is ahead — traffic hazard, detour, single-lane access. No permission needed; pass with caution at 30 kph or less.'),
    ('img/p11-sign-b.png', 'Red Job Coordinator Signs', 'permission required', 'Entry restricted. Stop at the sign, contact the equipment ID or area owner on the posted radio channel using positive communication, and do not proceed until pos-coms is made. Stay on the posted channel while inside; the 40 m zone still applies; notify the owner when you leave. No response after multiple attempts? DO NOT ENTER — notify the duty supervisor.'),
    ('img/p11-sign-c.png', 'Blast Signage & Barricades', 'shotfirer permission only', 'Blasting areas have restricted access via multiple signs and barricades. Never pass any of them without the shotfirer or delegate’s permission.'),
    ('img/p12-isolation.jpg', 'Disease Suspect Areas', 'hygiene rules', 'Forest disease suspect/confirmed areas have restricted access. Drivers must follow hygiene procedures — vehicles brushed down in summer and washed down in winter — to avoid spreading forest diseases.'),
]


def menu_slide() -> str:
    cards = []
    for tag, label, title, contents in PART_DEFS:
        cards.append(
            f'''      <div class="part-card" data-part="{tag}" style="background:#fff; padding:30px 34px; display:flex; flex-direction:column; gap:10px; border-top:6px solid #3C4043;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span class="pc-tag" style="font-size:23px; font-weight:700; letter-spacing:2px;">{label}</span>
          <span class="pc-tick" style="font-size:22px; font-weight:700;"></span>
        </div>
        <h2 style="font-size:29px; font-weight:800; line-height:1.1;">{title}</h2>
        <p style="font-size:23px; line-height:1.35; color:#666; font-family:'Archivo Narrow';">{contents}</p>
      </div>'''
        )
    grid = '\n'.join(cards)
    return f'''<section data-label="Section menu" style="background:var(--grey); color:var(--ink); display:flex; flex-direction:column; padding:64px var(--pad-x) 52px; gap:26px;">
  <div style="display:flex; justify-content:space-between; align-items:flex-end;">
    <h1 style="font-size:var(--type-title); font-weight:800; letter-spacing:-1px;">Section Menu</h1>
    <div style="display:flex; align-items:center; gap:16px;">
      <span class="menu-count" style="font-size:var(--type-small); color:#666;">0 of 6 modules complete</span>
      <div style="width:220px; height:12px; background:#ddd; border-radius:6px; overflow:hidden;"><div class="menu-fill" style="height:100%; background:#1a7a2e; width:0%; transition:width .4s;"></div></div>
    </div>
  </div>
  <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:22px; flex:1;">
{grid}
  </div>
  <p class="menu-foot" style="font-size:23px; color:#888; text-align:center;">Modules unlock in order — open a module, read every slide and every card, then come back here for the next.</p>
</section>'''


def pmh_slide() -> str:
    cards = []
    for i, (code, name, controls) in enumerate(PMH):
        cards.append(
            f'''      <div class="expander card" data-touch="pmh{i}" style="background:#4A4F53; border-top:5px solid #EADA23; padding:26px 30px; display:flex; flex-direction:column; gap:10px;">
        <span style="font-size:23px; font-weight:700; letter-spacing:2px; color:#EADA23;">{code}</span>
        <h2 style="font-size:29px; font-weight:800; line-height:1.15;">{name}</h2>
        <p class="detail" style="font-size:23px; line-height:1.4; color:#ccc; font-family:'Archivo Narrow'; display:none;">{controls}</p>
        <span class="closed-label" style="font-size:23px; color:#9a9a9a;">+ Critical controls</span>
      </div>'''
        )
    grid = '\n'.join(cards)
    return f'''<section data-label="PMH" style="background:var(--ink); color:#fff; display:flex; flex-direction:column; padding:70px var(--pad-x) 56px; gap:22px;">
  <div style="display:flex; flex-direction:column; gap:12px;">
    <h1 style="font-size:var(--type-title); font-weight:800; letter-spacing:-1px;">Principal Mining Hazards</h1>
    <p style="font-size:var(--type-small); color:#bbb; max-width:1500px; line-height:1.4;">South32 has identified 32 Principal Mining Hazards — activities with reasonable potential to cause multiple deaths in a single incident. Six apply to the BBM active mine area. Open each to see its critical controls.</p>
  </div>
  <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:18px; flex:1; align-content:start;">
{grid}
  </div>
</section>'''


def radio_slide() -> str:
    cards = []
    for i, (name, meaning) in enumerate(RADIO):
        cards.append(
            f'''      <div class="flipcard card" data-touch="rc{i}" style="min-height:172px;">
        <div class="flipinner">
          <div class="flipface" style="background:#fff; border:2px solid #ddd; padding:18px;">
            <span style="font-size:30px; font-weight:900; color:var(--ink); text-align:center; letter-spacing:-0.5px;">{name}</span>
            <span class="rc-hint" style="font-size:22px; color:#999;">tap to reveal</span>
          </div>
          <div class="flipface flipback" style="background:var(--ink); color:#fff; padding:18px 22px;">
            <span style="font-size:23px; line-height:1.3; text-align:center; font-family:'Archivo Narrow';">{meaning}</span>
          </div>
        </div>
      </div>'''
        )
    grid = '\n'.join(cards)
    return f'''<section data-label="Radio channels" style="background:var(--grey); color:var(--ink); display:flex; flex-direction:column; padding:64px var(--pad-x) 52px; gap:24px;">
  <div style="display:flex; justify-content:space-between; align-items:flex-end;">
    <h1 style="font-size:var(--type-title); font-weight:800; letter-spacing:-1px;">Radio Channel Reference Guide</h1>
    <p style="font-size:var(--type-small); color:#666;">Flip every card to continue</p>
  </div>
  <div style="display:grid; grid-template-columns:repeat(5,1fr); grid-auto-rows:1fr; gap:16px; flex:1;">
{grid}
  </div>
</section>'''


def horn_slide() -> str:
    cards = []
    for i, (count, label, meaning) in enumerate(HORN):
        cards.append(
            f'''      <div class="flipcard card" data-touch="hc{i}" style="min-height:360px;">
        <div class="flipinner">
          <div class="flipface" style="background:#4A4F53; border:2px solid #444;">
            <span style="font-size:120px; font-weight:900; color:var(--amber); line-height:1;">{count}</span>
            <span style="font-size:29px; font-weight:700;">{label}</span>
            <span class="rc-hint" style="font-size:22px; color:#888;">tap to reveal</span>
          </div>
          <div class="flipface flipback" style="background:#EADA23; color:#3C4043;">
            <span style="font-size:38px; font-weight:800; text-align:center; padding:0 28px; line-height:1.25;">{meaning}</span>
          </div>
        </div>
      </div>'''
        )
    grid = '\n'.join(cards)
    return f'''<section data-label="Horn signals" style="background:var(--ink); color:#fff; display:flex; flex-direction:column; padding:70px var(--pad-x) 56px; gap:30px;">
  <div style="display:flex; justify-content:space-between; align-items:flex-end;">
    <h1 style="font-size:var(--type-title); font-weight:800; letter-spacing:-1px;">Horn Signals</h1>
    <p style="font-size:var(--type-small); color:#bbb;">Flip every card — what does each signal mean?</p>
  </div>
  <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:26px; flex:1;">
{grid}
  </div>
  <div style="background:#4A4F53; padding:22px 32px;">
    <p style="font-size:var(--type-small); line-height:1.4;"><span style="color:var(--amber); font-weight:800;">Always wait 5–10 seconds</span> after signalling your intention before carrying out the action.</p>
  </div>
</section>'''


def signage_slide() -> str:
    rows = []
    for i, (img, name, hint, detail) in enumerate(SIGNS):
        rows.append(
            f'''      <div class="expander card" data-touch="sign{i}" data-accordion="1" style="background:#fff; display:flex; flex-direction:column;">
        <div style="display:flex; align-items:center; gap:24px; padding:14px 28px;">
          <img src="{img}" style="width:140px; height:84px; object-fit:contain; background:#fbfaf9; border:1px solid #eee; border-radius:8px; padding:6px; flex-shrink:0;">
          <h2 style="font-size:31px; font-weight:800; flex:1;">{name}</h2>
          <span style="font-size:25px; color:#999; font-family:'Archivo Narrow';">{hint}</span>
          <span class="chev" style="font-size:33px; font-weight:800; color:#E4002B;">+</span>
        </div>
        <div class="detail" style="display:none; gap:28px; align-items:flex-start; padding:0 28px 16px 192px;">
          <img src="{img}" style="width:230px; height:140px; object-fit:contain; background:#fbfaf9; border:1px solid #eee; border-radius:8px; padding:10px; flex-shrink:0;">
          <p style="font-size:24px; line-height:1.5; color:#444; font-family:'Archivo Narrow'; flex:1;">{detail}</p>
        </div>
      </div>'''
        )
    grid = '\n'.join(rows)
    return f'''<section data-label="Signage" style="background:var(--grey); color:var(--ink); display:flex; flex-direction:column; padding:56px var(--pad-x) 44px; gap:20px;">
  <div style="display:flex; justify-content:space-between; align-items:flex-end;">
    <h1 style="font-size:var(--type-title); font-weight:800; letter-spacing:-1px;">Signage</h1>
    <p style="font-size:var(--type-small); color:#666;">Open every sign type · max site speed 60 kph</p>
  </div>
  <div style="display:flex; flex-direction:column; gap:12px; flex:1;">
{grid}
  </div>
</section>'''


def completion_slide() -> str:
    return '''<section data-label="Completion" style="background:var(--ink); color:#fff; display:flex; flex-direction:column; justify-content:center; align-items:center; padding:0 var(--pad-x); gap:32px; text-align:center;">
  <img src="img/p02-cover.png" style="height:150px;">
  <h1 style="font-size:88px; font-weight:900; letter-spacing:-2px; line-height:1.05;">Induction Complete</h1>
  <p style="font-size:var(--type-body); color:#ccc; max-width:1200px; line-height:1.45;">You have read every module of the Mine Site SME Operating Manual. Your reading is recorded against the assessment — you can now begin.</p>
  <div style="display:flex; gap:20px;">
    <button class="cta" data-action="start" style="background:#EADA23; color:#3C4043; border:0; padding:22px 52px; font-size:28px; font-weight:800; cursor:pointer; border-radius:6px; font-family:'Archivo',sans-serif;">Start Assessment →</button>
    <button class="cta" data-action="menu" style="background:transparent; color:#fff; border:2px solid #555; padding:22px 40px; font-size:24px; font-weight:700; cursor:pointer; border-radius:6px; font-family:'Archivo',sans-serif;">Back to Section Menu</button>
  </div>
</section>'''


REGEN = {2: menu_slide, 6: pmh_slide, 11: radio_slide, 19: signage_slide, 22: horn_slide, 51: completion_slide}


# ── The engine: CSS + vanilla JS, both inlined (no fetch, sandbox-safe) ────────
CSS = r'''
*{box-sizing:border-box;}
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#1D1D1B;}
body{font-family:'Archivo','Arial Narrow','Helvetica Neue',system-ui,sans-serif;}
:root{--red:#3C4043;--ink:#3C4043;--paper:#FFFFFF;--grey:#F4F3F1;--amber:#EADA23;
 --type-title:64px;--type-subtitle:40px;--type-body:32px;--type-small:26px;
 --pad-x:110px;--pad-top:96px;--pad-bottom:84px;--gap-item:24px;--bar-h:78px;}
section h1,section h2,section p,section ul{margin:0;}
a{color:#3C4043;}

#viewport{position:fixed;left:0;right:0;top:0;bottom:var(--bar-h);overflow:hidden;background:var(--ink);}
#canvas{position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform:translate(-50%,-50%) scale(1);transform-origin:center center;}
.slide{position:absolute;inset:0;width:1920px;height:1080px;opacity:0;visibility:hidden;pointer-events:none;}
.slide.active{opacity:1;visibility:visible;pointer-events:auto;}
.slide>section{width:1920px;height:1080px;box-sizing:border-box;overflow:hidden;}
@media (prefers-reduced-motion:no-preference){
 .slide.active.enter{animation:course-in .45s cubic-bezier(.2,.7,.25,1);}
 @keyframes course-in{from{opacity:0;transform:translateX(52px);}to{opacity:1;transform:none;}}
}

/* flip + expander (from the original helmet) */
.flipcard{perspective:1200px;cursor:pointer;}
.flipinner{position:relative;width:100%;height:100%;transform-style:preserve-3d;transition:transform .5s;}
.flipcard.flipped .flipinner{transform:rotateY(180deg);}
.flipface{position:absolute;inset:0;backface-visibility:hidden;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;}
.flipback{transform:rotateY(180deg);}
.flipcard.viewed .flipface{box-shadow:0 0 0 3px rgba(26,122,46,.55);}
.expander{cursor:pointer;transition:background .15s,box-shadow .15s;}
.expander:hover{filter:brightness(0.97);}
.expander.viewed{box-shadow:inset 4px 0 0 #1a7a2e;}
.checkitem{cursor:pointer;display:flex;align-items:flex-start;gap:22px;}
.checkitem .box{flex:none;width:38px;height:38px;border:3px solid var(--amber);border-radius:6px;background:var(--paper);position:relative;transition:background .15s;}
.checkitem:hover .box{filter:brightness(0.96);}
.checkitem.checked .box{background:var(--amber);}
.checkitem.checked .box::after{content:'';position:absolute;left:11px;top:3px;width:9px;height:19px;border:solid var(--ink);border-width:0 4px 4px 0;transform:rotate(45deg);}
.hotspots{position:relative;}
.hotspot{position:absolute;transform:translate(-50%,-50%);width:54px;height:54px;border-radius:50%;border:4px solid var(--amber);background:rgba(20,20,24,.6);color:#fff;font-size:24px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:3;box-shadow:0 0 0 6px color-mix(in srgb, var(--amber) 30%, transparent);animation:hs-pulse 2s infinite;}
@keyframes hs-pulse{0%,100%{box-shadow:0 0 0 6px color-mix(in srgb,var(--amber) 30%,transparent);}50%{box-shadow:0 0 0 13px color-mix(in srgb,var(--amber) 8%,transparent);}}
.hotspot.viewed{border-color:#1a7a2e;background:#1a7a2e;animation:none;box-shadow:0 0 0 4px color-mix(in srgb,#1a7a2e 30%,transparent);}
.hotspot-detail{display:none;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;width:min(720px,80%);max-height:80%;overflow:auto;background:var(--paper);color:var(--ink);border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.45);padding:34px 40px;border-bottom:7px solid var(--amber);}
.hotspot-detail.open{display:block;}
.hotspot-detail h3{font-size:34px;font-weight:800;margin:0 0 16px;}
.hotspot-close{position:absolute;top:12px;right:18px;background:none;border:0;font-size:30px;line-height:1;color:#999;cursor:pointer;}

/* menu part cards */
.part-card{transition:opacity .3s,box-shadow .2s;}
.part-card.avail{cursor:pointer;}
.part-card.avail:hover{box-shadow:0 8px 24px rgba(0,0,0,.13);}
.part-card.locked{opacity:.5;cursor:not-allowed;}

/* nav bar */
#bar{position:fixed;left:0;right:0;bottom:0;height:var(--bar-h);background:#141418;border-top:1px solid #2b2b30;
 display:flex;align-items:center;gap:18px;padding:0 24px;z-index:20;color:#fff;
 font-family:'Archivo','Arial Narrow',system-ui,sans-serif;}
.crumb{font-size:14px;color:#9a9a9a;min-width:210px;white-space:nowrap;letter-spacing:.3px;}
.status{flex:1;display:flex;align-items:center;justify-content:center;gap:11px;font-size:15.5px;color:#cfcfcf;}
.status .tick{display:none;width:26px;height:26px;color:#43c463;}
.status .tick svg{width:100%;height:100%;}
.status .tick path{stroke-dasharray:34;stroke-dashoffset:34;}
.status.done{color:#5fd47a;font-weight:700;}
.status.done .tick{display:inline-flex;animation:tick-pop .34s cubic-bezier(.2,1.5,.4,1) both;}
.status.done .tick path{animation:tick-draw .5s .06s ease forwards;}
@keyframes tick-pop{from{transform:scale(.3);opacity:0;}to{transform:scale(1);opacity:1;}}
@keyframes tick-draw{to{stroke-dashoffset:0;}}
#next{position:relative;overflow:hidden;border:0;border-radius:8px;height:46px;padding:0 28px;min-width:160px;
 font-size:16px;font-weight:800;font-family:inherit;background:#EADA23;color:#1D1D1B;cursor:pointer;
 transition:box-shadow .2s,background .2s,color .2s;}
#next[disabled]{background:#31313a;color:#8a8a92;cursor:default;}
#next.ready{box-shadow:0 0 0 3px rgba(234,218,35,.4);}
#next .fill{position:absolute;left:0;top:0;bottom:0;width:0;background:rgba(255,255,255,.16);pointer-events:none;}
#next .lbl{position:relative;}
'''

JS = r'''
(function(){
'use strict';
var store; try{ window.localStorage.getItem('x'); store=window.localStorage; }
catch(e){ var m={}; store={getItem:function(k){return (k in m)?m[k]:null;},setItem:function(k,v){m[k]=String(v);}}; }
var KEY='sme-course-v3', DW=1920, DH=1080, TOTAL=52;
var PARTS={A:[3,7],B:[8,13],C:[14,19],D:[20,27],E:[28,37],F:[38,50]}, ORDER=['A','B','C','D','E','F'];
function partOf(i){ if(i===0||i===1)return 'intro'; if(i===2)return 'menu'; if(i===51)return 'done';
 for(var k=0;k<ORDER.length;k++){var r=PARTS[ORDER[k]]; if(i>=r[0]&&i<=r[1])return ORDER[k];} return 'intro'; }
var viewport,canvas,slides,crumb,statusEl,msgEl,nextBtn,nextFill,nextLbl;
var completed=new Set(), touched=new Set(), current=0, readTimer=null;

function load(){ try{ var s=JSON.parse(store.getItem(KEY)||'null'); if(s){
 (s.completed||[]).forEach(function(n){completed.add(n);}); (s.touched||[]).forEach(function(t){touched.add(t);});
 if(typeof s.current==='number') current=s.current; } }catch(e){} }
function save(){ try{ store.setItem(KEY, JSON.stringify({completed:Array.from(completed),touched:Array.from(touched),current:current})); }catch(e){} }
function report(i){ try{ window.parent.postMessage({type:'course-slide',index:i,total:TOTAL,skipped:[]},'*'); }catch(e){} }
function startAssessment(){ try{ window.parent.postMessage({type:'course-start-assessment'},'*'); }catch(e){} }

function partComplete(p){ var r=PARTS[p]; for(var i=r[0];i<=r[1];i++) if(!completed.has(i)) return false; return true; }
function unlocked(p){ var i=ORDER.indexOf(p); return i===0 || partComplete(ORDER[i-1]); }
function allDone(){ return ORDER.every(partComplete); }
function cardsOf(sl){ return sl.querySelectorAll('[data-touch]'); }
function cardsDone(sl){ var c=cardsOf(sl); for(var i=0;i<c.length;i++) if(!c[i].classList.contains('viewed')) return false; return true; }
function markComplete(i){ if(!completed.has(i)){ completed.add(i); report(i); save(); } }

function fit(){ var s=Math.min(viewport.clientWidth/DW, viewport.clientHeight/DH); canvas.style.transform='translate(-50%,-50%) scale('+s+')'; }
function tick(on){ statusEl.classList.toggle('done', !!on); }
function setMsg(t){ msgEl.textContent=t; }
function setNext(label, on){ nextLbl.textContent=label; nextBtn.disabled=!on; nextBtn.classList.toggle('ready', !!on); }
function stopFill(){ if(readTimer){clearTimeout(readTimer);readTimer=null;} nextFill.style.transition='none'; nextFill.style.width='0%'; }
function runFill(ms){ nextFill.style.transition='none'; nextFill.style.width='0%'; void nextFill.offsetWidth;
 nextFill.style.transition='width '+ms+'ms linear'; nextFill.style.width='100%'; }
function readingMs(sl){ var w=(sl.textContent||'').trim().split(/\s+/).length; return Math.min(8000, Math.max(2000, w*130)); }

function nextLabel(i){ var p=partOf(i);
 if(p==='intro') return i===0?'Begin →':'Next →';
 if(p==='done') return 'Start Assessment →';
 var r=PARTS[p]; return (i<r[1])?'Next →':('Finish Module '+p+' →'); }
function becomeReady(i){ stopFill(); tick(true); setMsg('Slide complete'); setNext(nextLabel(i), true); }

function reflectCards(sl){ var c=cardsOf(sl), d=0; for(var i=0;i<c.length;i++) if(c[i].classList.contains('viewed')) d++;
 if(d>=c.length){ markComplete(current); becomeReady(current); return; }
 tick(false); setNext('Next →', false); var m;
 if(sl.querySelector('.checkitem')) m='Tick all '+c.length+' boxes to continue — '+d+' of '+c.length+' ticked';
 else if(sl.querySelector('.hotspot')) m='Explore all '+c.length+' points to continue — '+d+' of '+c.length+' explored';
 else m='Open all '+c.length+' cards to continue — '+d+' of '+c.length+' viewed';
 setMsg(m); }

function menuBar(){ crumb.textContent='Section Menu';
 if(allDone()){ nextBtn.style.display=''; tick(true); setMsg('All sections complete'); setNext('Finish →', true); }
 else { nextBtn.style.display='none'; tick(false); setMsg('Choose an unlocked section to begin'); } }

function renderMenu(){ var sl=slides[2], done=0;
 Array.prototype.forEach.call(sl.querySelectorAll('.part-card'), function(card){
  var p=card.getAttribute('data-part'), comp=partComplete(p), unl=unlocked(p); if(comp) done++;
  card.classList.toggle('avail', unl); card.classList.toggle('locked', !unl);
  card.style.borderTopColor = comp?'#1a7a2e':unl?'#3C4043':'#c9c7c3';
  var tag=card.querySelector('.pc-tag'); if(tag) tag.style.color = comp?'#1a7a2e':unl?'#3C4043':'#aaa';
  var tk=card.querySelector('.pc-tick'); if(tk){ tk.textContent=comp?'✓ complete':unl?'start →':'locked'; tk.style.color=comp?'#1a7a2e':unl?'#B26A00':'#aaa'; }
 });
 var mc=sl.querySelector('.menu-count'); if(mc) mc.textContent=done+' of 6 modules complete';
 var mf=sl.querySelector('.menu-fill'); if(mf) mf.style.width=Math.round(done/6*100)+'%';
 var ft=sl.querySelector('.menu-foot'); if(ft) ft.textContent=allDone()?'All modules complete — press Finish to reach the assessment.':'Modules unlock in order — open a module, read every slide and every card, then come back here for the next.'; }

function setExp(card, open){
 var d=card.querySelector('.detail'); if(d) d.style.display = open ? (d.tagName==='P'?'block':'flex') : 'none';
 var cl=card.querySelector('.closed-label'); if(cl){ cl.style.display = open?'none':''; cl.textContent = card.classList.contains('viewed')?'✓ viewed — reopen':'+ Critical controls'; }
 var ch=card.querySelector('.chev'); if(ch) ch.textContent = open?'−':(card.classList.contains('viewed')?'✓':'+'); }

function handleCard(card){ var sl=slides[current];
 if(card.classList.contains('flipcard')){ card.classList.toggle('flipped'); var h=card.querySelector('.rc-hint'); if(h) h.textContent='✓ viewed'; }
 else if(card.classList.contains('expander')){
  var was=card.classList.contains('open');
  if(card.hasAttribute('data-accordion')) Array.prototype.forEach.call(sl.querySelectorAll('.expander.open'), function(x){ x.classList.remove('open'); setExp(x,false); });
  card.classList.toggle('open', !was); card.classList.add('viewed'); setExp(card, !was);
 }
 else if(card.classList.contains('checkitem')){ card.classList.add('checked'); }
 else if(card.classList.contains('hotspot')){
  Array.prototype.forEach.call(sl.querySelectorAll('.hotspot-detail.open'), function(x){ x.classList.remove('open'); });
  var det=sl.querySelector('.hotspot-detail[data-for="'+card.getAttribute('data-touch')+'"]'); if(det) det.classList.add('open');
 }
 card.classList.add('viewed'); touched.add(card.getAttribute('data-touch')); reflectCards(sl); save(); }

function enterSlide(i){ var sl=slides[i], p=partOf(i);
 crumb.textContent = p==='intro'?'Introduction' : p==='menu'?'Section Menu' : p==='done'?'Complete'
   : ('Module '+p+' · slide '+(i-PARTS[p][0]+1)+' of '+(PARTS[p][1]-PARTS[p][0]+1));
 tick(false); stopFill(); nextBtn.style.display='';
 if(p==='menu'){ renderMenu(); markComplete(i); menuBar(); return; }
 // The final slide counts as read on ARRIVAL — reaching it required finishing
 // every part, and its Start Assessment CTA is live at once. Without this a
 // fast click navigates away before this last slide is reported, leaving the
 // host one slide short of complete and the assessment gate shut.
 if(p==='done'){ markComplete(i); becomeReady(i); return; }
 var c=cardsOf(sl);
 if(c.length){
  if(completed.has(i)||cardsDone(sl)){ Array.prototype.forEach.call(c,function(x){x.classList.add('viewed'); if(x.classList.contains('expander')) setExp(x,false); if(x.classList.contains('checkitem')) x.classList.add('checked');}); markComplete(i); becomeReady(i); }
  else { reflectCards(sl); }
 } else {
  if(completed.has(i)){ becomeReady(i); }
  else { setMsg('Read the slide…'); setNext('Next →', false);
   var ms = sl.hasAttribute('data-quick')?1000:readingMs(sl); runFill(ms);
   readTimer=setTimeout(function(){ markComplete(i); becomeReady(i); }, ms); }
 } }

function go(i){ if(i<0)i=0; if(i>=TOTAL)i=TOTAL-1; current=i; save();
 slides.forEach(function(s,idx){ var on=idx===i; s.classList.toggle('active', on);
  if(on){ s.classList.remove('enter'); void s.offsetWidth; s.classList.add('enter'); } });
 enterSlide(i); }

function advance(){ if(nextBtn.disabled) return; var p=partOf(current);
 if(p==='intro'){ go(current+1); return; }
 if(p==='menu'){ if(allDone()) go(51); return; }
 if(p==='done'){ startAssessment(); return; }
 var r=PARTS[p]; if(current<r[1]) go(current+1); else go(2); }
function back(){ if(current>0) go(current-1); }

function bind(){
 nextBtn.addEventListener('click', advance);
 canvas.addEventListener('click', function(e){
  var closer=e.target.closest('.hotspot-close'); if(closer){ Array.prototype.forEach.call(slides[current].querySelectorAll('.hotspot-detail.open'), function(x){ x.classList.remove('open'); }); return; }
  var card=e.target.closest('[data-touch]'); if(card && slides[current].contains(card)){ handleCard(card); return; }
  var pc=e.target.closest('.part-card'); if(pc && current===2){ var p=pc.getAttribute('data-part'); if(unlocked(p)) go(PARTS[p][0]); return; }
  var cta=e.target.closest('[data-action]'); if(cta){ var a=cta.getAttribute('data-action'); if(a==='start') startAssessment(); else if(a==='menu') go(2); return; }
  if(!cardsOf(slides[current]).length && partOf(current)!=='menu' && !nextBtn.disabled) advance();
 });
 document.addEventListener('keydown', function(e){
  if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){ e.preventDefault(); advance(); }
  else if(e.key==='ArrowLeft'||e.key==='PageUp'){ e.preventDefault(); back(); } });
 window.addEventListener('resize', fit);
 window.addEventListener('message', function(e){ var d=e.data;
  if(d && d.type==='course-progress-seed' && Array.isArray(d.visited)){
   d.visited.forEach(function(n){ if(typeof n==='number'&&n>=0&&n<TOTAL) completed.add(n); });
   save(); enterSlide(current); } }); }

function init(){ viewport=document.getElementById('viewport'); canvas=document.getElementById('canvas');
 slides=Array.prototype.slice.call(document.querySelectorAll('.slide'));
 var bar=document.getElementById('bar'); crumb=bar.querySelector('.crumb'); statusEl=bar.querySelector('.status');
 msgEl=statusEl.querySelector('.msg'); nextBtn=document.getElementById('next');
 nextFill=nextBtn.querySelector('.fill'); nextLbl=nextBtn.querySelector('.lbl');
 load(); fit(); bind(); if(current<0||current>=TOTAL) current=0; go(current); }
if(document.readyState!=='loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
'''

PAGE = '''<!doctype html>
<!-- deck-stage: self-contained SME induction slideshow — no external runtime, no fetch (sandbox-safe) -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mine Site SME Operating Manual</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=Archivo+Narrow:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>__CSS__</style>
</head>
<body>
<div id="viewport"><div id="canvas">
__SLIDES__
</div></div>
<div id="bar">
  <span class="crumb"></span>
  <span class="status"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l6 6L20 6"/></svg></span><span class="msg"></span></span>
  <button id="next" disabled><span class="fill"></span><span class="lbl">Next →</span></button>
</div>
<script>__JS__</script>
</body>
</html>'''


IMSMANIFEST = '''<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MINE_SITE_SME_MANUAL_COURSE" version="1.2"
    xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
    xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-SME">
    <organization identifier="ORG-SME">
      <title>Mine Site SME Operating Manual</title>
      <item identifier="ITEM-SME-1" identifierref="RES-SME-1">
        <title>Mine Site SME Operating Manual - Self-paced induction</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-SME-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>
'''


def build() -> None:
    src = SOURCE.read_text(encoding='utf-8')
    imp = src[src.index('<x-import'):src.index('</x-import>')]
    pos = [m.start() for m in re.finditer(r'<section\b', imp)]
    ends = pos[1:] + [len(imp)]
    raw = [imp[a:b].strip() for a, b in zip(pos, ends)]
    assert len(raw) == 52, len(raw)

    quick = {0, 3, 8, 14, 20, 28, 38}
    wrapped = []
    for i in range(52):
        sec = REGEN[i]() if i in REGEN else raw[i]
        if i not in REGEN:
            assert '{{' not in sec and 'sc-for' not in sec and 'sc-if' not in sec, f'binding left in slide {i}'
        q = ' data-quick="1"' if i in quick else ''
        wrapped.append(f'<div class="slide" data-idx="{i}" data-part="{part_of(i)}"{q}>\n{sec}\n</div>')

    page = PAGE.replace('__CSS__', CSS).replace('__JS__', JS).replace('__SLIDES__', '\n'.join(wrapped))
    assert '{{' not in page, 'unresolved binding in final page'

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)
    (OUT_DIR / 'index.html').write_text(page, encoding='utf-8')
    shutil.copytree(HERE / 'img', OUT_DIR / 'img')
    (OUT_DIR / 'imsmanifest.xml').write_text(IMSMANIFEST, encoding='utf-8')

    if ZIP.exists():
        ZIP.unlink()
    with zipfile.ZipFile(ZIP, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(OUT_DIR.rglob('*')):
            if path.is_file():
                zf.write(path, path.relative_to(OUT_DIR).as_posix())
    print(f'wrote {ZIP} ({ZIP.stat().st_size:,} bytes); index.html {len(page):,} bytes')


if __name__ == '__main__':
    build()
