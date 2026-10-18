#!/usr/bin/env node
// Drives pages/creature.html in headless Chromium like a user would, and fails on any problem.
// Needs Playwright: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/check-pages.js [--shots dir]
'use strict';
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const W = require('../src/wav.js');
const C = require('../src/creature.js');

const ROOT = path.join(__dirname, '..');
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
const url = 'file://' + path.join(ROOT, 'pages', 'creature.html');
const results = [];
const ok = (name, cond, info) => { results.push({ name, ok: !!cond, info }); console.log((cond ? '  ok   ' : '  FAIL ') + name + (info ? '  (' + info + ')' : '')); };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.krillPage && window.krillPage.creature);
  ok('page loads with a creature', true, await page.evaluate(() => window.krillPage.creature.name));
  const counts = await page.evaluate(() => ({ ranges: document.querySelectorAll('.rng').length, knobs: document.querySelectorAll('.knob').length }));
  ok('controls are built', counts.ranges > 20 && counts.knobs >= 10, counts.ranges + ' ranges, ' + counts.knobs + ' knobs');

  // Call: renders in the worker and fills the LCD
  const t0 = Date.now();
  await page.click('#call');
  await page.waitForFunction(() => window.krillPage.last && /rendered/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const last = await page.evaluate(() => ({ units: window.krillPage.last.call.units.length, secs: window.krillPage.last.seconds, kind: window.krillPage.last.call.kind, status: document.getElementById('status').textContent }));
  ok('Call renders and plays', last.units > 0 && last.secs > 0, last.status + ', ' + (Date.now() - t0) + ' ms round trip');
  const lit = await page.evaluate(() => { const c = document.getElementById('spec'), g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, Math.floor(c.height * 0.8)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n / (d.length / 4); });
  ok('spectrogram shows the call', lit > 0.005, (lit * 100).toFixed(1) + '% of pixels lit');
  if (SHOTS) {
    await page.addStyleTag({ content: '.actions{position:static}' });   // a full-page shot shouldn\'t catch the sticky bar mid-page
    await page.screenshot({ path: path.join(SHOTS, '05-creature-page.png'), fullPage: true });
    await page.addStyleTag({ content: '.actions{position:sticky}' });
  }

  // examples: every one loads, Throat + tube shows a tube, bare shows pitch
  const exNames = await page.evaluate(() => (window.KRILL_EXAMPLES || []).map(e => e.name));
  ok('examples are built in', exNames.length === 4, exNames.join(', '));
  for (const n of exNames) {
    await page.click('#examples');
    await page.click('#exMenu .it:has-text("' + n + '")');
    const nm = await page.evaluate(() => window.krillPage.creature.name);
    if (nm !== n) { ok('example ' + n + ' loads', false, nm); continue; }
    await page.click('#call');
    await page.waitForFunction(() => /rendered/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    const view = await page.evaluate(() => document.getElementById('tubeLbl').textContent);
    const mouth = await page.evaluate(() => window.krillPage.creature.mouth);
    ok('example ' + n + ' calls', view === (mouth ? 'TUBE' : 'PITCH'), view);
    if (SHOTS && n === 'Moanback') await page.locator('.screen').screenshot({ path: path.join(SHOTS, '05-lcd-moanback.png') });
    if (SHOTS && n === 'Ticker') await page.locator('.mouthwrap').screenshot({ path: path.join(SHOTS, '05-mouth-ticker.png') });
    await page.click('#status');      // closes the menu if it stayed open
  }

  // editing: a range drag changes the creature, double-click locks, the dirty mark shows
  const before = await page.evaluate(() => JSON.stringify(window.krillPage.creature.ranges));
  const track = page.locator('#g-source .rng .track').first();
  await track.evaluate(e => e.scrollIntoView({ block: 'center' }));      // clear of the sticky action bar
  const box = await track.boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
  const after = await page.evaluate(() => JSON.stringify(window.krillPage.creature.ranges));
  ok('dragging a range edits the creature', before !== after);
  ok('changed creature is marked', await page.evaluate(() => !document.getElementById('dirty').hidden));
  await page.locator('#g-source .rng').first().dblclick();
  const lockedRow = await page.evaluate(() => document.querySelector('#g-source .rng').classList.contains('locked'));
  ok('double-click locks a range', lockedRow);

  // vowel pad: drawing a region writes both tongue ranges
  await page.evaluate(() => window.krillPage.load(window.KRILL_EXAMPLES.find(e => e.name === 'Moanback')));
  await page.locator('#pad').evaluate(e => e.scrollIntoView({ block: 'center' }));
  const pb = await page.locator('#pad').boundingBox();
  await page.mouse.move(pb.x + pb.width * 0.3, pb.y + pb.height * 0.3);
  await page.mouse.down(); await page.mouse.move(pb.x + pb.width * 0.6, pb.y + pb.height * 0.7, { steps: 6 }); await page.mouse.up();
  const tg = await page.evaluate(() => [window.krillPage.creature.ranges['mouth.tongueX'], window.krillPage.creature.ranges['mouth.tongueY']]);
  ok('drawing on the vowel pad sets the tongue region', tg[0][1] > tg[0][0] && tg[1][1] > tg[1][0], JSON.stringify(tg));

  // species switches: dolphin and no mouth
  await page.click('#g-species .seg >> text=Dolphin');
  await page.click('#g-species .seg >> text=Off');
  const sp = await page.evaluate(() => ({ s: window.krillPage.creature.source, m: window.krillPage.creature.mouth, title: document.getElementById('srcTitle').textContent, dis: document.getElementById('fsMouth').disabled, note: document.getElementById('pitchNote').textContent }));
  ok('switching species rebuilds the source panel', sp.s === 'dolphin' && !sp.m && sp.title === 'Dolphin' && sp.dis, sp.note);

  // Signature and free mode
  await page.selectOption('#scale', 'whole tone');
  await page.click('#keyBox .seg >> text=Free');
  await page.click('#sig');
  await page.waitForFunction(() => /rendered/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  ok('Signature renders in free mode', await page.evaluate(() => window.krillPage.last.call.kind === 'signature' && window.krillPage.last.pitch === 'FREE'));

  // Save: the downloaded file loads back as the same creature
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
  const saved = fs.readFileSync(await dl.path(), 'utf8');
  const back = C.normalise(saved);
  ok('Save downloads a valid creature file', back.warnings.length === 0 && back.creature.source === 'dolphin', dl.suggestedFilename());

  // Render 60 s solo: a real WAV comes down
  const t1 = Date.now();
  const [wavDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#solo')]);
  const wav = W.parse(new Uint8Array(fs.readFileSync(await wavDl.path())));
  ok('Render 60 s solo downloads a WAV', wav.frames === 60 * 48000 && wav.bits === 24 && wav.meta && wav.meta.seconds === 60, wavDl.suggestedFilename() + ', ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s');

  // the page remembers the creature across reloads
  await page.reload();
  await page.waitForFunction(() => window.krillPage && window.krillPage.creature);
  ok('the creature survives a reload', await page.evaluate(() => window.krillPage.creature.source === 'dolphin' && !window.krillPage.creature.mouth));

  // phone width: no horizontal scroll
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('no horizontal scroll at phone width', overflow <= 0, overflow + ' px');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '05-creature-phone.png'), fullPage: false });

  ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
