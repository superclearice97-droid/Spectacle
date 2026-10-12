'use strict';
const fs = require('fs');
const path = require('path');

// Desktop instances have their own persistent data and never bind to the LAN.
function prepareRuntime(userData, ffmpeg) {
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  const configFile = path.join(userData, 'desktop-config.json');
  const config = {
    dataDir: path.join(userData, 'data'),
    http: { enabled: true, host: '127.0.0.1', port: 0 },
    https: { enabled: false },
    publicUrl: '', ffmpeg,
    recording: { minFreeGB: 1, stagingDir: 'auto' },
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  return configFile;
}
function readSetupCode(userData) {
  const file = path.join(userData, 'data', 'SETUP-CODE.txt');
  if (!fs.existsSync(file)) return null;
  return /setup code: (\S+)/.exec(fs.readFileSync(file, 'utf8'))?.[1] || null;
}
module.exports = { prepareRuntime, readSetupCode };
