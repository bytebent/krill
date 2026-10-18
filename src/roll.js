/*
 * krill · rolling calls for one creature
 *
 * A creature is compiled once into flat arrays (compile). Calls are made in two steps:
 *
 *   motif   the abstract shape of a call: per unit its length, gap, contour and pitch step, and
 *           every varying parameter as a POSITION 0–1 inside the creature's range. Motifs are what
 *           creatures remember, repeat (signature) and copy from each other.
 *   call    a motif realised by one creature at one time: real seconds, MIDI pitches and engine
 *           values. Realising another creature's motif maps positions into the copier's own ranges,
 *           so a copy is the same gesture in a different voice.
 *
 * Efficiency: locked parameters are never rolled or stored per unit (they're written once by the
 * audio stage). Units without Morph share one value array for start and end. Evolve, Morph,
 * mutation and Harmonise work is skipped entirely when their amount is 0 or they're off.
 *
 * Works in the browser (Krill.roll) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const C = inNode ? require('./creature.js') : K.creature;
  const { Rng, hash, tag } = inNode ? require('./rng.js') : K.rng;
  const S = inNode ? require('./scales.js') : K.scales;

  const valueAt = C.valueAt;
  const PITCH_LO = 12, PITCH_HI = 120;       // absolute limits for contour ends
  const PULSE_PITCH_HZ = 30;                 // pulse rates above this are heard as pitch and snap to key

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function ftom(f) { return 69 + 12 * Math.log2(f / 440); }

  // ---------- compile ----------
  // pitch: a scales.makePitch() context
  function compile(creature, pitch) {
    const c = creature;
    const act = C.activeParams(c);
    const keyMode = !pitch.free;
    // dolphin parameters that must follow the note in key mode, even when locked, but only when
    // snapping can actually change them (anchors are already on the scale)
    let snapKeys = null;
    if (keyMode && c.source === 'dolphin') {
      const range = k => { const a = act.find(x => x.spec.key === k); return a ? [a.lo, a.hi] : null; };
      const kt = range('dolphin.keytrack'), rate = range('dolphin.rate'), fr = range('dolphin.freerate'), wt = range('dolphin.wtranspose');
      snapKeys = new Set();
      const ktCanBeOn = !kt || kt[1] >= 0.5, ktCanBeOff = !!kt && kt[0] < 0.5;
      if (ktCanBeOn && rate && !(rate[0] === rate[1] && Number.isInteger(rate[0]))) snapKeys.add('dolphin.rate');
      if (ktCanBeOff && fr && fr[1] > PULSE_PITCH_HZ) snapKeys.add('dolphin.freerate');
      if (wt && !(wt[0] === wt[1] && wt[0] % 12 === 0)) snapKeys.add('dolphin.wtranspose');
    }

    const vary = [], locked = [];
    for (const a of act) {
      if (!a.locked || (snapKeys && snapKeys.has(a.spec.key))) vary.push(a);
      else locked.push({ key: a.spec.key, engine: a.spec.engine, id: a.spec.id, value: a.lo });
    }
    const fixed = [];
    for (const eng of c.mouth ? [c.source, 'mouth'] : [c.source]) {
      for (const s of C.ENGINES[eng]) if (s.use === 'fixed') fixed.push({ key: s.key, engine: eng, id: s.id, value: s.value });
    }
    const V = vary.length;
    const cc = {
      creature: c, pitch, keyMode,
      name: c.name, source: c.source, mouth: c.mouth,
      V,
      vKey: vary.map(a => a.spec.key),
      vSpec: vary.map(a => a.spec),
      vLo: Float64Array.from(vary, a => a.lo),
      vHi: Float64Array.from(vary, a => a.hi),
      locked, fixed,
      lockedValue: {},
      low: c.pitch.low, high: c.pitch.high,
      cLo: c.pitch.contour[0], cHi: c.pitch.contour[1],
      notes: null,
      units: c.call.units, unitLength: c.call.unitLength, gap: c.call.gap,
      legato: c.call.legato, evolve: c.call.evolve, evolveAmount: c.call.evolveAmount,
      rest: c.call.rest, attack: c.call.attack, release: c.call.release,
      morph: c.morph,
      sigAmount: c.signature.amount, sigVariation: c.signature.variation,
      talkative: c.manner.talkative, responsive: c.manner.responsive, mimicry: c.manner.mimicry,
      pan: c.manner.pan, wander: c.manner.wander, level: c.manner.level,
      iRate: -1, iFree: -1, iWt: -1, iKeytrack: -1,
      signature: null,
    };
    for (const l of locked) cc.lockedValue[l.key] = l.value;
    cc.iRate = cc.vKey.indexOf('dolphin.rate');
    cc.iFree = cc.vKey.indexOf('dolphin.freerate');
    cc.iWt = cc.vKey.indexOf('dolphin.wtranspose');
    cc.iKeytrack = cc.vKey.indexOf('dolphin.keytrack');
    if (keyMode) {
      cc.notes = pitch.notesIn(cc.low, cc.high);
      if (!cc.notes.length) cc.notes = [pitch.snap((cc.low + cc.high) / 2)];
    }
    cc.stepScale = keyMode ? Math.max(1, cc.notes.length * 0.4) : Math.max(1, (cc.high - cc.low) * 0.4);
    // the signature comes from the creature seed alone, so it's the same animal in every pond
    cc.signature = generateMotif(cc, new Rng(hash(c.seed, tag('signature'))));
    return cc;
  }

  // ---------- motifs ----------
  function evolveAt(kind, u) {
    switch (kind) {
      case 'rise': return u;
      case 'fall': return -u;
      case 'arc': return Math.sin(Math.PI * u);
      default: return 0;
    }
  }

  function generateMotif(cc, rng) {
    const V = cc.V;
    const n = valueAt('lin', 1, cc.units[0], cc.units[1], rng.next());
    const amt = cc.evolveAmount;
    const ev = amt > 0 ? cc.evolve : 'steady';
    const moving = ev !== 'steady';
    const base = new Float64Array(V), dir = moving ? new Int8Array(V) : null;
    for (let j = 0; j < V; j++) { base[j] = rng.next(); if (moving) dir[j] = rng.sign(); }
    const lenBase = rng.next(), gapBase = rng.next();
    const morph = cc.morph;
    const units = new Array(n);
    let walk = 0;
    for (let i = 0; i < n; i++) {
      const u = n > 1 ? i / (n - 1) : 0;
      let g;
      if (ev === 'wander') { if (i > 0) walk = clamp(walk + rng.gauss() * 0.4, -1, 1); g = walk; }
      else g = evolveAt(ev, u);
      let step = moving ? g * amt * cc.stepScale : 0;
      if (i > 0 && rng.chance(0.25)) step += rng.sign() * (cc.keyMode ? 1 : 1.5);   // small turns
      if (cc.keyMode) step = Math.round(step);
      const p0 = new Float64Array(V);
      const pull = moving ? g * amt * 0.6 : 0;
      for (let j = 0; j < V; j++) p0[j] = clamp01(base[j] + (moving ? dir[j] * pull : 0) + rng.gauss() * 0.05);
      let p1 = p0;
      if (morph > 0 && V > 0 && rng.chance(morph)) {
        p1 = new Float64Array(V);
        for (let j = 0; j < V; j++) p1[j] = clamp01(p0[j] + rng.gauss() * 0.35);
      }
      units[i] = {
        len: clamp01(lenBase + rng.gauss() * 0.15),
        gap: clamp01(gapBase + rng.gauss() * 0.2),
        contour: rng.next(),
        step, p0, p1,
      };
    }
    return { keys: cc.vKey, units, atk: rng.next(), rel: rng.next(), key: cc.keyMode };
  }

  // A changed copy. amount 0 returns the same motif (nothing is copied).
  function mutate(m, amount, rng, maxUnits) {
    if (!(amount > 0)) return m;
    const j = amount * 0.25;
    const units = m.units.map(u => {
      const p0 = Float64Array.from(u.p0, x => clamp01(x + rng.gauss() * j));
      const p1 = u.p1 === u.p0 ? p0 : Float64Array.from(u.p1, x => clamp01(x + rng.gauss() * j));
      return {
        len: clamp01(u.len + rng.gauss() * j), gap: clamp01(u.gap + rng.gauss() * j),
        contour: clamp01(u.contour + rng.gauss() * j), step: u.step, p0, p1,
      };
    });
    if (rng.chance(amount * 0.5)) {
      const u = units[rng.int(0, units.length - 1)];
      u.step += m.key ? rng.sign() : rng.gauss() * 1.5;
    }
    if (units.length < (maxUnits || 32) && rng.chance(amount * 0.25)) {
      const k = rng.int(0, units.length - 1), u = units[k];
      units.splice(k + 1, 0, { len: u.len, gap: u.gap, contour: u.contour, step: u.step, p0: u.p0, p1: u.p1 });
    }
    if (units.length > 1 && rng.chance(amount * 0.25)) units.splice(rng.int(0, units.length - 1), 1);
    return {
      keys: m.keys, units, key: m.key,
      atk: clamp01(m.atk + rng.gauss() * j), rel: clamp01(m.rel + rng.gauss() * j),
    };
  }

  // ---------- realise ----------
  // ctx: { harmonise, sounding: [MIDI notes heard right now], register: offset (steps in key, semitones free) }
  function realise(cc, motif, t0, ctx, rng, kind) {
    ctx = ctx || {};
    const V = cc.V, units = motif.units, n = units.length;
    // map the motif's parameters onto ours; parameters it doesn't have follow its unit's overall position
    let idx = null;
    if (motif.keys !== cc.vKey) {
      idx = new Int16Array(V);
      for (let j = 0; j < V; j++) idx[j] = motif.keys.indexOf(cc.vKey[j]);
    }

    // pitch: fit the steps into our range, pick where the call starts
    let minS = Infinity, maxS = -Infinity;
    for (const u of units) { if (u.step < minS) minS = u.step; if (u.step > maxS) maxS = u.step; }
    const anchors = new Float64Array(n);
    const reg = ctx.register || 0;
    if (cc.keyMode) {
      const N = cc.notes.length;
      let squeeze = 1;
      if (maxS - minS > N - 1) squeeze = (N - 1) / (maxS - minS);
      const st = new Int32Array(n);
      for (let i = 0; i < n; i++) st[i] = Math.round((units[i].step - minS) * squeeze);
      let top = 0;
      for (let i = 0; i < n; i++) if (st[i] > top) top = st[i];
      const lastStart = N - 1 - top;                         // start index range [0, lastStart]
      let s;
      if (ctx.harmonise && ctx.sounding && ctx.sounding.length && lastStart > 0) {
        const w = new Float64Array(lastStart + 1);
        const off = st[0];
        for (let k = 0; k <= lastStart; k++) {
          let sum = 0;
          for (const h of ctx.sounding) sum += S.consonance(cc.notes[k + off], h);
          const m = sum / ctx.sounding.length;
          w[k] = 0.01 + m * m * m * m;         // steep: Harmonise should clearly harmonise
        }
        s = rng.weighted(w, lastStart + 1);
      } else s = rng.int(0, lastStart);
      if (reg) s = clamp(s + Math.round(reg), 0, lastStart);
      for (let i = 0; i < n; i++) anchors[i] = cc.notes[s + st[i]];
    } else {
      let squeeze = 1;
      const span = cc.high - cc.low;
      if (maxS - minS > span) squeeze = span / (maxS - minS);
      const lo = cc.low - minS * squeeze, hi = cc.high - maxS * squeeze;
      const start = clamp(rng.range(lo, Math.max(lo, hi)) + reg, lo, Math.max(lo, hi));
      for (let i = 0; i < n; i++) anchors[i] = start + units[i].step * squeeze;
    }

    const attack = valueAt('log', 0, cc.attack[0], cc.attack[1], motif.atk);
    const release = valueAt('log', 0, cc.release[0], cc.release[1], motif.rel);
    const out = new Array(n);
    let t = t0;
    const snapDolphin = cc.keyMode && (cc.iRate >= 0 || cc.iFree >= 0 || cc.iWt >= 0);
    for (let i = 0; i < n; i++) {
      const u = units[i];
      const note = anchors[i];
      let noteEnd = note + (cc.cLo === cc.cHi ? cc.cLo : cc.cLo + (cc.cHi - cc.cLo) * u.contour);
      if (cc.keyMode) noteEnd = cc.pitch.snap(noteEnd);
      noteEnd = clamp(noteEnd, PITCH_LO, PITCH_HI);
      const dur = valueAt('log', 0, cc.unitLength[0], cc.unitLength[1], u.len);
      const gap = cc.legato ? 0 : valueAt('sq', 0, cc.gap[0], cc.gap[1], u.gap);

      const v0 = new Float32Array(V);
      const morphs = u.p1 !== u.p0;
      const v1 = morphs ? new Float32Array(V) : v0;
      let energy = -1;
      for (let j = 0; j < V; j++) {
        let q0, q1;
        const k = idx ? idx[j] : j;
        if (k >= 0) { q0 = u.p0[k]; q1 = u.p1[k]; }
        else {
          if (energy < 0) { energy = 0; for (let q = 0; q < u.p0.length; q++) energy += u.p0[q]; energy = u.p0.length ? energy / u.p0.length : 0.5; }
          q0 = q1 = clamp01(energy + rng.gauss() * 0.15);
        }
        const s = cc.vSpec[j];
        v0[j] = valueAt(s.scale, s.step, cc.vLo[j], cc.vHi[j], q0);
        if (morphs) v1[j] = valueAt(s.scale, s.step, cc.vLo[j], cc.vHi[j], q1);
      }
      if (snapDolphin) { snapPulse(cc, v0, note); if (morphs) snapPulse(cc, v1, note); }
      out[i] = { t, dur, note, noteEnd, v0, v1 };
      t += dur + (i < n - 1 ? gap : 0);
    }
    const last = out[n - 1];
    return {
      t: t0, end: last.t + last.dur, tail: last.t + last.dur + release,
      attack, release, legato: cc.legato, kind: kind || 'fresh', motif, units: out,
    };
  }

  // in key mode, dolphin pulse rates heard as pitch, and the whistle transpose, land on the scale
  function snapPulse(cc, v, note) {
    const kt = cc.iKeytrack >= 0 ? v[cc.iKeytrack] : cc.lockedValue['dolphin.keytrack'];
    const keytrack = kt === undefined ? true : kt >= 0.5;
    if (keytrack && cc.iRate >= 0) {
      const r = v[cc.iRate];
      if (mtof(note) * Math.pow(2, r) > PULSE_PITCH_HZ) v[cc.iRate] = clamp((cc.pitch.snap(note + 12 * r) - note) / 12, -6, 2);
    } else if (!keytrack && cc.iFree >= 0) {
      const f = v[cc.iFree];
      if (f > PULSE_PITCH_HZ) v[cc.iFree] = clamp(mtof(cc.pitch.snap(ftom(f))), 1, 2000);
    }
    if (cc.iWt >= 0) v[cc.iWt] = clamp(cc.pitch.snap(note + v[cc.iWt]) - note, -24, 24);
  }

  // ---------- a creature that calls ----------
  class Caller {
    constructor(creature, pitch, rng) {
      this.cc = compile(creature, pitch);
      this.rng = rng;
    }
    // a call of its own: its signature (varied) or a fresh one
    call(t, ctx) {
      const cc = this.cc, rng = this.rng;
      if (rng.chance(cc.sigAmount)) return realise(cc, mutate(cc.signature, cc.sigVariation, rng, cc.units[1]), t, ctx, rng, 'signature');
      return realise(cc, generateMotif(cc, rng), t, ctx, rng, 'fresh');
    }
    // an answer to a heard motif: a changed copy with Mimicry's odds, otherwise a call of its own
    answer(t, heard, ctx) {
      const cc = this.cc, rng = this.rng;
      if (heard && rng.chance(cc.mimicry)) {
        return realise(cc, mutate(heard, Math.max(0.15, cc.sigVariation), rng, cc.units[1]), t, ctx, rng, 'copy');
      }
      return this.call(t, ctx);
    }
    rest(density) {
      const r = valueAt('log', 0, this.cc.rest[0], this.cc.rest[1], this.rng.next());
      return density > 0 ? r / density : r;
    }
  }

  // ---------- a single creature on its own ----------
  // Preview score for the creature page and solo renders. Alone, a creature imitates itself:
  // with half its Mimicry it answers its own previous call.
  function soloScore(creature, opts) {
    opts = opts || {};
    const pitch = opts.pitch && opts.pitch.snap ? opts.pitch : S.makePitch(opts.pitch);
    const seconds = opts.seconds > 0 ? opts.seconds : 60;
    const seed = (opts.seed >>> 0) || 1;
    const rng = new Rng(hash(seed, tag('slot'), 0, 0));
    const caller = new Caller(creature, pitch, rng);
    const cc = caller.cc;
    const calls = [];
    let t = rng.range(0, Math.min(2, cc.rest[0])), prev = null;
    while (t < seconds) {
      const call = prev && rng.chance(cc.mimicry * 0.5) ? caller.answer(t, prev.motif, {}) : caller.call(t, {});
      if (call.kind === 'copy') call.of = calls.length - 1;
      calls.push(call);
      prev = call;
      t = call.end + caller.rest(1);
    }
    return {
      format: 'krill-score', version: 1, seconds, seed, pitch: pitch.label,
      slots: [slotInfo(cc)],
      calls: calls.map(c => { c.slot = 0; return c; }),
    };
  }

  function slotInfo(cc) {
    return { name: cc.name, source: cc.source, mouth: cc.mouth, vary: cc.vKey, locked: cc.locked, fixed: cc.fixed };
  }

  // plain JSON form of a score (typed arrays become arrays, motifs dropped)
  function scoreToJSON(score) {
    return JSON.stringify(score, (k, v) => {
      if (k === 'motif') return undefined;
      if (v instanceof Float32Array || v instanceof Float64Array) return Array.from(v, x => Math.round(x * 1e5) / 1e5);
      if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1e5) / 1e5;
      return v;
    });
  }

  const api = { compile, generateMotif, mutate, realise, Caller, soloScore, slotInfo, scoreToJSON, mtof, ftom };
  if (inNode) module.exports = api;
  else K.roll = api;
})(typeof self !== 'undefined' ? self : this);
