'use strict';
// Decides when to look (only while something moves, or someone is watching live), runs the detector,
// follows objects, and turns "a person entered the Driveway zone" into an alert.
const { EventEmitter } = require('events');
const { Tracker, iou } = require('./tracker');
const { groupOf } = require('./coco');

const DEFAULTS = { enabled: true, kinds: ['person', 'vehicle'], motionAlerts: false, minScore: 0.5, zones: [] };
const camSmart = cam => ({ ...DEFAULTS, ...(cam.smart || {}) });

class SmartWatch extends EventEmitter {
  constructor(cfg, cams, detector) {
    super();
    this.cfg = cfg; this.cams = cams; this.det = detector;
    this.fps = Math.max(0.2, Math.min(5, (cfg.smart && cfg.smart.fps) || 2));
    this.state = new Map(); // camId -> { tracker, activeUntil, lastRun, inflight, motionBox, statics }
    this.watched = new Set();
    this.timer = setInterval(() => this.tick(), 200); this.timer.unref();
  }
  on_(id) {
    let s = this.state.get(id);
    if (!s) this.state.set(id, s = { tracker: new Tracker({ maxAgeMs: Math.max(3000, 2500 / this.fps * 2) }), activeUntil: 0, lastRun: 0, inflight: false, motionBox: null, motionAt: 0, statics: [] });
    return s;
  }
  enabledFor(cam) { return this.det.available && camSmart(cam).enabled; }

  /** Pixel motion seen: look properly for the next few seconds. */
  motion(cam, box) {
    if (!this.enabledFor(cam)) return;
    const s = this.on_(cam.id); s.activeUntil = Date.now() + 8000; s.motionBox = box; s.motionAt = Date.now();
  }
  /** Cameras someone has open full-screen: keep labelling what's in view. */
  setWatched(ids) { this.watched = new Set(ids); }

  tick() {
    if (!this.det.available) return;
    const now = Date.now(), gap = 1000 / this.fps;
    for (const cam of this.cams.list) {
      if (!this.enabledFor(cam)) continue;
      const s = this.on_(cam.id), pipe = this.cams.pipe(cam.id);
      if (!pipe || !pipe.latest || now - pipe.latestAt > 5000 || s.inflight || now - s.lastRun < gap) continue;
      if (!(now < s.activeUntil || s.tracker.active || this.watched.has(cam.id))) continue;
      s.inflight = true; s.lastRun = now;
      const jpeg = pipe.latest;
      this.det.detect(cam.id, jpeg).then(dets => { s.inflight = false; if (dets) this.process(cam, s, dets, jpeg); }, () => { s.inflight = false; });
    }
  }

  process(cam, s, dets, jpeg) {
    const now = Date.now(), cs = camSmart(cam);
    const tracks = s.tracker.update(dets, now, cs.zones);
    // Keep looking while something is in view and moving about.
    if (tracks.some(t => t.lastSeen === now && t.hits > 1)) s.activeUntil = Math.max(s.activeUntil, now + 3000);
    // Things that never move (a parked car, a garden gnome "person") are remembered and don't alert again.
    s.statics = s.statics.filter(st => now - st.at < 12 * 3600e3);
    for (const t of tracks) {
      if (!t.firstBox) t.firstBox = t.box;
      if (t.isStatic == null) t.isStatic = s.statics.some(st => st.group === groupOf(t.label) && iou(st.box, t.box) > 0.7);
      // "Moved" = really travelled, not detector jitter. Someone walking up to the door always does;
      // a parked car someone walks past doesn't, so it won't raise a vehicle alert.
      const shift = Math.hypot((t.box.x + t.box.w / 2) - (t.firstBox.x + t.firstBox.w / 2), (t.box.y + t.box.h / 2) - (t.firstBox.y + t.firstBox.h / 2));
      if (iou(t.firstBox, t.box) < 0.85 || shift > 0.03) { t.movedOnce = true; t.isStatic = false; }
      if (t.hits >= 6 && !t.movedOnce && !s.statics.some(st => iou(st.box, t.box) > 0.7)) s.statics.push({ group: groupOf(t.label), box: t.box, at: now });
    }
    this.emit('detections', cam, dets, now);
    // Small birds/animals in view: hand them to the biome log for species identification.
    for (const d of dets) if (d.label === 'bird' && d.score > 0.5) { this.emit('wildlife', cam, d, jpeg); break; }

    const due = s.tracker.due(now, cs.zones, { kinds: cs.kinds, minScore: cs.minScore })
      .filter(x => x.track.movedOnce && !x.track.isStatic);
    if (due.length) this.emit('alert', cam, due, dets, jpeg, now);
  }
}

module.exports = { SmartWatch, camSmart, DEFAULTS };
