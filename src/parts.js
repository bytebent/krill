/*
 * krill · parts: the sources and bodies a creature can be built from
 *
 * A creature is one SOURCE (makes the sound) through one BODY (shapes it; 'none' = raw source).
 * Everything krill knows about a particular engine lives in its entry here, so a new synth or
 * a new resonating body is one more entry; nothing else in krill names an engine.
 *
 * Every part has:
 *   id, label, ns          ns = namespace of its parameters in creature files ('throat.breathy')
 *   params                 the engine's parameter table (see P below)
 *   defaults               species-default ranges { id: [lo, hi] }
 *   groups, colors         how the creature page lays it out and colours it
 *   create(sr, seed)       an instance with krill's uniform interface (below)
 * Sources also have:
 *   pitch                  default note range [low, high]
 *   keySnap (optional)     rules for parameters that move pitch, applied in key mode
 * A source instance:  set(id, v) · noteOn(n) · noteOff(n) · setOffset(semitones) · render(out, n)
 *                     (mono, 32-sample blocks) · reach (how far setOffset can move, semitones)
 *                     · makeupDb (gain the voice adds back after the engine's headroom)
 * A body instance:    set(id, v) · snap() · process(inp, out, n) (may overwrite inp) · makeupDb
 * Loudness calibration per source + body combination is in CALIBRATION_DB (tools/calibrate.js).
 *
 * Param fields:
 *   use    'range' = the creature gives it a range (locked = min equal to max)
 *          'fixed' = krill sets it once to `value` and never touches it again
 *          'krill' = krill drives it from the score (pitch, envelope, glide), not from ranges
 *   scale  how a 0–1 position maps into a range: 'lin', 'log' (ratios) or 'sq' (fine near the low end)
 *   step   1 for whole-number (menu or switch) parameters
 *   headroom  an output gain krill turns down so the engine's own ±1 clamp never touches the
 *          sound; the part's makeupDb adds it back
 *
 * Works in the browser (Krill.parts) and in Node (module.exports). Engines are only needed
 * when create() is called, so pages can load this file without them.
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const engines = () => inNode ? require('./engines.js') : K.engines;

  const R = 'range', F = 'fixed', KR = 'krill';
  function P(id, label, min, max, def, use, opt) {
    const o = { id, label, min, max, def, use, scale: 'lin', step: 0, unit: '', value: def };
    if (opt) for (const k in opt) o[k] = opt[k];
    return o;
  }
  const db2lin = d => Math.pow(10, d / 20);
  const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;
  const fixedOf = params => params.filter(p => p.use === F);
  const headroomOf = params => params.filter(p => p.headroom).reduce((a, p) => a - p.value, 0);

  // ---------------- sources ----------------

  const THROAT = [
    P('voicing', 'Voicing', 0, 1, 1, R, { title: '0% breath only … 100% fully voiced' }),
    P('breathy', 'Breathy', 0, 1, 0, R),
    P('tense', 'Tense', 0, 1, 0, R),
    P('creaky', 'Creaky', 0, 1, 0, R),
    P('thin', 'Thin', 0, 1, 0, R),
    P('growl', 'Growl', 0, 1, 0, R),
    P('jitter', 'Jitter', 0, 1, 0, R),
    P('shimmer', 'Shimmer', 0, 1, 0, R),
    P('source', 'Source', 0, 1, 0, R, { step: 1, options: ['Flow', 'Derivative'] }),
    P('transpose', 'Transpose', -24, 24, 0, KR),
    P('detune', 'Detune', -100, 100, 0, KR),
    P('mode', 'Mode', 0, 1, 0, F, { value: 0 }),
    P('glide', 'Glide', 0, 2, 0.06, KR),
    P('attack', 'Attack', 0.001, 5, 0.02, KR),
    P('decay', 'Decay', 0.001, 5, 0.3, F, { value: 0.3 }),
    P('sustain', 'Sustain', 0, 1, 0.8, F, { value: 1 }),
    P('release', 'Release', 0.001, 8, 0.25, KR),
    P('volume', 'Volume', -48, 6, -6, F, { value: -12, headroom: true }),
  ];

  const DOLPHIN = [
    P('rate', 'Rate', -6, 2, -2, R, { unit: 'oct', title: 'Pulse rate in octaves from the note (when Key track is on)' }),
    P('keytrack', 'Key track', 0, 1, 1, R, { step: 1, options: ['Off', 'On'] }),
    P('freerate', 'Free rate', 1, 2000, 13, R, { scale: 'log', unit: '/s', title: 'Pulse rate in pulses per second (when Key track is off)' }),
    P('sync', 'Sync', 0, 1, 0, F, { step: 1, value: 0 }),
    P('pattern', 'Pattern', 0, 3, 0, R, { step: 1, options: ['Regular', 'Increasing', 'Decreasing', 'Grouped'] }),
    P('coda', 'Coda', 0, 16, 0, R, { step: 1 }),
    P('jitter', 'Jitter', 0, 1, 0.05, R),
    P('rubato', 'Rubato', 0, 1, 0, R),
    P('ornament', 'Ornament', 0, 1, 0, R),
    P('clicktone', 'Click tone', -2, 2, 0, R, { unit: 'oct' }),
    P('clickwidth', 'Click width', 0.05, 0.5, 0.1, R, { scale: 'log', unit: 'ms' }),
    P('ring', 'Ring', 0, 1, 0, R),
    P('vowel', 'Vowel', 0, 1, 0, R),
    P('pitchmode', 'Pitch mode', 0, 1, 0, F, { step: 1, value: 0 }),
    P('shape', 'Shape', 0, 5, 1, R, { step: 1, options: ['Flat', 'Up', 'Down', 'Convex', 'Concave', 'Wave'] }),
    P('sweep', 'Sweep', -3, 3, 1.4, R, { unit: 'oct' }),
    P('time', 'Time', 0.05, 4, 1, R, { scale: 'log', unit: 's' }),
    P('pitch', 'Pitch', -3, 3, 0, F, { value: 0 }),
    P('wtranspose', 'Whistle transpose', -24, 24, 0, R, { step: 1, unit: 'st' }),
    P('harmonics', 'Harmonics', 0, 3, 1, R, { step: 1 }),
    P('harmlevel', 'Harmonic level', -24, 0, -12, R, { unit: 'dB' }),
    P('register', 'Register', 0, 1, 0.5, R, { title: '0% pulses only … 100% whistle only' }),
    P('biphon', 'Biphonation', 0, 1, 0, R),
    P('spread', 'Spread', 0, 1, 0.3, F, { value: 0 }),
    P('size', 'Size', 0, 1, 0, R, { title: 'Small sounds higher: the whistle sits up to 4 octaves above the note' }),
    P('sizemode', 'Size mode', 0, 1, 0, R, { step: 1, options: ['Octaves', 'Continuous'] }),
    P('mode', 'Mode', 0, 1, 1, F, { step: 1, value: 0 }),
    P('glide', 'Glide', 0, 2, 0.06, KR),
    P('transpose', 'Transpose', -24, 24, 0, F, { step: 1, value: 0 }),
    P('detune', 'Detune', -100, 100, 0, KR),
    P('bendrange', 'Bend range', 2, 48, 12, F, { step: 1, value: 48 }),
    P('attack', 'Attack', 0.001, 5, 0.01, KR),
    P('decay', 'Decay', 0.001, 5, 0.3, F, { value: 0.3 }),
    P('sustain', 'Sustain', 0, 1, 0.8, F, { value: 1 }),
    P('release', 'Release', 0.001, 8, 0.3, KR),
    P('volume', 'Volume', -48, 6, -6, F, { value: -12, headroom: true }),
  ];
  // the four LFOs stay off (target None); krill moves parameters itself
  for (let i = 1; i <= 4; i++) DOLPHIN.push(P('lfo' + i + 'target', 'LFO ' + i + ' target', 0, 28, 0, F, { step: 1, value: 0 }));

  // Dolphin in key mode: pulse rates heard as pitch, the whistle transpose and the end of a sweep
  // land on the scale; Size may only move the whistle by whole octaves. Only parameters that
  // snapping can actually change are made to vary per unit.
  const PULSE_PITCH_HZ = 30;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const ftom = f => 69 + 12 * Math.log2(f / 440);
  const dolphinKey = {
    // act: [{ spec, lo, hi, locked }] from creature.activeParams; returns the keys that must vary
    prepare(act) {
      const find = k => act.find(x => x.spec.key === k);
      const sm = find('dolphin.sizemode');
      if (sm) { sm.lo = sm.hi = 0; sm.locked = true; }
      const range = k => { const a = find(k); return a ? [a.lo, a.hi] : null; };
      const kt = range('dolphin.keytrack'), rate = range('dolphin.rate'), fr = range('dolphin.freerate'),
        wt = range('dolphin.wtranspose'), sw = range('dolphin.sweep'), sh = range('dolphin.shape');
      const out = new Set();
      const ktOn = !kt || kt[1] >= 0.5, ktOff = !!kt && kt[0] < 0.5;
      if (ktOn && rate && !(rate[0] === rate[1] && Number.isInteger(rate[0]))) out.add('dolphin.rate');
      if (ktOff && fr && fr[1] > PULSE_PITCH_HZ) out.add('dolphin.freerate');
      if (wt && !(wt[0] === wt[1] && wt[0] % 12 === 0)) out.add('dolphin.wtranspose');
      if ((!sh || sh[1] > 0) && sw && !(sw[0] === sw[1] && Number.isInteger(sw[0]))) out.add('dolphin.sweep');
      return out;
    },
    // cc: the compiled creature; returns (values, note) => void, or null if nothing can change
    snapper(cc) {
      const iRate = cc.vKey.indexOf('dolphin.rate'), iFree = cc.vKey.indexOf('dolphin.freerate');
      const iWt = cc.vKey.indexOf('dolphin.wtranspose'), iKt = cc.vKey.indexOf('dolphin.keytrack'), iSw = cc.vKey.indexOf('dolphin.sweep');
      if (iRate < 0 && iFree < 0 && iWt < 0 && iSw < 0) return null;
      const snap = cc.pitch.snap, ktLocked = cc.lockedValue['dolphin.keytrack'], wtLocked = cc.lockedValue['dolphin.wtranspose'] || 0;
      return (v, note) => {
        const kt = iKt >= 0 ? v[iKt] : ktLocked;
        const keytrack = kt === undefined ? true : kt >= 0.5;
        if (keytrack && iRate >= 0) {
          const r = v[iRate];
          if (mtof(note) * Math.pow(2, r) > PULSE_PITCH_HZ) v[iRate] = clamp((snap(note + 12 * r) - note) / 12, -6, 2);
        } else if (!keytrack && iFree >= 0) {
          const f = v[iFree];
          if (f > PULSE_PITCH_HZ) v[iFree] = clamp(mtof(snap(ftom(f))), 1, 2000);
        }
        if (iWt >= 0) v[iWt] = clamp(snap(note + v[iWt]) - note, -24, 24);
        if (iSw >= 0) {
          const w = note + (iWt >= 0 ? v[iWt] : wtLocked);
          v[iSw] = clamp((snap(w + 12 * v[iSw]) - w) / 12, -3, 3);
        }
      };
    },
  };

  const SOURCES = {
    throat: {
      kind: 'source', id: 'throat', label: 'Throat', ns: 'throat', params: THROAT,
      colors: ['var(--red)', 'var(--blue)'],
      pitch: [40, 60],
      pitchNote: 'Throat sings the notes as they are.',
      defaults: { voicing: [0.85, 1], breathy: [0, 0.4], tense: [0, 0.3], creaky: [0, 0.2], thin: [0, 0.3], growl: [0, 0.1], jitter: [0.05, 0.2], shimmer: [0.05, 0.2], source: [0, 0] },
      groups: [
        { name: 'Voice', ids: ['voicing', 'breathy', 'tense', 'creaky', 'thin', 'growl'], c: 'var(--red)' },
        { name: 'Irregularity', ids: ['jitter', 'shimmer'], c: 'var(--blue)' },
        { name: 'Pulse shape', ids: ['source'], c: 'var(--blue)' },
      ],
      // holds one note; pitch moves through Transpose (±24 st) + Detune (±1 st), applied per block
      create(sr, seed) {
        const e = new (engines().ThroatEngine)(sr, seed);
        for (const p of fixedOf(THROAT)) e.setParam(p.id, p.value);
        e.setParam('glide', 0); e.setParam('detune', 0); e.setParam('transpose', 0);
        let last = NaN;
        return {
          reach: 25, makeupDb: headroomOf(THROAT),
          set: (id, v) => e.setParam(id, v),
          noteOn: n => e.noteOn(n, 100), noteOff: n => e.noteOff(n),
          setOffset(off) {
            if (off === last) return; last = off;
            const t = clamp(off, -24, 24);
            e.setParam('transpose', t); e.setParam('detune', (off - t) * 100);
          },
          render: (out, n) => e.process(out, n),
        };
      },
    },
    dolphin: {
      kind: 'source', id: 'dolphin', label: 'Dolphin', ns: 'dolphin', params: DOLPHIN,
      colors: ['var(--blue)'],
      pitch: [60, 84],
      keySnap: dolphinKey,
      defaults: {
        rate: [-3, -1], keytrack: [1, 1], freerate: [13, 13], pattern: [0, 0], coda: [0, 0],
        jitter: [0, 0.2], rubato: [0, 0.3], ornament: [0, 0], clicktone: [-0.5, 0.5], clickwidth: [0.1, 0.1],
        ring: [0, 0.3], vowel: [0, 0.5], shape: [1, 4], sweep: [-1, 1.5], time: [0.3, 1.5],
        wtranspose: [0, 0], harmonics: [1, 2], harmlevel: [-18, -8], register: [0.3, 0.9],
        biphon: [0, 0.3], size: [0.2, 0.6], sizemode: [0, 0],
      },
      groups: [
        { name: 'Pulses', ids: ['rate', 'keytrack', 'freerate', 'pattern', 'coda', 'jitter', 'rubato', 'ornament'], c: 'var(--blue)' },
        { name: 'Clicks', ids: ['clicktone', 'clickwidth', 'ring', 'vowel'], c: 'var(--blue)' },
        { name: 'Whistle', ids: ['shape', 'sweep', 'time', 'wtranspose', 'harmonics', 'harmlevel'], c: 'var(--blue)' },
        { name: 'Blend', ids: ['register', 'biphon', 'size', 'sizemode'], c: 'var(--blue)' },
      ],
      // what the page says about pitch: the whistle sounds Size octaves above the note
      pitchInfo(c, rangeOf, noteName) {
        const sz = rangeOf('dolphin.size');
        const k1 = Math.round(4 * (1 - sz[1])), k2 = Math.round(4 * (1 - sz[0]));
        const oct = k1 === k2 ? '+' + k1 : '+' + k1 + ' to +' + k2;
        return 'Dolphin: pulses follow the notes; the whistle sounds ' + oct + ' octaves higher (' +
          noteName(c.pitch.low + 12 * k1) + '–' + noteName(Math.min(127, c.pitch.high + 12 * k2)) + ').';
      },
      // holds one note; pitch moves through the bend (range fixed at ±48 st); stereo summed to mono
      create(sr, seed) {
        const e = new (engines().DolphinEngine)(sr, seed);
        for (const p of fixedOf(DOLPHIN)) e.setParam(p.id, p.value);
        e.setParam('glide', 0); e.setParam('detune', 0);
        const r = new Float32Array(32);
        let last = NaN;
        return {
          reach: 48, makeupDb: headroomOf(DOLPHIN),
          set: (id, v) => e.setParam(id, v),
          noteOn: n => e.noteOn(n, 100), noteOff: n => e.noteOff(n),
          setOffset(off) { if (off !== last) { last = off; e.setBend(off / 48); } },
          render(out, n) {
            const rr = r.length >= n ? r : new Float32Array(n);
            e.process(out, rr, n);
            for (let i = 0; i < n; i++) out[i] = (out[i] + rr[i]) * 0.5;
          },
        };
      },
    },
  };

  // ---------------- bodies ----------------

  const TUBE = [
    P('tongueX', 'Tongue front–back', 0, 1, 0.55, R),
    P('tongueY', 'Tongue close–open', 0, 1, 0.7, R),
    P('tip', 'Tip', 0, 1, 0, R),
    P('jaw', 'Jaw', 0, 1, 0.3, R),
    P('lips', 'Lips', 0, 1, 0.6, R),
    P('round', 'Round', 0, 1, 0, R),
    P('nasal', 'Nasal', 0, 1, 0, R),
    P('length', 'Length', 7, 35, 17, R, { unit: 'cm' }),
    P('damping', 'Damping', 0, 1, 0.5, R),
    P('spread', 'Spread', 0, 1, 0, F, { value: 0 }),
    P('radiation', 'Radiation', 0, 1, 1, F, { value: 1 }),
    P('mix', 'Mix', 0, 1, 1, F, { value: 1 }),
    P('output', 'Output', -24, 12, 0, F, { value: -18, headroom: true }),
  ];
  // The tube can add 20 dB or more of peak gain (clicks ringing its resonances), so it's fed this
  // much lower and the makeup adds it back. It's linear, so only headroom changes.
  const TUBE_TRIM_DB = -24;

  const BODIES = {
    none: {
      kind: 'body', id: 'none', label: 'None', ns: null, params: [], defaults: {}, groups: [], colors: [],
      create: () => null,
    },
    tube: {
      kind: 'body', id: 'tube', label: 'Mouth', ns: 'tube', params: TUBE, colors: ['var(--purple)'],
      view: 'tube',                     // the page draws the tract and the vowel pad for this body
      defaults: { tongueX: [0.2, 0.8], tongueY: [0.3, 0.9], tip: [0, 0], jaw: [0.2, 0.6], lips: [0.4, 0.9], round: [0, 0.5], nasal: [0, 0.15], length: [14, 20], damping: [0.4, 0.6] },
      groups: [{ name: 'Tract', ids: ['tongueX', 'tongueY', 'tip', 'jaw', 'lips', 'round', 'nasal', 'length', 'damping'], c: 'var(--purple)' }],
      create(sr) {
        const t = new (engines().MouthTube)(sr);
        for (const p of fixedOf(TUBE)) t.setParam(p.id, p.value);
        const trim = db2lin(TUBE_TRIM_DB), scratch = new Float32Array(32);
        return {
          makeupDb: headroomOf(TUBE) - TUBE_TRIM_DB,
          set: (id, v) => t.setParam(id, v),
          snap: () => t.snap(),
          process(inp, out, n) {
            for (let i = 0; i < n; i++) inp[i] *= trim;
            t.process(inp, null, out, scratch.length >= n ? scratch : new Float32Array(n), n);   // null: one channel only
          },
        };
      },
    },
  };

  // Loudness calibration (dB) per source + body, so Level 0 is about -20 dBFS RMS while calling
  // for each species default. Measured with tools/calibrate.js; a new part needs its own entry.
  const CALIBRATION_DB = { 'throat+none': 4.7, 'throat+tube': -7.4, 'dolphin+none': -0.6, 'dolphin+tube': -32.1 };

  const api = { SOURCES, BODIES, CALIBRATION_DB, TUBE_TRIM_DB, P };
  if (inNode) module.exports = api;
  else K.parts = api;
})(typeof self !== 'undefined' ? self : this);
