/*
 * krill · one creature's voice
 *
 * Plays one slot's calls on its own engine (Throat or Dolphin), optionally through mouth-tube,
 * then pans it into the stereo mix. Everything runs in the engines' own 32-sample blocks, so the
 * sound doesn't depend on how the caller chunks the output.
 *
 *   pitch   the engine holds one MIDI note; Krill moves it with Throat's Transpose + Detune
 *           (±25 st) or Dolphin's bend (±48 st). When a legato line goes further, the voice
 *           re-bases onto a new held note in the same block, so the pitch stays continuous.
 *   params  sent only when their value changes: once at a unit's start, then per block only
 *           for units that Morph.
 *   silence a voice with nothing sounding and its tail decayed isn't processed at all
 *           (engine, tube and panning are skipped; block() returns false).
 *
 * Works in the browser (Krill.voice) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const E = inNode ? require('./engines.js') : K.engines;
  const { hash, tag } = inNode ? require('./rng.js') : K.rng;

  const B = E.BLOCK;
  const TAIL_PAD = 0.75;          // s after a call's release before the voice may sleep (engine + tube ring-out)
  const THROAT_LIM = 25, DOLPHIN_LIM = 48;     // pitch offset reach before re-basing (semitones)
  const LEGATO_GLIDE = 0.08;      // s, glide into the next unit of a legato call
  // The tube can add 20 dB or more of peak gain (clicks ringing its resonances), so it's fed this
  // much lower and the voice adds it back afterwards. It's linear, so only headroom changes.
  const TUBE_TRIM_DB = -24;
  const TUBE_TRIM = Math.pow(10, TUBE_TRIM_DB / 20);
  // Loudness calibration per species, so Level 0 means roughly the same loudness for all four
  // (about -20 dBFS RMS while calling, for the species defaults). Measured with
  // tools/calibrate.js; re-measure if an engine is updated.
  const CALIBRATION_DB = { throat: 4.7, 'throat+tube': -7.4, dolphin: -0.6, 'dolphin+tube': -32.1 };

  function smooth(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }

  // value noise in -1..1, a function of time only (no state, so chunking can't change it)
  function noise(seed, t, period) {
    const x = t / period, k = Math.floor(x), f = x - k;
    const a = hash(seed, k) / 2147483648 - 1, b = hash(seed, k + 1) / 2147483648 - 1;
    const u = 0.5 - 0.5 * Math.cos(Math.PI * f);
    return a + (b - a) * u;
  }

  class Voice {
    // slot: a score slot (roll.slotInfo); calls: that slot's calls in time order
    // opts: { sampleRate, seed (slot stream), width (0–1, pond Width), pan, wander, level (dB) }
    constructor(slot, calls, opts) {
      const sr = opts.sampleRate;
      this.sr = sr;
      this.bdt = B / sr;
      this.throat = slot.source === 'throat';
      const eseed = hash(opts.seed >>> 0, tag('engine'));
      this.eng = this.throat ? new E.ThroatEngine(sr, eseed) : new E.DolphinEngine(sr, eseed);
      this.tube = slot.mouth ? new E.MouthTube(sr) : null;
      this.lim = this.throat ? THROAT_LIM : DOLPHIN_LIM;

      // set once: Krill's fixed values, then the creature's locked ones
      for (const f of slot.fixed) this.send(f.engine === 'mouth' ? 1 : 0, f.id, f.value);
      for (const l of slot.locked) this.send(l.engine === 'mouth' ? 1 : 0, l.id, l.value);
      this.send(0, 'glide', 0);
      this.send(0, 'detune', 0);
      if (this.throat) this.send(0, 'transpose', 0);
      if (this.tube) this.tube.snap();

      // varying parameters: where each one goes
      const V = slot.vary.length;
      this.V = V;
      this.vTube = new Uint8Array(V);
      this.vId = new Array(V);
      this.vStep = new Uint8Array(V);
      this.last = new Float64Array(V).fill(NaN);
      slot.vary.forEach((key, j) => {
        const dot = key.indexOf('.');
        this.vTube[j] = key.slice(0, dot) === 'mouth' ? 1 : 0;
        this.vId[j] = key.slice(dot + 1);
        this.vStep[j] = slot.varyStep ? slot.varyStep[j] : 0;
      });

      // timeline in blocks
      this.calls = calls.map(c => {
        const units = c.units.map(u => ({
          u, sb: Math.round(u.t * sr / B), eb: Math.max(Math.round(u.t * sr / B) + 1, Math.round((u.t + u.dur) * sr / B)),
        }));
        return { c, units, sb: units[0].sb, quiet: Math.ceil((c.tail + TAIL_PAD) * sr / B) };
      });
      this.ci = 0;               // next call to start
      this.cur = null;           // the call playing
      this.ui = -1;              // its current unit
      this.unitOn = false;
      this.held = -1;            // MIDI note held by the engine
      this.lastOff = NaN;
      this.awakeUntil = -1;      // block until which the voice must keep processing

      // output: the creature's level, plus back what was taken off for headroom inside the engines
      let comp = 0;
      for (const f of slot.fixed) if (f.headroom) comp -= f.value;
      if (this.tube) comp -= TUBE_TRIM_DB;
      comp += CALIBRATION_DB[slot.source + (slot.mouth ? '+tube' : '')] || 0;
      this.gain = Math.pow(10, ((opts.level == null ? 0 : opts.level) + comp) / 20);
      this.srcPeak = 0;          // largest engine/tube output sample: must stay well below 1
      this.home = opts.pan || 0;
      this.wander = opts.wander || 0;
      this.width = opts.width == null ? 1 : opts.width;
      this.panSeed = hash(opts.seed >>> 0, tag('pan'));
      this.panPeriod = 6 + 24 * (1 - this.wander);
      this.a = new Float32Array(B); this.b = new Float32Array(B);
      this.oL = new Float32Array(B); this.oR = new Float32Array(B);
      this.blocks = 0;           // blocks actually processed (for the bench)
    }

    send(target, id, v) {
      if (target === 1) { if (this.tube) this.tube.setParam(id, v); }
      else this.eng.setParam(id, v);
    }

    noteOn(n) { this.eng.noteOn(n, 100); }
    noteOff(n) { this.eng.noteOff(n); }

    // pitch offset from the held note: Throat Transpose + Detune, Dolphin bend
    setOffset(off) {
      if (off === this.lastOff) return;
      this.lastOff = off;
      if (this.throat) {
        const t = off > 24 ? 24 : off < -24 ? -24 : off;
        this.eng.setParam('transpose', t);
        this.eng.setParam('detune', (off - t) * 100);
      } else this.eng.setBend(off / DOLPHIN_LIM);
    }

    // move to an absolute pitch, re-basing the held note when the offset runs out of reach
    pitch(p) {
      let off = p - this.held;
      if (off > this.lim - 1 || off < -(this.lim - 1)) {
        const base = Math.round(p), old = this.held;
        this.noteOn(base);          // legato: no re-attack, glide is 0, so it jumps...
        this.noteOff(old);          // ...and the old note leaves the mono stack
        this.held = base;
        off = p - base;
      }
      this.setOffset(off);
    }

    params(u, frac, force) {
      const V = this.V, v0 = u.v0, v1 = u.v1, morph = v1 !== v0, last = this.last;
      if (!morph && !force) return;
      for (let j = 0; j < V; j++) {
        let v = v0[j];
        if (morph) v = this.vStep[j] ? (frac < 0.5 ? v0[j] : v1[j]) : v0[j] + (v1[j] - v0[j]) * frac;
        if (v !== last[j]) { last[j] = v; this.send(this.vTube[j], this.vId[j], v); }
      }
    }

    startCall(k) {
      const call = this.calls[k];
      this.cur = call; this.ui = -1; this.unitOn = false;
      this.send(0, 'attack', call.c.attack);
      this.send(0, 'release', call.c.release);
      if (call.quiet > this.awakeUntil) this.awakeUntil = call.quiet;
    }

    startUnit(i) {
      const call = this.cur, U = call.units[i], u = U.u;
      this.ui = i;
      this.params(u, 0, true);
      if (i === 0 || !call.c.legato) {
        if (this.held >= 0) this.noteOff(this.held);
        this.held = Math.round(u.note);
        this.lastOff = NaN;
        this.setOffset(u.note - this.held);
        this.noteOn(this.held);
      }
      this.unitOn = true;
    }

    // control for block b inside the current unit
    control(b) {
      const call = this.cur, U = call.units[this.ui], u = U.u;
      const t = (b - U.sb) * this.bdt;
      const frac = u.dur > 0 ? Math.min(1, t / u.dur) : 1;
      let p = u.note + (u.noteEnd - u.note) * smooth(frac);
      if (call.c.legato && this.ui > 0) {
        const prev = call.units[this.ui - 1].u.noteEnd;
        const g = Math.min(LEGATO_GLIDE, u.dur * 0.3);
        if (t < g) p += (prev - u.note) * (1 - smooth(t / g));
      }
      this.pitch(p);
      this.params(u, frac, false);
    }

    events(b) {
      if (!this.cur && this.ci < this.calls.length && this.calls[this.ci].sb <= b) this.startCall(this.ci++);
      const call = this.cur;
      if (!call) return;
      const units = call.units, legato = call.c.legato;
      while (this.ui + 1 < units.length && units[this.ui + 1].sb <= b) this.startUnit(this.ui + 1);
      if (this.ui < 0) return;
      const U = units[this.ui];
      if (this.unitOn && b >= U.eb) {
        const lastUnit = this.ui === units.length - 1;
        if (!legato || lastUnit) { this.noteOff(this.held); this.held = -1; this.unitOn = false; }
        if (lastUnit) { this.cur = null; this.unitOn = false; }
        else if (legato) this.control(b);      // hold the end pitch until the next unit starts
      } else if (this.unitOn) this.control(b);
    }

    // render block b and add it into outL/outR; false when the voice is asleep (nothing done)
    block(b, outL, outR) {
      this.events(b);                                   // starts the next call when it's due
      if (!this.cur && b >= this.awakeUntil) return false;   // asleep: nothing sounding, tail decayed
      this.blocks++;
      const a = this.a;
      if (this.throat) this.eng.process(a, B);
      else {
        const r = this.b;
        this.eng.process(a, r, B);
        for (let i = 0; i < B; i++) a[i] = (a[i] + r[i]) * 0.5;
      }
      let src = a;
      if (this.tube) {
        for (let i = 0; i < B; i++) a[i] *= TUBE_TRIM;
        this.tube.process(a, null, this.oL, this.oR, B); src = this.oL;
      }
      let pk = this.srcPeak;
      for (let i = 0; i < B; i++) { const x = src[i] < 0 ? -src[i] : src[i]; if (x > pk) pk = x; }
      this.srcPeak = pk;
      // pan: equal power around home, wandering slowly
      let pan = this.home;
      if (this.wander > 0) pan += this.wander * noise(this.panSeed, b * this.bdt, this.panPeriod);
      pan = (pan > 1 ? 1 : pan < -1 ? -1 : pan) * this.width;
      const th = (pan + 1) * Math.PI / 4, g = this.gain, gl = Math.cos(th) * g, gr = Math.sin(th) * g;
      for (let i = 0; i < B; i++) { const x = src[i]; outL[i] += x * gl; outR[i] += x * gr; }
      return true;
    }

    get done() { return !this.cur && this.ci >= this.calls.length; }
  }

  const api = { Voice, noise, TAIL_PAD, CALIBRATION_DB, TUBE_TRIM_DB };
  if (inNode) module.exports = api;
  else K.voice = api;
})(typeof self !== 'undefined' ? self : this);
