'use strict';
// Frame-difference motion detector on small greyscale frames (160x90).
const W = 160, H = 90;

class MotionDetector {
  constructor(sensitivity = 5) { this.setSensitivity(sensitivity); this.bg = null; this.hits = 0; this.n = 0; }
  setSensitivity(s) {
    s = Math.max(1, Math.min(10, Number(s) || 5));
    this.pixelThresh = 34 - s * 2.4;        // per-pixel brightness change needed
    this.areaThresh = 0.03 / s;             // fraction of frame that must change
  }
  // Returns null or { score, box:{x,y,w,h} normalised }.
  feed(frame) {
    this.n++;
    if (!this.bg) { this.bg = Float32Array.from(frame); return null; }
    let changed = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    const bg = this.bg;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; const d = Math.abs(frame[i] - bg[i]);
      if (d > this.pixelThresh) { changed++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      bg[i] += (frame[i] - bg[i]) * 0.08; // slowly adapt to lighting
    }
    const frac = changed / (W * H);
    if (this.n < 8) return null;                         // warm-up
    if (frac > 0.6) { this.bg = Float32Array.from(frame); this.hits = 0; return null; } // lights switched / camera moved
    if (frac < this.areaThresh) { this.hits = 0; return null; }
    if (++this.hits < 2) return null;                    // needs two frames in a row
    return { score: Math.min(1, frac / (this.areaThresh * 10)), box: { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H } };
  }
}

module.exports = { MotionDetector, MW: W, MH: H };
