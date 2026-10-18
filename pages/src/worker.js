// krill render worker: the engines and krill's modules are loaded before this file.
// Messages in:  { id, type: 'call' | 'signature' | 'solo', creature, pitch, seed, seconds, bits } · { id, type: 'pond', pond, seconds }
//               { id, type: 'exportStart', pond } → { fileName, base, bytes, calls } · { id, type: 'exportStep', seconds }
//               → { bytes, progress, done, header (when done), stats } · { id, type: 'exportStop' }
// Messages out: { id, type: 'progress', p } · { id, type: 'done', result } · { id, type: 'error', message }
'use strict';
let exp = null;              // the export in progress, stepped by the page so it can write as it goes
self.onmessage = e => {
  const m = e.data, K = self.Krill;
  try {
    if (m.type === 'exportStart') {
      exp = K.preview.pondExporter(m.pond);
      self.postMessage({ id: m.id, type: 'done', result: { fileName: exp.fileName, base: exp.base, bytes: exp.bytes, calls: exp.calls } });
      return;
    }
    if (m.type === 'exportStep') {
      if (!exp) throw new Error('No export running');
      const bytes = exp.step(m.seconds);
      const r = { bytes, progress: exp.progress, done: exp.done, header: exp.header, stats: exp.stats };
      if (exp.done) exp = null;
      self.postMessage({ id: m.id, type: 'done', result: r }, [bytes.buffer]);
      return;
    }
    if (m.type === 'exportStop') { exp = null; self.postMessage({ id: m.id, type: 'done', result: null }); return; }
    if (m.type === 'pond') {
      const r = K.preview.pondWav(m.pond, { seconds: m.seconds }, p => self.postMessage({ id: m.id, type: 'progress', p }));
      self.postMessage({ id: m.id, type: 'done', result: r }, [r.bytes.buffer]);
      return;
    }
    const creature = K.creature.normalise(m.creature).creature;
    if (m.type === 'call' || m.type === 'signature') {
      const r = K.preview.previewCall(creature, { pitch: m.pitch, seed: m.seed, kind: m.type });
      const spec = K.preview.spectrogram(r.L, r.R, r.sampleRate);
      r.spec = spec;
      self.postMessage({ id: m.id, type: 'done', result: r }, [r.L.buffer, r.R.buffer, spec.data.buffer]);
    } else if (m.type === 'solo') {
      const r = K.preview.soloWav(creature, { seed: m.seed, seconds: m.seconds, pitch: m.pitch, bits: m.bits },
        p => self.postMessage({ id: m.id, type: 'progress', p }));
      self.postMessage({ id: m.id, type: 'done', result: r }, [r.bytes.buffer]);
    } else throw new Error('Unknown job ' + m.type);
  } catch (err) {
    self.postMessage({ id: m.id, type: 'error', message: String((err && err.message) || err) });
  }
};
