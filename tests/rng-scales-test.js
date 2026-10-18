'use strict';
const { test, assert } = require('./harness');
const { Rng, hash } = require('../src/rng.js');
const S = require('../src/scales.js');

test('rng: same seed same stream, different seeds differ', () => {
  const a = new Rng(42), b = new Rng(42), c = new Rng(43);
  const xa = [], xb = [], xc = [];
  for (let i = 0; i < 100; i++) { xa.push(a.u32()); xb.push(b.u32()); xc.push(c.u32()); }
  assert.deepEqual(xa, xb);
  assert.notDeepEqual(xa, xc);
});

test('rng: known first values (stream must never change between versions)', () => {
  const r = new Rng(1);
  // pinned: if these change, every saved pond renders differently
  assert.deepEqual([r.u32(), r.u32(), r.u32()], [3384357204, 4001177017, 406009659]);
});

test('rng: uniform enough, ranges inclusive', () => {
  const r = new Rng(7);
  const bins = new Array(10).fill(0);
  for (let i = 0; i < 100000; i++) bins[Math.floor(r.next() * 10)]++;
  for (const b of bins) assert.ok(b > 9500 && b < 10500, 'bin ' + b);
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(r.int(1, 3));
  assert.deepEqual([...seen].sort(), [1, 2, 3]);
});

test('rng: forks are independent and do not advance the parent', () => {
  const p = new Rng(9), q = new Rng(9);
  const f1 = p.fork('slot', 1), f2 = p.fork('slot', 2), f1b = q.fork('slot', 1);
  assert.equal(p.u32(), q.u32());
  assert.equal(f1.u32(), f1b.u32());
  assert.notEqual(new Rng(9).fork('slot', 1).u32(), f2.u32());
  assert.notEqual(hash(1, 2), hash(2, 1));
  assert.notEqual(hash(5, 1, 2), hash(5, 2, 1));
  const seen = new Set();
  for (let slot = 0; slot < 6; slot++) for (let re = 0; re < 50; re++) seen.add(hash(5, slot, re));
  assert.equal(seen.size, 300, 'slot streams collide');
});

test('rng: weighted picks follow weights, all-zero gives -1', () => {
  const r = new Rng(3), w = [0, 1, 3], n = [0, 0, 0];
  for (let i = 0; i < 40000; i++) n[r.weighted(w, 3)]++;
  assert.equal(n[0], 0);
  assert.ok(Math.abs(n[2] / n[1] - 3) < 0.2, n.join(','));
  assert.equal(r.weighted([0, 0], 2), -1);
});

test('scales: notes in range and snapping', () => {
  const p = S.makePitch({ mode: 'key', root: 'D', scale: 'minor' });
  assert.deepEqual(p.notesIn(60, 72), [60, 62, 64, 65, 67, 69, 70, 72]);   // C D E F G A Bb C
  assert.equal(p.snap(61), 60);          // C# → C (tie goes down)
  assert.equal(p.snap(63.4), 62);        // D# area → D
  assert.equal(p.snap(66), 65);          // F# → F
  assert.equal(p.snap(71), 70);          // B → Bb
  for (let x = 20; x < 110; x += 0.37) assert.ok(p.inScale(p.snap(x)), 'snap ' + x);
  assert.ok(!p.inScale(61));
  assert.ok(!p.inScale(62.5));
});

test('scales: every scale and root snaps into itself', () => {
  for (const name in S.SCALES) for (const root of S.ROOTS) {
    const p = S.makePitch({ mode: 'key', root, scale: name });
    for (let n = 30; n < 90; n++) {
      const s = p.snap(n);
      assert.ok(p.inScale(s) && Math.abs(s - n) <= 2, name + ' ' + root + ' ' + n + '→' + s);
      if (p.inScale(n)) assert.equal(s, n);
    }
  }
});

test('scales: free mode is untouched, parse works', () => {
  const f = S.makePitch({ mode: 'free' });
  assert.equal(f.snap(61.37), 61.37);
  assert.equal(f.notesIn(60, 70), null);
  assert.deepEqual(S.parse('F# pentatonic minor'), { mode: 'key', root: 'F#', scale: 'pentatonic minor' });
  assert.deepEqual(S.parse('free'), { mode: 'free' });
  assert.throws(() => S.parse('H major'));
  assert.equal(S.makePitch(S.parse('Bb major')).root, 'A#');
});

test('scales: consonance prefers thirds, fifths and sixths', () => {
  for (const good of [3, 4, 7, 8, 9]) for (const bad of [1, 2, 6, 10, 11]) {
    assert.ok(S.consonance(60, 60 + good) > S.consonance(60, 60 + bad), good + ' vs ' + bad);
  }
  assert.equal(S.consonance(60, 72 + 7), S.consonance(60, 67));
  assert.equal(S.noteName(61.25, true), 'C#4+25');
  assert.equal(S.noteName(69), 'A4');
});
