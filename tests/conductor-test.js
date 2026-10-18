'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert } = require('./harness');
const C = require('../src/creature.js');
const S = require('../src/scales.js');
const PD = require('../src/pond.js');
const CD = require('../src/conductor.js');
const M = require('../src/mixer.js');

const ROOT = path.join(__dirname, '..');
const creature = n => C.normalise(fs.readFileSync(path.join(ROOT, 'examples', 'creatures', n + '.krill-creature.json'), 'utf8')).creature;
function pond(names, set) {
  const p = PD.defaults({ seed: 5 });
  names.forEach((n, i) => { p.slots[i] = { creature: typeof n === 'string' ? creature(n) : n, rerolls: 0 }; });
  p.output.minutes = 15;
  if (set) set(p);
  return PD.normalise(p).pond;
}
const FOUR = ['glassfin', 'siltclicker', 'ticker', 'wicklace'];   // Moanback only for long monotonous calls
const overlaps = calls => { let n = 0; for (let i = 0; i < calls.length; i++) for (let j = i + 1; j < calls.length; j++) if (calls[j].t < calls[i].end && calls[i].t < calls[j].end) n++; return n; };
const stripMotif = sc => JSON.stringify(sc, (k, v) => k === 'motif' ? undefined : v instanceof Float32Array ? Array.from(v) : v);

test('the example pond file loads clean', () => {
  const r = PD.normalise(fs.readFileSync(path.join(ROOT, 'examples', 'ponds', 'first-pond.krill-pond.json'), 'utf8'));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.pond.slots.filter(Boolean).length, 4);
  assert.equal(PD.serialise(r.pond), fs.readFileSync(path.join(ROOT, 'examples', 'ponds', 'first-pond.krill-pond.json'), 'utf8'));
});

test('pond files: repairs, six slots, unknown keys kept', () => {
  const { pond: p, warnings } = PD.normalise({ seed: 3, slots: [{ creature: creature('ticker') }, null, { creature: { format: 'krill-pond' } }], talk: { overlap: 4 }, pitch: { root: 'H' }, extra: 1 });
  assert.equal(p.slots.length, 6);
  assert.ok(p.slots[0] && !p.slots[2]);
  assert.equal(p.talk.overlap, 1);
  assert.equal(p.pitch.root, 'D');
  assert.equal(p.extra, 1);
  assert.ok(warnings.length >= 2, warnings.join(' | '));
  assert.throws(() => PD.normalise({ format: 'krill-creature' }));
});

test('same pond, same score; another seed differs', () => {
  const a = stripMotif(CD.conduct(pond(FOUR))), b = stripMotif(CD.conduct(pond(FOUR)));
  assert.equal(a, b);
  assert.notEqual(stripMotif(CD.conduct(pond(FOUR, p => { p.seed = 6; }))), a);
});

test('Overlap 0 is strict turns; Overlap 1 talks over itself', () => {
  const strict = CD.conduct(pond(FOUR, p => { p.talk.overlap = 0; }));
  assert.ok(strict.calls.length > 40);
  assert.equal(overlaps(strict.calls), 0);
  const free = CD.conduct(pond(FOUR, p => { p.talk.overlap = 1; }));
  assert.ok(overlaps(free.calls) > 10, overlaps(free.calls) + ' overlaps');
});

test('a creature never overlaps itself, and calls are in time order', () => {
  const sc = CD.conduct(pond(FOUR, p => { p.talk.overlap = 1; }));
  for (let i = 1; i < sc.calls.length; i++) assert.ok(sc.calls[i].t >= sc.calls[i - 1].t);
  for (let s = 0; s < 4; s++) {
    const mine = sc.calls.filter(c => c.slot === s);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i].t >= mine[i - 1].end - 1e-9, 'slot ' + s);
  }
});

test('Responsive 0: nobody answers; Talkative 0 too: only the opening call', () => {
  const quiet = FOUR.map(n => { const c = creature(n); c.manner.responsive = 0; return c; });
  const sc = CD.conduct(pond(quiet));
  assert.ok(sc.calls.length > 5);
  assert.ok(sc.calls.every(c => c.depth === 0));
  const mute = quiet.map(c => { c = JSON.parse(JSON.stringify(c)); c.manner.talkative = 0; return c; });
  assert.equal(CD.conduct(pond(mute)).calls.length, 1, 'the pond still opens');
});

