'use strict';
// Optional "smart detection": people, vehicles and animals with the Apache-2.0 D-FINE detector.
// Installed separately (npm run smart-detection) into ./addons, so Spectacle itself stays dependency-free.
// Everything runs on this machine; frames never leave it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const { LABELS } = require('./coco');
const { jpegSize } = require('../species');

const SIZES = { s: 'D-FINE-S', l: 'D-FINE-L', x: 'D-FINE-X' };

function locate(cfg) {
  const dir = path.join(cfg.root, 'addons');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'smart.json'), 'utf8')); } catch {}
  const size = (cfg.smart && cfg.smart.size) || meta.size || 'l';
  const model = path.join(dir, 'models', `dfine-${size}.onnx`);
  const ortPath = path.join(dir, 'node_modules', 'onnxruntime-node');
  if (!fs.existsSync(ortPath)) return { reason: 'not installed', hint: 'Run: npm run smart-detection' };
  if (!fs.existsSync(model)) return { reason: `model dfine-${size}.onnx not downloaded`, hint: `Run: npm run smart-detection -- --size ${size}` };
  return { size, model, ortPath };
}

/** JPEG -> 640x640 RGB (plain resize, as the model expects). */
function toRgb640(ffmpeg, jpeg) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-protocol_whitelist', 'pipe', '-f', 'jpeg_pipe', '-i', 'pipe:0', '-vf', 'scale=640:640:flags=bilinear', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const out = []; p.stdout.on('data', c => out.push(c)); p.on('error', reject);
    p.on('close', code => { const b = Buffer.concat(out); code === 0 && b.length === 640 * 640 * 3 ? resolve(b) : reject(new Error('Could not decode frame')); });
    p.stdin.on('error', () => {}); p.stdin.end(jpeg);
  });
}

class Detector {
  constructor(cfg) {
    this.cfg = cfg; this.n = 0; this.pending = new Map(); this.busy = false; this.waiting = new Map();
    this.ready = false; this.avgMs = 0; this.runs = 0; this.error = null;
    const where = locate(cfg);
    this.info = where;
    if (!where.model) { this.error = where.reason; return; }
    this.worker = new Worker(path.join(__dirname, 'detector-worker.js'), {
      workerData: { model: where.model, ortPath: where.ortPath, threads: Math.max(1, Math.min(8, (cfg.smart && cfg.smart.threads) || Math.max(1, os.cpus().length - 1))) },
    });
    this.worker.on('message', m => {
      if (m.type === 'ready') { this.ready = true; this.error = null; console.log(`Smart detection: on (${SIZES[where.size] || where.size}, runs on this computer only)`); return; }
      if (m.type === 'error') { this.error = m.error; console.warn('Smart detection could not start:', m.error); return; }
      const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else { this.runs++; this.avgMs = this.avgMs ? this.avgMs * 0.9 + m.ms * 0.1 : m.ms; p.resolve(m.dets.map(d => ({ label: LABELS[d.cls] || 'object', score: d.score, box: d.box }))); }
    });
    this.worker.on('error', e => { this.error = e.message; this.ready = false; });
    this.worker.unref();
  }
  get available() { return this.ready && !this.error; }
  status() { return { available: this.available, model: this.info.size ? SIZES[this.info.size] : null, size: this.info.size || null, avgMs: Math.round(this.avgMs) || null, error: this.error, hint: this.info.hint || null }; }

  async run(jpeg, minScore) {
    const size = jpegSize(jpeg); if (!size) throw new Error('Not a JPEG');
    const rgb = await toRgb640(this.cfg.ffmpeg, jpeg);
    return new Promise((resolve, reject) => {
      const id = ++this.n;
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('Detection timed out')); }, 60000);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      const buf = rgb.buffer.slice(rgb.byteOffset, rgb.byteOffset + rgb.length);
      this.worker.postMessage({ id, rgb: buf, w: size.w, h: size.h, minScore }, [buf]);
    });
  }

  /**
   * One detection at a time across all cameras (keeps the CPU calm). If a camera asks again while busy,
   * only its newest frame is kept, so we never fall behind real time.
   */
  detect(key, jpeg, minScore = 0.35) {
    if (!this.available) return Promise.resolve(null);
    return new Promise(resolve => {
      const prev = this.waiting.get(key); if (prev) prev.resolve(null);
      this.waiting.set(key, { jpeg, minScore, resolve });
      this.pump();
    });
  }
  async pump() {
    if (this.busy) return;
    const next = this.waiting.entries().next().value; if (!next) return;
    const [key, job] = next; this.waiting.delete(key);
    this.busy = true;
    try { job.resolve(await this.run(job.jpeg, job.minScore)); } catch (e) { if (process.env.SPECTACLE_DEBUG) console.warn('detect', e.message); job.resolve(null); }
    finally { this.busy = false; setImmediate(() => this.pump()); }
  }
}

module.exports = { Detector, locate, SIZES };
