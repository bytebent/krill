/*
 * krill · scales
 *
 * Pitch context for a pond: In key (root + scale) or Free. Pitches are MIDI note numbers;
 * in Free mode they may be fractional (60.37 = C4 + 37 cents).
 *
 *   makePitch({ mode: 'key', root: 'D', scale: 'minor' })  or  makePitch({ mode: 'free' })
 *   pitch.notesIn(lo, hi)      scale notes in a range (In key); null in Free
 *   pitch.snap(x)              nearest scale note (In key); x itself in Free
 *   pitch.inScale(x)
 *   consonance(a, b)           how well two pitches sit together, 0–1 (for Harmonise)
 *
 * Works in the browser (Krill.scales) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const SCALES = {
    'major': [0, 2, 4, 5, 7, 9, 11],
    'minor': [0, 2, 3, 5, 7, 8, 10],
    'dorian': [0, 2, 3, 5, 7, 9, 10],
    'phrygian': [0, 1, 3, 5, 7, 8, 10],
    'lydian': [0, 2, 4, 6, 7, 9, 11],
    'mixolydian': [0, 2, 4, 5, 7, 9, 10],
    'pentatonic major': [0, 2, 4, 7, 9],
    'pentatonic minor': [0, 3, 5, 7, 10],
    'whole tone': [0, 2, 4, 6, 8, 10],
    'chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = { Db: 1, Eb: 3, Gb: 6, Ab: 8, Bb: 10 };

  function rootIndex(r) {
    if (Number.isInteger(r)) return ((r % 12) + 12) % 12;
    const s = String(r).trim();
    const k = s.charAt(0).toUpperCase() + s.slice(1);
    if (ROOTS.includes(k)) return ROOTS.indexOf(k);
    if (k in FLATS) return FLATS[k];
    throw new Error('Unknown root "' + r + '"');
  }

  // "D minor", "F# pentatonic minor", "free"
  function parse(text) {
    const t = String(text).trim().toLowerCase();
    if (t === 'free') return { mode: 'free' };
    const m = t.match(/^([a-g][#b]?)\s+(.+)$/);
    if (!m || !SCALES[m[2]]) throw new Error('Unknown key "' + text + '" (try "D minor" or "free")');
    return { mode: 'key', root: m[1].charAt(0).toUpperCase() + m[1].slice(1), scale: m[2] };
  }

  function makePitch(opts) {
    opts = opts || { mode: 'free' };
    if (opts.mode !== 'key') {
      return {
        free: true, label: 'FREE',
        notesIn() { return null; },
        snap(x) { return x; },
        inScale() { return true; },
      };
    }
    const r = rootIndex(opts.root == null ? 'C' : opts.root);
    const scaleName = SCALES[opts.scale] ? opts.scale : 'minor';
    const steps = SCALES[scaleName];
    const member = new Uint8Array(12);
    for (const s of steps) member[(s + r) % 12] = 1;
    // nearest member for each pitch class, ties going down (keeps snapping stable)
    const nearest = new Int8Array(12);
    for (let pc = 0; pc < 12; pc++) {
      let best = 0;
      for (let d = 0; d <= 6; d++) {
        if (member[(pc - d + 12) % 12]) { best = -d; break; }
        if (member[(pc + d) % 12]) { best = d; break; }
      }
      nearest[pc] = best;
    }
    return {
      free: false, root: ROOTS[r], scale: scaleName,
      label: ROOTS[r] + ' ' + scaleName.toUpperCase(),
      notesIn(lo, hi) {
        const out = [];
        for (let n = Math.ceil(lo); n <= Math.floor(hi); n++) if (member[((n % 12) + 12) % 12]) out.push(n);
        return out;
      },
      snap(x) {
        const n = Math.round(x);
        return n + nearest[((n % 12) + 12) % 12];
      },
      inScale(x) { return x === Math.round(x) && member[((x % 12) + 12) % 12] === 1; },
    };
  }

  // consonance by interval class (semitones mod 12), 0–1. Unison and octave count, but less than
  // 3rds, 5ths and 6ths, so Harmonise makes chords rather than doublings.
  const CONS = [0.55, 0.05, 0.15, 1, 1, 0.5, 0.05, 1, 0.8, 0.9, 0.15, 0.05];
  function consonance(a, b) {
    const d = Math.round(Math.abs(a - b)) % 12;
    return CONS[d];
  }

  function noteName(x, cents) {
    const n = Math.round(x);
    const name = ROOTS[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
    if (!cents) return name;
    const c = Math.round((x - n) * 100);
    return c === 0 ? name : name + (c > 0 ? '+' : '') + c;
  }

  const api = { SCALES, ROOTS, makePitch, parse, consonance, noteName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.Krill = root.Krill || {}).scales = api;
})(typeof self !== 'undefined' ? self : this);
