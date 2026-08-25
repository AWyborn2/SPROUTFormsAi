/* course-deck-builder engine — a self-contained vanilla slideshow.
 *
 * WHY VANILLA / NO FETCH: the host runs this package in a
 * `sandbox="allow-scripts"` iframe whose origin is opaque ("null"). Any
 * fetch() to the package's own files is CORS-blocked from that origin, so a
 * runtime that boots by fetching its component (React/Claude-Design decks do)
 * silently fails and the slides render as stacked scrolling HTML. Everything
 * here is inline and driven off the DOM, so it works inside the sandbox.
 *
 * STRUCTURE IS READ FROM THE DOM, not hardcoded:
 *   .slide[data-idx][data-part]  — one wrapper per slide.
 *     data-part: 'intro' | 'menu' | 'done' | a part key ('A','B',…).
 *     data-quick: present → short reading beat (dividers/title).
 *   [data-touch] inside a slide  — an interactive card; the slide's Next
 *     unlocks only once every such card is opened.
 *   .part-card[data-part="X"] inside the menu slide — one per part.
 * Part ranges and order are derived from the data-part sequence, so the same
 * engine drives any deck the packager assembles.
 *
 * HOST BRIDGE (postMessage to parent):
 *   out {type:'course-slide', index, total}   — a slide was completed (read).
 *       Only completed slides are reported, so a blocked jump never counts.
 *   out {type:'course-start-assessment'}       — the final CTA was pressed.
 *   in  {type:'course-progress-seed', visited:[…]} — resume: mark these done.
 */