test('answers copy what they heard, and lineages spread between creatures', () => {
  const mimics = FOUR.map(n => { const c = creature(n); c.manner.responsive = 1; c.manner.mimicry = 1; return c; });
  const sc = CD.conduct(pond(mimics));
  const copies = sc.calls.filter(c => c.kind === 'copy');
  assert.ok(copies.length > 20, copies.length + ' copies');
  for (const c of copies.filter(c => c.of != null)) {
    const heard = sc.calls[c.of];
    assert.ok(heard.t < c.t && c.lineage === heard.lineage, 'a copy carries its source\'s lineage');
  }
  const spread = {};
  for (const c of sc.calls) (spread[c.lineage] = spread[c.lineage] || new Set()).add(c.slot);
  assert.ok(Object.values(spread).some(set => set.size >= 3), 'some lineage reached three creatures');
});

test('answer chains end: every step is less likely', () => {
  const eager = FOUR.map(n => { const c = creature(n); c.manner.responsive = 1; return c; });
  const sc = CD.conduct(pond(eager));
  const depths = sc.calls.map(c => c.depth);
  assert.ok(Math.max(...depths) < 24);
  assert.ok(depths.filter(d => d === 0).length > 3, 'conversations restart');
});

test('a lone creature answers and copies itself', () => {
  const c = creature('glassfin'); c.manner.responsive = 1; c.manner.mimicry = 1;
  const sc = CD.conduct(pond([c]));
  assert.ok(sc.calls.some(k => k.kind === 'copy' && k.from === 0));
  assert.ok(sc.calls.every(k => k.lean === 0));
});

test('answers lean away from their caller', () => {
  const sc = CD.conduct(pond(FOUR, p => { p.talk.overlap = 0; }));
  const homes = sc.slots.map(s => s && s.pan);
  const replies = sc.calls.filter(c => c.depth > 0 && c.from !== c.slot);
  assert.ok(replies.length > 10);
  for (const c of replies) {
    const d = homes[c.slot] - homes[c.from];
    if (Math.abs(d) > 1e-9) assert.ok(Math.sign(c.lean) === Math.sign(d), 'lean ' + c.lean + ' gap ' + d);
  }
});

test('re-rolling a slot changes that creature', () => {
  const a = CD.conduct(pond(FOUR)), b = CD.conduct(pond(FOUR, p => { p.slots[1].rerolls = 1; }));
  const first = (sc, s) => JSON.stringify(sc.calls.find(c => c.slot === s).units.map(u => [u.dur, u.note]));
  assert.notEqual(first(a, 1), first(b, 1), 'slot 2 rolled again');
});

test('Harmonise in key leans towards consonance with what is sounding', () => {
  const share = h => {
    const sc = CD.conduct(pond(FOUR, p => { p.talk.overlap = 1; p.pitch.harmonise = h; p.output.minutes = 40; }));
    let good = 0, n = 0;
    for (const c of sc.calls) {
      const others = sc.calls.filter(o => o.slot !== c.slot && o.t <= c.t && o.tail > c.t);
      if (!others.length) continue;
      const pitches = others.map(o => { let u = o.units[0]; for (const x of o.units) if (x.t <= c.t) u = x; return u.note; });
      n++;
      if (pitches.every(p => S.consonance(c.units[0].note, p) >= 0.5)) good++;
    }
    return { r: good / n, n };
  };
  const on = share(true), off = share(false);
  assert.ok(on.n > 20 && on.r > off.r + 0.1, 'harmonise ' + on.r.toFixed(2) + ' vs ' + off.r.toFixed(2) + ' (' + on.n + ' calls)');
});

test('eras: density and register drift within bounds', () => {
  const sc = CD.conduct(pond(FOUR, p => { p.talk.eraLength = 30; p.output.minutes = 20; }));
  assert.ok(sc.eras.length >= 40);
  const d = sc.eras.map(e => e.density), r = sc.eras.map(e => e.register);
  assert.ok(Math.min(...d) >= Math.exp(-0.9) - 1e-9 && Math.max(...d) <= Math.exp(0.9) + 1e-9);
  assert.ok(Math.max(...d) / Math.min(...d) > 1.5, 'density moves');
  assert.ok(r.every(x => Number.isInteger(x) && Math.abs(x) <= 3));
  assert.ok(new Set(r).size > 2, 'register moves');
});

test('an hour of a six-creature pond is decided in well under a second', () => {
  const six = ['glassfin', 'siltclicker', 'ticker', 'wicklace', 'glassfin', 'ticker'];
  const t = Date.now();
  const sc = CD.conduct(pond(six, p => { p.output.minutes = 60; }));
  const ms = Date.now() - t;
  assert.ok(ms < 1000, ms + ' ms for ' + sc.calls.length + ' calls');
});

