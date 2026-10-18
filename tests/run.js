// Runs every tests/*-test.js. Usage: node tests/run.js [filter]
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('-test.js')).sort();
for (const f of files) { h.setFile(f); require(path.join(__dirname, f)); }
h.run(process.argv[2]).then(fail => { process.exitCode = fail ? 1 : 0; });
