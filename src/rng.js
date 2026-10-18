/*
 * krill · seeded random streams
 *
 * Every random choice in krill comes from an Rng. Streams are derived from a seed plus tags
 * (slot number, re-roll count, purpose), so changing one stream never shifts another.
 * Uses sfc32 seeded through splitmix32: fast, good quality, and identical in every JS engine
 * because it only uses 32-bit integer maths.
 *
 * Works in the browser (Krill.rng) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  // mix a 32-bit value (splitmix32 finaliser)
  function mix32(x) {
    x = (x + 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    return (x ^ (x >>> 15)) >>> 0;
  }

  // combine a seed and any number of integer tags into one 32-bit value; order matters
  // (hash(s, 1, 2) and hash(s, 2, 1) differ), so slot and re-roll numbers can't collide
  function hash(seed) {
    let h = mix32(seed >>> 0);
    for (let i = 1; i < arguments.length; i++) h = mix32((Math.imul(h, 0x01000193) ^ mix32(arguments[i] >>> 0)) >>> 0);
    return h;
  }

  // tag strings once, so streams can be named ('signature', 'pitch')
  function tag(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  class Rng {
    constructor(seed) {
      const s = seed >>> 0;
      this.seed = s;
      this.a = mix32(s); this.b = mix32(this.a); this.c = mix32(this.b); this.d = 1;
      for (let i = 0; i < 12; i++) this.u32();      // warm up
    }
    u32() {
      const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
      this.d = (this.d + 1) >>> 0;
      this.a = (this.b ^ (this.b >>> 9)) >>> 0;
      this.b = (this.c + (this.c << 3)) >>> 0;
      this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
      this.c = (this.c + t) >>> 0;
      return t;
    }
    next() { return this.u32() / 4294967296; }                 // [0, 1)
    range(lo, hi) { return lo + (hi - lo) * this.next(); }
    int(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); }   // inclusive
    chance(p) { return p > 0 && this.next() < p; }
    sign() { return this.next() < 0.5 ? -1 : 1; }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    gauss() {                                                   // approx N(0,1), bounded ±3.5
      return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
    }
    // index into weights (non-negative, at least one > 0); -1 if all zero
    weighted(w, n) {
      let total = 0;
      for (let i = 0; i < n; i++) total += w[i];
      if (!(total > 0)) return -1;
      let r = this.next() * total;
      for (let i = 0; i < n; i++) { r -= w[i]; if (r < 0) return i; }
      return n - 1;
    }
    // a new independent stream: this stream's seed plus tags (does not advance this stream)
    fork() {
      const args = [this.seed];
      for (let i = 0; i < arguments.length; i++) {
        const a = arguments[i];
        args.push(typeof a === 'string' ? tag(a) : a);
      }
      return new Rng(hash.apply(null, args));
    }
  }

  const api = { Rng, hash, tag, mix32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.Krill = root.Krill || {}).rng = api;
})(typeof self !== 'undefined' ? self : this);
