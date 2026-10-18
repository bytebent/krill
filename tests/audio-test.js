'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert } = require('./harness');
const C = require('../src/creature.js');
const S = require('../src/scales.js');
const R = require('../src/roll.js');
const { Voice } = require('../src/voice.js');
const M = require('../src/mixer.js');
const W = require('../src/wav.js');
const VER = require('../src/version.js');

const SR = 48000;
const FREE = S.makePitch({ mode: 'free' });
const DIR = path.join(__dirname, '..', 'examples', 'creatures');
const example = n => C.normalise(fs.readFileSync(path.join(DIR, n + '.krill-creature.json'), 'utf8')).creature;

// a creature with every range locked at its default, then the given ones
function plain(source, locks) {
  const c = C.normalise({ source, name: 'Probe', ranges: locks || {} }).creature;
  c.manner.level = 0; c.manner.wander = 0; c.manner.pan = 0;
  return c;
}
// one call by hand: units [{t, dur, note, noteEnd}]
function call(cc, units, opt) {
  opt = opt || {};
  const V = cc.V, v = new Float32Array(V);
  for (let j = 0; j < V; j++) v[j] = (cc.vLo[j] + cc.vHi[j]) / 2;
  const us = units.map(u => ({ t: u.t, dur: u.dur, note: u.note, noteEnd: u.noteEnd == null ? u.note : u.noteEnd, v0: v, v1: v }));
  const last = us[us.length - 1];
  const rel = opt.release || 0.05;
  return { t: us[0].t, end: last.t + last.dur, tail: last.t + last.dur + rel, attack: opt.attack || 0.01, release: rel, legato: !!opt.legato, kind: 'fresh', units: us };
}
function renderCalls(creature, calls, seconds) {
  const cc = R.compile(creature, FREE);
  const slot = R.slotInfo(cc);
  const v = new Voice(slot, calls.map(f => f(cc)), { sampleRate: SR, seed: 1, level: 0, pan: 0, wander: 0 });
  const r = new M.Render([v], { sampleRate: SR, frames: Math.round(seconds * SR) });
  const L = new Float32Array(r.frames), Rr = new Float32Array(r.frames);
  r.read(L, Rr, r.frames);
  return { L, R: Rr, voice: v, render: r };
}
// f0 by normalised autocorrelation around time t
function f0At(x, t, fmin, fmax) {
  const N = 4096, s = Math.round(t * SR) - N / 2;
  const lo = Math.floor(SR / fmax), hi = Math.ceil(SR / fmin);
  let best = -1, bl = lo;
  const r = new Float64Array(hi + 2);
  for (let l = lo - 1; l <= hi + 1; l++) {
    let a = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < N; i++) { const p = x[s + i], q = x[s + i + l]; a += p * q; e1 += p * p; e2 += q * q; }
    r[l] = a / Math.sqrt(e1 * e2 + 1e-30);
    if (l >= lo && l <= hi && r[l] > best) { best = r[l]; bl = l; }
  }
  // prefer the shortest lag that is nearly as good (avoid octave errors)
  for (let l = lo; l <= hi; l++) if (r[l] > 0.9 * best && r[l] >= r[l - 1] && r[l] >= r[l + 1]) { bl = l; break; }
  const y0 = r[bl - 1], y1 = r[bl], y2 = r[bl + 1];
  const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
  return SR / (bl + d);
}
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const near = (a, b, pct) => Math.abs(a / b - 1) < pct / 100;

test('version.js engine commits match vendor/VERSIONS.md', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'VERSIONS.md'), 'utf8');
  for (const k in VER.ENGINES) assert.ok(md.includes(VER.ENGINES[k]), k);
});

test('Throat plays the score\'s pitch, cents included', () => {
  const c = plain('throat');
  for (const note of [45, 57, 57.5, 64.27]) {
    const { L } = renderCalls(c, [cc => call(cc, [{ t: 0.1, dur: 1, note }])], 1.3);
    const f = f0At(L, 0.7, 60, 1000);
    assert.ok(near(f, mtof(note), 0.3), note + ': ' + f.toFixed(2) + ' Hz, want ' + mtof(note).toFixed(2));
  }
});

