#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const { Auth, LEGAL_VERSION } = require('./lib/auth');
const { CameraManager, isPlainRtsp } = require('./lib/cameras');
const { Notifier } = require('./lib/notify');
const { Identifier } = require('./lib/species');
const { Biome } = require('./lib/biome');
const wsLib = require('./lib/ws');
const vault = require('./lib/vault');
const { Detector } = require('./lib/smart/detector');
const { SmartWatch, camSmart } = require('./lib/smart/watch');
const { cleanZones } = require('./lib/smart/tracker');
const { GROUP_NAMES, groupOf, nice } = require('./lib/smart/coco');
const { TalkHub } = require('./lib/talk');

const cfg = loadConfig();
const PUBLIC = path.join(cfg.root, 'public');
const auth = new Auth(cfg);
const settings = new Store(cfg.dataDir, 'settings', { armed: true, cameras: [] });
const events = new Store(cfg.dataDir, 'events', { list: [] });
const cams = new CameraManager(cfg, settings);
const identifier = new Identifier(cfg);
let detector = new Detector(cfg);
const smartModels = require('./lib/smart/models');
let smartInstall = null; // { size, pct } while the desktop app downloads a model
const smart = new SmartWatch(cfg, cams, detector);

const SECRETS = path.join(cfg.dataDir, 'secrets.json'), CODE_FILE = path.join(cfg.dataDir, 'SETUP-CODE.txt');
function setupCode() {
  if (auth.hasUsers()) { if (cfg.secrets.setupCode) { delete cfg.secrets.setupCode; vault.writeJSON(SECRETS, cfg.secrets); } fs.rmSync(CODE_FILE, { force: true }); return null; }
  if (!cfg.secrets.setupCode) {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.randomBytes(10);
    cfg.secrets.setupCode = [...b].map(x => A[x % A.length]).join('').replace(/(.{5})(?=.)/g, '$1-');
    vault.writeJSON(SECRETS, cfg.secrets);
  }
  fs.writeFileSync(CODE_FILE, `Spectacle setup code: ${cfg.secrets.setupCode}\nEnter it on the "Set up Spectacle" page. This file is deleted once the admin account exists.\n`, { mode: 0o600 });
  return cfg.secrets.setupCode;
}
const firstCode = setupCode();
if (firstCode) console.log(`\nSetup code for the first admin account: ${firstCode}\n(also saved in ${CODE_FILE})\n`);

// ---------------- live hub (presence + alerts) ----------------
const clients = new Map(); // ws -> { user, view, device }
const hub = {
  broadcast(msg) { const s = JSON.stringify(msg); for (const ws of clients.keys()) ws.send(s); },
  presence() {
    const byUser = new Map();
    for (const c of clients.values()) {
      if (c.bg) continue; // the app's background alert connection isn't "being online"
      const p = byUser.get(c.user.id) || { id: c.user.id, name: c.user.name, color: c.user.color, devices: 0, viewing: new Set(), page: c.view.page };
      p.devices++; (c.view.cams || []).forEach(id => p.viewing.add(id)); if (c.view.focus) p.page = c.view.page;
      byUser.set(c.user.id, p);
    }
    hub.broadcast({ type: 'presence', users: [...byUser.values()].map(p => ({ ...p, viewing: [...p.viewing] })) });
  },
};
const notifier = new Notifier(cfg, auth, hub);
// ---------------- two-way talk (live only, never recorded) ----------------
const talk = new TalkHub({
  cams,
  onState: st => hub.broadcast({ type: 'talk-state', ...st }),
  // Only a log line is kept: who joined and for how long. No audio.
  onEnd: e => {
    const ev = { id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), camId: e.camId, camName: e.camName, ts: new Date(e.startedAt).toISOString(), kind: 'talk', people: e.people, spoke: e.spoke, durationSec: e.durationSec, notified: false };
    events.data.list.unshift(ev); events.data.list = events.data.list.slice(0, 3000); events.save(); hub.broadcast({ type: 'event', event: ev });
  },
});
const lastRing = new Map();
function doorbell(cam) {
  const now = Date.now();
  if (!cam.talk || !cam.talk.doorbell || now - (lastRing.get(cam.id) || 0) < 20000) return false;
  lastRing.set(cam.id, now);
  const id = now.toString(36) + crypto.randomBytes(3).toString('hex'), pipe = cams.pipe(cam.id);
  let snapshot = null; if (pipe && pipe.latest) { snapshot = id + '.jpg'; vault.writeFile(path.join(cfg.dataDir, 'events', cam.id, snapshot), pipe.latest); }
  const ev = { id, camId: cam.id, camName: cam.name, ts: new Date(now).toISOString(), kind: 'ring', snapshot, notified: true };
  events.data.list.unshift(ev); events.data.list = events.data.list.slice(0, 3000); events.save(); hub.broadcast({ type: 'event', event: ev });
  // Doorbells always alert (even when "Home"), like a real doorbell.
  notifier.alert({ kind: 'ring', title: `Someone is at ${cam.name}`, body: 'They pressed the doorbell. Tap to see and talk to them.', camId: cam.id, url: '/#talk/' + cam.id, tag: 'ring-' + cam.id });
  return true;
}
const biome = new Biome(cfg, identifier, ev => {
  hub.broadcast({ type: 'sighting', ...ev });
  if (ev.isNew) notifier.alert({ kind: 'sighting', title: `New in the yard: ${ev.species.common || ev.species.scientific}`, body: `Spotted by ${ev.cam} (${Math.round(ev.conf * 100)}% sure). Tap to see its folder.`, url: '/#biome/' + ev.species.id, tag: 'biome-' + ev.species.id });
});

