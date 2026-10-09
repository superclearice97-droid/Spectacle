'use strict';
// Family accounts: scrypt password hashes, cookie sessions, invite codes, camera device tokens.
const crypto = require('crypto');
const { Store } = require('./store');

const COLORS = ['#ff7a59', '#4cc9f0', '#b5e48c', '#f9c74f', '#c77dff', '#ff99c8', '#90dbf4', '#ffd166'];
const SESSION_DAYS = 30;
const LEGAL_VERSION = '2026-10-09b';

class Auth {
  constructor(cfg) {
    this.store = new Store(cfg.dataDir, 'accounts', { users: [], sessions: {}, invites: {}, devices: {} });
    this.fails = new Map();
  }
  get d() { return this.store.data; }
  hasUsers() { return this.d.users.length > 0; }
  hash(pw, salt = crypto.randomBytes(16).toString('hex')) { return salt + ':' + crypto.scryptSync(pw, salt, 64, { N: 16384 }).toString('hex'); }
  verify(pw, stored) { const [salt, h] = stored.split(':'); const c = crypto.scryptSync(pw, salt, 64, { N: 16384 }); return crypto.timingSafeEqual(c, Buffer.from(h, 'hex')); }
  publicUser(u) { return u && { id: u.id, name: u.name, username: u.username, role: u.role, color: u.color, prefs: u.prefs, consent: u.consent }; }

  createUser({ username, name, password, role, consent }) {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,32}$/.test(username)) throw new Error('Username: 2–32 letters, numbers, . _ -');
    if (String(password || '').length < 10) throw new Error('Password must be at least 10 characters');
    if (this.d.users.some(u => u.username === username)) throw new Error('That username is taken');
    if (!consent || !consent.terms || !consent.presence) throw new Error('Please accept the terms and presence notice');
    const u = { id: crypto.randomUUID(), username, name: String(name || username).slice(0, 40), role, pw: this.hash(password), color: COLORS[this.d.users.length % COLORS.length], created: new Date().toISOString(), consent: { ...consent, version: LEGAL_VERSION, at: new Date().toISOString() }, prefs: { notify: true, mutedCams: [] }, push: [] };
    this.d.users.push(u); this.store.save(); return u;
  }
  login(username, password, ip) {
    const k = ip + '|' + String(username).toLowerCase();
    const f = this.fails.get(k) || { n: 0, until: 0 };
    if (Date.now() < f.until) throw new Error('Too many attempts. Try again in a few minutes.');
    const u = this.d.users.find(x => x.username === String(username || '').trim().toLowerCase());
    if (!u || !this.verify(String(password || ''), u.pw)) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; } this.fails.set(k, f);
      throw new Error('Wrong username or password');
    }
    this.fails.delete(k);
    return this.newSession(u);
  }
  newSession(u) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.d.sessions[this.sha(token)] = { uid: u.id, exp: Date.now() + SESSION_DAYS * 864e5 };
    this.store.save(); return token;
  }
  sha(t) { return crypto.createHash('sha256').update(t).digest('hex'); }
  userFromToken(token) {
    if (!token) return null;
    const s = this.d.sessions[this.sha(token)];
    if (!s || s.exp < Date.now()) return null;
    return this.d.users.find(u => u.id === s.uid) || null;
  }
  logout(token) { delete this.d.sessions[this.sha(token)]; this.store.save(); }
  user(id) { return this.d.users.find(u => u.id === id); }
  deleteUser(id) {
    this.d.users = this.d.users.filter(u => u.id !== id);
    for (const [k, s] of Object.entries(this.d.sessions)) if (s.uid === id) delete this.d.sessions[k];
    this.store.save();
  }
  createInvite(by, role = 'member') {
    const code = crypto.randomBytes(9).toString('base64url');
    this.d.invites[this.sha(code)] = { by, role, exp: Date.now() + 7 * 864e5 }; this.store.save(); return code;
  }
  useInvite(code) {
    const k = this.sha(String(code || '')); const inv = this.d.invites[k];
    if (!inv || inv.exp < Date.now()) throw new Error('Invite code is invalid or expired');
    delete this.d.invites[k]; this.store.save(); return inv;
  }
  // Pairing token for a phone/webcam acting as a camera.
  createDeviceToken(camId) {
    const t = crypto.randomBytes(24).toString('base64url');
    for (const [k, v] of Object.entries(this.d.devices)) if (v.camId === camId) delete this.d.devices[k];
    this.d.devices[this.sha(t)] = { camId, created: Date.now() }; this.store.save(); return t;
  }
  deviceCam(token) { const d = token && this.d.devices[this.sha(token)]; return d ? d.camId : null; }
  revokeDevices(camId) { for (const [k, v] of Object.entries(this.d.devices)) if (v.camId === camId) delete this.d.devices[k]; this.store.save(); }
  cleanup() { const now = Date.now(); for (const [k, s] of Object.entries(this.d.sessions)) if (s.exp < now) delete this.d.sessions[k]; for (const [k, i] of Object.entries(this.d.invites)) if (i.exp < now) delete this.d.invites[k]; this.store.save(); }
}

module.exports = { Auth, LEGAL_VERSION };