test('a long Throat contour re-bases the held note without a jump', () => {
  const c = plain('throat');
  const { L } = renderCalls(c, [cc => call(cc, [{ t: 0.1, dur: 3, note: 40, noteEnd: 76 }])], 3.4);
  let prev = 0;
  for (let t = 0.3; t <= 3.0; t += 0.1) {
    const f = f0At(L, t, 60, 1200);
    const want = mtof(40 + 36 * (s => s * s * (3 - 2 * s))((t - 0.1) / 3));
    assert.ok(near(f, want, 2.5), 't ' + t.toFixed(1) + ': ' + f.toFixed(1) + ' Hz, want ' + want.toFixed(1));
    assert.ok(f >= prev * 0.995, 'pitch went down at ' + t.toFixed(1));
    prev = f;
  }
});

test('Dolphin whistle follows the note and the bend contour', () => {
  // register 1 = whistle only; size 1 = whistle at the note (no octave lift); one partial
  const c = plain('dolphin', { 'dolphin.register': 1, 'dolphin.size': 1, 'dolphin.harmonics': 0, 'dolphin.shape': 0, 'dolphin.biphon': 0 });
  const { L } = renderCalls(c, [cc => call(cc, [{ t: 0.1, dur: 1.2, note: 69 }]), cc => call(cc, [{ t: 1.6, dur: 1.5, note: 69, noteEnd: 81 }])], 3.3);
  assert.ok(near(f0At(L, 0.8, 100, 3000), 440, 0.3), 'steady');
  assert.ok(near(f0At(L, 3.02, 100, 3000), 880, 1.5), 'end of contour');
});

test('legato and separate units both reach the next unit\'s pitch', () => {
  const c = plain('throat');
  const two = legato => cc => call(cc, [{ t: 0.1, dur: 0.6, note: 57 }, { t: 0.7, dur: 0.6, note: 64 }], { legato, release: 0.2 });
  const a = renderCalls(c, [two(true)], 1.6).L, b = renderCalls(c, [two(false)], 1.6).L;
  const rms = (x, t0, t1) => { let s = 0; for (let i = Math.round(t0 * SR); i < t1 * SR; i++) s += x[i] * x[i]; return Math.sqrt(s / ((t1 - t0) * SR)); };
  // around the join the separate version dips (release then attack), the legato one doesn't
  assert.ok(rms(a, 0.69, 0.72) > 0.5 * rms(a, 0.5, 0.6), 'legato holds level');
  assert.ok(near(f0At(a, 1.0, 60, 1000), mtof(64), 0.5), 'second legato unit pitch');
  assert.ok(near(f0At(b, 1.0, 60, 1000), mtof(64), 0.5), 'second separate unit pitch');
});

test('chunk size never changes the output', () => {
  const c = example('ticker');
  const run = chunk => {
    const job = M.soloRender(c, { seed: 3, seconds: 25, pitch: { mode: 'key', root: 'D', scale: 'minor' } });
    const L = new Float32Array(job.render.frames), Rr = new Float32Array(job.render.frames);
    const tl = new Float32Array(chunk), tr = new Float32Array(chunk);
    let p = 0;
    while (!job.render.done) { const n = job.render.read(tl, tr, chunk); L.set(tl.subarray(0, n), p); Rr.set(tr.subarray(0, n), p); p += n; }
    assert.equal(p, job.render.frames);
    return [L, Rr];
  };
  const a = run(32), b = run(4801), d = run(1);
  assert.deepEqual(a[0], b[0]); assert.deepEqual(a[1], b[1]); assert.deepEqual(a[0], d[0]);
});

