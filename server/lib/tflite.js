// Minimal, dependency-free TensorFlow Lite interpreter for quantized (uint8)
// MobileNet-style image classifiers. Supports the ops used by the bundled
// iNaturalist insect / plant / bird models. Runs fully offline.
'use strict';
const fs = require('fs');

// ---------- FlatBuffer reader ----------
class FB {
  constructor(buf) { this.b = buf; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u8(o) { return this.dv.getUint8(o); }
  i32(o) { return this.dv.getInt32(o, true); }
  u32(o) { return this.dv.getUint32(o, true); }
  u16(o) { return this.dv.getUint16(o, true); }
  f32(o) { return this.dv.getFloat32(o, true); }
  i64(o) { return Number(this.dv.getBigInt64(o, true)); }
  root() { return this.u32(0); }
  field(t, i) { // returns absolute offset of field i in table t, or 0
    const vt = t - this.i32(t);
    const vlen = this.u16(vt);
    const fo = 4 + i * 2;
    if (fo >= vlen) return 0;
    const off = this.u16(vt + fo);
    return off ? t + off : 0;
  }
  table(t, i) { const f = this.field(t, i); return f ? f + this.u32(f) : 0; }
  scalar(t, i, kind, def = 0) { const f = this.field(t, i); if (!f) return def; return this[kind](f); }
  vec(t, i) { const f = this.field(t, i); if (!f) return null; const v = f + this.u32(f); return { start: v + 4, len: this.u32(v) }; }
  vecTables(t, i) { const v = this.vec(t, i); if (!v) return []; const out = []; for (let k = 0; k < v.len; k++) { const e = v.start + k * 4; out.push(e + this.u32(e)); } return out; }
  vecI32(t, i) { const v = this.vec(t, i); if (!v) return []; const a = []; for (let k = 0; k < v.len; k++) a.push(this.i32(v.start + k * 4)); return a; }
  vecF32(t, i) { const v = this.vec(t, i); if (!v) return []; const a = []; for (let k = 0; k < v.len; k++) a.push(this.f32(v.start + k * 4)); return a; }
  vecI64(t, i) { const v = this.vec(t, i); if (!v) return []; const a = []; for (let k = 0; k < v.len; k++) a.push(this.i64(v.start + k * 8)); return a; }
  str(t, i) { const v = this.vec(t, i); return v ? this.b.toString('utf8', v.start, v.start + v.len) : ''; }
  bytes(t, i) { const v = this.vec(t, i); return v ? this.b.subarray(v.start, v.start + v.len) : null; }
}

const OP = { ADD: 0, AVERAGE_POOL_2D: 1, CONCATENATION: 2, CONV_2D: 3, DEPTHWISE_CONV_2D: 4, DEQUANTIZE: 6, FULLY_CONNECTED: 9, MAX_POOL_2D: 17, RELU: 19, RELU6: 21, RESHAPE: 22, SOFTMAX: 25, MEAN: 40, SQUEEZE: 43, QUANTIZE: 114 };
const ACT = { NONE: 0, RELU: 1, RELU_N1_TO_1: 2, RELU6: 3 };

class Model {
  constructor(path) {
    const buf = fs.readFileSync(path);
    const fb = new FB(buf);
    const m = fb.root();
    const opcodes = fb.vecTables(m, 1).map(oc => Math.max(fb.scalar(oc, 0, 'u8'), fb.scalar(oc, 3, 'i32')));
    const buffers = fb.vecTables(m, 4).map(b => fb.bytes(b, 0));
    const sg = fb.vecTables(m, 2)[0];
    this.tensors = fb.vecTables(sg, 0).map(t => {
      const q = fb.table(t, 4);
      const scale = q ? fb.vecF32(q, 2) : [];
      const zp = q ? fb.vecI64(q, 3) : [];
      const bi = fb.scalar(t, 2, 'u32');
      return { shape: fb.vecI32(t, 0), type: fb.scalar(t, 1, 'u8'), name: fb.str(t, 3), scale: scale[0] ?? 0, zp: zp[0] ?? 0, scales: scale, data: buffers[bi] && buffers[bi].length ? buffers[bi] : null };
    });
    this.inputs = fb.vecI32(sg, 1);
    this.outputs = fb.vecI32(sg, 2);
    this.ops = fb.vecTables(sg, 3).map(o => {
      const code = opcodes[fb.scalar(o, 0, 'u32')];
      const opt = fb.table(o, 4);
      const g = (i, k = 'i32', d = 0) => opt ? fb.scalar(opt, i, k, d) : d;
      let options = {};
      if (code === OP.CONV_2D) options = { padding: g(0, 'u8'), sw: g(1), sh: g(2), act: g(3, 'u8'), dw: g(4, 'i32', 1), dh: g(5, 'i32', 1) };
      else if (code === OP.DEPTHWISE_CONV_2D) options = { padding: g(0, 'u8'), sw: g(1), sh: g(2), mult: g(3, 'i32', 1), act: g(4, 'u8'), dw: g(5, 'i32', 1), dh: g(6, 'i32', 1) };
      else if (code === OP.AVERAGE_POOL_2D || code === OP.MAX_POOL_2D) options = { padding: g(0, 'u8'), sw: g(1), sh: g(2), fw: g(3), fh: g(4), act: g(5, 'u8') };
      else if (code === OP.ADD || code === OP.FULLY_CONNECTED) options = { act: g(0, 'u8') };
      else if (code === OP.SOFTMAX) options = { beta: opt ? fb.scalar(opt, 0, 'f32', 1) : 1 };
      return { code, inputs: fb.vecI32(o, 1), outputs: fb.vecI32(o, 2), options };
    });
    for (const op of this.ops) if (!Object.values(OP).includes(op.code)) throw new Error('Unsupported TFLite op code ' + op.code);
    const it = this.tensors[this.inputs[0]];
    this.inputShape = it.shape; // [1,H,W,3]
    this._prepWeights();
  }

