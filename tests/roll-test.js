'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert } = require('./harness');
const C = require('../src/creature.js');
const S = require('../src/scales.js');
const R = require('../src/roll.js');
const { Rng } = require('../src/rng.js');

const DIR = path.join(__dirname, '..', 'examples', 'creatures');
const EXAMPLES = fs.readdirSync(DIR).filter(f => f.endsWith('.krill-creature.json'))
  .map(f => C.normalise(fs.readFileSync(path.join(DIR, f), 'utf8')).creature);
const byName = n => JSON.parse(JSON.stringify(EXAMPLES.find(c => c.name === n)));
const DMIN = S.makePitch({ mode: 'key', root: 'D', scale: 'minor' });
const FREE = S.makePitch({ mode: 'free' });
const EPS = 1e-4;

function eachUnit(score, fn) { for (const c of score.calls) for (const u of c.units) fn(u, c); }

test('same seed gives the same score; another seed differs', () => {
  for (const c of EXAMPLES) {
    const a = R.scoreToJSON(R.soloScore(c, { seed: 11, seconds: 600, pitch: DMIN }));
    const b = R.scoreToJSON(R.soloScore(c, { seed: 11, seconds: 600, pitch: DMIN }));
    const d = R.scoreToJSON(R.soloScore(c, { seed: 12, seconds: 600, pitch: DMIN }));
    assert.equal(a, b, c.name);
    assert.notEqual(a, d, c.name);
  }
});

test('every value stays inside the creature\'s ranges', () => {
  for (const c of EXAMPLES) for (const pitch of [DMIN, FREE]) {
    const sc = R.soloScore(c, { seed: 5, seconds: 1800, pitch });
    const cc = R.compile(c, pitch);
    const snapped = new Set(['dolphin.rate', 'dolphin.freerate', 'dolphin.wtranspose', 'dolphin.sweep']);
    const [u0, u1] = c.call.units, [l0, l1] = c.call.unitLength;
    let prevEnd = null;
    for (const call of sc.calls) {
      assert.ok(call.units.length >= u0 && call.units.length <= u1, c.name + ' unit count ' + call.units.length);
      assert.ok(call.attack >= c.call.attack[0] - EPS && call.attack <= c.call.attack[1] + EPS);
      assert.ok(call.release >= c.call.release[0] - EPS && call.release <= c.call.release[1] + EPS);
      if (prevEnd !== null) {
        const rest = call.t - prevEnd;
        assert.ok(rest >= c.call.rest[0] - EPS && rest <= c.call.rest[1] + EPS, c.name + ' rest ' + rest);
      }
      prevEnd = call.end;
      call.units.forEach((u, i) => {
        assert.ok(u.dur >= l0 - EPS && u.dur <= l1 + EPS, c.name + ' dur ' + u.dur);
        if (i > 0) {
          const p = call.units[i - 1], gap = u.t - (p.t + p.dur);
          if (c.call.legato) assert.ok(Math.abs(gap) < EPS, 'legato gap');
          else assert.ok(gap >= c.call.gap[0] - EPS && gap <= c.call.gap[1] + EPS, c.name + ' gap ' + gap);
        }
        assert.ok(u.note >= c.pitch.low - EPS && u.note <= c.pitch.high + EPS, c.name + ' anchor ' + u.note);
        for (let j = 0; j < cc.V; j++) {
          const s = cc.vSpec[j];
          for (const v of [u.v0[j], u.v1[j]]) {
            if (snapped.has(s.key) && !pitch.free) assert.ok(v >= s.min - EPS && v <= s.max + EPS, s.key);
            else assert.ok(v >= cc.vLo[j] - EPS && v <= cc.vHi[j] + EPS, c.name + ' ' + s.key + ' ' + v);
            if (s.step) assert.equal(v, Math.round(v), s.key + ' whole');
          }
        }
      });
    }
  }
});

test('in key: every anchor and every contour end is on the scale', () => {
  for (const c of EXAMPLES) {
    eachUnit(R.soloScore(c, { seed: 2, seconds: 1800, pitch: DMIN }), u => {
      assert.ok(DMIN.inScale(u.note), c.name + ' anchor ' + u.note);
      assert.ok(DMIN.inScale(u.noteEnd), c.name + ' end ' + u.noteEnd);
    });
  }
});

test('free: pitches are continuous', () => {
  let frac = 0, all = 0;
  for (const c of EXAMPLES) eachUnit(R.soloScore(c, { seed: 2, seconds: 600, pitch: FREE }), u => { all++; if (u.note !== Math.round(u.note)) frac++; });
  assert.ok(frac > all * 0.9, frac + ' of ' + all);
});