// Pick up the offline species database as soon as `npm run species-db` writes it.
biome.refile();
fs.watchFile(identifier.dbFile, { interval: 5000 }, () => { identifier.reloadDb(); const n = biome.refile(); if (n) console.log(`Sorted ${n} biome folders by order/family`); hub.broadcast({ type: 'biome' }); });

// ---------------- motion -> events, alerts, biome ----------------
const lastMotion = new Map(), lastBiome = new Map(), scanning = new Set();
cams.on('status', (id, status) => hub.broadcast({ type: 'camstatus', id, ...cams.status(id) }));
cams.on('motion', (cam, hit, pipe) => {
  const now = Date.now();
  lastMotion.set(cam.id + ':box', { box: hit.box, at: now });
  // Small moving things are good candidates for bug/bird identification.
  if (cam.biome !== false && cfg.biome.enabled && hit.box.w * hit.box.h < 0.35 && now - (lastBiome.get(cam.id) || 0) > 15000) { lastBiome.set(cam.id, now); scan(cam, pipe, hit.box); }
  smart.motion(cam, hit.box);
  // With smart detection on, plain "something moved" alerts are replaced by person/vehicle/animal alerts
  // (unless the camera also asks for any-motion alerts).
  if (smart.enabledFor(cam) && !camSmart(cam).motionAlerts) return;
  if (now - (lastMotion.get(cam.id) || 0) < cfg.motion.cooldownSec * 1000) return;
  lastMotion.set(cam.id, now);
  const id = now.toString(36) + crypto.randomBytes(3).toString('hex');
  let snapshot = null;
  if (pipe.latest) { snapshot = id + '.jpg'; vault.writeFile(path.join(cfg.dataDir, 'events', cam.id, snapshot), pipe.latest); }
  const ev = { id, camId: cam.id, camName: cam.name, ts: new Date(now).toISOString(), score: hit.score, box: hit.box, snapshot, notified: false };
  const armed = settings.data.armed && cam.motion && cam.motion.notify !== false;
  if (armed) { ev.notified = true; notifier.alert({ kind: 'motion', title: `Motion: ${cam.name}`, body: `Movement detected at ${new Date(now).toLocaleTimeString()}`, camId: cam.id, url: '/#event/' + id, tag: 'motion-' + cam.id }); }
  events.data.list.unshift(ev); events.data.list = events.data.list.slice(0, 3000); events.save();
  hub.broadcast({ type: 'event', event: ev });
});
// ---------------- smart detection -> events, alerts ----------------
const lastSmart = new Map();
smart.on('alert', (cam, due, dets, jpeg, now) => {
  // One alert per camera+zone+kind per cooldown, combining everyone who arrived together.
  const groups = new Map();
  for (const d of due) { const k = d.zone.id + ':' + d.group; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  for (const [k, items] of groups) {
    const key = cam.id + ':' + k;
    if (now - (lastSmart.get(key) || 0) < cfg.motion.cooldownSec * 1000) continue;
    lastSmart.set(key, now);
    const { zone, group } = items[0], n = items.length;
    const what = group === 'person' ? (n > 1 ? `${n} people` : 'Person') : group === 'animal' ? (n > 1 ? `${n} animals` : nice(items[0].track.label)) : group === 'vehicle' ? (n > 1 ? `${n} vehicles` : nice(items[0].track.label)) : GROUP_NAMES[group];
    const where = zone.id === 'all' ? `at ${cam.name}` : `in ${zone.name}`;
    const id = now.toString(36) + crypto.randomBytes(3).toString('hex');
    const snapshot = id + '.jpg'; vault.writeFile(path.join(cfg.dataDir, 'events', cam.id, snapshot), jpeg);
    const boxes = dets.filter(d => d.score >= 0.4 && groupOf(d.label) !== 'other').slice(0, 20).map(d => ({ label: d.label, score: +d.score.toFixed(2), box: roundBox(d.box) }));
    const ev = { id, camId: cam.id, camName: cam.name, ts: new Date(now).toISOString(), kind: group, label: items[0].track.label, count: n, zone: zone.id === 'all' ? null : zone.name, stayedSec: zone.dwellSec ? items[0].stayedSec : undefined, score: +Math.max(...items.map(i => i.track.score)).toFixed(2), boxes, snapshot, notified: false };
    if (settings.data.armed) {
      ev.notified = true;
      const linger = zone.dwellSec ? ` · there for ${items[0].stayedSec} s` : '';
      notifier.alert({ kind: 'motion', title: `${what} ${where}`, body: `${cam.name} · ${new Date(now).toLocaleTimeString()}${linger}`, camId: cam.id, url: '/#event/' + id, tag: `smart-${cam.id}-${k}` });
    }
    events.data.list.unshift(ev); events.data.list = events.data.list.slice(0, 3000); events.save();
    hub.broadcast({ type: 'event', event: ev });
  }
});
const roundBox = b => ({ x: +b.x.toFixed(4), y: +b.y.toFixed(4), w: +b.w.toFixed(4), h: +b.h.toFixed(4) });
smart.on('detections', (cam, dets, ts) => {
  // Live labels only go to people who have this camera open.
  const msg = JSON.stringify({ type: 'detections', camId: cam.id, ts, objects: dets.filter(d => d.score >= 0.45).slice(0, 30).map(d => ({ label: d.label, group: groupOf(d.label), score: +d.score.toFixed(2), box: roundBox(d.box) })) });
  for (const [ws, c] of clients) if (!c.bg && c.view.page === 'cam' && (c.view.cams || []).includes(cam.id)) ws.send(msg);
});
smart.on('wildlife', (cam, d) => {
  const now = Date.now(), pipe = cams.pipe(cam.id);
  if (cam.biome === false || !cfg.biome.enabled || !pipe || now - (lastBiome.get(cam.id) || 0) < 15000) return;
  lastBiome.set(cam.id, now); scan(cam, pipe, d.box);
});
const scannedGray = new Map();
function sceneChanged(cam, pipe) {
  // Skip periodic scans of a scene that hasn't changed (re-checking the same flowerbed wastes CPU),
  // but still refresh at least every 30 minutes as light and blooms change.
  const prev = scannedGray.get(cam.id), cur = pipe.lastGray;
  if (!prev || !cur || Date.now() - prev.at > 30 * 60000) return true;
  let d = 0; for (let i = 0; i < cur.length; i += 7) d += Math.abs(cur[i] - prev.f[i]);
  return d / (cur.length / 7) > 6;
}
async function scan(cam, pipe, box, periodic) {
  if (scanning.has(cam.id) || !pipe.latest || Date.now() - pipe.latestAt > 10000) return;
  if (periodic && !box && !sceneChanged(cam, pipe)) return;
  if (pipe.lastGray) scannedGray.set(cam.id, { f: pipe.lastGray, at: Date.now() });
  scanning.add(cam.id);
  try { const t = Date.now(); const found = await biome.scanFrame(cam, pipe.latest, box); if (process.env.SPECTACLE_DEBUG) console.log(`biome scan ${cam.name}: ${found.length} found in ${Date.now() - t}ms`); } catch (e) { console.warn('biome scan', cam.name, e.message); } finally { scanning.delete(cam.id); }
}
setInterval(() => {
  if (!cfg.biome.enabled) return;
  for (const cam of cams.list) if (cam.biome !== false) { const p = cams.pipe(cam.id); if (p) { const m = lastMotion.get(cam.id + ':box'); scan(cam, p, m && Date.now() - m.at < 20000 ? m.box : null, true); } }
}, cfg.biome.intervalSec * 1000).unref();
setInterval(() => { cams.sweep(); auth.cleanup(); }, 10 * 60000).unref();

// ---------------- HTTP helpers ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
function secHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const isSecure = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const setSession = (req, res, token, maxAge = 30 * 86400) => res.setHeader('Set-Cookie', `sp_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`);
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
async function bodyJSON(req) { const b = await readBody(req); try { return b.length ? JSON.parse(b) : {}; } catch { throw new Error('Bad JSON'); } }
function serveFile(req, res, file, type, noCache) {
  let st; try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'Not found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'Not found' });
  const ct = type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? +range[1] : Math.max(0, st.size - +range[2]), end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': ct, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': ct, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': noCache ? 'no-store' : ct.startsWith('text/html') ? 'no-cache' : 'private, max-age=300' });
  fs.createReadStream(file).pipe(res);
}
/* Camera footage and photos: decrypted on the fly and never stored in browser caches. */
function serveMedia(req, res, file, type) {
  const h = { 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' };
  if (vault.isSealedFile(file)) return vault.serve(req, res, file, type, h);
  res.setHeader('Cache-Control', 'no-store'); return serveFile(req, res, file, type, true);
}
const imageType = b => b.length > 12 && ((b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'));
const PUSH_HOSTS = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[\w.-]+\.notify\.windows\.com|[\w.-]+\.push\.apple\.com)\//;
const okPush = u => typeof u === 'string' && u.length < 2000 && PUSH_HOSTS.test(u);
const within = (base, p) => { const r = path.resolve(base, p); return r.startsWith(path.resolve(base) + path.sep) ? r : null; };
const camView = c => ({ id: c.id, name: c.name, type: c.type, record: c.record !== false, biome: c.biome !== false, audio: !!c.audio, motion: c.motion, smart: camSmart(c), talk: { enabled: !!(c.talk && c.talk.enabled), doorbell: !!(c.talk && c.talk.doorbell), supported: c.type === 'browser', session: talk.state(c.id) }, enabled: c.enabled !== false, hasUrl: !!c.url, plainStream: c.type === 'rtsp' && isPlainRtsp(c.url), ...cams.status(c.id) });

// ---------------- routes ----------------
async function handle(req, res) {
  secHeaders(res);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname; const m = req.method;
  const user = auth.userFromToken(cookies(req).sp_session);
  // CSRF guard: state-changing API calls must come from our own JS.
  if (p.startsWith('/api/') && m !== 'GET' && req.headers['x-spectacle'] !== '1') return json(res, 403, { error: 'Missing app header' });
  const need = role => { if (!user) { json(res, 401, { error: 'Please sign in' }); return false; } if (role === 'admin' && user.role !== 'admin') { json(res, 403, { error: 'Only the family admin can do that' }); return false; } return true; };
  let mm;

  // Signed-out visitors learn only what the sign-in page needs (not whether the alarm is armed).
  if (p === '/api/state' && m === 'GET') return json(res, 200, { appName: cfg.appName, setupNeeded: !auth.hasUsers(), user: auth.publicUser(user), vapidKey: user ? cfg.secrets.vapid.publicKey : undefined, armed: user ? settings.data.armed : undefined, legalVersion: LEGAL_VERSION, appUrl: cfg.appDownloadUrl, publicUrl: user ? publicBase() : undefined, consentStale: user ? user.consent.version !== LEGAL_VERSION : false });
  if (p === '/api/setup' && m === 'POST') {
    if (auth.hasUsers()) return json(res, 409, { error: 'Already set up' });
    auth.throttle(req.socket.remoteAddress);
    const b = await bodyJSON(req); const want = cfg.secrets.setupCode || '';
    const given = String(b.setupCode || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), real = want.replace(/-/g, '');
    if (!real || given.length !== real.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(real))) { auth.failed(req.socket.remoteAddress); return json(res, 403, { error: 'That setup code is wrong. It was shown when Spectacle was installed (also in data/SETUP-CODE.txt on the server).' }); }
    const u = auth.createUser({ ...b, role: 'admin' }); setupCode();
    setSession(req, res, auth.newSession(u)); return json(res, 200, { user: auth.publicUser(u) });
  }
  if (p === '/api/register' && m === 'POST') {
    auth.throttle(req.socket.remoteAddress);
    const b = await bodyJSON(req); let inv; try { inv = auth.useInvite(b.invite); } catch (e) { auth.failed(req.socket.remoteAddress); throw e; }
    const u = auth.createUser({ ...b, role: inv.role === 'admin' ? 'admin' : 'member' });
    setSession(req, res, auth.newSession(u)); return json(res, 200, { user: auth.publicUser(u) });
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await bodyJSON(req); const t = auth.login(b.username, b.password, req.socket.remoteAddress);
    setSession(req, res, t); return json(res, 200, { ok: true });
  }
  if (p === '/api/logout' && m === 'POST') { const t = cookies(req).sp_session; if (t) auth.logout(t); setSession(req, res, '', 0); return json(res, 200, { ok: true }); }

  if (p === '/api/me/consent' && m === 'POST') { if (!need()) return; const b = await bodyJSON(req); if (b.terms !== true || b.presence !== true) return json(res, 400, { error: 'Please accept both' }); user.consent = { terms: true, presence: true, version: LEGAL_VERSION, at: new Date().toISOString() }; auth.store.save(); return json(res, 200, { ok: true }); }
  if (p === '/api/me/prefs' && m === 'PATCH') {
    if (!need()) return; const b = await bodyJSON(req);
    if (typeof b.notify === 'boolean') user.prefs.notify = b.notify;
    if (typeof b.biomeAlerts === 'boolean') user.prefs.biomeAlerts = b.biomeAlerts;
    if (Array.isArray(b.mutedCams)) user.prefs.mutedCams = b.mutedCams.filter(x => typeof x === 'string' && /^[\w-]{1,40}$/.test(x)).slice(0, 64);
    if (typeof b.name === 'string' && b.name.trim()) user.name = b.name.trim().slice(0, 40);
    auth.store.save(); return json(res, 200, { user: auth.publicUser(user) });
  }
  if (p === '/api/me/password' && m === 'POST') {
    if (!need()) return; const b = await bodyJSON(req);
    if (!auth.verify(String(b.current || ''), user.pw)) return json(res, 400, { error: 'Current password is wrong' });
    if (String(b.next || '').length < 10) return json(res, 400, { error: 'New password must be at least 10 characters' });
    // A new password signs out every other device (in case the old one was known to someone else).
    user.pw = auth.hash(b.next); auth.revokeSessions(user.id, cookies(req).sp_session); for (const [ws, c] of clients) if (c.user.id === user.id) ws.close(4003);
    auth.store.save(); return json(res, 200, { ok: true });
  }
  if (p === '/api/me/export' && m === 'GET') { if (!need()) return; const { pw, ...mine } = user; res.setHeader('Content-Disposition', 'attachment; filename="my-spectacle-data.json"'); return json(res, 200, { account: mine, exportedAt: new Date().toISOString() }); }
  if (p === '/api/me' && m === 'DELETE') {
    if (!need()) return;
    if (user.role === 'admin' && auth.d.users.filter(u => u.role === 'admin').length === 1 && auth.d.users.length > 1) return json(res, 400, { error: 'Make someone else an admin before deleting the only admin account' });
    auth.deleteUser(user.id); setSession(req, res, '', 0); return json(res, 200, { ok: true });
  }
  if (p === '/api/push/subscribe' && m === 'POST') {
    if (!need()) return; const { subscription } = await bodyJSON(req);
    // Only real browser push services, so the server can't be made to send requests anywhere else.
    if (!subscription || !okPush(subscription.endpoint) || !subscription.keys || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') return json(res, 400, { error: 'Bad subscription' });
    if ((user.push || []).length >= 10) user.push = user.push.slice(-9);
    user.push = (user.push || []).filter(s => s.endpoint !== subscription.endpoint); user.push.push({ endpoint: subscription.endpoint, keys: subscription.keys }); auth.store.save(); return json(res, 200, { ok: true });
  }
  if (p === '/api/push/test' && m === 'POST') { if (!need()) return; await notifier.alert({ kind: 'test', title: 'Spectacle test', body: `Hi ${user.name}, notifications are working.` }); return json(res, 200, { ok: true, devices: (user.push || []).length }); }

  if (p === '/api/users' && m === 'GET') { if (!need()) return; return json(res, 200, { users: auth.d.users.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role, color: u.color, created: u.created })) }); }
  if (p === '/api/invites' && m === 'POST') { if (!need('admin')) return; const b = await bodyJSON(req); if (b.shareUrl && !okShare(b.shareUrl)) return json(res, 400, { error: 'That doesn\'t look like a Tailscale link (it should start with https://login.tailscale.com/)' });
    return json(res, 200, { code: auth.createInvite(user.id, b.role === 'admin' ? 'admin' : 'member'), expiresInDays: 7, shareUrl: okShare(b.shareUrl), ...linkInfo(req) }); }
  if ((mm = /^\/api\/users\/([\w-]+)$/.exec(p))) {
    if (!need('admin')) return; const target = auth.user(mm[1]); if (!target) return json(res, 404, { error: 'No such user' });
    if (m === 'DELETE') { if (target.id === user.id) return json(res, 400, { error: 'Use "delete my account" for yourself' }); auth.deleteUser(target.id); for (const [ws, c] of clients) if (c.user.id === target.id) ws.close(); return json(res, 200, { ok: true }); }
    if (m === 'PATCH') { const b = await bodyJSON(req);
      if (b.role === 'member' && target.role === 'admin' && auth.d.users.filter(u => u.role === 'admin').length === 1) return json(res, 400, { error: 'There must always be at least one admin' });
      if (b.role === 'admin' || b.role === 'member') target.role = b.role; auth.store.save(); return json(res, 200, { ok: true }); }
  }

  if (p === '/api/armed' && m === 'POST') { if (!need()) return; const b = await bodyJSON(req); settings.data.armed = !!b.armed; settings.save(); hub.broadcast({ type: 'armed', armed: settings.data.armed, by: user.name }); return json(res, 200, { armed: settings.data.armed }); }
  if (p === '/api/cameras' && m === 'GET') { if (!need()) return; return json(res, 200, { cameras: cams.list.map(camView) }); }
  if (p === '/api/cameras' && m === 'POST') {
    if (!need('admin')) return; const b = await bodyJSON(req);
    if (!b.ackPlacement) return json(res, 400, { error: 'Please confirm the camera placement notice' });
    const type = b.type === 'rtsp' ? 'rtsp' : 'browser';
    if (type === 'rtsp' && !/^rtsps?:\/\/\S+$/i.test(b.url || '')) return json(res, 400, { error: 'Enter an rtsp:// address' });
    const cam = { id: crypto.randomUUID().slice(0, 8), name: String(b.name || 'Camera').slice(0, 40), type, url: type === 'rtsp' ? b.url : undefined, record: b.record !== false, biome: b.biome !== false, audio: false, motion: { enabled: true, sensitivity: 5, notify: true }, created: new Date().toISOString(), placementAck: { by: user.id, at: new Date().toISOString() } };
    settings.data.cameras.push(cam); settings.save(); cams.ensure(cam);
    hub.broadcast({ type: 'cameras' }); return json(res, 200, { camera: camView(cam) });
  }
  if ((mm = /^\/api\/cameras\/([\w-]+)(\/[\w-]+)?$/.exec(p))) {
    if (!need()) return;
    const cam = cams.get(mm[1]); if (!cam) return json(res, 404, { error: 'No such camera' });
    const sub = mm[2] || '';
    if (sub === '' && m === 'PATCH') {
      if (!need('admin')) return; const b = await bodyJSON(req);
      if (typeof b.name === 'string') cam.name = b.name.slice(0, 40);
      if (typeof b.url === 'string' && cam.type === 'rtsp') { if (!/^rtsps?:\/\/\S+$/i.test(b.url)) return json(res, 400, { error: 'Enter an rtsp:// address' }); cam.url = b.url; }
      for (const k of ['record', 'biome', 'enabled']) if (typeof b[k] === 'boolean') cam[k] = b[k];
      if (typeof b.audio === 'boolean') { if (b.audio && !b.ackAudio) return json(res, 400, { error: 'Confirm the audio-recording notice first' }); cam.audio = b.audio; }
      if (b.talk && typeof b.talk === 'object') {
        const want = { enabled: b.talk.enabled === true, doorbell: b.talk.doorbell === true };
        if ((want.enabled || want.doorbell) && cam.type !== 'browser') return json(res, 400, { error: 'Two-way talk and the doorbell button work with phone and webcam cameras only' });
        if (want.enabled && !(cam.talk && cam.talk.enabled) && !b.ackTalk) return json(res, 400, { error: 'Confirm the two-way talk notice first' });
        if (!want.enabled && cam.talk && cam.talk.enabled) talk.endAllFor(cam.id);
        cam.talk = { ...want, ack: want.enabled ? (cam.talk && cam.talk.ack) || { by: user.id, at: new Date().toISOString() } : undefined };
      }
      if (b.motion) cam.motion = { enabled: b.motion.enabled !== false, sensitivity: Math.max(1, Math.min(10, +b.motion.sensitivity || 5)), notify: b.motion.notify !== false };
      if (b.smart && typeof b.smart === 'object') {
        const cur = camSmart(cam), KINDS = ['person', 'vehicle', 'animal', 'package'];
        cam.smart = {
          enabled: typeof b.smart.enabled === 'boolean' ? b.smart.enabled : cur.enabled,
          kinds: Array.isArray(b.smart.kinds) ? b.smart.kinds.filter(k => KINDS.includes(k)) : cur.kinds,
          motionAlerts: typeof b.smart.motionAlerts === 'boolean' ? b.smart.motionAlerts : cur.motionAlerts,
          minScore: Number.isFinite(+b.smart.minScore) ? Math.max(0.3, Math.min(0.9, +b.smart.minScore)) : cur.minScore,
          zones: b.smart.zones !== undefined ? cleanZones(b.smart.zones) : cur.zones,
        };
        // Zones and alert choices apply instantly; no need to restart the camera.
        if (b.smart.zones !== undefined && Object.keys(b).every(k => k === 'smart')) { settings.save(); hub.broadcast({ type: 'cameras' }); return json(res, 200, { camera: camView(cam) }); }
      }
      settings.save();
      const old = cams.pipe(cam.id); if (old && old.device) old.device.close(4001); // phone camera reconnects with new settings
      const pipe = cams.restart(cam); pipe.motion.setSensitivity(cam.motion.sensitivity);
      hub.broadcast({ type: 'cameras' }); return json(res, 200, { camera: camView(cam) });
    }
    if (sub === '' && m === 'DELETE') { if (!need('admin')) return; const pp = cams.pipe(cam.id); if (pp && pp.device) pp.device.close(4002); cams.remove(cam.id); auth.revokeDevices(cam.id); settings.data.cameras = settings.data.cameras.filter(c => c.id !== cam.id); settings.save(); hub.broadcast({ type: 'cameras' }); return json(res, 200, { ok: true, note: 'Recordings were kept on disk; they are removed by the retention policy.' }); }
    if (sub === '/pair' && m === 'POST') { if (!need('admin')) return; if (cam.type !== 'browser') return json(res, 400, { error: 'Only phone/webcam cameras are paired' }); return json(res, 200, { token: auth.createDeviceToken(cam.id), ...linkInfo(req) }); }
    if (sub === '/live' && m === 'GET') {
      const pipe = cams.pipe(cam.id); if (!pipe) return json(res, 404, { error: 'Camera not running' });
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=spframe', 'Cache-Control': 'no-store', Connection: 'close' });
      let busy = false;
      const send = f => { if (busy || res.writableLength > 2e6) return; busy = true; res.write(`--spframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`); res.write(f); busy = !res.write('\r\n'); if (busy) res.once('drain', () => { busy = false; }); };
      if (pipe.latest) send(pipe.latest);
      pipe.viewers.add(send); req.on('close', () => pipe.viewers.delete(send)); return;
    }
    if (sub === '/snapshot' && m === 'GET') { const pipe = cams.pipe(cam.id); if (!pipe || !pipe.latest) return json(res, 404, { error: 'No picture yet' }); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); return res.end(pipe.latest); }
    if (sub === '/recordings' && m === 'GET') return json(res, 200, { recordings: cams.recordings(cam.id, url.searchParams.get('day')) });
    if (sub === '/identify' && m === 'POST') {
      const pipe = cams.pipe(cam.id); if (!pipe || !pipe.latest) return json(res, 404, { error: 'No picture yet' });
      const r = await biome.identifyJpeg(pipe.latest); lastIdentify.set(user.id, { jpeg: pipe.latest, r, cam }); return json(res, 200, { candidates: r.candidates });
    }
  }
  if (p === '/api/events' && m === 'GET') {
    if (!need()) return; const cam = url.searchParams.get('cam'); const lim = Math.min(500, +url.searchParams.get('limit') || 100);
    const list = events.data.list.filter(e => !cam || e.camId === cam).slice(0, lim).map(e => ({ ...e, segment: cams.findSegment(e.camId, new Date(e.ts).getTime()) }));
    return json(res, 200, { events: list });
  }
  if (p === '/api/identify' && m === 'POST') {
    if (!need()) return; const buf = await readBody(req, 15e6);
    if (!imageType(buf)) return json(res, 400, { error: 'Please choose a JPEG, PNG or WebP photo' });
    // Convert any phone photo (HEIC excluded) into a JPEG first.
    const jpeg = await toJpeg(buf); const r = await biome.identifyJpeg(jpeg);
    lastIdentify.set(user.id, { jpeg, r, cam: { id: 'upload', name: 'Photo upload' } }); return json(res, 200, { candidates: r.candidates });
  }
  if (p === '/api/identify/save' && m === 'POST') {
    if (!need()) return; const b = await bodyJSON(req); const li = lastIdentify.get(user.id);
    if (!li) return json(res, 400, { error: 'Identify something first' });
    const c = li.r.candidates.find(x => x.label === b.label && x.group === b.group); if (!c) return json(res, 400, { error: 'Pick one of the suggestions' });
    const sp = await biome.record(li.cam, { group: c.group, label: c.label, conf: c.conf, crop: li.r.plan[0] }, li.jpeg, li.r.img, true);
    return json(res, 200, { species: sp });
  }
  if (p === '/api/biome' && m === 'GET') { if (!need()) return; return json(res, 200, { species: biome.list(), db: identifier.dbStats(), sightings: biome.store.data.sightings.slice(0, 200) }); }
  if ((mm = /^\/api\/biome\/([\w-]+)$/.exec(p)) && m === 'PATCH') {
    if (!need()) return; const b = await bodyJSON(req);
    if (!['confirmed', 'rejected', 'unreviewed'].includes(b.status)) return json(res, 400, { error: 'Bad status' });
    const sp = biome.setStatus(mm[1], b.status); if (!sp) return json(res, 404, { error: 'Not found' }); hub.broadcast({ type: 'biome' }); return json(res, 200, { species: sp });
  }
  if (p === '/api/smart' && m === 'GET') { if (!need()) return; return json(res, 200, { ...detector.status(), installing: smartInstall, sizes: smartModels.SIZES_MB, labels: smartModels.LABELS }); }
  // Desktop app only: download and switch on a detector model from Settings (server installs use npm run smart-detection).
  if (p === '/api/smart/install' && m === 'POST') {
    if (!need('admin')) return; const b = await bodyJSON(req);
    if (!cfg.smart.modelDir || !fs.existsSync(path.join(cfg.root, 'addons', 'node_modules', 'onnxruntime-node'))) return json(res, 400, { error: 'On a server install, run: npm run smart-detection' });
    const size = ['s', 'l', 'x'].includes(b.size) ? b.size : 'l';
    if (smartInstall) return json(res, 409, { error: 'Already downloading' });
    smartInstall = { size, pct: 0 };
    hub.broadcast({ type: 'smart-install', ...smartInstall });
    smartModels.download(size, cfg.smart.modelDir, p => { smartInstall.pct = Math.round(p * 100); hub.broadcast({ type: 'smart-install', ...smartInstall }); })
      .then(() => {
        fs.writeFileSync(path.join(cfg.smart.modelDir, 'smart.json'), JSON.stringify({ size, sha256: smartModels.PINNED[size], installed: new Date().toISOString() }, null, 2));
        cfg.smart.size = size; detector.stop(); detector = new Detector(cfg); smart.det = detector;
        smartInstall = null; hub.broadcast({ type: 'smart-install', done: true, size });
      })
      .catch(e => { smartInstall = null; hub.broadcast({ type: 'smart-install', error: e.message }); });
    return json(res, 202, { started: true, size });
  }
  if (p === '/api/system' && m === 'GET') {
    if (!need()) return; let disk = null;
    try { const s = fs.statfsSync(cfg.dataDir); disk = { freeGB: +(s.bavail * s.bsize / 1e9).toFixed(1), totalGB: +(s.blocks * s.bsize / 1e9).toFixed(1) }; } catch {}
    return json(res, 200, { disk, retentionDays: cfg.recording.retentionDays, speciesDb: identifier.dbStats(), models: { insect: 1021, plant: 2101, bird: 964 }, uptimeSec: Math.round(process.uptime()), ntfy: !!cfg.ntfy.url, secure: isSecure(req), encryption: vault.status(), smart: detector.status() });
  }

  // ---- media ----
  if ((mm = /^\/media\/rec\/([\w-]+)\/([\w.-]+\.mp4)$/.exec(p))) { if (!need()) return; const r = cams.recordingFile(mm[1], mm[2]); return r ? serveMedia(req, res, r.file, 'video/mp4') : json(res, 404, {}); }
  if ((mm = /^\/media\/events\/([\w-]+)\/([\w.-]+\.jpg)$/.exec(p))) { if (!need()) return; const f = within(path.join(cfg.dataDir, 'events', mm[1]), mm[2]); return f ? serveMedia(req, res, f, 'image/jpeg') : json(res, 404, {}); }
  if ((mm = /^\/media\/biome\/([\w-]+)\/([\w.-]+\.jpg)$/.exec(p))) { if (!need()) return; const f = biome.photoPath(mm[1], mm[2]); return f ? serveMedia(req, res, f, 'image/jpeg') : json(res, 404, {}); }
  if ((mm = /^\/media\/species\/([\w.-]+)$/.exec(p))) { if (!need()) return; const f = within(path.join(cfg.dataDir, 'species-db', 'images'), mm[1]); return f ? serveFile(req, res, f) : json(res, 404, {}); }

  // ---- static ----
  if (m !== 'GET' && m !== 'HEAD') return json(res, 404, { error: 'Not found' });
  if (p === '/camera') return serveFile(req, res, path.join(PUBLIC, 'camera.html'));
  if (p === '/' || p === '/index.html') return serveFile(req, res, path.join(PUBLIC, 'index.html'));
  if (p === '/legal/third-party-notices.txt') return serveFile(req, res, path.join(cfg.root, 'THIRD_PARTY_NOTICES.txt'));
  const f = within(PUBLIC, decodeURIComponent(p.slice(1)));
  if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(req, res, f);
  return json(res, 404, { error: 'Not found' });
}
const lastIdentify = new Map();
// SHA-256 of our self-signed certificate. Put in invite/pairing links so the Android app can trust
// exactly this certificate on the home network (and nothing else).
let certFp = null;
try { if (cfg.https.enabled && fs.existsSync(cfg.https.cert)) certFp = new crypto.X509Certificate(fs.readFileSync(cfg.https.cert)).fingerprint256.replace(/:/g, '').toLowerCase(); } catch {}
const fpFor = req => (req.socket.encrypted && certFp ? certFp : null);
const publicBase = () => (/^https:\/\/[^/]+$/.test(cfg.publicUrl || '') ? cfg.publicUrl : null);
const linkInfo = req => { const base = publicBase(); return { base, fp: base ? null : fpFor(req), appUrl: cfg.appDownloadUrl, tailscaleAppUrl: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn' }; };
const okShare = u => typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*tailscale\.com\/\S+$/i.test(u.trim()) ? u.trim() : null;
function toJpeg(buf) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const t = imageType(buf); if (!t) return reject(new Error('Please choose a JPEG, PNG or WebP photo'));
    const demux = buf[0] === 0xff ? 'jpeg_pipe' : buf[0] === 0x89 ? 'png_pipe' : 'webp_pipe';
    const p = spawn(cfg.ffmpeg, ['-v', 'error', '-protocol_whitelist', 'pipe', '-f', demux, '-i', 'pipe:0', '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1']);
    const out = []; p.stdout.on('data', c => out.push(c)); p.on('error', reject);
    p.on('close', code => code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('Could not read that image (try a JPEG or PNG)')));
    p.stdin.on('error', () => {}); p.stdin.end(buf);
  });
}

