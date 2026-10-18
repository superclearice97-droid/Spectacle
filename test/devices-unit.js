#!/usr/bin/env node
// USB/V4L2 device discovery and format choice, against a fake /dev, /sys and FFmpeg.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const devices = require('../server/lib/devices');
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ✓ ' + msg); };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectacle-dev-'));
  const dev = path.join(tmp, 'dev'), sys = path.join(tmp, 'sys');
  const node = (n, name, index) => {
    fs.mkdirSync(path.join(sys, n), { recursive: true }); fs.writeFileSync(path.join(dev, n), '');
    fs.writeFileSync(path.join(sys, n, 'name'), name + '\n'); fs.writeFileSync(path.join(sys, n, 'index'), index + '\n');
  };
  fs.mkdirSync(path.join(dev, 'v4l', 'by-id'), { recursive: true });
  node('video0', 'HD USB Camera', 0); node('video1', 'HD USB Camera', 1); node('video2', 'Pixel 8 webcam', 0); node('video3', 'Locked cam', 0); node('video10', 'Codec', 0);
  fs.symlinkSync('../../video0', path.join(dev, 'v4l', 'by-id', 'usb-Acme_HD_USB_Camera-video-index0'));
  // Fake FFmpeg: prints `-list_formats` output for the device it's given, on stderr like the real one.
  const ff = path.join(tmp, 'ffmpeg');
  fs.writeFileSync(ff, `#!/bin/sh
for a; do d="$a"; done
case "$d" in
  */video0) echo "[video4linux2,v4l2 @ 0x1] Raw       :     yuyv422 :           YUYV 4:2:2 : 640x480 1280x720 1920x1080" >&2
            echo "[video4linux2,v4l2 @ 0x1] Compressed:       mjpeg :          Motion-JPEG : 640x480 1280x720 1920x1080 3840x2160" >&2 ;;
  */video2) echo "[video4linux2,v4l2 @ 0x1] Compressed:       mjpeg :          Motion-JPEG : 1280x720 1920x1080" >&2 ;;
  */video3) echo "$d: Permission denied" >&2 ;;
  *) echo "$d: Inappropriate ioctl for device" >&2 ;;
esac
exit 1
`, { mode: 0o755 });
  const list = await devices.list(ff, { dev, sys });
  ok(list.map(d => d.name).join('|') === 'HD USB Camera|Pixel 8 webcam|Locked cam', 'lists capture devices, skips metadata and non-camera nodes: ' + list.map(d => d.name).join(', '));
  ok(list[0].path === '/dev/v4l/by-id/usb-Acme_HD_USB_Camera-video-index0', 'prefers the stable by-id path');
  ok(list[1].path === '/dev/video2' && list[1].formats.includes('mjpeg'), 'falls back to /dev/videoN');
  ok(list[2].problem === 'denied', 'flags a camera it has no permission to open');

  const fmt = (compressed, name, ...sizes) => ({ compressed, name, sizes });
  ok(devices.inputArgs([fmt(false, 'yuyv422', [640, 480], [1920, 1080]), fmt(true, 'mjpeg', [1280, 720], [1920, 1080], [3840, 2160])]).join(' ') === '-input_format mjpeg -video_size 1920x1080', 'MJPEG at up to 1080p is preferred');
  ok(devices.inputArgs([fmt(false, 'yuyv422', [640, 480], [1280, 720], [1920, 1080])]).join(' ') === '-input_format yuyv422 -video_size 1280x720', 'raw video capped at 720p');
  ok(devices.inputArgs([fmt(false, 'yuv420p')]).join(' ') === '-input_format yuv420p -video_size 1280x720', 'stepwise sizes (e.g. a phone through scrcpy) get 720p');
  ok(devices.inputArgs([]).length === 0, 'unknown formats leave FFmpeg to choose');

  for (const p of ['/dev/video0', '/dev/v4l/by-id/usb-Acme_HD-video-index0', '/dev/v4l/by-path/pci-0000:00:14.0-usb-0:1:1.0-video-index0']) ok(devices.validDevice(p), 'accepts ' + p);
  for (const p of ['/etc/passwd', '/dev/sda', '/dev/v4l/by-id/../../sda', '/dev/v4l/by-id/..', 'video0', '/dev/video0; rm -rf ~', null]) ok(!devices.validDevice(p), 'rejects ' + p);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Device tests passed');
})().catch(e => { console.error(e); process.exit(1); });