test('in key: dolphin pulse pitch and whistle transpose land on the scale', () => {
  const c = byName('Glassfin');
  c.ranges['dolphin.rate'] = [-3, 0];
  c.ranges['dolphin.wtranspose'] = [-7, 7];
  let pitched = 0;
  eachUnit(R.soloScore(c, { seed: 4, seconds: 1800, pitch: DMIN }), (u) => {
    const cc = R.compile(c, DMIN);
    const r = u.v0[cc.iRate], wt = u.v0[cc.iWt];
    if (R.mtof(u.note) * Math.pow(2, r) > 30) { pitched++; assert.ok(DMIN.inScale(Math.round((u.note + 12 * r) * 1e3) / 1e3), 'pulse ' + u.note + ' ' + r); }   // rates are float32
    assert.ok(DMIN.inScale(u.note + wt), 'whistle ' + u.note + ' ' + wt);
    const sw = u.v0[cc.iSweep];
    assert.ok(DMIN.inScale(Math.round((u.note + wt + 12 * sw) * 1e3) / 1e3), 'sweep end ' + sw);
  });
  assert.ok(pitched > 50);
});

test('locked parameters are never rolled; snapping only adds what it can change', () => {
  const g = R.compile(byName('Glassfin'), DMIN);
  assert.ok(!g.vKey.includes('dolphin.freerate'), 'key track is locked on: free rate is inert');
  assert.ok(!g.vKey.includes('dolphin.wtranspose'), 'locked at 0: already in key');
  assert.ok(g.vKey.includes('dolphin.rate'));
  assert.ok(!g.vKey.includes('dolphin.coda'));
  assert.ok(g.locked.some(l => l.key === 'dolphin.coda'));
  const f = R.compile(byName('Glassfin'), FREE);
  for (const k of f.vKey) assert.ok(!f.locked.some(l => l.key === k));
  const sz = byName('Glassfin'); sz.ranges['dolphin.sizemode'] = [0, 1];
  assert.ok(R.compile(sz, DMIN).locked.some(l => l.key === 'dolphin.sizemode' && l.value === 0), 'size in octaves in key');
  assert.ok(R.compile(sz, FREE).vKey.includes('dolphin.sizemode'), 'free mode keeps continuous size');
  const w = R.compile(byName('Wicklace'), DMIN);
  assert.ok(!w.vKey.some(k => k.startsWith('mouth.')), 'no mouth, no mouth parameters');
  assert.ok(!w.fixed.some(k => k.engine === 'mouth'));
});

test('Morph 0 shares one value array; Morph 1 moves most units', () => {
  const c = byName('Wicklace');
  c.morph = 0;
  eachUnit(R.soloScore(c, { seed: 1, seconds: 600, pitch: DMIN }), u => assert.equal(u.v0, u.v1));
  c.morph = 1;
  let moving = 0, all = 0;
  eachUnit(R.soloScore(c, { seed: 1, seconds: 600, pitch: DMIN }), u => { all++; if (u.v0 !== u.v1) moving++; });
  assert.ok(moving > all * 0.6, moving + ' of ' + all);
});

test('Evolve rise climbs and fall descends', () => {
  function slope(kind) {
    const c = byName('Ticker');
    c.call.evolve = kind; c.call.evolveAmount = 1; c.call.units = [6, 8]; c.signature.amount = 0; c.manner.mimicry = 0;
    c.pitch = { low: 40, high: 90, contour: [0, 0] };
    let sum = 0;
    for (const call of R.soloScore(c, { seed: 3, seconds: 900, pitch: DMIN }).calls) sum += call.units[call.units.length - 1].note - call.units[0].note;
    return sum;
  }
  assert.ok(slope('rise') > 0, 'rise');
  assert.ok(slope('fall') < 0, 'fall');
});

test('signature: amount 1 and variation 0 repeat the same call shape in any pond', () => {
  const c = byName('Glassfin');
  c.signature = { amount: 1, variation: 0 };
  c.manner.mimicry = 0;
  // in key, steps are scale degrees: the same step can be 3 or 4 semitones
  const deg = DMIN.notesIn(0, 127), di = n => deg.indexOf(n);
  const shape = sc => sc.calls.map(k => k.units.map(u => u.dur.toFixed(6) + ':' + (di(u.note) - di(k.units[0].note))).join(','));
  const a = shape(R.soloScore(c, { seed: 1, seconds: 600, pitch: DMIN }));
  const b = shape(R.soloScore(c, { seed: 99, seconds: 600, pitch: DMIN }));
  assert.ok(a.length > 5);
  for (const s of a.concat(b)) assert.equal(s, a[0]);
  c.seed = 1234;
  const d = shape(R.soloScore(c, { seed: 1, seconds: 600, pitch: DMIN }));
  assert.notEqual(d[0], a[0], 'another creature seed, another signature');
});

