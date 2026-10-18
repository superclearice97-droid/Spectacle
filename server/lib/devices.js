'use strict';
// Video devices plugged into this computer (Linux V4L2): USB webcams, capture cards, and phones that
// show up as a webcam over USB (Android 14+ "USB webcam" mode, or scrcpy feeding a v4l2loopback device).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Only real capture nodes are accepted as a camera's device, never an arbitrary file.
const DEVICE_RE = /^\/dev\/(video\d+|v4l\/by-(id|path)\/[\w:+@-][\w.:+@-]*)$/;
const validDevice = p => typeof p === 'string' && DEVICE_RE.test(p);

/* Ask FFmpeg which formats a device offers. Resolves to { formats: [{ compressed, name, sizes: [[w,h]] }] } or { error }. */
function probe(ffmpeg, dev) {
  return new Promise(resolve => {
    execFile(ffmpeg, ['-hide_banner', '-f', 'v4l2', '-list_formats', 'all', '-i', dev], { timeout: 5000 }, (_e, _out, err) => {
      const formats = [];
      for (const line of String(err).split('\n')) {
        const m = /\]\s*(Raw|Emulated|Compressed)\s*:\s*(\S+)\s*:(.*)$/.exec(line);   // sizes follow the description, e.g. "YUYV 4:2:2 : 640x480 1280x720"
        if (m) formats.push({ compressed: m[1] === 'Compressed', name: m[2], sizes: [...m[3].matchAll(/(\d+)x(\d+)/g)].map(s => [+s[1], +s[2]]) });
      }
      resolve(formats.length ? { formats } : { error: /Permission denied/i.test(err) ? 'denied' : /busy/i.test(err) ? 'busy' : 'none' });
    });
  });
}

/* FFmpeg input options for the best picture a device offers: MJPEG/H.264 up to 1080p, otherwise raw up to 720p (USB 2 bandwidth). */
function inputArgs(formats) {
  const best = (list, maxW, maxH) => {
    let pick = null;
    for (const f of list) for (const [w, h] of f.sizes) if (w <= maxW && h <= maxH && (!pick || w * h > pick.w * pick.h)) pick = { name: f.name, w, h };
    if (!pick) { const f = list.find(f => !f.sizes.length); if (f) pick = { name: f.name, w: Math.min(1280, maxW), h: Math.min(720, maxH) }; }   // stepwise sizes
    return pick;
  };
  const enc = (formats || []).filter(f => f.compressed && ['mjpeg', 'h264'].includes(f.name));
  const raw = (formats || []).filter(f => !f.compressed);
  const pick = best(enc, 1920, 1080) || best(raw, 1280, 720);
  return pick ? ['-input_format', pick.name, '-video_size', `${pick.w}x${pick.h}`] : [];
}

/* Every capture device, named, with a path that stays the same after reboots and replugging when the system provides one. */
async function list(ffmpeg, { dev = '/dev', sys = '/sys/class/video4linux' } = {}) {
  let nodes; try { nodes = fs.readdirSync(dev).filter(n => /^video\d+$/.test(n)).sort((a, b) => a.slice(5) - b.slice(5)); } catch { nodes = []; }
  const stable = {};
  for (const kind of ['by-path', 'by-id']) {   // by-id wins: it names the device itself, not the port it's plugged into
    const dir = path.join(dev, 'v4l', kind);
    try { for (const l of fs.readdirSync(dir)) { try { stable[path.basename(fs.realpathSync(path.join(dir, l)))] = `/dev/v4l/${kind}/${l}`; } catch {} } } catch {}
  }
  const read = (n, f) => { try { return fs.readFileSync(path.join(sys, n, f), 'utf8').trim(); } catch { return null; } };
  const found = await Promise.all(nodes.map(async n => {
    if ((read(n, 'index') || '0') !== '0') return null;   // a USB camera's second node carries metadata, not video
    const r = await probe(ffmpeg, path.join(dev, n));
    if (r.error === 'none') return null;
    return { path: stable[n] || `/dev/${n}`, node: `/dev/${n}`, name: read(n, 'name') || n, ...(r.error ? { problem: r.error } : { formats: r.formats.map(f => f.name) }) };
  }));
  return found.filter(Boolean);
}

module.exports = { list, probe, inputArgs, validDevice };