test('a pond renders: every creature sounds, chunking doesn\'t matter', () => {
  const p = pond(FOUR, p => { p.output.minutes = 0.5; });
  const go = chunk => {
    const job = M.pondRender(p);
    const L = new Float32Array(job.render.frames), R = new Float32Array(job.render.frames), tl = new Float32Array(chunk), tr = new Float32Array(chunk);
    let at = 0; while (!job.render.done) { const n = job.render.read(tl, tr, chunk); L.set(tl.subarray(0, n), at); R.set(tr.subarray(0, n), at); at += n; }
    return { L, R, job };
  };
  const a = go(4800), b = go(777);
  assert.deepEqual(a.L, b.L); assert.deepEqual(a.R, b.R);
  const st = a.job.render.stats();
  const sounding = new Set(a.job.score.calls.map(c => c.slot));
  st.awake.forEach((w, i) => { if (sounding.has(a.job.score.slots.filter(Boolean)[i].slot)) assert.ok(w > 0, 'voice ' + i); });
  assert.equal(a.job.meta.kind, 'pond');
  assert.ok(st.enginePeakDb.every(x => x < -6), 'headroom ' + st.enginePeakDb.map(x => x.toFixed(1)).join(','));
});

test('Ignore others: a lane speaks on its own, by its Talkativeness, outside the conversation', () => {
  const mk = talk => pond(FOUR, p => {
    p.talk.overlap = 0;
    p.slots[3].ignore = true;
    p.slots[3].creature.manner.talkative = talk;
    for (const s of p.slots) if (s) { s.creature.manner.responsive = 1; s.creature.manner.mimicry = 1; }
  });
  const sc = CD.conduct(mk(0.8));
  const mine = sc.calls.filter(c => c.slot === 3), others = sc.calls.filter(c => c.slot !== 3);
  assert.ok(mine.length > 10);
  assert.ok(mine.every(c => c.depth === 0 && c.of == null && c.lineage === null), 'never answers or copies');
  assert.ok(sc.calls.every(c => c.from !== 3), 'nobody answers it');
  assert.equal(overlaps(others), 0, 'the conversation still takes turns');
  assert.ok(overlaps(sc.calls) > 0, 'it talks over the others');
  assert.ok(others.some(c => c.depth > 0), 'the others still converse');
  const quiet = CD.conduct(mk(0.1)).calls.filter(c => c.slot === 3).length;
  assert.ok(quiet < mine.length * 0.7, 'Talkative sets how often: ' + quiet + ' vs ' + mine.length);
});

test('a pond of only ignoring lanes still opens and every lane speaks', () => {
  const sc = CD.conduct(pond(FOUR, p => { for (const s of p.slots) if (s) s.ignore = true; }));
  assert.equal(new Set(sc.calls.map(c => c.slot)).size, 4);
  assert.ok(sc.calls[0].t < 2.1);
});

test('lane loudness: every call is drawn from [low, 0] dB, never louder; low 0 keeps calls level', () => {
  const sc = CD.conduct(pond(FOUR, p => { p.slots[0].loudness = [-12, 0]; p.slots[1].loudness = [0, 0]; }));
  const g0 = sc.calls.filter(c => c.slot === 0).map(c => c.gainDb), g1 = sc.calls.filter(c => c.slot === 1).map(c => c.gainDb);
  assert.ok(g0.every(g => g <= 0 && g >= -12) && Math.max(...g0) - Math.min(...g0) > 6, 'spread ' + (Math.max(...g0) - Math.min(...g0)).toFixed(1));
  assert.ok(g1.every(g => g === 0));
  const n = PD.normalise({ slots: [{ creature: creature('ticker'), loudness: [-40, 5] }, { creature: creature('ticker') }, { creature: creature('ticker'), level: -3, dynamics: 6 }] }).pond;
  assert.deepEqual(n.slots[0].loudness, [-24, 0], 'clamped; the top is always 0');
  assert.deepEqual(n.slots[1].loudness, [-6, 0], 'new lanes default to -6 to 0 dB');
  assert.deepEqual(n.slots[2].loudness, [-9, 0], 'an early level + dynamics lane converts');
  assert.equal(n.slots[2].level, undefined);
});

