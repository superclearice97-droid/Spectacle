#!/usr/bin/env node
// Checks that the bundled species models and label files match models/SHA256SUMS,
// so an accidental or malicious change to a committed binary fails CI.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.join(__dirname, '..', 'models');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map(l => l.split(/\s+/));
console.log('Bundled model integrity');
for (const [hash, name] of sums) ok(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex') === hash, name);
const listed = new Set(sums.map(s => s[1]));
const extra = fs.readdirSync(dir).filter(f => /\.(tflite|onnx|bin)$/.test(f) && !listed.has(f));
ok(extra.length === 0, 'no unlisted model files' + (extra.length ? ': ' + extra.join(', ') : ''));
process.exit(fails ? 1 : 0);
