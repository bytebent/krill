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
  ok('the loudness range moves its low end', loud[1] === 0 && loud[0] < -15, JSON.stringify(loud));
  const hb = await pp.locator('.slot').nth(4).locator('.h.hi').boundingBox();
  await pp.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await pp.mouse.down(); await pp.mouse.move(lb.x + lb.width * 0.5, lb.y + lb.height / 2, { steps: 5 }); await pp.mouse.up();
  const loud2 = await pp.evaluate(() => window.krillPond.pond.slots[4].loudness);
  ok('the top end moves down too and stays at or below 0', loud2[1] < -6 && loud2[1] <= 0 && loud2[0] <= loud2[1] && loud2[0] === loud[0], JSON.stringify(loud2));
  const sides = await pp.evaluate(() => { const P = window.krillPond.pond, sc = window.krillPond.score;
    const v = sc.calls.map(c => window.Krill.pan.slotPanAt(P, c.slot, sc.slots[c.slot], c.t, c.lean)); return [Math.min(...v), Math.max(...v)]; });
  ok('the pan strip spreads calls to both sides', sides[0] < -0.3 && sides[1] > 0.3, sides.map(x => x.toFixed(2)).join(' … '));
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
  ok('Preview renders and loads the player', await pp.evaluate(() => !document.getElementById('player').hidden && !!document.getElementById('audio').src), ((Date.now() - t2) / 1000).toFixed(1) + ' s for 30 s');
  const [pw] = await Promise.all([pp.waitForEvent('download'), pp.click('#dl')]);
  const pwav = W.parse(new Uint8Array(fs.readFileSync(await pw.path())));
  ok('Download WAV gives the preview', pwav.frames === 30 * 48000 && pwav.meta && pwav.meta.kind === 'pond' && pwav.meta.seed === 4242, pw.suggestedFilename());
  const [pd] = await Promise.all([pp.waitForEvent('download'), pp.click('#save')]);
  const back2 = require('../src/pond.js').normalise(fs.readFileSync(await pd.path(), 'utf8'));
  ok('Save downloads a pond that loads back cleanly', back2.warnings.length === 0 && back2.pond.seed === 4242 && back2.pond.slots[0].ignore && back2.pond.slots[1].rerolls === 1, pd.suggestedFilename());
  // Export, streaming (the save dialog is stood in for by a fake writable that collects the bytes)
  await pp.evaluate(() => {
    window.__exp = { parts: [], closed: false };
    window.showSaveFilePicker = async o => { window.__exp.name = o.suggestedName; return { createWritable: async () => ({
      write: async d => { if (d instanceof Uint8Array) window.__exp.parts.push(d.slice()); else window.__exp.header = { position: d.position, data: d.data.slice() }; },
      close: async () => { window.__exp.closed = true; }, abort: async () => {} }) }; };
  });
  await pp.click('#export');
  ok('Export opens the sheet with the length, fades and bits', await pp.evaluate(() => !document.getElementById('exportSheet').hidden && document.querySelectorAll('#exLenSeg button').length === 6 && document.querySelectorAll('#exOut .dial').length === 2 && /written to disk/.test(document.getElementById('exNote').textContent)));
  await pp.click('#exLenSeg >> text=20');
  ok('a length preset sets the pond length', await pp.evaluate(() => window.krillPond.pond.output.minutes === 20 && document.getElementById('minutes').value === '20' && /krill_4242_20m\.wav/.test(document.getElementById('exNote').textContent)));
  await pp.fill('#exMin', '0.5'); await pp.press('#exMin', 'Enter');
  const t3 = Date.now();
  const [pf] = await Promise.all([pp.waitForEvent('download'), pp.click('#exGo')]);
  await pp.waitForFunction(() => /Exported/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  const st = await pp.evaluate(() => {
    const e = window.__exp, n = e.parts.reduce((a, x) => a + x.length, 0), u = new Uint8Array(n); let o = 0;
    for (const x of e.parts) { u.set(x, o); o += x.length; }
    u.set(e.header.data, e.header.position);
    const w = window.Krill.wav.parse(u); let h = 0; for (let i = 0; i < u.length; i += 7) h = (h * 31 + u[i]) >>> 0;
    return { name: e.name, closed: e.closed, n, riff: w.riffSize, frames: w.frames, seconds: w.meta && w.meta.seconds, hidden: document.getElementById('exportSheet').hidden, h };
  });
  ok('Export streams a complete WAV to the file', st.closed && st.frames === 30 * 48000 && st.riff === st.n - 8 && st.seconds === 30 && st.name === 'krill_4242_30s.wav' && st.hidden, st.name + ', ' + ((Date.now() - t3) / 1000).toFixed(1) + ' s');
  const pfp = require('../src/pond.js').normalise(fs.readFileSync(await pf.path(), 'utf8'));
  ok('the pond file is saved alongside, with the export\'s length', pf.suggestedFilename() === 'krill_4242_30s.krill-pond.json' && pfp.warnings.length === 0 && pfp.pond.output.minutes === 0.5, pf.suggestedFilename());

  // Export in memory (browsers without the save dialog), and a krill WAV opens its pond
  const pm = await browser.newPage({ viewport: { width: 1180, height: 900 }, acceptDownloads: true });
  pm.on('pageerror', e => perr.push(String(e)));
  await pm.addInitScript(() => { delete window.showSaveFilePicker; delete Window.prototype.showSaveFilePicker; });
  await pm.goto('file://' + path.join(ROOT, 'pages', 'pond.html'));
  await pm.waitForFunction(() => window.krillPond && window.krillPond.score);
  await pm.evaluate(() => window.krillPond.load(window.KRILL_POND_EXAMPLE));
  await pm.click('#export');
  await pm.click('#exLenSeg >> text=60');
  ok('without the save dialog, past 30 min it shows the Node command instead', await pm.evaluate(() => document.getElementById('exGo').disabled && /node tools\/render\.js krill_7_60m\.krill-pond\.json/.test(document.getElementById('exNote').textContent)));
  await pm.fill('#exMin', '0.5'); await pm.press('#exMin', 'Enter');
  await pm.locator('#exPond').uncheck();
  const [mw] = await Promise.all([pm.waitForEvent('download'), pm.click('#exGo')]);
  const mbytes = new Uint8Array(fs.readFileSync(await mw.path())), mwav = W.parse(mbytes);
  ok('in memory it downloads a complete WAV', mwav.frames === 30 * 48000 && mwav.riffSize === mbytes.length - 8 && mwav.meta.pond.seed === 7, mw.suggestedFilename());
  await pm.evaluate(() => window.krillPond.load(Object.assign({}, window.KRILL_POND_EXAMPLE, { seed: 99 })));
  await pm.setInputFiles('#file', await mw.path());
  await pm.waitForFunction(() => /Opened the pond/.test(document.getElementById('status').textContent));
  ok('a krill WAV opens the pond it was made from', await pm.evaluate(() => window.krillPond.pond.seed === 7 && window.krillPond.pond.output.minutes === 0.5 && window.krillPond.pond.slots.filter(Boolean).length === 4));
  await pm.close();
  const shot = await pp.evaluate(() => { const u = document.getElementById('exGo'); return !!u; });
  await pp.fill('#minutes', '30'); await pp.press('#minutes', 'Enter'); await pp.locator('#minutes').blur();
  ok('long pieces preview their first 10 minutes', shot && await pp.evaluate(() => /first 10 min/.test(document.getElementById('render').textContent)));
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
