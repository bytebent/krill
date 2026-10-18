// krill player: an AudioWorklet that renders a pond live, or runs it silently next to a WAV.
// The engines and krill's modules are loaded before this file (as one module, with self = globalThis).
//
// Messages in:   { type: 'load', pond, seconds, mode: 'live' | 'wav' } · { type: 'play' } · { type: 'pause' }
//                { type: 'sync', t }  (wav mode: where the WAV is, in seconds)
// Messages out:  { type: 'ready', frames } · { type: 'error', message } · { type: 'ended' }
//                { type: 'scope', frame, slots: [slot index per voice], data: Float32Array(voices × SCOPE) }
//
// Scopes: each voice taps its own mono signal (after its gain and the call's loudness, before
// pan) into a ring of blocks; every SEND frames the last SCOPE samples of each voice go out.
// A voice that was asleep for a block gives zeros there, so silence shows as nothing.
'use strict';
const SCOPE = 512, SEND = 1024, RING = 32;      // RING blocks of 32 samples = 1024
const MAX_CATCH_UP = 48000 * 0.25;              // wav mode: frames rendered per callback at most
const RESEEK = 1.5;                             // wav mode: seek when this many seconds off

class KrillPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.job = null; this.playing = false; this.mode = 'live';
    this.frame = 0; this.sinceSend = 0; this.target = 0;
    this.port.onmessage = e => { try { this.msg(e.data); } catch (err) { this.port.postMessage({ type: 'error', message: String((err && err.message) || err) }); } };
  }
  msg(m) {
    const K = globalThis.Krill;
    if (m.type === 'load') {
      this.job = K.mixer.pondRender(m.pond, { seconds: m.seconds, sampleRate });
      this.mode = m.mode || 'live';
      this.frame = 0; this.target = 0; this.playing = false;
      this.scratchL = new Float32Array(4800); this.scratchR = new Float32Array(4800);
      // the voices are made for the slots that hold a creature, in slot order
      this.slots = []; this.job.score.slots.forEach((s, i) => { if (s) this.slots.push(i); });
      this.rings = this.job.render.voices.map(v => {
        const r = { buf: new Float32Array(RING * 32), stamp: new Int32Array(RING).fill(-1) };
        v.tap = (b, src, g) => { const k = b % RING, o = k * 32; for (let i = 0; i < 32; i++) r.buf[o + i] = src[i] * g; r.stamp[k] = b; };
        return r;
      });
      this.port.postMessage({ type: 'ready', frames: this.job.render.frames });
    } else if (m.type === 'play') this.playing = true;
    else if (m.type === 'pause') this.playing = false;
    else if (m.type === 'sync') this.target = Math.round(m.t * sampleRate);
  }
  send() {
    const r = this.job.render, last = r.b - 1, n = this.rings.length, data = new Float32Array(n * SCOPE), nb = SCOPE / 32;
    this.rings.forEach((ring, v) => {
      for (let k = 0; k < nb; k++) {
        const b = last - nb + 1 + k;
        if (b < 0 || ring.stamp[b % RING] !== b) continue;
        data.set(ring.buf.subarray((b % RING) * 32, (b % RING) * 32 + 32), v * SCOPE + k * 32);
      }
    });
    this.port.postMessage({ type: 'scope', frame: this.frame, slots: this.slots, data }, [data.buffer]);
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    if (!this.job || !this.playing) return true;
    const r = this.job.render;
    if (this.mode === 'live') {
      if (r.done) { this.playing = false; this.port.postMessage({ type: 'ended' }); return true; }
      const got = r.read(L, R, n);
      if (got < n) { L.fill(0, got); R.fill(0, got); }
      this.frame += got;
    } else {                                     // silent: follow the WAV for the pictures
      const off = this.target - this.frame;
      if (Math.abs(off) > RESEEK * sampleRate) { r.seek(this.target); this.frame = r.pos; }
      else {
        let left = Math.min(off, MAX_CATCH_UP);
        while (left > 0 && !r.done) { const k = r.read(this.scratchL, this.scratchR, Math.min(left, 4800)); if (!k) break; left -= k; this.frame += k; }
      }
    }
    this.sinceSend += n;
    if (this.sinceSend >= SEND) { this.sinceSend = 0; this.send(); }
    return true;
  }
}
registerProcessor('krill-player', KrillPlayer);
