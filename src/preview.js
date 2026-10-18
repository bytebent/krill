/*
 * krill · previews for the creature page
 *
 * The page's render worker calls these; they're plain functions so Node tests can run them too.
 *   previewCall()  render one call of a creature (as it would call in a pond, or its signature)
 *   spectrogram()  magnitude spectrogram as bytes, for the LCD
 *   soloWav()      a solo render straight into WAV bytes (Render 60 s solo)
 *
 * Works in the browser / a worker (Krill.preview) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const C = inNode ? require('./creature.js') : K.creature;
  const R = inNode ? require('./roll.js') : K.roll;
  const S = inNode ? require('./scales.js') : K.scales;
  const { Rng, hash, tag } = inNode ? require('./rng.js') : K.rng;
  const { Voice } = inNode ? require('./voice.js') : K.voice;
  const M = inNode ? require('./mixer.js') : K.mixer;
  const W = inNode ? require('./wav.js') : K.wav;

  const START = 0.05;                  // s of silence before the call
  const TAIL = 0.9;                    // s after the call's release
  // the body's parameter values at the start and end of a unit (for the page's body view)
  function bodyOf(slot, u) {
    const part = C.PARTS.BODIES[slot.body];
    if (!part || !part.ns) return null;
    const base = {};
    for (const p of part.params) base[p.id] = p.use === 'fixed' ? p.value : p.def;
    for (const l of slot.locked) if (l.engine === part.ns) base[l.id] = l.value;
    const a = Object.assign({}, base), b = Object.assign({}, base), pre = part.ns + '.';
    slot.vary.forEach((k, j) => {
      if (!k.startsWith(pre)) return;
      const id = k.slice(pre.length);
      a[id] = u.v0[j]; b[id] = u.v1[j];
    });
    return { start: a, end: b };
  }

  // kind: 'call' (what the creature would do: fresh or signature, by its own odds) or 'signature'
  function previewCall(creature, opts) {
    opts = opts || {};
    const sr = opts.sampleRate || 48000;
    const pitch = S.makePitch(opts.pitch);
    const seed = (opts.seed >>> 0) || 1;
    const rng = new Rng(hash(seed, tag('preview')));
    const caller = new R.Caller(creature, pitch, rng);
    const cc = caller.cc;
    const call = opts.kind === 'signature'
      ? R.realise(cc, R.mutate(cc.signature, cc.sigVariation, rng, cc.units[1]), START, {}, rng, 'signature')
      : caller.call(START, {});
    const slot = R.slotInfo(cc);
    const voice = new Voice(slot, [call], { sampleRate: sr, seed: hash(seed, tag('slot'), 0, 0), pan: slot.pan, wander: slot.wander, level: slot.level });
    const frames = Math.ceil((call.tail + TAIL) * sr);
    const render = new M.Render([voice], { sampleRate: sr, frames, fadeOut: 0.05 });
    const L = new Float32Array(frames), Rr = new Float32Array(frames);
    render.read(L, Rr, frames);
    const st = render.stats();
    return {
      L, R: Rr, sampleRate: sr, seconds: frames / sr, pitch: pitch.label,
      call: {
        kind: call.kind, attack: call.attack, release: call.release, legato: call.legato,
        t: call.t, end: call.end, tail: call.tail,
        units: call.units.map(u => ({ t: u.t, dur: u.dur, note: u.note, noteEnd: u.noteEnd, body: bodyOf(slot, u) })),
        bodyView: (C.PARTS.BODIES[creature.body] || {}).view || null,
      },
      peakDb: st.peakDb, enginePeakDb: st.enginePeakDb[0],
    };
  }

  // ---------- spectrogram ----------
  const fftCache = {};
  function fftTables(n) {
    if (fftCache[n]) return fftCache[n];
    const rev = new Uint32Array(n), bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    const win = new Float64Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return (fftCache[n] = { rev, cos, sin, win });
  }
  function fft(re, im, t) {
    const n = re.length;
    for (let i = 0; i < n; i++) { const j = t.rev[i]; if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
        const c = t.cos[k * step], si = t.sin[k * step], a = s + k, b = a + half;
        const xr = re[b] * c - im[b] * si, xi = re[b] * si + im[b] * c;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
  // returns { data (cols × bins bytes, column-major), cols, bins, hop, fmax, topDb }. Colours follow the
  // call's own peak: 255 = its loudest bin, 0 = 60 dB below, so quiet and loud calls both show detail.
  function spectrogram(L, Rr, sr, opts) {
    opts = opts || {};
    const n = opts.fft || 1024, hop = opts.hop || 256, fmax = Math.min(sr / 2, opts.fmax || 10000);
    const t = fftTables(n);
    const bins = Math.floor(fmax / (sr / n));
    const cols = Math.max(1, Math.floor((L.length - n) / hop) + 1);
    const data = new Uint8Array(cols * bins), dbs = new Float32Array(cols * bins);
    const re = new Float64Array(n), im = new Float64Array(n);
    let top = -200;
    const norm = 2 / (n * 0.5);              // Hann coherent gain 0.5; one-sided
    for (let c = 0; c < cols; c++) {
      const o = c * hop;
      for (let i = 0; i < n; i++) { const x = o + i < L.length ? (L[o + i] + Rr[o + i]) * 0.5 : 0; re[i] = x * t.win[i]; im[i] = 0; }
      fft(re, im, t);
      for (let k = 0; k < bins; k++) {
        const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
        const d = m > 0 ? 20 * Math.log10(m) : -200;
        dbs[c * bins + k] = d;
        if (d > top) top = d;
      }
    }
    const floor = top - 60;
    for (let i = 0; i < dbs.length; i++) { const v = (dbs[i] - floor) * (255 / 60); data[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
    return { data, cols, bins, hop, fmax: bins * sr / n, topDb: top };
  }

  // ---------- solo WAV ----------
  function soloWav(creature, opts, onProgress) {
    const job = M.soloRender(creature, opts);
    const sink = W.memorySink();
    const wav = new W.WavWriter(sink, {
      sampleRate: 48000, bits: opts.bits === 16 ? 16 : 24, seed: opts.seed,
      title: 'krill · ' + creature.name + ' · seed ' + opts.seed, software: 'krill ' + job.meta.krill,
      comment: creature.name + ' solo, ' + job.meta.pitch + ', ' + job.meta.seconds + ' s, seed ' + job.meta.seed,
      meta: job.meta,
    });
    const CH = 48000, L = new Float32Array(CH), Rr = new Float32Array(CH);
    let lastP = -1;
    while (!job.render.done) {
      const k = job.render.read(L, Rr, CH);
      wav.write(L, Rr, k);
      const p = Math.floor(job.render.progress * 100);
      if (onProgress && p !== lastP) { lastP = p; onProgress(job.render.progress); }
    }
    wav.finish();
    return { bytes: sink.bytes(), fileName: job.fileName, stats: job.render.stats(), calls: job.score.calls.length };
  }

  // a pond (or its first `seconds`) straight into WAV bytes (the pond page's preview)
  // A pond export in steps, so a long piece can stream to disk without being held in memory.
  //   step(seconds) renders the next stretch and returns its bytes (append them in order);
  //   once `done`, `header` is the final header, to be written over the file's first bytes.
  // pond: a pond whose output settings (length, bits, fades, level) are the export's.
  function pondExporter(pondIn, opts) {
    const job = M.pondRender(pondIn, { seconds: opts && opts.seconds });
    const p = job.pond;
    let pending = [], header = null;
    const sink = { write(b) { pending.push(b.slice()); }, patch(off, b) { header = b.slice(); } };
    const wav = new W.WavWriter(sink, {
      sampleRate: 48000, bits: p.output.bits, seed: p.seed,
      title: 'krill · ' + p.name + ' · seed ' + p.seed, software: 'krill ' + job.meta.krill,
      comment: p.name + ' pond, ' + job.meta.pitch + ', ' + job.meta.seconds + ' s, seed ' + p.seed, meta: job.meta,
    });
    const frames = job.render.frames, bytes = wav.headerSize + frames * 2 * (wav.bits / 8) + ((frames * 2 * (wav.bits / 8)) & 1);
    const CH = 4800, L = new Float32Array(CH), Rr = new Float32Array(CH);
    const ex = {
      fileName: job.fileName, base: job.fileName.replace(/\.wav$/, ''), pond: p, bytes, calls: job.score.calls.length,
      done: false, header: null, progress: 0,
      step(seconds) {
        let left = Math.max(1, Math.round((seconds || 5) * 48000));
        while (left > 0 && !job.render.done) { const n = job.render.read(L, Rr, Math.min(CH, left)); wav.write(L, Rr, n); left -= n; }
        ex.progress = job.render.progress;
        if (job.render.done && !ex.done) { wav.finish(); ex.done = true; ex.header = header; ex.stats = job.render.stats(); }
        const total = pending.reduce((a, x) => a + x.length, 0), out = new Uint8Array(total);
        let o = 0; for (const x of pending) { out.set(x, o); o += x.length; }
        pending = [];
        return out;
      },
    };
    return ex;
  }

  // a whole pond into WAV bytes in memory (Render preview)
  function pondWav(pond, opts, onProgress) {
    const ex = pondExporter(pond, opts), parts = [];
    let lastP = -1;
    while (!ex.done) {
      parts.push(ex.step(1));
      const q = Math.floor(ex.progress * 200);
      if (onProgress && q !== lastP) { lastP = q; onProgress(ex.progress); }
    }
    const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
    let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
    out.set(ex.header, 0);
    return { bytes: out, fileName: ex.fileName, stats: ex.stats, calls: ex.calls };
  }

  const api = { previewCall, spectrogram, soloWav, pondWav, pondExporter, START };
  if (inNode) module.exports = api;
  else K.preview = api;
})(typeof self !== 'undefined' ? self : this);
