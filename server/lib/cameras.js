'use strict';
// One ffmpeg pipeline per camera: live MJPEG, motion frames, and 24/7 segmented recording.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { MotionDetector, MW, MH } = require('./motion');
const vault = require('./vault');

// Where segments are written while they're still being recorded. RAM (/dev/shm) when it has room, so
// unencrypted footage never touches the disk; finished segments are encrypted into data/recordings.
let stagingRoot = null;
function staging(cfg) {
  if (stagingRoot) return stagingRoot;
  const want = cfg.recording.stagingDir;
  let dir = want && want !== 'auto' ? path.resolve(cfg.root, want) : null;
  if (!dir) {
    try { const s = fs.statfsSync('/dev/shm'); if (s.bavail * s.bsize > 1.5e9) dir = path.join('/dev/shm', 'spectacle-' + (process.getuid ? process.getuid() : 'u')); } catch {}
  }
  dir = dir || path.join(cfg.dataDir, 'staging');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch {}
  return (stagingRoot = dir);
}

class CameraPipe extends EventEmitter {
  constructor(cam, cfg) {
    super();
    this.cam = cam; this.cfg = cfg; this.status = 'offline'; this.latest = null; this.latestAt = 0;
    this.viewers = new Set(); this.proc = null; this.stopped = true; this.backoff = 2000;
    this.motion = new MotionDetector(cam.motion ? cam.motion.sensitivity : 5);
    this.recDir = path.join(cfg.dataDir, 'recordings', cam.id);
    this.stageDir = path.join(staging(cfg), cam.id);
  }
  args() {
    const { cam, cfg } = this; const live = cfg.live;
    const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (cam.type === 'rtsp') a.push('-protocol_whitelist', 'rtsp,rtsps,tcp,udp,tls,rtp,srtp,crypto', '-rtsp_transport', 'tcp', '-timeout', '10000000', '-fflags', 'nobuffer', '-i', cam.url);
    else a.push('-protocol_whitelist', 'pipe', '-f', 'webm', '-fflags', '+genpts', '-i', 'pipe:0');
    // 1) live view
    a.push('-map', '0:v:0', '-an', '-vf', `fps=${live.fps},scale='min(${live.width},iw)':-2`, '-q:v', String(live.quality), '-f', 'mjpeg', 'pipe:1');
    // 2) motion analysis frames
    a.push('-map', '0:v:0', '-an', '-vf', `fps=${cfg.motion.fps},scale=${MW}:${MH},format=gray`, '-f', 'rawvideo', 'pipe:3');
    // 3) continuous recording, fragmented MP4 so a power cut never corrupts a whole file
    if (cam.record !== false) {
      fs.mkdirSync(this.stageDir, { recursive: true, mode: 0o700 });
      a.push('-map', '0:v:0');
      if (cam.audio && cam.type === 'rtsp') a.push('-map', '0:a:0?', '-c:a', 'aac'); else a.push('-an');
      if (cam.type === 'rtsp') a.push('-c:v', 'copy');
      else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-g', '30', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1280,iw)':-2");
      a.push('-f', 'segment', '-segment_time', String(cfg.recording.segmentMinutes * 60), '-segment_format', 'mp4',
        '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof', '-strftime', '1', '-reset_timestamps', '1',
        path.join(this.stageDir, '%Y-%m-%d_%H-%M-%S.mp4'));
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
      this.emit('ended');
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
  startAll() { for (const c of this.list) this.ensure(c); this.sealer = setInterval(() => this.seal(), 20000); this.sealer.unref(); }
  ensure(cam) {
    let p = this.pipes.get(cam.id);
    if (!p) {
      p = new CameraPipe(cam, this.cfg);
      p.on('status', s => this.emit('status', cam.id, s));
      p.on('motion', hit => this.emit('motion', cam, hit, p));
      p.on('ended', () => setTimeout(() => this.seal(cam.id), 1500));
      this.pipes.set(cam.id, p);
    }
    if (cam.type === 'rtsp' && cam.enabled !== false) p.start();
    return p;
  }
  restart(cam) { const p = this.pipes.get(cam.id); if (p) { p.stop(); this.pipes.delete(cam.id); } return this.ensure(cam); }
  remove(id) { const p = this.pipes.get(id); if (p) p.stop(); this.pipes.delete(id); }
  status(id) { const p = this.pipes.get(id); return p ? { status: p.status, lastFrame: p.latestAt, error: p.lastError || null } : { status: 'offline' }; }

  // ---- recordings ----
  recDir(camId) { return path.join(this.cfg.dataDir, 'recordings', camId); }
  stageDir(camId) { return path.join(staging(this.cfg), camId); }
  /* Path of a recording: the encrypted file, or the segment still being recorded (in memory). */
  recordingFile(camId, file) {
    if (!/^[\w.-]+\.mp4$/.test(file) || !/^[\w-]+$/.test(camId)) return null;
    const live = path.join(this.stageDir(camId), file); if (fs.existsSync(live)) return { file: live, sealed: false };
    const enc = path.join(this.recDir(camId), file + '.spx'); if (fs.existsSync(enc)) return { file: enc, sealed: true };
    return null;
  }
  recordings(camId, day) {
    const out = new Map();
    const add = (dir, f, name, sealed) => {
      if (!name.endsWith('.mp4') || (day && !name.startsWith(day))) return;
      let st, size; try { st = fs.statSync(path.join(dir, f)); size = sealed ? vault.plainSize(path.join(dir, f)) : st.size; } catch { return; }
      const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
      out.set(name, { file: name, start: m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`).toISOString() : null, size, end: st.mtime.toISOString() });
    };
    for (const [dir, sealed] of [[this.recDir(camId), true], [this.stageDir(camId), false]]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) add(dir, f, sealed ? f.replace(/\.spx$/, '') : f, sealed && f.endsWith('.spx'));
    }
    return [...out.values()].sort((a, b) => b.file.localeCompare(a.file));
  }
  /* Encrypt finished segments (and any unencrypted footage left by older versions) into data/recordings. */
  seal(onlyCam) {
    const root = staging(this.cfg);
    const dirs = [];
    if (fs.existsSync(root)) for (const cam of fs.readdirSync(root)) if (!onlyCam || cam === onlyCam) dirs.push([path.join(root, cam), cam]);
    const recRoot = path.join(this.cfg.dataDir, 'recordings');
    if (fs.existsSync(recRoot)) for (const cam of fs.readdirSync(recRoot)) if (!onlyCam || cam === onlyCam) dirs.push([path.join(recRoot, cam), cam]);
    for (const [dir, cam] of dirs) {
      let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).sort(); } catch { continue; }
      const p = this.pipes.get(cam), recording = p && p.proc;
      files.forEach((f, i) => {
        const src = path.join(dir, f);
        let st; try { st = fs.statSync(src); } catch { return; }
        const newest = i === files.length - 1;
        if (newest && recording && Date.now() - st.mtimeMs < 60000 && dir.startsWith(root)) return;   // still being written
        if (st.size === 0) { fs.rmSync(src, { force: true }); return; }
        const dst = path.join(this.recDir(cam), f + '.spx');
        try { vault.encryptFile(src, dst); fs.utimesSync(dst, st.atime, st.mtime); } catch (e) { console.warn('encrypting recording', f, e.message); }
      });
    }
  }
  findSegment(camId, ts) {
    for (const r of this.recordings(camId, new Date(ts).toISOString().slice(0, 10)).concat(this.recordings(camId))) {
      if (r.start && new Date(r.start) <= ts && new Date(r.end) >= ts - 5000) return { file: r.file, offset: Math.max(0, Math.round((ts - new Date(r.start)) / 1000) - 5) };
    }
    return null;
  }
  sweep() {
    this.seal();
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
    if (fs.existsSync(ev)) for (const cam of fs.readdirSync(ev)) for (const f of fs.readdirSync(path.join(ev, cam))) {
      const p = path.join(ev, cam, f); const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) fs.rmSync(p, { force: true });
      else if (f.endsWith('.jpg') && !vault.isSealedFile(p)) { try { vault.writeFile(p, fs.readFileSync(p)); fs.utimesSync(p, st.atime, st.mtime); } catch {} }   // encrypt older snapshots
    }
  }
}

/* rtsp:// is unencrypted and unauthenticated end to end; rtsps:// is TLS. Used to warn the family admin. */
const isPlainRtsp = url => /^rtsp:\/\//i.test(String(url || ''));

module.exports = { CameraManager, isPlainRtsp };
