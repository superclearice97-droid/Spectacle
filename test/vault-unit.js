#!/usr/bin/env node
// Unit tests for the encryption layer (server/lib/vault.js): round trips, tamper detection,
// range reads across chunk boundaries, key handling. Runs anywhere; needs no camera, ffmpeg or network.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vault = require('../server/lib/vault');

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spectacle-vault-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
delete process.env.CREDENTIALS_DIRECTORY;

console.log('Key handling');
ok(throws(() => vault.sealJSON({ a: 1 })), 'refuses to encrypt before init');
vault.init(dir);
const keyFile = path.join(dir, 'vault.key');
ok(fs.existsSync(keyFile), 'creates a key file on first run');
ok(fs.readFileSync(keyFile, 'utf8').trim().length === 44, 'key is 32 bytes, base64');
if (process.platform !== 'win32') ok((fs.statSync(keyFile).mode & 0o777) === 0o600, 'key file readable only by its owner');
ok(vault.status().encrypted && vault.status().keySource === 'file', 'status reports the key source');

console.log('JSON documents');
const doc = { user: 'sam', n: [1, 2, 3], note: 'héllo ✓' };
const sealed = vault.sealJSON(doc);
ok(vault.isSealedJSON(sealed), 'sealed documents are recognised');
ok(!sealed.toString('latin1').includes('sam'), 'plaintext does not appear in the sealed bytes');
ok(JSON.stringify(vault.openJSON(sealed)) === JSON.stringify(doc), 'round trip returns the same document');
ok(!sealed.equals(vault.sealJSON(doc)), 'a fresh random IV is used each time');
const flipped = Buffer.from(sealed); flipped[flipped.length - 1] ^= 1;
ok(throws(() => vault.openJSON(flipped)), 'a modified ciphertext is rejected');
const flippedTag = Buffer.from(sealed); flippedTag[20] ^= 1;
ok(throws(() => vault.openJSON(flippedTag)), 'a modified authentication tag is rejected');
ok(vault.openJSON(Buffer.from('{"old":true}')).old === true, 'an older plain JSON file is still readable (migration)');
const jf = path.join(dir, 'doc.json');
vault.writeJSON(jf, doc);
ok(vault.isSealedJSON(fs.readFileSync(jf)) && vault.readJSON(jf).user === 'sam', 'writeJSON/readJSON store it encrypted on disk');
ok(!fs.existsSync(jf + '.tmp'), 'no temporary file is left behind');

console.log('Files and recordings');
const sizes = [0, 1, vault.CHUNK - 1, vault.CHUNK, vault.CHUNK + 1, vault.CHUNK * 3 + 17];
let allRound = true;
for (const n of sizes) {
  const plain = crypto.randomBytes(n), f = path.join(dir, `f${n}.bin`);
  vault.writeFile(f, plain);
  if (!vault.isSealedFile(f) || vault.plainSize(f) !== n || !vault.readFile(f).equals(plain)) { allRound = false; console.log('    failed at size', n); }
}
ok(allRound, `round trip at ${sizes.length} sizes, including empty and chunk boundaries`);

const big = crypto.randomBytes(vault.CHUNK * 4 + 123), bf = path.join(dir, 'big.bin');
vault.writeFile(bf, big);
const ranges = [[0, 0], [5, 99], [vault.CHUNK - 3, vault.CHUNK + 3], [vault.CHUNK * 2, vault.CHUNK * 3 - 1], [big.length - 10, big.length - 1], [100, 10 ** 9]];
ok(ranges.every(([s, e]) => vault.readRange(bf, s, e).equals(big.subarray(s, Math.min(e, big.length - 1) + 1))), 'range reads match the original across chunk boundaries');
ok(!fs.readFileSync(bf).includes(big.subarray(1000, 1032)), 'plaintext does not appear in the file on disk');

const tampered = Buffer.from(fs.readFileSync(bf)); tampered[200] ^= 1;
const tf = path.join(dir, 'tampered.bin'); fs.writeFileSync(tf, tampered);
ok(throws(() => vault.readFile(tf)), 'a flipped byte in a recording is detected');
const truncated = fs.readFileSync(bf).subarray(0, fs.statSync(bf).size - 40);
const trf = path.join(dir, 'truncated.bin'); fs.writeFileSync(trf, truncated);
ok(throws(() => vault.readFile(trf)), 'a truncated recording is detected');
const swapped = Buffer.from(fs.readFileSync(bf)), c = vault.CHUNK + 16;
swapped.copy(swapped, 5 + 16 + 8 + c, 5 + 16 + 8, 5 + 16 + 8 + c);   // copy chunk 0 over chunk 1
const sf = path.join(dir, 'swapped.bin'); fs.writeFileSync(sf, swapped);
ok(throws(() => vault.readRange(sf, vault.CHUNK, vault.CHUNK + 10)), 'moving a chunk to another position is detected');
const notEnc = path.join(dir, 'plain.txt'); fs.writeFileSync(notEnc, 'just text');
ok(!vault.isSealedFile(notEnc) && throws(() => vault.readFile(notEnc)), 'a plain file is not mistaken for an encrypted one');
ok(!vault.isSealedFile(path.join(dir, 'missing')), 'a missing file is reported as not encrypted, without throwing');

console.log('Encrypting a finished recording segment');
const seg = path.join(dir, 'seg.mp4'), out = path.join(dir, 'sub', 'seg.enc'), segData = crypto.randomBytes(vault.CHUNK * 2 + 5);
fs.writeFileSync(seg, segData);
vault.encryptFile(seg, out);
ok(!fs.existsSync(seg), 'plaintext segment is removed after encryption');
ok(vault.readFile(out).equals(segData), 'encrypted segment decrypts to the original');

console.log('HTTP range serving');
function request(range, method = 'GET') {
  return new Promise(resolve => {
    const res = { headers: {}, chunks: [], code: 0, listeners: {} };
    res.writeHead = (code, h) => { res.code = code; Object.assign(res.headers, h); };
    res.write = b => { res.chunks.push(Buffer.from(b)); return true; };
    res.end = b => { if (b) res.chunks.push(Buffer.from(b)); resolve(res); };
    res.on = () => {}; res.once = () => {}; res.destroy = e => resolve({ ...res, error: e });
    vault.serve({ headers: range ? { range } : {}, method }, res, bf, 'video/mp4', {});
  });
}
(async () => {
  const full = await request();
  ok(full.code === 200 && Buffer.concat(full.chunks).equals(big), 'full download returns the whole file');
  const part = await request(`bytes=${vault.CHUNK - 5}-${vault.CHUNK + 5}`);
  ok(part.code === 206 && Buffer.concat(part.chunks).equals(big.subarray(vault.CHUNK - 5, vault.CHUNK + 6)), 'partial request returns the right bytes');
  ok(part.headers['Content-Range'] === `bytes ${vault.CHUNK - 5}-${vault.CHUNK + 5}/${big.length}`, 'Content-Range is correct');
  const tail = await request('bytes=-10');
  ok(tail.code === 206 && Buffer.concat(tail.chunks).equals(big.subarray(big.length - 10)), 'suffix range returns the last bytes');
  ok((await request(`bytes=${big.length + 5}-`)).code === 416, 'a range past the end is refused with 416');
  ok((await request(null, 'HEAD')).chunks.length === 0, 'HEAD sends headers only');

  console.log(fails ? `\n${fails} check(s) failed` : '\nAll vault checks passed');
  process.exit(fails ? 1 : 0);
})();
