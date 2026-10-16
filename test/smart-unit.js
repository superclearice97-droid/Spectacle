#!/usr/bin/env node
// Scenario tests for smart-detection logic (tracking, zones, linger time, parked-car suppression).
// Uses scripted detections, so it runs anywhere without the model.
'use strict';
const { EventEmitter } = require('events');
const { Tracker, inPolygon, cleanZones } = require('../server/lib/smart/tracker');
const { SmartWatch } = require('../server/lib/smart/watch');

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const box = (x, y, w = 0.08, h = 0.25) => ({ x, y, w, h });

console.log('Geometry & validation');
const drive = [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]];
ok(inPolygon(0.7, 0.7, drive) && !inPolygon(0.2, 0.7, drive), 'point-in-zone');
let threw = false; try { cleanZones([{ points: [[0, 0], [1, 1]] }]); } catch { threw = true; } ok(threw, 'zone with 2 corners rejected');
const cz = cleanZones([{ name: 'Driveway <b>', points: [[0.5, 0.5], [2, 0.5], [1, 1]], kinds: ['person', 'hacker'], dwellSec: 9999 }]);
ok(cz[0].points[1][0] === 1 && cz[0].kinds.join() === 'person' && cz[0].dwellSec === 600, 'zones clamped and cleaned');

// Drive the real SmartWatch with a fake camera + scripted detector, on a fake clock.
function scene(frames, camSmart) {
  let t = 1_000_000; const realNow = Date.now; Date.now = () => t;
  const cam = { id: 'c1', name: 'Front', smart: camSmart };
  const cams = { list: [cam], pipe: () => ({ latest: Buffer.from('x'), latestAt: t }) };
  const det = { available: true, detect: async () => null };
  const w = new SmartWatch({ smart: { fps: 2 } }, cams, det); clearInterval(w.timer);
  const alerts = [];
  w.on('alert', (c, due) => alerts.push(...due.map(d => ({ t, group: d.group, zone: d.zone.name, stayed: d.stayedSec }))));
  const s = w.on_(cam.id);
  for (const dets of frames) { t += 500; w.process(cam, s, dets, null); }
  Date.now = realNow; return alerts;
}

console.log('Scenes');
// 1) Person walks up the driveway into the zone.
const walk = Array.from({ length: 12 }, (_, i) => [{ label: 'person', score: 0.9, box: box(0.2 + i * 0.05, 0.4) }]);
let a = scene(walk, { kinds: ['person'], zones: cleanZones([{ name: 'Driveway', points: drive, kinds: ['person'] }]) });
ok(a.length === 1 && a[0].zone === 'Driveway', 'person walking into Driveway → exactly one alert');
// 2) Same walk, but zone only cares about vehicles → no alert.
a = scene(walk, { zones: cleanZones([{ name: 'Driveway', points: drive, kinds: ['vehicle'] }]) });
ok(a.length === 0, 'vehicle-only zone ignores people');
// 3) Parked car that never moves while a person walks past elsewhere.
const parked = Array.from({ length: 14 }, (_, i) => [
  { label: 'car', score: 0.95, box: box(0.6 + (i % 2) * 0.002, 0.6, 0.3, 0.2) },
  { label: 'person', score: 0.9, box: box(0.05 + i * 0.02, 0.1) },
]);
a = scene(parked, { kinds: ['vehicle'] });
ok(a.length === 0, 'parked car with someone walking past → no vehicle alert');
// 4) A car arriving does alert.
const arrive = Array.from({ length: 8 }, (_, i) => [{ label: 'car', score: 0.9, box: box(0.1 + i * 0.06, 0.6, 0.3, 0.2) }]);
a = scene(arrive, { kinds: ['vehicle'] });
ok(a.length === 1 && a[0].group === 'vehicle', 'car driving in → one vehicle alert');
// 5) Loitering: zone with 5 s linger only alerts after 5 s inside.
const loiter = [...Array.from({ length: 4 }, (_, i) => [{ label: 'person', score: 0.9, box: box(0.5 + i * 0.04, 0.55) }]),
  ...Array.from({ length: 14 }, () => [{ label: 'person', score: 0.9, box: box(0.66, 0.55) }])];
a = scene(loiter, { zones: cleanZones([{ name: 'Back door', points: drive, kinds: ['person'], dwellSec: 5 }]) });
ok(a.length === 1 && a[0].stayed >= 5, `lingering 5 s at Back door → one alert (after ${a[0] && a[0].stayed} s)`);
// 6) Brief pass-through shorter than the linger time → no alert.
a = scene(loiter.slice(0, 7), { zones: cleanZones([{ name: 'Back door', points: drive, kinds: ['person'], dwellSec: 5 }]) });
ok(a.length === 0, 'walking through quickly → no linger alert');
// 7) A single low-confidence flicker never alerts.
a = scene([[{ label: 'person', score: 0.4, box: box(0.7, 0.6) }], [], [{ label: 'person', score: 0.45, box: box(0.1, 0.1) }]], { kinds: ['person'] });
ok(a.length === 0, 'low-confidence flickers ignored');
// 8) Tracker keeps identity through a missed frame.
const tr = new Tracker({ maxAgeMs: 3000 });
tr.update([{ label: 'person', score: 0.9, box: box(0.1, 0.1) }], 0, []);
tr.update([], 500, []);
const t3 = tr.update([{ label: 'person', score: 0.9, box: box(0.13, 0.1) }], 1000, []);
ok(t3.length === 1 && t3[0].hits === 2, 'same person kept through a missed frame');

console.log(fails ? `\n${fails} failed` : '\nAll smart-detection logic checks passed.');
process.exit(fails ? 1 : 0);
