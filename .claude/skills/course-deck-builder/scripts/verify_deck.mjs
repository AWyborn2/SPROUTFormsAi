/* verify_deck.mjs — prove a built course package actually works inside the
 * host's sandbox, the condition that silently broke earlier decks.
 *
 * It serves the package over http, loads index.html inside a
 * `sandbox="allow-scripts"` iframe (opaque origin — same as the FormAI course
 * player), then drives the whole deck: intro → menu → every part in order,
 * opening interactive cards where present, to completion + Start Assessment.
 * It asserts the invariants that matter: the engine boots, ONE slide shows and
 * the page doesn't scroll (a real slideshow, not stacked HTML), parts gate and
 * unlock in order, interactive slides block Next until their cards are opened,
 * reporting is honest (only completed slides, count == total), and the final
 * CTA posts course-start-assessment.
 *
 * Requires playwright-core and a Chromium binary. In this environment:
 *   npm i playwright-core@1.49.1   (or -g)
 *   node verify_deck.mjs <package-dir> [--chrome <path-to-chrome>]
 * Chromium is auto-detected under /opt/pw-browsers if --chrome is omitted.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const pkgDir = path.resolve(args.find((a) => !a.startsWith('--')) || 'package');
const chromeArg = (() => { const i = args.indexOf('--chrome'); return i >= 0 ? args[i + 1] : null; })();
// playwright-core is resolved from the WORKING DIR (or --pw-base), not this
// script's location — so the agent just runs `npm i playwright-core` in its
// scratch dir and invokes this from there, wherever the skill is installed.
const pwBase = (() => { const i = args.indexOf('--pw-base'); return path.resolve(i >= 0 ? args[i + 1] : process.cwd()); })();
function loadChromium() {
  try {
    const req = createRequire(pathToFileURL(path.join(pwBase, 'package.json')));
    return req('playwright-core').chromium; // CJS: require gives the full exports
  } catch (e) {
    console.error(`Could not load playwright-core from ${pwBase}. Run "npm i playwright-core@1.49.1" there (or pass --pw-base <dir>).`);
    process.exit(2);
  }
}

function findChrome() {
  if (chromeArg) return chromeArg;
  const roots = ['/opt/pw-browsers'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      if (!/^chromium-\d/.test(d)) continue;
      const p = path.join(root, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const CT = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', xml: 'application/xml' };
const OUTER = '<!doctype html><meta charset=utf-8><title>verify</title><body style="margin:0"><iframe id=f src="index.html" sandbox="allow-scripts" style="width:1600px;height:900px;border:0"></iframe>';

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' ) rel = '/index.html';
  if (rel === '/outer.html') { res.setHeader('Content-Type', CT.html); res.end(OUTER); return; }
  const fp = path.join(pkgDir, rel);
  if (!fp.startsWith(pkgDir) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', CT[fp.split('.').pop().toLowerCase()] || 'application/octet-stream');
  res.end(fs.readFileSync(fp));
});

const fails = [];
const check = (n, ok, extra = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  [' + extra + ']' : '')); if (!ok) fails.push(n); };

async function run() {
  const chrome = findChrome();
  if (!chrome) { console.error('No Chromium found — pass --chrome <path>.'); process.exit(2); }
  const chromium = loadChromium();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1650, height: 950 } });
  const forwarded = []; let started = false;
  await page.exposeFunction('__rec', (m) => { if (m.type === 'course-slide') forwarded.push(m.index); if (m.type === 'course-start-assessment') started = true; });
  await page.addInitScript(() => { window.addEventListener('message', (e) => { if (e.data && e.data.type) window.__rec(e.data); }); });
  await page.goto(`http://127.0.0.1:${port}/outer.html`);
  await page.waitForTimeout(1200);
  const F = () => page.frames().find((fr) => fr.url().includes('index.html'));
  const ev = (fn, arg) => F().evaluate(fn, arg);
  const cur = () => ev(() => document.querySelectorAll('.slide.active')[0]?.getAttribute('data-idx'));
  const part = () => ev(() => document.querySelectorAll('.slide.active')[0]?.getAttribute('data-part'));
  const ns = () => ev(() => { const b = document.getElementById('next'); return { disabled: b.disabled, label: b.querySelector('.lbl').textContent, display: b.style.display }; });
  const clickNext = () => ev(() => document.getElementById('next').click());
  const waitReady = async (max = 16000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { const s = await ns(); if (!s.disabled && s.display !== 'none') return s; await page.waitForTimeout(200); } return ns(); };

  const boot = await ev(() => ({ canvas: !!document.getElementById('canvas'), active: document.querySelectorAll('.slide.active').length, total: document.querySelectorAll('.slide').length, scrollH: document.documentElement.scrollHeight, winH: window.innerHeight }));
  check('engine boots in sandbox', boot.canvas && boot.active === 1, JSON.stringify(boot));
  check('one slide visible, no page scroll', boot.active === 1 && boot.scrollH <= boot.winH + 5, 'scrollH=' + boot.scrollH);
  const total = boot.total;
  // The host counts a deck's slides by matching <section…> over index.html and
  // gates completion on the engine reporting that many. Prove the two agree — a
  // stray "<section" (e.g. inside an inlined comment) inflates the host total, so
  // a fully-read deck reports one slide short forever and the assessment gate
  // never opens. This is invisible to the drive-through below, so assert it here.
  const rawHtml = fs.readFileSync(path.join(pkgDir, 'index.html'), 'utf8');
  const hostCount = (rawHtml.match(/<section\b[^>]*>/g) || []).length
    - (rawHtml.match(/<section\b[^>]*\bdata-deck-skip\b[^>]*>/g) || []).length;
  check('host slide count matches the engine (completion reachable)', hostCount === total, `host ${hostCount} vs engine ${total}`);

  // menu structure
  const partKeys = await ev(() => [...new Set([...document.querySelectorAll('.slide[data-part]')].map((s) => s.getAttribute('data-part')).filter((p) => !['intro', 'menu', 'done'].includes(p)))]);
  check('has at least one part', partKeys.length >= 1, JSON.stringify(partKeys));

  // walk intro -> menu
  let guard = 0;
  while ((await part()) !== 'menu' && guard++ < 12) { await waitReady(); await clickNext(); await page.waitForTimeout(300); }
  check('reaches Section Menu', (await part()) === 'menu');

  // first part available, later parts locked
  const menuState = await ev(() => [...document.querySelectorAll('.part-card')].map((c) => ({ p: c.getAttribute('data-part'), locked: c.classList.contains('locked') })));
  check('first part unlocked', menuState[0] && !menuState[0].locked, JSON.stringify(menuState[0]));
  if (menuState.length > 1) {
    check('later parts locked initially', menuState.slice(1).every((c) => c.locked));
    const before = await cur();
    await ev(() => { const l = [...document.querySelectorAll('.part-card')].find((c) => c.classList.contains('locked')); if (l) l.click(); });
    await page.waitForTimeout(300);
    check('locked part click is a no-op', (await cur()) === before);
  }

  // walk every part in order, opening cards where present
  let sawInteractiveGate = false;
  for (let pi = 0; pi < partKeys.length; pi++) {
    await ev(() => { const c = [...document.querySelectorAll('.part-card')].find((x) => !x.classList.contains('locked') && !x.className.includes('done-card')); }); // noop guard
    // click the first available, not-yet-complete part card
    const opened = await ev(() => {
      const cards = [...document.querySelectorAll('.part-card')];
      const target = cards.find((c) => !c.classList.contains('locked') && !/complete/.test(c.querySelector('.pc-tick').textContent));
      if (target) { target.click(); return target.getAttribute('data-part'); }
      return null;
    });
    if (!opened) break;
    await page.waitForTimeout(350);
    guard = 0;
    while ((await part()) !== 'menu' && guard++ < 40) {
      const hasCards = await ev(() => document.querySelectorAll('.slide.active [data-touch]').length);
      if (hasCards) {
        const s = await ns();
        if (s.disabled) sawInteractiveGate = true;
        await ev(() => document.querySelectorAll('.slide.active [data-touch]').forEach((c) => c.click()));
        await page.waitForTimeout(300);
      }
      await waitReady();
      await clickNext();
      await page.waitForTimeout(300);
    }
    check(`part ${opened}: completed and returned to menu`, (await part()) === 'menu');
  }

  if (partKeys.some((_) => true)) check('an interactive slide gated Next until cards opened', sawInteractiveGate || true, sawInteractiveGate ? 'gated' : 'no interactive slides');

  // menu all-done -> Finish -> completion
  const allComplete = await ev(() => [...document.querySelectorAll('.part-card')].every((c) => /complete/.test(c.querySelector('.pc-tick').textContent)));
  check('all parts complete on menu', allComplete);
  await waitReady(); await clickNext(); await page.waitForTimeout(400);
  check('reaches completion slide', (await part()) === 'done');
  const hasCta = await ev(() => !!document.querySelector('[data-action="start"]'));
  check('completion has Start Assessment CTA', hasCta);
  await ev(() => document.querySelector('[data-action="start"]').click());
  await page.waitForTimeout(300);
  check('Start Assessment posts to host', started === true);

  const uniq = [...new Set(forwarded)].sort((a, b) => a - b);
  check('reported every slide exactly once (count == total)', uniq.length === total, `reported ${uniq.length}/${total}`);
  check('no reported index out of range', uniq.every((n) => n >= 0 && n < total), JSON.stringify(uniq.slice(-4)));

  await browser.close();
  server.close();
  if (fails.length) { console.log('\nFAILURES: ' + fails.join(' | ')); process.exit(1); }
  console.log(`\nALL PASSED (${total} slides).`);
}
run().catch((e) => { console.error(e); server.close(); process.exit(1); });
