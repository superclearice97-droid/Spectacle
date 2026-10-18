'use strict';
const fs = require('fs');
const path = require('path');

// Desktop instances have their own persistent data and never bind to the LAN.
function prepareRuntime(userData, ffmpeg) {
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  fs.chmodSync(userData, 0o700);
  const configFile = path.join(userData, 'desktop-config.json');
  const config = {
    dataDir: path.join(userData, 'data'),
    http: { enabled: true, host: '127.0.0.1', port: 0 },
    https: { enabled: false },
    publicUrl: '', ffmpeg,
    recording: { minFreeGB: 1, stagingDir: 'auto' },
    // Smart detection: ONNX Runtime ships inside the app; the model is downloaded from Settings into here.
    smart: { modelDir: path.join(userData, 'addons', 'models') },
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  return configFile;
}
function readSetupCode(userData) {
  const file = path.join(userData, 'data', 'SETUP-CODE.txt');
  if (!fs.existsSync(file)) return null;
  return /setup code: (\S+)/.exec(fs.readFileSync(file, 'utf8'))?.[1] || null;
}
// Login autostart (XDG): ~/.config/autostart/spectacle.desktop, started hidden so it just records.
const autostartFile = configHome => path.join(configHome, 'autostart', 'spectacle.desktop');
// Desktop-entry quoting escapes " ` $ \ with a backslash, then string escaping doubles every backslash.
const quoteExec = p => '"' + p.replace(/["`$\\]/g, c => '\\\\' + c) + '"';
const autostartEntry = exe => `[Desktop Entry]\nType=Application\nName=Spectacle\nComment=Keeps your cameras recording\nExec=${quoteExec(exe)} --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
function readPrefs(userData) { try { return JSON.parse(fs.readFileSync(path.join(userData, 'desktop-prefs.json'), 'utf8')); } catch { return {}; } }
function writePrefs(userData, prefs) { fs.writeFileSync(path.join(userData, 'desktop-prefs.json'), JSON.stringify(prefs), { mode: 0o600 }); }
module.exports = { prepareRuntime, readSetupCode, autostartFile, autostartEntry, readPrefs, writePrefs };
