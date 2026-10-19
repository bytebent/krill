// The safety limiter at the end of each creature's chain (krill-birds-v1).
'use strict';
const { test, assert } = require('./harness');
const C = require('../src/creature.js');
const M = require('../src/mixer.js');
const { VOICE_CEIL_DB } = require('../src/voice.js');

const CEIL = Math.pow(10, VOICE_CEIL_DB / 20);
function voiceOf(source, body, level) {
  const c = C.defaults(source, body, { seed: 3 });
  c.manner.level = level; c.manner.pan = 0; c.manner.wander = 0;
  return M.soloRender(c, { seed: 3, seconds: 20, pitch: { mode: 'free' }, fadeIn: 0, fadeOut: 0 }).render;
}
// run a render's voice and return the loudest sample it sent to the mix (centre pan: undo the -3 dB)
function voicePeak(render) {
  const v = render.voices[0], L = new Float32Array(32), R = new Float32Array(32);
  let pk = 0;
  for (let b = 0; !v.done || b < 200; b++) {
    L.fill(0); R.fill(0);
    if (v.block(b, L, R)) for (let i = 0; i < 32; i++) pk = Math.max(pk, Math.abs(L[i]) * Math.SQRT2, Math.abs(R[i]) * Math.SQRT2);
    if (b > 48000 * 25 / 32) break;
  }
  return { pk, red: v.limMaxDb };
}

test('limiter: a creature driven far too hot never passes its ceiling', () => {
  for (const sp of [['syrinx', 'tube'], ['throat', 'beak'], ['dolphin', 'none']]) {
    const { pk, red } = voicePeak(voiceOf(sp[0], sp[1], 6));
    // level +6 on top of calibration puts these well over the ceiling unlimited
    assert.ok(pk <= CEIL * 1.0001, sp.join('+') + ' peak ' + (20 * Math.log10(pk)).toFixed(2) + ' dB');
    assert.ok(red > 0, sp.join('+') + ' the limiter acted');
  }
});

test('limiter: at normal levels it does nothing', () => {
  const { pk, red } = voicePeak(voiceOf('syrinx', 'none', -6));
  assert.equal(red, 0, 'no gain reduction');
  assert.ok(pk < CEIL, 'peak ' + (20 * Math.log10(pk)).toFixed(1) + ' dB');
});

test('limiter: a block with NaN or Infinity is silenced and counted', () => {
  const v = voiceOf('throat', 'none', -6).voices[0];
  const blk = new Float32Array(32).fill(0.1); blk[7] = NaN;
  v.limit(blk, 1);
  assert.ok(blk.every(x => x === 0));
  const inf = new Float32Array(32).fill(0.1); inf[3] = Infinity;
  v.limit(inf, 1);
  assert.ok(inf.every(x => x === 0));
  assert.equal(v.badBlocks, 2);
});

test('limiter: it comes back to unity after a loud block', () => {
  const v = voiceOf('throat', 'none', -6).voices[0];
  const loud = new Float32Array(32).fill(1);
  v.limit(loud, 1);
  assert.ok(Math.abs(loud[0] - CEIL) < 1e-6, 'held at the ceiling');
  const q = new Float32Array(32);
  for (let k = 0; k < 2000; k++) { q.fill(0.01); v.limit(q, 1); }
  assert.equal(v.limG, 1);
  assert.ok(Math.abs(q[31] - 0.01) < 1e-9, 'quiet block untouched again');
});
