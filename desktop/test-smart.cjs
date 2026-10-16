'use strict';
// Desktop app: smart detection inside Electron's own runtime.
// Turns it on the way a user does (Settings → "Turn on smart detection" = POST /api/smart/install),
// then streams a person walking into view and expects a "Person" alert.
const { app, utilityProcess } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepareRuntime, readSetupCode } = require('./runtime');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectacle-desktop-smart-'));
const root = path.join(__dirname, '..');
let child, origin, cookie = '', feeder;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const note = m => { console.log('PASS: ' + m); if (process.env.GITHUB_ACTIONS) console.log('::notice title=desktop smart detection::' + m); };
async function api(route, body, method) {
  const r = await fetch(origin + route, { method: method || (body ? 'POST' : 'GET'), headers: { Cookie: cookie, 'X-Spectacle': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  const j = await r.json(); assert(r.ok, `${route}: ${JSON.stringify(j)}`); return j;
}
app.whenReady().then(async () => {
  const config = prepareRuntime(tmp, 'ffmpeg');
  const c = JSON.parse(fs.readFileSync(config)); c.smart.size = 's'; c.biome = { enabled: false }; fs.writeFileSync(config, JSON.stringify(c));
  await new Promise((resolve, reject) => {
    child = utilityProcess.fork(path.join(root, 'server/index.js'), [], { cwd: root, env: { ...process.env, SPECTACLE_CONFIG: config, SPECTACLE_DESKTOP: '1' }, stdio: 'pipe' });
    child.stderr.on('data', d => process.stderr.write(d)); child.stdout.on('data', d => process.stdout.write(d));
    const t = setTimeout(() => reject(Error('runtime did not start')), 20000);
    child.on('message', m => { if (m.type === 'ready') { origin = m.origin; clearTimeout(t); resolve(); } });
  });
  await api('/api/setup', { setupCode: readSetupCode(tmp), username: 'desk', name: 'Desk', password: 'local-only-password', consent: { terms: true, presence: true } });
  let st = await api('/api/smart');
  assert(st.canInstall && !st.available, 'fresh desktop should offer one-tap install: ' + JSON.stringify(st));
  note('fresh desktop app offers "Turn on smart detection"');
  await api('/api/smart/install', { size: 's' });
  for (let i = 0; i < 240 && !st.available; i++) { await sleep(500); st = await api('/api/smart'); }
  assert(st.available, 'model did not load: ' + JSON.stringify(st));
  note(`model downloaded, verified and loaded inside Electron (${st.model})`);
  assert(fs.existsSync(path.join(tmp, 'addons', 'models', 'dfine-s.onnx')), 'model saved in the user data folder');

  const { camera } = await api('/api/cameras', { name: 'Porch', type: 'browser', ackPlacement: true });
  await api('/api/cameras/' + camera.id, { smart: { kinds: ['person'], zones: [] } }, 'PATCH');
  const { token } = await api(`/api/cameras/${camera.id}/pair`, {});
  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws/ingest?token=' + token); ws.binaryType = 'arraybuffer';
  await new Promise((res, rej) => { ws.onmessage = res; ws.onerror = rej; });
  feeder = spawn('ffmpeg', ['-v', 'error', '-re', '-loop', '1', '-i', path.join(root, 'test-images/sunflower.bmp'), '-loop', '1', '-i', path.join(root, 'test-images/grace_hopper.jpg'),
    '-filter_complex', "[0:v]scale=640:480,fps=15[bg];[1:v]scale=210:246[p];[bg][p]overlay=x='-200+min(t,6)*110':y=230:shortest=1,format=yuv420p",
    '-t', '40', '-r', '15', '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '1M', '-f', 'webm', 'pipe:1']);
  feeder.stdout.on('data', d => ws.readyState === 1 && ws.send(new Uint8Array(d)));
  let ev = null;
  for (let i = 0; i < 70 && !ev; i++) { await sleep(500); ev = (await api('/api/events')).events.find(e => e.kind === 'person'); }
  assert(ev, 'no person alert');
  note(`person walking in → "${ev.kind}" alert at ${ev.camName} (≈${(await api('/api/smart')).avgMs} ms per check)`);
  feeder.kill(); ws.close(); child.postMessage({ type: 'shutdown' });
  await new Promise(r => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
  fs.rmSync(tmp, { recursive: true, force: true }); app.exit(0);
}).catch(e => { console.error(e); feeder?.kill(); child?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); app.exit(1); });
