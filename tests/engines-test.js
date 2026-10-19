// The vendored engines are untouched, load in Node and make sound in the way Krill will drive them.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, assert } = require('./harness');

const V = path.join(__dirname, '..', 'vendor');
const { ThroatEngine } = require(path.join(V, 'throat-engine.js'));
const { DolphinEngine } = require(path.join(V, 'dolphin-engine.js'));
const { MouthTube } = require(path.join(V, 'mouth-tube.js'));
const { SyrinxEngine } = require(path.join(V, 'syrinx-engine.js'));
const { BeakTube } = require(path.join(V, 'beak-tube.js'));

const SR = 48000;

function stats(buf) {
  let peak = 0, sum = 0, finite = true;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    if (!Number.isFinite(x)) finite = false;
    const a = Math.abs(x); if (a > peak) peak = a;
    sum += x * x;
  }
  return { peak, rms: Math.sqrt(sum / buf.length), finite };
}

test('vendored files match recorded hashes', () => {
  const want = JSON.parse(fs.readFileSync(path.join(V, 'hashes.json'), 'utf8'));
  for (const f in want) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(V, f))).digest('hex');
    assert.equal(got, want[f], f + ' differs from the copy recorded in vendor/VERSIONS.md');
  }
});

test('Throat renders a mono note', () => {
  const e = new ThroatEngine(SR, 1);
  e.setParam('mode', 0);
  e.noteOn(48, 100);
  const out = new Float32Array(SR / 2);
  for (let i = 0; i < out.length; i += 128) e.process(out.subarray(i, i + 128), Math.min(128, out.length - i));
  const s = stats(out);
  assert.ok(s.finite, 'finite');
  assert.ok(s.rms > 1e-4, 'audible, rms ' + s.rms);
  assert.ok(s.peak < 4, 'sane level, peak ' + s.peak);
});

test('Dolphin renders a mono note', () => {
  const e = new DolphinEngine(SR, 1);
  e.setParam('mode', 0);
  e.noteOn(72, 100);
  const L = new Float32Array(SR / 2), R = new Float32Array(SR / 2);
  for (let i = 0; i < L.length; i += 128) e.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128);
  const s = stats(L);
  assert.ok(s.finite, 'finite');
  assert.ok(s.rms > 1e-4, 'audible, rms ' + s.rms);
});

test('mouth-tube filters Throat on one channel', () => {
  const e = new ThroatEngine(SR, 2), m = new MouthTube(SR);
  e.setParam('mode', 0);
  e.noteOn(48, 100);
  const src = new Float32Array(128), zero = new Float32Array(128), oL = new Float32Array(128), oR = new Float32Array(128);
  const out = new Float32Array(128 * 188);
  for (let i = 0; i < out.length; i += 128) {
    e.process(src, 128);
    m.process(src, zero, oL, oR, 128);
    out.set(oL, i);
  }
  const s = stats(out);
  assert.ok(s.finite, 'finite');
  assert.ok(s.rms > 1e-4, 'audible, rms ' + s.rms);
});

test('Syrinx renders a mono note and follows the bend', () => {
  const e = new SyrinxEngine(SR, 1);
  e.setParam('mode', 0); e.setParam('transpose', 0); e.setParam('bendrange', 48); e.setParam('lock', 1);
  e.noteOn(96, 100);
  const out = new Float32Array(SR / 2);
  for (let i = 0; i < out.length; i += 128) e.process(out.subarray(i, i + 128), null, 128);
  const s = stats(out);
  assert.ok(s.finite, 'finite');
  assert.ok(s.rms > 1e-3, 'audible, rms ' + s.rms);
  assert.ok(s.peak < 1, 'inside the clamp, peak ' + s.peak);
  // pitch from zero crossings, then a bend up an octave
  const hz = buf => { let n = 0; for (let i = 1; i < buf.length; i++) if (buf[i - 1] < 0 && buf[i] >= 0) n++; return n * SR / buf.length; };
  const before = hz(out.subarray(SR / 4));
  e.setBend(12 / 48);
  const up = new Float32Array(SR / 2);
  for (let i = 0; i < up.length; i += 128) e.process(up.subarray(i, i + 128), null, 128);
  const after = hz(up.subarray(SR / 4));
  assert.ok(Math.abs(before / (440 * Math.pow(2, 27 / 12)) - 1) < 0.02, 'note 96 at about 2093 Hz, got ' + before);
  assert.ok(Math.abs(after / before - 2) < 0.04, 'bend +12 doubles the pitch, ' + before + ' → ' + after);
});

test('beak-tube shapes Syrinx on one channel', () => {
  const e = new SyrinxEngine(SR, 2), b = new BeakTube(SR);
  e.setParam('mode', 0); e.setParam('transpose', 0); e.setParam('filter', 0);
  e.noteOn(96, 100);
  const src = new Float32Array(128), o = new Float32Array(128), out = new Float32Array(128 * 188);
  for (let i = 0; i < out.length; i += 128) { e.process(src, null, 128); b.process(src, null, o, null, 128); out.set(o, i); }
  const s = stats(out);
  assert.ok(s.finite, 'finite');
  assert.ok(s.rms > 1e-3, 'audible, rms ' + s.rms);
});

test('engines are deterministic for a seed', () => {
  const render = seed => {
    const e = new ThroatEngine(SR, seed); e.setParam('mode', 0); e.setParam('jitter', 0.5); e.noteOn(50, 100);
    const out = new Float32Array(8192); e.process(out, out.length); return out;
  };
  assert.deepEqual(render(7), render(7));
});
