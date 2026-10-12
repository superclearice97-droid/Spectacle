'use strict';
const { app, BrowserWindow, Menu, dialog, shell, session, utilityProcess, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { prepareRuntime, readSetupCode } = require('./runtime');
app.setName('Spectacle');
let child, win, origin, quitting = false, cameraWindow, alertSocket;
const userData = app.getPath('userData');
const root = app.isPackaged ? path.join(process.resourcesPath, 'spectacle') : path.join(__dirname, '..');
const logFile = path.join(userData, 'desktop.log');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(start).catch(async e => {
    await dialog.showMessageBox({ type: 'error', title: 'Spectacle could not start', message: e.message, detail: `Diagnostic log: ${logFile}` });
    app.quit();
  });
}
function log(data) { fs.appendFileSync(logFile, data.toString(), { mode: 0o600 }); }
function safeURL(url) { try { return new URL(url).origin === origin; } catch { return false; } }
function makeWindow(options = {}) {
  const w = new BrowserWindow({ width: 1280, height: 900, minWidth: 420, minHeight: 600,
    backgroundColor: '#0e1311', icon: path.join(root, 'public', 'icon-512.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }, ...options });
  w.webContents.on('will-navigate', (e, url) => { if (!safeURL(url)) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (safeURL(url)) { const extra = makeWindow(); extra.loadURL(url); }
    else if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return w;
}
async function start() {
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.old');
  const ffmpeg = 'ffmpeg';
  try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 5000 }); }
  catch { throw new Error('FFmpeg is missing. Install ffmpeg using your Linux package manager, then reopen Spectacle.'); }
  const config = prepareRuntime(userData, ffmpeg);
  const ready = new Promise((resolve, reject) => {
    child = utilityProcess.fork(path.join(root, 'server', 'index.js'), [], {
      cwd: root, env: { ...process.env, SPECTACLE_CONFIG: config, SPECTACLE_DESKTOP: '1' },
      stdio: 'pipe', serviceName: 'Spectacle local camera server',
    });
    const timer = setTimeout(() => reject(new Error('The local camera server did not start within 30 seconds.')), 30000);
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.on('message', msg => { if (msg.type === 'ready') { clearTimeout(timer); origin = msg.origin; resolve(); } });
    child.on('exit', code => {
      clearTimeout(timer);
      if (!origin) reject(new Error(`The local camera server exited (${code}).`));
      else if (!quitting) { dialog.showErrorBox('Spectacle stopped', `The local server stopped (${code}). Reopen Spectacle. See ${logFile}.`); app.quit(); }
    });
  });
  await ready;
  const trusted = (wc, requestOrigin) => safeURL(requestOrigin) && safeURL(wc?.getURL());
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(trusted(wc, details.requestingUrl) && (permission === 'media' && details.mediaTypes?.every(t => t === 'video') || ['notifications', 'fullscreen'].includes(permission)));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestOrigin, details) =>
    trusted(wc, requestOrigin) && (permission === 'media' && details.mediaType === 'video' || ['notifications', 'fullscreen'].includes(permission)));
  // Forward local motion/species alerts to Linux notifications, including while minimized.
  const connectAlerts = async () => {
    alertSocket?.close(); alertSocket = null;
    const cookies = await session.defaultSession.cookies.get({ url: origin, name: 'sp_session' });
    if (!cookies.length || quitting) return;
    const ws = alertSocket = new WebSocket(origin.replace('http:', 'ws:') + '/ws?background=1', { headers: { Cookie: `sp_session=${cookies[0].value}` } });
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type !== 'alert' || !Notification.isSupported()) return;
      const n = new Notification({ title: String(m.title || 'Spectacle'), body: String(m.body || '') });
      n.on('click', () => { win?.show(); win?.focus(); if (typeof m.url === 'string' && m.url.startsWith('/#')) win?.loadURL(origin + m.url); }); n.show();
    };
    ws.onerror = () => {};
  };
  session.defaultSession.cookies.on('changed', connectAlerts);
  await connectAlerts();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Spectacle', submenu: [
      { label: 'Use this computer’s camera', click: useWebcam },
      { label: 'Show setup code', click: () => dialog.showMessageBox(win, { message: readSetupCode(userData) || 'Already set up. Sign in with your local account.' }) },
      { label: 'Open local data folder', click: () => shell.openPath(path.join(userData, 'data')) },
      { type: 'separator' }, { role: 'quit' },
    ] }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
  win = makeWindow(); win.on('closed', () => { win = null; });
  await win.loadURL(origin);
  const code = readSetupCode(userData);
  if (code) await dialog.showMessageBox(win, { title: 'Set up this computer', message: `Your setup code: ${code}`, detail: 'Create your local admin account in the app. This computer works independently; no phone, Tailscale, or external server is needed.' });
}
async function api(route, body) {
  const cookies = await session.defaultSession.cookies.get({ url: origin });
  const r = await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: {
    Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), 'X-Spectacle': '1', 'Content-Type': 'application/json',
  }, body: body ? JSON.stringify(body) : undefined });
  const result = await r.json(); if (!r.ok) throw new Error(result.error || 'Sign in first.'); return result;
}
async function useWebcam() {
  try {
    if (cameraWindow && !cameraWindow.isDestroyed()) return cameraWindow.focus();
    const { user } = await api('/api/state'); if (user?.role !== 'admin') throw new Error('Create or sign in to your local admin account first.');
    const ack = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'I agree — open camera'], defaultId: 0,
      message: 'Use this computer’s webcam?', detail: 'Only record places you are allowed to record, and tell household members and guests. Audio is disabled. Keep the camera window open to continue recording.' });
    if (ack.response !== 1) return;
    const { cameras } = await api('/api/cameras');
    const existing = cameras.find(c => c.name === 'This computer' && c.type === 'browser');
    const camera = existing || (await api('/api/cameras', { name: 'This computer', type: 'browser', ackPlacement: true })).camera;
    const { token } = await api(`/api/cameras/${camera.id}/pair`, {});
    cameraWindow = makeWindow({ width: 800, height: 700, title: 'Spectacle — local webcam' });
    await cameraWindow.loadURL(origin + '/camera#token=' + encodeURIComponent(token));
  } catch (e) { await dialog.showMessageBox(win, { type: 'error', message: e.message }); }
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', e => {
  if (quitting || !child) return;
  e.preventDefault(); quitting = true; alertSocket?.close();
  child.postMessage({ type: 'shutdown' });
  const timer = setTimeout(() => { child?.kill(); app.exit(); }, 5000);
  child.once('exit', () => { clearTimeout(timer); app.exit(); });
});
