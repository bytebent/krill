/*
 * krill · streaming WAV writer
 *
 * PCM, 16- or 24-bit, stereo. Writes through a sink, so the same code streams to disk in Node
 * and builds a Blob in the browser:
 *   sink.write(Uint8Array)              append bytes
 *   sink.patch(offset, Uint8Array)      overwrite bytes already written (header sizes at the end)
 *
 * The header carries a LIST/INFO chunk (title, software, comment) and a 'krll' chunk with JSON
 * describing exactly what made the file (seed, settings, creature or pond, engine commits).
 * Both come before the data, so the header has a fixed size and only the sizes are patched.
 * 16-bit output uses seeded TPDF dither, so it is repeatable too.
 *
 * Works in the browser (Krill.wav) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports;
  const K = inNode ? null : (root.Krill = root.Krill || {});
  const { Rng, hash, tag } = inNode ? require('./rng.js') : K.rng;

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return Uint8Array.from(Buffer.from(str, 'utf8'));
  }
  function chunk(id, body) {               // id (4 chars) + size + body + pad to even
    const pad = body.length & 1;
    const out = new Uint8Array(8 + body.length + pad);
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  }
  function zstr(s) { const b = utf8(s); const o = new Uint8Array(b.length + 1); o.set(b); return o; }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  class WavWriter {
    // opts: { sampleRate, bits (16|24), channels (2), title, comment, meta (object → 'krll' JSON), seed }
    constructor(sink, opts) {
      this.sink = sink;
      this.sr = opts.sampleRate;
      this.bits = opts.bits === 16 ? 16 : 24;
      this.ch = opts.channels || 2;
      this.bps = this.bits / 8;
      this.frames = 0;
      this.dither = this.bits === 16 ? new Rng(hash(opts.seed >>> 0, tag('dither'))) : null;
      const info = [utf8('INFO')];
      if (opts.title) info.push(chunk('INAM', zstr(opts.title)));
      info.push(chunk('ISFT', zstr(opts.software || 'krill')));
      if (opts.comment) info.push(chunk('ICMT', zstr(opts.comment)));
      this.extra = concat([chunk('LIST', concat(info)), opts.meta ? chunk('krll', utf8(JSON.stringify(opts.meta))) : new Uint8Array(0)]);
      this.headerSize = 12 + 24 + this.extra.length + 8;
      this.buf = new Uint8Array(0);
      sink.write(this.header(0));
    }
    header(dataBytes) {
      const h = new Uint8Array(this.headerSize), v = new DataView(h.buffer);
      const w4 = (o, s) => { for (let i = 0; i < 4; i++) h[o + i] = s.charCodeAt(i); };
      w4(0, 'RIFF'); v.setUint32(4, this.headerSize - 8 + dataBytes + (dataBytes & 1), true); w4(8, 'WAVE');
      w4(12, 'fmt '); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, this.ch, true);
      v.setUint32(24, this.sr, true); v.setUint32(28, this.sr * this.ch * this.bps, true);
      v.setUint16(32, this.ch * this.bps, true); v.setUint16(34, this.bits, true);
      h.set(this.extra, 36);
      const d = 36 + this.extra.length;
      w4(d, 'data'); v.setUint32(d + 4, dataBytes, true);
      return h;
    }
    // interleave and convert n frames (floats in -1..1)
    write(L, R, n) {
      const need = n * this.ch * this.bps;
      if (this.buf.length < need) this.buf = new Uint8Array(need);
      const b = this.buf;
      let o = 0;
      if (this.bits === 24) {
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < 2; c++) {
            let x = (c ? R[i] : L[i]) * 8388607;
            x = x > 8388607 ? 8388607 : x < -8388608 ? -8388608 : Math.round(x);
            b[o++] = x & 255; b[o++] = (x >> 8) & 255; b[o++] = (x >> 16) & 255;
          }
        }
      } else {
        const d = this.dither;
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < 2; c++) {
            let x = (c ? R[i] : L[i]) * 32767 + (d.next() - d.next());
            x = x > 32767 ? 32767 : x < -32768 ? -32768 : Math.round(x);
            b[o++] = x & 255; b[o++] = (x >> 8) & 255;
          }
        }
      }
      this.sink.write(b.subarray(0, need));
      this.frames += n;
    }
    finish() {
      const bytes = this.frames * this.ch * this.bps;
      if (bytes & 1) this.sink.write(new Uint8Array(1));
      this.sink.patch(0, this.header(bytes));
      return bytes + this.headerSize;
    }
  }

  // read back the parts tests and tools care about
  function parse(u8) {
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const id = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (id(0) !== 'RIFF' || id(8) !== 'WAVE') throw new Error('Not a WAV file');
    const out = { riffSize: v.getUint32(4, true), chunks: {} };
    let o = 12;
    while (o + 8 <= u8.length) {
      const cid = id(o), size = v.getUint32(o + 4, true);
      out.chunks[cid] = { offset: o + 8, size };
      if (cid === 'fmt ') {
        out.format = v.getUint16(o + 8, true); out.channels = v.getUint16(o + 10, true);
        out.sampleRate = v.getUint32(o + 12, true); out.bits = v.getUint16(o + 22, true);
      }
      if (cid === 'krll') out.meta = JSON.parse(new TextDecoder().decode(u8.subarray(o + 8, o + 8 + size)));
      o += 8 + size + (size & 1);
    }
    if (out.chunks.data) out.frames = out.chunks.data.size / (out.channels * out.bits / 8);
    return out;
  }

  // sink that collects into memory (browser previews, tests)
  function memorySink() {
    const parts = [];
    let size = 0;
    return {
      write(b) { parts.push(b.slice()); size += b.length; },
      patch(off, b) {
        let o = 0;
        for (const p of parts) {
          if (off < o + p.length) { const k = off - o; p.set(b.subarray(0, Math.min(b.length, p.length - k)), k); return; }
          o += p.length;
        }
      },
      bytes() { return concat(parts); },
      parts, get size() { return size; },
    };
  }

  const api = { WavWriter, parse, memorySink };
  if (inNode) module.exports = api;
  else K.wav = api;
})(typeof self !== 'undefined' ? self : this);