test('same seed renders the same audio; rests are digital silence and cost nothing', () => {
  const c = example('glassfin');
  const go = () => {
    const job = M.soloRender(c, { seed: 8, seconds: 40, pitch: { mode: 'key', root: 'D', scale: 'minor' } });
    const L = new Float32Array(job.render.frames), Rr = new Float32Array(job.render.frames);
    job.render.read(L, Rr, job.render.frames);
    return { L, job };
  };
  const a = go(), b = go();
  assert.deepEqual(a.L, b.L);
  const calls = a.job.score.calls;
  assert.ok(calls.length >= 2);
  // the stretch between a call's tail (plus pad and fades aside) and the next call is exactly zero
  const from = Math.ceil((calls[0].tail + 0.8) * SR), to = Math.floor(calls[1].t * SR) - 64;
  if (to > from) for (let i = from; i < to; i++) assert.equal(a.L[i], 0, 'sample ' + i);
  assert.ok(a.job.render.stats().awake[0] < 0.8);
});

test('limiter: loud input never passes the ceiling, quiet input is untouched', () => {
  const fake = amp => ({ phase: 0, block(b, L, Rr) { for (let i = 0; i < 32; i++) { const s = amp * Math.sin(this.phase += 0.05); L[i] += s; Rr[i] += s * 0.5; } return true; } });
  const loud = new M.Render([fake(4)], { sampleRate: SR, frames: SR });
  const L = new Float32Array(SR), Rr = new Float32Array(SR);
  loud.read(L, Rr, SR);
  let pk = 0; for (let i = 0; i < SR; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(Rr[i]));
  assert.ok(pk <= Math.pow(10, -1 / 20) + 1e-6, 'peak ' + pk);
  assert.ok(pk > 0.8, 'not over-limited ' + pk);
  const quiet = new M.Render([fake(0.1)], { sampleRate: SR, frames: 4800 });
  const q = new Float32Array(4800), qr = new Float32Array(4800);
  quiet.read(q, qr, 4800);
  let ph = 0;
  for (let i = 0; i < 4800; i++) assert.ok(Math.abs(q[i] - 0.1 * Math.sin(ph += 0.05)) < 1e-6, 'sample ' + i);
});

test('fades start and end the piece at silence', () => {
  const fake = { block(b, L, Rr) { L.fill(0.5); Rr.fill(0.5); return true; } };
  const r = new M.Render([fake], { sampleRate: SR, frames: SR, fadeIn: 0.1, fadeOut: 0.2 });
  const L = new Float32Array(SR), Rr = new Float32Array(SR);
  r.read(L, Rr, SR);
  assert.equal(L[0], 0);
  assert.ok(Math.abs(L[SR - 1]) < 1e-9);
  assert.ok(Math.abs(L[SR / 2] - 0.5) < 1e-6);
  assert.ok(L[2400] > 0.2 && L[2400] < 0.3, 'half way into the fade in');
});

test('WAV: header, sizes, metadata, 16-bit dither is repeatable', () => {
  for (const bits of [16, 24]) {
    const make = () => {
      const sink = W.memorySink();
      const w = new W.WavWriter(sink, { sampleRate: SR, bits, seed: 5, title: 'odd', comment: 'krill test', meta: { seed: 5, note: 'é' } });
      const L = new Float32Array(1001).map((_, i) => Math.sin(i / 10) * 0.5), Rr = L.map(x => -x);
      w.write(L, Rr, 1001); w.write(L, Rr, 10);
      w.finish();
      return sink.bytes();
    };
    const a = make(), b = make();
    assert.deepEqual(a, b);
    const p = W.parse(a);
    assert.equal(p.format, 1); assert.equal(p.channels, 2); assert.equal(p.sampleRate, SR); assert.equal(p.bits, bits);
    assert.equal(p.frames, 1011);
    assert.equal(p.riffSize, a.length - 8);
    assert.deepEqual(p.meta, { seed: 5, note: 'é' });
    assert.ok(p.chunks.LIST);
  }
});

