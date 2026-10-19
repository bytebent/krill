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


  // Syrinx (bytebent/syrinx, prototype). Transpose is fixed at 0, so krill's note is the pitch
  // heard at Size 25% (a songbird): MIDI 96 is about 2.1 kHz. Size moves the whole bird, its pitch
  // too (bigger is lower); pitch moves through the bend, range fixed at ±48 st, like Dolphin.
  const SYRINX = [
    P('topology', 'Topology', 0, 2, 0, R, { step: 1, options: ['Duplex', 'Single', 'Triple'], title: 'Two sides (songbirds), one source (doves, parrots), or labia plus a membrane (tracheophones)' }),
    P('membrane', 'Membrane', -48, 12, -24, R, { unit: 'st', title: 'Membrane pitch from the note (Triple)' }),
    P('memlevel', 'Membrane level', 0, 1, 0.5, R),
    P('regime', 'Regime', 0, 1, 0.3, R, { title: '0% born as a pure tone … 100% pulse-like and rich' }),
    P('link', 'Link', 0, 1, 0.7, R, { title: 'How much Regime follows the note: rich low, tonal high' }),
    P('grain', 'Grain', 0, 1, 0.15, R),
    P('breathbend', 'Breath bend', 0, 1, 0, R),
    P('playmode', 'Play mode', 0, 3, 0, R, { step: 1, options: ['Handoff', 'Interval', 'Duo', 'Independent'], title: 'krill holds one note, so Duo and Independent sing one side' }),
    P('split', 'Split', 500, 8000, 3500, R, { scale: 'log', unit: 'Hz', title: 'Handoff: the left side sings below, the right above' }),
    P('overlap', 'Overlap', 0, 1500, 300, R, { unit: 'Hz' }),
    P('interval', 'Interval', -24, 24, 7.3, R, { unit: 'st', title: 'Interval mode: the right side this far from the note' }),
    P('asym', 'Asymmetry', 0, 1, 0.2, R),
    P('balance', 'Balance', -1, 1, 0, R),
    P('coupling', 'Coupling', 0, 1, 0.1, R),
    P('jumps', 'Jumps', 0, 1, 0, R),
    P('trachea', 'Trachea', 1, 200, 3.5, R, { scale: 'log', unit: 'cm' }),
    P('chaos', 'Chaos', 0, 1, 0, R),
    P('wobblerate', 'Wobble rate', 0, 250, 0, R, { unit: 'Hz' }),
    P('wobble', 'Wobble', 0, 1, 0, R),
    P('wobblefm', 'Wobble pitch', 0, 1, 0, R, { title: '0% loudness … 100% pitch' }),
    P('pressure', 'Pressure', 0, 1, 0.7, R),
    P('attack', 'Attack', 0.001, 5, 0.008, KR),
    P('decay', 'Decay', 0.001, 5, 0.3, F, { value: 0.3 }),
    P('sustain', 'Sustain', 0, 1, 0.8, F, { value: 1 }),
    P('release', 'Release', 0.001, 8, 0.03, KR),
    P('minibreath', 'Minibreath', 0, 1, 0.6, R),
    P('pattern', 'Pattern', 0, 1, 0, R, { step: 1, options: ['Off', 'On'], title: 'On: each unit is a run of syllables (a trill)' }),
    P('sylrate', 'Syllable rate', 0.5, 60, 8, R, { scale: 'log', unit: '/s' }),
    P('sync', 'Sync', 0, 1, 0, F, { step: 1, value: 0 }),
    P('duty', 'Duty', 0.05, 0.95, 0.6, R),
    P('shape', 'Shape', 0, 5, 2, R, { step: 1, options: ['Flat', 'Up', 'Down', 'Convex', 'Concave', 'Wave'] }),
    P('sweep', 'Sweep', -4, 4, 1, R, { unit: 'oct' }),
    P('sides', 'Sides', 0, 3, 0, R, { step: 1, options: ['Auto', 'Left', 'Right', 'Alternate'] }),
    P('trill', 'Trill limit', 0, 1, 0.7, R),
    P('jitter', 'Jitter', 0, 1, 0.05, R),
    P('transpose', 'Transpose', -24, 60, 36, F, { step: 1, value: 0 }),
    P('detune', 'Detune', -100, 100, 0, F, { value: 0 }),
    P('glide', 'Glide', 0, 2, 0.02, KR),
    P('bendrange', 'Bend range', 2, 48, 12, F, { step: 1, value: 48 }),
    P('mode', 'Mode', 0, 1, 0, F, { step: 1, value: 0 }),
    P('size', 'Size', 0, 1, 0.25, R, { title: 'Wren (0%) to crane (100%); 25% is a songbird. Bigger sings lower' }),
    P('tempolock', 'Tempo lock', 0, 1, 0.5, R),
    P('filter', 'Filter', 0, 1, 1, R, { step: 1, options: ['Off', 'On'], title: 'The internal trachea shapes the sound (turn off in front of Beak)' }),
    P('volume', 'Volume', -48, 6, -6, F, { value: -12, headroom: true }),
    P('lock', 'Lock', 0, 1, 0, R, { step: 1, options: ['Off', 'On'], title: 'Every pitch on a semitone; always on in key mode' }),
    P('glidestyle', 'Glide style', 0, 1, 0, R, { step: 1, options: ['Smooth', 'Stepped'] }),
  ];

  // Syrinx in key mode: Lock goes on (Size moves whole octaves, sweeps end on semitones, no pitch
  // jitter), and a sweep's end, the Interval side and the Triple membrane land on the scale.
  const syrinxKey = {
    prepare(act) {
      const find = k => act.find(x => x.spec.key === k);
      const lk = find('syrinx.lock');
      if (lk) { lk.lo = lk.hi = 1; lk.locked = true; }
      const range = k => { const a = find(k); return a ? [a.lo, a.hi] : null; };
      const out = new Set();
      const pat = range('syrinx.pattern'), sh = range('syrinx.shape'), sw = range('syrinx.sweep');
      if ((!pat || pat[1] >= 0.5) && (!sh || sh[1] > 0) && sw && !(sw[0] === sw[1] && Number.isInteger(sw[0]))) out.add('syrinx.sweep');
      const pm = range('syrinx.playmode'), iv = range('syrinx.interval');
      if (iv && (!pm || (pm[0] <= 1 && pm[1] >= 1)) && !(iv[0] === iv[1] && iv[0] % 12 === 0)) out.add('syrinx.interval');
      const tp = range('syrinx.topology'), mb = range('syrinx.membrane');
      if (mb && tp && tp[1] >= 2 && !(mb[0] === mb[1] && mb[0] % 12 === 0)) out.add('syrinx.membrane');
      return out;
    },
    snapper(cc) {
      const iSw = cc.vKey.indexOf('syrinx.sweep'), iIv = cc.vKey.indexOf('syrinx.interval'), iMb = cc.vKey.indexOf('syrinx.membrane');
      if (iSw < 0 && iIv < 0 && iMb < 0) return null;
      const snap = cc.pitch.snap;
      return (v, note) => {
        if (iSw >= 0) v[iSw] = clamp((snap(note + 12 * v[iSw]) - note) / 12, -4, 4);
        if (iIv >= 0) v[iIv] = clamp(snap(note + v[iIv]) - note, -24, 24);
        if (iMb >= 0) v[iMb] = clamp(snap(note + v[iMb]) - note, -48, 12);
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
    syrinx: {
      kind: 'source', id: 'syrinx', label: 'Syrinx', ns: 'syrinx', params: SYRINX,
      colors: ['var(--green)', 'var(--yellow)', 'var(--orange)'],
      pitch: [88, 103],
      keySnap: syrinxKey,
      defaults: {
        topology: [0, 0], membrane: [-24, -24], memlevel: [0.5, 0.5], regime: [0.1, 0.5], link: [0.5, 0.9], grain: [0.05, 0.25],
        breathbend: [0, 0.15], playmode: [0, 0], split: [3500, 3500], overlap: [300, 300], interval: [7, 7], asym: [0.1, 0.3],
        balance: [-0.2, 0.2], coupling: [0.05, 0.2], jumps: [0, 0.15], trachea: [3, 5], chaos: [0, 0],
        wobblerate: [0, 0], wobble: [0, 0], wobblefm: [0, 0], pressure: [0.55, 0.85], minibreath: [0.6, 0.6],
        pattern: [0, 1], sylrate: [6, 18], duty: [0.4, 0.8], shape: [1, 4], sweep: [-1, 1], sides: [0, 0], trill: [0.7, 0.7],
        jitter: [0, 0.1], size: [0.15, 0.35], tempolock: [0.5, 0.5], filter: [1, 1], lock: [0, 0], glidestyle: [0, 0],
      },
      groups: [
        { name: 'Source', ids: ['topology', 'regime', 'link', 'grain', 'breathbend', 'membrane', 'memlevel'], c: 'var(--green)' },
        { name: 'Sides', ids: ['playmode', 'split', 'overlap', 'interval', 'asym', 'balance', 'coupling'], c: 'var(--green)' },
        { name: 'Nonlinear', ids: ['jumps', 'trachea', 'chaos'], c: 'var(--orange)' },
        { name: 'Breath and muscles', ids: ['pressure', 'minibreath', 'wobblerate', 'wobble', 'wobblefm'], c: 'var(--yellow)' },
        { name: 'Pattern', ids: ['pattern', 'sylrate', 'duty', 'shape', 'sweep', 'sides', 'trill', 'jitter'], c: 'var(--yellow)' },
        { name: 'Bird', ids: ['size', 'tempolock', 'filter', 'lock', 'glidestyle'], c: 'var(--green)' },
      ],
      pitchInfo(c, rangeOf, noteName) {
        const sz = rangeOf('syrinx.size');
        const o1 = -(sz[1] - 0.25) * 8 / 3, o2 = -(sz[0] - 0.25) * 8 / 3;
        const lo = Math.max(0, Math.round(c.pitch.low + 12 * o1)), hi = Math.min(127, Math.round(c.pitch.high + 12 * o2));
        const hz = n => { const f = 440 * Math.pow(2, (n - 69) / 12); return f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz'; };
        return 'Syrinx: the notes as they are at Size 25%; this bird\'s Size puts it at ' + noteName(lo) + '–' + noteName(hi) +
          ' (' + hz(lo) + '–' + hz(hi) + '). Pattern trills and sweeps go around the note.';
      },
      // holds one note; pitch moves through the bend (range fixed at ±48 st); its two channels are the same
      create(sr, seed) {
        const e = new (engines().SyrinxEngine)(sr, seed);
        for (const p of fixedOf(SYRINX)) e.setParam(p.id, p.value);
        e.setParam('glide', 0);
        const r = new Float32Array(32);
        let last = NaN;
        return {
          reach: 48, makeupDb: headroomOf(SYRINX),
          set: (id, v) => e.setParam(id, v),
          noteOn: n => e.noteOn(n, 100), noteOff: n => e.noteOff(n),
          setOffset(off) { if (off !== last) { last = off; e.setBend(off / 48); } },
          render: (out, n) => e.process(out, null, n),
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


  // beak-tube (bytebent/beak-tube, prototype): a bird's trachea, throat and beak. Its throat
  // follows the pitch it hears, so it works on any source; on Syrinx turn Syrinx's Filter off.
  const BEAK = [
    P('size', 'Size', 0, 1, 0.25, R, { title: 'Wren (0%) to crane (100%); matches Syrinx\'s Size' }),
    P('mode', 'Mode', 0, 3, 0, R, { step: 1, options: ['Song', 'Parrot', 'Sac', 'Boom'] }),
    P('trachlen', 'Trachea length', 1.5, 200, 3.5, R, { scale: 'log', unit: 'cm' }),
    P('trachloss', 'Trachea loss', 0, 1, 0.3, R),
    P('larynx', 'Larynx', 0, 1, 0.6, R),
    P('track', 'Track', 0, 1, 0.9, R, { title: 'How much the throat resonance follows the pitch' }),
    P('tune', 'Tune', 200, 10000, 4000, R, { scale: 'log', unit: 'Hz' }),
    P('lag', 'Lag', 0, 0.03, 0.005, R, { unit: 's' }),
    P('ring', 'Ring', 0, 1, 0.5, R),
    P('gape', 'Gape', 0, 1, 0.5, R),
    P('gapefollow', 'Gape follow', 0, 1, 0.6, R),
    P('tonguefb', 'Tongue front–back', 0, 1, 0.5, R, { title: 'Parrot only' }),
    P('tongueht', 'Tongue height', 0, 1, 0.3, R, { title: 'Parrot only' }),
    P('sactune', 'Sac tune', 200, 1500, 600, R, { scale: 'log', unit: 'Hz', title: 'Sac and Boom' }),
    P('inflate', 'Inflate', 0, 1, 0.8, R, { title: 'Sac and Boom' }),
    P('body', 'Body', 0, 1, 0, R),
    P('spread', 'Spread', 0, 1, 0.2, F, { value: 0 }),
    P('radiation', 'Radiation', 0, 1, 1, F, { step: 1, value: 1 }),
    P('mix', 'Mix', 0, 1, 1, F, { value: 1 }),
    P('output', 'Output', -24, 12, 0, F, { value: -12, headroom: true }),
    P('bypass', 'Bypass', 0, 1, 0, F, { step: 1, value: 0 }),
  ];

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
    beak: {
      kind: 'body', id: 'beak', label: 'Beak', ns: 'beak', params: BEAK, colors: ['var(--orange)'],
      defaults: {
        size: [0.15, 0.35], mode: [0, 0], trachlen: [3, 5], trachloss: [0.2, 0.4], larynx: [0.5, 0.7], track: [0.8, 1],
        tune: [3000, 5000], lag: [0.003, 0.008], ring: [0.4, 0.6], gape: [0.4, 0.7], gapefollow: [0.5, 0.8],
        tonguefb: [0.3, 0.7], tongueht: [0.2, 0.4], sactune: [500, 700], inflate: [0.7, 0.9], body: [0, 0.2],
      },
      // a source's defaults that change in front of this body: Syrinx's own trachea filter goes off
      sourceDefaults: { syrinx: { filter: [0, 0] } },
      groups: [
        { name: 'Bird', ids: ['size', 'mode'], c: 'var(--orange)' },
        { name: 'Trachea', ids: ['trachlen', 'trachloss'], c: 'var(--orange)' },
        { name: 'Throat', ids: ['track', 'tune', 'larynx', 'lag', 'ring'], c: 'var(--orange)' },
        { name: 'Beak', ids: ['gape', 'gapefollow'], c: 'var(--orange)' },
        { name: 'Tongue, sac and body', ids: ['tonguefb', 'tongueht', 'sactune', 'inflate', 'body'], c: 'var(--orange)' },
      ],
      // mono in, mono out; its throat tracks the input's pitch (latency about 6 ms)
      create(sr) {
        const t = new (engines().BeakTube)(sr);
        for (const p of fixedOf(BEAK)) t.setParam(p.id, p.value);
        return {
          makeupDb: headroomOf(BEAK),
          set: (id, v) => t.setParam(id, v),
          snap: () => {},                     // settings land at once until the first block
          process: (inp, out, n) => t.process(inp, null, out, null, n),
        };
      },
    },
  };

  // Loudness calibration (dB) per source + body, so Level 0 is about -20 dBFS RMS while calling
  // for each species default. Measured with tools/calibrate.js; a new part needs its own entry.
  const CALIBRATION_DB = {
    'throat+none': 4.7, 'throat+tube': -7.4, 'throat+beak': 31.5,
    'dolphin+none': -0.6, 'dolphin+tube': -32.1, 'dolphin+beak': -8.5,
    'syrinx+none': -3.1, 'syrinx+tube': -30.7, 'syrinx+beak': -4.9,
  };

  const api = { SOURCES, BODIES, CALIBRATION_DB, TUBE_TRIM_DB, P };
  if (inNode) module.exports = api;
  else K.parts = api;
})(typeof self !== 'undefined' ? self : this);
