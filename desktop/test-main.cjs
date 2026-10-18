'use strict';
// Exercise the real desktop entry point: its menu, permissions, private server and shutdown.
const { app, BrowserWindow, dialog, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectacle-main-test-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
dialog.showMessageBox = async () => ({ response: 1 });
dialog.showErrorBox = (title, detail) => { throw Error(title + ': ' + detail); };
// The execution container forbids Unix sockets; exercise app startup without Chromium's process lock.
app.requestSingleInstanceLock = () => true;
require('./main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = (window, code) => window.webContents.executeJavaScript(code);
async function until(check, message) {
  for (let i = 0; i < 80; i++) { const r = await check(); if (r) return r; await sleep(250); }
  throw Error(message);
}
app.whenReady().then(async () => {
  const window = await until(() => BrowserWindow.getAllWindows().find(w => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(w.webContents.getURL())), 'Main window never loaded');
  await until(() => !window.webContents.isLoading(), 'Main page did not load');
  const { readSetupCode } = require('./runtime');
  const code = readSetupCode(tmp); assert(code);
  const result = await js(window, `fetch('/api/setup', {method:'POST',headers:{'X-Spectacle':'1','Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ setupCode: code, username: 'owner', name: 'Owner', password: 'standalone-test-password', consent: { terms: true, presence: true } })})}).then(r=>r.json())`);
  assert.equal(result.user.role, 'admin');
  const menu = Menu.getApplicationMenu();
  const item = label => menu.items[0].submenu.items.find(i => i.label === label);
  assert(item('Add a USB camera, capture card or phone…'), 'USB camera menu item');
  assert.equal(item('Keep computer awake (recommended for 24/7)').checked, true, 'keeps the computer awake by default');
  item('Use this computer’s camera').click();
  const camera = await until(() => BrowserWindow.getAllWindows().find(w => w !== window && w.webContents.getURL().includes('/camera')), 'Webcam menu did not open a camera');
  await until(() => !camera.webContents.isLoading(), 'Camera page did not load');
  await js(camera, "document.querySelector('#ack').checked=true;document.querySelector('#start').disabled=false;document.querySelector('#start').click()");
  await until(async () => (await js(window, "fetch('/api/cameras').then(r=>r.json())")).cameras.some(c => c.status === 'live'), 'Permission policy or local webcam ingest failed');
  assert.equal(await js(window, 'typeof require'), 'undefined');
  assert.equal(await js(camera, 'typeof require'), 'undefined');
  // 24/7: closing the main window hides it; the server and camera keep running.
  window.close(); await sleep(500);
  assert(!window.isDestroyed() && !window.isVisible(), 'closing the window hides it instead of quitting');
  assert((await js(window, "fetch('/api/cameras').then(r=>r.json())")).cameras.some(c => c.status === 'live'), 'camera keeps recording with the window closed');
  console.log('PASS: real desktop startup, setup, local webcam menu, camera permission, live ingest and background running.');
  app.quit();
}).catch(e => { console.error(e); app.exit(1); });
// main.js waits for the child to flush its encrypted stores before exiting.
app.on('will-quit', () => { fs.rmSync(tmp, { recursive: true, force: true }); });
