#!/usr/bin/env node
// Render a pond, or a creature on its own, to a WAV file.
// Usage: node tools/render.js <pond.json | creature.json> [--seed N] [--minutes M | --seconds S] [--key "D minor" | --free]
//                             [--bits 16|24] [--level dB] [--fade-in S] [--fade-out S] [--out file.wav]
// The WAV streams to disk in chunks, so any length works. For a pond, the pond file's own seed, key,
// length, bits, level and fades are used unless an option overrides them.
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/creature.js');
const S = require('../src/scales.js');
const M = require('../src/mixer.js');
const PD = require('../src/pond.js');
const { WavWriter } = require('../src/wav.js');

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node tools/render.js <pond.json | creature.json> [--seed N] [--minutes M | --seconds S] [--key "D minor" | --free]\n' +
    '                            [--bits 16|24] [--level dB] [--fade-in S] [--fade-out S] [--out file.wav]');
  process.exit(1);
}

const args = process.argv.slice(2);
const o = { seed: 1, seconds: 60, pitch: { mode: 'key', root: 'D', scale: 'minor' }, bits: 24, level: 0 };
let file = null, out = null;
const given = new Set();
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => { if (i + 1 >= args.length) usage(a + ' needs a value'); return args[++i]; };
  if (a.startsWith('--')) given.add(a === '--minutes' ? '--seconds' : a === '--free' ? '--key' : a);
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

const text = fs.readFileSync(file, 'utf8');
let isPond = false;
try { isPond = JSON.parse(text).format === PD.FORMAT; } catch (e) { usage(file + ' is not JSON'); }
let job, name;
if (isPond) {
  const r = PD.normalise(text);
  for (const w of r.warnings) console.error('warning: ' + w);
  const pond = r.pond;
  if (given.has('--seed')) pond.seed = o.seed;
  if (given.has('--key')) pond.pitch = Object.assign({ harmonise: pond.pitch.harmonise }, o.pitch);
  if (given.has('--bits')) pond.output.bits = o.bits;
  if (given.has('--level')) pond.output.level = o.level;
  if (given.has('--fade-in')) pond.output.fadeIn = o.fadeIn;
  if (given.has('--fade-out')) pond.output.fadeOut = o.fadeOut;
  if (given.has('--seconds')) pond.output.minutes = o.seconds / 60;
  o.seed = pond.seed; o.bits = pond.output.bits; o.seconds = pond.output.minutes * 60;
  job = M.pondRender(pond);
  name = pond.name;
} else {
  const r = C.normalise(text);
  for (const w of r.warnings) console.error('warning: ' + w);
  job = M.soloRender(r.creature, o);
  name = r.creature.name;
}
if (!out) { fs.mkdirSync('renders', { recursive: true }); out = path.join('renders', job.fileName); }
const fd = fs.openSync(out, 'w');
const sink = {
  write(b) { fs.writeSync(fd, b); },
  patch(off, b) { fs.writeSync(fd, b, 0, b.length, off); },
};
const wav = new WavWriter(sink, {
  sampleRate: 48000, bits: o.bits, seed: o.seed,
  title: 'krill · ' + name + ' · seed ' + o.seed,
  software: 'krill ' + job.meta.krill,
  comment: name + (isPond ? ' pond' : ' solo') + ', ' + job.meta.pitch + ', ' + o.seconds + ' s, seed ' + o.seed,
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
console.log('  ' + name + ' · ' + job.meta.pitch + ' · seed ' + o.seed + ' · ' + o.seconds + ' s · ' + job.score.calls.length + ' calls');
console.log('  rendered in ' + secs.toFixed(1) + ' s (' + (o.seconds / secs).toFixed(1) + '× real time), voices awake ' + st.awake.map(a => (a * 100).toFixed(0) + '%').join(' ') + ' of the time');
console.log('  peak ' + st.peakDb.toFixed(1) + ' dBFS before the limiter, limiter max ' + st.maxReductionDb.toFixed(1) + ' dB · ' + (bytes / 1048576).toFixed(1) + ' MB');
const worst = Math.max(...st.enginePeakDb);
console.log('  engine headroom: peak ' + worst.toFixed(1) + ' dB inside the engines' + (worst > -1 ? ' · WARNING: near an engine\'s clamp' : ''));
const lim = st.voiceLimitDb.map((d, i) => d > 0 ? 'lane ' + (i + 1) + ' −' + d.toFixed(1) + ' dB' : null).filter(Boolean);
console.log('  creature limiters: ' + (lim.length ? lim.join(', ') : 'idle') + (st.badBlocks ? ' · WARNING: ' + st.badBlocks + ' blocks silenced (NaN or Infinity from an engine)' : ''));
