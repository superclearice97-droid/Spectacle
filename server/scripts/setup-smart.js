#!/usr/bin/env node
// Installs Spectacle's optional smart detection (people, vehicles, animals) into ./addons:
//   - onnxruntime-node (MIT, Microsoft) to run the model on this computer's CPU
//   - one D-FINE detector model (Apache-2.0), checked against its published SHA-256
// Nothing is sent anywhere while it runs: detection happens entirely on this machine.
//
// Usage: npm run smart-detection [-- --size s|l|x] [--remove]
//   s = small and fast (Raspberry Pi, old laptops)  · l = recommended, about as accurate as YOLO26x
//   x = most accurate, needs a strong CPU
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'addons');
const ORT_VERSION = '1.24.3';
const models = require('../lib/smart/models');
const args = process.argv.slice(2);
const say = s => console.log('==> ' + s);

if (args.includes('--remove')) {
  fs.rmSync(DIR, { recursive: true, force: true });
  say('Smart detection removed. Restart Spectacle: sudo systemctl restart spectacle');
  process.exit(0);
}

function recommend() {
  const cores = os.cpus().length, gb = os.totalmem() / 1e9;
  if (process.arch !== 'x64' && cores <= 4) return 's';
  if (cores < 4 || gb < 4) return 's';
  return 'l';
}
const si = args.indexOf('--size');
const size = si >= 0 ? args[si + 1] : recommend();
if (!['s', 'l', 'x'].includes(size)) { console.error('Size must be s, l or x'); process.exit(1); }

async function get(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Download failed (${r.status}) for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  fs.mkdirSync(path.join(DIR, 'models'), { recursive: true });
  // 1) runtime
  const ortDir = path.join(DIR, 'node_modules', 'onnxruntime-node');
  let have = null; try { have = JSON.parse(fs.readFileSync(path.join(ortDir, 'package.json'), 'utf8')).version; } catch {}
  if (have !== ORT_VERSION) {
    say(`Installing ONNX Runtime ${ORT_VERSION} (CPU only)`);
    if (!fs.existsSync(path.join(DIR, 'package.json'))) fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify({ name: 'spectacle-addons', private: true, license: 'MIT' }, null, 2) + '\n');
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', DIR, '--no-audit', '--no-fund', '--omit=dev', '--save-exact', `onnxruntime-node@${ORT_VERSION}`], {
      stdio: 'inherit',
      // CPU build only: skip the optional ~500 MB GPU (CUDA) download.
      env: { ...process.env, npm_config_onnxruntime_node_install: 'skip', npm_config_onnxruntime_node_install_cuda: 'skip', ONNXRUNTIME_NODE_INSTALL: 'skip', ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip' },
    });
  } else say(`ONNX Runtime ${ORT_VERSION} already installed`);

  // 2) model (checked against the SHA-256 built into this version of Spectacle)
  const file = `dfine-${size}.onnx`, dest = path.join(DIR, 'models', file);
  say(`Getting the ${ {s: 'small', l: 'recommended', x: 'most accurate'}[size] } detector model (${file}, ${models.SIZES_MB[size]} MB, once)`);
  let shown = -1;
  await models.download(size, path.join(DIR, 'models'), p => { const pct = Math.floor(p * 10) * 10; if (pct !== shown) { shown = pct; process.stdout.write(`    ${pct}%\r`); } });
  say('Model downloaded and verified');
  try { fs.copyFileSync(path.join(DIR, 'models', 'MODEL-LICENSE.txt'), path.join(DIR, 'MODEL-LICENSE.txt')); } catch {}
  fs.writeFileSync(path.join(DIR, 'smart.json'), JSON.stringify({ size, model: file, sha256: models.PINNED[size], ort: ORT_VERSION, installed: new Date().toISOString() }, null, 2) + '\n');

  // 3) quick self-test so a broken install is caught now, not at 3 a.m.
  say('Testing it on a sample picture');
  const ort = require(ortDir);
  const s = await ort.InferenceSession.create(dest, { executionProviders: ['cpu'] });
  const t = Date.now();
  await s.run({ images: new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]), orig_target_sizes: new ort.Tensor('int64', BigInt64Array.from([640n, 640n]), [1, 2]) });
  say(`Works: about ${Date.now() - t} ms per check on this computer.`);
  console.log('\nSmart detection is installed. Restart Spectacle to use it:  sudo systemctl restart spectacle');
  console.log('Then in the app: Settings → Cameras → choose what each camera alerts on, and draw zones.');
})().catch(e => { console.error('\nSmart detection was not installed: ' + e.message); process.exit(1); });