(function () {
  'use strict';
  var store;
  try { window.localStorage.getItem('x'); store = window.localStorage; }
  catch (e) { var m = {}; store = { getItem: function (k) { return (k in m) ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); } }; }
  var KEY = (window.__courseKey || 'course-deck') + '-progress';

  var viewport, canvas, slides, crumb, statusEl, msgEl, nextBtn, nextFill, nextLbl;
  var TOTAL = 0, PARTS = {}, ORDER = [];
  var completed = new Set(), touched = new Set(), current = 0, readTimer = null;

  function partOf(i) { return slides[i].getAttribute('data-part') || 'intro'; }
  function derive() {
    // PARTS[key] = [firstIdx, lastIdx] in DOM order; ORDER = first-seen order.
    slides.forEach(function (s, i) {
      var p = s.getAttribute('data-part');
      if (p === 'intro' || p === 'menu' || p === 'done') return;
      if (!PARTS[p]) { PARTS[p] = [i, i]; ORDER.push(p); }
      else PARTS[p][1] = i;
    });
  }
  function menuIdx() { for (var i = 0; i < TOTAL; i++) if (partOf(i) === 'menu') return i; return -1; }
  function doneIdx() { for (var i = 0; i < TOTAL; i++) if (partOf(i) === 'done') return i; return TOTAL - 1; }

  function load() { try { var s = JSON.parse(store.getItem(KEY) || 'null'); if (s) { (s.completed || []).forEach(function (n) { completed.add(n); }); (s.touched || []).forEach(function (t) { touched.add(t); }); if (typeof s.current === 'number') current = s.current; } } catch (e) {} }
  function save() { try { store.setItem(KEY, JSON.stringify({ completed: Array.from(completed), touched: Array.from(touched), current: current })); } catch (e) {} }
  function report(i) { try { window.parent.postMessage({ type: 'course-slide', index: i, total: TOTAL, skipped: [] }, '*'); } catch (e) {} }
  function startAssessment() { try { window.parent.postMessage({ type: 'course-start-assessment' }, '*'); } catch (e) {} }

  function partComplete(p) { var r = PARTS[p]; for (var i = r[0]; i <= r[1]; i++) if (!completed.has(i)) return false; return true; }
  function unlocked(p) { var i = ORDER.indexOf(p); return i === 0 || partComplete(ORDER[i - 1]); }
  function allDone() { return ORDER.every(partComplete); }
  function cardsOf(sl) { return sl.querySelectorAll('[data-touch]'); }
  function cardsDone(sl) { var c = cardsOf(sl); for (var i = 0; i < c.length; i++) if (!c[i].classList.contains('viewed')) return false; return true; }
  function markComplete(i) { if (!completed.has(i)) { completed.add(i); report(i); save(); } }

  function fit() { var s = Math.min(viewport.clientWidth / 1920, viewport.clientHeight / 1080); canvas.style.transform = 'translate(-50%,-50%) scale(' + s + ')'; }
  function tick(on) { statusEl.classList.toggle('done', !!on); }
  function setMsg(t) { msgEl.textContent = t; }
  function setNext(label, on) { nextLbl.textContent = label; nextBtn.disabled = !on; nextBtn.classList.toggle('ready', !!on); }
  function stopFill() { if (readTimer) { clearTimeout(readTimer); readTimer = null; } nextFill.style.transition = 'none'; nextFill.style.width = '0%'; }
  function runFill(ms) { nextFill.style.transition = 'none'; nextFill.style.width = '0%'; void nextFill.offsetWidth; nextFill.style.transition = 'width ' + ms + 'ms linear'; nextFill.style.width = '100%'; }
  function readingMs(sl) { var w = (sl.textContent || '').trim().split(/\s+/).length; return Math.min(8000, Math.max(2000, w * 130)); }

  function nextLabel(i) {
    var p = partOf(i);
    if (p === 'intro') return i === 0 ? 'Begin →' : 'Next →';
    if (p === 'done') return 'Start Assessment →';
    var r = PARTS[p];
    return (i < r[1]) ? 'Next →' : ('Finish Part ' + p + ' →');
  }
  function becomeReady(i) { stopFill(); tick(true); setMsg('Slide complete'); setNext(nextLabel(i), true); }

  function reflectCards(sl) {
    var c = cardsOf(sl), d = 0; for (var i = 0; i < c.length; i++) if (c[i].classList.contains('viewed')) d++;
    if (d >= c.length) { markComplete(current); becomeReady(current); return; }
    tick(false); setNext('Next →', false);
    // Phrase the gate for the card type on this slide: a checklist "ticks
    // boxes", hotspots "explore points", the flip/expander decks "open cards".
    var msg;
    if (sl.querySelector('.checkitem')) msg = 'Tick all ' + c.length + ' boxes to continue — ' + d + ' of ' + c.length + ' ticked';
    else if (sl.querySelector('.hotspot')) msg = 'Explore all ' + c.length + ' points to continue — ' + d + ' of ' + c.length + ' explored';
    else msg = 'Open all ' + c.length + ' cards to continue — ' + d + ' of ' + c.length + ' viewed';
    setMsg(msg);
  }
  function menuBar() {
    crumb.textContent = 'Section Menu';
    if (allDone()) { nextBtn.style.display = ''; tick(true); setMsg('All sections complete'); setNext('Finish →', true); }
    else { nextBtn.style.display = 'none'; tick(false); setMsg('Choose an unlocked section to begin'); }
  }
  function renderMenu() {
    var sl = slides[menuIdx()], done = 0;
    Array.prototype.forEach.call(sl.querySelectorAll('.part-card'), function (card) {
      var p = card.getAttribute('data-part'), comp = partComplete(p), unl = unlocked(p); if (comp) done++;
      card.classList.toggle('avail', unl); card.classList.toggle('locked', !unl);
      card.style.borderTopColor = comp ? 'var(--good)' : unl ? 'var(--ink)' : '#c9c7c3';
      var tag = card.querySelector('.pc-tag'); if (tag) tag.style.color = comp ? 'var(--good)' : unl ? 'var(--ink)' : '#aaa';
      var tk = card.querySelector('.pc-tick'); if (tk) { tk.textContent = comp ? '✓ complete' : unl ? 'start →' : 'locked'; tk.style.color = comp ? 'var(--good)' : unl ? '#B26A00' : '#aaa'; }
    });
    var mc = sl.querySelector('.menu-count'); if (mc) mc.textContent = done + ' of ' + ORDER.length + ' parts complete';
    var mf = sl.querySelector('.menu-fill'); if (mf) mf.style.width = Math.round(done / ORDER.length * 100) + '%';
    var ft = sl.querySelector('.menu-foot'); if (ft) ft.textContent = allDone() ? 'All sections complete — press Finish to reach the assessment.' : 'Parts unlock in order — open a section, read every slide and every card, then come back here for the next.';
  }

  function setExp(card, open) {
    var d = card.querySelector('.detail'); if (d) d.style.display = open ? (d.tagName === 'P' ? 'block' : 'flex') : 'none';
    var cl = card.querySelector('.closed-label'); if (cl) { cl.style.display = open ? 'none' : ''; cl.textContent = card.classList.contains('viewed') ? (cl.getAttribute('data-seen') || '✓ viewed — reopen') : (cl.getAttribute('data-shut') || cl.textContent); }
    var ch = card.querySelector('.chev'); if (ch) ch.textContent = open ? '−' : (card.classList.contains('viewed') ? '✓' : '+');
  }
  function handleCard(card) {
    var sl = slides[current];
    if (card.classList.contains('flipcard')) { card.classList.toggle('flipped'); var h = card.querySelector('.rc-hint'); if (h) h.textContent = '✓ viewed'; }
    else if (card.classList.contains('expander')) {
      var was = card.classList.contains('open');
      if (card.hasAttribute('data-accordion')) Array.prototype.forEach.call(sl.querySelectorAll('.expander.open'), function (x) { x.classList.remove('open'); setExp(x, false); });
      card.classList.toggle('open', !was); card.classList.add('viewed'); setExp(card, !was);
    }
    // checkbox: a one-way acknowledgement — ticking it is the "click to
    // continue" the checklist gate waits on. Left checked so the visual always
    // matches the gate (no half-done state to puzzle over).
    else if (card.classList.contains('checkitem')) { card.classList.add('checked'); }
    // hotspot: a numbered marker over an image; clicking opens its detail
    // popover (one at a time) and counts the marker as explored.
    else if (card.classList.contains('hotspot')) {
      Array.prototype.forEach.call(sl.querySelectorAll('.hotspot-detail.open'), function (x) { x.classList.remove('open'); });
      var det = sl.querySelector('.hotspot-detail[data-for="' + card.getAttribute('data-touch') + '"]');
      if (det) det.classList.add('open');
    }
    card.classList.add('viewed'); touched.add(card.getAttribute('data-touch')); reflectCards(sl); save();
  }

  function enterSlide(i) {
    var sl = slides[i], p = partOf(i);
    crumb.textContent = p === 'intro' ? 'Introduction' : p === 'menu' ? 'Section Menu' : p === 'done' ? 'Complete'
      : ('Part ' + p + ' · slide ' + (i - PARTS[p][0] + 1) + ' of ' + (PARTS[p][1] - PARTS[p][0] + 1));
    tick(false); stopFill(); nextBtn.style.display = '';
    if (p === 'menu') { renderMenu(); markComplete(i); menuBar(); return; }
    // The final slide counts as read on ARRIVAL, not after a reading beat:
    // reaching it already required finishing every part, and its CTA is live
    // immediately — so a fast click on Start Assessment must not navigate away
    // before this last slide is reported, which would leave the host one slide
    // short of complete and keep the assessment gate shut.
    if (p === 'done') { markComplete(i); becomeReady(i); return; }
    var c = cardsOf(sl);
    if (c.length) {
      if (completed.has(i) || cardsDone(sl)) { Array.prototype.forEach.call(c, function (x) { x.classList.add('viewed'); if (x.classList.contains('expander')) setExp(x, false); if (x.classList.contains('checkitem')) x.classList.add('checked'); }); markComplete(i); becomeReady(i); }
      else { reflectCards(sl); }
    } else {
      if (completed.has(i)) { becomeReady(i); }
      else { setMsg('Read the slide…'); setNext('Next →', false); var ms = sl.hasAttribute('data-quick') ? 1000 : readingMs(sl); runFill(ms); readTimer = setTimeout(function () { markComplete(i); becomeReady(i); }, ms); }
    }
  }
  function go(i) {
    if (i < 0) i = 0; if (i >= TOTAL) i = TOTAL - 1; current = i; save();
    slides.forEach(function (s, idx) { var on = idx === i; s.classList.toggle('active', on); if (on) { s.classList.remove('enter'); void s.offsetWidth; s.classList.add('enter'); } });
    enterSlide(i);
  }
  function advance() {
    if (nextBtn.disabled) return; var p = partOf(current);
    if (p === 'intro') { go(current + 1); return; }
    if (p === 'menu') { if (allDone()) go(doneIdx()); return; }
    if (p === 'done') { startAssessment(); return; }
    var r = PARTS[p]; if (current < r[1]) go(current + 1); else go(menuIdx());
  }
  function back() { if (current > 0) go(current - 1); }

  function bind() {
    nextBtn.addEventListener('click', advance);
    canvas.addEventListener('click', function (e) {
      // close a hotspot popover (X button or a click on the detail's own
      // backdrop) without counting as a new interaction
      var closer = e.target.closest('.hotspot-close');
      if (closer) { Array.prototype.forEach.call(slides[current].querySelectorAll('.hotspot-detail.open'), function (x) { x.classList.remove('open'); }); return; }
      var card = e.target.closest('[data-touch]'); if (card && slides[current].contains(card)) { handleCard(card); return; }
      var pc = e.target.closest('.part-card'); if (pc && partOf(current) === 'menu') { var p = pc.getAttribute('data-part'); if (unlocked(p)) go(PARTS[p][0]); return; }
      var cta = e.target.closest('[data-action]'); if (cta) { var a = cta.getAttribute('data-action'); if (a === 'start') startAssessment(); else if (a === 'menu') go(menuIdx()); return; }
      if (!cardsOf(slides[current]).length && partOf(current) !== 'menu' && !nextBtn.disabled) advance();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); advance(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); back(); }
    });
    window.addEventListener('resize', fit);
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (d && d.type === 'course-progress-seed' && Array.isArray(d.visited)) {
        d.visited.forEach(function (n) { if (typeof n === 'number' && n >= 0 && n < TOTAL) completed.add(n); });
        save(); enterSlide(current);
      }
    });
  }
  function init() {
    viewport = document.getElementById('viewport'); canvas = document.getElementById('canvas');
    slides = Array.prototype.slice.call(document.querySelectorAll('.slide')); TOTAL = slides.length;
    var bar = document.getElementById('bar'); crumb = bar.querySelector('.crumb'); statusEl = bar.querySelector('.status');
    msgEl = statusEl.querySelector('.msg'); nextBtn = document.getElementById('next');
    nextFill = nextBtn.querySelector('.fill'); nextLbl = nextBtn.querySelector('.lbl');
    derive(); load(); fit(); bind(); if (current < 0 || current >= TOTAL) current = 0; go(current);
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
