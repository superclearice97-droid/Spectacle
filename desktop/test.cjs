'use strict';
// Exercises the packaged runtime API and a real Chromium local camera without a phone/external server.
const { app, BrowserWindow, utilityProcess, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareRuntime, readSetupCode } = require('./runtime');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectacle-desktop-test-'));
const root = path.join(__dirname, '..');
let child, origin, cookie = '', win;
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(route, body) {
  const response = await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Spectacle': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const json = await response.json(); assert(response.ok, `${route}: ${JSON.stringify(json)}`); return json;
}
app.whenReady().then(async () => {
  const config = prepareRuntime(tmp, 'ffmpeg');
  assert.equal(JSON.parse(fs.readFileSync(config)).http.host, '127.0.0.1');
  assert.equal(JSON.parse(fs.readFileSync(config)).https.enabled, false);
  await new Promise((resolve, reject) => {
    child = utilityProcess.fork(path.join(root, 'server/index.js'), [], { cwd: root, env: { ...process.env, SPECTACLE_CONFIG: config, SPECTACLE_DESKTOP: '1' }, stdio: 'pipe' });
    child.stderr.on('data', d => process.stderr.write(d));
    child.stdout.on('data', d => process.stdout.write(d));
    const timer = setTimeout(() => reject(Error('No runtime readiness message')), 15000);
    child.on('message', msg => { if (msg.type === 'ready') { origin = msg.origin; clearTimeout(timer); resolve(); } });
    child.on('exit', code => reject(Error(`Runtime exited: ${code}`)));
  });
  const code = readSetupCode(tmp); assert(code);
  await api('/api/setup', { setupCode: code, username: 'desktop', name: 'Desktop', password: 'local-only-password', consent: { terms: true, presence: true } });
  assert.equal(readSetupCode(tmp), null);
  assert.equal((await api('/api/state')).user.role, 'admin');
  const { camera } = await api('/api/cameras', { name: 'Local webcam', type: 'browser', ackPlacement: true, biome: false });
  const { token } = await api(`/api/cameras/${camera.id}/pair`, {});
  const [name, value] = cookie.split('='); await session.defaultSession.cookies.set({ url: origin, name, value });
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler(() => true);
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(origin);
  assert.equal(await win.webContents.executeJavaScript('typeof require'), 'undefined');
  await win.loadURL(origin + '/camera#token=' + token);
  await win.webContents.executeJavaScript("document.querySelector('#ack').checked = true; document.querySelector('#start').disabled = false; document.querySelector('#start').click();");
  let live = false;
  for (let i = 0; i < 40; i++) { await sleep(500); if ((await api('/api/cameras')).cameras[0].status === 'live') { live = true; break; } }
  assert(live, 'local webcam did not become live');
  const jpg = await fetch(origin + `/api/cameras/${camera.id}/snapshot`, { headers: { Cookie: cookie } });
  assert(jpg.ok); assert.equal(new Uint8Array(await jpg.arrayBuffer())[0], 255);
  console.log('PASS: independent local server, account, sandboxed window, webcam ingest and snapshot.');
  win.destroy();
  child.postMessage({ type: 'shutdown' });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('Server failed to stop')), 5000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
  console.log('PASS: local runtime shuts down cleanly.');
  fs.rmSync(tmp, { recursive: true, force: true }); app.exit(0);
}).catch(e => { console.error(e); child?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); app.exit(1); });
