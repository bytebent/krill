/*
 * krill · where a voice sits left to right
 *
 * One place for the pan math, so the voice (what you hear) and the pond page's sketch (what you
 * see) can't drift apart. A voice's pan at time t is
 *
 *   home + wander · noise(t)  + lean  → clamped to -1..1 → times the pond's Width
 *
 * where home and wander come from the creature's manner, noise is slow value noise from the
 * slot's own stream, and lean is how far an answer moves away from its caller (the voice eases
 * into it over about half a second; the sketch uses the target).
 *
 * Works in the browser (Krill.pan) and in Node (module.exports). Needs only rng.js.
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const { hash, tag } = inNode ? require('./rng.js') : K.rng;

  // value noise in -1..1, a function of time only (no state, so chunking can't change it)
  function noise(seed, t, period) {
    const x = t / period, k = Math.floor(x), f = x - k;
    const a = hash(seed, k) / 2147483648 - 1, b = hash(seed, k + 1) / 2147483648 - 1;
    const u = 0.5 - 0.5 * Math.cos(Math.PI * f);
    return a + (b - a) * u;
  }

  // a slot's stream in a pond (the voice's seed)
  const slotSeed = (pondSeed, i, rerolls) => hash(pondSeed, tag('slot'), i, rerolls || 0);

  // the wander stream and its speed: more wander also moves faster (6–30 s per swing)
  const wanderSeed = voiceSeed => hash(voiceSeed >>> 0, tag('pan'));
  const period = wander => 6 + 24 * (1 - wander);

  // home plus wander at time t (seconds), before the lean, clamp and Width
  function wanderAt(wseed, home, wander, t) {
    return wander > 0 ? home + wander * noise(wseed, t, period(wander)) : home;
  }

  // the final pan, -width..width
  function place(p, width) { return (p > 1 ? 1 : p < -1 ? -1 : p) * width; }

  // a pond slot's pan at time t with a given lean (for the sketch)
  function slotPanAt(pond, i, slot, t, lean) {
    const ws = wanderSeed(slotSeed(pond.seed, i, pond.slots[i] && pond.slots[i].rerolls));
    return place(wanderAt(ws, slot.pan || 0, slot.wander || 0, t) + (lean || 0), pond.space.width);
  }

  const api = { noise, slotSeed, wanderSeed, period, wanderAt, place, slotPanAt };
  if (inNode) module.exports = api;
  else K.pan = api;
})(typeof self !== 'undefined' ? self : this);
