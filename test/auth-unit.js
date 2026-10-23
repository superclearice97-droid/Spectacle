#!/usr/bin/env node
// Unit tests for accounts and sessions (server/lib/auth.js): password rules, hashing, sessions,
// invites, device tokens and sign-in throttling. Runs anywhere; needs no camera, ffmpeg or network.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vault = require('../server/lib/vault');
const { Auth } = require('../server/lib/auth');

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spectacle-auth-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
delete process.env.CREDENTIALS_DIRECTORY;
vault.init(dir);

const consent = { terms: true, presence: true };
const fresh = () => new Auth({ dataDir: fs.mkdtempSync(path.join(dir, 'a-')) });
const PW = 'correct horse battery';

console.log('Creating accounts');
let a = fresh();
ok(!a.hasUsers(), 'starts with no users');
ok(throws(() => a.createUser({ username: 'x', password: PW, consent }), /Username/), 'rejects a one-letter username');
ok(throws(() => a.createUser({ username: 'bad name!', password: PW, consent }), /Username/), 'rejects spaces and symbols in usernames');
ok(throws(() => a.createUser({ username: 'sam', password: 'short', consent }), /at least 10/), 'rejects passwords under 10 characters');
ok(throws(() => a.createUser({ username: 'sam', password: PW }), /accept/), 'requires the terms to be accepted');
ok(throws(() => a.createUser({ username: 'sam', password: PW, consent: { terms: true } }), /accept/), 'requires the presence notice to be accepted');
const sam = a.createUser({ username: '  Sam ', name: 'Sam', password: PW, role: 'admin', consent });
ok(sam.username === 'sam' && a.hasUsers(), 'usernames are trimmed and lower-cased');
ok(throws(() => a.createUser({ username: 'SAM', password: PW, consent }), /taken/), 'rejects a duplicate username, ignoring case');
ok(!/correct horse/.test(sam.pw) && /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(sam.pw), 'password is stored as a salted scrypt hash, not plaintext');
const pub = a.publicUser(sam);
ok(!('pw' in pub) && !('push' in pub), 'publicUser never exposes the password hash or push keys');
ok(a.hash(PW) !== a.hash(PW), 'the same password hashes differently each time (random salt)');
ok(a.verify(PW, sam.pw) && !a.verify('wrong password', sam.pw), 'verify accepts the right password only');
ok(!a.verify(PW, '') && !a.verify(PW, 'nocolon') && !a.verify(PW, null), 'verify rejects empty or malformed stored hashes');

console.log('Sign in and sessions');
const token = a.login('SAM', PW, '10.0.0.5');
ok(typeof token === 'string' && token.length >= 40, 'sign-in returns a long random token');
ok(a.userFromToken(token).id === sam.id, 'the token identifies the user');
ok(Object.keys(a.d.sessions).every(k => k !== token), 'the raw token is never stored, only its hash');
ok(a.userFromToken(null) === null && a.userFromToken('nope') === null, 'unknown or missing tokens identify nobody');
const t2 = a.login('sam', PW, '10.0.0.5');
a.revokeSessions(sam.id, t2);
ok(a.userFromToken(token) === null && a.userFromToken(t2) !== null, 'changing a password signs out every other device');
a.logout(t2);
ok(a.userFromToken(t2) === null, 'logout invalidates the session');
const t3 = a.login('sam', PW, '10.0.0.5');
a.d.sessions[a.sha(t3)].exp = Date.now() - 1;
ok(a.userFromToken(t3) === null, 'an expired session is refused');
a.cleanup();
ok(!a.d.sessions[a.sha(t3)], 'cleanup removes expired sessions');

console.log('Wrong passwords and throttling');
ok(throws(() => a.login('sam', 'nope', '10.0.0.9'), /Wrong username or password/), 'wrong password is refused');
const msgKnown = (() => { try { a.login('sam', 'nope', '10.0.0.9'); } catch (e) { return e.message; } })();
const msgUnknown = (() => { try { a.login('ghost', 'nope', '10.0.0.9'); } catch (e) { return e.message; } })();
ok(msgKnown === msgUnknown, 'unknown usernames get exactly the same error as wrong passwords');
a = fresh(); a.createUser({ username: 'sam', password: PW, role: 'admin', consent });
for (let i = 0; i < 5; i++) throws(() => a.login('sam', 'bad' + i, '10.0.0.1'));
ok(throws(() => a.login('sam', PW, '10.0.0.1'), /Too many/), 'five failures lock that account from that address, even for the right password');
ok(a.login('sam', PW, '10.0.0.2') !== undefined, 'a different address is not locked out');
a = fresh();
for (let i = 0; i < 20; i++) a.failed('9.9.9.9');
ok(throws(() => a.throttle('9.9.9.9'), /Too many/), 'twenty failures block an address entirely');
ok(!throws(() => a.throttle('8.8.8.8')), 'other addresses are unaffected');

console.log('Invites');
a = fresh(); const admin = a.createUser({ username: 'admin', password: PW, role: 'admin', consent });
const code = a.createInvite(admin.id, 'member');
ok(!JSON.stringify(a.d.invites).includes(code), 'invite codes are stored hashed');
ok(a.useInvite(code).role === 'member', 'a valid invite can be used');
ok(throws(() => a.useInvite(code), /invalid or expired/), 'an invite works only once');
ok(throws(() => a.useInvite('made-up'), /invalid or expired/) && throws(() => a.useInvite(undefined), /invalid or expired/), 'unknown or missing invite codes are refused');
const old = a.createInvite(admin.id); a.d.invites[a.sha(old)].exp = Date.now() - 1;
ok(throws(() => a.useInvite(old), /invalid or expired/), 'an expired invite is refused');

console.log('Camera device tokens');
const dt = a.createDeviceToken('cam1');
ok(a.deviceCam(dt) === 'cam1' && a.deviceCam('x') === null && a.deviceCam(null) === null, 'a device token maps to its camera only');
const dt2 = a.createDeviceToken('cam1');
ok(a.deviceCam(dt) === null && a.deviceCam(dt2) === 'cam1', 'creating a new pairing token revokes the old one');
a.revokeDevices('cam1');
ok(a.deviceCam(dt2) === null, 'revokeDevices removes access');

console.log('Deleting users and persistence');
const m = a.createUser({ username: 'mia', password: PW, role: 'member', consent }), mt = a.login('mia', PW, '10.0.0.3');
a.deleteUser(m.id);
ok(a.user(m.id) === undefined && a.userFromToken(mt) === null, 'deleting a user also ends their sessions');
a.store.flush();
const raw = fs.readFileSync(a.store.file);
ok(vault.isSealedJSON(raw) && !raw.toString('latin1').includes('admin'), 'accounts file is encrypted on disk');
const reopened = new Auth({ dataDir: path.dirname(a.store.file) });
ok(reopened.hasUsers() && reopened.login('admin', PW, '10.0.0.4') !== undefined, 'accounts survive a restart');

console.log(fails ? `\n${fails} check(s) failed` : '\nAll auth checks passed');
process.exit(fails ? 1 : 0);
