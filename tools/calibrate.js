#!/usr/bin/env node
// Measures how loud each species' default creature is at Level 0 (RMS while calling, and peak),
// before calibration, and prints the CALIBRATION_DB values for src/voice.js.
// Usage: node tools/calibrate.js [renders per species]
'use strict';
const C = require('../src/creature.js');
const M = require('../src/mixer.js');
const V = require('../src/voice.js');

const TARGET = -20;                  // dBFS RMS while calling
const MEASURE = 30;                  // render this far down so nothing clips, then add it back
const runs = parseInt(process.argv[2], 10) || 6;
const out = {};
for (const source of ['throat', 'dolphin']) for (const mouth of [false, true]) {
  const sp = source + (mouth ? '+tube' : '');
  let e = 0, n = 0, pk = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const c = C.defaults(source, mouth, { seed });
    c.manner.level = 0; c.manner.pan = 0; c.manner.wander = 0;
    const job = M.soloRender(c, { seed, seconds: 90, pitch: { mode: 'free' }, fadeIn: 0, fadeOut: 0, level: -MEASURE });
    job.render.lim.ceil = 0;                                     // 30 dB down: nothing is limited or clamped
    const L = new Float32Array(4800), R = new Float32Array(4800);
    while (!job.render.done) {
      const k = job.render.read(L, R, 4800);
      for (let i = 0; i < k; i++) {
        const x = (L[i] + R[i]) * Math.SQRT1_2 * Math.pow(10, MEASURE / 20);   // undo centre pan and the trim
        if (x !== 0) { e += x * x; n++; }
        const a = Math.abs(x); if (a > pk) pk = a;
      }
    }
  }
  const rms = 10 * Math.log10(e / Math.max(1, n));
  const now = V.CALIBRATION_DB[sp] || 0;
  out[sp] = Math.round((TARGET - (rms - now)) * 10) / 10;
  console.log(sp.padEnd(14) + 'rms ' + rms.toFixed(1).padStart(6) + ' dB   peak ' + (20 * Math.log10(pk)).toFixed(1).padStart(6) + ' dB   (current calibration ' + now + ')');
}
console.log('\nCALIBRATION_DB = ' + JSON.stringify(out).replace(/"(\w+)":/g, "$1: ").replace(/"/g, "'").replace(/,/g, ', '));
