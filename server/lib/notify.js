'use strict';
// Sends alerts to the family: in-app (live), Web Push (phone notifications), optional ntfy.
const webpush = require('./webpush');

class Notifier {
  constructor(cfg, auth, hub) { this.cfg = cfg; this.auth = auth; this.hub = hub; }
  async alert({ title, body, camId, url, tag, kind = 'motion' }) {
    this.hub.broadcast({ type: 'alert', kind, title, body, camId, url, ts: Date.now() });
    const subject = this.cfg.contactEmail ? 'mailto:' + this.cfg.contactEmail : 'mailto:admin@localhost';
    for (const u of this.auth.d.users) {
      if (!u.prefs || !u.prefs.notify) continue;
      if (kind === 'sighting' && u.prefs.biomeAlerts === false) continue;
      if (camId && u.prefs.mutedCams && u.prefs.mutedCams.includes(camId)) continue;
      for (const sub of [...(u.push || [])]) {
        webpush.send(sub, { title, body, url: url || '/', tag: tag || kind }, this.cfg.secrets.vapid, subject)
          .then(st => { if (st === 404 || st === 410) { u.push = u.push.filter(s => s.endpoint !== sub.endpoint); this.auth.store.save(); } })
          .catch(() => {});
      }
    }
    if (this.cfg.ntfy.url && kind === 'motion') {
      fetch(this.cfg.ntfy.url, { method: 'POST', headers: { Title: title, Tags: 'rotating_light', Click: (this.cfg.publicUrl || '') + (url || '/') }, body }).catch(() => {});
    }
  }
}

module.exports = { Notifier };
