'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert } = require('./harness');
const C = require('../src/creature.js');
const P = require('../src/preview.js');
const W = require('../src/wav.js');
const { PAGES } = require('../tools/build-pages.js');

const ROOT = path.join(__dirname, '..');
const example = n => C.normalise(fs.readFileSync(path.join(ROOT, 'examples', 'creatures', n + '.krill-creature.json'), 'utf8')).creature;
const DMIN = { mode: 'key', root: 'D', scale: 'minor' };

test('built pages are up to date (run node tools/build-pages.js)', () => {
  for (const out in PAGES) {
    const want = PAGES[out]();
    const got = fs.readFileSync(path.join(ROOT, out), 'utf8');
    assert.ok(got === want, out + ' is stale');
    // inlined code can't end the script element early
    const id = want.includes('id="worker-src">') ? 'id="worker-src">' : 'id="worklet-src">';
    const worker = want.slice(want.indexOf(id), want.indexOf('</script>', want.indexOf(id)));
    assert.ok(worker.length > 100000, out + ': worker code is inlined');
    assert.ok(!/<\/script/i.test(worker.slice(20)), 'no </script inside the worker source');
  }
});

test('a previewed call is repeatable and carries what the LCD needs', () => {
  const c = example('ticker');
  const a = P.previewCall(c, { pitch: DMIN, seed: 4 }), b = P.previewCall(c, { pitch: DMIN, seed: 4 });
  assert.deepEqual(a.L, b.L);
  assert.equal(a.L.length, Math.ceil((a.call.tail + 0.9) * 48000));
  assert.ok(a.call.units.length >= c.call.units[0]);
  const m = a.call.units[0].body;
  assert.equal(a.call.bodyView, 'tube');
  assert.ok(m && m.start && m.end, 'body shape per unit');
  for (const id of ['tongueX', 'tongueY', 'jaw', 'lips', 'round', 'nasal']) assert.ok(m.start[id] >= 0 && m.start[id] <= 1, id);
  assert.ok(m.start.length >= c.ranges['tube.length'][0] && m.start.length <= c.ranges['tube.length'][1], 'tube length in cm inside its range');
  assert.notDeepEqual(P.previewCall(c, { pitch: DMIN, seed: 5 }).L, a.L);
  const bare = P.previewCall(example('glassfin'), { pitch: DMIN, seed: 1 });
  assert.equal(bare.call.units[0].body, null);
  assert.equal(bare.call.bodyView, null);
});

test('the Signature button plays the signature, the same shape for any seed when variation is 0', () => {
  const c = example('glassfin');
  c.signature.variation = 0;
  const a = P.previewCall(c, { pitch: DMIN, seed: 1, kind: 'signature' }), b = P.previewCall(c, { pitch: DMIN, seed: 9, kind: 'signature' });
  assert.equal(a.call.kind, 'signature');
  assert.deepEqual(a.call.units.map(u => u.dur), b.call.units.map(u => u.dur));
});

test('spectrogram: size, range, and a tone lands in its bin', () => {
  const sr = 48000, n = sr, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.5 * Math.sin(2 * Math.PI * 1500 * i / sr);
  const sp = P.spectrogram(L, L, sr);
  assert.equal(sp.bins, Math.floor(10000 / (sr / 1024)));
  assert.equal(sp.cols, Math.floor((n - 1024) / 256) + 1);
  const col = sp.data.subarray(10 * sp.bins, 11 * sp.bins);
  let best = 0; for (let k = 1; k < sp.bins; k++) if (col[k] > col[best]) best = k;
  assert.equal(best, Math.round(1500 / (sr / 1024)));
  assert.equal(col[best], 255);
  assert.ok(Math.abs(sp.topDb - 20 * Math.log10(0.5)) < 1, 'top level ' + sp.topDb);
});

test('Render 60 s solo produces a complete WAV', () => {
  let calls = 0;
  const r = P.soloWav(example('wicklace'), { seed: 3, seconds: 10, pitch: DMIN, bits: 16 }, () => calls++);
  const w = W.parse(r.bytes);
  assert.equal(w.frames, 480000);
  assert.equal(w.bits, 16);
  assert.equal(w.meta.creature.name, 'Wicklace');
  assert.ok(calls > 5, 'progress reported');
  assert.equal(r.fileName, 'krill_wicklace_3_10s.wav');
});

test('the pond page preview renders a pond (or its first minutes) to WAV', () => {
  const PD = require('../src/pond.js');
  const p = PD.normalise(fs.readFileSync(path.join(ROOT, 'examples', 'ponds', 'first-pond.krill-pond.json'), 'utf8')).pond;
  let n = 0;
  const r = P.pondWav(p, { seconds: 12 }, () => n++);
  const w = W.parse(r.bytes);
  assert.equal(w.frames, 12 * 48000);
  assert.equal(w.bits, p.output.bits);
  assert.equal(w.meta.kind, 'pond');
  assert.equal(w.meta.seconds, 12);
  assert.ok(n > 10, 'progress');
});
