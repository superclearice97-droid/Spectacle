'use strict';
// Follows detected objects from frame to frame (so "a person has been at the door for 40 seconds" works),
// and decides when an object in a zone should raise an alert. Pure logic: no I/O, easy to test.
const { groupOf } = require('./coco');

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
};

/** Ray-casting point-in-polygon. Points are normalised 0..1 [[x,y],...]. */
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Where an object "is" for zone purposes: its feet/wheels (bottom centre), which is what a drawn area on the ground means. */
const anchor = b => [b.x + b.w / 2, Math.min(1, b.y + b.h * 0.95)];

const WHOLE = { id: 'all', name: 'anywhere', points: null };

class Tracker {
  /** @param opts.maxAgeMs drop a track not seen for this long. */
  constructor({ maxAgeMs = 4000 } = {}) { this.maxAgeMs = maxAgeMs; this.tracks = []; this.n = 0; }

  /**
   * dets: [{label, score, box:{x,y,w,h} normalised}], zones: camera zones (may be empty = whole picture).
   * Returns the current tracks (each with .zonesSince {zoneId: ms}).
   */
  update(dets, now, zones) {
    const zs = zones && zones.length ? zones : [WHOLE];
    const used = new Set();
    // Greedy match, best overlaps first, only within the same group (a person never "becomes" a car).
    const pairs = [];
    for (let ti = 0; ti < this.tracks.length; ti++) for (let di = 0; di < dets.length; di++) {
      const t = this.tracks[ti], d = dets[di];
      if (groupOf(t.label) !== groupOf(d.label)) continue;
      const o = iou(t.box, d.box);
      // Small/fast things may not overlap between frames; allow a near centre jump too.
      const near = Math.hypot((t.box.x + t.box.w / 2) - (d.box.x + d.box.w / 2), (t.box.y + t.box.h / 2) - (d.box.y + d.box.h / 2)) < Math.max(t.box.w, t.box.h) * 0.75;
      if (o > 0.2 || near) pairs.push([o + (near ? 0.05 : 0), ti, di]);
    }
    pairs.sort((a, b) => b[0] - a[0]);
    const matchedT = new Set();
    for (const [, ti, di] of pairs) {
      if (matchedT.has(ti) || used.has(di)) continue;
      matchedT.add(ti); used.add(di);
      const t = this.tracks[ti], d = dets[di];
      t.box = d.box; t.score = Math.max(t.score * 0.7, d.score); t.label = d.score >= t.labelScore ? d.label : t.label;
      t.labelScore = Math.max(t.labelScore, d.score); t.lastSeen = now; t.hits++;
    }
    for (let di = 0; di < dets.length; di++) if (!used.has(di)) {
      const d = dets[di];
      this.tracks.push({ id: ++this.n, label: d.label, labelScore: d.score, score: d.score, box: d.box, firstSeen: now, lastSeen: now, hits: 1, zonesSince: {}, alerted: {} });
    }
    this.tracks = this.tracks.filter(t => now - t.lastSeen <= this.maxAgeMs);
    for (const t of this.tracks) {
      if (t.lastSeen !== now) continue; // not visible right now: keep its zone timers but don't extend them
      const [ax, ay] = anchor(t.box);
      for (const z of zs) {
        const inside = !z.points || inPolygon(ax, ay, z.points);
        if (inside && t.zonesSince[z.id] == null) t.zonesSince[z.id] = now;
        if (!inside) delete t.zonesSince[z.id];
      }
    }
    return this.tracks;
  }

  /**
   * Which (track, zone) pairs should alert now. kinds = groups the camera alerts on when it has no zones.
   * Each track alerts at most once per zone.
   */
  due(now, zones, { kinds = ['person'], minScore = 0.5, minHits = 2 } = {}) {
    const zs = zones && zones.length ? zones : [{ ...WHOLE, kinds, dwellSec: 0 }];
    const out = [];
    for (const t of this.tracks) {
      if (t.lastSeen !== now || t.hits < minHits || t.score < minScore) continue;
      const g = groupOf(t.label);
      for (const z of zs) {
        const since = t.zonesSince[z.id];
        if (since == null || t.alerted[z.id]) continue;
        if (!(z.kinds || kinds).includes(g)) continue;
        if (now - since < (z.dwellSec || 0) * 1000) continue;
        t.alerted[z.id] = now;
        out.push({ track: t, zone: z, group: g, stayedSec: Math.round((now - since) / 1000) });
      }
    }
    return out;
  }

  get active() { return this.tracks.length > 0; }
}

/** Validates zones coming from the app. Returns a clean copy or throws a friendly error. */
function cleanZones(zones) {
  if (!Array.isArray(zones)) return [];
  if (zones.length > 8) throw new Error('Up to 8 zones per camera');
  const KINDS = ['person', 'vehicle', 'animal', 'package'];
  return zones.map((z, i) => {
    const pts = Array.isArray(z.points) ? z.points : [];
    if (pts.length < 3 || pts.length > 16) throw new Error('Each zone needs 3 to 16 corners');
    const points = pts.map(p => {
      const x = +p[0], y = +p[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Bad zone corner');
      return [Math.min(1, Math.max(0, +x.toFixed(4))), Math.min(1, Math.max(0, +y.toFixed(4)))];
    });
    const kinds = (Array.isArray(z.kinds) ? z.kinds : ['person']).filter(k => KINDS.includes(k));
    return {
      id: /^[\w-]{1,24}$/.test(z.id || '') ? z.id : 'z' + (i + 1) + Math.random().toString(36).slice(2, 6),
      name: String(z.name || `Zone ${i + 1}`).trim().slice(0, 30) || `Zone ${i + 1}`,
      points, kinds: kinds.length ? kinds : ['person'],
      dwellSec: Math.max(0, Math.min(600, Math.round(+z.dwellSec || 0))),
    };
  });
}

module.exports = { Tracker, inPolygon, iou, anchor, cleanZones };
