'use strict';
// One ffmpeg pipeline per camera: live MJPEG, motion frames, and 24/7 segmented recording.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { MotionDetector, MW, MH } = require('./motion');

class CameraPipe extends EventEmitter {
  constructor(cam, cfg) {
    super();
    this.cam = cam; this.cfg = cfg; this.status = 'offline'; this.latest = null; this.latestAt = 0;
    this.viewers = new Set(); this.proc = null; this.stopped = true; this.backoff = 2000;
    this.motion = new MotionDetector(cam.motion ? cam.motion.sensitivity : 5);
    this.recDir = path.join(cfg.dataDir, 'recordings', cam.id);
  }
  args() {
    const { cam, cfg } = this; const live = cfg.live;
    const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (cam.type === 'rtsp') a.push('-rtsp_transport', 'tcp', '-timeout', '10000000', '-fflags', 'nobuffer', '-i', cam.url);
    else a.push('-fflags', '+genpts', '-i', 'pipe:0');
    // 1) live view
    a.push('-map', '0:v:0', '-an', '-vf', `fps=${live.fps},scale='min(${live.width},iw)':-2`, '-q:v', String(live.quality), '-f', 'mjpeg', 'pipe:1');
    // 2) motion analysis frames
    a.push('-map', '0:v:0', '-an', '-vf', `fps=${cfg.motion.fps},scale=${MW}:${MH},format=gray`, '-f', 'rawvideo', 'pipe:3');
    // 3) continuous recording, fragmented MP4 so a power cut never corrupts a whole file
    if (cam.record !== false) {
      fs.mkdirSync(this.recDir, { recursive: true });
      a.push('-map', '0:v:0');
      if (cam.audio && cam.type === 'rtsp') a.push('-map', '0:a:0?', '-c:a', 'aac'); else a.push('-an');
      if (cam.type === 'rtsp') a.push('-c:v', 'copy');
      else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-g', '30', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1280,iw)':-2");
      a.push('-f', 'segment', '-segment_time', String(cfg.recording.segmentMinutes * 60), '-segment_format', 'mp4',
        '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof', '-strftime', '1', '-reset_timestamps', '1',
        path.join(this.recDir, '%Y-%m-%d_%H-%M-%S.mp4'));
    }
    return a;
  }
  start() {
    this.stopped = false;
    if (this.proc) return;
    this.setStatus('connecting');
    const p = this.proc = spawn(this.cfg.ffmpeg, this.args(), { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let jbuf = Buffer.alloc(0), gbuf = Buffer.alloc(0), errTail = '';
    p.stdout.on('data', d => {
      jbuf = jbuf.length ? Buffer.concat([jbuf, d]) : d;
      for (;;) {
        const s = jbuf.indexOf(Buffer.from([0xff, 0xd8])); if (s < 0) { jbuf = Buffer.alloc(0); break; }
        const e = jbuf.indexOf(Buffer.from([0xff, 0xd9]), s + 2); if (e < 0) { if (s > 0) jbuf = jbuf.subarray(s); break; }
        const frame = Buffer.from(jbuf.subarray(s, e + 2)); jbuf = jbuf.subarray(e + 2);
        this.onJpeg(frame);
      }
    });
    const FS = MW * MH;
    p.stdio[3].on('data', d => {
      gbuf = gbuf.length ? Buffer.concat([gbuf, d]) : d;
      while (gbuf.length >= FS) { const f = gbuf.subarray(0, FS); gbuf = gbuf.subarray(FS); this.onGray(f); }
    });
    p.stderr.on('data', d => { errTail = (errTail + d).slice(-600); if (process.env.SPECTACLE_DEBUG) process.stderr.write('[ffmpeg ' + this.cam.name + '] ' + d); });
    p.stdin.on('error', () => {});
    p.on('error', e => { errTail = e.message; });
    p.on('close', () => {
      if (this.proc !== p) return; // an older process we already replaced
      this.proc = null;
      if (errTail.trim()) this.lastError = errTail.trim().split('\n').pop();
      this.setStatus('offline');
      if (!this.stopped && this.cam.type === 'rtsp') {
        setTimeout(() => !this.stopped && this.start(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30000);
      }
    });
  }
  feed(chunk) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(chunk); }
  stop() {
    this.stopped = true;
    const p = this.proc; if (!p) return;
    this.proc = null; this.setStatus('offline');
    p.stdin.end(); p.kill('SIGINT'); setTimeout(() => p.kill('SIGKILL'), 4000).unref();
  }
  setStatus(s) { if (this.status !== s) { this.status = s; this.emit('status', s); } }
  onJpeg(frame) {
    this.latest = frame; this.latestAt = Date.now(); this.backoff = 2000; this.lastError = null;
    if (this.status !== 'live') this.setStatus('live');
    for (const v of this.viewers) v(frame);
  }
  onGray(f) {
    this.lastGray = Buffer.from(f);
    const m = this.cam.motion;
    if (!m || m.enabled === false) return;
    const hit = this.motion.feed(f);
    if (hit) this.emit('motion', hit);
  }
}

class CameraManager extends EventEmitter {
  constructor(cfg, settings) { super(); this.cfg = cfg; this.settings = settings; this.pipes = new Map(); }
  get list() { return this.settings.data.cameras; }
  get(id) { return this.list.find(c => c.id === id); }
  pipe(id) { return this.pipes.get(id); }
  startAll() { for (const c of this.list) this.ensure(c); }
  ensure(cam) {
    let p = this.pipes.get(cam.id);
    if (!p) {
      p = new CameraPipe(cam, this.cfg);
      p.on('status', s => this.emit('status', cam.id, s));
      p.on('motion', hit => this.emit('motion', cam, hit, p));
      this.pipes.set(cam.id, p);
    }
    if (cam.type === 'rtsp' && cam.enabled !== false) p.start();
    return p;
  }
  restart(cam) { const p = this.pipes.get(cam.id); if (p) { p.stop(); this.pipes.delete(cam.id); } return this.ensure(cam); }
  remove(id) { const p = this.pipes.get(id); if (p) p.stop(); this.pipes.delete(id); }
  status(id) { const p = this.pipes.get(id); return p ? { status: p.status, lastFrame: p.latestAt, error: p.lastError || null } : { status: 'offline' }; }

  // ---- recordings ----
  recordings(camId, day) {
    const dir = path.join(this.cfg.dataDir, 'recordings', camId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.mp4') && (!day || f.startsWith(day))).sort().reverse().map(f => {
      const st = fs.statSync(path.join(dir, f));
      const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(f);
      return { file: f, start: m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`).toISOString() : null, size: st.size, end: st.mtime.toISOString() };
    });
  }
  findSegment(camId, ts) {
    for (const r of this.recordings(camId, new Date(ts).toISOString().slice(0, 10)).concat(this.recordings(camId))) {
      if (r.start && new Date(r.start) <= ts && new Date(r.end) >= ts - 5000) return { file: r.file, offset: Math.max(0, Math.round((ts - new Date(r.start)) / 1000) - 5) };
    }
    return null;
  }
  sweep() {
    const root = path.join(this.cfg.dataDir, 'recordings');
    if (!fs.existsSync(root)) return;
    const cutoff = Date.now() - this.cfg.recording.retentionDays * 864e5;
    const all = [];
    for (const cam of fs.readdirSync(root)) {
      const dir = path.join(root, cam);
      for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); const st = fs.statSync(p); if (st.mtimeMs < cutoff) fs.rmSync(p, { force: true }); else all.push([st.mtimeMs, p]); }
    }
    // Keep a safety margin of free disk space by deleting the oldest footage first.
    try {
      all.sort((a, b) => a[0] - b[0]);
      const free = () => { const s = fs.statfsSync(root); return s.bavail * s.bsize / 1e9; };
      while (all.length > 1 && free() < this.cfg.recording.minFreeGB) fs.rmSync(all.shift()[1], { force: true });
    } catch {}
    // Same retention for motion snapshots.
    const ev = path.join(this.cfg.dataDir, 'events');
    if (fs.existsSync(ev)) for (const cam of fs.readdirSync(ev)) for (const f of fs.readdirSync(path.join(ev, cam))) { const p = path.join(ev, cam, f); if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); }
  }
}

module.exports = { CameraManager };
