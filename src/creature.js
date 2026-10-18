/*
 * krill · creature format
 *
 * A creature is a source (Throat, Dolphin…) through a body (none, Mouth…), plus ranges for every
 * parameter that shapes its sound, a call grammar, a signature, a manner and an output filter.
 * The parts and their parameter tables live in parts.js.
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
  const VERSION = 2;             // 2: `body` replaces `mouth`, tube parameters are 'tube.*', output filter

  const inNode = typeof module !== 'undefined' && module.exports;
  const PARTS = inNode ? require('./parts.js') : (root.Krill || {}).parts;

  // ---------- parameter tables, from the parts ----------
  const R = 'range';
  const ENGINES = {};            // namespace → parameter table ('throat', 'dolphin', 'tube', …)
  const PART_OF = {};            // namespace → part
  for (const group of [PARTS.SOURCES, PARTS.BODIES]) for (const id in group) {
    const part = group[id];
    if (part.ns) { ENGINES[part.ns] = part.params; PART_OF[part.ns] = part; }
  }
  const BY_KEY = {};             // 'throat.breathy' → spec (with .engine and .key)
  for (const eng in ENGINES) for (const s of ENGINES[eng]) { s.engine = eng; s.key = eng + '.' + s.id; BY_KEY[s.key] = s; }

  const SOURCES = Object.keys(PARTS.SOURCES);
  const BODIES = Object.keys(PARTS.BODIES);
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
    { path: 'filter.on', kind: 'bool', def: false },
    { path: 'filter.cutoff', kind: 'num', min: 200, max: 20000, def: 8000, scale: 'log', unit: 'Hz' },
  ];
  const FIELD = {};
  for (const f of FIELDS) FIELD[f.path] = f;

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

  // a fresh creature of one species: a source and a body ('none' for a raw source)
  function defaults(source, body, opts) {
    source = SOURCES.includes(source) ? source : SOURCES[0];
    body = BODIES.includes(body) ? body : 'none';
    const c = {
      format: FORMAT, version: VERSION,
      name: (opts && opts.name) || 'Unnamed',
      seed: (opts && Number.isInteger(opts.seed)) ? opts.seed >>> 0 : 1,
      source, body,
      pitch: {}, ranges: {}, morph: 0, call: {}, signature: {}, manner: {}, filter: {},
    };
    for (const f of FIELDS) setPath(c, f.path, clone(f.def));
    const src = PARTS.SOURCES[source], bod = PARTS.BODIES[body];
    c.pitch.low = src.pitch[0];
    c.pitch.high = src.pitch[1];
    for (const part of [src, bod]) for (const id in part.defaults) c.ranges[part.ns + '.' + id] = part.defaults[id].slice();
    return c;
  }

  // ---------- migration ----------
  // MIGRATIONS[n] turns a version n creature into version n + 1
  const MIGRATIONS = {
    // 1 → 2: `mouth: true/false` becomes `body: 'tube' | 'none'`; 'mouth.*' ranges become 'tube.*'
    1(o) {
      if (o.body == null) o.body = o.mouth ? 'tube' : 'none';
      delete o.mouth;
      if (o.ranges && typeof o.ranges === 'object') {
        const r = {};
        for (const k in o.ranges) r[k.startsWith('mouth.') ? 'tube.' + k.slice(6) : k] = o.ranges[k];
        o.ranges = r;
      }
      return o;
    },
  };

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

    if (!SOURCES.includes(o.source)) { if (o.source != null) warn.push('Unknown source "' + o.source + '", using ' + SOURCES[0]); o.source = SOURCES[0]; }
    if (!BODIES.includes(o.body)) { if (o.body != null) warn.push('Unknown body "' + o.body + '", using none'); o.body = 'none'; }
    if (typeof o.name !== 'string' || !o.name.trim()) { o.name = 'Unnamed'; }
    o.name = o.name.trim().slice(0, 40);
    o.seed = Number.isFinite(o.seed) ? Math.floor(Math.abs(o.seed)) >>> 0 : 1;

    const base = defaults(o.source, o.body);
    for (const f of FIELDS) {
      const raw = getPath(o, f.path);
      setPath(o, f.path, fixField(f, raw, getPath(base, f.path), warn));
    }
    if (o.pitch.low > o.pitch.high) { const t = o.pitch.low; o.pitch.low = o.pitch.high; o.pitch.high = t; warn.push('pitch.low was above pitch.high; swapped'); }

    // ranges: keep every entry (a body's ranges survive switching to another body), repair the known ones
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
    for (const eng of namespaces(c)) for (const s of ENGINES[eng]) {
      if (s.use !== R) continue;
      const r = c.ranges[s.key];
      const lo = r ? r[0] : s.def, hi = r ? r[1] : s.def;
      out.push({ spec: s, lo, hi, locked: lo === hi });
    }
    return out;
  }

  // parameter namespaces a creature uses: its source's, then its body's (if the body has any)
  function namespaces(c) {
    const out = [PARTS.SOURCES[c.source].ns];
    const b = PARTS.BODIES[c.body];
    if (b && b.ns) out.push(b.ns);
    return out;
  }
  // 'throat+tube': the key for calibration and labels
  const species = c => c.source + '+' + c.body;
  function speciesLabel(c) {
    const b = PARTS.BODIES[c.body];
    return PARTS.SOURCES[c.source].label + (b && b.ns ? ' + ' + b.label : '');
  }

  // ---------- files ----------
  // Stable key order; ranges listed in engine order, unknown ones after. Unknown top-level keys kept.
  function serialise(c) {
    const order = ['format', 'version', 'name', 'seed', 'source', 'body', 'pitch', 'ranges', 'morph', 'call', 'signature', 'manner', 'filter'];
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
    FORMAT, VERSION, ENGINES, BY_KEY, SOURCES, BODIES, PARTS, PART_OF, EVOLVE, FIELDS, FIELD, namespaces, species, speciesLabel,
    defaults, normalise, serialise, fileName, activeParams, randomName, valueAt, positionOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.Krill = root.Krill || {}).creature = api;
})(typeof self !== 'undefined' ? self : this);
