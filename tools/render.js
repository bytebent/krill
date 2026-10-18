#!/usr/bin/env node
// Render a creature on its own to a WAV file.
// Usage: node tools/render.js <creature.json> [--seed N] [--minutes M | --seconds S] [--key "D minor" | --free]
//                             [--bits 16|24] [--level dB] [--fade-in S] [--fade-out S] [--out file.wav]
// The WAV streams to disk in chunks, so any length works.
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/creature.js');
const S = require('../src/scales.js');
const M = require('../src/mixer.js');
const { WavWriter } = require('../src/wav.js');

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node tools/render.js <creature.json> [--seed N] [--minutes M | --seconds S] [--key "D minor" | --free]\n' +
    '                            [--bits 16|24] [--level dB] [--fade-in S] [--fade-out S] [--out file.wav]');
  process.exit(1);
}

const args = process.argv.slice(2);
const o = { seed: 1, seconds: 60, pitch: { mode: 'key', root: 'D', scale: 'minor' }, bits: 24, level: 0 };
let file = null, out = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => { if (i + 1 >= args.length) usage(a + ' needs a value'); return args[++i]; };
  if (a === '--seed') o.seed = parseInt(next(), 10);
  else if (a === '--minutes') o.seconds = parseFloat(next()) * 60;
  else if (a === '--seconds') o.seconds = parseFloat(next());
  else if (a === '--key') { try { o.pitch = S.parse(next()); } catch (e) { usage(e.message); } }
  else if (a === '--free') o.pitch = { mode: 'free' };
  else if (a === '--bits') o.bits = parseInt(next(), 10);
  else if (a === '--level') o.level = parseFloat(next());
  else if (a === '--fade-in') o.fadeIn = parseFloat(next());
  else if (a === '--fade-out') o.fadeOut = parseFloat(next());
  else if (a === '--out') out = next();
  else if (a.startsWith('--')) usage('Unknown option ' + a);
  else file = a;
}
if (!file) usage();
if (!Number.isFinite(o.seed) || !(o.seconds > 0) || ![16, 24].includes(o.bits)) usage('Check --seed, the length and --bits');

const { creature, warnings } = C.normalise(fs.readFileSync(file, 'utf8'));
for (const w of warnings) console.error('warning: ' + w);

const job = M.soloRender(creature, o);
if (!out) { fs.mkdirSync('renders', { recursive: true }); out = path.join('renders', job.fileName); }
const fd = fs.openSync(out, 'w');
const sink = {
  write(b) { fs.writeSync(fd, b); },
  patch(off, b) { fs.writeSync(fd, b, 0, b.length, off); },
};
const wav = new WavWriter(sink, {
  sampleRate: 48000, bits: o.bits, seed: o.seed,
  title: 'krill · ' + creature.name + ' · seed ' + o.seed,
  software: 'krill ' + job.meta.krill,
  comment: creature.name + ' solo, ' + job.meta.pitch + ', ' + o.seconds + ' s, seed ' + o.seed,
  meta: job.meta,
});

const CH = 48000;
const L = new Float32Array(CH), R = new Float32Array(CH);
const t0 = Date.now();
let lastShown = -1;
const tty = process.stderr.isTTY;
while (!job.render.done) {
  const n = job.render.read(L, R, CH);
  wav.write(L, R, n);
  const pct = Math.floor(job.render.progress * 100);
  if (tty && pct !== lastShown) { process.stderr.write('\rrendering ' + pct + '%'); lastShown = pct; }
}
const bytes = wav.finish();
fs.closeSync(fd);
const secs = (Date.now() - t0) / 1000;
const st = job.render.stats();
if (tty) process.stderr.write('\r');
console.log(out);
console.log('  ' + creature.name + ' · ' + job.meta.pitch + ' · seed ' + o.seed + ' · ' + o.seconds + ' s · ' + job.score.calls.length + ' calls');
console.log('  rendered in ' + secs.toFixed(1) + ' s (' + (o.seconds / secs).toFixed(1) + '× real time), voice awake ' + (st.awake[0] * 100).toFixed(0) + '% of the time');
console.log('  peak ' + st.peakDb.toFixed(1) + ' dBFS before the limiter, limiter max ' + st.maxReductionDb.toFixed(1) + ' dB · ' + (bytes / 1048576).toFixed(1) + ' MB');
console.log('  engine headroom: peak ' + st.enginePeakDb[0].toFixed(1) + ' dB inside the engine' + (st.enginePeakDb[0] > -1 ? ' · WARNING: near the engine\'s clamp' : ''));
