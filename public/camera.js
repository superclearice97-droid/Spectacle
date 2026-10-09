'use strict';
// Turns a phone or webcam into a Spectacle camera: getUserMedia -> MediaRecorder (WebM) -> WebSocket.
const $ = s => document.querySelector(s);
let token = new URLSearchParams(location.hash.slice(1)).get('token');
try { if (token) { localStorage.setItem('sp_cam_token', token); history.replaceState(null, '', '/camera'); } else token = localStorage.getItem('sp_cam_token'); } catch {}
let stream, rec, ws, wake, running = false, retry = 1000;

if (!token) { $('#intro').textContent = 'This page needs a pairing link. Ask the family admin to open Settings → Cameras → "Get pairing link" and send it to this device.'; $('#form').hidden = true; }
if (!window.isSecureContext || !navigator.mediaDevices) { $('#err').textContent = 'Cameras only work over HTTPS. Open the pairing link using your server\'s https:// address.'; }
$('#ack').onchange = e => { $('#start').disabled = !e.target.checked; };
$('#start').onclick = () => start().catch(e => { $('#err').textContent = e.message; });
$('#stop').onclick = () => { running = false; teardown(); location.reload(); };
$('#flip').onclick = async () => { $('#facing').value = $('#facing').value === 'user' ? 'environment' : 'user'; teardown(); await start(); };
// In the Android app, "Dim screen" also turns the backlight right down.
const bridge = window.SpectacleAndroid;
$('#dimBtn').onclick = () => { $('#dim').classList.add('on'); bridge && bridge.dim(true); };
$('#dim').onclick = () => { $('#dim').classList.remove('on'); bridge && bridge.dim(false); };

function pickMime() {
  for (const m of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm;codecs=h264', 'video/webm']) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  throw new Error('This browser can\'t stream video. Try Chrome or Firefox.');
}
async function start() {
  running = true;
  stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: $('#facing').value, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 20 } } });
  $('#v').srcObject = stream;
  $('#setup').hidden = true; $('#cam').hidden = false;
  try { wake = await navigator.wakeLock.request('screen'); } catch {}
  connect();
}
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/ingest?token=' + encodeURIComponent(token));
  ws.binaryType = 'arraybuffer';
  setState('Connecting…', false);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'config') { $('#name').textContent = m.name; startRecorder(); } };
  ws.onclose = e => {
    stopRecorder();
    if (e.code === 4000) return setState('Another device took over this camera', false);
    if (e.code === 4002) { running = false; return setState('This camera was removed', false); }
    if (!running) return;
    setState('Reconnecting…', false);
    setTimeout(() => running && connect(), retry); retry = Math.min(retry * 2, 15000);
  };
}
function startRecorder() {
  rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 1_500_000 });
  rec.ondataavailable = async e => { if (e.data.size && ws.readyState === 1 && ws.bufferedAmount < 4e6) ws.send(await e.data.arrayBuffer()); };
  rec.start(500); retry = 1000; setState('REC', true);
}
function stopRecorder() { try { rec && rec.state !== 'inactive' && rec.stop(); } catch {} rec = null; }
function teardown() { stopRecorder(); try { ws && ws.close(); } catch {} stream && stream.getTracks().forEach(t => t.stop()); }
function setState(t, live) { $('#state').textContent = t; $('#state').className = 'pill ' + (live ? 'rec' : 'warn'); }
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && running) { try { wake = await navigator.wakeLock.request('screen'); } catch {} } });