  _prepWeights() {
    // Pre-subtract zero points into Int16 arrays for fast inner loops.
    for (const op of this.ops) {
      if (op.code === OP.CONV_2D || op.code === OP.DEPTHWISE_CONV_2D || op.code === OP.FULLY_CONNECTED) {
        const w = this.tensors[op.inputs[1]];
        if (w.type !== 3) throw new Error('Only uint8-quantized weights supported');
        const a = new Int16Array(w.data.length);
        for (let i = 0; i < a.length; i++) a[i] = w.data[i] - w.zp;
        op.w = a;
        const b = op.inputs[2] >= 0 ? this.tensors[op.inputs[2]] : null;
        op.bias = b && b.data ? new Int32Array(b.data.buffer.slice(b.data.byteOffset, b.data.byteOffset + b.data.length)) : null;
      }
    }
  }

  actRange(act, scale, zp) {
    let lo = 0, hi = 255;
    const q = v => Math.round(v / scale) + zp;
    if (act === ACT.RELU) lo = Math.max(lo, q(0));
    else if (act === ACT.RELU6) { lo = Math.max(lo, q(0)); hi = Math.min(hi, q(6)); }
    else if (act === ACT.RELU_N1_TO_1) { lo = Math.max(lo, q(-1)); hi = Math.min(hi, q(1)); }
    return [lo, hi];
  }