test('mutate: amount 0 is the same motif, amount 1 changes it', () => {
  const cc = R.compile(byName('Ticker'), DMIN);
  const m = R.generateMotif(cc, new Rng(1));
  assert.equal(R.mutate(m, 0, new Rng(2)), m);
  const x = R.mutate(m, 1, new Rng(2), 32);
  assert.notEqual(x, m);
  assert.ok(x.units.some((u, i) => !m.units[i] || u.len !== m.units[i].len));
  assert.ok(x.units.length >= 1 && x.units.length <= 32);
});

test('copying across species keeps the gesture in the copier\'s own voice', () => {
  const throat = R.compile(byName('Moanback'), DMIN), dolphin = R.compile(byName('Ticker'), DMIN);
  const m = R.generateMotif(throat, new Rng(8));
  const call = R.realise(dolphin, m, 10, {}, new Rng(9), 'copy');
  assert.equal(call.units.length, m.units.length);
  const [l0, l1] = dolphin.unitLength;
  call.units.forEach((u, i) => {
    assert.ok(Math.abs(C.positionOf('log', l0, l1, u.dur) - m.units[i].len) < 1e-6, 'same length position');
    assert.ok(u.note >= dolphin.low && u.note <= dolphin.high, 'in the copier\'s pitch range');
  });
  // shared mouth parameters copy exactly
  const jT = throat.vKey.indexOf('mouth.lips'), jD = dolphin.vKey.indexOf('mouth.lips');
  assert.ok(jT >= 0 && jD >= 0);
  assert.ok(Math.abs(C.positionOf('lin', dolphin.vLo[jD], dolphin.vHi[jD], call.units[0].v0[jD]) - m.units[0].p0[jT]) < 1e-5);
});

test('Harmonise leans towards consonant intervals with what is sounding', () => {
  const c = byName('Glassfin');
  c.pitch = { low: 50, high: 80, contour: [0, 0] };
  c.call.units = [1, 1];
  const cc = R.compile(c, DMIN);
  function share(harmonise) {
    const rng = new Rng(4);
    let good = 0;
    for (let i = 0; i < 2000; i++) {
      const call = R.realise(cc, R.generateMotif(cc, rng), 0, { harmonise, sounding: [62, 69] }, rng);
      const n = call.units[0].note;
      if (S.consonance(n, 62) >= 0.8 && S.consonance(n, 69) >= 0.5) good++;
    }
    return good / 2000;
  }
  const on = share(true), off = share(false);
  assert.ok(on > off + 0.15, 'harmonise ' + on.toFixed(2) + ' vs ' + off.toFixed(2));
});

test('Register offset moves calls up the range', () => {
  const c = byName('Glassfin');
  c.call.units = [1, 1];
  const cc = R.compile(c, DMIN);
  const mean = reg => { const rng = new Rng(6); let s = 0; for (let i = 0; i < 1000; i++) s += R.realise(cc, R.generateMotif(cc, rng), 0, { register: reg }, rng).units[0].note; return s / 1000; };
  assert.ok(mean(3) > mean(0) + 2);
  assert.ok(mean(-3) < mean(0) - 2);
});

test('an hour of score for every example takes well under a second', () => {
  const t = Date.now();
  let units = 0;
  for (const c of EXAMPLES) for (const pitch of [DMIN, FREE]) eachUnit(R.soloScore(c, { seed: 7, seconds: 3600, pitch }), () => units++);
  const ms = Date.now() - t;
  assert.ok(ms < 800, ms + ' ms for ' + units + ' units');
});

test('scoreToJSON is plain JSON without motifs', () => {
  const sc = R.soloScore(byName('Ticker'), { seed: 1, seconds: 60, pitch: DMIN });
  const back = JSON.parse(R.scoreToJSON(sc));
  assert.equal(back.calls.length, sc.calls.length);
  assert.equal(back.calls[0].motif, undefined);
  assert.ok(Array.isArray(back.calls[0].units[0].v0));
  assert.equal(back.slots[0].name, 'Ticker');
});
