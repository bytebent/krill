/*
 * beak-tube v0.1 · bytebent
 *
 * A bird's vocal tract as an audio effect. It makes no sound of its own: whatever comes in
 * travels up a trachea, through a throat cavity whose resonance follows the pitch it hears,
 * and out of a beak (or an inflated sac).
 *
 *   - Trachea: a tube closed at the syrinx and open at the larynx, a delay line with a lossy
 *     inverting reflection (resonances at odd multiples of c/4L: 2.5 and 7.5 kHz for 3.5 cm).
 *   - Song mode: larynx opening, OEC and beak as one lumped circuit after Perl et al. 2011, eq. 7:
 *     the larynx is the neck (inertance Lg) of a Helmholtz resonator whose volume is the OEC
 *     (compliance Ch); the beak (inertance Lb) and its radiation resistance Rb load the cavity.
 *     Three state variables per channel, integrated with the trapezoidal rule, prewarped at the
 *     cavity resonance.
 *   - Tracking: a YIN pitch tracker per input channel sets the cavity volume so its resonance
 *     sits on the fundamental (Riede et al. 2006). When it is unsure the cavity holds its last
 *     tuning. The audio is delayed by the tracker's look-ahead, so the cavity arrives on time.
 *   - Parrot: four tongue-shaped resonances (Beckers, Nelson & Suthers 2004) instead of the OEC.
 *     Sac: beak closed, one narrow resonance at Sac tune with soft-wall damping (dove coo).
 *     Boom: Sac with a long trachea and the body resonator (cassowary).
 *   - Body: a low resonator driven by the trachea (a sternum, Gaunt et al. 1987).
 *   - Size scales the trachea, beak and body together, on the same scale as Syrinx's Size.
 *   - Stereo in stays stereo: one tracker and one tract per channel. Mono in uses one tract
 *     until Spread is up.
 *   - Radiation (flow → pressure, +6 dB/oct), Mix (dry delayed to line up), Output, Bypass.
 *
 * Fixed 32-sample blocks; parameters are read once per block. Latency is fixed per sample rate
 * (block + tracker look-ahead). process() never allocates. Same input, same output, at any host
 * buffer size. Works in an AudioWorklet and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const BLOCK = 32;                    // fixed internal block (host samples)
  const SOUND = 350;                   // m/s, warm moist air
  const TWO_PI = 2 * Math.PI;
  const SIZE_OCT = 8 / 3;              // as Syrinx: octaves per unit of Size away from 0.25
  const SIZE_REF = 0.25;               // songbird; every value below is for this Size

  // trachea
  const TUBE_N = 16384, TUBE_MASK = TUBE_N - 1;    // longest round trip at 192 kHz: 2 × 8 m / 350 m/s
  const TUBE_MAX_M = 8;                // physical tube length cap (200 cm × Size × Boom)
  const TUBE_R = [0.95, 0.3];          // |reflection| at the open end: Loss 0 … 1
  const TUBE_LP = [16000, 2500];       // wall loss low-pass on the returning wave: Loss 0 … 1

  // Song chain (Perl et al. 2011). Units are normalised: Lg = 1 at the default Larynx.
  const LB_RATIO = 33;                 // beak / larynx inertance, Perl's 1000 / 30
  const LARYNX_DEF = 0.6;              // default Larynx: the resonance sits where Track and Tune put it
  const LARYNX_OCT = 3;                // octaves of neck area over the Larynx range (resonance moves half as much)
  const Q_MIN = 0.8, Q_MAX = 24;       // Ring 0 … 1 (log)
  const GAPE_HZ = [2000, 16000];       // beak low-pass corner: Gape 0 … 1 (log), at Size 0.25
  const GAPE_FOLLOW = 0.35;            // gape change per octave of pitch at Gape follow 100%
  const GAPE_REF_HZ = 3000;            // pitch where Gape follow adds nothing
  const F_LO = 60;                     // lowest cavity resonance

  // Parrot (Beckers et al. 2004, Fig. 2): formants at tongue front (fb 0) … back (fb 1), Size 0.25
  const PARROT = [
    { f0: 1300, f1: 1900, g: 1.0 },    // F1 rises as the tongue moves back
    { f0: 4400, f1: 4200, g: 0.7 },
    { f0: 7600, f1: 5400, g: 0.55 },   // F3 falls about 2 kHz
    { f0: 9900, f1: 8800, g: 0.3 },
  ];
  const PARROT_HEIGHT = 0.75;          // Tongue height: level drop of all formants at full

  // Sac and Boom
  const SAC_WALL = 2.5;                // soft wall: low-pass at this × Sac tune
  const SAC_LEAK_HZ = 900, SAC_LEAK = 0.1;   // closed beak: what leaks through, low-passed (two poles)
  const BOOM_DIV = 16;                 // Boom: Sac tune divided by this (600 Hz → 37 Hz)
  const BOOM_TUBE = 6;                 // Boom: trachea this many times longer
  const BOOM_BODY = 0.5;               // Boom: body at least this

  // Body (sternum)
  const BODY_HZ = 400, BODY_Q = 3, BODY_GAIN = 3;

  // Spread: how far the two tracts differ at full
  const SPREAD_LEN = 0.06, SPREAD_OCT = 0.08, SPREAD_GAPE = 0.1;

  // output
  const RAD_REF_HZ = 2000;             // radiation filter has unity gain here (÷ Size); Sac and Boom: at Sac tune
  // level match, processed against dry, at each mode's defaults, on band-limited pulse trains
  // (tests/signals.js) in the mode's own range: Song and Parrot 1.2–6 kHz, Sac 400–800 Hz,
  // Boom 25–50 Hz. tools/calibrate.js measures them; the tests check they still hold.
  const GAIN = [1.07, 4.38, 13.51, 2.88];        // Song, Parrot, Sac, Boom, Radiation on
  const GAIN_FLOW = [1.39, 2.14, 1.3, 1.27];   // extra gain with Radiation off

  // pitch tracker (YIN, de Cheveigné & Kawahara 2002) in two bands, each band-limited and decimated:
  // a fast high band for bird pitches and a slow low band for voices and bass. One sample of
  // integer lag is too coarse for sharp pulses at a few samples per period, so each band's
  // input is low-passed to what its pitch range needs.
  const TRK_BANDS = [
    { rate: 12000, fmin: 55, fmax: 1600, win: 0.0107, lp: 2000, trust: [0, 850] },      // low
    { rate: 96000, fmin: 800, fmax: 14000, win: 0.0025, lp: 12000, trust: [800, 1e9], up: true }, // high
  ];
  const TRK_THRESH = 0.2;              // YIN threshold: a dip below this counts as a pitch
  const TRK_HALF = 0.4;                // half-period check: accept the half below this
  const TRK_GAP = 0.3;                 // high band below this share of the low band's mean square: a gap
  const TRK_GATE = 1e-6;               // mean square below this (−60 dBFS) is silence: unsure
  const TRK_RESYNC = 1 << 14;          // recompute the running sums exactly this often (band samples)

  const PARAMS = {
    size:       { def: 0.25, min: 0, max: 1 },
    mode:       { def: 0, min: 0, max: 3, step: 1 },          // Song, Parrot, Sac, Boom
    trachlen:   { def: 3.5, min: 1.5, max: 200 },             // cm at Size 0.25
    trachloss:  { def: 0.3, min: 0, max: 1 },
    larynx:     { def: LARYNX_DEF, min: 0, max: 1 },
    track:      { def: 0.9, min: 0, max: 1 },
    tune:       { def: 4000, min: 200, max: 10000 },          // Hz
    lag:        { def: 0.005, min: 0, max: 0.03 },            // s
    ring:       { def: 0.5, min: 0, max: 1 },
    gape:       { def: 0.5, min: 0, max: 1 },
    gapefollow: { def: 0.6, min: 0, max: 1 },
    tonguefb:   { def: 0.5, min: 0, max: 1 },
    tongueht:   { def: 0.3, min: 0, max: 1 },
    sactune:    { def: 600, min: 200, max: 1500 },            // Hz
    inflate:    { def: 0.8, min: 0, max: 1 },
    body:       { def: 0, min: 0, max: 1 },
    spread:     { def: 0.2, min: 0, max: 1 },
    radiation:  { def: 1, min: 0, max: 1, step: 1 },
    mix:        { def: 1, min: 0, max: 1 },
    output:     { def: 0, min: -24, max: 12 },                // dB
    bypass:     { def: 0, min: 0, max: 1, step: 1 },
  };
  const IDS = Object.keys(PARAMS);
  const PI_ = {}; IDS.forEach((k, i) => { PI_[k] = i; });
  const SMOOTHED = ['size', 'trachlen', 'trachloss', 'larynx', 'track', 'tune', 'ring', 'gape', 'gapefollow',
    'tonguefb', 'tongueht', 'sactune', 'inflate', 'body', 'spread', 'radiation', 'mix', 'output', 'bypass'].map(k => PI_[k]);

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const sizeScale = size => Math.pow(2, (size - SIZE_REF) * SIZE_OCT);     // lengths × this, frequencies ÷ this
  const ringQ = ring => Q_MIN * Math.pow(Q_MAX / Q_MIN, ring);
  const trachR = loss => -(TUBE_R[0] + (TUBE_R[1] - TUBE_R[0]) * loss);   // inverting: closed–open tube
  const trachLp = loss => TUBE_LP[0] * Math.pow(TUBE_LP[1] / TUBE_LP[0], loss);

  /* ---------- pitch tracker ---------- */

  // one band: two one-pole low-passes, boxcar decimation, running YIN difference function
  class Band {
    constructor(sr, B) {
      // below 64 kHz the high band runs at twice the host rate (cubic midpoints), so a pitch of
      // a few samples per period still lands on a fine enough grid of lags
      this.U = B.up && sr < 64000 ? 2 : 1;
      this.D = Math.max(1, Math.round(sr * this.U / B.rate));
      this.rate = sr * this.U / this.D;
      this.W = 2 * Math.round(B.win * this.rate / 2);
      this.TMAX = Math.ceil(this.rate / B.fmin);
      this.TMIN = Math.max(2, Math.floor(this.rate / B.fmax));
      this.aLp = 1 - Math.exp(-TWO_PI * Math.min(B.lp, 0.45 * sr) / sr);
      this.trust = B.trust;
      let n = 1; while (n < this.W + this.TMAX + 2) n <<= 1;
      this.N = n; this.M = n - 1;
      this.x = new Float64Array(n);
      this.d = new Float64Array(this.TMAX + 1);
      this.cm = new Float64Array(this.TMAX + 2);
      this.reset();
    }
    reset() {
      this.x.fill(0); this.d.fill(0); this.t = 0; this.acc = 0; this.accN = 0; this.energy = 0; this.sinceSync = 0;
      this.l1 = 0; this.l2 = 0; this.y0 = 0; this.y1 = 0; this.y2 = 0;
      this.f = 0; this.conf = 0; this.sure = false;
    }
    // look-ahead in host samples: the window's centre
    get delay() { return this.W / 2 * this.D / this.U + (this.U > 1 ? 1 : 0); }
    push(v) {
      const a = this.aLp;
      this.l1 += a * (v - this.l1); this.l2 += a * (this.l1 - this.l2);
      if (this.U > 1) {
        // the midpoint between the last two samples (one sample late), then the later one
        const y3 = this.l2, mid = (9 * (this.y1 + this.y2) - this.y0 - y3) / 16;
        this.y0 = this.y1; this.y1 = this.y2; this.y2 = y3;
        this.dec(mid); this.dec(this.y1);
      } else this.dec(this.l2);
    }
    dec(v) {
      this.acc += v;
      if (++this.accN === this.D) { this.step(this.acc / this.D); this.acc = 0; this.accN = 0; }
    }
    step(v) {
      const x = this.x, M = this.M, d = this.d, W = this.W, TMAX = this.TMAX;
      const t = this.t;
      x[t & M] = v;
      const old = x[(t - W) & M];
      this.energy += v * v - old * old;
      for (let tau = 1; tau <= TMAX; tau++) {
        const a = v - x[(t - tau) & M], b = old - x[(t - W - tau) & M];
        d[tau] += a * a - b * b;
      }
      this.t = t + 1;
      if (++this.sinceSync >= TRK_RESYNC) this.resync();
    }
    // exact recomputation, so rounding in the running sums never builds up
    resync() {
      const x = this.x, M = this.M, d = this.d, W = this.W, t = this.t - 1;
      let e = 0;
      for (let j = 0; j < W; j++) { const v = x[(t - j) & M]; e += v * v; }
      this.energy = e;
      for (let tau = 1; tau <= this.TMAX; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const a = x[(t - j) & M] - x[(t - j - tau) & M]; s += a * a; }
        d[tau] = s;
      }
      this.sinceSync = 0;
    }
    estimate(thresh) {
      const d = this.d, cm = this.cm, TMAX = this.TMAX;
      this.sure = false; this.conf = 0;
      if (this.energy / this.W < TRK_GATE) return;
      let run = 0;
      cm[0] = 1;
      for (let tau = 1; tau <= TMAX; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
      cm[TMAX + 1] = 1;
      let tau = -1;
      for (let k = this.TMIN; k <= TMAX; k++) {
        if (cm[k] < thresh) { while (k + 1 <= TMAX && cm[k + 1] < cm[k]) k++; tau = k; break; }
      }
      if (tau < 0) return;
      // a period of a few samples that falls between two lags dips less than twice that period:
      // take the half if it dips nearly as well
      const h = tau >> 1;
      if (h >= this.TMIN + 1 && tau >= 2 * this.TMIN + 2) {
        let k = h - 1; for (let j = h; j <= h + 1; j++) if (cm[j] < cm[k]) k = j;
        if (cm[k] < TRK_HALF) tau = k;
      }
      // parabolic interpolation of the dip, on the raw difference
      const a = d[tau - 1], b = d[tau], c = tau + 1 <= TMAX ? d[tau + 1] : d[tau], den = a - 2 * b + c;
      const off = den > 0 ? clamp(0.5 * (a - c) / den, -0.5, 0.5) : 0;
      const f = this.rate / (tau + off);
      if (f < this.trust[0] || f >= this.trust[1]) return;
      this.f = f; this.conf = clamp(1 - cm[tau], 0, 1); this.sure = true;
    }
  }

  // both bands for one input channel. The high band's window is shorter, so it is fed later
  // (by the difference of the look-aheads) and both describe the same moment.
  class Tracker {
    constructor(sr) {
      this.lo = new Band(sr, TRK_BANDS[0]);
      this.hi = new Band(sr, TRK_BANDS[1]);
      this.delay = Math.max(this.lo.delay, this.hi.delay);
      this.hiLate = this.delay - this.hi.delay;
      this.loLate = this.delay - this.lo.delay;
      this.memory = Math.max(this.lo.N * this.lo.D, this.hi.N * this.hi.D) + this.delay;
      this.f = 0; this.conf = 0; this.sure = false;
    }
    reset() { this.lo.reset(); this.hi.reset(); this.f = 0; this.conf = 0; this.sure = false; }
    // hist: input ring (mask hM), w: index of the block's first sample
    push(hist, hM, w, n) {
      const lo = this.lo, hi = this.hi, dl = this.loLate, dh = this.hiLate;
      for (let i = 0; i < n; i++) { lo.push(hist[(w + i - dl) & hM]); hi.push(hist[(w + i - dh) & hM]); }
    }
    estimate(thresh) {
      this.lo.estimate(thresh); this.hi.estimate(thresh);
      // both bands sure: the deeper dip wins. The high band's short window can find a false
      // period between widely spaced low pulses; the low band can find one in what its filter
      // leaves of a high pitch. Neither dips as deep as the true period does in the other band.
      const lo = this.lo, hi = this.hi;
      // the high band's window sitting in a gap between low pulses holds little of the energy
      if (hi.sure && hi.energy / hi.W < TRK_GAP * lo.energy / lo.W) { hi.sure = false; hi.conf = 0; }
      const b = lo.sure && hi.sure ? (hi.conf > lo.conf ? hi : lo) : lo.sure ? lo : hi.sure ? hi : null;
      if (b) { this.f = b.f; this.conf = b.conf; this.sure = true; } else { this.conf = 0; this.sure = false; }
    }
  }

  /* ---------- one channel's tract ---------- */

  class Tract {
    constructor(eng) {
      this.e = eng;
      this.tube = new Float64Array(TUBE_N);
      this.svf = new Float64Array(2 * 6);   // 4 parrot formants, sac, body: (ic1, ic2) each
      this.reset();
    }
    reset() {
      this.tube.fill(0); this.svf.fill(0);
      this.tw = 0; this.tlp = 0; this.T = 0;
      this.ug = 0; this.pc = 0; this.ub = 0; this.pPrev = 0;
      this.lp1 = 0; this.lp2 = 0; this.lp3 = 0; this.leak = 0; this.leak2 = 0; this.radPrev = 0;
      this.logF = -1;                        // smoothed cavity resonance, log2 Hz (−1: not set)
      this.fRes = 0; this.gEff = 0; this.held = undefined;
    }
  }

  // TPT state-variable band-pass, unity peak; state at s[o], s[o + 1]
  function svfCoefs(f, q, sr, out, o) {
    const g = Math.tan(Math.PI * Math.min(f, 0.45 * sr) / sr), k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    out[o] = a1; out[o + 1] = g * a1; out[o + 2] = g * g * a1; out[o + 3] = k;
  }

  /* ---------- engine ---------- */

  class BeakTube {
    constructor(sampleRate) {
      const sr = this.sr = sampleRate;
      this.P = new Float64Array(IDS.length);   // targets
      this.S = new Float64Array(IDS.length);   // smoothed per block
      IDS.forEach((k, i) => { this.P[i] = PARAMS[k].def; this.S[i] = PARAMS[k].def; });
      this.smooth = 1 - Math.exp(-BLOCK / (0.02 * sr));
      this.trk = [new Tracker(sr), new Tracker(sr)];
      this.tr = [new Tract(this), new Tract(this)];
      this.trkDelay = this.trk[0].delay;
      this.latency = BLOCK + this.trkDelay;
      // input history: the audio path reads it trkDelay late
      let n = 1; while (n < this.trkDelay + BLOCK + 2) n <<= 1;   // the audio path and the late band read it
      this.hN = n; this.hM = n - 1;
      this.hist = [new Float32Array(n), new Float32Array(n)];
      this.hw = 0;
      this.inL = new Float32Array(BLOCK); this.inR = new Float32Array(BLOCK);
      this.dly = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      this.outL = new Float32Array(BLOCK); this.outR = new Float32Array(BLOCK);
      this.pos = 0;
      this.co = new Float64Array(4 * 6);       // svf coefficient scratch
      this.pg = new Float64Array(4);           // parrot formant levels
      this.twoTracts = false; this.quiet = 0; this.idle = true;
      // tests and bench read these
      this.info = { f: [0, 0], conf: [0, 0], sure: [false, false], res: [0, 0], gape: [0, 0], stereo: false, idle: true };
      this.tap = null;                         // tests only
      this.fresh = true;
    }
    static get BLOCK() { return BLOCK; }
    setParam(id, v) {
      const i = PI_[id]; if (i === undefined) return;
      const p = PARAMS[id];
      v = clamp(+v, p.min, p.max);
      if (p.step) v = Math.round(v);
      this.P[i] = v;
      if (!SMOOTHED.includes(i) || this.fresh) this.S[i] = v;   // before the first block, settings land at once
    }
    getParam(id) { return this.P[PI_[id]]; }
    reset() {
      for (const t of this.trk) t.reset();
      for (const t of this.tr) t.reset();
      for (const h of this.hist) h.fill(0);
      this.pos = 0; this.quiet = 0; this.idle = true; this.fresh = true;
      this.outL.fill(0); this.outR.fill(0);
      this.S.set(this.P);
    }

    // inL, inR: input (inR null = mono). outL, outR: output (outR may be null). Any n.
    process(inL, inR, outL, outR, n) {
      let pos = this.pos;
      for (let i = 0; i < n; i++) {
        this.inL[pos] = inL[i]; this.inR[pos] = inR ? inR[i] : inL[i];
        outL[i] = this.outL[pos]; if (outR) outR[i] = this.outR[pos];
        if (++pos === BLOCK) { this.processBlock(!!inR); pos = 0; }
      }
      this.pos = pos;
    }

    processBlock(stereo) {
      const P = this.P, S = this.S, a = this.smooth, sr = this.sr;
      this.fresh = false;
      for (const i of SMOOTHED) S[i] += (P[i] - S[i]) * a;
      // input history and the delayed block
      const hM = this.hM, h0 = this.hist[0], h1 = this.hist[1];
      let silent = true;
      for (let j = 0; j < BLOCK; j++) {
        const w = (this.hw + j) & hM;
        h0[w] = this.inL[j]; h1[w] = this.inR[j];
        if (this.inL[j] !== 0 || this.inR[j] !== 0) silent = false;
        const r = (this.hw + j - this.trkDelay) & hM;
        this.dly[0][j] = h0[r]; this.dly[1][j] = h1[r];
      }
      this.hw = (this.hw + BLOCK) & hM;

      const spread = S[PI_.spread];
      const two = stereo || spread > 1e-4;
      // idle: nothing has come in for longer than the trackers' memory and the tracts have rung out
      if (silent) this.quiet++; else this.quiet = 0;
      const idleNow = this.quiet * BLOCK > this.latency + this.trk[0].memory + 0.5 * sr;
      if (idleNow) {
        if (!this.idle) { for (const t of this.trk) t.reset(); for (const t of this.tr) t.reset(); this.idle = true; }
        this.outL.fill(0); this.outR.fill(0);
        this.info.idle = true;
        return;
      }
      this.idle = false; this.info.idle = false;
      if (two && !this.twoTracts) { // the second tract starts from the first's state of mind
        const A = this.tr[0], B = this.tr[1];
        B.logF = A.logF;
      }
      this.twoTracts = two; this.info.stereo = stereo;

      // trackers: left always, right only for stereo input
      const thresh = TRK_THRESH;
      const w0 = (this.hw - BLOCK) & hM;
      this.trk[0].push(h0, hM, w0, BLOCK);
      this.trk[0].estimate(thresh);
      if (stereo) { this.trk[1].push(h1, hM, w0, BLOCK); this.trk[1].estimate(thresh); }

      const gOut = Math.pow(10, S[PI_.output] / 20), wet = S[PI_.mix], byp = S[PI_.bypass];
      if (!two) {
        this.runTract(0, 0, this.trk[0], this.dly[0], this.outL);
        for (let j = 0; j < BLOCK; j++) this.outR[j] = this.outL[j];
      } else {
        this.runTract(0, -spread, this.trk[0], this.dly[0], this.outL);
        this.runTract(1, spread, stereo ? this.trk[1] : this.trk[0], this.dly[1], this.outR);
      }
      // mix, output, bypass
      for (let j = 0; j < BLOCK; j++) {
        const dl = this.dly[0][j], dr = this.dly[1][j];
        let l = (wet * this.outL[j] + (1 - wet) * dl) * gOut, r = (wet * this.outR[j] + (1 - wet) * dr) * gOut;
        l = byp * dl + (1 - byp) * l; r = byp * dr + (1 - byp) * r;
        this.outL[j] = l; this.outR[j] = r;
      }
      for (let c = 0; c < 2; c++) {
        const t = c === 1 && !stereo ? this.trk[0] : this.trk[c];
        this.info.f[c] = t.f; this.info.conf[c] = t.conf; this.info.sure[c] = t.sure;
        const tr = this.tr[two ? c : 0];
        this.info.res[c] = tr.fRes; this.info.gape[c] = tr.gEff;
      }
    }

    // the tract of channel c, side −1 … +1 (Spread), fed by block x, written to out
    runTract(c, side, trk, x, out) {
      const t = this.tr[c], S = this.S, sr = this.sr;
      const mode = this.P[PI_.mode];
      const sc = sizeScale(S[PI_.size]);
      const boom = mode === 3, sac = mode >= 2, parrot = mode === 1;

      // trachea
      const lenM = Math.min(TUBE_MAX_M, S[PI_.trachlen] / 100 * sc * (boom ? BOOM_TUBE : 1) * (1 + side * SPREAD_LEN));
      const Tnew = Math.max(2, 2 * lenM / SOUND * sr);
      if (t.T === 0) t.T = Tnew;
      let T = t.T; const dT = (Tnew - T) / BLOCK; t.T = Tnew;
      const loss = S[PI_.trachloss], r = trachR(loss);
      const aLoss = 1 - Math.exp(-TWO_PI * Math.min(trachLp(loss), 0.45 * sr) / sr);
      const tubeNorm = Math.sqrt(1 - r * r);
      const tube = t.tube;
      let tw = t.tw, tlp = t.tlp;

      // cavity resonance target (log2 Hz) for this block
      const offOct = side * SPREAD_OCT;
      const logTune = Math.log2(S[PI_.tune]);
      if (t.logF < 0) t.logF = logTune;
      const track = S[PI_.track];
      const logPitch = trk.f > 0 ? Math.log2(trk.f) : logTune;
      if (trk.sure) t.held = logPitch; else if (t.held === undefined) t.held = logTune;
      const logTarget = track * t.held + (1 - track) * logTune
        + 0.5 * LARYNX_OCT * (S[PI_.larynx] - LARYNX_DEF) + offOct;
      const lag = this.P[PI_.lag];
      const cLag = lag <= 0 ? 1 : 1 - Math.exp(-1 / (lag * sr));
      const Q = ringQ(S[PI_.ring]);
      // beak gape: opens with pitch (Gape follow), smaller for a bigger bird
      const gEff = clamp(S[PI_.gape] + side * SPREAD_GAPE + S[PI_.gapefollow] * GAPE_FOLLOW * (t.held - Math.log2(GAPE_REF_HZ / sc)), 0, 1);
      t.gEff = gEff;
      const fcBeak = Math.min(0.45 * sr, GAPE_HZ[0] * Math.pow(GAPE_HZ[1] / GAPE_HZ[0], gEff) / sc);

      // body resonator
      const body = boom ? Math.max(BOOM_BODY, S[PI_.body]) : S[PI_.body];
      const co = this.co, svf = t.svf;
      // in Boom the body rings with the sac, as a cassowary's whole body does
      const fBoom = S[PI_.sactune] / BOOM_DIV * Math.pow(2, side * SPREAD_OCT);
      if (body > 0) svfCoefs(boom ? fBoom : BODY_HZ / sc, BODY_Q, sr, co, 20);

      // radiation: unity at the mode's own band, so switching it changes colour more than level
      const rad = S[PI_.radiation];
      const gMode = GAIN[mode] * (rad + (1 - rad) * GAIN_FLOW[mode]);

      // Parrot formants and Sac set-up (fixed for the block)
      let aBeak = 0;
      if (parrot || sac) aBeak = 1 - Math.exp(-TWO_PI * fcBeak / sr);
      const fbT = S[PI_.tonguefb], ht = S[PI_.tongueht];
      const pg = this.pg;
      if (parrot) {
        const qF = 2 + 10 * S[PI_.ring];
        for (let k = 0; k < 4; k++) {
          const F = PARROT[k], f = (F.f0 + (F.f1 - F.f0) * fbT) / sc * Math.pow(2, offOct);
          svfCoefs(f, qF, sr, co, 4 * k);
          // uneven level changes with front/back, all down with height
          let g = F.g;
          if (k === 1) g *= 0.6 + 0.8 * fbT;
          if (k === 2) g *= 1.3 - 0.6 * fbT;
          pg[k] = g * (1 - PARROT_HEIGHT * ht);
        }
        t.fRes = (PARROT[0].f0 + (PARROT[0].f1 - PARROT[0].f0) * fbT) / sc;
      }
      let aWall = 0, aLeak = 0, inflate = 0;
      if (sac) {
        inflate = S[PI_.inflate];
        const fS = S[PI_.sactune] / (boom ? BOOM_DIV : 1) * Math.pow(2, offOct);
        svfCoefs(fS, 3 + 9 * inflate, sr, co, 16);
        aWall = 1 - Math.exp(-TWO_PI * Math.min(0.45 * sr, SAC_WALL * fS) / sr);
        aLeak = 1 - Math.exp(-TWO_PI * SAC_LEAK_HZ / sr);
        t.fRes = fS;
      }
      const radK = 1 / (2 * Math.sin(Math.PI * Math.min(0.45 * sr, sac ? t.fRes : RAD_REF_HZ / sc) / sr));

      let ug = t.ug, pc = t.pc, ub = t.ub, pPrev = t.pPrev, logF = t.logF;
      let lp1 = t.lp1, lp2 = t.lp2, lp3 = t.lp3, leak = t.leak, leak2 = t.leak2, radPrev = t.radPrev;
      const tap = this.tap;
      for (let j = 0; j < BLOCK; j++) {
        // --- trachea: closed at the source, inverting reflection at the open end
        T += dT;
        const rp = tw - T, j0 = Math.floor(rp), fr = rp - j0;
        const back = tube[j0 & TUBE_MASK] * (1 - fr) + tube[(j0 + 1) & TUBE_MASK] * fr;
        tlp += aLoss * (back - tlp);
        tube[tw & TUBE_MASK] = x[j] + r * tlp;
        const hp = tw - 0.5 * T, k0 = Math.floor(hp), fk = hp - k0;
        const p = tubeNorm * (tube[k0 & TUBE_MASK] * (1 - fk) + tube[(k0 + 1) & TUBE_MASK] * fk);
        tw++;

        let y = 0;
        if (mode === 0) {
          // --- Song: larynx (Lg, Rg) → OEC (Ch) → beak (Lb, Rb), trapezoidal, prewarped at the resonance
          logF += cLag * (logTarget - logF);
          const f = clamp(Math.pow(2, logF), F_LO, 0.42 * sr);
          const w = TWO_PI * f;
          const Lg = 1, Lb = LB_RATIO * Lg / (0.2 + gEff);
          const Leff = Lg * Lb / (Lg + Lb);
          const Ch = 1 / (w * w * Leff), Rg = w * Lg / Q, Rb = TWO_PI * fcBeak * Lb;
          const hh = 2 * Math.tan(w / (2 * sr)) / w;   // prewarped step
          const ah = 0.5 * hh, kg = ah / Lg, kc = ah / Ch, kb = ah / Lb;
          const A1 = 1 + kg * Rg, A3 = 1 + kb * Rb;
          const r1 = ug + kg * (pPrev + p - pc - Rg * ug);
          const r2 = pc + kc * (ug - ub);
          const r3 = ub + kb * (pc - Rb * ub);
          const pc1 = (r2 + kc * r1 / A1 - kc * r3 / A3) / (1 + kc * kg / A1 + kc * kb / A3);
          ug = (r1 - kg * pc1) / A1;
          ub = (r3 + kb * pc1) / A3;
          pc = pc1; pPrev = p;
          y = Rb * ub / Math.sqrt(Q);
        } else if (parrot) {
          for (let k = 0; k < 4; k++) {
            const o = 4 * k, s = 2 * k, a1 = co[o], a2 = co[o + 1], a3 = co[o + 2];
            const v3 = p - svf[s + 1], v1 = a1 * svf[s] + a2 * v3, v2 = svf[s + 1] + a2 * svf[s] + a3 * v3;
            svf[s] = 2 * v1 - svf[s]; svf[s + 1] = 2 * v2 - svf[s + 1];
            y += pg[k] * co[o + 3] * v1;
          }
          lp1 += aBeak * (y - lp1); y = lp1;     // beak
        } else {
          // --- Sac (and Boom): beak closed, the inflated esophagus radiates one narrow resonance
          const a1 = co[16], a2 = co[17], a3 = co[18];
          const v3 = p - svf[9], v1 = a1 * svf[8] + a2 * v3, v2 = svf[9] + a2 * svf[8] + a3 * v3;
          svf[8] = 2 * v1 - svf[8]; svf[9] = 2 * v2 - svf[9];
          lp2 += aWall * (co[19] * v1 - lp2);    // soft wall damps the highs (two poles)
          lp3 += aWall * (lp2 - lp3);
          leak += aLeak * (p - leak); leak2 += aLeak * (leak - leak2);   // what gets past the closed beak
          y = inflate * lp3 + (1 - inflate) * SAC_LEAK * leak2;
        }
        // --- body: a low resonator driven by the trachea
        if (body > 0) {
          const a1 = co[20], a2 = co[21], a3 = co[22];
          const v3 = p - svf[11], v1 = a1 * svf[10] + a2 * v3, v2 = svf[11] + a2 * svf[10] + a3 * v3;
          svf[10] = 2 * v1 - svf[10]; svf[11] = 2 * v2 - svf[11];
          y += body * BODY_GAIN * co[23] * v1;
        }
        // --- radiation: flow → pressure (+6 dB/oct, unity at RAD_REF_HZ), crossfaded with flow
        const yr = (y - radPrev) * radK; radPrev = y;
        out[j] = gMode * (rad * yr + (1 - rad) * y);
        if (tap !== null && c === 0 && tap.n < tap.len) { tap.p[tap.n] = p; tap.f[tap.n] = mode === 0 ? Math.pow(2, logF) : t.fRes; tap.n++; }
      }
      if (mode === 0) t.fRes = clamp(Math.pow(2, logF), F_LO, 0.42 * sr);
      else logF = logTarget;
      // a runaway state (should never happen) is reset rather than allowed to blow up
      if (!(Math.abs(pc) < 1e6 && Math.abs(ug) < 1e6 && Math.abs(ub) < 1e6 && Math.abs(tlp) < 1e6 && Math.abs(lp1) < 1e6 && Math.abs(lp2) < 1e6 && Math.abs(lp3) < 1e6)) {
        const held = t.held; t.reset(); t.held = held; return;
      }
      t.ug = ug; t.pc = pc; t.ub = ub; t.pPrev = pPrev; t.logF = logF;
      t.lp1 = lp1; t.lp2 = lp2; t.lp3 = lp3; t.leak = leak; t.leak2 = leak2; t.radPrev = radPrev;
      t.tw = tw; t.tlp = tlp; t.T = T;
    }

    // magnitude response (dB) of channel c's tract at the given frequencies, at the current
    // smoothed settings and cavity tuning. For the bench's response curve and the tests.
    response(c, freqs, outDb) {
      const t = this.tr[c], S = this.S, sr = this.sr, mode = this.P[PI_.mode];
      const side = this.twoTracts ? (c === 0 ? -1 : 1) * S[PI_.spread] : 0;
      const sc = sizeScale(S[PI_.size]), boom = mode === 3;
      const lenM = Math.min(TUBE_MAX_M, S[PI_.trachlen] / 100 * sc * (boom ? BOOM_TUBE : 1) * (1 + side * SPREAD_LEN));
      const T = 2 * lenM / SOUND * sr;
      const loss = S[PI_.trachloss], r = trachR(loss), fl = Math.min(trachLp(loss), 0.45 * sr);
      const Q = ringQ(S[PI_.ring]);
      const offOct = side * SPREAD_OCT;
      const fRes = mode === 0 ? (t.fRes || S[PI_.tune]) : t.fRes;
      const gEff = t.gEff || S[PI_.gape];
      const fcBeak = Math.min(0.45 * sr, GAPE_HZ[0] * Math.pow(GAPE_HZ[1] / GAPE_HZ[0], gEff) / sc);
      const rad = S[PI_.radiation];
      const fSac = S[PI_.sactune] / (boom ? BOOM_DIV : 1) * Math.pow(2, offOct);
      const radK = 1 / (2 * Math.sin(Math.PI * Math.min(0.45 * sr, mode >= 2 ? fSac : RAD_REF_HZ / sc) / sr));
      const bp = (f, f0, q) => { // unity-peak band-pass, analog
        const u = f / f0; const re = 1 - u * u, im = u / q; return { re: (im * im) / (re * re + im * im), im: (im * re) / (re * re + im * im) };
      };
      for (let i = 0; i < freqs.length; i++) {
        const f = freqs[i], w = TWO_PI * f;
        // trachea: sqrt(1 − r²) / (1 − r · lp · e^{−jωT/sr}) (delay of half a round trip drops out of |H|)
        const lpRe = 1 / (1 + (f / fl) * (f / fl)), lpIm = -(f / fl) * lpRe;
        const ph = -w * T / sr, eRe = Math.cos(ph), eIm = Math.sin(ph);
        const qRe = 1 - r * (lpRe * eRe - lpIm * eIm), qIm = -r * (lpRe * eIm + lpIm * eRe);
        let mag = Math.sqrt(1 - r * r) / Math.hypot(qRe, qIm);
        if (mode === 0) {
          const wH = TWO_PI * fRes, Lg = 1, Lb = LB_RATIO / (0.2 + gEff), Leff = Lg * Lb / (Lg + Lb);
          const Ch = 1 / (wH * wH * Leff), Rg = wH / Q, Rb = TWO_PI * fcBeak * Lb;
          // Zb = Rb + jωLb, Zc = 1/(jωCh); Zp = Zc‖Zb; H = Rb · Zp / ((Rg + jωLg + Zp) · Zb)
          const zbRe = Rb, zbIm = w * Lb;
          // Zp = Zb / (1 + jωCh Zb)
          const dRe = 1 - w * Ch * zbIm, dIm = w * Ch * zbRe;
          const dd = dRe * dRe + dIm * dIm;
          const zpRe = (zbRe * dRe + zbIm * dIm) / dd, zpIm = (zbIm * dRe - zbRe * dIm) / dd;
          const tRe = Rg + zpRe, tIm = w * Lg + zpIm;
          const num = Rb * Math.hypot(zpRe, zpIm), den = Math.hypot(tRe, tIm) * Math.hypot(zbRe, zbIm);
          mag *= num / den / Math.sqrt(Q);
        } else if (mode === 1) {
          const fbT = S[PI_.tonguefb], ht = S[PI_.tongueht], qF = 2 + 10 * S[PI_.ring];
          let re = 0, im = 0;
          for (let k = 0; k < 4; k++) {
            const F = PARROT[k], f0 = (F.f0 + (F.f1 - F.f0) * fbT) / sc * Math.pow(2, offOct);
            let g = F.g; if (k === 1) g *= 0.6 + 0.8 * fbT; if (k === 2) g *= 1.3 - 0.6 * fbT; g *= 1 - PARROT_HEIGHT * ht;
            const b = bp(f, Math.min(f0, 0.45 * sr), qF); re += g * b.re; im += g * b.im;
          }
          mag *= Math.hypot(re, im) / Math.sqrt(1 + (f / fcBeak) * (f / fcBeak));
        } else {
          const inflate = S[PI_.inflate], fS = S[PI_.sactune] / (boom ? BOOM_DIV : 1) * Math.pow(2, offOct);
          const b = bp(f, fS, 3 + 9 * inflate), wall = SAC_WALL * fS;
          const lw = 1 / Math.sqrt(1 + (f / wall) * (f / wall)), lk = 1 / Math.sqrt(1 + (f / SAC_LEAK_HZ) * (f / SAC_LEAK_HZ));
          mag *= inflate * Math.hypot(b.re, b.im) * lw * lw + (1 - inflate) * SAC_LEAK * lk * lk;
        }
        const radMag = 2 * Math.sin(Math.PI * Math.min(f, 0.5 * sr) / sr) * radK;
        mag *= GAIN[mode] * (rad + (1 - rad) * GAIN_FLOW[mode]) * (rad * radMag + (1 - rad));
        outDb[i] = 20 * Math.log10(Math.max(1e-9, mag));
      }
      return outDb;
    }
  }

  BeakTube.PARAMS = PARAMS;
  BeakTube.MODES = ['Song', 'Parrot', 'Sac', 'Boom'];
  BeakTube.GAIN = GAIN; BeakTube.GAIN_FLOW = GAIN_FLOW;   // tools/calibrate.js reads these
  BeakTube.sizeScale = sizeScale;
  BeakTube.Tracker = Tracker;

  if (typeof module !== 'undefined' && module.exports) module.exports = { BeakTube, PARAMS, Tracker, sizeScale };
  else root.BeakTube = BeakTube;
})(typeof globalThis !== 'undefined' ? globalThis : this);
