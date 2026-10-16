'use strict';
// Turns a phone or webcam into a Spectacle camera: getUserMedia -> MediaRecorder (WebM) -> WebSocket.
const $ = s => document.querySelector(s);
let token = new URLSearchParams(location.hash.slice(1)).get('token');
try { if (token) { localStorage.setItem('sp_cam_token', token); history.replaceState(null, '', '/camera'); } else token = localStorage.getItem('sp_cam_token'); } catch {}
let stream, rec, ws, wake, running = false, retry = 1000, cfg = {};

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
  // Unlock sound now (browsers need a tap first), so a doorbell chime or a family member's voice can play later.
  if (window.SpTalk && SpTalk.supported()) SpTalk.audio().catch(() => {});
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
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'config') { $('#name').textContent = m.name; cfg = m; $('#ring').hidden = !m.doorbell; startRecorder(); if (m.talk) primeMic(); }
    else if (m.type === 'talk') onTalk(m);
    else if (m.type === 'ring-ok') ringDone(m.sent);
  };
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

// ---------------- two-way talk & doorbell ----------------
// Ask for microphone permission once, while the person setting up the camera is here. The mic itself is
// only switched on during a talk session, which always shows a notice and plays a chime first.
let micAsked = false;
async function primeMic() {
  if (micAsked || !window.SpTalk || !SpTalk.supported()) return; micAsked = true;
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); } catch {}
}
let call = null; // { sock, mic, spk }
async function onTalk(m) {
  if (m.active && !call) {
    call = { opening: true };
    $('#talkbar').hidden = false; $('#dim').classList.remove('on'); bridge && bridge.dim(false);
    try {
      SpTalk.chime('talk').catch(() => {});
      const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/cam-audio?token=' + encodeURIComponent(token));
      sock.binaryType = 'arraybuffer';
      const spk = await SpTalk.speaker(1.6);
      sock.onmessage = e => { if (e.data instanceof ArrayBuffer) spk.push(e.data); };
      const mic = await SpTalk.mic(f => { if (sock.readyState === 1 && sock.bufferedAmount < 64000) sock.send(f); });
      sock.onclose = () => { if (call && call.sock === sock) endCall(); };
      call = { sock, mic, spk };
    } catch (e) { $('#talkWho').textContent = 'Couldn\'t start the microphone: ' + e.message; }
  }
  if (!m.active) { endCall(); return; }
  const people = (m.people || []).join(' & ') || 'Someone from the house';
  $('#talkWho').textContent = m.talker ? `${m.talker} is talking to you` : `${people} can hear you`;
}
function endCall() {
  if (!call) return;
  try { call.mic && call.mic.stop(); call.spk && call.spk.stop(); call.sock && call.sock.close(); } catch {}
  call = null; $('#talkbar').hidden = true;
}
function ring() {
  if (!ws || ws.readyState !== 1) return;
  $('#ring').disabled = true; $('#ring').textContent = '🔔 Ringing…';
  SpTalk && SpTalk.chime('ring').catch(() => {});
  ws.send(JSON.stringify({ type: 'ring' }));
}
function ringDone(sent) {
  $('#ring').textContent = sent ? '✓ They\'ve been told' : '🔔 Ring';
  setTimeout(() => { $('#ring').disabled = false; $('#ring').textContent = '🔔 Ring'; }, sent ? 20000 : 3000);
}
$('#ring').onclick = e => { e.stopPropagation(); ring(); };
