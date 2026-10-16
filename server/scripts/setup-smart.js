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
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'addons');
const REPO = 'superclearice97-droid/spectacle';
const TAG = 'detector-models-v1';
const ORT_VERSION = '1.24.3';
// Pinned checksums of the published models (from the detector-models-v1 release built by GitHub Actions).
const PINNED = {
  's': '9ceede01469b821a3807fb8e25ee5283a0781c6b9b2d0c7795a76408610b9b6b',
  'l': 'bceee0b6ca3f5b67248f1471cc156f0ed380c7321005514f12276178e1d98a38',
  'x': '2fe00f6bcca85241610d2ca491cffc6b316c72bdfbd1e2fc6d725b79a2fdf932',
};
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

  // 2) model
  const base = `https://github.com/${REPO}/releases/download/${TAG}`;
  const file = `dfine-${size}.onnx`, dest = path.join(DIR, 'models', file);
  say(`Checking the ${ {s: 'small', l: 'recommended', x: 'most accurate'}[size] } detector model (${file})`);
  const sums = (await get(`${base}/SHA256SUMS`)).toString();
  const want = (sums.split('\n').find(l => l.trim().endsWith(file)) || '').split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('Model checksum list is missing this file');
  if (want !== PINNED[size]) throw new Error('The published model doesn\'t match the checksum built into this version of Spectacle, so it was not installed.');
  const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (!fs.existsSync(dest) || hash(dest) !== want) {
    say(`Downloading ${file} (once; it never sends anything back)`);
    const buf = await get(`${base}/${file}`);
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== want) throw new Error('The downloaded model failed its integrity check, so it was not installed. Try again later.');
    fs.writeFileSync(dest + '.tmp', buf); fs.renameSync(dest + '.tmp', dest);
  } else say('Model already downloaded and verified');
  fs.writeFileSync(path.join(DIR, 'MODEL-LICENSE.txt'), await get(`${base}/MODEL-LICENSE.txt`));
  fs.writeFileSync(path.join(DIR, 'smart.json'), JSON.stringify({ size, model: file, sha256: want, ort: ORT_VERSION, installed: new Date().toISOString() }, null, 2) + '\n');

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
