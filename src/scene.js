/*
 * krill · the visualizer's scene: where each creature is and what links them, at any time
 *
 * Everything comes from the pond and its score, so it's the same every time and needs no audio:
 *   x       the creature's pan, exactly as the voice pans it (src/pan.js), with the answer lean
 *           eased the way the voice eases it (about 0.6 s)
 *   y       has no sound behind it: a height seeded per slot that drifts slowly with the eras
 *   size    the loudness of the creature's current (or last) call, from its lane loudness range;
 *           loudness never moves a creature
 *   links   an answer draws a solid line from caller to answerer, with a ball that leaves the
 *           caller as its call ends and arrives as the answer starts; a copy draws a dotted line
 *           from the creature it copies (an answer that copies: dotted, with the ball)
 *
 * The scopes themselves (each creature's own signal, fading with its level) come from the
 * player; this file only places them.
 *
 * Works in the browser (Krill.scene) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const PAN = inNode ? require('./pan.js') : K.pan;
  const { hash, tag } = inNode ? require('./rng.js') : K.rng;

  const LEAN_TC = 0.6;          // s, the voice's lean easing (Voice.leanK)
  const HEIGHT = 0.42;          // how far the height drifts around its home
  const HOME = 0.5;             // homes spread over -HOME..HOME
  const BALL_MIN = 0.35;        // s, shortest ball flight (answers that start almost at once)
  const LINE_FADE = 1.4;        // s, an answer's line after the answer starts
  const COPY_FADE = 2.0;        // s, a copy's dotted line after the copy starts
  const REACH = 0.86;           // creatures stay inside this share of the circle's radius

  const unit = h => (h >>> 0) / 4294967296;                    // 0..1

  function makeScene(pond, score) {
    const slots = [], seed = pond.seed >>> 0, eraLen = Math.max(5, pond.talk.eraLength || 60);
    score.slots.forEach((s, i) => {
      if (!s) { slots.push(null); return; }
      const calls = [];
      score.calls.forEach((c, k) => { if (c.slot === i) calls.push(k); });
      // lean at the start of each call, chaining the voice's easing through the calls
      const leanAt = [];
      let lean = 0, from = 0, target = 0;
      for (const k of calls) {
        const c = score.calls[k];
        lean = target + (lean - target) * Math.exp(-(c.t - from) / LEAN_TC);
        leanAt.push(lean); from = c.t; target = c.lean || 0;
      }
      slots.push({
        i, info: s, calls, leanAt,
        wseed: PAN.wanderSeed(PAN.slotSeed(seed, i, pond.slots[i] && pond.slots[i].rerolls)),
        hseed: hash(seed, tag('height'), i, (pond.slots[i] && pond.slots[i].rerolls) || 0),
        home: (unit(hash(seed, tag('home'), i)) * 2 - 1) * HOME,
      });
    });
    // who a copy copies: the answered caller, or the last call of its lineage by someone else
    const copyFrom = new Map(), lastOfLineage = new Map();
    score.calls.forEach((c, k) => {
      if (c.kind === 'copy') {
        if (c.of != null) copyFrom.set(k, score.calls[c.of].slot);
        else if (c.lineage != null && lastOfLineage.has(c.lineage)) {
          const src = score.calls[lastOfLineage.get(c.lineage)];
          if (src.slot !== c.slot) copyFrom.set(k, src.slot);
        }
      }
      if (c.lineage != null) lastOfLineage.set(c.lineage, k);
    });
    // the calls whose links may show at time t, found from a start index that moves forward
    const order = score.calls.map((c, k) => k).sort((a, b) => score.calls[a].t - score.calls[b].t);

    // the last call index of a slot that started at or before t (binary search)
    function lastCall(s, t) {
      let lo = 0, hi = s.calls.length - 1, r = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (score.calls[s.calls[m]].t <= t) { r = m; lo = m + 1; } else hi = m - 1; }
      return r;
    }

    function place(s, t) {
      const j = lastCall(s, t);
      let lean = 0;
      if (j >= 0) {
        const c = score.calls[s.calls[j]], target = c.lean || 0;
        lean = target + (s.leanAt[j] - target) * Math.exp(-(t - c.t) / LEAN_TC);
      }
      let x = PAN.place(PAN.wanderAt(s.wseed, s.info.pan || 0, s.info.wander || 0, t) + lean, pond.space.width);
      let y = s.home + HEIGHT * PAN.noise(s.hseed, t, eraLen);
      const r = Math.hypot(x, y);
      if (r > 1) { x /= r; y /= r; }
      const call = j >= 0 ? score.calls[s.calls[j]] : null;
      return {
        slot: s.i, x: x * REACH, y: y * REACH, pan: PAN.place(PAN.wanderAt(s.wseed, s.info.pan || 0, s.info.wander || 0, t) + lean, pond.space.width),
        gainDb: call ? call.gainDb || 0 : 0, size: call ? Math.pow(10, (call.gainDb || 0) / 40) : 1,
        calling: !!call && t < call.end, name: s.info.name,
      };
    }

    function at(t) {
      const where = slots.map(s => s ? place(s, t) : null);
      const links = [];
      for (const k of order) {
        const c = score.calls[k];
        if (c.t - 10 > t) break;                                  // nothing this far ahead shows yet
        if (c.t + COPY_FADE < t) continue;
        const copy = c.kind === 'copy', to = c.slot;
        if (c.of != null) {
          const src = score.calls[c.of], t0 = Math.min(src.end, c.t - BALL_MIN), t1 = c.t;
          if (t < t0 || t > t1 + (copy ? COPY_FADE : LINE_FADE) || src.slot === to) continue;
          const ball = t <= t1 ? (t - t0) / (t1 - t0) : null;
          const alpha = t <= t1 ? 1 : 1 - (t - t1) / (copy ? COPY_FADE : LINE_FADE);
          links.push({ call: k, from: src.slot, to, dotted: copy, ball, alpha });
        } else if (copy && copyFrom.has(k)) {
          if (t < c.t || t > c.t + COPY_FADE) continue;
          links.push({ call: k, from: copyFrom.get(k), to, dotted: true, ball: null, alpha: 1 - (t - c.t) / COPY_FADE });
        }
      }
      return { t, where, links };
    }

    return { at, seconds: score.seconds };
  }

  const api = { makeScene, REACH };
  if (inNode) module.exports = api;
  else K.scene = api;
})(typeof self !== 'undefined' ? self : this);
