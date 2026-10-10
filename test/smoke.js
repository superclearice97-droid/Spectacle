#!/usr/bin/env node
// End-to-end smoke test: starts a throwaway server, creates an admin, adds a phone-style camera,
// streams a synthetic video into it, and checks live view, motion events, recording and the biome log.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectacle-test-'));
const PORT = 18080 + Math.floor(Math.random() * 1000);
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ dataDir: path.join(tmp, 'data'), http: { enabled: true, host: '127.0.0.1', port: PORT }, https: { enabled: false }, recording: { segmentMinutes: 1, retentionDays: 1, minFreeGB: 0 }, motion: { fps: 4, cooldownSec: 5 }, biome: { intervalSec: 5 }, publicUrl: 'https://spectacle.example-tailnet.ts.net' }));
const BASE = `http://127.0.0.1:${PORT}`;
let cookie = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ✓ ' + msg); };

async function call(p, body, method) {
  const r = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'X-Spectacle': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${j.error || r.status}`);
  return j;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: { ...process.env, SPECTACLE_CONFIG: cfgFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => process.stdout.write('    [server] ' + d)); srv.stderr.on('data', d => process.stdout.write('    [server] ' + d));
  let feeder;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/state'); break; } catch { await sleep(100); } }
    console.log('Accounts & consent');
    let noCode = false; try { await call('/api/setup', { name: 'X', username: 'intruder', password: 'correct horse battery', consent: { terms: true, presence: true } }); } catch { noCode = true; }
    ok(noCode, 'admin account can\'t be claimed without the setup code');
    const anonState = await (await fetch(BASE + '/api/state')).json(); ok(anonState.armed === undefined, 'signed-out visitors can\'t see whether the alarm is armed');
    const code = /setup code: (\S+)/.exec(fs.readFileSync(path.join(tmp, 'data/SETUP-CODE.txt'), 'utf8'))[1];
    await call('/api/setup', { setupCode: code, name: 'Test Admin', username: 'admin', password: 'correct horse battery', consent: { terms: true, presence: true } });
    ok(!fs.existsSync(path.join(tmp, 'data/SETUP-CODE.txt')), 'setup code removed once used');
    const st = await call('/api/state'); ok(st.user && st.user.role === 'admin', 'first account becomes admin');
    let rejected = false; try { await call('/api/cameras', { name: 'x', type: 'browser' }); } catch { rejected = true; } ok(rejected, 'camera needs placement acknowledgement');
    const { camera } = await call('/api/cameras', { name: 'Garden', type: 'browser', ackPlacement: true });
    const { token } = await call(`/api/cameras/${camera.id}/pair`, {});
    ok(token.length > 20, 'pairing token issued');
    const inv = await call('/api/invites', { role: 'member', shareUrl: 'https://login.tailscale.com/admin/invite/abc123' });
    ok(inv.code && inv.base === 'https://spectacle.example-tailnet.ts.net' && inv.shareUrl && !inv.fp, 'invite uses the private Tailscale address + share link');
    let badShare = false; try { await call('/api/invites', { shareUrl: 'https://evil.example.com/x' }); } catch { badShare = true; } ok(badShare, 'non-Tailscale share links rejected');

    console.log('Presence');
    const viewer = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie } });
    const msgs = []; viewer.onmessage = e => msgs.push(JSON.parse(e.data));
    await new Promise(r => viewer.onopen = r);
    viewer.send(JSON.stringify({ type: 'view', page: 'cam', cams: [camera.id], focus: true }));
    await sleep(300);
    const pres = msgs.filter(m => m.type === 'presence').pop();
    ok(pres && pres.users[0].viewing.includes(camera.id), 'others can see which camera you are watching');

    console.log('Phone camera stream');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/ingest?token=${token}`);
    ws.binaryType = 'arraybuffer';
    await new Promise((res, rej) => { ws.onmessage = res; ws.onerror = rej; });
    // Sunflower scene + a small dark "bug" crawling across it, encoded like a phone's MediaRecorder (VP8 WebM).
    feeder = spawn('ffmpeg', ['-v', 'error', '-re', '-loop', '1', '-i', path.join(ROOT, 'test-images/sunflower.bmp'),
      '-f', 'lavfi', '-i', 'color=c=0x2a1a0a:s=80x150:r=15',
      '-filter_complex', "[0:v]scale=640:480,fps=15[bg];[bg][1:v]overlay=x='mod(t*90,560)':y=150:shortest=1,format=yuv420p", '-t', '40', '-r', '15', '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '1M', '-f', 'webm', 'pipe:1']);
    feeder.stdout.on('data', c => ws.readyState === 1 && ws.send(new Uint8Array(c)));
    await sleep(6000);
    const cams = await call('/api/cameras'); ok(cams.cameras[0].status === 'live', 'camera is live');
    const live = await fetch(`${BASE}/api/cameras/${camera.id}/snapshot`, { headers: { Cookie: cookie } });
    const jpg = Buffer.from(await live.arrayBuffer()); ok(live.ok && jpg[0] === 0xff && jpg[1] === 0xd8, 'live snapshot is a JPEG (' + jpg.length + ' bytes)');
    const ctrl = new AbortController();
    const mj = await fetch(`${BASE}/api/cameras/${camera.id}/live`, { headers: { Cookie: cookie }, signal: ctrl.signal });
    const reader = mj.body.getReader(); let got = 0, t0 = Date.now();
    while (Date.now() - t0 < 2000) { const { value } = await reader.read(); got += value.length; }
    ctrl.abort(); ok(got > 50000, `MJPEG live view streaming (${(got / 1024).toFixed(0)} KB in 2s)`);

    console.log('Motion & alerts');
    await sleep(8000);
    const ev = await call('/api/events'); ok(ev.events.length > 0, `motion events logged (${ev.events.length})`);
    ok(msgs.some(m => m.type === 'alert' && m.kind === 'motion'), 'family received live motion alert');
    ok(fs.existsSync(path.join(tmp, 'data/events', camera.id, ev.events[0].snapshot)), 'motion snapshot saved');

    console.log('Biome log (offline identification)');
    let bio; for (let i = 0; i < 25; i++) { bio = await call('/api/biome'); if (bio.species.length) break; await sleep(1000); }
    const sun = bio.species.find(s => s.scientific === 'Helianthus annuus');
    ok(sun, 'sunflower identified passively: ' + bio.species.map(s => `${s.common} ${Math.round(s.bestConf * 100)}%`).join(', '));
    const folder = path.join(tmp, 'data/biome', sun.folder);
    ok(fs.existsSync(path.join(folder, 'info.md')) && fs.readdirSync(path.join(folder, 'photos')).length, 'species folder with info.md and photos: biome/' + sun.folder);
    ok(msgs.some(m => m.type === 'sighting'), 'family notified of new species');

    console.log('Manual identify (photo upload)');
    const up = await fetch(BASE + '/api/identify', { method: 'POST', headers: { 'X-Spectacle': '1', 'Content-Type': 'image/jpeg', Cookie: cookie }, body: fs.readFileSync(path.join(ROOT, 'test-images/parrot.jpg')) });
    const upj = await up.json(); ok(upj.candidates && upj.candidates[0].scientific === 'Ara macao', 'uploaded photo → ' + upj.candidates[0].common + ' ' + Math.round(upj.candidates[0].conf * 100) + '%');
    const saved = await call('/api/identify/save', { label: upj.candidates[0].label, group: upj.candidates[0].group }); ok(saved.species.status === 'confirmed', 'manual ID saved as confirmed folder');

    console.log('Recording');
    feeder.kill(); ws.close(); await sleep(3000);
    const recs = await call(`/api/cameras/${camera.id}/recordings`);
    ok(recs.recordings.length && recs.recordings[0].size > 100000, `recording written (${recs.recordings.map(r => (r.size / 1e6).toFixed(1) + ' MB').join(', ')})`);
    const dl = await fetch(`${BASE}/media/rec/${camera.id}/${recs.recordings[0].file}`, { headers: { Cookie: cookie } });
    const recFile = path.join(tmp, 'download.mp4'); fs.writeFileSync(recFile, Buffer.from(await dl.arrayBuffer()));
    const probe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', recFile]);
    let dur = ''; probe.stdout.on('data', d => dur += d); await new Promise(r => probe.on('close', r));
    ok(parseFloat(dur) > 5, `recording is playable MP4 (${parseFloat(dur).toFixed(1)}s)`);
    const rr = await fetch(`${BASE}/media/rec/${camera.id}/${recs.recordings[0].file}`, { headers: { Cookie: cookie, Range: 'bytes=0-99' } });
    ok(rr.status === 206, 'recordings stream with seeking (HTTP range)');

    console.log('Security');
    const anon = await fetch(`${BASE}/api/cameras/${camera.id}/snapshot`); ok(anon.status === 401, 'camera feed requires sign-in');
    const csrf = await fetch(BASE + '/api/armed', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"armed":false}' }); ok(csrf.status === 403, 'cross-site requests blocked');
    const trav = await fetch(`${BASE}/media/rec/${camera.id}/..%2F..%2Fsecrets.json`, { headers: { Cookie: cookie } }); ok(trav.status === 404, 'path traversal blocked');

    console.log('Encryption at rest');
    const D = path.join(tmp, 'data'), readAll = d => fs.readdirSync(d, { recursive: true }).map(f => path.join(d, f)).filter(f => fs.statSync(f).isFile());
    for (const f of ['accounts.json', 'settings.json', 'events.json', 'biome.json', 'secrets.json']) ok(fs.readFileSync(path.join(D, f)).subarray(0, 4).toString() === 'SPXJ', `${f} is encrypted`);
    ok(!fs.readFileSync(path.join(D, 'accounts.json')).includes('admin'), 'usernames are not readable on disk');
    const sealed = await (async () => { for (let i = 0; i < 30; i++) { const enc = fs.existsSync(path.join(D, 'recordings', camera.id)) ? fs.readdirSync(path.join(D, 'recordings', camera.id)).filter(f => f.endsWith('.spx')) : []; if (enc.length) return enc; await sleep(1000); } return []; })();
    ok(sealed.length && readAll(path.join(D, 'recordings')).every(f => f.endsWith('.spx') && !fs.readFileSync(f).includes('ftyp')), 'finished recordings are encrypted on disk');
    ok(readAll(path.join(D, 'events')).every(f => fs.readFileSync(f)[0] !== 0xff), 'motion snapshots are encrypted on disk');
    ok(readAll(path.join(D, 'biome')).filter(f => f.endsWith('.jpg')).every(f => fs.readFileSync(f)[0] !== 0xff), 'biome photos are encrypted on disk');
    const snapUrl = `${BASE}/media/events/${camera.id}/${ev.events[0].snapshot}`;
    const snap = await fetch(snapUrl, { headers: { Cookie: cookie } }); const sb = Buffer.from(await snap.arrayBuffer());
    ok(snap.ok && sb[0] === 0xff && sb[1] === 0xd8 && snap.headers.get('cache-control') === 'no-store', 'signed-in family get the decrypted picture, never cached');

    console.log('Hardening');
    const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie, Origin: 'https://evil.example.com' } });
    const evilOpen = await new Promise(r => { evil.onopen = () => r(true); evil.onerror = () => r(false); evil.onclose = () => r(false); });
    ok(!evilOpen, 'WebSocket from another website refused');
    const notImg = await fetch(BASE + '/api/identify', { method: 'POST', headers: { 'X-Spectacle': '1', 'Content-Type': 'application/octet-stream', Cookie: cookie }, body: '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\nfile:///etc/passwd\n' });
    ok(notImg.status === 400, 'uploads that aren\'t photos are refused before ffmpeg sees them');
    let badPush = false; try { await call('/api/push/subscribe', { subscription: { endpoint: 'https://192.168.1.1/admin', keys: { p256dh: 'x', auth: 'y' } } }); } catch { badPush = true; } ok(badPush, 'push subscriptions limited to real push services');
    const second = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'X-Spectacle': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
    const other = second.headers.get('set-cookie').split(';')[0];
    await call('/api/me/password', { current: 'correct horse battery', next: 'an even longer passphrase' });
    const otherNow = await fetch(BASE + '/api/cameras', { headers: { Cookie: other } }); ok(otherNow.status === 401, 'changing the password signs out other devices');
    viewer.close();
    console.log('\nAll checks passed.');
  } catch (e) { console.error('\n' + e.message); process.exitCode = 1; }
  finally { feeder && feeder.kill(); srv.kill('SIGTERM'); await sleep(1800); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(); }
})();