test('lane loudness: the top end moves too; calls stay inside [low, high], both at most 0', () => {
  const sc = CD.conduct(pond(FOUR, p => { p.slots[0].loudness = [-18, -8]; p.slots[1].loudness = [-5, -5]; }));
  const g0 = sc.calls.filter(c => c.slot === 0).map(c => c.gainDb), g1 = sc.calls.filter(c => c.slot === 1).map(c => c.gainDb);
  assert.ok(g0.every(g => g >= -18 && g <= -8) && Math.max(...g0) - Math.min(...g0) > 5, 'spread ' + (Math.max(...g0) - Math.min(...g0)).toFixed(1));
  assert.ok(g1.every(g => g === -5), 'low = high fixes the level');
  const n = PD.normalise({ slots: [{ creature: creature('ticker'), loudness: [-3, -10] }, { creature: creature('ticker'), loudness: [-6, 4] }] }).pond;
  assert.deepEqual(n.slots[0].loudness, [-10, -3], 'swapped ends are sorted');
  assert.deepEqual(n.slots[1].loudness, [-6, 0], 'the top never goes above 0');
});

test('the sketch pan is the voice pan: home, wander, lean and Width', () => {
  const PAN = require('../src/pan.js');
  const p = pond(FOUR), sc = CD.conduct(p, { seconds: 300 });
  const v = sc.calls.map(c => PAN.slotPanAt(p, c.slot, sc.slots[c.slot], c.t, c.lean));
  assert.ok(v.every(x => Math.abs(x) <= p.space.width + 1e-9));
  assert.ok(Math.min(...v) < -0.3 && Math.max(...v) > 0.3, 'both sides: ' + Math.min(...v).toFixed(2) + ' … ' + Math.max(...v).toFixed(2));
  const byHome = sc.slots.filter(Boolean).map(s => { const vs = sc.calls.filter(c => c.slot === s.slot).map(c => PAN.slotPanAt(p, c.slot, s, c.t, c.lean)); return [s.pan, vs.reduce((a, b) => a + b, 0) / vs.length]; });
  byHome.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < byHome.length; i++) if (byHome[i][0] - byHome[i - 1][0] > 0.3) assert.ok(byHome[i][1] > byHome[i - 1][1], 'lanes keep their left-to-right order on average');
});

test('a lane with a lower loudness range sounds quieter in the mix', () => {
  const energy = low => {
    const p = pond(['glassfin'], q => { q.output.minutes = 0.4; q.slots[0].loudness = [low, 0]; q.output.fadeIn = 0; q.output.fadeOut = 0; });
    const job = M.pondRender(p);
    const L = new Float32Array(job.render.frames), R = new Float32Array(job.render.frames);
    job.render.read(L, R, job.render.frames);
    let e = 0; for (let i = 0; i < L.length; i++) e += L[i] * L[i] + R[i] * R[i];
    return 10 * Math.log10(e);
  };
  const d = energy(0) - energy(-24);
  assert.ok(d > 4 && d < 24, d.toFixed(1) + ' dB quieter');
});

test('Chaos: 0 is the pond as it was; more Chaos gives more answers and copies, bunched together', () => {
  const run = ch => CD.conduct(pond(FOUR, p => { if (ch != null) p.talk.chaos = ch; }));
  const none = run(null), zero = run(0);
  assert.deepEqual(zero.calls.map(c => [c.slot, c.t, c.kind, c.of, c.gainDb]), none.calls.map(c => [c.slot, c.t, c.kind, c.of, c.gainDb]), 'Chaos 0 changes nothing');
  const stats = sc => {
    const by = {};
    for (const c of sc.calls) if (c.of != null) (by[c.of] = by[c.of] || []).push(c.t);
    const multi = Object.values(by).filter(v => v.length > 1);
    const spread = multi.length ? multi.reduce((a, v) => a + Math.max(...v) - Math.min(...v), 0) / multi.length : Infinity;
    return { answers: sc.calls.filter(c => c.of != null).length, copies: sc.calls.filter(c => c.kind === 'copy').length, multi: multi.length, spread };
  };
  const a = stats(zero), b = stats(run(0.5)), c = stats(run(1));
  assert.ok(a.answers < b.answers && b.answers < c.answers, JSON.stringify([a.answers, b.answers, c.answers]));
  assert.ok(a.copies < b.copies && b.copies < c.copies, JSON.stringify([a.copies, b.copies, c.copies]));
  assert.ok(c.multi > a.multi * 3, 'calls answered by several: ' + a.multi + ' → ' + c.multi);
  assert.ok(c.spread < 0.6, 'answers to one call start within ' + c.spread.toFixed(2) + ' s of each other');
  const n = PD.normalise({ talk: { chaos: 7 } }).pond;
  assert.equal(n.talk.chaos, 1, 'clamped');
  assert.equal(PD.normalise({}).pond.talk.chaos, 0, 'old ponds get 0');
});
