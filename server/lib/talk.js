'use strict';
// Two-way talk ("intercom"): relays live audio between family members and a camera's phone/webcam.
// Nothing is recorded. The camera's microphone is only on during a session, which a family member starts,
// and the camera device announces every session with a chime and an on-screen notice.
const MAX_FRAME = 4096;               // bytes per audio message (20 ms of 16 kHz PCM is 640)
const MAX_FPS = 120;                  // messages per second per sender before we start dropping
const MAX_SESSION_MS = 15 * 60_000;   // talk sessions end themselves after 15 minutes

class TalkHub {
  constructor({ cams, onState, onEnd }) {
    this.cams = cams; this.onState = onState; this.onEnd = onEnd;
    this.sessions = new Map(); // camId -> session
    setInterval(() => { const now = Date.now(); for (const [id, s] of this.sessions) if (now - s.startedAt > MAX_SESSION_MS) this.end(id, 'time limit'); }, 10_000).unref();
  }
  /** Can this camera talk right now? Returns a reason string if not. */
  unavailable(cam) {
    if (!cam) return 'No such camera';
    if (!cam.talk || !cam.talk.enabled) return 'Two-way talk is turned off for this camera (Settings → Cameras).';
    if (cam.type !== 'browser') return 'Two-way talk works with phone and webcam cameras. This IP camera can\'t be talked through yet.';
    const pipe = this.cams.pipe(cam.id);
    if (!pipe || !pipe.device) return 'The camera phone isn\'t connected right now.';
    return null;
  }
  state(camId) {
    const s = this.sessions.get(camId);
    return s ? { camId, active: true, people: [...new Set([...s.listeners.values()].map(l => l.name))], talker: s.talker ? s.listeners.get(s.talker).name : null, cameraReady: !!s.camAudio, since: s.startedAt } : { camId, active: false, people: [], talker: null };
  }
  publish(camId) {
    const st = this.state(camId);
    this.onState(st);
    const s = this.sessions.get(camId);
    if (s) { const msg = JSON.stringify({ type: 'talk-state', ...st }); for (const ws of s.listeners.keys()) ws.send(msg); }
    // Tell the camera device too, so the person there sees who's talking.
    const dev = this.cams.pipe(camId)?.device;
    if (dev) dev.send({ type: 'talk', active: st.active, people: st.people, talker: st.talker });
  }

  /** A family member opened the intercom for this camera. */
  addListener(ws, user, cam) {
    const why = this.unavailable(cam); if (why) { ws.send({ type: 'talk-error', error: why }); ws.close(4010); return; }
    let s = this.sessions.get(cam.id);
    if (!s) this.sessions.set(cam.id, s = { camId: cam.id, camName: cam.name, listeners: new Map(), talker: null, camAudio: null, startedAt: Date.now(), names: new Set(), spoke: new Set() });
    s.listeners.set(ws, { id: user.id, name: user.name, rate: rateLimiter() });
    s.names.add(user.name);
    ws.on('message', (data, binary) => {
      const me = s.listeners.get(ws); if (!me) return;
      if (!binary) {
        let m; try { m = JSON.parse(data); } catch { return; }
        if (m.type === 'speak') {
          if (m.on && (!s.talker || s.talker === ws)) { s.talker = ws; s.spoke.add(me.name); }
          else if (!m.on && s.talker === ws) s.talker = null;
          else if (m.on) ws.send({ type: 'talk-error', error: `${s.listeners.get(s.talker).name} is talking. Wait until they finish.` });
          this.publish(cam.id);
        }
        return;
      }
      // Only the person who has the "floor" reaches the camera's speaker.
      if (s.talker !== ws || !s.camAudio || data.length > MAX_FRAME || !me.rate()) return;
      if (s.camAudio.bufferedAmount < 64_000) s.camAudio.send(data);
    });
    ws.on('close', () => {
      if (!s.listeners.delete(ws)) return;
      if (s.talker === ws) s.talker = null;
      if (!s.listeners.size) this.end(cam.id, 'hung up'); else this.publish(cam.id);
    });
    this.publish(cam.id);
  }

  /** The camera device connected its audio socket (after we told it a session started). */
  attachCamera(ws, cam) {
    const s = this.sessions.get(cam.id);
    if (!s) { ws.close(4011); return; }
    if (s.camAudio) try { s.camAudio.close(); } catch {}
    s.camAudio = ws; const rate = rateLimiter();
    ws.on('message', (data, binary) => {
      if (!binary || data.length > MAX_FRAME || !rate()) return;
      for (const l of s.listeners.keys()) if (l.bufferedAmount < 64_000) l.send(data);
    });
    ws.on('close', () => { if (s.camAudio === ws) { s.camAudio = null; if (this.sessions.get(cam.id) === s) this.publish(cam.id); } });
    this.publish(cam.id);
  }

  end(camId, reason) {
    const s = this.sessions.get(camId); if (!s) return;
    this.sessions.delete(camId);
    for (const ws of s.listeners.keys()) { ws.send({ type: 'talk-ended', reason }); ws.close(1000); }
    if (s.camAudio) try { s.camAudio.close(1000); } catch {}
    this.publish(camId);
    this.onEnd({ camId, camName: s.camName, startedAt: s.startedAt, durationSec: Math.round((Date.now() - s.startedAt) / 1000), people: [...s.names], spoke: [...s.spoke] });
  }
  endAllFor(camId) { this.end(camId, 'camera changed'); }
}

function rateLimiter() {
  let n = 0, t = Date.now();
  return () => { const now = Date.now(); if (now - t >= 1000) { t = now; n = 0; } return ++n <= MAX_FPS; };
}

module.exports = { TalkHub };
