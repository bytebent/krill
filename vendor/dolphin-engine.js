/*
 * Dolphin engine v0.1 · bytebent
 *
 * A cetacean voice: two phonic-lip sources per voice.
 *   - Right lips, pulses: a rate that runs from rhythm (codas, click trains) to pitch (burst pulses),
 *     each pulse a Gaussian-windowed sine burst written at its exact sub-sample time, then a
 *     multipulse comb (echoes inside the head, spacing IPI) and one or two vowel peaks.
 *   - Left lips, whistle: sparse sine partials (no formants), pitch from the note plus a per-note
 *     envelope or a single automatable Pitch knob.
 *   - Biphonation: the whistle is amplitude-modulated at the pulse rate (sidebands at f ± rate).
 *
 * Everything runs at 4x the host rate in fixed 32-sample blocks and is decimated with a
 * windowed-sinc FIR, as in Throat. process() never allocates. Same seed, same notes: same output,
 * at any host buffer size.
 *
 * Works in an AudioWorklet and in Node (module.exports) for offline tests.
 */
(function (root) {
  'use strict';

  const OS = 4;                 // internal oversampling
  const BLOCK = 32;             // fixed internal block (host samples) = latency
  const FIR_LEN = 128;          // decimation filter taps (at 4x rate)
  const MAX_VOICES = 8;
  const MAX_KERNELS = 24;       // overlapping clicks per voice
  const SIGMAS = 3.5;           // click kernel runs ±3.5 standard deviations
  const F_CAP = 16000;          // whistle base pitch is dropped an octave above this
  const TWO_PI = 2 * Math.PI;
  // sine table for the whistle partials and the biphonation wave (linear interpolation, error below -120 dB)
  const SIN_N = 4096;
  const SIN = new Float64Array(SIN_N + 2);
  for (let i = 0; i < SIN_N + 2; i++) SIN[i] = Math.sin(TWO_PI * i / SIN_N);

  // ids, defaults and ranges: the one table the C++ core and the UI copy.
  // log: the knob moves logarithmically; curve: knob position^curve; step: whole steps.
  const PARAMS = [
    { id: 'rate', def: -2, min: -6, max: 2 },           // octaves from the note (key track on)
    { id: 'keytrack', def: 1, min: 0, max: 1, step: 1 },
    { id: 'freerate', def: 13, min: 1, max: 2000, log: true },  // pulses per second (key track off)
    { id: 'sync', def: 0, min: 0, max: 1, step: 1 },
    { id: 'pattern', def: 0, min: 0, max: 3, step: 1 }, // Regular, Increasing, Decreasing, Grouped
    { id: 'coda', def: 0, min: 0, max: 16, step: 1 },   // clicks per coda, 0 = continuous
    { id: 'jitter', def: 0.05, min: 0, max: 1 },
    { id: 'rubato', def: 0, min: 0, max: 1 },
    { id: 'ornament', def: 0, min: 0, max: 1 },
    { id: 'clicktone', def: 0, min: -2, max: 2 },       // octaves from the Size centre
    { id: 'clickwidth', def: 0.1, min: 0.05, max: 0.5, log: true }, // ms (standard deviation)
    { id: 'ring', def: 0, min: 0, max: 1 },
    { id: 'vowel', def: 0, min: 0, max: 1 },            // 0 a (one peak), 1 i (two peaks)
    { id: 'pitchmode', def: 0, min: 0, max: 1, step: 1 },  // 0 envelope, 1 knob
    { id: 'shape', def: 1, min: 0, max: 5, step: 1 },   // Flat, Up, Down, Convex, Concave, Wave
    { id: 'sweep', def: 1.4, min: -3, max: 3 },         // octaves
    { id: 'time', def: 1, min: 0.05, max: 4, curve: 2 },// s
    { id: 'pitch', def: 0, min: -3, max: 3 },           // octaves (knob mode)
    { id: 'wtranspose', def: 0, min: -24, max: 24, step: 1 },  // semitones, whistle only
    { id: 'harmonics', def: 1, min: 0, max: 3, step: 1 },
    { id: 'harmlevel', def: -12, min: -24, max: 0 },    // dB, 2nd partial
    { id: 'register', def: 0.5, min: 0, max: 1 },       // 0 pulses only, 1 whistle only
    { id: 'biphon', def: 0, min: 0, max: 1 },
    { id: 'spread', def: 0.3, min: 0, max: 1 },
    { id: 'size', def: 0, min: 0, max: 1 },             // 0 small, 1 large
    { id: 'sizemode', def: 0, min: 0, max: 1, step: 1 },// 0 octaves, 1 continuous
    { id: 'mode', def: 1, min: 0, max: 1, step: 1 },    // 0 mono, 1 poly
    { id: 'glide', def: 0.06, min: 0, max: 2, curve: 3 },  // s, mono only
    { id: 'transpose', def: 0, min: -24, max: 24, step: 1 },  // semitones
    { id: 'detune', def: 0, min: -100, max: 100 },      // cents
    { id: 'bendrange', def: 12, min: 2, max: 48, step: 1 },  // semitones
    { id: 'attack', def: 0.01, min: 0.001, max: 5, curve: 3 },
    { id: 'decay', def: 0.3, min: 0.001, max: 5, curve: 3 },
    { id: 'sustain', def: 0.8, min: 0, max: 1 },
    { id: 'release', def: 0.3, min: 0.001, max: 8, curve: 3 },
    { id: 'volume', def: -6, min: -48, max: 6 },        // dB
  ];
  // what an LFO may move: every knob except Bend range
  const MOD_TARGETS = ['rate', 'freerate', 'coda', 'jitter', 'rubato', 'ornament', 'clicktone', 'clickwidth', 'ring', 'vowel',
    'sweep', 'time', 'pitch', 'wtranspose', 'harmonics', 'harmlevel', 'register', 'biphon', 'spread', 'size',
    'glide', 'transpose', 'detune', 'attack', 'decay', 'sustain', 'release', 'volume'];
  const NUM_LFOS = 4;
  const LFO_SHAPES = ['Sine', 'Triangle', 'Ramp up', 'Ramp down', 'Square', 'Random step', 'Random smooth'];
  // synced LFO lengths in beats: 8 bars … 1/32, with triplets
  const LFO_DIVS = [32, 16, 8, 4, 2, 4 / 3, 1, 2 / 3, 0.5, 1 / 3, 0.25, 1 / 6, 0.125];
  for (let n = 1; n <= NUM_LFOS; n++) {
    PARAMS.push(
      { id: 'lfo' + n + 'target', def: 0, min: 0, max: MOD_TARGETS.length, step: 1 },   // 0 = none (dormant)
      { id: 'lfo' + n + 'shape', def: 0, min: 0, max: LFO_SHAPES.length - 1, step: 1 },
      { id: 'lfo' + n + 'rate', def: 0.5, min: 0.02, max: 40, log: true },              // Hz (free)
      { id: 'lfo' + n + 'sync', def: 0, min: 0, max: 1, step: 1 },
      { id: 'lfo' + n + 'from', def: 0, min: 0, max: 1 },                               // share of the target's range
      { id: 'lfo' + n + 'to', def: 1, min: 0, max: 1 },
      { id: 'lfo' + n + 'retrig', def: 0, min: 0, max: 1, step: 1 });                   // 0 free, 1 restart on note
  }
  const PINDEX = {};
  PARAMS.forEach((p, i) => { PINDEX[p.id] = i; });
  const TARGET_INDEX = MOD_TARGETS.map(id => PINDEX[id]);

  const SYNC_DIVS = [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];   // pulses per beat

  // knob position (0–1) ↔ value, as the UI's knobs move
  function toNorm(d, v) {
    if (d.log) return Math.log(v / d.min) / Math.log(d.max / d.min);
    const n = (v - d.min) / (d.max - d.min);
    return d.curve ? Math.pow(Math.max(0, n), 1 / d.curve) : n;
  }
  function fromNorm(d, n) {
    n = n < 0 ? 0 : n > 1 ? 1 : n;
    let v = d.log ? d.min * Math.pow(d.max / d.min, n) : d.min + (d.max - d.min) * (d.curve ? Math.pow(n, d.curve) : n);
    if (d.step) v = Math.round(v / d.step) * d.step;
    return v;
  }
  // nearest synced LFO length to a free rate, in beats
  function lfoBeats(rateHz, bpm) {
    const want = (bpm / 60) / rateHz;
    let best = LFO_DIVS[0], bd = Infinity;
    for (const b of LFO_DIVS) { const dd = Math.abs(Math.log(b / want)); if (dd < bd) { bd = dd; best = b; } }
    return best;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // whistle envelope shapes, u in [0, 1] → offset in units of Sweep
  function shapeAt(shape, u) {
    switch (shape) {
      case 1: return 1 - (1 - u) * (1 - u);              // Up: fast start, settles
      case 2: return -(1 - (1 - u) * (1 - u));           // Down
      case 3: return Math.sin(Math.PI * u);              // Convex: up and back
      case 4: return -Math.sin(Math.PI * u);             // Concave: down and back
      case 5: return Math.sin(3 * Math.PI * u);          // Wave: three turns
      default: return 0;                                  // Flat
    }
  }

  function makeFir() {
    const h = new Float32Array(FIR_LEN);
    const fc = 0.5 / OS * 0.92, M = (FIR_LEN - 1) / 2;
    let sum = 0;
    for (let n = 0; n < FIR_LEN; n++) {
      const x = n - M;
      const s = x === 0 ? 2 * fc : Math.sin(TWO_PI * fc * x) / (Math.PI * x);
      const a = TWO_PI * n / (FIR_LEN - 1);
      const w = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
      h[n] = s * w; sum += h[n];
    }
    for (let n = 0; n < FIR_LEN; n++) h[n] /= sum;
    return h;
  }

  /* ---------- one voice ---------- */
  class Voice {
    constructor(e, seed) {
      this.e = e;
      this.seed = (seed >>> 0) || 1;
      // click kernels (struct of arrays)
      this.kOn = new Uint8Array(MAX_KERNELS);
      this.kList = new Int32Array(MAX_KERNELS); this.kN = 0;   // active kernels only
      this.kG = new Float64Array(MAX_KERNELS); this.kQ = new Float64Array(MAX_KERNELS); this.kC = new Float64Array(MAX_KERNELS);
      this.kRe = new Float64Array(MAX_KERNELS); this.kIm = new Float64Array(MAX_KERNELS);
      this.kCr = new Float64Array(MAX_KERNELS); this.kCi = new Float64Array(MAX_KERNELS);
      this.kLeft = new Int32Array(MAX_KERNELS); this.kAmp = new Float64Array(MAX_KERNELS);
      // multipulse delay lines
      this.dlen = e.dlen;
      this.dx = new Float32Array(this.dlen); this.de = new Float32Array(this.dlen);
      this.reset();
    }
    reset() {
      this.rng = this.seed;
      this.stage = 0; this.env = 0; this.note = -1; this.held = false; this.vel = 1; this.age = 0;
      this.logF = Math.log2(440); this.glideLeft = 0; this.glideStep = 0; this.drop = 0;
      this.phW = 0; this.envT = 0; this.phP = 0;
      this.clickIdx = 0; this.gapW = 1; this.tempoF = 1; this.ornDone = false;
      this.codaVowel = 0; this.prevVowel = 0; this.vw = 0; this.vwS = 0;
      this.b1a = 0; this.b1b = 0; this.b2a = 0; this.b2b = 0;
      this.wpos = 0;
      this.kOn.fill(0); this.kN = 0;
      this.dx.fill(0); this.de.fill(0);
      this.fW = 0; this.rateNow = 0;
    }
    rand() {
      let x = this.rng;
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      this.rng = x;
      return x / 4294967296;
    }
    gauss() { let s = this.rand(); s += this.rand(); s += this.rand(); s += this.rand(); return (s - 2) * 1.7320508; }
    active() { return this.stage !== 0; }

    pitchTarget(note) {
      const e = this.e;
      return Math.log2(440) + (note - 69 + e.m[PINDEX.transpose] + e.m[PINDEX.detune] / 100) / 12;
    }
    setTarget(note, glide) {
      const t = this.pitchTarget(note);
      const g = this.e.m[PINDEX.glide];
      if (glide && g > 0.0015) {
        const steps = Math.max(1, Math.round(g * this.e.sr / BLOCK));
        this.glideStep = (t - this.logF) / steps; this.glideLeft = steps;
      } else { this.logF = t; this.glideLeft = 0; }
      this.note = note;
    }
    trigger(vel) {
      const e = this.e;
      this.vel = 0.2 + 0.8 * clamp(vel / 127, 0, 1);
      if (this.stage === 0) {
        this.env = 0; this.phW = 0; this.phP = 0.999999;   // first click on the first sample
        this.kOn.fill(0); this.kN = 0; this.dx.fill(0); this.de.fill(0);
        this.b1a = this.b1b = this.b2a = this.b2b = 0;
      }
      this.stage = 1; this.held = true; this.age = ++e.ageCounter;
      this.envT = 0; this.clickIdx = 0; this.gapW = 1; this.tempoF = 1; this.ornDone = false;
      this.prevVowel = this.codaVowel = this.vw = this.vwS = e.sVowel;
      // whistle base pitch: drop whole octaves above the cap
      this.drop = 0;
      while (Math.pow(2, this.logF + e.kSize + e.wTransOct + this.drop) > F_CAP) this.drop -= 1;
    }
    release() { if (this.stage !== 0) { this.stage = 4; this.held = false; } }

    // gap weight after click i of a coda (mean 1 inside the coda)
    weightFor(i) {
      const e = this.e, n = e.codaN > 0 ? e.codaN : 8;
      const pat = e.pattern;
      if (n < 2 || pat === 0) return 1;
      const gaps = n - 1, k = i % n;
      if (k >= gaps) return 1;
      if (pat === 1 || pat === 2) {
        const r = pat === 1 ? 1.15 : 0.87;
        const mean = (Math.pow(r, gaps) - 1) / (r - 1) / gaps;
        return Math.pow(r, k) / mean;
      }
      // Grouped (1+1+3 style): two long gaps, then short ones
      if (gaps < 3) return 1;
      const longs = 2, shorts = gaps - 2, wl = 2, ws = 0.5;
      const mean = (longs * wl + shorts * ws) / gaps;
      return (k < 2 ? wl : ws) / mean;
    }

    // what follows the click that just fired
    nextGap() {
      const e = this.e, n = e.codaN;
      let w;
      if (n > 0) {
        const last = this.clickIdx >= n - 1;
        if (last && !this.ornDone && e.ornament > 0 && this.rand() < e.ornament) {
          this.ornDone = true; w = 0.5;                       // ornament: one extra quick click
        } else if (last) {
          w = Math.max(2, n);                                  // rest about one coda long
          this.clickIdx = -1; this.ornDone = false;
          if (e.rubato > 0) this.tempoF = clamp(this.tempoF * Math.exp(e.rubato * 0.25 * this.gauss()), 0.6, 1.6);
          else this.tempoF = 1;
        } else w = this.weightFor(this.clickIdx);
      } else w = this.weightFor(this.clickIdx);
      if (e.jitter > 0) w *= clamp(1 + e.jitter * 0.3 * this.gauss(), 0.25, 2.5);
      this.gapW = w;
      this.clickIdx++;
    }

    fire(frac, audible) {
      const e = this.e;
      // vowel: a new coda's first click still carries the previous coda's vowel
      if (e.codaN > 0) {
        if (this.clickIdx === 0) { this.prevVowel = this.codaVowel; this.codaVowel = e.sVowel; this.vw = this.prevVowel; }
        else this.vw = this.codaVowel;
      } else this.vw = e.sVowel;
      let slot = -1;
      if (audible && this.kN < MAX_KERNELS) for (let i = 0; i < MAX_KERNELS; i++) if (!this.kOn[i]) { slot = i; break; }
      if (slot >= 0) {
        const s = e.sigmaS, t0 = frac - SIGMAS * s;
        this.kG[slot] = Math.exp(-0.5 * t0 * t0 / (s * s));
        this.kQ[slot] = Math.exp(-(2 * t0 + 1) / (2 * s * s));
        this.kC[slot] = Math.exp(-1 / (s * s));
        const w = TWO_PI * e.fcN, th = w * t0;
        this.kRe[slot] = Math.cos(th); this.kIm[slot] = Math.sin(th);
        this.kCr[slot] = Math.cos(w); this.kCi[slot] = Math.sin(w);
        this.kLeft[slot] = Math.ceil(2 * SIGMAS * s - frac) + 1;
        this.kAmp[slot] = e.jitter > 0 ? clamp(1 + e.jitter * 0.15 * this.gauss(), 0.5, 1.5) : 1;
        this.kOn[slot] = 1;
        this.kList[this.kN++] = slot;
      }
      if (e.onsets) e.onsets.push(e.osTime - frac);
      e.pulseCount++;
      this.nextGap();
    }

    render(nOS, oL, oR, cb) {
      const e = this.e, srOS = e.srOS;
      // pitch: glide, bend
      if (this.glideLeft > 0) { this.logF += this.glideStep; this.glideLeft--; }
      const base = this.logF + e.bendOct;
      // whistle pitch at block start and end
      let p0, p1;
      if (e.pitchmode === 1) { p0 = e.pitchPrev; p1 = e.pitchNow; }
      else {
        const T = e.sTime, dt = nOS / srOS;
        const u0 = Math.min(1, this.envT / T), u1 = Math.min(1, (this.envT + dt) / T);
        p0 = e.sSweep * shapeAt(e.shape, u0); p1 = e.sSweep * shapeAt(e.shape, u1);
        this.envT += dt;
      }
      const f0 = Math.pow(2, base + e.kSizePrev + e.wTransPrev + this.drop + p0);
      const f1 = Math.pow(2, base + e.kSize + e.wTransOct + this.drop + p1);
      this.fW = f1;
      // pulse rate
      let rate = e.keytrack ? Math.pow(2, base + e.sRate) : e.freeRate;
      rate = clamp(rate, 0.2, 2500) * this.tempoF;
      this.rateNow = rate;
      const incP = rate / srOS;
      // partial gains, fading out near the host Nyquist
      const nH = e.harmonics, lim0 = 0.40 * e.sr, lim1 = 0.45 * e.sr;
      const fmax = Math.max(f0, f1);
      const fade = f => f <= lim0 ? 1 : f >= lim1 ? 0 : (lim1 - f) / (lim1 - lim0);
      const g1 = fade(fmax), g2 = nH >= 1 ? e.hGain * fade(2 * fmax) : 0;
      const g3 = nH >= 2 ? e.hGain * 0.5 * fade(3 * fmax) : 0, g4 = nH >= 3 ? e.hGain * 0.25 * fade(4 * fmax) : 0;
      const wNorm = 0.4 / (1 + e.hGain * (nH >= 1) + e.hGain * 0.5 * (nH >= 2) + e.hGain * 0.25 * (nH >= 3));
      // per-voice vowel blend
      this.vwS += (this.vw - this.vwS) * 0.5;
      const vw = this.vwS;
      // envelope steps
      const attStep = 1 / Math.max(1, e.m[PINDEX.attack] * srOS);
      const dCoef = Math.exp(-4 / Math.max(1, e.m[PINDEX.decay] * srOS));
      const rCoef = Math.exp(-4 / Math.max(1, e.m[PINDEX.release] * srOS));
      const sus = e.m[PINDEX.sustain];
      // gains
      const amp = this.vel;
      const pg = e.gPulse * amp, wg = e.gWhistle * amp * wNorm;
      const pL = e.panPL * pg, pR = e.panPR * pg, wL = e.panWL * wg, wR = e.panWR * wg;
      const bip = e.biphon;
      // skip whichever lip is silent (Register at an end)
      const pulseOn = pg > 1e-7, whistleOn = wg > 1e-9;
      // comb
      const ring = e.ringG, D = e.ipiS, D0 = 0.9 * D, mask = this.dlen - 1;
      const ringOn = ring > 0.0005;
      // svf coefficients (shared per block)
      const a1 = e.svf1a1, a2 = e.svf1a2, a3 = e.svf1a3, k1 = e.svf1k;
      const c1 = e.svf2a1, c2 = e.svf2a2, c3 = e.svf2a3, k2 = e.svf2k;
      let b1a = this.b1a, b1b = this.b1b, b2a = this.b2a, b2b = this.b2b;
      let env = this.env, stage = this.stage, phW = this.phW, phP = this.phP, wpos = this.wpos;
      const df = (f1 - f0) / nOS;
      let f = f0;
      for (let j = 0; j < nOS; j++) {
        // envelope
        if (stage === 1) { env += attStep; if (env >= 1) { env = 1; stage = 2; } }
        else if (stage === 2) { env = sus + (env - sus) * dCoef; if (Math.abs(env - sus) < 1e-4) { env = sus; stage = 3; } }
        else if (stage === 4) { env *= rCoef; if (env < 1e-5) { env = 0; stage = 0; } }
        // pulses
        phP += incP / this.gapW;
        if (phP >= 1) {
          const inc = incP / this.gapW;
          phP -= 1;
          const frac = inc > 0 ? Math.min(0.999999, phP / inc) : 0;
          e.osTime = e.osTimeBase + j;
          this.fire(frac, pulseOn);
          phP = phP * (inc > 0 ? (incP / this.gapW) / inc : 1);
        }
        let pulse = 0;
        if (pulseOn) {
        let x = 0;
        for (let a = 0; a < this.kN;) {
          const k = this.kList[a];
          const g = this.kG[k];
          x += g * this.kRe[k] * this.kAmp[k];
          this.kG[k] = g * this.kQ[k]; this.kQ[k] *= this.kC[k];
          const re = this.kRe[k], im = this.kIm[k], cr = this.kCr[k], ci = this.kCi[k];
          this.kRe[k] = re * cr - im * ci; this.kIm[k] = re * ci + im * cr;
          if (--this.kLeft[k] <= 0) { this.kOn[k] = 0; this.kList[a] = this.kList[--this.kN]; continue; }
          a++;
        }
        // multipulse: echoes at 0.9 D, then every D
        let y = x;
        if (ringOn) {
          const r0 = wpos - D0, r1 = wpos - D;
          const i0 = Math.floor(r0), fr0 = r0 - i0, i1 = Math.floor(r1), fr1 = r1 - i1;
          const xa = this.dx[i0 & mask], xb = this.dx[(i0 + 1) & mask];
          const ea = this.de[i1 & mask], eb = this.de[(i1 + 1) & mask];
          const ev = ring * (xa + (xb - xa) * fr0) + ring * (ea + (eb - ea) * fr1);
          this.dx[wpos & mask] = x; this.de[wpos & mask] = ev;
          y = x + ev;
        } else { this.dx[wpos & mask] = x; this.de[wpos & mask] = 0; }
        wpos++;
        // vowel peaks (TPT state-variable band-pass, peak gain 1)
        let v3 = y - b1b, v1 = a1 * b1a + a2 * v3, v2 = b1b + a2 * b1a + a3 * v3;
        b1a = 2 * v1 - b1a; b1b = 2 * v2 - b1b;
        const bp1 = k1 * v1;
        v3 = y - b2b; v1 = c1 * b2a + c2 * v3; v2 = b2b + c2 * b2a + c3 * v3;
        b2a = 2 * v1 - b2a; b2b = 2 * v2 - b2b;
        const bp2 = k2 * v1;
        pulse = (0.3 * y + 0.9 * bp1 + vw * 0.9 * bp2) * env;
        }
        // whistle: sine partials via the Chebyshev recurrence
        let w = 0;
        if (whistleOn) {
          phW += f / srOS; if (phW >= 1) phW -= 1;
          f += df;
          let xs = phW * SIN_N, is = xs | 0, fs = xs - is;
          const s1 = SIN[is] + (SIN[is + 1] - SIN[is]) * fs;
          xs = (phW + 0.25) * SIN_N; if (xs >= SIN_N) xs -= SIN_N; is = xs | 0; fs = xs - is;
          const c2x = 2 * (SIN[is] + (SIN[is + 1] - SIN[is]) * fs);
          const s2 = c2x * s1, s3 = c2x * s2 - s1, s4 = c2x * s3 - s2;
          w = g1 * s1 + g2 * s2 + g3 * s3 + g4 * s4;
          if (bip > 0) {
            let xb = (phP + 0.25) * SIN_N; xb -= SIN_N * Math.floor(xb / SIN_N); const ib = xb | 0;
            w *= 1 - bip + bip * (0.5 + 0.5 * (SIN[ib] + (SIN[ib + 1] - SIN[ib]) * (xb - ib)));
          }
          w *= env;
        }
        oL[j] += pulse * pL + w * wL;
        oR[j] += pulse * pR + w * wR;
      }
      this.env = env; this.stage = stage; this.phW = phW; this.phP = phP; this.wpos = wpos & 0x3fffffff;
      this.b1a = b1a; this.b1b = b1b; this.b2a = b2a; this.b2b = b2b;
      if (stage === 0) { this.note = -1; this.held = false; this.kOn.fill(0); this.kN = 0; }
    }
  }

  /* ---------- engine ---------- */
  class DolphinEngine {
    constructor(sampleRate, seed) {
      this.sr = sampleRate; this.srOS = sampleRate * OS;
      this.p = new Float64Array(PARAMS.length);           // as set by the host or the UI
      PARAMS.forEach((d, i) => { this.p[i] = d.def; });
      this.m = Float64Array.from(this.p);                  // after the LFOs: what the sound uses
      this.modded = new Uint8Array(PARAMS.length);
      // LFOs: dormant (no work at all) while their target is None
      this.lfoPhase = new Float64Array(NUM_LFOS); this.lfoPrev = new Float64Array(NUM_LFOS); this.lfoNext = new Float64Array(NUM_LFOS);
      this.lfoOut = new Float64Array(NUM_LFOS); this.lfoSm = new Float64Array(NUM_LFOS);
      this.lfoTarget = new Int32Array(NUM_LFOS); this.lfoFresh = new Uint8Array(NUM_LFOS).fill(1);
      this.lfoRng = new Uint32Array(NUM_LFOS);
      for (let i = 0; i < NUM_LFOS; i++) this.lfoRng[i] = ((((seed >>> 0) || 1) * 2654435761) ^ (0x51ed27 * (i + 1))) >>> 0 || 1;
      this.lfoSmooth = 1 - Math.exp(-BLOCK / (0.002 * sampleRate));
      this.fir = makeFir();
      this.histL = new Float32Array(FIR_LEN * 2); this.histR = new Float32Array(FIR_LEN * 2); this.hw = 0;
      this.osL = new Float32Array(BLOCK * OS); this.osR = new Float32Array(BLOCK * OS);
      this.blkL = new Float32Array(BLOCK); this.blkR = new Float32Array(BLOCK); this.blkPos = BLOCK;
      this.dlen = 1; while (this.dlen < Math.ceil(0.0046 * this.srOS) + 8) this.dlen <<= 1;
      this.ageCounter = 0; this.quietBlocks = 0;
      this.stack = [];
      this.bendNorm = 0; this.tempo = 120;
      this.dc = { xl: 0, yl: 0, xr: 0, yr: 0, R: 1 - 2 * Math.PI * 10 / sampleRate };
      this.osTimeBase = 0; this.osTime = 0; this.pulseCount = 0; this.onsets = null;
      const base = (seed >>> 0) || 0x9e3779b9;
      this.voices = [];
      for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(this, (base + i * 0x6d2b79f5) >>> 0));
      // smoothed controls
      this.smooth = 1 - Math.exp(-BLOCK / (0.02 * sampleRate));
      this.smoothFast = 1 - Math.exp(-BLOCK / (0.003 * sampleRate));
      this.sRate = this.p[PINDEX.rate]; this.sFree = Math.log2(this.p[PINDEX.freerate]);
      this.sPitch = this.p[PINDEX.pitch]; this.sSweep = this.p[PINDEX.sweep]; this.sTime = this.p[PINDEX.time];
      this.sVowel = this.p[PINDEX.vowel]; this.sSize = this.p[PINDEX.size]; this.sReg = this.p[PINDEX.register];
      this.sSpread = this.p[PINDEX.spread]; this.sTone = this.p[PINDEX.clicktone]; this.sWidth = this.p[PINDEX.clickwidth];
      this.sRing = this.p[PINDEX.ring]; this.sBip = this.p[PINDEX.biphon]; this.sVol = this.p[PINDEX.volume];
      this.pitchNow = this.pitchPrev = this.sPitch;
      this.kSize = this.kSizePrev = 0; this.wTransOct = this.wTransPrev = 0;
      this.updateControls(true);
      this.info = { voices: 0, rate: 0, whistle: 0 };
    }

    static get LATENCY() { return BLOCK; }
    static get PARAMS() { return PARAMS; }

    setParam(id, v) {
      // an LFO target may be given by parameter id ('pitch') instead of its menu number
      if (typeof v === 'string' && /^lfo\dtarget$/.test(id)) v = v === 'none' ? 0 : MOD_TARGETS.indexOf(v) + 1;
      const i = PINDEX[id];
      if (i === undefined || !Number.isFinite(v)) return;
      const d = PARAMS[i];
      this.p[i] = clamp(v, d.min, d.max);
      if (id === 'mode') this.allNotesOff();
    }
    getParam(id) { return this.p[PINDEX[id]]; }
    setBend(norm) { this.bendNorm = clamp(norm, -1, 1); }       // -1..1 like a pitch wheel
    setTempo(bpm) { this.tempo = clamp(bpm, 20, 400); }

    noteOn(note, vel) {
      if (vel <= 0) { this.noteOff(note); return; }
      // LFOs set to restart on each note
      for (let i = 0; i < NUM_LFOS; i++) if (this.p[PINDEX['lfo' + (i + 1) + 'retrig']] >= 0.5) { this.lfoPhase[i] = 0; this.lfoFresh[i] = 1; }
      // starting from silence: jump straight to the current settings instead of gliding from old ones
      if (!this.voices.some(v => v.active())) { this.advanceLfos(0); this.updateControls(true); }
      if (this.p[PINDEX.mode] === 0) {
        const v = this.voices[0];
        const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
        this.stack.push(note);
        const legato = v.active() && v.held;
        v.setTarget(note, legato);
        if (!legato) v.trigger(vel);
        else v.vel = 0.2 + 0.8 * clamp(vel / 127, 0, 1);
        return;
      }
      for (const v of this.voices) if (v.active() && v.note === note) { v.setTarget(note, false); v.trigger(vel); return; }
      let pick = null;
      for (const v of this.voices) if (!v.active()) { pick = v; break; }
      if (!pick) { for (const v of this.voices) if (!v.held && (!pick || v.age < pick.age)) pick = v; }
      if (!pick) { for (const v of this.voices) if (!pick || v.age < pick.age) pick = v; }
      pick.setTarget(note, false);
      pick.trigger(vel);
    }
    noteOff(note) {
      if (this.p[PINDEX.mode] === 0) {
        const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
        const v = this.voices[0];
        if (!v.active() || v.note !== note) return;
        if (this.stack.length) v.setTarget(this.stack[this.stack.length - 1], true);
        else v.release();
        return;
      }
      for (const v of this.voices) if (v.note === note && v.held) v.release();
    }
    allNotesOff() { this.stack.length = 0; for (const v of this.voices) v.release(); }

    // per-block control values
    updateControls(snap) {
      this.applyLfos();
      const P = this.m, M = this.modded, c0 = snap ? 1 : this.smooth, cf = snap ? 1 : this.smoothFast;
      const c = c0;
      this.sRate += (P[PINDEX.rate] - this.sRate) * cf;
      this.sFree += (Math.log2(P[PINDEX.freerate]) - this.sFree) * cf;
      this.pitchPrev = this.sPitch;
      this.sPitch += (P[PINDEX.pitch] - this.sPitch) * cf;
      this.pitchNow = this.sPitch;
      this.sSweep += (P[PINDEX.sweep] - this.sSweep) * (M[PINDEX.sweep] ? cf : c);
      this.sTime += (P[PINDEX.time] - this.sTime) * (M[PINDEX.time] ? cf : c);
      this.sVowel += (P[PINDEX.vowel] - this.sVowel) * cf;
      this.sSize += (P[PINDEX.size] - this.sSize) * (M[PINDEX.size] ? cf : c);
      this.sReg += (P[PINDEX.register] - this.sReg) * (M[PINDEX.register] ? cf : c);
      this.sSpread += (P[PINDEX.spread] - this.sSpread) * (M[PINDEX.spread] ? cf : c);
      this.sTone += (P[PINDEX.clicktone] - this.sTone) * (M[PINDEX.clicktone] ? cf : c);
      this.sWidth += (P[PINDEX.clickwidth] - this.sWidth) * (M[PINDEX.clickwidth] ? cf : c);
      this.sRing += (P[PINDEX.ring] - this.sRing) * (M[PINDEX.ring] ? cf : c);
      this.sBip += (P[PINDEX.biphon] - this.sBip) * (M[PINDEX.biphon] ? cf : c);
      this.sVol += (P[PINDEX.volume] - this.sVol) * (M[PINDEX.volume] ? cf : c);

      this.keytrack = P[PINDEX.keytrack] >= 0.5;
      this.pattern = Math.round(P[PINDEX.pattern]);
      this.codaN = Math.round(P[PINDEX.coda]);
      this.jitter = P[PINDEX.jitter]; this.rubato = P[PINDEX.rubato]; this.ornament = P[PINDEX.ornament];
      this.pitchmode = Math.round(P[PINDEX.pitchmode]);
      this.shape = Math.round(P[PINDEX.shape]);
      this.harmonics = Math.round(P[PINDEX.harmonics]);
      this.hGain = Math.pow(10, P[PINDEX.harmlevel] / 20);
      this.biphon = this.sBip;
      // free rate, optionally synced to tempo
      let fr = Math.pow(2, this.sFree);
      if (P[PINDEX.sync] >= 0.5) {
        const bps = this.tempo / 60;
        let best = SYNC_DIVS[0] * bps, bd = Infinity;
        for (const d of SYNC_DIVS) { const r = d * bps, dd = Math.abs(Math.log(r / fr)); if (dd < bd) { bd = dd; best = r; } }
        fr = best;
      }
      this.freeRate = fr;
      // bend
      this.bendOct = this.bendNorm * P[PINDEX.bendrange] / 12;
      this.wTransPrev = this.wTransOct;
      this.wTransOct = P[PINDEX.wtranspose] / 12;
      if (snap) this.wTransPrev = this.wTransOct;
      // size
      this.kSizePrev = this.kSize;
      const kRaw = 4 * (1 - this.sSize);
      this.kSize = P[PINDEX.sizemode] >= 0.5 ? kRaw : Math.round(4 * (1 - P[PINDEX.size]));
      if (snap) this.kSizePrev = this.kSize;
      // click kernel: centre 8 kHz (small) to 3 kHz (large), Click tone on top
      const centre = 8000 * Math.pow(3 / 8, this.sSize) * Math.pow(2, this.sTone);
      const sigma = this.sWidth / 1000;                                 // s
      const bw = 1 / (TWO_PI * sigma);                                  // spectral standard deviation, Hz
      const fc = clamp(centre, 300, Math.max(300, 0.45 * this.sr - 3 * bw));
      this.fcN = fc / this.srOS; this.sigmaS = sigma * this.srOS;
      this.clickFc = fc;
      // multipulse
      this.ipiS = (1.5 + 2.5 * this.sSize) / 1000 * this.srOS;
      this.ringG = this.sRing * 0.82;
      // vowel peaks scale with the click centre (tunable constants, set by ear)
      const F1 = clamp(fc * 0.7, 200, 0.42 * this.sr), F2 = clamp(fc * 1.55, 400, 0.44 * this.sr);
      this.setSvf(1, F1, 4); this.setSvf(2, F2, 5);
      // mix
      this.gPulse = Math.cos(this.sReg * Math.PI / 2) * 0.9;
      this.gWhistle = Math.sin(this.sReg * Math.PI / 2);
      const pp = 0.5 + 0.5 * this.sSpread, pw = 0.5 - 0.5 * this.sSpread;
      this.panPL = Math.cos(pp * Math.PI / 2) * Math.SQRT2; this.panPR = Math.sin(pp * Math.PI / 2) * Math.SQRT2;
      this.panWL = Math.cos(pw * Math.PI / 2) * Math.SQRT2; this.panWR = Math.sin(pw * Math.PI / 2) * Math.SQRT2;
      this.vol = Math.pow(10, this.sVol / 20);
    }
    // move each active LFO on by dt seconds and compute its output (0–1)
    advanceLfos(dt) {
      for (let i = 0; i < NUM_LFOS; i++) {
        const b = PINDEX['lfo' + (i + 1) + 'target'];
        const t = Math.round(this.p[b]);
        this.lfoTarget[i] = t;
        if (t === 0) continue;                                   // dormant
        const shape = Math.round(this.p[b + 1]);
        let hz = this.p[b + 2];
        if (this.p[b + 3] >= 0.5) hz = (this.tempo / 60) / lfoBeats(hz, this.tempo);
        let ph = this.lfoPhase[i] + hz * dt;
        let wrapped = false;
        if (ph >= 1) { ph -= Math.floor(ph); wrapped = true; }
        if (wrapped || this.lfoFresh[i]) {
          this.lfoPrev[i] = this.lfoFresh[i] ? this.lfoRand(i) : this.lfoNext[i];
          this.lfoNext[i] = this.lfoRand(i);
          this.lfoFresh[i] = 0;
        }
        this.lfoPhase[i] = ph;
        let y;
        switch (shape) {
          case 0: y = 0.5 - 0.5 * Math.cos(TWO_PI * ph); break;          // Sine, starts at From
          case 1: y = ph < 0.5 ? 2 * ph : 2 - 2 * ph; break;              // Triangle
          case 2: y = ph; break;                                           // Ramp up
          case 3: y = 1 - ph; break;                                       // Ramp down
          case 4: y = ph < 0.5 ? 0 : 1; break;                             // Square
          case 5: y = this.lfoPrev[i]; break;                              // Random step
          default: { const u = 0.5 - 0.5 * Math.cos(Math.PI * ph); y = this.lfoPrev[i] + (this.lfoNext[i] - this.lfoPrev[i]) * u; }  // Random smooth
        }
        this.lfoOut[i] = y;
        // a 2 ms glide keeps square and step jumps from clicking
        this.lfoSm[i] = dt === 0 ? y : this.lfoSm[i] + (y - this.lfoSm[i]) * this.lfoSmooth;
      }
    }
    lfoRand(i) {
      let x = this.lfoRng[i];
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      this.lfoRng[i] = x;
      return x / 4294967296;
    }
    // effective values: the set values, with each active LFO's target replaced by From→To
    applyLfos() {
      this.m.set(this.p);
      this.modded.fill(0);
      for (let i = 0; i < NUM_LFOS; i++) {
        const t = this.lfoTarget[i];
        if (t === 0) continue;
        const b = PINDEX['lfo' + (i + 1) + 'target'];
        const idx = TARGET_INDEX[t - 1], d = PARAMS[idx];
        const from = this.p[b + 4], to = this.p[b + 5];
        this.m[idx] = fromNorm(d, from + (to - from) * this.lfoSm[i]);
        this.modded[idx] = 1;
      }
    }

    setSvf(n, f, q) {
      const g = Math.tan(Math.PI * f / this.srOS), k = 1 / q;
      const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
      if (n === 1) { this.svf1a1 = a1; this.svf1a2 = a2; this.svf1a3 = a3; this.svf1k = k; }
      else { this.svf2a1 = a1; this.svf2a2 = a2; this.svf2a3 = a3; this.svf2k = k; }
    }

    processBlock() {
      this.advanceLfos(BLOCK / this.sr);
      const d0 = this.dc;
      if (this.quietBlocks > 0 && !this.voices.some(v => v.stage !== 0) &&
          Math.abs(d0.yl) < 1e-12 && Math.abs(d0.yr) < 1e-12 && Math.abs(d0.xl) < 1e-12 && Math.abs(d0.xr) < 1e-12) {
        // idle: nothing sounds and the filters are empty; a note from silence snaps the controls anyway
        this.blkL.fill(0); this.blkR.fill(0); d0.xl = d0.yl = d0.xr = d0.yr = 0;
        this.info.voices = 0; this.info.idle = true;
        return;
      }
      this.updateControls(false);
      const nOS = BLOCK * OS, oL = this.osL, oR = this.osR;
      oL.fill(0); oR.fill(0);
      let count = 0, rate = 0, wh = 0, newest = -1;
      for (const v of this.voices) if (v.stage !== 0) {
        v.render(nOS, oL, oR);
        count++;
        if (v.age > newest) { newest = v.age; rate = v.rateNow; wh = v.fW; }
      }
      this.osTimeBase += nOS;
      this.info.voices = count; this.info.rate = rate; this.info.whistle = wh;
      const d = this.dc;
      // silence: once a whole block has passed with no voices, the filter history is all zeros,
      // so skip the decimation until a note starts (the DC blocker's tail must have died out too)
      if (count === 0 && this.quietBlocks > 0 && Math.abs(d.yl) < 1e-12 && Math.abs(d.yr) < 1e-12 && Math.abs(d.xl) < 1e-12 && Math.abs(d.xr) < 1e-12) {
        this.blkL.fill(0); this.blkR.fill(0);
        d.xl = d.yl = d.xr = d.yr = 0;
        this.info.idle = true;
        return;
      }
      this.quietBlocks = count === 0 ? this.quietBlocks + 1 : 0;
      this.info.idle = false;
      // decimate (FIR, symmetric: half the multiplies) both channels, DC block, volume, clip
      const L = FIR_LEN, H = FIR_LEN / 2, h = this.fir, hl = this.histL, hr = this.histR, vol = this.vol;
      let hw = this.hw;
      for (let j = 0, o = 0; j < BLOCK; j++) {
        for (let q = 0; q < OS; q++, o++) {
          hl[hw] = hl[hw + L] = oL[o];
          hr[hw] = hr[hw + L] = oR[o];
          hw = hw + 1 === L ? 0 : hw + 1;
        }
        let al = 0, ar = 0;
        for (let t = 0, u = hw + L - 1; t < H; t++, u--) { const c = h[t], a = hw + t; al += c * (hl[a] + hl[u]); ar += c * (hr[a] + hr[u]); }
        const yl = al - d.xl + d.R * d.yl; d.xl = al; d.yl = yl;
        const yr = ar - d.xr + d.R * d.yr; d.xr = ar; d.yr = yr;
        let sl = yl * vol, sr = yr * vol;
        this.blkL[j] = sl > 1 ? 1 : sl < -1 ? -1 : sl;
        this.blkR[j] = sr > 1 ? 1 : sr < -1 ? -1 : sr;
      }
      this.hw = hw;
      if (Math.abs(d.yl) < 1e-20) d.yl = 0;
      if (Math.abs(d.yr) < 1e-20) d.yr = 0;
    }

    // host calls with any n; work happens in fixed BLOCK chunks
    process(outL, outR, n) {
      let pos = this.blkPos;
      for (let j = 0; j < n; j++) {
        if (pos === BLOCK) { this.processBlock(); pos = 0; }
        outL[j] = this.blkL[pos];
        if (outR) outR[j] = this.blkR[pos];
        pos++;
      }
      this.blkPos = pos;
    }
  }

  DolphinEngine.BLOCK = BLOCK; DolphinEngine.OS = OS;
  DolphinEngine.MOD_TARGETS = MOD_TARGETS; DolphinEngine.LFO_SHAPES = LFO_SHAPES; DolphinEngine.LFO_DIVS = LFO_DIVS;
  DolphinEngine.toNorm = toNorm; DolphinEngine.fromNorm = fromNorm; DolphinEngine.lfoBeats = lfoBeats;
  if (typeof module !== 'undefined' && module.exports) module.exports = { DolphinEngine, PARAMS, MOD_TARGETS, LFO_SHAPES, LFO_DIVS };
  else root.DolphinEngine = DolphinEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
