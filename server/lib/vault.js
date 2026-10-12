'use strict';
// Encryption at rest for everything Spectacle saves: accounts, settings, the motion log, the biome log,
// motion snapshots, biome photos and recordings. AES-256-GCM.
//
// The master key comes from (in order):
//   1. a systemd credential (install.sh seals it with `systemd-creds`, bound to this machine's TPM chip
//      when it has one), so a copied or stolen disk can't be read on another computer;
//   2. data/vault.key, readable only by the Spectacle user (when not run as a service).
//
// Files are encrypted in 64 KiB chunks so recordings can still be streamed and seeked (HTTP ranges)
// without decrypting the whole file. Each file has its own key derived from the master key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JSON_MAGIC = Buffer.from('SPXJ1');
const FILE_MAGIC = Buffer.from('SPXF1');
const CHUNK = 64 * 1024, TAG = 16, SALT = 16;
const HEADER = FILE_MAGIC.length + SALT + 8;               // magic | salt | plaintext size (uint64 BE)
let master = null, source = null;

function decodeKey(buf) {
  const s = buf.toString('utf8').trim();
  const k = /^[A-Za-z0-9+/=]{43,44}$/.test(s) ? Buffer.from(s, 'base64') : buf;
  if (k.length !== 32) throw new Error('Spectacle encryption key must be 32 bytes');
  return k;
}