test('a solo render carries what made it', () => {
  const job = M.soloRender(example('moanback'), { seed: 21, seconds: 2, pitch: { mode: 'free' } });
  assert.equal(job.fileName, 'krill_moanback_21_2s.wav');
  assert.equal(job.meta.seed, 21);
  assert.equal(job.meta.creature.name, 'Moanback');
  assert.deepEqual(job.meta.engines, VER.ENGINES);
  assert.equal(M.fileName('X', 4, 1200), 'krill_x_4_20m.wav');
});

test('every example keeps at least 6 dB of headroom inside its engine', () => {
  for (const n of ['glassfin', 'moanback', 'ticker', 'wicklace']) {
    const job = M.soloRender(example(n), { seed: 2, seconds: 90, pitch: { mode: 'key', root: 'D', scale: 'minor' } });
    const L = new Float32Array(4800), Rr = new Float32Array(4800);
    while (!job.render.done) job.render.read(L, Rr, 4800);
    const st = job.render.stats();
    assert.ok(st.enginePeakDb[0] < -6, n + ' engine peak ' + st.enginePeakDb[0].toFixed(1) + ' dB');
  }
});

test('species calibration: Level 0 is about -20 dBFS RMS while calling, for all four', () => {
  for (const source of C.SOURCES) for (const body of C.BODIES) {
    const c = C.defaults(source, body, { seed: 3 });
    c.manner.level = 0; c.manner.pan = 0; c.manner.wander = 0;
    const job = M.soloRender(c, { seed: 3, seconds: 60, pitch: { mode: 'free' }, fadeIn: 0, fadeOut: 0, level: -30 });
    job.render.lim.ceil = 0;
    const L = new Float32Array(4800), Rr = new Float32Array(4800);
    let e = 0, n = 0;
    while (!job.render.done) {
      const k = job.render.read(L, Rr, 4800);
      for (let i = 0; i < k; i++) { const x = (L[i] + Rr[i]) * Math.SQRT1_2; if (x !== 0) { e += x * x; n++; } }
    }
    const rms = 10 * Math.log10(e / n) + 30;
    assert.ok(Math.abs(rms + 20) < 5, source + '+' + body + ' ' + rms.toFixed(1) + ' dB');
  }
});

test('low-pass: off costs nothing and changes nothing; on cuts the highs at 24 dB/oct', () => {
  const c = plain('throat', { 'throat.breathy': 0.6, 'throat.thin': 1 });
  const go = filter => { const k = JSON.parse(JSON.stringify(c)); k.filter = filter; return renderCalls(k, [cc => call(cc, [{ t: 0.1, dur: 1, note: 57 }])], 1.2); };
  const off = go({ on: false, cutoff: 1000 }), base = go({ on: false, cutoff: 8000 }), on = go({ on: true, cutoff: 1000 });
  assert.deepEqual(off.L, base.L, 'off: cutoff is ignored');
  assert.equal(off.voice.lp, null, 'off: no filter object at all');
  // energy around 4 kHz (two octaves above the cutoff) should drop by about 48 dB
  const band = x => { const P = require('../src/preview.js').spectrogram(x, x, SR); let e = 0, n = 0;
    const k0 = Math.round(3500 / (SR / 1024)), k1 = Math.round(4500 / (SR / 1024));
    for (let c2 = 20; c2 < P.cols - 20; c2++) for (let k = k0; k <= k1; k++) { e += P.data[c2 * P.bins + k]; n++; } return e / n; };
  assert.ok(band(on.L) < band(off.L) - 60, 'highs reduced: ' + band(on.L).toFixed(0) + ' vs ' + band(off.L).toFixed(0) + ' (bytes, 60 dB window)');
  const low = x => { let s = 0; for (let i = 0.3 * SR; i < 1.0 * SR; i++) s += x[i] * x[i]; return s; };
  assert.ok(low(on.L) > 0.2 * low(off.L), 'the voice itself is still there');
  const coef = require('../src/voice.js').lowpass(1000, Math.SQRT1_2, SR);
  assert.ok(Math.abs((coef[0] + coef[1] + coef[2]) / (1 + coef[3] + coef[4]) - 1) < 1e-9, 'unity gain at DC');
});
