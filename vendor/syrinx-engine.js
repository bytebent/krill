/*
 * Syrinx engine v0.3 · bytebent
 *
 * A bird voice. Each voice is a syrinx with one, two or three sound sources. A labial source is
 * the normal form of the Mindlin group's model (Sitt et al. 2010; Perl et al. 2011), a
 * two-variable nonlinear oscillator
 *     x' = y,   y' = γ²·α + γ²·β·x + γ²·x² − γ·x·y − γ²·x³ − γ·x²·y
 * where α is pressure (more negative = more drive), β is labial tension and γ a time scale.
 *   - γ only rescales time, so the pitch is exactly γ times the oscillator's frequency at γ = 1.
 *     A map of that frequency over (Regime, drive), made by tools/make-maps.js, lets every block
 *     set γ so the note comes out in tune whatever the timbre.
 *   - Regime moves along a path from the Hopf side (born as a pure tone) to the SNILC side (born
 *     pulse-like and rich). Link makes Regime follow the note, as in zebra finch song.
 *   - Topology: Duplex (left and right sides, as in songbirds), Single (one source of two folds,
 *     as in doves and parrots), Triple (labia plus a tracheal membrane, a van der Pol oscillator,
 *     as in the tracheophones; Garcia et al. 2017).
 *   - Coupling: the sources meet in a shared pressure at the base of the trachea (Laje & Mindlin
 *     2005); each source's position nudges the drive of the others.
 *   - Breath and gates: the envelope shapes pressure; pattern syllables gate the sources with
 *     sample accuracy; minibreaths drop the drive between slow syllables; Wobble is superfast
 *     muscle modulation, up to 250 Hz.
 *
 *   - Internal trachea: a delay line per voice; its reflection reaches the drive (Jumps, Chaos) and,
 *     with Filter on, what leaves its far end is the sound.
 *   - Lock: every pitch lands on a semitone; a pitch keeper measures each source's period and
 *     corrects γ, so coupling and tube feedback cannot pull a note out of tune.
 *   - Size moves the whole bird: pitch range, Split, the Link band and the tube length.
 *
 * Batches 02–07 (see plan.md).
 *
 * All sources of a voice are integrated together, RK4 at 4x the host rate, with a shared number
 * of sub-steps that keeps every step at or below 0.1 time units (pitch error under 0.1 cent), in
 * fixed 32-sample blocks, then decimated with a windowed-sinc FIR, as in Throat and Dolphin.
 * process() never allocates. Same seed, same notes: same output, at any host buffer size.
 *
 * Works in an AudioWorklet and in Node (module.exports) for offline tests.
 */
