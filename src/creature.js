/*
 * krill · creature format
 *
 * A creature is a source engine (Throat or Dolphin), optionally through mouth-tube, plus ranges
 * for every parameter that shapes its sound, a call grammar, a signature and a manner.
 * This file owns:
 *   - the parameter table for each engine (what Krill may range, what it fixes, how values roll),
 *   - creature defaults per species,
 *   - normalise(): validation, clamping, migration; unknown keys are kept,
 *   - serialise(): stable JSON for .krill-creature.json files,
 *   - randomName().
 *
 * Engine min/max/defaults are copied from the vendored engines; tests/creature-test.js checks
 * they still match, so an engine update can't silently drift from this table.
 *
 * Works in the browser (Krill.creature) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const FORMAT = 'krill-creature';
  const VERSION = 1;

  // ---------- engine parameter tables ----------
  // use: 'range' = the creature gives it a range (locked = min equal to max)
  //      'fixed' = Krill sets it once to `value` and never touches it again
  //      'krill' = Krill drives it from the score (pitch, envelope, glide), not from ranges
  // scale: how a 0–1 position maps into a range: 'lin', 'log' (ratios) or 'sq' (fine near the low end)
  // step: 1 for whole-number (menu or switch) parameters
  const R = 'range', F = 'fixed', K = 'krill';
  function P(id, label, min, max, def, use, opt) {
    const o = { id, label, min, max, def, use, scale: 'lin', step: 0, unit: '', value: def };
    if (opt) for (const k in opt) o[k] = opt[k];
    return o;
  }

  const ENGINES = {
    throat: [
      P('voicing', 'Voicing', 0, 1, 1, R),
      P('breathy', 'Breathy', 0, 1, 0, R),
      P('tense', 'Tense', 0, 1, 0, R),
      P('creaky', 'Creaky', 0, 1, 0, R),
      P('thin', 'Thin', 0, 1, 0, R),
      P('growl', 'Growl', 0, 1, 0, R),
      P('jitter', 'Jitter', 0, 1, 0, R),
      P('shimmer', 'Shimmer', 0, 1, 0, R),
      P('source', 'Source', 0, 1, 0, R, { step: 1, options: ['Flow', 'Derivative'] }),
      P('transpose', 'Transpose', -24, 24, 0, F, { value: 0 }),
      P('detune', 'Detune', -100, 100, 0, K),
      P('mode', 'Mode', 0, 1, 0, F, { value: 0 }),
      P('glide', 'Glide', 0, 2, 0.06, K),
      P('attack', 'Attack', 0.001, 5, 0.02, K),
      P('decay', 'Decay', 0.001, 5, 0.3, F, { value: 0.3 }),
      P('sustain', 'Sustain', 0, 1, 0.8, F, { value: 1 }),
      P('release', 'Release', 0.001, 8, 0.25, K),
      P('volume', 'Volume', -48, 6, -6, F, { value: 0 }),
    ],
    dolphin: [
      P('rate', 'Rate', -6, 2, -2, R, { unit: 'oct' }),
      P('keytrack', 'Key track', 0, 1, 1, R, { step: 1, options: ['Off', 'On'] }),
      P('freerate', 'Free rate', 1, 2000, 13, R, { scale: 'log', unit: '/s' }),
      P('sync', 'Sync', 0, 1, 0, F, { step: 1, value: 0 }),
      P('pattern', 'Pattern', 0, 3, 0, R, { step: 1, options: ['Regular', 'Increasing', 'Decreasing', 'Grouped'] }),
      P('coda', 'Coda', 0, 16, 0, R, { step: 1 }),
      P('jitter', 'Jitter', 0, 1, 0.05, R),
      P('rubato', 'Rubato', 0, 1, 0, R),
      P('ornament', 'Ornament', 0, 1, 0, R),
      P('clicktone', 'Click tone', -2, 2, 0, R, { unit: 'oct' }),
      P('clickwidth', 'Click width', 0.05, 0.5, 0.1, R, { scale: 'log', unit: 'ms' }),
      P('ring', 'Ring', 0, 1, 0, R),
      P('vowel', 'Vowel', 0, 1, 0, R),
      P('pitchmode', 'Pitch mode', 0, 1, 0, F, { step: 1, value: 0 }),
      P('shape', 'Shape', 0, 5, 1, R, { step: 1, options: ['Flat', 'Up', 'Down', 'Convex', 'Concave', 'Wave'] }),
      P('sweep', 'Sweep', -3, 3, 1.4, R, { unit: 'oct' }),
      P('time', 'Time', 0.05, 4, 1, R, { scale: 'log', unit: 's' }),
      P('pitch', 'Pitch', -3, 3, 0, F, { value: 0 }),
      P('wtranspose', 'Whistle transpose', -24, 24, 0, R, { step: 1, unit: 'st' }),
      P('harmonics', 'Harmonics', 0, 3, 1, R, { step: 1 }),
      P('harmlevel', 'Harmonic level', -24, 0, -12, R, { unit: 'dB' }),
      P('register', 'Register', 0, 1, 0.5, R),
      P('biphon', 'Biphonation', 0, 1, 0, R),
      P('spread', 'Spread', 0, 1, 0.3, F, { value: 0 }),
      P('size', 'Size', 0, 1, 0, R),
      P('sizemode', 'Size mode', 0, 1, 0, R, { step: 1, options: ['Octaves', 'Continuous'] }),
      P('mode', 'Mode', 0, 1, 1, F, { step: 1, value: 0 }),
      P('glide', 'Glide', 0, 2, 0.06, K),
      P('transpose', 'Transpose', -24, 24, 0, F, { step: 1, value: 0 }),
      P('detune', 'Detune', -100, 100, 0, K),
      P('bendrange', 'Bend range', 2, 48, 12, F, { step: 1, value: 12 }),
      P('attack', 'Attack', 0.001, 5, 0.01, K),
      P('decay', 'Decay', 0.001, 5, 0.3, F, { value: 0.3 }),
      P('sustain', 'Sustain', 0, 1, 0.8, F, { value: 1 }),
      P('release', 'Release', 0.001, 8, 0.3, K),
      P('volume', 'Volume', -48, 6, -6, F, { value: 0 }),
    ],
    mouth: [
      P('tongueX', 'Tongue front–back', 0, 1, 0.55, R),
      P('tongueY', 'Tongue close–open', 0, 1, 0.7, R),
      P('tip', 'Tip', 0, 1, 0, R),
      P('jaw', 'Jaw', 0, 1, 0.3, R),
      P('lips', 'Lips', 0, 1, 0.6, R),
      P('round', 'Round', 0, 1, 0, R),
      P('nasal', 'Nasal', 0, 1, 0, R),
      P('length', 'Length', 7, 35, 17, R, { unit: 'cm' }),
      P('damping', 'Damping', 0, 1, 0.5, R),
      P('spread', 'Spread', 0, 1, 0, F, { value: 0 }),
      P('radiation', 'Radiation', 0, 1, 1, F, { value: 1 }),
      P('mix', 'Mix', 0, 1, 1, F, { value: 1 }),
      P('output', 'Output', -24, 12, 0, F, { value: 0 }),
    ],
  };
  // Dolphin LFOs: all four stay off (target None); Krill moves parameters itself
  for (let i = 1; i <= 4; i++) ENGINES.dolphin.push(P('lfo' + i + 'target', 'LFO ' + i + ' target', 0, 28, 0, F, { step: 1, value: 0 }));

  const BY_KEY = {};              // 'throat.breathy' → spec (with .engine and .key)
  for (const eng in ENGINES) for (const s of ENGINES[eng]) { s.engine = eng; s.key = eng + '.' + s.id; BY_KEY[s.key] = s; }

  const SOURCES = ['throat', 'dolphin'];
  const EVOLVE = ['steady', 'rise', 'fall', 'arc', 'wander'];

  // ---------- position ↔ value ----------
  // p in 0–1 → value inside [lo, hi] for spec scale; whole numbers for step parameters
  function valueAt(scale, step, lo, hi, p) {
    if (lo === hi) return lo;
    let v;
    if (scale === 'log' && lo > 0) v = lo * Math.pow(hi / lo, p);
    else if (scale === 'sq') v = lo + (hi - lo) * p * p;
    else v = lo + (hi - lo) * p;
    if (step) { v = Math.round(v); if (v < lo) v = Math.ceil(lo); if (v > hi) v = Math.floor(hi); }
    return v;
  }
  // value → position 0–1 inside [lo, hi] (inverse of valueAt, ignoring rounding)
  function positionOf(scale, lo, hi, v) {
    if (hi === lo) return 0.5;
    let p;
    if (scale === 'log' && lo > 0) p = Math.log(v / lo) / Math.log(hi / lo);
    else if (scale === 'sq') p = Math.sqrt(Math.max(0, (v - lo) / (hi - lo)));
    else p = (v - lo) / (hi - lo);
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  // ---------- Krill's own fields ----------
  // kind: 'range' (two numbers), 'irange' (two whole numbers), 'num', 'bool', 'enum'
  const FIELDS = [
    { path: 'pitch.low', kind: 'num', min: 12, max: 120, def: 48, step: 1 },
    { path: 'pitch.high', kind: 'num', min: 12, max: 120, def: 64, step: 1 },
    { path: 'pitch.contour', kind: 'range', min: -24, max: 24, def: [-2, 2], unit: 'st' },
    { path: 'morph', kind: 'num', min: 0, max: 1, def: 0.2 },
    { path: 'call.units', kind: 'irange', min: 1, max: 32, def: [1, 4] },
    { path: 'call.unitLength', kind: 'range', min: 0.02, max: 20, def: [0.3, 2], scale: 'log', unit: 's' },
    { path: 'call.gap', kind: 'range', min: 0, max: 5, def: [0.05, 0.5], scale: 'sq', unit: 's' },
    { path: 'call.legato', kind: 'bool', def: false },
    { path: 'call.evolve', kind: 'enum', options: EVOLVE, def: 'wander' },
    { path: 'call.evolveAmount', kind: 'num', min: 0, max: 1, def: 0.3 },
    { path: 'call.rest', kind: 'range', min: 0.5, max: 300, def: [3, 20], scale: 'log', unit: 's' },
    { path: 'call.attack', kind: 'range', min: 0.001, max: 5, def: [0.02, 0.3], scale: 'log', unit: 's' },
    { path: 'call.release', kind: 'range', min: 0.001, max: 8, def: [0.2, 1.5], scale: 'log', unit: 's' },
    { path: 'signature.amount', kind: 'num', min: 0, max: 1, def: 0.3 },
    { path: 'signature.variation', kind: 'num', min: 0, max: 1, def: 0.2 },
    { path: 'manner.talkative', kind: 'num', min: 0, max: 1, def: 0.5 },
    { path: 'manner.responsive', kind: 'num', min: 0, max: 1, def: 0.5 },
    { path: 'manner.mimicry', kind: 'num', min: 0, max: 1, def: 0.3 },
    { path: 'manner.pan', kind: 'num', min: -1, max: 1, def: 0 },
    { path: 'manner.wander', kind: 'num', min: 0, max: 1, def: 0.2 },
    { path: 'manner.level', kind: 'num', min: -48, max: 6, def: -6, unit: 'dB' },
  ];
  const FIELD = {};
  for (const f of FIELDS) FIELD[f.path] = f;

  // ---------- species defaults ----------
  const DEFAULT_RANGES = {
    throat: {
      voicing: [0.85, 1], breathy: [0, 0.4], tense: [0, 0.3], creaky: [0, 0.2], thin: [0, 0.3],
      growl: [0, 0.1], jitter: [0.05, 0.2], shimmer: [0.05, 0.2], source: [0, 0],
    },
    dolphin: {
      rate: [-3, -1], keytrack: [1, 1], freerate: [13, 13], pattern: [0, 0], coda: [0, 0],
      jitter: [0, 0.2], rubato: [0, 0.3], ornament: [0, 0], clicktone: [-0.5, 0.5], clickwidth: [0.1, 0.1],
      ring: [0, 0.3], vowel: [0, 0.5], shape: [1, 4], sweep: [-1, 1.5], time: [0.3, 1.5],
      wtranspose: [0, 0], harmonics: [1, 2], harmlevel: [-18, -8], register: [0.3, 0.9],
      biphon: [0, 0.3], size: [0.2, 0.6], sizemode: [0, 0],
    },
    mouth: {
      tongueX: [0.2, 0.8], tongueY: [0.3, 0.9], tip: [0, 0], jaw: [0.2, 0.6], lips: [0.4, 0.9],
      round: [0, 0.5], nasal: [0, 0.15], length: [14, 20], damping: [0.4, 0.6],
    },
  };
  const DEFAULT_PITCH = { throat: [40, 60], dolphin: [60, 84] };

  function getPath(o, path) {
    const parts = path.split('.');
    for (const p of parts) { if (o == null || typeof o !== 'object') return undefined; o = o[p]; }
    return o;
  }
  function setPath(o, path, v) {
    const parts = path.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object' || Array.isArray(o[parts[i]])) o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = v;
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // a fresh creature of one species
  function defaults(source, mouth, opts) {
    source = SOURCES.includes(source) ? source : 'throat';
    mouth = !!mouth;
    const c = {
      format: FORMAT, version: VERSION,
      name: (opts && opts.name) || 'Unnamed',
      seed: (opts && Number.isInteger(opts.seed)) ? opts.seed >>> 0 : 1,
      source, mouth,
      pitch: {}, ranges: {}, morph: 0, call: {}, signature: {}, manner: {},
    };
    for (const f of FIELDS) setPath(c, f.path, clone(f.def));
    c.pitch.low = DEFAULT_PITCH[source][0];
    c.pitch.high = DEFAULT_PITCH[source][1];
    for (const id in DEFAULT_RANGES[source]) c.ranges[source + '.' + id] = DEFAULT_RANGES[source][id].slice();
    if (mouth) for (const id in DEFAULT_RANGES.mouth) c.ranges['mouth.' + id] = DEFAULT_RANGES.mouth[id].slice();
    return c;
  }

  // ---------- migration ----------
  // MIGRATIONS[n] turns a version n creature into version n + 1
  const MIGRATIONS = {};

  // ---------- validation ----------
  // Returns { creature, warnings }. Throws only if the input is not a creature at all.
  // Everything else is repaired: missing fields take defaults, values are clamped, reversed ranges
  // swapped. Unknown keys (anywhere) are kept untouched so newer files survive a round trip.
  function normalise(input) {
    let o = input;
    if (typeof o === 'string') o = JSON.parse(o);
    if (o == null || typeof o !== 'object' || Array.isArray(o)) throw new Error('Not a creature: expected an object');
    if (o.format != null && o.format !== FORMAT) throw new Error('Not a creature: format is "' + o.format + '"');
    o = clone(o);
    const warn = [];
    let v = Number.isInteger(o.version) ? o.version : 1;
    if (v > VERSION) warn.push('File is version ' + v + ', newer than this krill (' + VERSION + '); loading what it understands');
    while (v < VERSION && MIGRATIONS[v]) { o = MIGRATIONS[v](o); v++; }
    o.format = FORMAT;
    o.version = VERSION;

    if (!SOURCES.includes(o.source)) { if (o.source != null) warn.push('Unknown source "' + o.source + '", using throat'); o.source = 'throat'; }
    o.mouth = !!o.mouth;
    if (typeof o.name !== 'string' || !o.name.trim()) { o.name = 'Unnamed'; }
    o.name = o.name.trim().slice(0, 40);
    o.seed = Number.isFinite(o.seed) ? Math.floor(Math.abs(o.seed)) >>> 0 : 1;

    const base = defaults(o.source, o.mouth);
    for (const f of FIELDS) {
      const raw = getPath(o, f.path);
      setPath(o, f.path, fixField(f, raw, getPath(base, f.path), warn));
    }
    if (o.pitch.low > o.pitch.high) { const t = o.pitch.low; o.pitch.low = o.pitch.high; o.pitch.high = t; warn.push('pitch.low was above pitch.high; swapped'); }

    // ranges: keep every entry (a mouth range survives switching the mouth off), repair the known ones
    const ranges = (o.ranges && typeof o.ranges === 'object' && !Array.isArray(o.ranges)) ? o.ranges : {};
    o.ranges = {};
    for (const key in ranges) {
      const s = BY_KEY[key];
      if (!s) { o.ranges[key] = ranges[key]; warn.push('Unknown parameter "' + key + '" kept but unused'); continue; }
      if (s.use !== R) { warn.push('"' + key + '" is set by krill, not a range; dropped'); continue; }
      o.ranges[key] = fixRange(s, ranges[key], [s.def, s.def], warn, key);
    }
    return { creature: o, warnings: warn };
  }

  function fixField(f, raw, def, warn) {
    if (raw === undefined) return clone(def);
    if (f.kind === 'bool') return !!raw;
    if (f.kind === 'enum') {
      if (f.options.includes(raw)) return raw;
      warn.push(f.path + ': unknown value "' + raw + '", using "' + def + '"');
      return def;
    }
    if (f.kind === 'num') {
      if (!Number.isFinite(+raw)) { warn.push(f.path + ': not a number, using default'); return def; }
      let v = clampNum(+raw, f.min, f.max);
      if (f.step) v = Math.round(v);
      if (v !== +raw) warn.push(f.path + ': ' + raw + ' clamped to ' + v);
      return v;
    }
    return fixRange({ min: f.min, max: f.max, step: f.kind === 'irange' ? 1 : 0 }, raw, def, warn, f.path);
  }

  function fixRange(s, raw, def, warn, name) {
    let lo, hi;
    if (Number.isFinite(+raw) && !Array.isArray(raw)) { lo = hi = +raw; }
    else if (Array.isArray(raw) && raw.length === 2 && Number.isFinite(+raw[0]) && Number.isFinite(+raw[1])) { lo = +raw[0]; hi = +raw[1]; }
    else { warn.push(name + ': not a range, using default'); return def.slice(); }
    if (lo > hi) { const t = lo; lo = hi; hi = t; warn.push(name + ': reversed range swapped'); }
    const clo = clampNum(lo, s.min, s.max), chi = clampNum(hi, s.min, s.max);
    if (clo !== lo || chi !== hi) warn.push(name + ': clamped to [' + clo + ', ' + chi + ']');
    lo = clo; hi = chi;
    if (s.step) { lo = Math.round(lo); hi = Math.round(hi); }
    return [lo, hi];
  }

  // the parameter specs a creature actually uses, in engine order: [{ spec, lo, hi, locked }]
  function activeParams(c) {
    const out = [];
    const engines = c.mouth ? [c.source, 'mouth'] : [c.source];
    for (const eng of engines) for (const s of ENGINES[eng]) {
      if (s.use !== R) continue;
      const r = c.ranges[s.key];
      const lo = r ? r[0] : s.def, hi = r ? r[1] : s.def;
      out.push({ spec: s, lo, hi, locked: lo === hi });
    }
    return out;
  }

  // ---------- files ----------
  // Stable key order; ranges listed in engine order, unknown ones after. Unknown top-level keys kept.
  function serialise(c) {
    const order = ['format', 'version', 'name', 'seed', 'source', 'mouth', 'pitch', 'ranges', 'morph', 'call', 'signature', 'manner'];
    const out = {};
    for (const k of order) if (k in c) out[k] = c[k];
    const ranges = {};
    for (const eng in ENGINES) for (const s of ENGINES[eng]) if (c.ranges && c.ranges[s.key]) ranges[s.key] = c.ranges[s.key];
    for (const k in c.ranges) if (!(k in ranges)) ranges[k] = c.ranges[k];
    out.ranges = ranges;
    for (const k in c) if (!(k in out)) out[k] = c[k];
    // short arrays on one line keep files readable
    return JSON.stringify(out, null, 2).replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, '[$1, $2]') + '\n';
  }

  function fileName(c) {
    return (c.name || 'creature').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.krill-creature.json';
  }

  // ---------- names ----------
  const NAME_A = ['glass', 'moan', 'tick', 'drift', 'hollow', 'murk', 'silt', 'brine', 'pale', 'kelp', 'reed', 'ember',
    'gloam', 'fen', 'shoal', 'quill', 'dusk', 'hum', 'mire', 'frost', 'ash', 'wick', 'loam', 'vesper', 'cinder', 'knell'];
  const NAME_B = ['fin', 'back', 'wing', 'maw', 'tail', 'lung', 'coil', 'gill', 'shell', 'eye', 'horn', 'spine',
    'reed', 'hide', 'throat', 'skin', 'belly', 'drift', 'song', 'tongue', 'crest', 'whorl', 'mote', 'lace'];
  function randomName(rng) {
    let a = rng.pick(NAME_A), b = rng.pick(NAME_B);
    while (b === a) b = rng.pick(NAME_B);
    return a.charAt(0).toUpperCase() + a.slice(1) + b;
  }

  const api = {
    FORMAT, VERSION, ENGINES, BY_KEY, SOURCES, EVOLVE, FIELDS, FIELD,
    defaults, normalise, serialise, fileName, activeParams, randomName, valueAt, positionOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.Krill = root.Krill || {}).creature = api;
})(typeof self !== 'undefined' ? self : this);
