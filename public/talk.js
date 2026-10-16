'use strict';
// Shared two-way talk helpers for the app and the camera page (window.SpTalk).
// Audio is live only: it's relayed through your own Spectacle server and never recorded.
(function () {
  let ctx = null, loaded = null;
  /** Must first be called from a tap (browsers only allow sound after the person interacts). */
  async function audio() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    // Never hang waiting for a sound device (no speaker, Bluetooth glitch): carry on after 1.5 s.
    if (ctx.state === 'suspended') await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1500))]);
    if (!loaded) loaded = ctx.audioWorklet.addModule('/audio-worklets.js');
    await loaded;
    return ctx;
  }
  /** Microphone -> 20 ms PCM frames. Echo cancellation and noise suppression on, so a phone on speaker works. */
  async function mic(onFrame, onLevel) {
    const c = await audio();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
    const src = c.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(c, 'sp-capture');
    const sink = c.createGain(); sink.gain.value = 0; // keeps the graph running without playing your own voice back
    node.port.onmessage = e => { if (e.data instanceof ArrayBuffer) onFrame(e.data); else if (onLevel && e.data.level != null) onLevel(e.data.level); };
    src.connect(node); node.connect(sink); sink.connect(c.destination);
    return { stop() { try { src.disconnect(); node.disconnect(); } catch {} stream.getTracks().forEach(t => t.stop()); } };
  }
  /** Plays PCM frames as they arrive. volume 0..2 */
  async function speaker(volume = 1) {
    const c = await audio();
    const node = new AudioWorkletNode(c, 'sp-play', { outputChannelCount: [1] });
    const gain = c.createGain(); gain.gain.value = volume;
    node.connect(gain); gain.connect(c.destination);
    return { push(buf) { node.port.postMessage(buf, [buf]); }, volume(v) { gain.gain.value = v; }, stop() { try { node.disconnect(); gain.disconnect(); } catch {} } };
  }
  /** A friendly two-tone chime (ding-dong), generated so there's no sound file to load. */
  async function chime(kind = 'talk') {
    const c = await audio(), t = c.currentTime;
    const notes = kind === 'ring' ? [[659, 0], [523, 0.45]] : [[880, 0], [1175, 0.18]];
    for (const [f, d] of notes) {
      const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(0.35, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.9);
      o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + 1);
    }
  }
  const supported = () => !!(window.AudioWorkletNode && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
  const state = () => (ctx ? ctx.state : 'none');
  window.SpTalk = { audio, mic, speaker, chime, supported, state };
})();
