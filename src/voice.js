/*
 * krill · one creature's voice
 *
 * Plays one slot's calls: source → body → optional low-pass → pan, into the stereo mix. The
 * source and body come from parts.js, so nothing here names an engine. Everything runs in the
 * engines' own 32-sample blocks, so the sound doesn't depend on how the caller chunks the output.
 *
 *   pitch   the source holds one MIDI note and moves it with its setOffset (Throat: Transpose +
 *           Detune, ±25 st; Dolphin: bend, ±48 st). When a legato line goes further than the
 *           source's reach, the voice re-bases onto a new held note in the same block, so the
 *           pitch stays continuous.
 *   filter  optional fixed low-pass at the end (24 dB/oct Butterworth), set per creature;
 *           off costs nothing.
 *   params  sent only when their value changes: once at a unit's start, then per block only
 *           for units that Morph.
 *   silence a voice with nothing sounding and its tail decayed isn't processed at all
 *           (source, body, filter and panning are skipped; block() returns false).
 *
 * Works in the browser (Krill.voice) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const E = inNode ? require('./engines.js') : K.engines;
  const PARTS = inNode ? require('./parts.js') : K.parts;
  const { hash, tag } = inNode ? require('./rng.js') : K.rng;
  const PAN = inNode ? require('./pan.js') : K.pan;

  const B = E.BLOCK;
  const TAIL_PAD = 0.75;          // s after a call's release before the voice may sleep (engine + tube ring-out)
  const LEGATO_GLIDE = 0.08;      // s, glide into the next unit of a legato call
  const BUTTER_Q = [0.5411961, 1.3065630];     // two biquads = 4th-order Butterworth low-pass

  // RBJ low-pass biquad coefficients [b0, b1, b2, a1, a2] (a0 normalised)
  function lowpass(f, q, sr) {
    const w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    const b1 = (1 - cs) / a0;
    return [b1 / 2, b1, b1 / 2, -2 * cs / a0, (1 - al) / a0];
  }

  function smooth(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }

  class Voice {
    // slot: a score slot (roll.slotInfo); calls: that slot's calls in time order
    // opts: { sampleRate, seed (slot stream), width (0–1, pond Width), pan, wander, level (dB) }
    constructor(slot, calls, opts) {
      const sr = opts.sampleRate;
      this.sr = sr;
      this.bdt = B / sr;
      const eseed = hash(opts.seed >>> 0, tag('engine'));
      const srcPart = PARTS.SOURCES[slot.source], bodyPart = PARTS.BODIES[slot.body || 'none'];
      this.src = srcPart.create(sr, eseed);
      this.body = bodyPart.create(sr);                 // null for no body
      this.srcNs = srcPart.ns;
      this.lim = this.src.reach;

      // set once: the creature's locked values (each part sets its own fixed ones)
      for (const l of slot.locked) this.send(l.engine === this.srcNs ? 0 : 1, l.id, l.value);
      if (this.body) this.body.snap();

      // varying parameters: where each one goes
      const V = slot.vary.length;
      this.V = V;
      this.vTube = new Uint8Array(V);
      this.vId = new Array(V);
      this.vStep = new Uint8Array(V);
      this.last = new Float64Array(V).fill(NaN);
      slot.vary.forEach((key, j) => {
        const dot = key.indexOf('.');
        this.vTube[j] = key.slice(0, dot) === this.srcNs ? 0 : 1;     // 0 source, 1 body
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
      this.awakeUntil = -1;      // block until which the voice must keep processing

      // output: the creature's level, plus what the parts took off for headroom, plus calibration
      const comp = this.src.makeupDb + (this.body ? this.body.makeupDb : 0) + (PARTS.CALIBRATION_DB[slot.source + '+' + (slot.body || 'none')] || 0);
      this.gain = Math.pow(10, ((opts.level == null ? 0 : opts.level) + comp) / 20);
      this.srcPeak = 0;          // largest source/body output sample: must stay well below 1 (their clamps)
      // optional low-pass: coefficients once, state per stage
      const f = slot.filter;
      this.lp = null;
      if (f && f.on && f.cutoff < 0.45 * sr) {
        this.lp = BUTTER_Q.map(q => lowpass(f.cutoff, q, sr));
        this.lpZ = new Float64Array(4);
      }
      this.home = opts.pan || 0;
      this.wander = opts.wander || 0;
      this.width = opts.width == null ? 1 : opts.width;
      this.panSeed = PAN.wanderSeed(opts.seed);
      this.lean = 0; this.leanTarget = 0;
      this.callGain = 1; this.callGainTarget = 1;
      this.gainK = 1 - Math.exp(-B / (0.05 * sr));   // a call's loudness eases in over about 50 ms
      this.leanK = 1 - Math.exp(-B / (0.6 * sr));    // the lean moves over about half a second
      this.a = new Float32Array(B);
      this.oL = new Float32Array(B);
      this.blocks = 0;           // blocks actually processed (for the bench)
    }

    send(target, id, v) {
      if (target === 1) { if (this.body) this.body.set(id, v); }
      else this.src.set(id, v);
    }

    noteOn(n) { this.src.noteOn(n); }
    noteOff(n) { this.src.noteOff(n); }
    setOffset(off) { this.src.setOffset(off); }

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
      this.leanTarget = call.c.lean || 0;          // answers lean away from their caller
      this.callGainTarget = call.c.gainDb ? Math.pow(10, call.c.gainDb / 20) : 1;   // lane loudness range
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
      this.src.render(a, B);
      let src = a;
      if (this.body) { this.body.process(a, this.oL, B); src = this.oL; }
      let pk = this.srcPeak;
      for (let i = 0; i < B; i++) { const x = src[i] < 0 ? -src[i] : src[i]; if (x > pk) pk = x; }
      this.srcPeak = pk;
      if (this.lp) {
        const z = this.lpZ;
        for (let s = 0; s < 2; s++) {
          const [b0, b1, b2, a1, a2] = this.lp[s];
          let z1 = z[2 * s], z2 = z[2 * s + 1];
          for (let i = 0; i < B; i++) {            // transposed direct form II
            const x = src[i], y = b0 * x + z1;
            z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y;
            src[i] = y;
          }
          z[2 * s] = z1; z[2 * s + 1] = z2;
        }
      }
      // pan: equal power around home, wandering slowly
      let pan = PAN.wanderAt(this.panSeed, this.home, this.wander, b * this.bdt);
      if (this.lean !== this.leanTarget) {
        this.lean += (this.leanTarget - this.lean) * this.leanK;
        if (Math.abs(this.lean - this.leanTarget) < 1e-4) this.lean = this.leanTarget;
      }
      pan += this.lean;
      if (this.callGain !== this.callGainTarget) {
        this.callGain += (this.callGainTarget - this.callGain) * this.gainK;
        if (Math.abs(this.callGain - this.callGainTarget) < 1e-5) this.callGain = this.callGainTarget;
      }
      pan = PAN.place(pan, this.width);
      const th = (pan + 1) * Math.PI / 4, g = this.gain * this.callGain, gl = Math.cos(th) * g, gr = Math.sin(th) * g;
      for (let i = 0; i < B; i++) { const x = src[i]; outL[i] += x * gl; outR[i] += x * gr; }
      return true;
    }

    get done() { return !this.cur && this.ci >= this.calls.length; }
  }

  const api = { Voice, noise: PAN.noise, TAIL_PAD, lowpass };
  if (inNode) module.exports = api;
  else K.voice = api;
})(typeof self !== 'undefined' ? self : this);
