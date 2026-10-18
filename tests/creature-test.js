'use strict';
const path = require('path');
const fs = require('fs');
const { test, assert } = require('./harness');
const C = require('../src/creature.js');
const { Rng } = require('../src/rng.js');

const V = path.join(__dirname, '..', 'vendor');
const vendor = {
  throat: require(path.join(V, 'throat-engine.js')).PARAMS,
  dolphin: require(path.join(V, 'dolphin-engine.js')).PARAMS,
  mouth: require(path.join(V, 'mouth-tube.js')).PARAMS,
};
function vendorList(eng) {
  const p = vendor[eng];
  return Array.isArray(p) ? p : Object.keys(p).map(id => Object.assign({ id }, p[id]));
}

test('parameter table matches every vendored engine parameter', () => {
  for (const eng of ['throat', 'dolphin', 'mouth']) {
    const ours = {};
    for (const s of C.ENGINES[eng]) ours[s.id] = s;
    for (const d of vendorList(eng)) {
      const s = ours[d.id];
      if (/^lfo\d(shape|rate|sync|from|to|retrig)$/.test(d.id)) continue;   // inert while targets are None
      assert.ok(s, eng + '.' + d.id + ' is missing from krill\'s table');
      assert.equal(s.min, d.min, eng + '.' + d.id + ' min');
      assert.equal(s.max, d.max, eng + '.' + d.id + ' max');
      assert.equal(s.def, d.def, eng + '.' + d.id + ' default');
      if (d.step) assert.equal(s.step, d.step, eng + '.' + d.id + ' step');
    }
    const ids = new Set(vendorList(eng).map(d => d.id));
    for (const s of C.ENGINES[eng]) assert.ok(ids.has(s.id), eng + '.' + s.id + ' does not exist in the engine');
  }
});

test('fixed values are inside their engine range', () => {
  for (const eng in C.ENGINES) for (const s of C.ENGINES[eng]) {
    if (s.use !== 'fixed') continue;
    assert.ok(s.value >= s.min && s.value <= s.max, s.key + ' fixed value ' + s.value);
  }
});

test('engines are driven in mono mode with LFOs off', () => {
  assert.equal(C.BY_KEY['throat.mode'].value, 0);
  assert.equal(C.BY_KEY['dolphin.mode'].value, 0);
  for (let i = 1; i <= 4; i++) assert.equal(C.BY_KEY['dolphin.lfo' + i + 'target'].value, 0);
  assert.equal(C.BY_KEY['mouth.mix'].value, 1);
});

test('defaults for all four species are clean', () => {
  for (const src of ['throat', 'dolphin']) for (const mouth of [false, true]) {
    const c = C.defaults(src, mouth);
    const { creature, warnings } = C.normalise(c);
    assert.deepEqual(warnings, [], src + (mouth ? '+tube' : ''));
    assert.deepEqual(creature, c);
    const act = C.activeParams(creature);
    assert.equal(act.some(a => a.spec.engine === 'mouth'), mouth);
    assert.ok(act.every(a => a.spec.engine === src || a.spec.engine === 'mouth'));
  }
});

test('repairs: clamp, swap, step rounding, bad types', () => {
  const c = C.defaults('dolphin', true);
  c.ranges['dolphin.register'] = [1.4, -2];       // reversed and out of range
  c.ranges['dolphin.coda'] = [2.4, 6.6];          // whole numbers
  c.ranges['mouth.length'] = 22;                   // single number = locked
  c.call.units = [0, 99];
  c.manner.pan = 3;
  c.call.evolve = 'sideways';
  c.pitch = { low: 90, high: 30, contour: 'x' };
  const { creature, warnings } = C.normalise(c);
  assert.deepEqual(creature.ranges['dolphin.register'], [0, 1]);
  assert.deepEqual(creature.ranges['dolphin.coda'], [2, 7]);
  assert.deepEqual(creature.ranges['mouth.length'], [22, 22]);
  assert.deepEqual(creature.call.units, [1, 32]);
  assert.equal(creature.manner.pan, 1);
  assert.equal(creature.call.evolve, 'wander');
  assert.equal(creature.pitch.low, 30); assert.equal(creature.pitch.high, 90);
  assert.deepEqual(creature.pitch.contour, [-2, 2]);
  assert.ok(warnings.length >= 7, warnings.join(' | '));
});

