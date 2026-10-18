#!/usr/bin/env node
// Print a creature's solo score as text.
// Usage: node tools/score.js <creature.json> [--seed N] [--minutes M | --seconds S] [--key "D minor" | --free] [--json]
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/creature.js');
const S = require('../src/scales.js');
const R = require('../src/roll.js');

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node tools/score.js <creature.json> [--seed N] [--minutes M | --seconds S] [--key "D minor" | --free] [--json]');
  process.exit(1);
}

const args = process.argv.slice(2);
let file = null, seed = 1, seconds = 60, pitch = { mode: 'key', root: 'D', scale: 'minor' }, json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--seed') seed = parseInt(args[++i], 10);
  else if (a === '--minutes') seconds = parseFloat(args[++i]) * 60;
  else if (a === '--seconds') seconds = parseFloat(args[++i]);
  else if (a === '--key') { try { pitch = S.parse(args[++i]); } catch (e) { usage(e.message); } }
  else if (a === '--free') pitch = { mode: 'free' };
  else if (a === '--json') json = true;
  else if (a.startsWith('--')) usage('Unknown option ' + a);
  else file = a;
}
if (!file) usage();
if (!Number.isFinite(seed) || !(seconds > 0)) usage('Seed and length must be numbers');

const { creature, warnings } = C.normalise(fs.readFileSync(file, 'utf8'));
for (const w of warnings) console.error('warning: ' + w);
const score = R.soloScore(creature, { seed, seconds, pitch });
if (json) { process.stdout.write(R.scoreToJSON(score) + '\n'); process.exit(0); }

const free = pitch.mode !== 'key';
const slot = score.slots[0];
function clock(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}
function num(v) {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a === Math.round(a) ? String(v) : v.toFixed(2);
}
const labels = slot.vary.map(k => {
  const s = C.BY_KEY[k];
  return (s.engine === slot.source ? '' : s.engine + '.') + s.id;
});
function showValue(k, v) {
  const s = C.BY_KEY[k];
  return s.options ? s.options[Math.round(v)] || num(v) : num(v);
}

const species = C.speciesLabel(slot);
console.log(slot.name + ' · ' + species + ' · seed ' + score.seed + ' · ' + score.pitch + ' · ' + clock(score.seconds));
if (slot.locked.length) console.log('locked: ' + slot.locked.map(l => (l.engine === slot.source ? l.id : l.key) + ' ' + showValue(l.key, l.value)).join(', '));
console.log('');
let units = 0;
score.calls.forEach((c, n) => {
  units += c.units.length;
  const kind = c.kind === 'copy' ? 'copy of ' + (c.of + 1) : c.kind;
  console.log(clock(c.t).padStart(7) + '  call ' + (n + 1) + '  ' + kind + '  ' + c.units.length + ' unit' + (c.units.length > 1 ? 's' : '') +
    '  atk ' + num(c.attack) + ' s  rel ' + num(c.release) + ' s' + (c.legato ? '  legato' : ''));
  for (const u of c.units) {
    const p = S.noteName(u.note, free) + (u.noteEnd !== u.note ? ' → ' + S.noteName(u.noteEnd, free) : '');
    const vals = [];
    for (let j = 0; j < labels.length; j++) {
      const a = u.v0[j], b = u.v1[j];
      vals.push(labels[j] + ' ' + showValue(slot.vary[j], a) + (u.v1 !== u.v0 && Math.abs(a - b) > 1e-3 ? '→' + showValue(slot.vary[j], b) : ''));
    }
    console.log('         ' + clock(u.t).padStart(7) + '  ' + (num(u.dur) + ' s').padEnd(7) + ' ' + p.padEnd(15) + ' ' + vals.join('  '));
  }
});
console.log('');
console.log(score.calls.length + ' calls, ' + units + ' units');
