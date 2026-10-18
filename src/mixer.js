/*
 * krill · mixing and rendering
 *
 *   Limiter   block-based lookahead peak limiter. Gain is decided per 32-sample block from the
 *             peaks of the next few blocks and ramped linearly inside each block, so no sample
 *             passes the ceiling and quiet material is left exactly as it was (gain 1).
 *   Render    pulls voices block by block, sums them, applies master level, the limiter and the
 *             fades, and hands out exactly `frames` stereo frames in any chunk size. Sleeping
 *             voices cost nothing.
 *   soloRender  a creature's solo score → Render (the creature page and `tools/render.js`).
 *
 * Works in the browser (Krill.mixer) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const E = inNode ? require('./engines.js') : K.engines;
  const { Voice } = inNode ? require('./voice.js') : K.voice;
  const PAN = inNode ? require('./pan.js') : K.pan;
  const R = inNode ? require('./roll.js') : K.roll;
  const S = inNode ? require('./scales.js') : K.scales;
  const { hash, tag } = inNode ? require('./rng.js') : K.rng;
  const VER = inNode ? require('./version.js') : K.version;

  const B = E.BLOCK;
  const LOOK = 4;                       // lookahead, blocks (2.7 ms at 48 kHz)

  function db(x) { return 20 * Math.log10(x); }

  class Limiter {
    constructor(sampleRate, ceilingDb) {
      this.ceil = ceilingDb == null ? -1 : ceilingDb;
      this.atk = 1.5;                                          // dB per block of lookahead
      this.rel = 6 / (0.3 * sampleRate / B);                   // dB per block: 6 dB in 300 ms
      const N = LOOK + 2;
      this.N = N;
      this.L = []; this.R = [];
      for (let i = 0; i < N; i++) { this.L.push(new Float32Array(B)); this.R.push(new Float32Array(B)); }
      this.req = new Float64Array(N);     // required gain (dB, ≤ 0) of each queued block
      this.count = 0;                     // blocks pushed
      this.bnd = 0;                       // gain (dB) at the start of the next output block
      this.maxReduction = 0;
    }
    // push one block; returns true when an output block is ready in outL/outR
    push(inL, inR, outL, outR) {
      const N = this.N, k = this.count % N;
      this.L[k].set(inL); this.R[k].set(inR);
      let pk = 0;
      for (let i = 0; i < B; i++) { const a = Math.abs(inL[i]), c = Math.abs(inR[i]); if (a > pk) pk = a; if (c > pk) pk = c; }
      this.req[k] = pk > 0 ? Math.min(0, this.ceil - db(pk)) : 0;
      this.count++;
      const o = this.count - 1 - (LOOK + 1);              // output block index
      if (o < 0) return false;
      // boundary o+1 (end of block o): limited by blocks o+1 … o+1+LOOK, with an attack slope
      const reqAt = i => this.req[((i % N) + N) % N];
      let end = this.bnd + this.rel;
      if (end > 0) end = 0;
      for (let j = 0; j <= LOOK; j++) {
        const i = o + 1 + j;
        const c = Math.min(reqAt(i - 1), reqAt(i)) + j * this.atk;
        if (c < end) end = c;
      }
      const start = Math.min(this.bnd, reqAt(o));          // never above what block o needs
      const g0 = Math.pow(10, start / 20), g1 = Math.pow(10, Math.min(end, reqAt(o)) / 20);
      this.bnd = end;
      if (-start > this.maxReduction) this.maxReduction = -start;
      const L = this.L[o % N], Rr = this.R[o % N];
      if (g0 === 1 && g1 === 1) { outL.set(L); outR.set(Rr); return true; }
      const d = (g1 - g0) / B;
      for (let i = 0; i < B; i++) { const g = g0 + d * (i + 1); outL[i] = L[i] * g; outR[i] = Rr[i] * g; }
      return true;
    }
  }

  class Render {
    // voices: Voice[]; opts: { sampleRate, frames, level (dB), fadeIn, fadeOut (s), ceiling (dB) }
    constructor(voices, opts) {
      this.voices = voices;
      this.sr = opts.sampleRate;
      this.frames = opts.frames;
      this.gain = Math.pow(10, (opts.level || 0) / 20);
      this.fadeIn = Math.max(0, Math.round((opts.fadeIn || 0) * this.sr));
      this.fadeOut = Math.max(0, Math.round((opts.fadeOut || 0) * this.sr));
      this.lim = new Limiter(this.sr, opts.ceiling);
      this.mixL = new Float32Array(B); this.mixR = new Float32Array(B);
      this.outL = new Float32Array(B); this.outR = new Float32Array(B);
      this.b = 0;                 // next block to synthesise
      this.pos = 0;               // frames handed out
      this.have = 0; this.at = 0; // ready samples in outL/outR and read position
      this.peak = 0;              // before the limiter
      this.blocksTotal = 0;
    }
    get done() { return this.pos >= this.frames; }
    get progress() { return this.frames ? this.pos / this.frames : 1; }

    synth() {
      const mL = this.mixL, mR = this.mixR;
      while (true) {
        mL.fill(0); mR.fill(0);
        const b = this.b++;
        for (const v of this.voices) v.block(b, mL, mR);
        this.blocksTotal++;
        const g = this.gain;
        let pk = this.peak;
        for (let i = 0; i < B; i++) {
          const l = mL[i] * g, r = mR[i] * g; mL[i] = l; mR[i] = r;
          const a = l < 0 ? -l : l, c = r < 0 ? -r : r;
          if (a > pk) pk = a; if (c > pk) pk = c;
        }
        this.peak = pk;
        if (this.lim.push(mL, mR, this.outL, this.outR)) { this.have = B; this.at = 0; return; }
      }
    }

    // fill up to n frames; returns how many were written (0 when finished)
    read(L, R, n) {
      let w = 0;
      while (w < n && this.pos < this.frames) {
        if (this.at >= this.have) this.synth();
        let k = Math.min(n - w, this.have - this.at, this.frames - this.pos);
        const oL = this.outL, oR = this.outR, fi = this.fadeIn, fo = this.fadeOut, F = this.frames;
        for (let i = 0; i < k; i++) {
          const p = this.pos + i;
          let g = 1;
          if (p < fi) g = 0.5 - 0.5 * Math.cos(Math.PI * p / fi);
          const left = F - 1 - p;
          if (left < fo) g *= 0.5 - 0.5 * Math.cos(Math.PI * left / fo);
          let l = oL[this.at + i] * g, r = oR[this.at + i] * g;
          L[w + i] = l > 1 ? 1 : l < -1 ? -1 : l;
          R[w + i] = r > 1 ? 1 : r < -1 ? -1 : r;
        }
        this.at += k; this.pos += k; w += k;
      }
      return w;
    }

    stats() {
      return {
        peakDb: this.peak > 0 ? db(this.peak) : -Infinity,
        maxReductionDb: this.lim.maxReduction,
        awake: this.voices.map(v => v.blocks / Math.max(1, this.blocksTotal)),
        enginePeakDb: this.voices.map(v => v.srcPeak > 0 ? db(v.srcPeak) : -Infinity),
      };
    }
  }

  // ---------- a pond ----------
  // pond: a pond object or file (pond.normalise is applied); opts: { seconds, sampleRate }
  function pondRender(pondIn, opts) {
    opts = opts || {};
    const PD = inNode ? require('./pond.js') : K.pond;
    const CD = inNode ? require('./conductor.js') : K.conductor;
    const pond = PD.normalise(pondIn).pond;
    const sr = opts.sampleRate || 48000;
    const seconds = opts.seconds > 0 ? opts.seconds : pond.output.minutes * 60;
    const score = CD.conduct(pond, { seconds });
    const voices = [];
    score.slots.forEach((slot, i) => {
      if (!slot) return;
      const calls = score.calls.filter(c => c.slot === i);
      voices.push(new Voice(slot, calls, {
        sampleRate: sr, seed: PAN.slotSeed(pond.seed, i, pond.slots[i].rerolls),
        pan: slot.pan, wander: slot.wander, level: slot.level, width: pond.space.width,
      }));
    });
    const fadeIn = Math.min(pond.output.fadeIn, seconds * 0.25), fadeOut = Math.min(pond.output.fadeOut, seconds * 0.25);
    const render = new Render(voices, { sampleRate: sr, frames: Math.round(seconds * sr), level: pond.output.level, fadeIn, fadeOut });
    const meta = { krill: VER.KRILL, engines: VER.ENGINES, kind: 'pond', seed: pond.seed, seconds, sampleRate: sr, pitch: score.pitch, pond };
    return { render, score, meta, pond, fileName: PD.exportName(pond, seconds) + '.wav' };
  }

  // ---------- a creature on its own ----------
  // opts: { seed, seconds, pitch ({mode, root, scale} or makePitch()), sampleRate, level, fadeIn, fadeOut }
  function soloRender(creature, opts) {
    const sr = opts.sampleRate || 48000;
    const seconds = opts.seconds > 0 ? opts.seconds : 60;
    const pitch = opts.pitch && opts.pitch.snap ? opts.pitch : S.makePitch(opts.pitch);
    const seed = (opts.seed >>> 0) || 1;
    const score = R.soloScore(creature, { seed, seconds, pitch });
    const slot = score.slots[0];
    const voice = new Voice(slot, score.calls, {
      sampleRate: sr, seed: hash(seed, tag('slot'), 0, 0),
      pan: slot.pan, wander: slot.wander, level: slot.level, width: 1,
    });
    const fadeIn = opts.fadeIn != null ? opts.fadeIn : Math.min(5, seconds * 0.05);
    const fadeOut = opts.fadeOut != null ? opts.fadeOut : Math.min(20, seconds * 0.1);
    const render = new Render([voice], {
      sampleRate: sr, frames: Math.round(seconds * sr), level: opts.level || 0, fadeIn, fadeOut,
    });
    const meta = {
      krill: VER.KRILL, engines: VER.ENGINES, kind: 'solo', seed, seconds, sampleRate: sr,
      pitch: pitch.label, level: opts.level || 0, fadeIn, fadeOut, creature,
    };
    return { render, score, meta, fileName: fileName(creature.name, seed, seconds) };
  }

  function fileName(name, seed, seconds) {
    const len = seconds >= 60 && seconds % 60 === 0 ? (seconds / 60) + 'm' : Math.round(seconds) + 's';
    const n = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return 'krill_' + (n ? n + '_' : '') + seed + '_' + len + '.wav';
  }

  const api = { Limiter, Render, soloRender, pondRender, fileName, LOOK };
  if (inNode) module.exports = api;
  else K.mixer = api;
})(typeof self !== 'undefined' ? self : this);
