'use strict';
// Where Spectacle's detector models come from, and how they're checked. Used by the command-line installer
// (npm run smart-detection) and by the desktop app's "Turn on smart detection" button.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'superclearice97-droid/spectacle';
const TAG = 'detector-models-v1';
const BASE = `https://github.com/${REPO}/releases/download/${TAG}`;
// Pinned checksums of the published models (built by .github/workflows/detector-models.yml).
const PINNED = {
  s: '9ceede01469b821a3807fb8e25ee5283a0781c6b9b2d0c7795a76408610b9b6b',
  l: 'bceee0b6ca3f5b67248f1471cc156f0ed380c7321005514f12276178e1d98a38',
  x: '2fe00f6bcca85241610d2ca491cffc6b316c72bdfbd1e2fc6d725b79a2fdf932',
};
const SIZES_MB = { s: 41, l: 124, x: 245 };
const LABELS = { s: 'Small (fast, for older computers)', l: 'Recommended (about as accurate as YOLO26x)', x: 'Most accurate (needs a strong computer)' };

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function installed(dir, size) { const f = path.join(dir, `dfine-${size}.onnx`); return fs.existsSync(f) && sha(f) === PINNED[size]; }

/** Streams the model to dir, verifying it before it's put in place. onProgress(0..1). */
async function download(size, dir, onProgress = () => {}) {
  if (!PINNED[size]) throw new Error('Size must be s, l or x');
  fs.mkdirSync(dir, { recursive: true });
  const file = `dfine-${size}.onnx`, dest = path.join(dir, file), tmp = dest + '.part';
  if (installed(dir, size)) { onProgress(1); return dest; }
  const r = await fetch(`${BASE}/${file}`, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}). Check the internet connection and try again.`);
  const total = +r.headers.get('content-length') || SIZES_MB[size] * 1e6;
  const hash = crypto.createHash('sha256'), out = fs.createWriteStream(tmp);
  let got = 0, last = 0;
  try {
    for await (const chunk of r.body) {
      hash.update(chunk); got += chunk.length;
      if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      if (got - last > 2e6) { last = got; onProgress(Math.min(0.99, got / total)); }
    }
    await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
  } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw e; }
  if (hash.digest('hex') !== PINNED[size]) { fs.rmSync(tmp, { force: true }); throw new Error('The downloaded model failed its integrity check, so it was not installed. Try again later.'); }
  fs.renameSync(tmp, dest);
  try { const lic = await fetch(`${BASE}/MODEL-LICENSE.txt`); if (lic.ok) fs.writeFileSync(path.join(dir, 'MODEL-LICENSE.txt'), Buffer.from(await lic.arrayBuffer())); } catch {}
  onProgress(1);
  return dest;
}

module.exports = { REPO, TAG, BASE, PINNED, SIZES_MB, LABELS, download, installed };
