#!/usr/bin/env node
// Checks the plain-RTSP detector that drives the "this stream is not encrypted" warning.
'use strict';
const { isPlainRtsp } = require('../server/lib/cameras');

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

console.log('Plain RTSP detection');
ok(isPlainRtsp('rtsp://192.168.1.20:554/stream1') === true, 'rtsp:// is flagged');
ok(isPlainRtsp('RTSP://user:pw@cam.local/s') === true, 'case is ignored and credentials do not matter');
ok(isPlainRtsp('rtsps://192.168.1.20:322/stream1') === false, 'rtsps:// is not flagged');
ok(isPlainRtsp('RtspS://cam/s') === false, 'rtsps:// in any case is not flagged');
ok(isPlainRtsp('') === false && isPlainRtsp(undefined) === false && isPlainRtsp(null) === false, 'empty values are not flagged');
ok(isPlainRtsp('http://x/rtsp://y') === false, 'rtsp:// later in the text does not count');
process.exit(fails ? 1 : 0);
