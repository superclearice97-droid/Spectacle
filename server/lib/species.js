'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');

function parseLabel(label) {
  const m = /^(.+?)\s*\((.+)\)\s*$/.exec(label.trim());
  return m ? { scientific: m[1].trim(), common: m[2].trim() } : { scientific: label.trim(), common: '' };
}
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- JPEG helpers ----
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
function decodeJpeg(ffmpeg, jpeg) {
  const size = jpegSize(jpeg);
  if (!size) return Promise.reject(new Error('Not a JPEG'));
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', reject);
    p.on('close', code => {
      const rgb = Buffer.concat(chunks);
      if (code !== 0 || rgb.length !== size.w * size.h * 3) return reject(new Error('Could not decode image'));
      resolve({ rgb, w: size.w, h: size.h });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(jpeg);
  });
}
// Bilinear crop + resize to 224x224 RGB.
function cropResize(img, x, y, cw, ch, S = 224) {
  const out = new Uint8Array(S * S * 3);
  for (let oy = 0; oy < S; oy++) {
    const fy = y + (oy + 0.5) * ch / S - 0.5; const y0 = Math.max(0, Math.min(img.h - 1, Math.floor(fy))); const y1 = Math.min(img.h - 1, y0 + 1); const dy = Math.min(1, Math.max(0, fy - y0));
    for (let ox = 0; ox < S; ox++) {
      const fx = x + (ox + 0.5) * cw / S - 0.5; const x0 = Math.max(0, Math.min(img.w - 1, Math.floor(fx))); const x1 = Math.min(img.w - 1, x0 + 1); const dx = Math.min(1, Math.max(0, fx - x0));
      for (let c = 0; c < 3; c++) {
        const a = img.rgb[(y0 * img.w + x0) * 3 + c], b = img.rgb[(y0 * img.w + x1) * 3 + c], d = img.rgb[(y1 * img.w + x0) * 3 + c], e = img.rgb[(y1 * img.w + x1) * 3 + c];
        out[(oy * S + ox) * 3 + c] = Math.round((a * (1 - dx) + b * dx) * (1 - dy) + (d * (1 - dx) + e * dx) * dy);
      }
    }
  }
  return out;
}
// Square crops to scan: whole-frame centre, optional 2x2 tiles, optional motion region.
function planCrops(img, { tiles, box }) {
  // Plants sit still, so they're searched across the frame (centre + 4 tiles).
  // Bugs and birds are small and move, so they're checked in the centre and wherever motion was seen.
  const crops = [];
  const s = Math.min(img.w, img.h);
  crops.push({ name: 'center', x: (img.w - s) / 2, y: (img.h - s) / 2, w: s, h: s, groups: ['plant', 'insect', 'bird'] });
  if (tiles) {
    const t = Math.round(s * 0.6);
    for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) crops.push({ name: `tile${fx}${fy}`, x: fx * (img.w - t), y: fy * (img.h - t), w: t, h: t, groups: ['plant'] });
  }
  if (box) { // box is normalised 0..1
    const bw = box.w * img.w, bh = box.h * img.h; let side = Math.max(bw, bh) * 1.6; side = Math.max(96, Math.min(s, side));
    const cx = (box.x + box.w / 2) * img.w, cy = (box.y + box.h / 2) * img.h;
    crops.push({ name: 'motion', x: Math.max(0, Math.min(img.w - side, cx - side / 2)), y: Math.max(0, Math.min(img.h - side, cy - side / 2)), w: side, h: side, groups: ['insect', 'bird'] });
  }
  return crops;
}

class Identifier {
  constructor(cfg) {
    this.cfg = cfg; this.n = 0; this.pending = new Map(); this.queue = Promise.resolve();
    this.spawnWorker();
    this.dbFile = path.join(cfg.dataDir, 'species-db', 'species.json');
    this.reloadDb();
  }
  spawnWorker() {
    this.worker = new Worker(path.join(__dirname, 'id-worker.js'));
    this.worker.on('message', m => { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m.results); });
    // If the worker ever dies, fail what's pending and start a fresh one.
    this.worker.on('error', e => console.warn('identifier worker error:', e.message));
    this.worker.on('exit', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('identifier restarted')); } this.pending.clear(); setTimeout(() => this.spawnWorker(), 1000); });
    this.worker.unref();
  }
  reloadDb() {
    try { this.db = JSON.parse(fs.readFileSync(this.dbFile, 'utf8')).species; } catch { this.db = {}; }
  }
  info(scientific) { return this.db[slug(scientific)] || null; }
  dbStats() { const v = Object.values(this.db); return { total: v.length, explained: v.filter(e => e.summary).length }; }
  // Serialised so several cameras never pile onto the CPU at once.
  classify(img, cropPlan, groups) {
    const run = () => new Promise((resolve, reject) => {
      const id = ++this.n;
      const crops = cropPlan.map(c => ({ name: c.name, groups: c.groups ? c.groups.filter(g => groups.includes(g)) : null, rgb: cropResize(img, c.x, c.y, c.w, c.h).buffer }));
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('identification timed out')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, crops, groups }, crops.map(c => c.rgb));
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

module.exports = { parseLabel, slug, jpegSize, decodeJpeg, cropResize, planCrops, Identifier };
