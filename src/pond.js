/*
 * krill · pond format (.krill-pond.json)
 *
 * A pond is up to six slots, each holding a creature (embedded, so the file alone can re-render
 * a piece), a re-roll count and its lane settings, plus pitch, talk, space and output settings
 * and a seed. Lane settings: ignore (outside the conversation: speaks on its own, isn't heard)
 * and loudness [low, high] dB: each call's loudness is drawn from this range. Both ends lie in
 * -24..0, so a lane only ever gets quieter than its creature, never louder; low = high fixes it.
 * Files from before the top was movable have [low, 0] and play the same.
 * normalise() repairs and fills in like creature.normalise(); unknown keys are kept.
 *
 * Works in the browser (Krill.pond) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const C = inNode ? require('./creature.js') : K.creature;
  const S = inNode ? require('./scales.js') : K.scales;

  const FORMAT = 'krill-pond';
  const VERSION = 1;
  const SLOTS = 6;
  const LOUDNESS = { min: -24, def: -6 };       // lane loudness range is [low, high] dB, both -24..0
  const COLORS = ['var(--green)', 'var(--yellow)', 'var(--orange)', 'var(--red)', 'var(--purple)', 'var(--blue)'];   // stripe order

  const FIELDS = [
    { path: 'pitch.harmonise', kind: 'bool', def: false },
    { path: 'talk.overlap', kind: 'num', min: 0, max: 1, def: 0.2 },
    { path: 'talk.response', kind: 'range', min: 0.05, max: 20, def: [0.3, 2.5] },
    { path: 'talk.eraLength', kind: 'num', min: 10, max: 1800, def: 120 },
    { path: 'space.width', kind: 'num', min: 0, max: 1, def: 0.8 },
    { path: 'output.minutes', kind: 'num', min: 0.1, max: 600, def: 20 },
    { path: 'output.bits', kind: 'enum', options: [16, 24], def: 24 },
    { path: 'output.level', kind: 'num', min: -24, max: 12, def: 0 },
    { path: 'output.fadeIn', kind: 'num', min: 0, max: 120, def: 5 },
    { path: 'output.fadeOut', kind: 'num', min: 0, max: 300, def: 20 },
  ];

  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function set(o, p, v) { const ks = p.split('.'); for (let i = 0; i < ks.length - 1; i++) { if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = v; }
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  function defaults(opts) {
    const p = { format: FORMAT, version: VERSION, name: (opts && opts.name) || 'Pond', seed: (opts && opts.seed) || 1,
      slots: new Array(SLOTS).fill(null), pitch: { mode: 'key', root: 'D', scale: 'minor' }, talk: {}, space: {}, output: {} };
    for (const f of FIELDS) set(p, f.path, Array.isArray(f.def) ? f.def.slice() : f.def);
    return p;
  }

  function normalise(input) {
    let o = typeof input === 'string' ? JSON.parse(input) : input;
    if (o == null || typeof o !== 'object' || Array.isArray(o)) throw new Error('Not a pond: expected an object');
    if (o.format != null && o.format !== FORMAT) throw new Error('Not a pond: format is "' + o.format + '"');
    o = JSON.parse(JSON.stringify(o));
    const warn = [];
    if (Number.isInteger(o.version) && o.version > VERSION) warn.push('File is version ' + o.version + ', newer than this krill (' + VERSION + ')');
    o.format = FORMAT; o.version = VERSION;
    if (typeof o.name !== 'string' || !o.name.trim()) o.name = 'Pond';
    o.seed = Number.isFinite(o.seed) ? Math.floor(Math.abs(o.seed)) >>> 0 : 1;
    // pitch
    const pm = o.pitch && typeof o.pitch === 'object' ? o.pitch : {};
    if (pm.mode === 'free') o.pitch = { mode: 'free', harmonise: false };
    else {
      let root = 'D', scale = 'minor';
      try { const k = S.makePitch({ mode: 'key', root: pm.root || 'D', scale: pm.scale }); root = k.root; scale = k.scale; }
      catch (e) { warn.push('pitch: ' + e.message + ', using D minor'); }
      o.pitch = Object.assign({}, pm, { mode: 'key', root, scale });
    }
    for (const f of FIELDS) {
      let v = get(o, f.path);
      if (v === undefined) { set(o, f.path, Array.isArray(f.def) ? f.def.slice() : f.def); continue; }
      if (f.kind === 'bool') v = !!v;
      else if (f.kind === 'enum') { if (!f.options.includes(v)) { warn.push(f.path + ': using ' + f.def); v = f.def; } }
      else if (f.kind === 'num') { if (!Number.isFinite(+v)) { warn.push(f.path + ': not a number'); v = f.def; } else v = clamp(+v, f.min, f.max); }
      else {
        if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite)) { warn.push(f.path + ': not a range'); v = f.def.slice(); }
        v = [clamp(Math.min(v[0], v[1]), f.min, f.max), clamp(Math.max(v[0], v[1]), f.min, f.max)];
      }
      set(o, f.path, v);
    }
    if (o.pitch.mode === 'free') o.pitch.harmonise = false;
    // slots: exactly six, each null or { creature, rerolls }
    const slots = Array.isArray(o.slots) ? o.slots : [];
    o.slots = [];
    for (let i = 0; i < SLOTS; i++) {
      const s = slots[i];
      if (!s || !s.creature) { o.slots.push(null); continue; }
      try {
        const r = C.normalise(s.creature);
        for (const w of r.warnings) warn.push('slot ' + (i + 1) + ': ' + w);
        const slot = Object.assign({}, s, { creature: r.creature, rerolls: Number.isInteger(s.rerolls) && s.rerolls > 0 ? s.rerolls : 0, ignore: !!s.ignore });
        let low = LOUDNESS.def, high = 0;
        if (Array.isArray(s.loudness) && Number.isFinite(+s.loudness[0])) {
          low = +s.loudness[0];
          if (Number.isFinite(+s.loudness[1])) high = +s.loudness[1];
        }
        else if (Number.isFinite(+s.level) || Number.isFinite(+s.dynamics)) low = Math.min(0, +s.level || 0) - (+s.dynamics || 0);   // early files
        delete slot.level; delete slot.dynamics;
        const q = x => clamp(Math.round(x * 10) / 10, LOUDNESS.min, 0);
        slot.loudness = [Math.min(q(low), q(high)), Math.max(q(low), q(high))];
        o.slots.push(slot);
      } catch (e) { warn.push('slot ' + (i + 1) + ': ' + e.message + ', emptied'); o.slots.push(null); }
    }
    if (slots.length > SLOTS && slots.slice(SLOTS).some(Boolean)) warn.push('only ' + SLOTS + ' slots are used');
    return { pond: o, warnings: warn };
  }

  function serialise(p) {
    const order = ['format', 'version', 'name', 'seed', 'slots', 'pitch', 'talk', 'space', 'output'];
    const out = {};
    for (const k of order) if (k in p) out[k] = p[k];
    for (const k in p) if (!(k in out)) out[k] = p[k];
    return JSON.stringify(out, null, 2).replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, '[$1, $2]') + '\n';
  }

  const fileName = p => (p.name || 'pond').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.krill-pond.json';

  // a new lane for a creature
  const slotFor = (creature, opts) => Object.assign({ creature, rerolls: 0, ignore: false, loudness: [LOUDNESS.def, 0] }, opts || {});

  const api = { FORMAT, VERSION, SLOTS, COLORS, FIELDS, LOUDNESS, defaults, normalise, serialise, fileName, slotFor };
  if (inNode) module.exports = api;
  else K.pond = api;
})(typeof self !== 'undefined' ? self : this);
