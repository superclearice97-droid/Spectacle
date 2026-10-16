// Audio worklets for Spectacle two-way talk. Live audio only: nothing here is stored.
// Wire format: mono 16-bit little-endian PCM at 16 kHz, ~20 ms per message.
const RATE = 16000;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / RATE; this.pos = 0; this.out = new Int16Array(320); this.n = 0; this.level = 0; this.k = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Simple averaging downsampler (good enough for speech, cheap on old phones).
    for (let i = 0; i < ch.length; i++) {
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, ch[i]));
        this.out[this.n++] = v * 32767;
        this.level = Math.max(this.level * 0.995, Math.abs(v));
        if (this.n === this.out.length) {
          this.port.postMessage(this.out.buffer.slice(0));
          this.n = 0;
          if (++this.k % 5 === 0) this.port.postMessage({ level: this.level });
        }
      }
    }
    return true;
  }
}

class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(RATE * 2); this.r = 0; this.w = 0; this.started = false;
    this.step = RATE / sampleRate; this.frac = 0;
    this.port.onmessage = e => {
      const pcm = new Int16Array(e.data);
      for (let i = 0; i < pcm.length; i++) { this.buf[this.w] = pcm[i] / 32768; this.w = (this.w + 1) % this.buf.length; if (this.w === this.r) this.r = (this.r + 1) % this.buf.length; }
    };
  }
  avail() { return (this.w - this.r + this.buf.length) % this.buf.length; }
  process(_in, outputs) {
    const out = outputs[0][0]; if (!out) return true;
    // Small jitter buffer: start after ~120 ms; if we fall too far behind (>600 ms), skip ahead to stay live.
    if (!this.started) { if (this.avail() < RATE * 0.12) { out.fill(0); return true; } this.started = true; }
    if (this.avail() > RATE * 0.6) this.r = (this.w - Math.floor(RATE * 0.15) + this.buf.length) % this.buf.length;
    for (let i = 0; i < out.length; i++) {
      if (this.avail() < 2) { out[i] = 0; this.started = this.avail() > 0; continue; }
      const a = this.buf[this.r], b = this.buf[(this.r + 1) % this.buf.length];
      out[i] = a + (b - a) * this.frac;
      this.frac += this.step;
      while (this.frac >= 1) { this.frac -= 1; this.r = (this.r + 1) % this.buf.length; }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('sp-capture', Capture);
registerProcessor('sp-play', Play);
