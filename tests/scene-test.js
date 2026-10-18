// the visualizer's scene: positions, sizes and links from the pond and its score
const fs = require('fs');
const path = require('path');
const { test, assert } = require('./harness');
const PD = require('../src/pond.js');
const CD = require('../src/conductor.js');
const SC = require('../src/scene.js');
const PAN = require('../src/pan.js');
const M = require('../src/mixer.js');

const examplePond = () => PD.normalise(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ponds', 'first-pond.krill-pond.json'), 'utf8')).pond;
const setup = (edit, seconds) => { const p = examplePond(); if (edit) edit(p); const s = CD.conduct(p, { seconds: seconds || 600 }); return { p, s, sc: SC.makeScene(p, s) }; };

test('scene: the same pond gives the same scene; another seed differs', () => {
  const a = setup().sc.at(123.4), b = setup().sc.at(123.4), c = setup(p => { p.seed = 99; }).sc.at(123.4);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.where.map(w => w && w.y), c.where.map(w => w && w.y));
});

test('scene: left to right is the pan you hear, everyone stays inside the circle', () => {
  const { p, s, sc } = setup();
  let n = 0;
  for (let t = 0; t < 600; t += 0.7) for (const w of sc.at(t).where) if (w) {
    assert.ok(Math.hypot(w.x, w.y) <= SC.REACH + 1e-9);
    // away from the moment a lean starts, x is the voice's pan (scaled into the circle)
    const k = s.calls.findIndex(c => c.slot === w.slot && c.t <= t && t - c.t > 5 && (s.calls.find(d => d.slot === w.slot && d.t > c.t) || { t: Infinity }).t > t);
    if (k >= 0 && Math.hypot(w.pan, w.y / SC.REACH) <= 1) { assert.ok(Math.abs(w.x / SC.REACH - PAN.slotPanAt(p, w.slot, s.slots[w.slot], t, s.calls[k].lean)) < 0.02); n++; }
  }
  assert.ok(n > 100, n + ' checked');
});

test('scene: height is seeded per slot and drifts with the eras, slower with longer eras', () => {
  const travel = eraLength => { const { sc } = setup(p => { p.talk.eraLength = eraLength; }); let d = 0, last = null; for (let t = 0; t < 600; t += 1) { const y = sc.at(t).where[0].y; if (last != null) d += Math.abs(y - last); last = y; } return d; };
  const fast = travel(30), slow = travel(300);
  assert.ok(fast > slow * 2, fast.toFixed(2) + ' vs ' + slow.toFixed(2));
  const ys = setup().sc.at(0).where.filter(Boolean).map(w => w.y);
  assert.ok(new Set(ys.map(y => y.toFixed(3))).size === ys.length, 'slots start at different heights');
});

test('scene: size follows the call\'s loudness; loudness never moves a creature', () => {
  const quiet = setup(p => { p.slots[0].loudness = [-24, -24]; }), loud = setup(p => { p.slots[0].loudness = [0, 0]; });
  for (const t of [50, 200, 400]) {
    const a = quiet.sc.at(t).where[0], b = loud.sc.at(t).where[0];
    assert.ok(a.size < 0.3 && Math.abs(b.size - 1) < 1e-9, a.size + ' ' + b.size);
  }
  // the same calls at the same times in both, so positions only differ through the score itself
  const same = setup(p => { p.slots[0].loudness = [-6, -6]; }), other = setup(p => { p.slots[0].loudness = [-18, -18]; });
  assert.deepEqual(same.s.calls.map(c => c.t), other.s.calls.map(c => c.t));
  for (const t of [30, 300]) { const a = same.sc.at(t).where[0], b = other.sc.at(t).where[0]; assert.ok(a.x === b.x && a.y === b.y); }
});

test('scene: an answer\'s line appears as the answer starts and fades; copies draw dotted lines', () => {
  const { s, sc } = setup();
  const ans = s.calls.map((c, k) => [c, k]).find(([c]) => c.of != null && c.kind !== 'copy' && s.calls[c.of].slot !== c.slot);
  const [c, k] = ans, src = s.calls[c.of];
  const at = t => sc.at(t).links.find(l => l.call === k);
  assert.ok(!at(c.t - 0.01), 'nothing before the answer starts');
  const on = at(c.t);
  assert.ok(on && !on.dotted && on.from === src.slot && on.to === c.slot && on.alpha === 1 && !('ball' in on));
  const after = at(c.t + 0.7);
  assert.ok(after && after.alpha < 1 && after.alpha > 0, 'the line fades');
  assert.ok(!at(c.t + 5));
  let dotted = 0, solid = 0;
  for (let t = 0; t < 600; t += 0.25) for (const l of sc.at(t).links) { if (l.dotted) { dotted++; assert.equal(s.calls[l.call].kind, 'copy'); } else solid++; }
  assert.ok(dotted > 20 && solid > 20, dotted + ' dotted, ' + solid + ' solid');
});

test('scene: a frame takes well under a millisecond, even six hours in', () => {
  const { sc } = setup(null, 6 * 3600);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) sc.at(6 * 3600 * i / 2000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 2000;
  assert.ok(ms < 0.5, ms.toFixed(3) + ' ms');
});

test('seek: the silent voices pick up where a WAV is, close to a straight render', () => {
  const p = examplePond(); p.output.minutes = 2;
  const straight = M.pondRender(p), jumped = M.pondRender(p);
  const n = 48000 * 70, L = new Float32Array(n), R = new Float32Array(n);
  straight.render.read(L, R, n);
  const at = 60 * 48000;
  jumped.render.seek(at - 48000 * 10);
  const m = 48000 * 10, L2 = new Float32Array(m), R2 = new Float32Array(m);
  jumped.render.read(L2, R2, m);
  // the next 10 s: loud where the straight render is loud (energy per second within 3 dB)
  let ok = 0, sec = 0;
  for (let s = 0; s < 10; s++) {
    let a = 0, b = 0;
    for (let i = s * 48000; i < (s + 1) * 48000; i++) { a += L[at - m + i] ** 2; b += L2[i] ** 2; }
    if (a < 1e-6 && b < 1e-6) continue;
    sec++; if (Math.abs(10 * Math.log10((a + 1e-12) / (b + 1e-12))) < 3) ok++;
  }
  assert.ok(sec > 3 && ok >= sec - 1, ok + ' of ' + sec + ' seconds');
});