function onRequest(req, res) {
  handle(req, res).catch(e => { if (!res.headersSent) json(res, 400, { error: e.message || 'Error' }); else res.end(); });
}

// ---------------- WebSockets ----------------
/* Browsers always send Origin on WebSocket handshakes; it must be this server (blocks cross-site hijacking). */
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;            // the Android app's background connection has no Origin
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
function onUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws') {
    if (!sameOrigin(req)) return socket.destroy();
    const user = auth.userFromToken(cookies(req).sp_session);
    if (!user) return socket.destroy();
    const ws = wsLib.upgrade(req, socket, head); if (!ws) return;
    const ua = req.headers['user-agent'] || '';
    clients.set(ws, { user, bg: url.searchParams.get('background') === '1', view: { page: 'cameras', cams: [] }, device: /Android|iPhone|Mobile/i.test(ua) ? 'phone' : 'computer' });
    ws.send({ type: 'hello', you: auth.publicUser(user), armed: settings.data.armed });
    if (!clients.get(ws).bg) hub.presence();
    ws.on('message', msg => {
      let d; try { d = JSON.parse(msg); } catch { return; }
      if (d.type === 'view') { const c = clients.get(ws); c.view = { page: String(d.page || '').slice(0, 30), cams: (d.cams || []).slice(0, 16).map(String), focus: !!d.focus }; hub.presence(); updateWatched(); }
      if (d.type === 'ping-family' && typeof d.text === 'string') hub.broadcast({ type: 'chat', from: user.name, color: user.color, text: d.text.slice(0, 280), ts: Date.now() });
    });
    ws.on('close', () => { const bg = clients.get(ws)?.bg; clients.delete(ws); if (!bg) hub.presence(); updateWatched(); });
    return;
  }
  if (url.pathname === '/ws/talk') {
    if (!sameOrigin(req)) return socket.destroy();
    const user = auth.userFromToken(cookies(req).sp_session);
    if (!user) return socket.destroy();
    const ws = wsLib.upgrade(req, socket, head); if (!ws) return;
    talk.addListener(ws, user, cams.get(String(url.searchParams.get('cam') || '')));
    devices.add(ws); ws.on('close', () => devices.delete(ws));
    return;
  }
  if (url.pathname === '/ws/cam-audio') {
    const camId = auth.deviceCam(url.searchParams.get('token'));
    const cam = camId && cams.get(camId);
    if (!cam || !cam.talk || !cam.talk.enabled) return socket.destroy();
    const ws = wsLib.upgrade(req, socket, head); if (!ws) return;
    talk.attachCamera(ws, cam);
    devices.add(ws); ws.on('close', () => devices.delete(ws));
    return;
  }
  if (url.pathname === '/ws/ingest') {
    const camId = auth.deviceCam(url.searchParams.get('token'));
    const cam = camId && cams.get(camId);
    if (!cam) return socket.destroy();
    const ws = wsLib.upgrade(req, socket, head); if (!ws) return;
    const pipe = cams.ensure(cam);
    if (pipe.device) pipe.device.close(4000); // newest device wins
    pipe.stop(); pipe.device = ws;
    let started = false;
    ws.send({ type: 'config', name: cam.name, fps: 15, talk: !!(cam.talk && cam.talk.enabled), doorbell: !!(cam.talk && cam.talk.doorbell) });
    ws.on('message', (data, binary) => {
      if (!binary) {
        let m; try { m = JSON.parse(data); } catch { return; }
        if (m.type === 'ring') ws.send({ type: 'ring-ok', sent: doorbell(cam) });
        return;
      }
      if (!started) { started = true; pipe.start(); }
      pipe.feed(data);
    });
    ws.on('close', () => { if (pipe.device === ws) { pipe.device = null; pipe.stop(); talk.end(cam.id, 'camera disconnected'); } devices.delete(ws); });
    devices.add(ws);
    return;
  }
  socket.destroy();
}
const devices = new Set();
function updateWatched() { const ids = new Set(); for (const c of clients.values()) if (!c.bg && c.view.page === 'cam' && c.view.focus) for (const id of c.view.cams || []) ids.add(id); smart.setWatched([...ids]); }
wsLib.heartbeat(() => [...clients.keys(), ...devices]);