  // rgb: Uint8Array of H*W*3 matching the input shape. Returns Float32Array of probabilities.
  run(rgb) {
    const vals = new Map();
    const inT = this.tensors[this.inputs[0]];
    if (rgb.length !== inT.shape.reduce((a, b) => a * b, 1)) throw new Error('Bad input size');
    vals.set(this.inputs[0], rgb);
    const get = i => vals.has(i) ? vals.get(i) : this.tensors[i].data;
    for (const op of this.ops) {
      const T = this.tensors, inp = op.inputs, out = op.outputs[0], ot = T[out];
      const x = get(inp[0]), xt = T[inp[0]];
      let y;
      switch (op.code) {
        case OP.CONV_2D: y = this.conv(x, xt, T[inp[1]], op, ot, false); break;
        case OP.DEPTHWISE_CONV_2D: y = this.conv(x, xt, T[inp[1]], op, ot, true); break;
        case OP.ADD: {
          const b = get(inp[1]), bt = T[inp[1]];
          const [lo, hi] = this.actRange(op.options.act, ot.scale, ot.zp);
          y = new Uint8Array(x.length);
          const s1 = xt.scale / ot.scale, s2 = bt.scale / ot.scale;
          for (let i = 0; i < x.length; i++) { let v = Math.round(s1 * (x[i] - xt.zp) + s2 * (b[i] - bt.zp)) + ot.zp; y[i] = v < lo ? lo : v > hi ? hi : v; }
          break;
        }
        case OP.AVERAGE_POOL_2D: case OP.MAX_POOL_2D: y = this.pool(x, xt, op, ot); break;
        case OP.MEAN: { // mean over H,W
          const [, H, W, C] = xt.shape; y = new Uint8Array(C); const r = xt.scale / ot.scale;
          for (let c = 0; c < C; c++) { let s = 0; for (let p = 0; p < H * W; p++) s += x[p * C + c] - xt.zp; y[c] = clamp(Math.round(r * s / (H * W)) + ot.zp); }
          break;
        }
        case OP.FULLY_CONNECTED: {
          const wt = T[inp[1]], [O, I] = wt.shape, w = op.w; y = new Uint8Array(O);
          const m = xt.scale * wt.scale / ot.scale; const [lo, hi] = this.actRange(op.options.act, ot.scale, ot.zp);
          const xs = new Int16Array(I); for (let i = 0; i < I; i++) xs[i] = x[i] - xt.zp;
          for (let o = 0; o < O; o++) { let acc = op.bias ? op.bias[o] : 0; const base = o * I; for (let i = 0; i < I; i++) acc += xs[i] * w[base + i]; let v = Math.round(acc * m) + ot.zp; y[o] = v < lo ? lo : v > hi ? hi : v; }
          break;
        }
        case OP.RESHAPE: case OP.SQUEEZE: y = x; break;
        case OP.SOFTMAX: {
          const n = x.length; const f = new Float64Array(n); let mx = -Infinity;
          for (let i = 0; i < n; i++) { f[i] = op.options.beta * xt.scale * (x[i] - xt.zp); if (f[i] > mx) mx = f[i]; }
          let s = 0; for (let i = 0; i < n; i++) { f[i] = Math.exp(f[i] - mx); s += f[i]; }
          y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = f[i] / s;
          vals.set(out, y); vals.set('float:' + out, true); continue;
        }
        case OP.DEQUANTIZE: { y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = xt.scale * (x[i] - xt.zp); vals.set('float:' + out, true); break; }
        case OP.QUANTIZE: { y = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) y[i] = clamp(Math.round(x[i] / ot.scale) + ot.zp); break; }
        default: throw new Error('op ' + op.code);
      }
      vals.set(out, y);
    }
    const oid = this.outputs[0];
    const o = vals.get(oid);
    if (vals.get('float:' + oid)) return o;
    const t = this.tensors[oid]; const r = new Float32Array(o.length);
    for (let i = 0; i < o.length; i++) r[i] = t.scale * (o[i] - t.zp);
    return r;
  }