(function (root) {
  'use strict';

  const OS = 4;                 // internal oversampling
  const BLOCK = 32;             // fixed internal block (host samples) = latency
  const FIR_LEN = 128;          // decimation filter taps (at 4x rate)
  const MAX_VOICES = 4;         // Poly voices (batch 03: worst case about 11% of a core per voice)
  const TWO_PI = 2 * Math.PI;
  const LOG2_440 = Math.log2(440);

  /* ---------- the model and its map ---------- */
  const BETA_LO = -0.4, BETA_HI = 0.4;     // Regime 0 → 1
  const D_MIN = 2e-4, D_MAX = 0.3;         // drive past onset covered by the map
  const ROWS = 49, COLS = 97;              // map size (row 9 sits on the Hopf/SNILC corner, β = −0.25)
  const U0 = Math.sqrt(D_MIN / D_MAX);
  const H_MAX = 0.1;                       // largest RK4 step, in model time units
  const MAX_SUB = 48;                      // sub-steps per oversampled sample, at most (the band limit keeps it under 20)
  const D_HOPF = 0.15, D_SNILC = 1e-3;     // drive at default Pressure and full envelope, Regime 0 and 1
  const PRESS_OCT = 8;                     // Pressure 0–1 spans 8 octaves of drive (default 0.7)
  const NORM_POW = 0.7;                    // how much loudness is evened out across the map
  const LEVEL = 0.22;
  const GRAIN_SD = 0.03;                   // tension noise at Grain 1 (β units)
  const GRAIN_HZ = 1000;                   // tension noise bandwidth
  const LINK_LO = 1000, LINK_HI = 2250;    // Hz: rich below, tonal above (Sitt et al. 2008, 2010)
  const CONTENT_HZ = 15000;                // band limit: spectral content at most CONTENT_HZ / pitch,
                                           // so high notes get the drive they need to stay below 4x Nyquist

  // onset line: Hopf at α = 0 up to β = −0.25, then the saddle-node of the fixed points (SNILC)
  function alphaOn(b) {
    if (b <= -0.25) return 0;
    const x = (2 + Math.sqrt(4 + 12 * b)) / 6;
    return Math.min(0, -b * x - x * x + x * x * x);
  }
  function colDrive(c) { const u = U0 + (1 - U0) * c / (COLS - 1); return D_MAX * u * u; }
  function rowBeta(r) { return BETA_LO + (BETA_HI - BETA_LO) * r / (ROWS - 1); }
  // one RK4 step of the oscillator at γ = 1; s = [x, y]
  function accel(a, b, x, y) { return a + b * x + x * x - x * y - x * x * x - x * x * y; }
  function rk4(a, b, s, h) {
    const x = s[0], y = s[1];
    const k1x = y, k1y = accel(a, b, x, y);
    const k2x = y + 0.5 * h * k1y, k2y = accel(a, b, x + 0.5 * h * k1x, y + 0.5 * h * k1y);
    const k3x = y + 0.5 * h * k2y, k3y = accel(a, b, x + 0.5 * h * k2x, y + 0.5 * h * k2y);
    const k4x = y + h * k3y, k4y = accel(a, b, x + h * k3x, y + h * k3y);
    s[0] = x + h / 6 * (k1x + 2 * k2x + 2 * k3x + k4x);
    s[1] = y + h / 6 * (k1y + 2 * k2y + 2 * k3y + k4y);
  }
  const core = { BETA_LO, BETA_HI, D_MIN, D_MAX, ROWS, COLS, alphaOn, colDrive, rowBeta, rk4 };

  let MAP = null;
  if (typeof module !== 'undefined' && module.exports) {
    try { MAP = require('./syrinx-maps.js'); } catch (err) { MAP = null; }   // absent while make-maps.js runs
  } else MAP = root.SyrinxMap || null;

  // map lookup at Regime r (0–1) and drive d: Catmull-Rom across both. The onset line has a corner
  // at β = −0.25, which sits exactly on row KINK; no stencil reaches across it.
  const KINK = 9;
  function cubic(p0, p1, p2, p3, t) {
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  function rowAt(arr, row, cx) {
    const c = Math.min(COLS - 2, Math.max(0, Math.floor(cx))), t = cx - c, o = row * COLS;
    const p1 = arr[o + c], p2 = arr[o + c + 1];
    // ends: extend linearly so the curve stays smooth
    const p0 = c === 0 ? 2 * p1 - p2 : arr[o + c - 1];
    const p3 = c + 2 > COLS - 1 ? 2 * p2 - p1 : arr[o + c + 2];
    return cubic(p0, p1, p2, p3, t);
  }
  function at(arr, r0, t, cx) {
    const p1 = rowAt(arr, r0, cx), p2 = rowAt(arr, r0 + 1, cx);
    const p0 = r0 === 0 || r0 === KINK ? 2 * p1 - p2 : rowAt(arr, r0 - 1, cx);
    const p3 = r0 + 1 === ROWS - 1 || r0 + 1 === KINK ? 2 * p2 - p1 : rowAt(arr, r0 + 2, cx);
    return cubic(p0, p1, p2, p3, t);
  }
  function coords(r, d) {
    const ry = Math.min(1, Math.max(0, r)) * (ROWS - 1);
    const u = Math.sqrt(Math.min(D_MAX, Math.max(D_MIN, d)) / D_MAX);
    const r0 = Math.min(ROWS - 2, Math.floor(ry));
    return [r0, ry - r0, (u - U0) / (1 - U0) * (COLS - 1)];
  }
  function lookup(r, d, out) {
    const [r0, t, cx] = coords(r, d);
    out.f = at(MAP.f, r0, t, cx);
    out.rms = at(MAP.rms, r0, t, cx);
    out.mean = at(MAP.mean, r0, t, cx);
    out.sci = at(MAP.sci, r0, t, cx);
    return out;
  }
  function sciAt(r, d) { const [r0, t, cx] = coords(r, d); return at(MAP.sci, r0, t, cx); }
  // least drive whose spectral content stays at or under smax (content falls as drive grows)
  function driveForContent(r, d, smax) {
    if (sciAt(r, d) <= smax) return d;
    let lo = Math.sqrt(d / D_MAX), hi = 1;
    if (sciAt(r, D_MAX) > smax) return D_MAX;
    for (let i = 0; i < 18; i++) { const m = 0.5 * (lo + hi); if (sciAt(r, D_MAX * m * m) > smax) lo = m; else hi = m; }
    return D_MAX * hi * hi;
  }

  /* ---------- the tracheal membrane (Triple) ---------- */
  // A van der Pol oscillator, z'' = ε(μ − z²)z' − z, after Garcia et al. 2017: pulse-like and low.
  // μ is its driving pressure (amplitude about 2√μ); its frequency at time scale 1 depends on εμ.
  const VDP_EPS = 3;
  const VDP_MU = [];                       // table of frequency against μ, built once
  (function buildVdp() {
    for (let i = 0; i <= 32; i++) {
      const mu = 0.02 + 0.98 * i / 32, h = 0.01;
      let z = 0.1, v = 0;
      const acc = (z, v) => VDP_EPS * (mu - z * z) * v - z;
      const step = () => {
        const k1z = v, k1v = acc(z, v);
        const k2z = v + 0.5 * h * k1v, k2v = acc(z + 0.5 * h * k1z, v + 0.5 * h * k1v);
        const k3z = v + 0.5 * h * k2v, k3v = acc(z + 0.5 * h * k2z, v + 0.5 * h * k2v);
        const k4z = v + h * k3v, k4v = acc(z + h * k3z, v + h * k3v);
        z += h / 6 * (k1z + 2 * k2z + 2 * k3z + k4z); v += h / 6 * (k1v + 2 * k2v + 2 * k3v + k4v);
      };
      for (let t = 0; t < 200; t += h) step();
      let prev = z, cross = [], n = 0;
      while (cross.length < 11) { step(); n++; if (prev < 0 && z >= 0) cross.push(n - 1 + -prev / (z - prev)); prev = z; }
      VDP_MU.push(10 / ((cross[10] - cross[0]) * h));
    }
  })();
  function vdpFreq(mu) {
    const t = clamp((mu - 0.02) / 0.98 * 32, 0, 32), i = Math.min(31, Math.floor(t)), f = t - i;
    return VDP_MU[i] + (VDP_MU[i + 1] - VDP_MU[i]) * f;
  }

  // ids, defaults and ranges: the one table the C++ core and the UI copy.
  // log: the knob moves logarithmically; curve: knob position^curve; step: whole steps.
  // All of design.md §9 (batches 02–07).
  const PARAMS = [
    // source
    { id: 'topology', def: 0, min: 0, max: 2, step: 1 },     // Duplex, Single, Triple
    { id: 'membrane', def: -24, min: -48, max: 12 },         // semitones from the note (Triple)
    { id: 'memlevel', def: 0.5, min: 0, max: 1 },            // membrane pressure (Triple)
    { id: 'regime', def: 0.3, min: 0, max: 1 },              // Hopf (tonal) → SNILC (pulse-like)
    { id: 'link', def: 0.7, min: 0, max: 1 },                // how much Regime follows the note
    { id: 'grain', def: 0.15, min: 0, max: 1 },              // noise on tension
    { id: 'breathbend', def: 0, min: 0, max: 1 },            // octaves of pitch from pressure
    // sides
    { id: 'playmode', def: 0, min: 0, max: 3, step: 1 },     // Handoff, Interval, Duo, Independent
    { id: 'split', def: 3500, min: 500, max: 8000, log: true },  // Hz, handoff point
    { id: 'overlap', def: 300, min: 0, max: 1500 },          // Hz, crossover band
    { id: 'interval', def: 7.3, min: -24, max: 24 },         // semitones, right side in Interval mode
    { id: 'asym', def: 0.2, min: 0, max: 1 },                // how much the sides (or folds) differ
    { id: 'balance', def: 0, min: -1, max: 1 },              // left–right level
    { id: 'coupling', def: 0.1, min: 0, max: 1 },            // pull between sources through the shared tube
    // nonlinear
    { id: 'jumps', def: 0, min: 0, max: 1 },                 // reflection fed back from the internal trachea
    { id: 'trachea', def: 3.5, min: 1, max: 200, log: true },// cm, internal tube length
    { id: 'chaos', def: 0, min: 0, max: 1 },                 // strong coupling plus feedback
    // muscles
    { id: 'wobblerate', def: 0, min: 0, max: 250 },          // Hz
    { id: 'wobble', def: 0, min: 0, max: 1 },
    { id: 'wobblefm', def: 0, min: 0, max: 1 },              // 0 amplitude, 1 pitch
    // breath
    { id: 'pressure', def: 0.7, min: 0, max: 1 },            // drive past onset
    { id: 'attack', def: 0.008, min: 0.001, max: 5, curve: 3 },
    { id: 'decay', def: 0.3, min: 0.001, max: 5, curve: 3 },
    { id: 'sustain', def: 0.8, min: 0, max: 1 },
    { id: 'release', def: 0.03, min: 0.001, max: 8, curve: 3 },
    { id: 'minibreath', def: 0.6, min: 0, max: 1 },          // drive dip between slow syllables
    // pattern
    { id: 'pattern', def: 0, min: 0, max: 1, step: 1 },
    { id: 'sylrate', def: 8, min: 0.5, max: 60, log: true }, // syllables per second
    { id: 'sync', def: 0, min: 0, max: 1, step: 1 },
    { id: 'duty', def: 0.6, min: 0.05, max: 0.95 },
    { id: 'shape', def: 2, min: 0, max: 5, step: 1 },        // Flat, Up, Down, Convex, Concave, Wave
    { id: 'sweep', def: 1, min: -4, max: 4 },                // octaves
    { id: 'sides', def: 0, min: 0, max: 3, step: 1 },        // Auto, Left, Right, Alternate
    { id: 'trill', def: 0.7, min: 0, max: 1 },               // trill limit (Podos 1997)
    { id: 'jitter', def: 0.05, min: 0, max: 1 },
    // pitch and output
    { id: 'transpose', def: 36, min: -24, max: 60, step: 1 },  // semitones; middle C plays about 2.1 kHz
    { id: 'detune', def: 0, min: -100, max: 100 },           // cents
    { id: 'glide', def: 0.02, min: 0, max: 2, curve: 3 },    // s, mono only
    { id: 'bendrange', def: 12, min: 2, max: 48, step: 1 },
    { id: 'mode', def: 0, min: 0, max: 1, step: 1 },         // 0 mono, 1 poly (4 voices)
    { id: 'size', def: 0.25, min: 0, max: 1 },               // wren (0) to crane (1); 0.25 songbird
    { id: 'tempolock', def: 0.5, min: 0, max: 1 },           // 1 keeps syllable timing at any Size, 0 slows it with Size
    { id: 'filter', def: 1, min: 0, max: 1, step: 1 },       // internal trachea and tracking resonance on the output
    { id: 'volume', def: -6, min: -48, max: 6 },             // dB
    // musical lock
    { id: 'lock', def: 0, min: 0, max: 1, step: 1 },         // every pitch on a semitone
    { id: 'glidestyle', def: 0, min: 0, max: 1, step: 1 },   // Smooth, Stepped (a chromatic run)
  ];
  const PINDEX = {};
  PARAMS.forEach((p, i) => { PINDEX[p.id] = i; });

  const SYL_DIVS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];   // syllables per beat (Sync)
  const COUPLE_DC = 0.002;                 // coupling acts on drive + this, so tonal sources feel it too
  const COUPLE_MAX = 0.8;                  // the push from the other sources never swings the drive past this share of itself
                                           // (beyond it a tonal side froze and the other relaxed at a few hundred Hz)
  const MEM_LEVEL = 0.6;                   // membrane output against the labia
  const WOBBLE_CENTS = 200;                // pitch depth of Wobble at full
  const GATE_MS = 1.5;                     // side and syllable gate time, at most
  // the internal trachea (Laje & Mindlin 2005; Arneodo & Mindlin 2009): a tube closed at the syrinx
  // and open at the far end. The sources push pressure in; the far end reflects part of it back,
  // which reaches the sources' drive (Jumps) and, with Filter on, what comes out of the far end is
  // the sound, through a light resonance that follows the pitch.
  const SOUND = 350;                       // m/s
  const TUBE_N = 16384, TUBE_MASK = TUBE_N - 1;   // 2 m of tube at 4 x 192 kHz
  const TUBE_R0 = 0.5, JUMP_R = 0.45;      // reflection at the far end: 0.5, up to 0.95 with Jumps
  const JUMP_K = 0.3;                      // feedback into the drive at Jumps 1 (follows Jumps squared:
                                           // a subtle pull up to about 0.3, jumps with hysteresis from about 0.5)
  // Chaos (batch 06 experiments): chaos appears with rich sources, moderate feedback and two
  // sources a wide, non-harmonic interval apart; tonal sources and locked pairs stay periodic
  const CHAOS_K = 0.3;                     // extra tube feedback at Chaos 1
  const CHAOS_REG = 0.6;                   // Chaos pulls Regime up to at least this
  const CHAOS_ST = 3.3;                    // Chaos in Handoff: the other side opens this far above (or below)
  const CHAOS_C = 0.3;                     // extra coupling at Chaos 1
  const TUBE_LOSS_HZ = 10000;              // wall loss: one-pole low-pass on the returning wave
  const FILTER_Q = 2.5, FILTER_MIX = 0.7;  // tracking resonance on the pitch
  const FILTER_GAIN = 2.8;                 // level match, Filter on against off (average over notes and Regime)
  const SINGLE_PULL = 0.05;                 // Single: fold pull at Coupling 0 is 0.3 × this
  const SINGLE_CENTS = 300;                // Single: fold detuning at full Asymmetry (they stop locking past about 1 semitone)
  const SIZE_OCT = 8 / 3;                  // octaves down per unit of Size above 0.25 (crane: 2 octaves under a songbird)
  // pitch keeper (Lock): counts the periods each source really makes against the cycles its
  // commanded pitch should make, and corrects γ. Sweep-proof, since both count the same stretch.
  const KEEP_G = 0.06;                     // correction per measured period (slow enough for an 8-period window)
  const KEEP_K = 8;                        // periods per measurement (one period alone misses an occasional extra crossing)
  const KEEP_ARM = 0.3;                    // a period ends at an upward zero crossing after dipping below −this × its amplitude
  const KEEP_MAX = 0.25;                   // octaves of correction, at most; a source still off at the limit has been captured
  const KEEP_RING = 16;
  const KEEP_STEP = 0.02;                  // octaves per block: a faster change of the target is a step (Stepped runs,
  const KEEP_HOLD = 4;                     // syllable starts); the keeper starts over and skips this many periods
                                           // while its band-pass settles
  const LOCK_JUMPS = 0.7;                  // Lock: Jumps covers the part the keeper can hold (above it the tube owns the pitch
                                           // and γ no longer steers it)
  const LOCK_COUPLING = 0.35;              // Lock: Coupling covers the part the keeper can hold (above it the sides lock onto one pitch and wobble)
  const KEEP_Q = 8;                        // the keeper listens through a band-pass on the source's own pitch,
                                           // so another source's tone in its waveform does not add crossings

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
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // syllable pitch shapes, u in [0, 1] → offset in units of Sweep (as Dolphin's whistle)
  function shapeAt(shape, u) {
    switch (shape) {
      case 1: return 1 - (1 - u) * (1 - u);              // Up
      case 2: return -(1 - (1 - u) * (1 - u));           // Down
      case 3: return Math.sin(Math.PI * u);              // Convex
      case 4: return -Math.sin(Math.PI * u);             // Concave
      case 5: return Math.sin(3 * Math.PI * u);          // Wave
      default: return 0;                                  // Flat
    }
  }
  const SHAPE_RANGE = [[0, 0], [0, 1], [-1, 0], [0, 1], [-1, 0], [-1, 1]];
  // Podos 1997, pooled upper bound: frequency bandwidth (Hz) a trill of this rate can cover
  function podosBandwidth(rate) { return Math.max(200, (7.55 - 0.124 * rate) * 1000); }

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

  /* ---------- one voice: up to three sources (0 left, 1 right, 2 membrane) ---------- */
  class Voice {
    constructor(e, seed) {
      this.e = e;
      this.seed = (seed >>> 0) || 1;
      // per source, struct of arrays
      this.x = new Float64Array(3); this.y = new Float64Array(3);
      this.a0 = new Float64Array(3); this.b0 = new Float64Array(3); this.g0 = new Float64Array(3);
      this.gain0 = new Float64Array(3); this.mean0 = new Float64Array(3); this.rms0 = new Float64Array(3);
      this.d0 = new Float64Array(3); this.slope = new Float64Array(3);
      this.gs = new Float64Array(3);       // side gate, smoothed (0 closed, 1 open)
      this.w = new Float64Array(3);        // side gate target for this block
      this.on = new Uint8Array(3);         // integrated this block
      this.noise = new Float64Array(3);
      this.prevN = new Float64Array(3);    // last normalized output, for coupling
      this.q = { f: 0, rms: 1, mean: 0, sci: 1 };
      this.logF = new Float64Array(2); this.glideLeft = new Int32Array(2); this.glideStep = new Float64Array(2);
      this.sideNote = new Int32Array(2); this.sideHeld = new Uint8Array(2);
      this.patGate = new Float32Array(BLOCK * OS);
      this.tube = new Float64Array(TUBE_N);
      // pitch keeper per labial source
      this.corr = new Float64Array(2); this.aim = new Float64Array(2); this.kph = new Float64Array(2);
      this.khz = new Float64Array(2); this.kring = new Float64Array(2 * KEEP_RING);
      this.kcount = new Int32Array(2); this.knew = new Int32Array(2); this.karm = new Uint8Array(2); this.kprev = new Float64Array(2);
      this.kb = new Float64Array(4);       // band-pass state, two per source
      this.kenv = new Float64Array(2);     // amplitude after the band-pass
      this.khold = new Int32Array(2);
      this.fNow = new Float64Array(3); this.subNow = 0; this.regimeNow = 0; this.driveNow = 0; this.sciNow = 1; this.gammaNow = 0;
      this.reset();
    }
    reset() {
      this.rng = this.seed;
      this.stage = 0; this.env = 0; this.note = -1; this.held = false; this.vel = 1; this.age = 0;
      this.logF.fill(Math.log2(440)); this.glideLeft.fill(0); this.glideStep.fill(0);
      this.sideNote.fill(-1); this.sideHeld.fill(0);
      this.x.fill(0); this.y.fill(0); this.gs.fill(0); this.w.fill(0); this.on.fill(0);
      this.noise.fill(0); this.prevN.fill(0); this.fresh = true;
      this.gp = 0;                          // pattern gate, smoothed
      this.wobPh = 0;
      // pattern state
      this.pPhase = 0; this.sylRate = 8; this.sylPitch = 0; this.sylSweep = 0; this.sylSide = 1; this.sylCount = 0;
      this.contour0 = 0;
      this.tube.fill(0); this.tw = 0; this.tlp = 0; this.Tsm = 0; this.ic1 = 0; this.ic2 = 0;
      this.resetKeeper();
    }
    resetKeeper() {
      this.corr.fill(0); this.aim.fill(0); this.kph.fill(0); this.khz.fill(0);
      this.kcount.fill(0); this.knew.fill(0); this.karm.fill(0); this.kprev.fill(0); this.kb.fill(0); this.kenv.fill(0); this.khold.fill(0);
    }
    // a period has ended at expected-cycle count ph
    keepCross(j, ph) {
      if (this.khold[j] > 0) { this.khold[j]--; return; }
      const o = j * KEEP_RING, n = this.kcount[j];
      if (n > 0) {
        const gap = ph - this.kring[o + (n - 1) % KEEP_RING];
        if (gap > 2.5 || gap < 0.3) this.kcount[j] = 0;                      // the source stopped, or a spurious crossing
      }
      const m = this.kcount[j];
      this.kring[o + m % KEEP_RING] = ph;
      this.kcount[j] = m + 1; this.knew[j]++;
    }
    // block end: correct γ from the last KEEP_K periods
    keepUpdate(j) {
      const n = this.kcount[j], fresh = this.knew[j];
      this.knew[j] = 0;
      if (fresh === 0 || n <= KEEP_K) return;
      const o = j * KEEP_RING;
      const span = this.kring[o + (n - 1) % KEEP_RING] - this.kring[o + (n - 1 - KEEP_K) % KEEP_RING];
      if (!(span > 0)) return;
      const err = Math.log2(KEEP_K / span);                                  // octaves: measured against intended (with the correction)
      // Small pulls go back onto the note. A source still off with the correction at its limit has jumped
      // (tube feedback) or been captured by another source (coupling): it stays where it is, moved onto the
      // nearest semitone, instead of winding up against it. When the pull goes away it returns to the note.
      const e12 = 12 * err, nat = 12 * (err - this.corr[j]);
      if (Math.abs(this.corr[j]) >= KEEP_MAX - 1e-6) { if (Math.abs(e12 - 12 * this.aim[j]) > 0.5) this.aim[j] = Math.round(e12) / 12; }
      else if (this.aim[j] !== 0 && Math.abs(nat) < 0.5) this.aim[j] = 0;
      this.corr[j] = clamp(this.corr[j] - Math.min(1, KEEP_G * fresh) * (err - this.aim[j]), -KEEP_MAX, KEEP_MAX);
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
      return Math.log2(440) + (note - 69 + e.p[PINDEX.transpose] + e.p[PINDEX.detune] / 100) / 12;
    }
    // side −1: both sides follow the note; 0 or 1: that side only (Duo, Independent)
    setTarget(note, glide, side) {
      const t = this.pitchTarget(note);
      const g = this.e.p[PINDEX.glide];
      const sides = side === 0 || side === 1 ? [side] : [0, 1];
      for (const s of sides) {
        if (glide && g > 0.0015) {
          const steps = Math.max(1, Math.round(g * this.e.sr / BLOCK));
          this.glideStep[s] = (t - this.logF[s]) / steps; this.glideLeft[s] = steps;
        } else { this.logF[s] = t; this.glideLeft[s] = 0; }
      }
      if (!(side === 1)) this.note = note;
    }
    trigger(vel) {
      this.vel = 0.2 + 0.8 * clamp(vel / 127, 0, 1);
      if (this.stage === 0) {
        // from rest: the labia start at their midpoint with a small push; the pattern starts a syllable
        this.env = 0; this.fresh = true;
        for (let j = 0; j < 3; j++) { this.x[j] = 0; this.y[j] = 0.01; this.gs[j] = 0; this.noise[j] = 0; this.prevN[j] = 0; }
        this.x[2] = 0.1; this.y[2] = 0;
        this.gp = 0; this.pPhase = 0; this.wobPh = 0;
        this.tube.fill(0); this.tw = 0; this.tlp = 0; this.Tsm = 0; this.ic1 = 0; this.ic2 = 0;
        this.resetKeeper();
        this.newSyllable(true);
      }
      this.stage = 1; this.held = true; this.age = ++this.e.ageCounter;
    }
    release() { if (this.stage !== 0) { this.stage = 4; this.held = false; } }

    // syllable rate now: free or synced to tempo
    baseRate() {
      const e = this.e, P = e.p;
      // a bigger bird sings slower unless Tempo lock holds the timing
      let r = P[PINDEX.sylrate] * Math.pow(2, e.sizeOct * (1 - P[PINDEX.tempolock]));
      if (P[PINDEX.sync] >= 0.5) {
        const bps = e.tempo / 60;
        let best = SYL_DIVS[0] * bps, bd = Infinity;
        for (const d of SYL_DIVS) { const q = d * bps, dd = Math.abs(Math.log(q / r)); if (dd < bd) { bd = dd; best = q; } }
        r = best;
      }
      return r;
    }
    newSyllable(first) {
      const e = this.e, P = e.p, jit = P[PINDEX.jitter], lock = P[PINDEX.lock] >= 0.5;
      const base = this.baseRate();
      // Sync keeps syllables on the beat grid (no timing jitter); Lock keeps them on the note (no pitch jitter)
      this.sylRate = jit > 0 && P[PINDEX.sync] < 0.5 ? base * clamp(1 + jit * 0.25 * this.gauss(), 0.5, 1.5) : base;
      this.sylPitch = jit > 0 && !lock ? jit * (0.5 / 12) * this.gauss() : 0;
      if (!first) this.sylSide = 1 - this.sylSide; else this.sylSide = 0;
      // trill limit: shrink the sweep until the syllable's bandwidth is under Podos's line
      let sw = P[PINDEX.sweep];
      const trill = P[PINDEX.trill], shape = Math.round(P[PINDEX.shape]);
      if (trill > 0 && sw !== 0 && shape !== 0) {
        const f = Math.pow(2, this.logF[0] + e.sizeOct), [lo, hi] = SHAPE_RANGE[shape];
        const bwMax = podosBandwidth(this.sylRate) / trill;
        const bw = (s) => f * (Math.pow(2, Math.max(s * lo, s * hi)) - Math.pow(2, Math.min(s * lo, s * hi)));
        if (bw(sw) > bwMax) {
          let a = 0, b = Math.abs(sw);
          for (let i = 0; i < 30; i++) { const m = 0.5 * (a + b); if (bw(Math.sign(sw) * m) > bwMax) b = m; else a = m; }
          sw = Math.sign(sw) * a;
          if (lock) sw = Math.sign(sw) * Math.floor(a * 12 + 1e-9) / 12;      // locked: whole semitones, still under the limit
        }
      }
      if (lock) sw = Math.round(sw * 12) / 12;                               // starts on the note, ends on a semitone
      this.sylSweep = sw;
      this.sylCount++;
      if (e.onsets) e.onsets.push(e.osTime);
    }
    // contour offset (octaves) at the current pattern phase
    contour() {
      const P = this.e.p;
      if (P[PINDEX.pattern] < 0.5) return 0;
      const duty = P[PINDEX.duty];
      const u = Math.min(1, this.pPhase / duty);
      return this.sylPitch + this.sylSweep * shapeAt(Math.round(P[PINDEX.shape]), u);
    }

    stepEnv(nOS) {
      const e = this.e, P = e.p, srOS = e.srOS;
      const attStep = 1 / Math.max(1, P[PINDEX.attack] * srOS);
      const dCoef = Math.exp(-4 / Math.max(1, P[PINDEX.decay] * srOS));
      const rCoef = Math.exp(-4 / Math.max(1, P[PINDEX.release] * srOS));
      const sus = P[PINDEX.sustain];
      let env = this.env;
      for (let i = 0; i < nOS; i++) {
        if (this.stage === 1) { env += attStep; if (env >= 1) { env = 1; this.stage = 2; } }
        else if (this.stage === 2) { env = sus + (env - sus) * dCoef; if (Math.abs(env - sus) < 1e-5) { env = sus; this.stage = 3; } }
        else if (this.stage === 3) env = sus;
        else if (this.stage === 4) env *= rCoef;
      }
      this.env = env;
      if (this.stage === 4 && env < 1e-4) { this.stage = 0; this.env = 0; return false; }
      return true;
    }

    // per-source block setup for a labial source; returns false if the source is silent
    setupLabial(j, logHz, regBase, E, gamma, out) {
      const e = this.e, P = e.p;
      const hz = Math.pow(2, logHz);
      const lz = logHz - e.sizeOct;                                          // Size moves the Link band with the bird
      const rNote = clamp((Math.log2(LINK_HI) - lz) / (Math.log2(LINK_HI) - Math.log2(LINK_LO)), 0, 1);
      let reg = clamp(regBase + P[PINDEX.link] * (rNote - regBase), 0, 1);
      reg += P[PINDEX.chaos] * Math.max(0, CHAOS_REG - reg);                 // Chaos wants a rich source, after Link
      const dPath = D_HOPF * Math.pow(D_SNILC / D_HOPF, reg);
      let d = clamp(dPath * Math.pow(2, PRESS_OCT * (P[PINDEX.pressure] - 0.7)) * (0.3 + 0.7 * E), D_MIN, D_MAX);
      d = driveForContent(reg, d, Math.max(1.02, CONTENT_HZ / hz));
      const b = BETA_LO + (BETA_HI - BETA_LO) * reg;
      const q = lookup(reg, d, this.q);
      out.hz = hz; out.reg = reg; out.d = d; out.b = b; out.a = alphaOn(b) - d;
      out.slope = (alphaOn(b + 1e-4) - alphaOn(b - 1e-4)) / 2e-4;
      out.gamma = hz / q.f; out.mean = q.mean; out.rms = q.rms; out.sci = q.sci;
      out.gain = LEVEL / Math.pow(q.rms, NORM_POW);
      return out;
    }

    render(nOS, out) {
      const e = this.e, P = e.p, srOS = e.srOS;
      for (let s = 0; s < 2; s++) if (this.glideLeft[s] > 0) { this.logF[s] += this.glideStep[s]; this.glideLeft[s]--; }
      if (!this.stepEnv(nOS)) return;
      const E = this.env;
      const topo = Math.round(P[PINDEX.topology]);
      const mode = topo === 0 ? Math.round(P[PINDEX.playmode]) : 1;
      const patOn = P[PINDEX.pattern] >= 0.5;

      // pattern pre-pass: syllable phase and gate for every 4x sample of the block
      const duty = P[PINDEX.duty], pg = this.patGate;
      let started = false;
      if (patOn) {
        for (let i = 0; i < nOS; i++) {
          this.pPhase += this.sylRate / srOS;
          if (this.pPhase >= 1) { this.pPhase -= Math.floor(this.pPhase); e.osTime = e.osTimeBase + i; this.newSyllable(false); started = true; }
          pg[i] = this.pPhase < duty ? 1 : 0;
        }
      } else pg.fill(1, 0, nOS);
      const contour1 = this.contour();
      // a syllable that starts inside this block starts at its own first pitch (every shape starts at 0),
      // not ramped from the last syllable's end; the gate is closed until then
      this.contour0 = contour1;
      const rate = patOn ? this.sylRate : 0;
      const mb = P[PINDEX.minibreath] * clamp((30 - rate) / 5, 0, 1);

      // side pitches (log2 Hz) at block end
      const lock = P[PINDEX.lock] >= 0.5, stepped = lock && P[PINDEX.glidestyle] >= 0.5;
      // Lock: Breath bend is a scoop in the attack only; Stepped runs every sweep and glide in semitones
      const bend = lock && this.stage !== 1 ? 0 : P[PINDEX.breathbend] * (E - 1);
      const cont = stepped ? Math.round(contour1 * 12) / 12 : contour1;
      const common = e.bendOct + bend + cont + e.sizeOct;
      const ref = LOG2_440 + P[PINDEX.detune] / 1200;
      const base0 = stepped ? ref + Math.round((this.logF[0] - ref) * 12) / 12 : this.logF[0];
      const base1 = stepped ? ref + Math.round((this.logF[1] - ref) * 12) / 12 : this.logF[1];
      let lL = base0 + common;
      let lR;
      if (topo === 1) {                                                       // Single: the two folds, detuned around the note
        const as = Math.max(P[PINDEX.asym], P[PINDEX.chaos]), half = 0.5 * as * as * SINGLE_CENTS / 1200;   // squared: small values stay in tune; Chaos detunes too
        lR = lL + half; lL -= half;
      }
      else if (mode === 1) lR = lL + (lock ? Math.round(P[PINDEX.interval]) : P[PINDEX.interval]) / 12;   // Interval
      else if (mode >= 2) lR = base1 + common;                                // Duo, Independent
      else lR = lL;                                                           // Handoff
      // side targets
      const w = this.w;
      if (topo === 2) { w[0] = 1; w[1] = 0; w[2] = P[PINDEX.memlevel] > 0 ? 1 : 0; }
      else if (topo === 1) { w[0] = 1; w[1] = 1; w[2] = 0; }
      else {
        w[2] = 0;
        if (mode === 0) {
          const sides = patOn ? Math.round(P[PINDEX.sides]) : 0;
          if (sides === 1) { w[0] = 1; w[1] = 0; }
          else if (sides === 2) { w[0] = 0; w[1] = 1; }
          else if (sides === 3) { w[0] = this.sylSide === 0 ? 1 : 0; w[1] = 1 - w[0]; }
          else {
            const f = Math.pow(2, lL - e.sizeOct), sp = P[PINDEX.split], ov = P[PINDEX.overlap];   // Size moves Split with the bird
            const lo = Math.max(50, sp - ov / 2), hi = sp + ov / 2;
            const t = hi > lo ? clamp((f - lo) / (hi - lo), 0, 1) : (f >= sp ? 1 : 0);
            w[1] = t * t * (3 - 2 * t); w[0] = 1 - w[1];
          }
          // Chaos opens the silent side too, a non-harmonic interval away (harsh calls are bilateral); locked: 3 semitones
          const ch = P[PINDEX.chaos], cst = (lock ? Math.round(CHAOS_ST) : CHAOS_ST) / 12;
          if (ch > 0) {
            if (w[0] >= w[1]) { w[1] = Math.max(w[1], ch); lR = lL + cst; }
            else { w[0] = Math.max(w[0], ch); lL = lR - cst; }
          }
        } else if (mode === 1) { w[0] = 1; w[1] = 1; }
        else { w[0] = this.sideHeld[0] ? 1 : 0; w[1] = this.sideHeld[1] ? 1 : 0; }
      }
      // balance and asymmetry on levels
      const bal = P[PINDEX.balance], asym = topo === 0 ? P[PINDEX.asym] : 0;
      const lvl0 = 1 - Math.max(0, bal), lvl1 = (1 + Math.min(0, bal)) * (1 - 0.3 * asym);

      // block setup per source
      const wobRate = P[PINDEX.wobblerate], wob = wobRate > 0 ? P[PINDEX.wobble] : 0, wfm = P[PINDEX.wobblefm];
      const fmMax = Math.pow(2, wob * wfm * WOBBLE_CENTS / 1200);
      const regBase = P[PINDEX.regime];
      const S = e.scratch;
      let sub = 1, any = false;
      for (let j = 0; j < 2; j++) {
        const live = w[j] > 0 || this.gs[j] > 1e-4;
        this.on[j] = live ? 1 : 0;
        if (!live) continue;
        any = true;
        const regJ = j === 1 && topo === 0 ? clamp(regBase + 0.25 * asym, 0, 1) : regBase;
        const o = this.setupLabial(j, j === 0 ? lL : lR, regJ, E, 0, S[j]);
        if (lock) o.gamma *= Math.pow(2, this.corr[topo === 1 ? 0 : j]);     // the pitch keeper (Single: one for both folds)
        o.gain *= j === 0 ? lvl0 : lvl1;
        if (topo === 1) o.gain *= 0.6;                                        // two folds sum
        sub = Math.max(sub, Math.ceil(o.gamma * fmMax / (srOS * H_MAX)));
      }
      // membrane
      const mu = P[PINDEX.memlevel];
      this.on[2] = topo === 2 && (mu > 0 || this.gs[2] > 1e-4) ? 1 : 0;
      if (this.on[2]) {
        const o = S[2];
        o.hz = Math.pow(2, lL + P[PINDEX.membrane] / 12);
        o.gamma = o.hz / vdpFreq(Math.max(0.02, mu));
        o.gain = LEVEL * MEM_LEVEL; o.mean = 0; o.rms = 1; o.a = Math.max(0.02, mu); o.b = 0; o.d = 0; o.slope = 0;
        sub = Math.max(sub, Math.ceil(o.gamma * fmMax / (srOS * H_MAX)));
        any = true;
      }
      if (!any) return;
      sub = Math.min(MAX_SUB, sub);
      if (this.fresh) {
        for (let j = 0; j < 3; j++) { const o = S[j]; this.a0[j] = o.a; this.b0[j] = o.b; this.g0[j] = o.gamma; this.gain0[j] = 0; this.mean0[j] = o.mean; this.rms0[j] = o.rms; this.d0[j] = o.d; }
        this.fresh = false;
      }

      // ramps across the block
      const inv = 1 / nOS;
      const ca = e.ca, cb = e.cb, cg = e.cg, cgain = e.cgain, cmean = e.cmean, crms = e.crms, cd = e.cd;
      const da = e.da, db = e.db, dg = e.dg, dgain = e.dgain, dmean = e.dmean, drms = e.drms, dd = e.dd;
      const vel = this.vel;
      for (let j = 0; j < 3; j++) {
        const o = S[j];
        if (!this.on[j]) { this.gain0[j] = 0; continue; }
        const gainT = o.gain * vel * E;
        if (started) { this.a0[j] = o.a; this.b0[j] = o.b; this.g0[j] = o.gamma; this.mean0[j] = o.mean; this.rms0[j] = o.rms; this.d0[j] = o.d; }
        ca[j] = this.a0[j]; cb[j] = this.b0[j]; cg[j] = this.g0[j]; cgain[j] = this.gain0[j]; cmean[j] = this.mean0[j]; crms[j] = this.rms0[j]; cd[j] = this.d0[j];
        da[j] = (o.a - ca[j]) * inv; db[j] = (o.b - cb[j]) * inv; dg[j] = (o.gamma - cg[j]) * inv;
        dgain[j] = (gainT - cgain[j]) * inv; dmean[j] = (o.mean - cmean[j]) * inv; drms[j] = (o.rms - crms[j]) * inv; dd[j] = (o.d - cd[j]) * inv;
        this.a0[j] = o.a; this.b0[j] = o.b; this.g0[j] = o.gamma; this.gain0[j] = gainT; this.mean0[j] = o.mean; this.rms0[j] = o.rms; this.d0[j] = o.d;
        this.slope[j] = o.slope;
        this.fNow[j] = o.hz;
      }

      // gates: side gates follow w, the pattern gate follows the syllables; times scale with syllables
      const gateS = Math.min(GATE_MS / 1000, patOn ? 0.25 * duty / this.sylRate : 1);
      const gc = 1 - Math.exp(-1 / (gateS * srOS));
      const grain = P[PINDEX.grain] * GRAIN_SD;
      const nc = 1 - Math.exp(-TWO_PI * GRAIN_HZ / srOS), nNorm = Math.sqrt((2 - nc) / nc);
      const C = topo === 1 ? 0 : Math.min(1, P[PINDEX.coupling] * (lock ? LOCK_COUPLING : 1) + CHAOS_C * P[PINDEX.chaos]);
      // Single: the two folds of one source are tied through their velocities (dissipative coupling), so they
      // move together until Asymmetry detunes them too far; in step, the pull vanishes
      const K = topo === 1 ? SINGLE_PULL * (0.3 + P[PINDEX.coupling]) : 0;
      const wobInc = wobRate / srOS;
      // internal trachea and Filter
      const jumps = P[PINDEX.jumps] * (lock ? LOCK_JUMPS : 1), chaos = P[PINDEX.chaos], filterOn = P[PINDEX.filter] >= 0.5;
      const rBase = TUBE_R0 + JUMP_R * jumps, rT = rBase + chaos * (0.95 - rBase);
      const kfb = JUMP_K * jumps * jumps + CHAOS_K * chaos;
      const tubeOn = filterOn || kfb > 0;
      const Tnew = Math.max(2, 2 * P[PINDEX.trachea] * Math.pow(2, -e.sizeOct) / 100 / SOUND * srOS);   // Size scales the tube
      if (this.Tsm === 0) this.Tsm = Tnew;
      let cT = this.Tsm;
      const dT = (Tnew - cT) * inv;
      this.Tsm = Tnew;
      const aLoss = 1 - Math.exp(-TWO_PI * TUBE_LOSS_HZ / srOS);
      const fTrack = Math.min(0.45 * e.sr, on0Hz(this, S));
      const fg = Math.tan(Math.PI * fTrack / srOS), fk = 1 / FILTER_Q;
      const fa1 = 1 / (1 + fg * (fg + fk)), fa2 = fg * fa1, fa3 = fg * fa2;
      const tube = this.tube;
      let tw = this.tw, tlp = this.tlp, ic1 = this.ic1, ic2 = this.ic2;
      const amDepth = wob * (1 - wfm), fmDepth = wob * wfm * WOBBLE_CENTS / 1200 * Math.LN2;
      const invSub = 1 / sub, invSr = 1 / srOS;
      const on0 = this.on[0], on1 = this.on[1], on2 = this.on[2];
      let x0 = this.x[0], y0 = this.y[0], x1 = this.x[1], y1 = this.y[1], z = this.x[2], zv = this.y[2];
      let gs0 = this.gs[0], gs1 = this.gs[1], gs2 = this.gs[2], gp = this.gp;
      let n0 = this.noise[0], n1 = this.noise[1];
      let pn0 = this.prevN[0], pn1 = this.prevN[1], pn2 = this.prevN[2];
      const w0 = w[0], w1 = w[1], w2 = w[2];
      let wph = this.wobPh;
      const tap = e.tap;                    // tests only: per-source normalized output at 4x
      // pitch keeper: expected cycles of each source's commanded pitch (without the correction), and its crossings.
      // Single measures the two folds together (they move as one source) against the centre pitch.
      const single = topo === 1;
      const k0 = lock && on0, k1 = lock && on1 && !single;
      let kp0 = this.kph[0], kp1 = this.kph[1], kprev0 = this.kprev[0], kprev1 = this.kprev[1];
      let karm0 = this.karm[0], karm1 = this.karm[1];
      const hzT0 = single ? Math.pow(2, 0.5 * (lL + lR)) : S[0].hz, hzT1 = S[1].hz;
      let kh0 = this.khz[0] || hzT0, kh1 = this.khz[1] || hzT1;
      if (lock) {
        if (Math.abs(Math.log2(hzT0 / kh0)) > KEEP_STEP) { this.kcount[0] = 0; this.khold[0] = KEEP_HOLD; }
        if (Math.abs(Math.log2(hzT1 / kh1)) > KEEP_STEP) { this.kcount[1] = 0; this.khold[1] = KEEP_HOLD; }
      }
      const dkh0 = (hzT0 - kh0) * inv, dkh1 = (hzT1 - kh1) * inv;
      const kg0 = Math.tan(Math.PI * Math.min(0.45 * srOS / OS, hzT0 * Math.pow(2, this.corr[0])) / srOS), kk = 1 / KEEP_Q;
      const kg1 = Math.tan(Math.PI * Math.min(0.45 * srOS / OS, hzT1 * Math.pow(2, this.corr[1])) / srOS);
      const ka10 = 1 / (1 + kg0 * (kg0 + kk)), ka20 = kg0 * ka10, ka30 = kg0 * ka20;
      const ka11 = 1 / (1 + kg1 * (kg1 + kk)), ka21 = kg1 * ka11, ka31 = kg1 * ka21;
      let kb0 = this.kb[0], kb1 = this.kb[1], kb2 = this.kb[2], kb3 = this.kb[3];
      let ke0 = this.kenv[0], ke1 = this.kenv[1];
      const kdec0 = 1 - 2 * hzT0 / srOS, kdec1 = 1 - 2 * hzT1 / srOS;     // the peak hold falls to 1/e in about half a period
      if (!lock && (this.corr[0] !== 0 || this.corr[1] !== 0)) this.resetKeeper();
      for (let i = 0; i < nOS; i++) {
        gs0 += (w0 - gs0) * gc; gs1 += (w1 - gs1) * gc; gs2 += (w2 - gs2) * gc;
        gp += (pg[i] - gp) * gc;
        // superfast muscles
        let am = 1, fm = 1;
        if (wob > 0) {
          wph += wobInc; if (wph >= 1) wph -= 1;
          const sn = Math.sin(TWO_PI * wph);
          am = 1 - amDepth * (0.5 - 0.5 * sn);
          fm = Math.exp(fmDepth * sn);
        }
        // drive factor: a closed side stops; between slow syllables the drive dips (minibreath).
        // Every coupling term uses the previous sample's values, so no source sees another's new state.
        const breathOff = mb * (1 - gp);
        // the wave returning from the far end of the tube, delayed by the round trip
        let refl = 0;
        if (tubeOn) {
          cT += dT;
          const rp = tw - cT, i0 = Math.floor(rp), fr = rp - i0;
          const pd = tube[i0 & TUBE_MASK] * (1 - fr) + tube[(i0 + 1) & TUBE_MASK] * fr;
          tlp += aLoss * (pd - tlp);
          refl = -rT * tlp;
        }
        const fb = kfb * refl;
        let a0 = 0, b0 = 0, a1 = 0, b1 = 0, muE = 0, h0 = 0, h1 = 0, h2 = 0;
        if (on0) {
          ca[0] += da[0]; cb[0] += db[0]; cg[0] += dg[0]; cgain[0] += dgain[0]; cmean[0] += dmean[0]; crms[0] += drms[0]; cd[0] += dd[0];
          const ge = Math.max(-0.5, 1 - 1.5 * ((1 - gs0) + breathOff * gs0));
          a0 = ca[0] + cd[0] * (1 - ge); b0 = cb[0];
          if (grain > 0) { n0 += nc * (this.gauss() - n0); const n = grain * nNorm * n0; b0 += n; a0 += this.slope[0] * n; }
          // coupling: the other sources' positions nudge this drive (shared pressure)
          if (C > 0) { const u = C * (gs1 * pn1 + (on2 ? gs2 * pn2 : 0)); a0 += (cd[0] + COUPLE_DC) * (u > COUPLE_MAX ? COUPLE_MAX : u < -COUPLE_MAX ? -COUPLE_MAX : u); }
          if (K > 0) a0 += K * (y1 - y0);
          if (fb !== 0) a0 += fb * (cd[0] + COUPLE_DC) * gs0;
          h0 = cg[0] * fm * invSr * invSub;
        }
        if (on1) {
          ca[1] += da[1]; cb[1] += db[1]; cg[1] += dg[1]; cgain[1] += dgain[1]; cmean[1] += dmean[1]; crms[1] += drms[1]; cd[1] += dd[1];
          const ge = Math.max(-0.5, 1 - 1.5 * ((1 - gs1) + breathOff * gs1));
          a1 = ca[1] + cd[1] * (1 - ge); b1 = cb[1];
          if (grain > 0) { n1 += nc * (this.gauss() - n1); const n = grain * nNorm * n1; b1 += n; a1 += this.slope[1] * n; }
          if (C > 0) { const u = C * gs0 * pn0; a1 += (cd[1] + COUPLE_DC) * (u > COUPLE_MAX ? COUPLE_MAX : u < -COUPLE_MAX ? -COUPLE_MAX : u); }
          if (K > 0) a1 += K * (y0 - y1);
          if (fb !== 0) a1 += fb * (cd[1] + COUPLE_DC) * gs1;
          h1 = cg[1] * fm * invSr * invSub;
        }
        if (on2) {
          cg[2] += dg[2]; cgain[2] += dgain[2];
          // membrane: its pressure is nudged by the labia (Garcia et al.: μ2 + 0.1·x1)
          muE = Math.max(0, ca[2] * (1 + C * 0.5 * gs0 * pn0));
          h2 = cg[2] * fm * invSr * invSub;
        }
        // all active sources advance together, one RK4 step each per sub-step (independent chains
        // in one loop run almost as fast as one: batch 03)
        const hh0 = 0.5 * h0, h60 = h0 / 6, hh1 = 0.5 * h1, h61 = h1 / 6, hh2 = 0.5 * h2, h62 = h2 / 6;
        for (let k = 0; k < sub; k++) {
          if (on0) {
            const x = x0, y = y0;
            const k1y = a0 + b0 * x + x * x - x * y - x * x * x - x * x * y;
            const x2 = x + hh0 * y, y2 = y + hh0 * k1y;
            const k2y = a0 + b0 * x2 + x2 * x2 - x2 * y2 - x2 * x2 * x2 - x2 * x2 * y2;
            const x3 = x + hh0 * y2, y3 = y + hh0 * k2y;
            const k3y = a0 + b0 * x3 + x3 * x3 - x3 * y3 - x3 * x3 * x3 - x3 * x3 * y3;
            const x4 = x + h0 * y3, y4 = y + h0 * k3y;
            const k4y = a0 + b0 * x4 + x4 * x4 - x4 * y4 - x4 * x4 * x4 - x4 * x4 * y4;
            x0 = x + h60 * (y + 2 * y2 + 2 * y3 + y4);
            y0 = y + h60 * (k1y + 2 * k2y + 2 * k3y + k4y);
          }
          if (on1) {
            const x = x1, y = y1;
            const k1y = a1 + b1 * x + x * x - x * y - x * x * x - x * x * y;
            const x2 = x + hh1 * y, y2 = y + hh1 * k1y;
            const k2y = a1 + b1 * x2 + x2 * x2 - x2 * y2 - x2 * x2 * x2 - x2 * x2 * y2;
            const x3 = x + hh1 * y2, y3 = y + hh1 * k2y;
            const k3y = a1 + b1 * x3 + x3 * x3 - x3 * y3 - x3 * x3 * x3 - x3 * x3 * y3;
            const x4 = x + h1 * y3, y4 = y + h1 * k3y;
            const k4y = a1 + b1 * x4 + x4 * x4 - x4 * y4 - x4 * x4 * x4 - x4 * x4 * y4;
            x1 = x + h61 * (y + 2 * y2 + 2 * y3 + y4);
            y1 = y + h61 * (k1y + 2 * k2y + 2 * k3y + k4y);
          }
          if (on2) {
            const q = z, v = zv;
            const k1v = VDP_EPS * (muE - q * q) * v - q;
            const q2 = q + hh2 * v, v2 = v + hh2 * k1v;
            const k2v = VDP_EPS * (muE - q2 * q2) * v2 - q2;
            const q3 = q + hh2 * v2, v3 = v + hh2 * k2v;
            const k3v = VDP_EPS * (muE - q3 * q3) * v3 - q3;
            const q4 = q + h2 * v3, v4 = v + h2 * k3v;
            const k4v = VDP_EPS * (muE - q4 * q4) * v4 - q4;
            z = q + h62 * (v + 2 * v2 + 2 * v3 + v4);
            zv = v + h62 * (k1v + 2 * k2v + 2 * k3v + k4v);
          }
        }
        let sum = 0;
        if (on0) { pn0 = (x0 - cmean[0]) / crms[0]; sum += pn0 * crms[0] * cgain[0] * gs0; }
        if (on1) { pn1 = (x1 - cmean[1]) / crms[1]; sum += pn1 * crms[1] * cgain[1] * gs1; }
        if (k0) {
          kh0 += dkh0; const inc = kh0 * fm * invSr; kp0 += inc;
          const xin = single ? 0.5 * (pn0 + pn1) : pn0;
          const v3 = xin - kb1, v1 = ka10 * kb0 + ka20 * v3, v2 = kb1 + ka20 * kb0 + ka30 * v3;
          kb0 = 2 * v1 - kb0; kb1 = 2 * v2 - kb1;
          const sg = kk * v1;
          ke0 = Math.max(sg < 0 ? -sg : sg, ke0 * kdec0);
          if (gs0 < 0.5) { karm0 = 0; this.kcount[0] = 0; }
          else if (karm0) { if (sg >= 0) { this.keepCross(0, kp0 - inc * sg / (sg - kprev0)); karm0 = 0; } }
          else if (sg < -KEEP_ARM * ke0) karm0 = 1;
          kprev0 = sg;
        }
        if (k1) {
          kh1 += dkh1; const inc = kh1 * fm * invSr; kp1 += inc;
          const v3 = pn1 - kb3, v1 = ka11 * kb2 + ka21 * v3, v2 = kb3 + ka21 * kb2 + ka31 * v3;
          kb2 = 2 * v1 - kb2; kb3 = 2 * v2 - kb3;
          const sg = kk * v1;
          ke1 = Math.max(sg < 0 ? -sg : sg, ke1 * kdec1);
          if (gs1 < 0.5) { karm1 = 0; this.kcount[1] = 0; }
          else if (karm1) { if (sg >= 0) { this.keepCross(1, kp1 - inc * sg / (sg - kprev1)); karm1 = 0; } }
          else if (sg < -KEEP_ARM * ke1) karm1 = 1;
          kprev1 = sg;
        }
        if (on2) { pn2 = z / (2 * Math.sqrt(ca[2])); sum += pn2 * cgain[2] * gs2; }
        if (tubeOn) {
          // into the tube: the sources' normalized flow, plus the reflected wave
          const w0n = on0 ? gs0 : 0, w1n = on1 ? gs1 : 0, w2n = on2 ? MEM_LEVEL * gs2 : 0;
          const sn = w0n * pn0 + w1n * pn1 + w2n * pn2;
          tube[tw & TUBE_MASK] = sn + refl;
          if (filterOn) {
            // out of the far end (transmitted, half a round trip later), at the sources' level
            const rp = tw - 0.5 * cT, j0 = Math.floor(rp), fr = rp - j0;
            const tr = (1 - rT) * (tube[j0 & TUBE_MASK] * (1 - fr) + tube[(j0 + 1) & TUBE_MASK] * fr);
            const wsum = w0n + w1n + w2n;
            const scale = wsum > 1e-9 ? ((on0 ? crms[0] * cgain[0] * w0n : 0) + (on1 ? crms[1] * cgain[1] * w1n : 0) + (on2 ? cgain[2] * w2n / MEM_LEVEL * MEM_LEVEL : 0)) / wsum : 0;
            const v = tr * scale * FILTER_GAIN;
            // tracking resonance (state-variable band-pass, unity peak) mixed with the tube
            const v3 = v - ic2, v1 = fa1 * ic1 + fa2 * v3, v2 = ic2 + fa2 * ic1 + fa3 * v3;
            ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
            sum = (1 - FILTER_MIX) * v + FILTER_MIX * fk * v1;
          }
          tw++;
        }
        out[i] += sum * gp * am;
        if (tap !== null && tap.n < tap.len) { tap.s0[tap.n] = on0 ? pn0 * gs0 : 0; tap.s1[tap.n] = on1 ? pn1 * gs1 : 0; tap.s2[tap.n] = on2 ? pn2 * gs2 : 0; tap.n++; }
      }
      // a runaway state (should never happen) is reset rather than allowed to blow up
      if (!(Math.abs(x0) < 50 && Math.abs(y0) < 50)) { x0 = 0; y0 = 0.01; }
      if (!(Math.abs(x1) < 50 && Math.abs(y1) < 50)) { x1 = 0; y1 = 0.01; }
      if (!(Math.abs(z) < 50 && Math.abs(zv) < 50)) { z = 0.1; zv = 0; }
      this.x[0] = x0; this.y[0] = y0; this.x[1] = x1; this.y[1] = y1; this.x[2] = z; this.y[2] = zv;
      this.gs[0] = gs0; this.gs[1] = gs1; this.gs[2] = gs2; this.gp = gp;
      this.noise[0] = n0; this.noise[1] = n1;
      this.prevN[0] = pn0; this.prevN[1] = pn1; this.prevN[2] = pn2;
      this.wobPh = wph;
      this.tw = tw & TUBE_MASK; this.tlp = tlp; this.ic1 = ic1; this.ic2 = ic2;
      if (lock) {
        this.kph[0] = kp0; this.kph[1] = kp1; this.kprev[0] = kprev0; this.kprev[1] = kprev1;
        this.karm[0] = karm0; this.karm[1] = karm1;
        this.kb[0] = kb0; this.kb[1] = kb1; this.kb[2] = kb2; this.kb[3] = kb3; this.kenv[0] = ke0; this.kenv[1] = ke1;
        this.khz[0] = k0 ? hzT0 : 0; this.khz[1] = k1 ? hzT1 : 0;
        if (k0) this.keepUpdate(0); else this.kcount[0] = 0;
        if (k1) this.keepUpdate(1); else this.kcount[1] = 0;
        if (single) this.corr[1] = this.corr[0];
      }
      if (!(Math.abs(tlp) < 1e6 && Math.abs(ic1) < 1e6 && Math.abs(ic2) < 1e6)) { this.tube.fill(0); this.tlp = this.ic1 = this.ic2 = 0; }
      // what the bench and tests read
      const m = on0 ? S[0] : S[1];
      this.subNow = sub; this.regimeNow = m.reg; this.driveNow = m.d; this.sciNow = m.sci; this.gammaNow = m.gamma;
    }
  }

  function on0Hz(v, S) { return v.on[0] ? S[0].hz : v.on[1] ? S[1].hz : S[2].hz || 1000; }

  /* ---------- the engine ---------- */
  class SyrinxEngine {
    constructor(sampleRate, seed) {
      if (!MAP) throw new Error('Syrinx map missing: run node tools/make-maps.js');
      this.sr = sampleRate; this.srOS = sampleRate * OS;
      this.p = new Float64Array(PARAMS.length);
      PARAMS.forEach((d, i) => { this.p[i] = d.def; });
      this.fir = makeFir();
      this.hist = new Float32Array(FIR_LEN * 2); this.hw = 0;
      this.os = new Float32Array(BLOCK * OS);
      this.blkL = new Float32Array(BLOCK); this.blkR = new Float32Array(BLOCK); this.blkPos = BLOCK;
      this.ageCounter = 0; this.quietBlocks = 0;
      this.stack = [];
      this.bendNorm = 0; this.bendOct = 0; this.tempo = 120; this.sizeOct = 0;
      this.dc = { x: 0, y: 0, R: 1 - 2 * Math.PI * 10 / sampleRate };
      this.volSm = Math.pow(10, PARAMS[PINDEX.volume].def / 20);
      this.smooth = 1 - Math.exp(-BLOCK / (0.02 * sampleRate));
      this.osTimeBase = 0; this.osTime = 0; this.onsets = null;
      this.tap = null;                      // tests: { s0, s1, s2, n, len } to record each source
      // per-block scratch shared by the voices (no allocation while running)
      this.scratch = [0, 1, 2].map(() => ({ hz: 0, reg: 0, d: 0, b: 0, a: 0, slope: 0, gamma: 0, mean: 0, rms: 1, sci: 1, gain: 0 }));
      for (const k of ['ca', 'cb', 'cg', 'cgain', 'cmean', 'crms', 'cd', 'da', 'db', 'dg', 'dgain', 'dmean', 'drms', 'dd']) this[k] = new Float64Array(3);
      const base = (seed >>> 0) || 0x9e3779b9;
      this.voices = [];
      for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(this, (base + i * 0x6d2b79f5) >>> 0));
      this.info = { voices: 0, idle: true };
    }

    static get LATENCY() { return BLOCK; }
    static get PARAMS() { return PARAMS; }

    setParam(id, v) {
      const i = PINDEX[id];
      if (i === undefined || !Number.isFinite(v)) return;
      const d = PARAMS[i];
      this.p[i] = clamp(d.step ? Math.round(v / d.step) * d.step : v, d.min, d.max);
      if (id === 'mode' || id === 'playmode' || id === 'topology') this.allNotesOff();
      if (id === 'size' || id === 'lock') this.sizeOct = this.computeSizeOct();
    }
    getParam(id) { return this.p[PINDEX[id]]; }
    // octaves Size moves the bird by (0 at the songbird default); whole octaves with Lock
    computeSizeOct() {
      const o = -(this.p[PINDEX.size] - 0.25) * SIZE_OCT;
      return this.p[PINDEX.lock] >= 0.5 ? Math.round(o) : o;
    }
    setBend(norm) { this.bendNorm = clamp(norm, -1, 1); }
    setTempo(bpm) { this.tempo = clamp(bpm, 20, 400); }

    // Duo and Independent drive one voice with a note per side
    sideMode() { return Math.round(this.p[PINDEX.topology]) === 0 && Math.round(this.p[PINDEX.playmode]) >= 2; }
    updateSides(vel) {
      const v = this.voices[0], indep = Math.round(this.p[PINDEX.playmode]) === 3;
      if (!indep) {
        const held = this.stack.slice().sort((a, b) => a - b);
        for (let s = 0; s < 2; s++) {
          const n = held[s];
          if (n === undefined) { v.sideHeld[s] = 0; continue; }
          const legato = v.active() && v.sideHeld[s];
          if (v.sideNote[s] !== n) v.setTarget(n, legato, s);
          v.sideNote[s] = n; v.sideHeld[s] = 1;
        }
      }
      if (v.sideHeld[0] || v.sideHeld[1]) { if (!v.active() || !v.held) v.trigger(vel); else if (vel > 0) v.vel = 0.2 + 0.8 * clamp(vel / 127, 0, 1); }
      else v.release();
    }

    noteOn(note, vel, ch) {
      if (vel <= 0) { this.noteOff(note, ch); return; }
      if (this.sideMode()) {
        const v = this.voices[0];
        if (Math.round(this.p[PINDEX.playmode]) === 3) {
          const s = (ch | 0) & 1;
          v.setTarget(note, v.active() && v.sideHeld[s], s);
          v.sideNote[s] = note; v.sideHeld[s] = 1;
        } else {
          const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
          this.stack.push(note);
        }
        this.updateSides(vel);
        return;
      }
      if (this.p[PINDEX.mode] === 0) {
        const v = this.voices[0];
        const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
        this.stack.push(note);
        const legato = v.active() && v.held;
        v.setTarget(note, legato, -1);
        if (!legato) v.trigger(vel);
        else v.vel = 0.2 + 0.8 * clamp(vel / 127, 0, 1);
        return;
      }
      for (const v of this.voices) if (v.active() && v.note === note) { v.setTarget(note, false, -1); v.trigger(vel); return; }
      let pick = null;
      for (const v of this.voices) if (!v.active()) { pick = v; break; }
      if (!pick) { for (const v of this.voices) if (!v.held && (!pick || v.age < pick.age)) pick = v; }
      if (!pick) { for (const v of this.voices) if (!pick || v.age < pick.age) pick = v; }
      pick.setTarget(note, false, -1);
      pick.trigger(vel);
    }
    noteOff(note, ch) {
      if (this.sideMode()) {
        const v = this.voices[0];
        if (Math.round(this.p[PINDEX.playmode]) === 3) {
          const s = (ch | 0) & 1;
          if (v.sideNote[s] === note) v.sideHeld[s] = 0;
        } else {
          const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
        }
        this.updateSides(0);
        return;
      }
      if (this.p[PINDEX.mode] === 0) {
        const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
        const v = this.voices[0];
        if (!v.active() || v.note !== note) return;
        if (this.stack.length) v.setTarget(this.stack[this.stack.length - 1], true, -1);
        else v.release();
        return;
      }
      for (const v of this.voices) if (v.note === note && v.held) v.release();
    }
    allNotesOff() {
      this.stack.length = 0;
      for (const v of this.voices) { v.release(); v.sideHeld.fill(0); }
    }

    processBlock() {
      const d = this.dc;
      const busy = this.voices.some(v => v.stage !== 0);
      if (!busy && this.quietBlocks > 0 && Math.abs(d.y) < 1e-12 && Math.abs(d.x) < 1e-12) {
        // idle: nothing sounds and the filters are empty
        this.blkL.fill(0); this.blkR.fill(0); d.x = d.y = 0;
        this.info.voices = 0; this.info.idle = true;
        this.osTimeBase += BLOCK * OS;
        return;
      }
      this.bendOct = this.bendNorm * this.p[PINDEX.bendrange] / 12;
      this.sizeOct = this.computeSizeOct();
      this.volSm += (Math.pow(10, this.p[PINDEX.volume] / 20) - this.volSm) * this.smooth;
      const nOS = BLOCK * OS, o = this.os;
      o.fill(0);
      let count = 0;
      for (const v of this.voices) if (v.stage !== 0) { v.render(nOS, o); count++; }
      this.osTimeBase += nOS;
      this.quietBlocks = count === 0 ? this.quietBlocks + 1 : 0;
      this.info.voices = count; this.info.idle = false;
      // decimate (symmetric FIR), DC block, volume, clip; mono for now, same on both sides
      const L = FIR_LEN, H = FIR_LEN / 2, h = this.fir, hs = this.hist, vol = this.volSm;
      let hw = this.hw;
      for (let j = 0, k = 0; j < BLOCK; j++) {
        for (let q = 0; q < OS; q++, k++) { hs[hw] = hs[hw + L] = o[k]; hw = hw + 1 === L ? 0 : hw + 1; }
        let acc = 0;
        for (let t = 0, u = hw + L - 1; t < H; t++, u--) acc += h[t] * (hs[hw + t] + hs[u]);
        const y = acc - d.x + d.R * d.y; d.x = acc; d.y = y;
        const s = y * vol;
        this.blkL[j] = this.blkR[j] = s > 1 ? 1 : s < -1 ? -1 : s;
      }
      this.hw = hw;
      if (Math.abs(d.y) < 1e-20) d.y = 0;
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

  SyrinxEngine.BLOCK = BLOCK; SyrinxEngine.OS = OS;
  SyrinxEngine.toNorm = toNorm; SyrinxEngine.fromNorm = fromNorm;
  SyrinxEngine.lookup = (r, d) => lookup(r, d, {});
  SyrinxEngine.vdpFreq = vdpFreq; SyrinxEngine.podosBandwidth = podosBandwidth;
  if (typeof module !== 'undefined' && module.exports) module.exports = { SyrinxEngine, PARAMS, core };
  else root.SyrinxEngine = SyrinxEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
