'use strict';
// Runs the D-FINE object detector (ONNX) off the main thread, so live video and alerts never stall.
const { parentPort, workerData } = require('worker_threads');

let ort, session, loadErr = null;
(async () => {
  try {
    ort = require(workerData.ortPath);
    session = await ort.InferenceSession.create(workerData.model, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: workerData.threads,
      interOpNumThreads: 1,
    });
    parentPort.postMessage({ type: 'ready' });
  } catch (e) { loadErr = e.message; parentPort.postMessage({ type: 'error', error: e.message }); }
})();

parentPort.on('message', async ({ id, rgb, w, h, minScore }) => {
  if (!session) return parentPort.postMessage({ id, error: loadErr || 'Detector is still starting' });
  try {
    // HWC uint8 RGB 640x640 -> CHW float32 0..1 (what D-FINE was trained with: plain resize, no mean/std).
    const src = new Uint8Array(rgb), S = 640 * 640, data = new Float32Array(3 * S);
    for (let i = 0, j = 0; i < S; i++, j += 3) { data[i] = src[j] / 255; data[S + i] = src[j + 1] / 255; data[2 * S + i] = src[j + 2] / 255; }
    const t = Date.now();
    const out = await session.run({
      images: new ort.Tensor('float32', data, [1, 3, 640, 640]),
      orig_target_sizes: new ort.Tensor('int64', BigInt64Array.from([BigInt(w), BigInt(h)]), [1, 2]),
    });
    const labels = out.labels.data, boxes = out.boxes.data, scores = out.scores.data, dets = [];
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] < minScore) continue;
      const x1 = Math.max(0, boxes[i * 4]), y1 = Math.max(0, boxes[i * 4 + 1]), x2 = Math.min(w, boxes[i * 4 + 2]), y2 = Math.min(h, boxes[i * 4 + 3]);
      if (x2 <= x1 || y2 <= y1) continue;
      dets.push({ cls: Number(labels[i]), score: scores[i], box: { x: x1 / w, y: y1 / h, w: (x2 - x1) / w, h: (y2 - y1) / h } });
    }
    parentPort.postMessage({ id, dets, ms: Date.now() - t });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
