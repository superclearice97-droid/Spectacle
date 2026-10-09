'use strict';
// Runs species classification off the main thread so live video never stalls.
const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { Model } = require('./tflite');

const MODELS = path.join(__dirname, '..', '..', 'models');
const cache = {};
function load(group) {
  if (!cache[group]) {
    cache[group] = {
      model: new Model(path.join(MODELS, `mobilenet_v2_1.0_224_inat_${group}_quant.tflite`)),
      labels: fs.readFileSync(path.join(MODELS, `inat_${group}_labels.txt`), 'utf8').split('\n').map(s => s.trim()),
    };
  }
  return cache[group];
}

parentPort.on('message', ({ id, crops, groups, topK = 3 }) => {
  try {
    const results = [];
    for (const crop of crops) {
      const rgb = new Uint8Array(crop.rgb);
      for (const g of crop.groups || groups) {
        const { model, labels } = load(g);
        const p = model.run(rgb);
        const top = [];
        for (let i = 0; i < p.length; i++) if (labels[i] && labels[i] !== 'background') top.push([p[i], i]);
        top.sort((a, b) => b[0] - a[0]);
        results.push({ crop: crop.name, group: g, background: p[labels.indexOf('background')] || 0, top: top.slice(0, topK).map(([conf, i]) => ({ label: labels[i], conf })) });
      }
    }
    parentPort.postMessage({ id, results });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