// ---------------- start ----------------
let servers = 0;
if (cfg.http.enabled) { const s = http.createServer(onRequest); s.on('upgrade', onUpgrade); s.listen(cfg.http.port, cfg.http.host, () => {
  const origin = `http://${cfg.http.host}:${s.address().port}`;
  console.log(`Spectacle listening on ${origin}`);
  if (process.env.SPECTACLE_DESKTOP === '1' && process.parentPort) process.parentPort.postMessage({ type: 'ready', origin });
}); servers++; }
if (cfg.https.enabled) {
  if (fs.existsSync(cfg.https.cert) && fs.existsSync(cfg.https.key)) {
    const s = https.createServer({ cert: fs.readFileSync(cfg.https.cert), key: fs.readFileSync(cfg.https.key) }, onRequest); s.on('upgrade', onUpgrade);
    s.listen(cfg.https.port, cfg.https.host, () => console.log(`Spectacle listening on https://${cfg.https.host}:${cfg.https.port}`)); servers++;
  } else console.warn('HTTPS disabled: no certificate found (run ./install.sh or set https.enabled=false)');
}
if (!servers) { console.error('No server enabled in config.json'); process.exit(1); }
cams.startAll(); cams.sweep();
setImmediate(() => { try { const n = biome.encryptOldPhotos(); if (n) console.log(`Encrypted ${n} older biome photos`); } catch (e) { console.warn('encrypting photos', e.message); } });
console.log(`Encryption at rest: on (${vault.status().keySource === 'sealed' ? 'key sealed to this machine' : 'key in data/vault.key — run install.sh to seal it to this machine'})`);
const st = identifier.dbStats();
console.log(st.total ? `Offline species database: ${st.explained}/${st.total} species explained` : 'Offline species database not downloaded yet — run: npm run species-db');
const shutdown = () => { for (const c of cams.list) cams.remove(c.id); auth.store.flush(); settings.flush(); events.flush(); biome.store.flush(); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

// Electron's local runtime requests the same orderly shutdown as a system service.
if (process.env.SPECTACLE_DESKTOP === '1' && process.parentPort) process.parentPort.on('message', e => { if (e.data?.type === 'shutdown') shutdown(); });
