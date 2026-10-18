#!/usr/bin/env node
// Builds the self-contained pages in pages/ from pages/src, the vendored engines and src/.
// Each page is one HTML file that works opened straight from disk (the render worker is
// started from inlined code, so no server is needed).
// Usage: node tools/build-pages.js        tests/pages-test.js checks the built files are current.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const js = files => files.map(f => '// ---- ' + f + '\n' + read(f)).join('\n').replace(/<\/script/gi, '<\\/script');

const ENGINES = ['vendor/throat-engine.js', 'vendor/dolphin-engine.js', 'vendor/mouth-tube.js'];
const CORE = ['src/rng.js', 'src/scales.js', 'src/parts.js', 'src/creature.js', 'src/roll.js', 'src/engines.js', 'src/version.js',
  'src/voice.js', 'src/pond.js', 'src/conductor.js', 'src/mixer.js', 'src/wav.js', 'src/preview.js'];

function examples() {
  const dir = path.join(ROOT, 'examples', 'creatures');
  const list = fs.readdirSync(dir).filter(f => f.endsWith('.krill-creature.json')).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  return 'window.KRILL_EXAMPLES = ' + JSON.stringify(list) + ';\n';
}

function buildCreature() {
  const worker = js(ENGINES.concat(CORE, ['pages/src/worker.js']));
  const main = examples() + js(['vendor/mouth-tube.js', 'src/rng.js', 'src/scales.js', 'src/parts.js', 'src/creature.js', 'pages/src/kit.js', 'pages/src/creature-page.js']);
  return read('pages/src/creature.html')
    .replace('/*KIT_CSS*/', () => read('pages/src/kit.css'))
    .replace('/*WORKER*/', () => worker)
    .replace('/*MAIN*/', () => main);
}

function buildPond() {
  const worker = js(ENGINES.concat(CORE, ['pages/src/worker.js']));
  const pondEx = fs.readFileSync(path.join(ROOT, 'examples', 'ponds', 'first-pond.krill-pond.json'), 'utf8');
  const main = examples() + 'window.KRILL_POND_EXAMPLE = ' + JSON.stringify(JSON.parse(pondEx)) + ';\n' +
    js(['src/rng.js', 'src/scales.js', 'src/parts.js', 'src/creature.js', 'src/roll.js', 'src/pond.js', 'src/conductor.js', 'pages/src/kit.js', 'pages/src/pond-page.js']);
  return read('pages/src/pond.html')
    .replace('/*KIT_CSS*/', () => read('pages/src/kit.css'))
    .replace('/*WORKER*/', () => worker)
    .replace('/*MAIN*/', () => main);
}

const PAGES = { 'pages/creature.html': buildCreature, 'pages/pond.html': buildPond };

if (require.main === module) {
  for (const out in PAGES) {
    const html = PAGES[out]();
    fs.writeFileSync(path.join(ROOT, out), html);
    console.log(out + '  ' + (html.length / 1024).toFixed(0) + ' kB');
  }
}
module.exports = { PAGES };