  conv(x, xt, wt, op, ot, depthwise) {
    const [, H, W, C] = xt.shape; const [, OH, OW, OC] = ot.shape;
    const { sw, sh, dw, dh } = op.options;
    const KH = wt.shape[1], KW = wt.shape[2];
    const padH = op.options.padding === 0 ? Math.max(((OH - 1) * sh + (KH - 1) * dh + 1 - H), 0) >> 1 : 0;
    const padW = op.options.padding === 0 ? Math.max(((OW - 1) * sw + (KW - 1) * dw + 1 - W), 0) >> 1 : 0;
    const m = xt.scale * wt.scale / ot.scale; const [lo, hi] = this.actRange(op.options.act, ot.scale, ot.zp);
    const xs = new Int16Array(x.length); const z = xt.zp; for (let i = 0; i < x.length; i++) xs[i] = x[i] - z;
    const w = op.w, bias = op.bias, y = new Uint8Array(OH * OW * OC), zo = ot.zp;
    if (!depthwise && KH === 1 && KW === 1 && sh === 1 && sw === 1) { // pointwise fast path
      const acc = new Int32Array(OC);
      const xrow = new Int32Array(C);
      for (let p = 0, P = H * W; p < P; p++) {
        const xb = p * C;
        for (let c = 0; c < C; c++) xrow[c] = xs[xb + c];
        let o = 0;
        // 4 output channels per pass so each input value is loaded once for four multiplies.
        for (; o + 3 < OC; o += 4) {
          let a0 = 0, a1 = 0, a2 = 0, a3 = 0; const w0 = o * C, w1 = w0 + C, w2 = w1 + C, w3 = w2 + C;
          for (let c = 0; c < C; c++) { const v = xrow[c]; a0 += v * w[w0 + c]; a1 += v * w[w1 + c]; a2 += v * w[w2 + c]; a3 += v * w[w3 + c]; }
          if (bias) { a0 += bias[o]; a1 += bias[o + 1]; a2 += bias[o + 2]; a3 += bias[o + 3]; }
          acc[o] = a0; acc[o + 1] = a1; acc[o + 2] = a2; acc[o + 3] = a3;
        }
        for (; o < OC; o++) { let a = bias ? bias[o] : 0; const wb = o * C; for (let c = 0; c < C; c++) a += xrow[c] * w[wb + c]; acc[o] = a; }
        const yb = p * OC;
        for (let o = 0; o < OC; o++) { let v = Math.round(acc[o] * m) + zo; y[yb + o] = v < lo ? lo : v > hi ? hi : v; }
      }
      return y;
    }
    const mult = depthwise ? OC / C : 0;
    for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) {
      const iy0 = oy * sh - padH, ix0 = ox * sw - padW, yb = (oy * OW + ox) * OC;
      for (let o = 0; o < OC; o++) {
        let a = bias ? bias[o] : 0;
        if (depthwise) {
          const c = (o / mult) | 0;
          for (let ky = 0; ky < KH; ky++) { const iy = iy0 + ky * dh; if (iy < 0 || iy >= H) continue;
            for (let kx = 0; kx < KW; kx++) { const ix = ix0 + kx * dw; if (ix < 0 || ix >= W) continue;
              a += xs[(iy * W + ix) * C + c] * w[(ky * KW + kx) * OC + o]; } }
        } else {
          for (let ky = 0; ky < KH; ky++) { const iy = iy0 + ky * dh; if (iy < 0 || iy >= H) continue;
            for (let kx = 0; kx < KW; kx++) { const ix = ix0 + kx * dw; if (ix < 0 || ix >= W) continue;
              const xb = (iy * W + ix) * C, wb = ((o * KH + ky) * KW + kx) * C;
              for (let c = 0; c < C; c++) a += xs[xb + c] * w[wb + c]; } }
        }
        let v = Math.round(a * m) + zo; y[yb + o] = v < lo ? lo : v > hi ? hi : v;
      }
    }
    return y;
  }

  pool(x, xt, op, ot) {
    const [, H, W, C] = xt.shape; const [, OH, OW] = ot.shape; const { sw, sh, fw, fh } = op.options;
    const padH = op.options.padding === 0 ? Math.max((OH - 1) * sh + fh - H, 0) >> 1 : 0;
    const padW = op.options.padding === 0 ? Math.max((OW - 1) * sw + fw - W, 0) >> 1 : 0;
    const y = new Uint8Array(OH * OW * C); const max = op.code === OP.MAX_POOL_2D; const r = xt.scale / ot.scale;
    for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) for (let c = 0; c < C; c++) {
      let s = 0, n = 0, mx = 0;
      for (let ky = 0; ky < fh; ky++) { const iy = oy * sh - padH + ky; if (iy < 0 || iy >= H) continue;
        for (let kx = 0; kx < fw; kx++) { const ix = ox * sw - padW + kx; if (ix < 0 || ix >= W) continue;
          const v = x[(iy * W + ix) * C + c]; s += v - xt.zp; n++; if (v > mx) mx = v; } }
      y[(oy * OW + ox) * C + c] = max ? mx : clamp(Math.round(r * s / n) + ot.zp);
    }
    return y;
  }
}
function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

module.exports = { Model };
