'use strict';
// Web Push (RFC 8030/8291/8292): VAPID-signed, aes128gcm-encrypted. No dependencies.
const crypto = require('crypto');

function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapid.privatePem, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${sig.toString('base64url')}, k=${vapid.publicKey}`;
}

function encrypt(payload, sub) {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

async function send(sub, payload, vapid, subject) {
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: vapidHeader(sub.endpoint, vapid, subject) },
    body: encrypt(JSON.stringify(payload), sub),
  });
  return r.status; // 404/410 = subscription gone
}

module.exports = { send, encrypt, vapidHeader };