function init(dataDir) {
  if (master) return;
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  const cred = credDir && path.join(credDir, 'spectacle-key');
  const file = path.join(dataDir, 'vault.key');
  if (cred && fs.existsSync(cred)) { master = decodeKey(fs.readFileSync(cred)); source = 'sealed'; }
  else {
    if (!fs.existsSync(file)) {
      try { fs.writeFileSync(file, crypto.randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    try { fs.chmodSync(file, 0o600); } catch {}
    master = decodeKey(fs.readFileSync(file)); source = 'file';
  }
}
const ready = () => { if (!master) throw new Error('Encryption not initialised'); };
const status = () => ({ encrypted: true, keySource: source });
const fileKey = salt => Buffer.from(crypto.hkdfSync('sha256', master, salt, Buffer.from('spectacle file v1'), 32));
const jsonKey = () => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('spectacle json v1'), 32));

/* ---------- small documents (JSON stores, secrets) ---------- */
function sealJSON(obj) {
  ready();
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', jsonKey(), iv);
  c.setAAD(JSON_MAGIC);
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return Buffer.concat([JSON_MAGIC, iv, c.getAuthTag(), ct]);
}
function openJSON(buf) {
  ready();
  if (!isSealedJSON(buf)) return JSON.parse(buf.toString('utf8'));       // older plain file: read once, re-saved encrypted
  const iv = buf.subarray(5, 17), tag = buf.subarray(17, 33), ct = buf.subarray(33);
  const d = crypto.createDecipheriv('aes-256-gcm', jsonKey(), iv); d.setAAD(JSON_MAGIC); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
const isSealedJSON = buf => buf.length > 33 && buf.subarray(0, 5).equals(JSON_MAGIC);
function writeJSON(file, obj) {
  fs.writeFileSync(file + '.tmp', sealJSON(obj), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function readJSON(file) { return openJSON(fs.readFileSync(file)); }

/* ---------- files (snapshots, photos, recordings) ---------- */
function chunkCipher(key, header, i, decrypt) {
  const iv = Buffer.alloc(12); iv.writeUInt32BE(Math.floor(i / 2 ** 32), 4); iv.writeUInt32BE(i >>> 0, 8);
  const c = decrypt ? crypto.createDecipheriv('aes-256-gcm', key, iv) : crypto.createCipheriv('aes-256-gcm', key, iv);
  const aad = Buffer.alloc(8); aad.writeBigUInt64BE(BigInt(i)); c.setAAD(Buffer.concat([header, aad]));
  return c;
}
function header(size) { const h = Buffer.alloc(HEADER); FILE_MAGIC.copy(h, 0); crypto.randomBytes(SALT).copy(h, 5); h.writeBigUInt64BE(BigInt(size), 5 + SALT); return h; }
function sealBuffer(buf) {
  ready();
  const h = header(buf.length), key = fileKey(h.subarray(5, 5 + SALT)), parts = [h];
  for (let i = 0, off = 0; off < buf.length || (i === 0 && buf.length === 0); i++, off += CHUNK) {
    const c = chunkCipher(key, h, i, false);
    parts.push(c.update(buf.subarray(off, off + CHUNK)), c.final(), c.getAuthTag());
    if (buf.length === 0) break;
  }
  return Buffer.concat(parts);
}
function writeFile(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', sealBuffer(buf), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
/* Encrypt a finished plaintext file (a recording segment) and remove the plaintext. */
function encryptFile(src, dst) {
  ready();
  const size = fs.statSync(src).size, h = header(size), key = fileKey(h.subarray(5, 5 + SALT));
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  const tmp = dst + '.tmp', out = fs.openSync(tmp, 'w', 0o600), inp = fs.openSync(src, 'r'), buf = Buffer.alloc(CHUNK);
  try {
    fs.writeSync(out, h);
    for (let i = 0, off = 0; off < size; i++, off += CHUNK) {
      const n = fs.readSync(inp, buf, 0, Math.min(CHUNK, size - off), off);
      const c = chunkCipher(key, h, i, false);
      fs.writeSync(out, Buffer.concat([c.update(buf.subarray(0, n)), c.final(), c.getAuthTag()]));
    }
    fs.fsyncSync(out);
  } finally { fs.closeSync(out); fs.closeSync(inp); }
  fs.renameSync(tmp, dst);
  fs.rmSync(src, { force: true });
}
function readHeader(fd) {
  const h = Buffer.alloc(HEADER); fs.readSync(fd, h, 0, HEADER, 0);
  if (!h.subarray(0, 5).equals(FILE_MAGIC)) throw new Error('Not an encrypted Spectacle file');
  return { h, size: Number(h.readBigUInt64BE(5 + SALT)), key: fileKey(h.subarray(5, 5 + SALT)) };
}
const isSealedFile = file => { try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(5); fs.readSync(fd, b, 0, 5, 0); fs.closeSync(fd); return b.equals(FILE_MAGIC); } catch { return false; } };
const plainSize = file => { const fd = fs.openSync(file, 'r'); try { return readHeader(fd).size; } finally { fs.closeSync(fd); } };
/* Decrypt bytes [start, end] (inclusive) of an encrypted file. */
function readRange(file, start, end) {
  ready();
  const fd = fs.openSync(file, 'r');
  try {
    const { h, size, key } = readHeader(fd);
    if (size === 0) return Buffer.alloc(0);
    end = Math.min(end, size - 1); const first = Math.floor(start / CHUNK), last = Math.floor(end / CHUNK), out = [];
    const ct = Buffer.alloc(CHUNK + TAG);
    for (let i = first; i <= last; i++) {
      const plen = Math.min(CHUNK, size - i * CHUNK), n = fs.readSync(fd, ct, 0, plen + TAG, HEADER + i * (CHUNK + TAG));
      if (n !== plen + TAG) throw new Error('Encrypted file is truncated');
      const d = chunkCipher(key, h, i, true); d.setAuthTag(ct.subarray(plen, plen + TAG));
      const pt = Buffer.concat([d.update(ct.subarray(0, plen)), d.final()]);
      out.push(pt.subarray(i === first ? start - i * CHUNK : 0, i === last ? end - i * CHUNK + 1 : pt.length));
    }
    return Buffer.concat(out);
  } finally { fs.closeSync(fd); }
}
const readFile = file => readRange(file, 0, Number.MAX_SAFE_INTEGER);

/* Stream (part of) an encrypted file to an HTTP response, decrypting chunk by chunk. */
function serve(req, res, file, type, headers = {}) {
  let size; try { size = plainSize(file); } catch { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Not found"}'); }
  let start = 0, end = size - 1, code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; } else { start = Math.max(0, size - +m[2]); }
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...headers });
  if (req.method === 'HEAD') return res.end();
  let pos = start;
  const pump = () => {
    while (pos <= end) {
      const upto = Math.min(end, (Math.floor(pos / CHUNK) + 4) * CHUNK - 1);      // ~256 KiB at a time
      let part; try { part = readRange(file, pos, upto); } catch (e) { return res.destroy(e); }
      pos = upto + 1;
      if (!res.write(part)) return res.once('drain', pump);
    }
    res.end();
  };
  res.on('close', () => { pos = end + 1; });
  pump();
}

module.exports = { init, status, sealJSON, openJSON, isSealedJSON, writeJSON, readJSON, sealBuffer, writeFile, encryptFile, readFile, readRange, plainSize, isSealedFile, serve, CHUNK };
