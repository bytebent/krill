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
  ok('examples are built in', exNames.length === 5, exNames.join(', '));
  for (const n of exNames) {
    await page.click('#examples');
    await page.click('#exMenu .it:has-text("' + n + '")');
    const nm = await page.evaluate(() => window.krillPage.creature.name);
    if (nm !== n) { ok('example ' + n + ' loads', false, nm); continue; }
    await page.click('#call');
    await page.waitForFunction(() => /rendered/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    const view = await page.evaluate(() => document.getElementById('tubeLbl').textContent);
    const body = await page.evaluate(() => window.krillPage.creature.body);
    ok('example ' + n + ' calls', view === (body === 'tube' ? 'TUBE' : 'PITCH'), view);
    if (SHOTS && n === 'Siltclicker') await page.locator('.screen').screenshot({ path: path.join(SHOTS, '05-lcd-siltclicker.png') });
    if (SHOTS && n === 'Ticker') await page.locator('.bodywrap').screenshot({ path: path.join(SHOTS, '05-mouth-ticker.png') });
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
  await page.evaluate(() => window.krillPage.load(window.KRILL_EXAMPLES.find(e => e.name === 'Siltclicker')));
  await page.locator('#pad').evaluate(e => e.scrollIntoView({ block: 'center' }));
  const pb = await page.locator('#pad').boundingBox();
  await page.mouse.move(pb.x + pb.width * 0.3, pb.y + pb.height * 0.3);
  await page.mouse.down(); await page.mouse.move(pb.x + pb.width * 0.6, pb.y + pb.height * 0.7, { steps: 6 }); await page.mouse.up();
  const tg = await page.evaluate(() => [window.krillPage.creature.ranges['tube.tongueX'], window.krillPage.creature.ranges['tube.tongueY']]);
  ok('drawing on the vowel pad sets the tongue region', tg[0][1] > tg[0][0] && tg[1][1] > tg[1][0], JSON.stringify(tg));

  // species switches: dolphin and no mouth
  await page.click('#g-species .seg >> text=Dolphin');
  await page.click('#g-species .seg >> text=None');
  const sp = await page.evaluate(() => ({ s: window.krillPage.creature.source, b: window.krillPage.creature.body, title: document.getElementById('srcTitle').textContent, pad: document.getElementById('padBox').hidden, bodyRanges: document.querySelectorAll('#g-body .rng').length, note: document.getElementById('pitchNote').textContent }));
  ok('switching source and body rebuilds their panels', sp.s === 'dolphin' && sp.b === 'none' && sp.title === 'Dolphin' && sp.pad && sp.bodyRanges === 0, sp.note);

  // low-pass: on, cutoff knob by keyboard, saved with the creature
  await page.click('#g-out .seg >> text=On');
  await page.locator('#g-out .dial').focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
  const flt = await page.evaluate(() => window.krillPage.creature.filter);
  ok('low-pass switch and cutoff edit the creature', flt.on && flt.cutoff < 8000, JSON.stringify(flt));

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
  ok('Save downloads a valid creature file', back.warnings.length === 0 && back.creature.source === 'dolphin' && back.creature.filter.on && back.creature.version === 2, dl.suggestedFilename());

  // Render 60 s solo: a real WAV comes down
  const t1 = Date.now();
  const [wavDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#solo')]);
  const wav = W.parse(new Uint8Array(fs.readFileSync(await wavDl.path())));
  ok('Render 60 s solo downloads a WAV', wav.frames === 60 * 48000 && wav.bits === 24 && wav.meta && wav.meta.seconds === 60, wavDl.suggestedFilename() + ', ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s');

  // the page remembers the creature across reloads
  await page.reload();
  await page.waitForFunction(() => window.krillPage && window.krillPage.creature);
  ok('the creature survives a reload', await page.evaluate(() => window.krillPage.creature.source === 'dolphin' && window.krillPage.creature.body === 'none' && window.krillPage.creature.filter.on));

  // an old (version 1) file still loads
  await page.evaluate(() => window.krillPage.load({ format: 'krill-creature', version: 1, name: 'Old', source: 'throat', mouth: true, ranges: { 'mouth.jaw': [0.2, 0.4] } }));
  ok('a version 1 creature migrates on load', await page.evaluate(() => window.krillPage.creature.body === 'tube' && !document.getElementById('padBox').hidden && document.querySelectorAll('#g-body .rng').length === 9));

  ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ---------------- pond page ----------------
  console.log('\npond.html');
  const pp = await browser.newPage({ viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  const perr = [];
  pp.on('console', m => { if (m.type() === 'error') perr.push(m.text()); });
  pp.on('pageerror', e => perr.push(String(e)));
  await pp.goto('file://' + path.join(ROOT, 'pages', 'pond.html'));
  await pp.waitForFunction(() => window.krillPond && window.krillPond.score);
  await pp.evaluate(() => window.krillPond.load(window.KRILL_POND_EXAMPLE));
  const p0 = await pp.evaluate(() => ({ calls: window.krillPond.score.calls.length, slots: document.querySelectorAll('.slot:not(.empty)').length, empty: document.querySelectorAll('.slot.empty').length }));
  ok('pond page loads the example pond and scores it', p0.calls > 50 && p0.slots === 4 && p0.empty === 2, p0.calls + ' calls');
  const lit2 = await pp.evaluate(() => { const c = document.getElementById('sketch'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 150) n++; return n / (d.length / 4); });
  ok('the sketch is drawn', lit2 > 0.02, (lit2 * 100).toFixed(1) + '% lit');
  if (SHOTS) {
    await pp.addStyleTag({ content: '.actions{position:static}' });
    await pp.screenshot({ path: path.join(SHOTS, '08-pond-page.png'), fullPage: true });
    await pp.addStyleTag({ content: '.actions{position:sticky}' });
  }
  const sig = () => pp.evaluate(() => JSON.stringify(window.krillPond.score.calls.map(c => [c.slot, +c.t.toFixed(3)])));
  const s0 = await sig();
  await pp.fill('#seed', '4242'); await pp.press('#seed', 'Enter'); await pp.locator('#seed').blur();
  await pp.waitForTimeout(300);
  ok('a new seed rescores the sketch', (await sig()) !== s0 && await pp.evaluate(() => window.krillPond.pond.seed === 4242));
  const s1 = await sig();
  await pp.locator('.slot').nth(1).locator('button[title^="Re-roll"]').click();
  await pp.waitForTimeout(300);
  ok('re-roll changes the score and counts', (await sig()) !== s1 && await pp.evaluate(() => window.krillPond.pond.slots[1].rerolls === 1));
  await pp.locator('.slot').nth(0).locator('.seg >> text=Ignores').click();
  await pp.waitForTimeout(300);
  ok('Ignores takes a lane out of the conversation', await pp.evaluate(() => window.krillPond.pond.slots[0].ignore && window.krillPond.score.calls.filter(c => c.slot === 0).every(c => c.depth === 0)));
  await pp.locator('.slot').nth(4).locator('select').selectOption({ label: 'Siltclicker' });
  await pp.waitForTimeout(300);
  ok('adding a creature to an empty slot', await pp.evaluate(() => window.krillPond.pond.slots[4] && window.krillPond.pond.slots[4].creature.name === 'Siltclicker' && window.krillPond.score.calls.some(c => c.slot === 4)));
  const lt = pp.locator('.slot').nth(4).locator('.track');
  await lt.evaluate(e => e.scrollIntoView({ block: 'center' }));
  const lb = await lt.boundingBox();
  await pp.mouse.move(lb.x + lb.width * 0.75, lb.y + lb.height / 2); await pp.mouse.down(); await pp.mouse.move(lb.x + 3, lb.y + lb.height / 2, { steps: 5 }); await pp.mouse.up();
  const loud = await pp.evaluate(() => window.krillPond.pond.slots[4].loudness);
  ok('the loudness range moves its low end and keeps the top at 0', loud[1] === 0 && loud[0] < -15, JSON.stringify(loud));
  await pp.locator('.slot').nth(4).locator('button[title^="Remove"]').click();
  ok('removing a creature empties the slot', await pp.evaluate(() => window.krillPond.pond.slots[4] === null));
  await pp.click('#g-pitch .seg >> text=On');
  await pp.waitForTimeout(300);
  ok('Harmonise switches on', await pp.evaluate(() => window.krillPond.pond.pitch.harmonise && /HARMONISE/.test(document.getElementById('ro').textContent)));
  // render a short preview and get it back as a WAV
  await pp.fill('#minutes', '0.5'); await pp.press('#minutes', 'Enter'); await pp.locator('#minutes').blur();
  const t2 = Date.now();
  await pp.click('#render');
  await pp.waitForFunction(() => /Rendered/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  ok('Render preview renders and loads the player', await pp.evaluate(() => !document.getElementById('player').hidden && !!document.getElementById('audio').src), ((Date.now() - t2) / 1000).toFixed(1) + ' s for 30 s');
  const [pw] = await Promise.all([pp.waitForEvent('download'), pp.click('#dl')]);
  const pwav = W.parse(new Uint8Array(fs.readFileSync(await pw.path())));
  ok('Download WAV gives the preview', pwav.frames === 30 * 48000 && pwav.meta && pwav.meta.kind === 'pond' && pwav.meta.seed === 4242, pw.suggestedFilename());
  const [pd] = await Promise.all([pp.waitForEvent('download'), pp.click('#save')]);
  const back2 = require('../src/pond.js').normalise(fs.readFileSync(await pd.path(), 'utf8'));
  ok('Save downloads a pond that loads back cleanly', back2.warnings.length === 0 && back2.pond.seed === 4242 && back2.pond.slots[0].ignore && back2.pond.slots[1].rerolls === 1, pd.suggestedFilename());
  await pp.fill('#minutes', '30'); await pp.press('#minutes', 'Enter'); await pp.locator('#minutes').blur();
  ok('long pieces show the Node command', await pp.evaluate(() => !document.getElementById('longNote').hidden && /first 10 min/.test(document.getElementById('render').textContent)));
  await pp.reload();
  await pp.waitForFunction(() => window.krillPond && window.krillPond.score);
  ok('the pond survives a reload', await pp.evaluate(() => window.krillPond.pond.seed === 4242 && window.krillPond.pond.output.minutes === 30));
  // Edit opens the creature on the creature page
  await pp.locator('.slot').nth(2).locator('button[title^="Open"]').click();
  await pp.waitForFunction(() => window.krillPage && window.krillPage.creature);
  ok('Edit opens that creature on the creature page', await pp.evaluate(() => window.krillPage.creature.name === 'Ticker'));
  ok('no console errors on the pond page', perr.length === 0, perr.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
