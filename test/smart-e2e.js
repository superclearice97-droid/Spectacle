#!/usr/bin/env node
// End-to-end test of smart detection with the real model (needs `npm run smart-detection` first; CI does this).
// A phone-style camera shows a garden; a person walks in from the left and stops inside the "Right side" zone.
// Expect: live labels for the viewer, then exactly one "Person in Right side" alert with a snapshot and boxes.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
if (!fs.existsSync(path.join(ROOT, 'addons', 'node_modules', 'onnxruntime-node'))) { console.log('Smart detection not installed; skipping (run: npm run smart-detection)'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectacle-smart-'));
const PORT = 19080 + Math.floor(Math.random() * 800);
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ dataDir: path.join(tmp, 'data'), http: { enabled: true, host: '127.0.0.1', port: PORT }, https: { enabled: false }, recording: { segmentMinutes: 1, retentionDays: 1, minFreeGB: 0 }, motion: { fps: 4, cooldownSec: 60 }, biome: { enabled: false } }));
const BASE = `http://127.0.0.1:${PORT}`;
let cookie = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); if (process.env.GITHUB_ACTIONS) console.log('::notice title=smart detection::' + m); };
async function call(p, body, method) {
  const r = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'X-Spectacle': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${j.error || r.status}`); return j;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: { ...process.env, SPECTACLE_CONFIG: cfgFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
  let feeder;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/state'); break; } catch { await sleep(100); } }
    const code = /setup code: (\S+)/.exec(fs.readFileSync(path.join(tmp, 'data/SETUP-CODE.txt'), 'utf8'))[1];
    await call('/api/setup', { setupCode: code, name: 'Admin', username: 'admin', password: 'correct horse battery', consent: { terms: true, presence: true } });
    let st; for (let i = 0; i < 60; i++) { st = await call('/api/smart'); if (st.available || st.error) break; await sleep(500); }
    ok(st.available, `smart detection loaded (${st.model})`);

    const { camera } = await call('/api/cameras', { name: 'Garden', type: 'browser', ackPlacement: true });
    const r = await call('/api/cameras/' + camera.id, { smart: { kinds: ['person'], zones: [{ name: 'Right side', points: [[0.5, 0], [1, 0], [1, 1], [0.5, 1]], kinds: ['person'] }] } }, 'PATCH');
    ok(r.camera.smart.zones.length === 1 && r.camera.smart.zones[0].name === 'Right side', 'zone saved');
    let bad = false; try { await call('/api/cameras/' + camera.id, { smart: { zones: [{ points: [[0, 0]] }] } }, 'PATCH'); } catch { bad = true; } ok(bad, 'broken zone rejected');
    const { token } = await call(`/api/cameras/${camera.id}/pair`, {});

    const viewer = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie } });
    const msgs = []; viewer.onmessage = e => msgs.push(JSON.parse(e.data));
    await new Promise(res => viewer.onopen = res);
    viewer.send(JSON.stringify({ type: 'view', page: 'cam', cams: [camera.id], focus: true }));

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/ingest?token=${token}`); ws.binaryType = 'arraybuffer';
    await new Promise((res, rej) => { ws.onmessage = res; ws.onerror = rej; });
    // Garden background; a person (Grace Hopper's portrait) walks in from the left and stops on the right.
    feeder = spawn('ffmpeg', ['-v', 'error', '-re', '-loop', '1', '-i', path.join(ROOT, 'test-images/sunflower.bmp'),
      '-loop', '1', '-i', path.join(ROOT, 'test-images/grace_hopper.jpg'),
      '-filter_complex', "[0:v]scale=640:480,fps=15[bg];[1:v]scale=210:246[p];[bg][p]overlay=x='-200+min(t,6)*110':y=230:shortest=1,format=yuv420p",
      '-t', '45', '-r', '15', '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '1M', '-f', 'webm', 'pipe:1']);
    feeder.stdout.on('data', c => ws.readyState === 1 && ws.send(new Uint8Array(c)));

    let ev = null;
    for (let i = 0; i < 80 && !ev; i++) { await sleep(500); ev = msgs.find(m => m.type === 'event' && m.event.kind === 'person'); }
    const live = msgs.filter(m => m.type === 'detections' && m.objects.some(o => o.label === 'person'));
    ok(live.length > 0, `live "person" labels sent to the viewer (${live.length} updates)`);
    ok(ev, 'person alert raised');
    ev = ev.event;
    ok(ev.zone === 'Right side' && ev.notified, `alert says "Person in ${ev.zone}" and was sent to the family`);
    ok(ev.boxes.some(b => b.label === 'person' && b.box.x + b.box.w / 2 > 0.5), 'event includes the person\'s box on the right');
    ok(msgs.some(m => m.type === 'alert' && /Person in Right side/.test(m.title)), 'family alert text: ' + (msgs.find(m => m.type === 'alert') || {}).title);
    const snap = await fetch(`${BASE}/media/events/${camera.id}/${ev.snapshot}`, { headers: { Cookie: cookie } });
    ok(snap.ok && (await snap.arrayBuffer()).byteLength > 1000, 'snapshot saved');
    await sleep(6000);
    const all = (await call('/api/events')).events.filter(e => e.kind === 'person');
    ok(all.length === 1, 'standing still in the zone doesn\'t repeat the alert');
    ok(!(await call('/api/events')).events.some(e => !e.kind), 'no plain "motion" alerts while smart detection covers the camera');
    console.log(`\nSmart detection end-to-end passed (≈${(await call('/api/smart')).avgMs} ms per check).`);
  } catch (e) { console.error('\n' + e.message + '\n--- server log ---\n' + log.slice(-3000)); process.exitCode = 1; }
  finally { feeder && feeder.kill(); srv.kill('SIGTERM'); await sleep(1800); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(); }
})();
