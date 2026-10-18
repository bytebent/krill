/*
 * krill · the conductor: turns a pond into a score (decisions only, no audio)
 *
 * Time moves from event to event: creatures trying to start a call, and answers falling due.
 *   floor      a call holds the floor until it ends. A creature whose rest is over starts a call
 *              when the floor is free (odds: Talkative); while it's held it interrupts only with
 *              Overlap's odds, otherwise it waits until the floor frees plus a response gap.
 *   answers    when a call ends, each other creature may answer (odds: Responsive, shrinking
 *              with every step of a chain, so conversations end). The earliest answers; others
 *              join with Overlap's odds. A lone creature answers itself. An answer copies what it
 *              heard with Mimicry's odds (roll.Caller.answer), in the copier's own voice.
 *   memory     recent motifs and their lineages. Copies strengthen a lineage, every call fades
 *              them all; a starting creature sometimes recalls a strong one. That's the dialect.
 *   harmonise  in key, a call's start weighs against the notes sounding at that moment.
 *   eras       every Era length the pond's density (rests ÷ density) and register drift a step.
 *   ignore     a lane set to ignore others is outside the conversation: it starts whenever its
 *              rest is over (odds: Talkative), never waits for the floor or answers, and its
 *              calls don't hold the floor, aren't answered and aren't remembered.
 *   chaos      (pond Talk, 0 … 1) more creatures answer each call, chains run longer, answers
 *              bunch together and over each other, more of them copy, recalls are likelier.
 *              It only changes odds and times of the draws already made, so 0 is the pond as it
 *              always was, bit for bit.
 *   loudness   each call's loudness is drawn from the lane's range [low, high] dB (both ≤ 0).
 *   streams    each slot's decisions and sounds come from its own stream (seed, slot, re-rolls),
 *              so re-rolling a slot changes that creature; the others only shift where they react.
 *
 * Works in the browser (Krill.conductor) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const R = inNode ? require('./roll.js') : K.roll;
  const S = inNode ? require('./scales.js') : K.scales;
  const PD = inNode ? require('./pond.js') : K.pond;
  const { Rng, hash, tag } = inNode ? require('./rng.js') : K.rng;

  const CHAIN = 0.7;          // each answer in a chain is this much less likely than the last
  const RECALL = 0.3;         // × Mimicry: odds a starting creature recalls a remembered motif
  const MEMORY = 12;          // motifs kept
  const FADE = 0.85;          // every call fades all remembered lineages by this
  const LEAN = 0.5;           // answers move away from their caller by this share of the distance between them
  const MAX_DEPTH = 24;

  // the pond's slow drift: knots every era, interpolated between
  function eraWalk(seed, seconds, eraLength, keyMode) {
    const rng = new Rng(hash(seed, tag('era')));
    const n = Math.ceil(seconds / eraLength) + 2, knots = [];
    let ld = 0, reg = 0;
    for (let k = 0; k < n; k++) {
      if (k > 0) {
        ld = Math.max(-0.9, Math.min(0.9, ld + rng.gauss() * 0.35));
        reg = Math.max(-3, Math.min(3, reg + (keyMode ? rng.int(-1, 1) : rng.gauss() * 1.2)));
      }
      knots.push({ t: k * eraLength, density: Math.exp(ld), register: keyMode ? reg : Math.round(reg * 10) / 10 });
    }
    const at = t => {
      const x = Math.max(0, t / eraLength), k = Math.min(n - 2, Math.floor(x)), f = Math.min(1, x - k);
      const a = knots[k], b = knots[k + 1];
      return { density: a.density + (b.density - a.density) * f, register: keyMode ? (f < 0.5 ? a.register : b.register) : a.register + (b.register - a.register) * f };
    };
    return { knots, at };
  }

  // what's sounding at time t (anchor notes of other slots' units, during their tails too)
  function soundingAt(active, t, except) {
    const out = [];
    for (const c of active) {
      if (c.slot === except || c.tail <= t || c.t > t) continue;
      let u = c.units[0];
      for (const x of c.units) if (x.t <= t) u = x;
      out.push(u.note);
    }
    return out;
  }

  function conduct(pondIn, opts) {
    opts = opts || {};
    const pond = pondIn.format ? PD.normalise(pondIn).pond : pondIn;
    const pitch = S.makePitch(pond.pitch);
    const seconds = opts.seconds > 0 ? opts.seconds : pond.output.minutes * 60;
    const seed = pond.seed >>> 0;
    const overlap = pond.talk.overlap, resp = pond.talk.response, chaos = pond.talk.chaos || 0;
    const loosen = p => p + (1 - p) * chaos;          // chaos pushes an odds towards 1
    const harmonise = !!pond.pitch.harmonise && !pitch.free;
    const era = eraWalk(seed, seconds, pond.talk.eraLength, !pitch.free);

    // the creatures
    const slots = [];
    pond.slots.forEach((s, i) => {
      if (!s) return;
      const rng = new Rng(hash(seed, tag('slot'), i, s.rerolls || 0));
      const caller = new R.Caller(s.creature, pitch, rng);
      slots.push({ i, caller, cc: caller.cc, rng, busyUntil: -1, next: Infinity, home: caller.cc.pan, ignore: !!s.ignore, low: s.loudness ? s.loudness[0] : 0, high: s.loudness ? s.loudness[1] || 0 : 0 });
    });
    const score = { format: 'krill-score', version: 1, seconds, seed, pitch: pitch.label, slots: [], calls: [], eras: era.knots.filter(k => k.t <= seconds) };
    score.slots = pond.slots.map((s, i) => s ? Object.assign(R.slotInfo(slots.find(x => x.i === i).cc), { slot: i, color: PD.COLORS[i] }) : null);
    if (!slots.length) return score;
    const solo = slots.length === 1;

    const gapRng = new Rng(hash(seed, tag('response')));
    const gap = () => resp[0] * Math.pow(resp[1] / resp[0], gapRng.next());
    const restOf = (s, t) => s.caller.rest(era.at(t).density);

    // start: the most talkative creature opens within a couple of seconds; the others are staggered
    const talkers = slots.filter(s => !s.ignore).length ? slots.filter(s => !s.ignore) : slots;
    let opener = talkers[0];
    for (const s of talkers) if (s.cc.talkative > opener.cc.talkative) opener = s;
    for (const s of slots) s.next = s === opener ? s.rng.range(0.2, 2) : s.rng.next() * restOf(s, 0);
    opener.forced = true;

    const pending = [];                   // answers due: { s, t, heard, depth, callerHome }
    const active = [];                    // calls whose tails may still sound
    const memory = [];                    // { motif, lineage, weight }
    let floorUntil = -1, lineages = 0;

    function remember(call, heardLineage) {
      for (const m of memory) m.weight *= FADE;
      const lineage = heardLineage != null ? heardLineage : lineages++;
      const m = memory.find(x => x.lineage === lineage);
      if (m) { m.weight += 1; m.motif = call.motif; }
      else memory.push({ motif: call.motif, lineage, weight: 1 });
      memory.sort((a, b) => b.weight - a.weight);
      if (memory.length > MEMORY) memory.length = MEMORY;
      return lineage;
    }

    function place(s, call, info) {
      call.slot = s.i;
      call.depth = info.depth;
      call.gainDb = s.low < s.high ? s.high + (s.low - s.high) * s.rng.next() : s.high;   // [low, 0] draws as before
      call.lineage = s.ignore ? null : remember(call, call.kind === 'copy' ? info.lineage : null);
      if (info.of != null) call.of = info.of;
      if (info.from != null) call.from = info.from;
      call.lean = info.lean || 0;
      const idx = score.calls.length;
      score.calls.push(call);
      active.push(call);
      s.busyUntil = call.end;
      s.next = call.end + restOf(s, call.end);
      if (s.ignore) return;                         // not heard: no floor, no answers
      if (call.end > floorUntil) floorUntil = call.end;
      // who answers this one?
      if (info.depth >= MAX_DEPTH) return;
      const decay = Math.pow(CHAIN, info.depth * (1 - 0.5 * chaos));
      const cand = [];
      for (const o of slots) {
        if ((o === s && !solo) || o.ignore) continue;
        const p = o.cc.responsive * decay;
        if (o.rng.chance(chaos ? Math.min(1, p * (1 + 2 * chaos)) : p)) cand.push({ o, t: call.end + gap() * (1 - 0.5 * chaos) });
      }
      if (!cand.length) return;
      cand.sort((a, b) => a.t - b.t);
      if (chaos) for (const c of cand) c.t = cand[0].t + (c.t - cand[0].t) * (1 - 0.85 * chaos);   // bunch the answers together
      cand.forEach((c, k) => {
        if (k > 0 && !c.o.rng.chance(chaos ? loosen(overlap) : overlap)) return;
        pending.push({ s: c.o, t: c.t, heard: call.motif, depth: info.depth + 1, of: idx, from: s.i, lineage: call.lineage, callerHome: s.home });
      });
    }

    function ctxFor(s, t) {
      return { harmonise, sounding: harmonise ? soundingAt(active, t, s.i) : null, register: era.at(t).register, copyMore: 0.6 * chaos };
    }

    while (true) {
      // next event: an answer due, or a creature's next try
      let ev = null, evT = Infinity;
      for (const a of pending) if (a.t < evT) { evT = a.t; ev = a; }
      let who = null;
      for (const s of slots) if (s.next < evT) { evT = s.next; who = s; ev = null; }
      if (evT >= seconds) break;
      for (let k = active.length - 1; k >= 0; k--) if (active[k].tail < evT) active.splice(k, 1);

      if (ev) {                                       // an answer falls due
        pending.splice(pending.indexOf(ev), 1);
        const s = ev.s, t = ev.t;
        if (s.busyUntil > t) continue;                 // still calling
        if (floorUntil > t && !s.rng.chance(chaos ? loosen(overlap) : overlap)) continue;   // someone else took the floor
        const call = s.caller.answer(t, ev.heard, ctxFor(s, t));
        // widen the gap between caller and answerer (both at the same spot: no lean)
        const lean = solo ? 0 : Math.max(-1, Math.min(1, (s.home - ev.callerHome) * LEAN));
        place(s, call, { depth: ev.depth, of: ev.of, from: ev.from, lineage: ev.lineage, lean });
        continue;
      }
      const s = who, t = evT;                          // a creature tries to start
      if (s.busyUntil > t) { s.next = s.busyUntil + restOf(s, s.busyUntil); continue; }
      const forced = s.forced; s.forced = false;
      if (s.ignore) {
        if (!forced && !s.rng.chance(s.cc.talkative)) { s.next = t + restOf(s, t) * 0.5; continue; }
        place(s, s.caller.call(t, ctxFor(s, t)), { depth: 0 });
        continue;
      }
      if (floorUntil > t && !forced) {
        if (!s.rng.chance(overlap * s.cc.talkative)) { s.next = floorUntil + gap(); continue; }
      } else if (!forced && !s.rng.chance(s.cc.talkative)) { s.next = t + restOf(s, t) * 0.5; continue; }
      let call;
      if (memory.length && s.rng.chance(chaos ? Math.min(1, s.cc.mimicry * RECALL * (1 + 2 * chaos)) : s.cc.mimicry * RECALL)) {
        const k = s.rng.weighted(memory.map(m => m.weight), memory.length);
        call = s.caller.answer(t, memory[k].motif, ctxFor(s, t));
        place(s, call, { depth: 0, lineage: memory[k].lineage });
      } else {
        call = s.caller.call(t, ctxFor(s, t));
        place(s, call, { depth: 0 });
      }
    }
    return score;
  }

  const api = { conduct, eraWalk, CHAIN };
  if (inNode) module.exports = api;
  else K.conductor = api;
})(typeof self !== 'undefined' ? self : this);