test('unknown keys survive, krill-owned parameters are refused', () => {
  const c = C.defaults('throat', false);
  c.futureThing = { a: 1 };
  c.manner.futureKnob = 0.5;
  c.ranges['throat.newparam'] = [0, 1];
  c.ranges['throat.attack'] = [0, 1];
  c.ranges['mouth.jaw'] = [0.1, 0.2];              // no mouth: kept for later, unused
  const { creature } = C.normalise(c);
  assert.deepEqual(creature.futureThing, { a: 1 });
  assert.equal(creature.manner.futureKnob, 0.5);
  assert.deepEqual(creature.ranges['throat.newparam'], [0, 1]);
  assert.equal(creature.ranges['throat.attack'], undefined);
  assert.deepEqual(creature.ranges['mouth.jaw'], [0.1, 0.2]);
  assert.ok(!C.activeParams(creature).some(a => a.spec.key === 'mouth.jaw'));
});

test('not a creature is refused; newer version loads with a warning', () => {
  assert.throws(() => C.normalise({ format: 'krill-pond' }));
  assert.throws(() => C.normalise([1, 2]));
  const c = C.defaults('throat');
  c.version = 99;
  const { creature, warnings } = C.normalise(c);
  assert.equal(creature.version, C.VERSION);
  assert.ok(warnings[0].includes('newer'));
});

test('minimal file: unlisted parameters are locked at engine defaults', () => {
  const { creature } = C.normalise({ source: 'dolphin', name: 'Bare' });
  const act = C.activeParams(creature);
  for (const a of act) { assert.ok(a.locked, a.spec.key); assert.equal(a.lo, a.spec.def); }
});

test('serialise round trip is stable', () => {
  const c = C.defaults('dolphin', true, { name: 'Round Trip', seed: 42 });
  c.extra = 'kept';
  const txt = C.serialise(c);
  const back = C.normalise(txt).creature;
  assert.equal(C.serialise(back), txt);
  assert.ok(txt.includes('"dolphin.rate": [-3, -1]'));
  assert.equal(C.fileName(c), 'round-trip.krill-creature.json');
});

test('position and value are inverses on every scale', () => {
  for (const scale of ['lin', 'log', 'sq']) for (const p of [0, 0.1, 0.5, 0.93, 1]) {
    const v = C.valueAt(scale, 0, 0.05, 4, p);
    assert.ok(Math.abs(C.positionOf(scale, 0.05, 4, v) - p) < 1e-9, scale + ' ' + p);
  }
  assert.equal(C.valueAt('lin', 1, 0, 5, 0.55), 3);
  assert.equal(C.valueAt('lin', 0, 2, 2, 0.7), 2);
});

test('names are deterministic per stream', () => {
  const a = C.randomName(new Rng(5)), b = C.randomName(new Rng(5));
  assert.equal(a, b);
  assert.match(a, /^[A-Z][a-z]+$/);
});

test('example creatures load without warnings', () => {
  const dir = path.join(__dirname, '..', 'examples', 'creatures');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.krill-creature.json'));
  assert.ok(files.length >= 4);
  const species = new Set();
  for (const f of files) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const { creature, warnings } = C.normalise(txt);
    assert.deepEqual(warnings, [], f);
    assert.equal(C.serialise(creature), txt, f + ' is not in canonical form');
    species.add(creature.source + (creature.mouth ? '+tube' : ''));
  }
  assert.equal(species.size, 4, 'one example per species');
});
