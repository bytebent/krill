// Tiny test harness: test(name, fn) collects, run() executes in order and reports.
'use strict';
const assert = require('node:assert/strict');

const tests = [];
function test(name, fn) { tests.push({ name, fn, file: currentFile }); }
let currentFile = '';
function setFile(f) { currentFile = f; }

async function run(filter) {
  let pass = 0, fail = 0, lastFile = '';
  const t0 = Date.now();
  for (const t of tests) {
    if (filter && !(t.file + ' ' + t.name).includes(filter)) continue;
    if (t.file !== lastFile) { console.log('\n' + t.file); lastFile = t.file; }
    const s = Date.now();
    try {
      await t.fn();
      pass++;
      console.log('  ok   ' + t.name + ' (' + (Date.now() - s) + ' ms)');
    } catch (e) {
      fail++;
      console.log('  FAIL ' + t.name);
      console.log('       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       '));
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + (Date.now() - t0) + ' ms');
  return fail;
}

module.exports = { test, run, setFile, assert };
