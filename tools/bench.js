#!/usr/bin/env node
// Render speed per example creature, so speed regressions show up.
// Usage: node tools/bench.js [seconds]   (default 120 s of each, D minor, seed 1)
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/creature.js');
const M = require('../src/mixer.js');

const seconds = parseFloat(process.argv[2]) || 120;
const dir = path.join(__dirname, '..', 'examples', 'creatures');
const L = new Float32Array(4800), R = new Float32Array(4800);
console.log('creature'.padEnd(12) + 'species'.padEnd(16) + 'awake'.padStart(7) + 'x real time'.padStart(13) + '  ms per awake second');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.krill-creature.json')).sort()) {
  const c = C.normalise(fs.readFileSync(path.join(dir, f), 'utf8')).creature;
  const job = M.soloRender(c, { seed: 1, seconds, pitch: { mode: 'key', root: 'D', scale: 'minor' } });
  const t = process.hrtime.bigint();
  while (!job.render.done) job.render.read(L, R, 4800);
  const s = Number(process.hrtime.bigint() - t) / 1e9;
  const awake = job.render.stats().awake[0];
  console.log(c.name.padEnd(12) + (c.source + (c.mouth ? ' + tube' : '')).padEnd(16) + ((awake * 100).toFixed(0) + '%').padStart(7) +
    (seconds / s).toFixed(1).padStart(13) + '  ' + (s * 1000 / (seconds * awake)).toFixed(1).padStart(8));
}
