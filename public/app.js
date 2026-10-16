'use strict';
// Spectacle web app (no build step, no frameworks).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = n => esc(String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase());
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = t => { const d = new Date(t), today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1); if (d.toDateString() === today.toDateString()) return 'Today'; if (d.toDateString() === y.toDateString()) return 'Yesterday'; return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }); };
const ago = t => { const s = (Date.now() - new Date(t)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; };
const view = $('#view');

let T = null; // the open intercom call, if any
const S = { talk: {}, me: null, armed: true, cameras: [], presence: [], ws: null, route: '', vapidKey: '', events: [], feed: [] };

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'X-Spectacle': '1' }, credentials: 'same-origin' };
  if (opts.body instanceof Blob) { init.body = opts.body; init.headers['Content-Type'] = opts.body.type || 'application/octet-stream'; }
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !opts.allow401) { S.me = null; boot(); throw new Error('Please sign in'); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}

function toast(title, body, kind = '', onclick) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.innerHTML = `<b>${esc(title)}</b>${body ? `<span class="small muted">${esc(body)}</span>` : ''}`;
  t.onclick = () => { onclick && onclick(); close(); };
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 300); };
  const box = $('#toasts');
  // Same camera alerting again replaces its old toast; never show more than two at once.
  if (kind) $$('.toast', box).forEach(o => { if (o.dataset.title === title) o.remove(); });
  t.dataset.title = title; box.prepend(t);
  $$('.toast', box).slice(2).forEach(o => o.remove());
  setTimeout(close, kind === 'motion' ? 7000 : 4500);
}
const avatar = (u, cls = '') => `<span class="av ${cls}" style="--c:${esc(u.color)}" title="${esc(u.name)}">${initials(u.name)}</span>`;

// ---------------- live connection ----------------
function connect() {
  if (S.ws && S.ws.readyState <= 1) return;
  const ws = S.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => sendView();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'presence') { S.presence = m.users; renderPresence(); }
    else if (m.type === 'alert') {
      if (m.kind === 'motion') { toast(m.title, m.body, 'motion', () => location.hash = m.url.replace('/', '')); flashTile(m.camId); }
      else if (m.kind === 'test') toast(m.title, m.body);
      else if (m.kind === 'ring') { toast('🔔 ' + m.title, 'Tap to answer', 'motion', () => location.hash = '#talk/' + m.camId); flashTile(m.camId); if (S.route === 'cam/' + m.camId) renderTalk(); }
    }
    else if (m.type === 'event') { S.events.unshift(m.event); if (S.route === 'events') render(); }
    else if (m.type === 'smart-install') { S.smartInstall = m; if (m.done || m.error) { S.smart = null; if (m.done) toast('Smart detection is on', 'Choose what each camera alerts on in Settings → Cameras'); else toast('Smart detection wasn\'t installed', m.error); } if (S.route === 'settings') m.done || m.error ? render() : updateSmartProgress(); }
    else if (m.type === 'talk-state') { S.talk[m.camId] = m; if (S.route.endsWith('/' + m.camId)) renderTalk(); const t = $(`.tile[data-cam="${CSS.escape(m.camId)}"] [data-call]`); if (t) t.hidden = !m.active; }
    else if (m.type === 'detections') { if (S.route === 'cam/' + m.camId) drawBoxes($('#liveBoxes'), m.objects, true); }
    else if (m.type === 'sighting') { if (S.route.startsWith('biome')) render(); if (!m.isNew) return; toast('New species spotted', `${m.species.common || m.species.scientific} · ${m.cam}`, 'sighting', () => location.hash = '#biome/' + m.species.id); }
    else if (m.type === 'armed') { S.armed = m.armed; renderArmed(); toast(m.armed ? 'Alerts armed' : 'Alerts paused', 'by ' + m.by); }
    else if (m.type === 'camstatus') { const c = S.cameras.find(c => c.id === m.id); if (c) { Object.assign(c, m); updateTileStatus(c); } }
    else if (m.type === 'cameras') loadCameras().then(() => ['cameras', 'settings'].includes(S.route) && render());
    else if (m.type === 'chat') { S.feed.unshift(m); S.feed = S.feed.slice(0, 50); if (S.route === 'family') render(); else toast(m.from, m.text); }
  };
  ws.onclose = () => { if (S.me) setTimeout(connect, 2500); };
}
function sendView(cams) {
  if (!S.ws || S.ws.readyState !== 1) return;
  const ids = cams || (S.route === 'cameras' ? S.cameras.map(c => c.id) : S.route.startsWith('cam/') ? [S.route.slice(4)] : []);
  S.ws.send(JSON.stringify({ type: 'view', page: S.route.split('/')[0], cams: ids, focus: document.visibilityState === 'visible' }));
}
document.addEventListener('visibilitychange', () => sendView());

function renderPresence() {
  const others = S.presence;
  $('#presence').innerHTML = others.slice(0, 5).map(u => avatar(u, 'live')).join('') + (others.length > 5 ? `<span class="av" style="--c:var(--line);color:var(--ink)">+${others.length - 5}</span>` : '');
  $('#presence').title = others.map(u => u.name).join(', ') + ' online';
  // who's watching which camera
  for (const el of $$('[data-watchers]')) {
    const id = el.dataset.watchers;
    const w = others.filter(u => u.viewing.includes(id) && (S.route !== 'cameras' || u.page === 'cam'));
    const all = others.filter(u => u.viewing.includes(id));
    const list = el.dataset.full ? all : w;
    el.innerHTML = list.map(u => avatar(u, 'sm')).join('') + (el.dataset.full && list.length ? `<span class="small muted" style="margin-left:6px">${list.map(u => esc(u.name)).join(', ')} watching</span>` : '');
  }
  if (S.route === 'family') renderFamilyPeople();
}
function renderArmed() {
  const b = $('#armed'); b.classList.toggle('on', S.armed); b.textContent = S.armed ? 'Armed' : 'Home';
  b.title = S.armed ? 'Motion alerts are being sent to the family. Tap to pause.' : 'Motion is still recorded, but no alerts are sent. Tap to arm.';
}
$('#armed').onclick = async () => { try { const r = await api('/api/armed', { method: 'POST', body: { armed: !S.armed } }); S.armed = r.armed; renderArmed(); } catch (e) { toast('Could not change', e.message); } };

// ---------------- routing ----------------
async function loadCameras() {
  const [c, sm] = await Promise.all([api('/api/cameras'), S.smart ? null : api('/api/smart').catch(() => ({ available: false }))]);
  S.cameras = c.cameras; if (sm) S.smart = sm;
}
window.addEventListener('hashchange', render);
async function render() {
  const route = location.hash.slice(1) || 'cameras';
  // stop any MJPEG streams from the previous page
  $$('img[data-live]', view).forEach(i => { i.src = ''; });
  if (T && !(route === 'cam/' + T.camId || route === 'talk/' + T.camId)) hangUp();
  S.route = route;
  const tab = route.startsWith('zones') ? 'settings' : route.startsWith('talk/') ? 'cameras' : route.split('/')[0] === 'cam' || route.startsWith('event') ? (route.startsWith('cam') ? 'cameras' : 'events') : route.split('/')[0];
  $$('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  sendView();
  try {
    const [page, arg] = route.split('/');
    const fn = { cameras: pageCameras, cam: pageCam, talk: id => pageCam(id, { answer: true }), zones: pageZones, events: pageEvents, event: pageEvent, biome: arg ? pageSpecies : pageBiome, family: pageFamily, settings: pageSettings, identify: pageIdentify, legal: pageLegal }[page] || pageCameras;
    await fn(arg ? decodeURIComponent(arg) : undefined);
    renderPresence();
  } catch (e) { if (S.me) view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  view.focus({ preventScroll: true });
}

// ---------------- cameras ----------------
function tileHtml(c, i) {
  const off = c.status !== 'live';
  return `<article class="tile" data-cam="${esc(c.id)}" style="animation-delay:${i * 60}ms" tabindex="0" aria-label="${esc(c.name)} camera">
    ${off ? '' : `<img data-live src="/api/cameras/${esc(c.id)}/live" alt="">`}
    ${off ? `<div class="off">${c.status === 'connecting' ? 'Connecting…' : c.type === 'browser' ? 'Waiting for the camera phone to connect' : 'Camera offline' + (c.error ? `<br><span class="small">${esc(c.error)}</span>` : '')}</div>` : ''}
    <div class="shade"></div>
    <div class="hd"><span class="name"><span class="dot ${esc(c.status)}"></span> ${esc(c.name)}</span><span class="row" style="gap:6px"><span class="pill ok" data-call ${c.talk && c.talk.session && c.talk.session.active ? '' : 'hidden'}>On a call</span>${c.record ? '<span class="pill rec">REC</span>' : ''}</span></div>
    <div class="ft"><span class="clock" data-clock></span><span class="watchers" data-watchers="${esc(c.id)}"></span></div>
  </article>`;
}
async function pageCameras() {
  await loadCameras();
  if (!S.cameras.length) {
    view.innerHTML = `<div class="empty stack"><h2>No cameras yet</h2><p>${S.me.role === 'admin' ? 'Add an IP camera, or turn an old phone or webcam into one.' : 'Ask the family admin to add a camera.'}</p>${S.me.role === 'admin' ? '<a class="btn primary" href="#settings">Add a camera</a>' : ''}</div>`;
    return;
  }
  view.innerHTML = `<div class="row spread" style="margin-bottom:12px"><h1>Cameras</h1><span class="small muted">${S.cameras.filter(c => c.status === 'live').length} of ${S.cameras.length} live</span></div>
    <div class="grid">${S.cameras.map(tileHtml).join('')}</div>`;
  $$('.tile', view).forEach(t => { t.onclick = () => location.hash = '#cam/' + t.dataset.cam; t.onkeydown = e => e.key === 'Enter' && t.click(); });
  tickClocks();
}
function updateTileStatus(c) {
  const t = $(`.tile[data-cam="${CSS.escape(c.id)}"]`); if (!t) return;
  const i = S.cameras.indexOf(c); const tmp = document.createElement('div'); tmp.innerHTML = tileHtml(c, i);
  const nt = tmp.firstElementChild; nt.style.animation = 'none'; t.replaceWith(nt); nt.onclick = () => location.hash = '#cam/' + c.id; renderPresence();
}
function flashTile(id) { const t = $(`.tile[data-cam="${CSS.escape(id || '')}"]`); if (t) { t.classList.add('motion'); setTimeout(() => t.classList.remove('motion'), 6000); } }
function tickClocks() { const s = new Date().toLocaleTimeString(); $$('[data-clock]').forEach(e => e.textContent = s); }
setInterval(tickClocks, 1000);

async function pageCam(id, opts = {}) {
  await loadCameras();
  const c = S.cameras.find(x => x.id === id); if (!c) throw new Error('Camera not found');
  const [{ events }, { recordings }] = await Promise.all([api('/api/events?limit=30&cam=' + encodeURIComponent(id)), api(`/api/cameras/${encodeURIComponent(id)}/recordings`)]);
  view.innerHTML = `<div class="row spread" style="margin-bottom:10px"><div class="row"><a class="btn ghost" href="#cameras" aria-label="Back">←</a><h1 style="margin:0">${esc(c.name)}</h1><span class="dot ${esc(c.status)}"></span></div>
      <div class="watchers" data-watchers="${esc(c.id)}" data-full="1"></div></div>
    <div class="viewer">${c.status === 'live' ? `<div class="frame"><img data-live src="/api/cameras/${esc(c.id)}/live" alt="Live view of ${esc(c.name)}"><div class="boxes" id="liveBoxes" aria-hidden="true"></div></div>` : `<div class="empty" style="border:0">Not live right now.</div>`}</div>
    ${S.smart && S.smart.available && c.smart.enabled ? '<p class="small muted" id="liveSaid" aria-live="polite" style="margin:8px 0 0">Watching for people, vehicles and animals…</p>' : ''}
    <div class="row" style="margin:12px 0"><button class="btn" id="snap"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg>Snapshot</button>
      <button class="btn" id="ident"><svg viewBox="0 0 24 24"><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/></svg>What's in view?</button>
      ${S.me.role === 'admin' && S.smart && S.smart.available ? `<a class="btn" href="#zones/${esc(c.id)}"><svg viewBox="0 0 24 24"><path d="M4 6l7-2 9 4-2 11-12 1z"/></svg>Zones (${c.smart.zones.length})</a>` : ''}</div>
    <div id="identOut"></div>
    <section class="card stack talkbox" id="talkBox" ${c.talk.enabled ? '' : 'hidden'} aria-labelledby="talkHead"></section>
    <div class="journal" style="margin-top:6px"><section><h2>Recent alerts</h2><div class="events">${events.length ? events.map(evHtml).join('') : '<p class="muted">No motion recorded yet.</p>'}</div></section>
    <section><h2>Recordings</h2><video id="player" controls playsinline preload="none" hidden></video><div class="stack small" style="margin-top:8px">${recordings.length ? recordings.slice(0, 60).map(r => `<button class="btn ghost" style="width:100%;justify-content:space-between" data-rec="${esc(r.file)}"><span>${esc(fmtDay(r.start))} · ${esc(fmtTime(r.start))}–${esc(fmtTime(r.end))}</span><span class="mono">${(r.size / 1e6).toFixed(0)} MB</span></button>`).join('') : `<p class="muted">${c.record ? 'Recording starts as soon as the camera is live.' : 'Recording is off for this camera.'}</p>`}</div></section></div>`;
  $('#snap').onclick = () => window.open(`/api/cameras/${encodeURIComponent(id)}/snapshot`, '_blank');
  $('#ident').onclick = async () => { $('#identOut').innerHTML = '<p class="muted">Looking closely…</p>'; try { const r = await api(`/api/cameras/${encodeURIComponent(id)}/identify`, { method: 'POST' }); showCandidates($('#identOut'), r.candidates); } catch (e) { $('#identOut').innerHTML = `<p class="err">${esc(e.message)}</p>`; } };
  $$('[data-rec]').forEach(b => b.onclick = () => { const p = $('#player'); p.hidden = false; p.src = `/media/rec/${encodeURIComponent(id)}/${encodeURIComponent(b.dataset.rec)}`; p.play(); p.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  bindEvClicks();
  S.talkCam = c; S.talkAnswer = !!opts.answer; S.talk[c.id] = c.talk.session; renderTalk();
}

// ---------------- two-way talk ----------------
function renderTalk() {
  const box = $('#talkBox'), c = S.talkCam; if (!box || !c || !c.talk.enabled) return;
  const st = S.talk[c.id] || {}, others = (st.people || []).filter(n => n !== S.me.name);
  if (!T) {
    box.innerHTML = `<h2 id="talkHead">Talk through this camera</h2>
      ${S.talkAnswer ? `<p class="talk-ring" role="alert">🔔 Someone rang the doorbell at ${esc(c.name)}.</p>` : ''}
      ${st.active ? `<p class="small">On a call now: ${esc(others.join(', ') || 'someone')}. You can join.</p>` : '<p class="small muted">They\'ll hear a chime and see that someone from the house is on the line. Nothing is recorded.</p>'}
      <button class="btn primary big" id="talkOpen">${S.talkAnswer ? '📞 Answer' : st.active ? '🎧 Join the call' : '🎙️ Start a call'}</button>`;
    $('#talkOpen').onclick = () => openTalk(c);
    return;
  }
  const busy = st.talker && st.talker !== S.me.name;
  box.innerHTML = `<h2 id="talkHead">On a call · ${esc(c.name)}</h2>
    <p class="small" aria-live="polite" id="talkStatus">${!st.cameraReady ? 'Connecting to the camera…' : busy ? `${esc(st.talker)} is talking. You can listen.` : T.speaking ? 'They can hear you now.' : 'You can hear them. Tap the big button to talk.'}${others.length ? ` · Also listening: ${esc(others.join(', '))}` : ''}</p>
    <div class="meter" aria-hidden="true"><i id="talkLevel"></i></div>
    <button class="btn big ${T.speaking ? 'danger' : 'primary'}" id="talkSpeak" aria-pressed="${T.speaking}" ${busy || !st.cameraReady ? 'disabled' : ''}>${T.speaking ? '■ Stop talking' : '🎤 Start talking'}</button>
    <div class="row"><label class="f" style="flex:1">Their volume<input type="range" id="talkVol" min="0" max="2" step="0.1" value="${T.vol}"></label><button class="btn danger" id="talkEnd">Hang up</button></div>`;
  $('#talkSpeak').onclick = toggleSpeak;
  $('#talkEnd').onclick = () => hangUp();
  $('#talkVol').oninput = e => { T.vol = +e.target.value; T.spk.volume(T.vol); };
}
async function openTalk(c) {
  if (!window.SpTalk || !SpTalk.supported()) return toast('Talking needs a newer browser', 'Use Chrome, Firefox or the Spectacle app');
  try {
    // Connect first (the camera starts its chime and notice straight away), then set up sound.
    const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/talk?cam=' + encodeURIComponent(c.id));
    sock.binaryType = 'arraybuffer';
    const queued = [];
    T = { camId: c.id, sock, spk: { push: b => queued.push(b), volume() {}, stop() {} }, mic: null, speaking: false, vol: 1.2 };
    SpTalk.speaker(1.2).then(spk => { if (!T || T.sock !== sock) return spk.stop(); T.spk = spk; queued.splice(-10).forEach(b => spk.push(b)); }).catch(e => toast('No sound on this device', e.message));
    sock.onmessage = e => {
      if (e.data instanceof ArrayBuffer) { T && T.spk.push(e.data); return; }
      const m = JSON.parse(e.data);
      if (m.type === 'talk-state') { S.talk[m.camId] = m; renderTalk(); }
      else if (m.type === 'talk-error') toast('Can\'t talk right now', m.error);
      else if (m.type === 'talk-ended') toast('Call ended', m.reason === 'time limit' ? 'Calls end after 15 minutes. Start a new one if needed.' : '');
    };
    sock.onclose = () => { if (T && T.sock === sock) hangUp(true); };
    S.talkAnswer = false; renderTalk();
  } catch (e) { toast('Couldn\'t start the call', e.message); hangUp(true); }
}
async function toggleSpeak() {
  if (!T) return;
  if (!T.speaking) {
    try {
      T.mic = await SpTalk.mic(f => { if (T && T.speaking && T.sock.readyState === 1 && T.sock.bufferedAmount < 64000) T.sock.send(f); }, lvl => { const el = $('#talkLevel'); if (el) el.style.width = Math.min(100, lvl * 160) + '%'; });
      T.speaking = true; T.sock.send(JSON.stringify({ type: 'speak', on: true }));
    } catch (e) { toast('Microphone blocked', 'Allow the microphone for Spectacle in your phone or browser settings, then try again.'); }
  } else { T.speaking = false; T.mic && T.mic.stop(); T.mic = null; T.sock.send(JSON.stringify({ type: 'speak', on: false })); }
  renderTalk();
}
function hangUp(quiet) {
  if (!T) return;
  const t = T; T = null;
  try { t.mic && t.mic.stop(); t.spk && t.spk.stop(); if (t.sock.readyState <= 1) t.sock.close(); } catch {}
  if (!quiet) toast('Call ended');
  renderTalk();
}

// ---------------- zones (draw areas on the picture) ----------------
const ZONE_COLORS = ['#c9f27a', '#7cc6e8', '#f6c453', '#ff99c8', '#c77dff', '#ff7a59', '#90dbf4', '#b5e48c'];
const PRESETS = { 'Whole picture': [[0, 0], [1, 0], [1, 1], [0, 1]], 'Left half': [[0, 0], [0.5, 0], [0.5, 1], [0, 1]], 'Right half': [[0.5, 0], [1, 0], [1, 1], [0.5, 1]], 'Bottom half': [[0, 0.5], [1, 0.5], [1, 1], [0, 1]], 'Middle': [[0.25, 0.2], [0.75, 0.2], [0.75, 1], [0.25, 1]] };
async function pageZones(id) {
  await loadCameras();
  const c = S.cameras.find(x => x.id === id); if (!c) throw new Error('Camera not found');
  if (S.me.role !== 'admin') throw new Error('Only the family admin can change zones');
  let zones = c.smart.zones.map(z => ({ ...z })), drawing = null;
  const save = async () => { const r = await api('/api/cameras/' + id, { method: 'PATCH', body: { smart: { zones } } }); zones = r.camera.smart.zones; toast('Zones saved', c.name); paint(); };
  view.innerHTML = `<div class="row" style="margin-bottom:8px"><a class="btn ghost" href="#settings" aria-label="Back to settings">←</a><h1 style="margin:0">Zones · ${esc(c.name)}</h1></div>
    <p class="muted small">Zones are areas of the picture, like the driveway or the back door. Alerts only come from people, vehicles or animals whose feet or wheels are inside a zone. With no zones, the whole picture counts.</p>
    <div class="viewer"><div class="frame" id="zf"><img id="zimg" src="/api/cameras/${esc(id)}/snapshot?t=${Date.now()}" alt="Current picture from ${esc(c.name)}"><svg id="zsvg" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"></svg><div class="boxes" id="zlabels" aria-hidden="true"></div></div></div>
    <div id="zctl" class="stack" style="margin-top:12px"></div>
    <section class="card stack" style="margin-top:14px"><h2>Your zones</h2><div id="zlist" class="stack"></div></section>`;
  const img = $('#zimg'); img.onerror = () => { $('#zf').innerHTML = '<div class="empty" style="border:0">No picture yet. Zones can be drawn once the camera is live.</div>'; };
  const pt = e => { const r = img.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
  $('#zf').addEventListener('click', e => { if (!drawing) return; drawing.push(pt(e).map(v => +v.toFixed(4))); paint(); });
  function paint() {
    const poly = (pts, col, dash) => `<polygon points="${pts.map(p => p[0] * 1000 + ',' + p[1] * 1000).join(' ')}" fill="${col}33" stroke="${col}" stroke-width="3" vector-effect="non-scaling-stroke" ${dash ? 'stroke-dasharray="8 6"' : ''}/>`;
    $('#zsvg').innerHTML = zones.map((z, i) => poly(z.points, ZONE_COLORS[i % 8])).join('') + (drawing && drawing.length ? (drawing.length > 2 ? poly(drawing, '#ffffff', true) : '') + drawing.map(p => `<circle cx="${p[0] * 1000}" cy="${p[1] * 1000}" r="9" fill="#fff" vector-effect="non-scaling-stroke"/>`).join('') : '');
    $('#zlabels').innerHTML = zones.map((z, i) => { const x = Math.min(...z.points.map(p => p[0])), y = Math.min(...z.points.map(p => p[1])); return `<div class="bx" style="left:${x * 100}%;top:${y * 100}%;border:0;--c:${ZONE_COLORS[i % 8]}"><span>${esc(z.name)}</span></div>`; }).join('');
    $('#zctl').innerHTML = drawing
      ? `<div class="card stack" style="border-color:var(--lime)"><b>Tap the picture to place the corners of the zone (${drawing.length} so far).</b><div class="row"><button class="btn primary" id="zdone" ${drawing.length < 3 ? 'disabled' : ''}>Done</button><button class="btn" id="zundo" ${drawing.length ? '' : 'disabled'}>Undo corner</button><button class="btn ghost" id="zcancel">Cancel</button></div></div>`
      : `<div class="row"><button class="btn primary" id="zadd" ${zones.length >= 8 ? 'disabled' : ''}>Draw a new zone</button><label class="f" style="flex-direction:row;align-items:center;gap:8px">or add<select id="zpreset">${Object.keys(PRESETS).map(k => `<option>${k}</option>`).join('')}</select><button class="btn" id="zaddp" ${zones.length >= 8 ? 'disabled' : ''}>Add</button></label></div>`;
    $('#zlist').innerHTML = zones.length ? zones.map((z, i) => `<form class="card stack" data-z="${i}" style="border-left:6px solid ${ZONE_COLORS[i % 8]}">
        <label class="f">Name<input type="text" name="name" value="${esc(z.name)}" maxlength="30"></label>
        <div class="small muted">Alert when these are inside:</div>
        <div class="row">${[['person', 'People'], ['vehicle', 'Vehicles'], ['animal', 'Animals'], ['package', 'Bags & packages']].map(([v, l]) => `<label class="check"><input type="checkbox" name="kind" value="${v}" ${z.kinds.includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
        <label class="f">Only alert if they stay at least<select name="dwell">${[[0, 'No wait: alert straight away'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes']].map(([v, l]) => `<option value="${v}" ${+z.dwellSec === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="row"><button class="btn primary">Save</button><button type="button" class="btn danger" data-zdel="${i}">Delete zone</button></div></form>`).join('')
      : '<p class="muted small">No zones yet, so the whole picture counts.</p>';
    if ($('#zadd')) $('#zadd').onclick = () => { drawing = []; paint(); toast('Tap the corners of the area', 'Then tap Done'); };
    if ($('#zaddp')) $('#zaddp').onclick = () => { const n = $('#zpreset').value; zones.push({ name: n, points: PRESETS[n], kinds: ['person'], dwellSec: 0 }); save(); };
    if ($('#zdone')) $('#zdone').onclick = () => { zones.push({ name: `Zone ${zones.length + 1}`, points: drawing, kinds: ['person'], dwellSec: 0 }); drawing = null; save().then(() => { const f = $$('#zlist form').pop(); f && f.name.focus(); f && f.name.select(); }); };
    if ($('#zundo')) $('#zundo').onclick = () => { drawing.pop(); paint(); };
    if ($('#zcancel')) $('#zcancel').onclick = () => { drawing = null; paint(); };
    $$('#zlist form').forEach(f => {
      f.onsubmit = e => { e.preventDefault(); const z = zones[+f.dataset.z]; z.name = f.name.value.trim() || z.name; z.kinds = $$('input[name=kind]', f).filter(x => x.checked).map(x => x.value); if (!z.kinds.length) return toast('Pick at least one', 'People, vehicles, animals or packages'); z.dwellSec = +f.dwell.value; save(); };
      $('[data-zdel]', f).onclick = () => { if (!confirm(`Delete the zone "${zones[+f.dataset.z].name}"?`)) return; zones.splice(+f.dataset.z, 1); save(); };
    });
  }
  paint();
}

// ---------------- motion events ----------------
const KIND = { person: ['Person', 'People'], vehicle: ['Vehicle', 'Vehicles'], animal: ['Animal', 'Animals'], package: ['Bag or package', 'Bags or packages'] };
const cap = t => t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
function evTitle(e) {
  if (!e.kind) return 'Motion';
  if (e.kind === 'ring') return 'Doorbell rang';
  if (e.kind === 'talk') return `Call: ${(e.people || []).join(', ')} · ${e.durationSec < 60 ? e.durationSec + ' s' : Math.round(e.durationSec / 60) + ' min'}`;
  const what = e.count > 1 ? `${e.count} ${KIND[e.kind][1].toLowerCase()}` : (e.kind === 'person' ? 'Person' : cap(e.label) || KIND[e.kind][0]);
  return `${what} ${e.zone ? 'in ' + e.zone : 'seen'}`;
}
const evHtml = (e, i = 0) => `<a class="ev" href="#event/${esc(e.id)}" style="animation-delay:${Math.min(i, 10) * 40}ms;text-decoration:none;color:inherit">${e.snapshot ? `<img loading="lazy" src="/media/events/${esc(e.camId)}/${esc(e.snapshot)}" alt="">` : '<img alt="">'}
  <div><div><b>${esc(evTitle(e))}</b> <span class="muted">· ${esc(e.camName)}</span> ${e.notified ? '<span class="pill warn">alerted</span>' : ''}</div><div class="t">${esc(fmtTime(e.ts))} · ${esc(ago(e.ts))}${e.stayedSec ? ` · stayed ${e.stayedSec} s` : ''}</div></div></a>`;
const BOX_COLORS = { person: '#c9f27a', vehicle: '#7cc6e8', animal: '#f6c453', package: '#ff99c8' };
const groupOfLabel = l => ({ person: 'person', bicycle: 'vehicle', car: 'vehicle', motorcycle: 'vehicle', bus: 'vehicle', truck: 'vehicle', boat: 'vehicle', train: 'vehicle', airplane: 'vehicle', bird: 'animal', cat: 'animal', dog: 'animal', horse: 'animal', sheep: 'animal', cow: 'animal', bear: 'animal', elephant: 'animal', zebra: 'animal', giraffe: 'animal', backpack: 'package', handbag: 'package', suitcase: 'package' })[l] || 'other';
/** Boxes as percent-positioned labels over a picture (works at any size, readable at any zoom). */
function drawBoxes(el, objs, live) {
  if (!el) return;
  const shown = (objs || []).filter(o => groupOfLabel(o.label) !== 'other');
  el.innerHTML = shown.map(o => { const g = groupOfLabel(o.label), b = o.box; return `<div class="bx" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%;--c:${BOX_COLORS[g]}"><span>${esc(cap(o.label))} ${Math.round(o.score * 100)}%</span></div>`; }).join('');
  if (live) {
    const said = $('#liveSaid'); if (!said) return;
    const n = {}; for (const o of shown) { const k = o.label; n[k] = (n[k] || 0) + 1; }
    const txt = Object.keys(n).length ? 'In view: ' + Object.entries(n).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(', ') : 'Nobody in view.';
    if (said.textContent !== txt) said.textContent = txt;
    clearTimeout(el._t); el._t = setTimeout(() => { el.innerHTML = ''; if (said) said.textContent = 'Nobody in view.'; }, 4000);
  }
}
function bindEvClicks() {}
async function pageEvents() {
  const { events } = await api('/api/events?limit=200'); S.events = events;
  let html = '<h1>Alerts</h1>', last = '';
  if (!events.length) html += '<div class="empty">Nothing yet. Alerts show up here with a snapshot and a link to the recording.</div>';
  events.forEach((e, i) => { const d = fmtDay(e.ts); if (d !== last) { html += `<div class="day">${esc(d)}</div>`; last = d; } html += evHtml(e, i); });
  view.innerHTML = `<div class="events">${html}</div>`;
}
async function pageEvent(id) {
  const { events } = await api('/api/events?limit=500'); const e = events.find(x => x.id === id); if (!e) throw new Error('That event has expired');
  view.innerHTML = `<div class="row" style="margin-bottom:10px"><a class="btn ghost" href="#events" aria-label="Back to alerts">←</a><h1 style="margin:0">${esc(evTitle(e))}</h1></div>
    <p class="mono muted">${esc(e.camName)} · ${esc(new Date(e.ts).toLocaleString())}${e.stayedSec ? ` · stayed ${e.stayedSec} s` : ''}</p>
    ${e.kind && e.snapshot ? `<div class="viewer" style="margin-bottom:12px"><div class="frame"><img src="/media/events/${esc(e.camId)}/${esc(e.snapshot)}" alt="What the camera saw: ${esc(evTitle(e))}"><div class="boxes" id="evBoxes" aria-hidden="true"></div></div></div>` : ''}
    ${e.segment ? `<video controls playsinline autoplay muted src="/media/rec/${esc(e.camId)}/${esc(e.segment.file)}#t=${e.segment.offset}"></video>` : e.snapshot ? `<img class="refimg" src="/media/events/${esc(e.camId)}/${esc(e.snapshot)}" alt="Snapshot">` : ''}
    <div class="row" style="margin-top:12px"><a class="btn" href="#cam/${esc(e.camId)}">Open live view</a>${e.snapshot ? `<a class="btn ghost" href="/media/events/${esc(e.camId)}/${esc(e.snapshot)}" download>Download snapshot</a>` : ''}</div>`;
  if (e.boxes) drawBoxes($('#evBoxes'), e.boxes);
}

// ---------------- biome ----------------
let biomeFilter = 'all';
async function pageBiome() {
  const { species, db } = await api('/api/biome');
  const groups = { insect: 'Insects & bugs', plant: 'Plants & flowers', bird: 'Birds' };
  const n = g => species.filter(s => s.group === g && s.status !== 'rejected').length;
  const shown = species.filter(s => (biomeFilter === 'all' ? s.status !== 'rejected' : biomeFilter === 'review' ? s.status === 'unreviewed' : biomeFilter === 'rejected' ? s.status === 'rejected' : s.group === biomeFilter && s.status !== 'rejected'));
  view.innerHTML = `<div class="biome-head"><div><h1>Backyard biome</h1><div class="muted small">Everything your cameras have identified, one folder per species.</div></div><a class="btn primary" href="#identify">Identify a photo</a></div>
    <div class="counts">${Object.entries(groups).map(([g, l]) => `<div class="count"><b>${n(g)}</b><span>${l}</span></div>`).join('')}<div class="count"><b>${species.filter(s => s.status === 'unreviewed').length}</b><span>to review</span></div></div>
    ${!db.total ? `<p class="card small" style="margin-top:12px">Explanations aren't downloaded (optional). To add them, run <span class="mono">npm run species-db</span> on the server once while online. It sends only species names, never your footage.</p>` : ''}
    <div class="chips" role="tablist">${[['all', 'All'], ['insect', 'Bugs'], ['plant', 'Plants'], ['bird', 'Birds'], ['review', 'To review'], ['rejected', 'Rejected']].map(([k, l]) => `<button class="chip ${biomeFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    ${shown.length ? `<div class="folders">${shown.map((s, i) => folderHtml(s, i)).join('')}</div>` : `<div class="empty">No species here yet. Cameras with the biome log on check what's in view about once a minute and whenever something small moves.</div>`}`;
  $$('[data-f]').forEach(b => b.onclick = () => { biomeFilter = b.dataset.f; pageBiome(); });
}
function folderHtml(s, i) {
  const photo = s.photos[0] ? `/media/biome/${esc(s.id)}/${esc(s.photos[0].file)}` : s.info && s.info.image ? `/media/species/${esc(s.info.image.file)}` : '';
  const st = { unreviewed: '<span class="pill warn">review</span>', confirmed: '<span class="pill ok">confirmed</span>', rejected: '<span class="pill">rejected</span>' }[s.status];
  return `<a class="folder" href="#biome/${esc(s.id)}" style="animation-delay:${Math.min(i, 12) * 45}ms"><div class="tab"></div><div class="body">
    <div class="ph" style="${photo ? `background-image:url('${photo}')` : ''}">${st}</div>
    <div class="meta"><div class="cn">${esc(s.common || s.scientific)}</div><div class="sn">${esc(s.scientific)}</div><div class="ln">${esc(s.groupName)} · seen ${s.count}× · ${esc(ago(s.lastSeen))}</div></div></div></a>`;
}
async function pageSpecies(id) {
  const { species } = await api('/api/biome'); const s = species.find(x => x.id === id); if (!s) throw new Error('Not in your biome log');
  const t = (s.info && s.info.taxonomy) || {};
  const info = s.info;
  view.innerHTML = `<div class="row" style="margin-bottom:8px"><a class="btn ghost" href="#biome">← All folders</a></div>
  <div class="journal"><section>
    <h1>${esc(s.common || s.scientific)}</h1><div class="sci">${esc(s.scientific)}</div>
    <div class="crumbs">${['kingdom', 'phylum', 'class', 'order', 'family', 'genus'].filter(k => t[k]).map(k => `<span title="${k}">${esc(t[k])}</span>`).join('') || `<span>${esc(s.groupName)}</span>`}</div>
    <h2>What it is</h2>
    <div class="explain">${info && info.summary ? esc(info.summary) : '<span class="muted">No offline explanation yet. Run <span class="mono">npm run species-db</span> on the server while online to download explanations for every species the app knows.</span>'}</div>
    ${info && info.source ? `<div class="attrib">Text: Wikipedia, “<a href="${esc(info.source.url)}" target="_blank" rel="noopener">${esc(info.source.title)}</a>”, <a href="${esc(info.source.licenseUrl)}" target="_blank" rel="noopener">${esc(info.source.license)}</a>. Classification: GBIF Backbone Taxonomy (CC BY 4.0). Automatic identifications can be wrong — never touch, eat or handle anything based on this app.</div>` : ''}
    <h2 style="margin-top:20px">In your yard</h2>
    <div class="card small stack"><div class="row spread"><span>First seen</span><b>${esc(new Date(s.firstSeen).toLocaleString())}</b></div><div class="row spread"><span>Last seen</span><b>${esc(new Date(s.lastSeen).toLocaleString())}</b></div><div class="row spread"><span>Detections</span><b>${s.count}</b></div><div class="row spread"><span>Cameras</span><b>${esc(Object.keys(s.cameras).join(', '))}</b></div><div class="row spread"><span>Best match</span><b>${Math.round(s.bestConf * 100)}%</b></div><div class="row spread"><span>Folder on server</span><span class="mono">biome/${esc(s.folder)}</span></div></div>
    <div class="row" style="margin-top:12px">${s.status !== 'confirmed' ? '<button class="btn primary" data-st="confirmed">Yes, that\'s right</button>' : ''}${s.status !== 'rejected' ? '<button class="btn danger" data-st="rejected">Wrong ID — ignore it</button>' : '<button class="btn" data-st="unreviewed">Restore</button>'}</div>
  </section><section>
    ${info && info.image ? `<figure style="margin:0 0 14px"><img class="refimg" src="/media/species/${esc(info.image.file)}" alt="Reference photo of ${esc(s.common || s.scientific)}"><figcaption class="attrib" style="border:0;margin:4px 0 0;padding:0">Reference photo: ${esc(info.image.credit)}, <a href="${esc(info.image.source)}" target="_blank" rel="noopener">${esc(info.image.license)}</a></figcaption></figure>` : ''}
    <h2>Your photos</h2><div class="gallery">${s.photos.map(p => `<figure><a href="/media/biome/${esc(s.id)}/${esc(p.file)}" target="_blank"><img loading="lazy" src="/media/biome/${esc(s.id)}/${esc(p.file)}" alt=""></a><figcaption>${esc(p.cam)} · ${Math.round(p.conf * 100)}%<br>${esc(new Date(p.ts).toLocaleDateString())}</figcaption></figure>`).join('') || '<p class="muted small">None yet.</p>'}</div>
  </section></div>`;
  $$('[data-st]').forEach(b => b.onclick = async () => { await api('/api/biome/' + encodeURIComponent(id), { method: 'PATCH', body: { status: b.dataset.st } }); pageSpecies(id); });
}
function showCandidates(el, cands) {
  if (!cands.length) { el.innerHTML = '<p class="muted">Nothing recognisable.</p>'; return; }
  el.innerHTML = `<div class="card stack"><h2>Best guesses</h2><p class="small muted">Pick the right one to add it to your biome log, or ignore if none fit. Get the subject close and filling the frame for best results.</p><div class="cands">${cands.map(c => `<div class="cand"><div style="flex:1"><b>${esc(c.common || c.scientific)}</b> <span class="muted small"><i>${esc(c.scientific)}</i> · ${esc(c.group)}</span><div class="bar"><i style="width:${Math.round(c.conf * 100)}%"></i></div>${c.info && c.info.summary ? `<div class="small muted" style="margin-top:6px">${esc(c.info.summary.slice(0, 180))}${c.info.summary.length > 180 ? '…' : ''}</div>` : ''}</div><div class="row"><span class="mono">${Math.round(c.conf * 100)}%</span><button class="btn" data-save="${esc(c.label)}" data-g="${esc(c.group)}">Add</button></div></div>`).join('')}</div></div>`;
  $$('[data-save]', el).forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api('/api/identify/save', { method: 'POST', body: { label: b.dataset.save, group: b.dataset.g } }); location.hash = '#biome/' + r.species.id; } catch (e) { toast('Could not save', e.message); b.disabled = false; } });
}
async function pageIdentify() {
  view.innerHTML = `<div class="row" style="margin-bottom:8px"><a class="btn ghost" href="#biome" aria-label="Back to biome">←</a><h1 style="margin:0">Identify a photo</h1></div>
    <div class="card stack"><p class="muted">Snap a bug, flower or bird. It's identified on your own server — the photo never leaves your home.</p>
    <label class="btn primary" style="width:fit-content">Choose or take a photo<input type="file" accept="image/*" capture="environment" id="pick" hidden></label>
    <img id="prev" class="refimg" hidden alt="Your photo"><div id="out"></div></div>`;
  $('#pick').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    $('#prev').src = URL.createObjectURL(f); $('#prev').hidden = false; $('#out').innerHTML = '<p class="muted">Identifying…</p>';
    try { const r = await api('/api/identify', { method: 'POST', body: f }); showCandidates($('#out'), r.candidates); } catch (err) { $('#out').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  };
}

// ---------------- family ----------------
async function pageFamily() {
  const { users } = await api('/api/users');
  S.users = users;
  view.innerHTML = `<h1>Family</h1><p class="muted small">Everyone signed in can see who else is online and which camera they're watching.</p>
    <div class="card"><div class="people" id="people"></div></div>
    <div class="card stack" style="margin-top:14px"><h2>Quick note to everyone online</h2><form id="say" class="row"><input type="text" id="sayText" maxlength="280" placeholder="e.g. I'm checking the back gate" style="flex:1"><button class="btn primary">Send</button></form>
    <div class="feed" id="feed">${S.feed.map(f => `<div class="small"><b style="color:${esc(f.color)}">${esc(f.from)}</b> ${esc(f.text)} <span class="muted">${esc(fmtTime(f.ts))}</span></div>`).join('') || '<p class="muted small">Notes aren\'t saved; they only reach people online right now.</p>'}</div></div>
    ${S.me.role === 'admin' ? `<div class="card stack" style="margin-top:14px"><h2>Invite someone</h2><p class="small muted">Invite codes work once and expire after 7 days. Only invite people who live with you or whom the household agrees should see the cameras.</p>${S.publicUrl ? `<label class="f">Tailscale share link for this person (recommended)<input type="url" id="invShare" placeholder="https://login.tailscale.com/admin/invite/…"><span class="small muted" style="font-weight:400">Lets them reach your cameras privately. In Tailscale's admin page, open <b>Machines</b>, tap ⋯ next to your Spectacle server, choose <b>Share…</b> and copy a new invite link (one per person). They'll see only this server, nothing else on your network.</span></label>` : `<p class="small muted">Invites currently only work on your home Wi-Fi. Set up Tailscale on the server (see the README) so family can connect from anywhere.</p>`}
    <div class="row"><button class="btn" id="inv">Create invite link</button><label class="check"><input type="checkbox" id="invAdmin"> Make them an admin</label></div><div id="invOut"></div></div>` : ''}`;
  renderFamilyPeople();
  $('#say').onsubmit = e => { e.preventDefault(); const t = $('#sayText').value.trim(); if (t && S.ws) { S.ws.send(JSON.stringify({ type: 'ping-family', text: t })); $('#sayText').value = ''; } };
  if ($('#inv')) $('#inv').onclick = async () => {
    let r;
    try { r = await api('/api/invites', { method: 'POST', body: { role: $('#invAdmin').checked ? 'admin' : 'member', shareUrl: ($('#invShare') && $('#invShare').value.trim()) || undefined } }); }
    catch (e) { $('#invOut').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const link = (r.base || location.origin) + '/#join/' + r.code + (r.fp ? '?fp=' + r.fp : '');
    const steps = r.base ? [
      `Install Tailscale (keeps our connection private): ${r.tailscaleAppUrl}\nOpen it and sign in (for example with your Google account).`,
      r.shareUrl ? `Tap this link to connect to our cameras, then tap Accept: ${r.shareUrl}` : null,
      `Install Spectacle: ${r.appUrl}`,
    ] : [`Install Spectacle: ${r.appUrl}`];
    steps.push(`Copy this whole message, open Spectacle and tap "Paste my invite".`);
    const msg = `You're invited to our family cameras on Spectacle!\n\n${steps.filter(Boolean).map((t, i) => `${i + 1}) ${t}`).join('\n\n')}\n\nInvite (works once, for 7 days): ${link}`;
    $('#invOut').innerHTML = `<label class="f" style="margin-top:8px">Message to send<textarea readonly rows="7">${esc(msg)}</textarea></label><div class="row" style="margin-top:8px">${navigator.share ? '<button class="btn primary" id="shareInv">Send by text or email…</button>' : ''}<button class="btn" id="copyInv">Copy message</button></div><p class="small muted">Send it privately, to one person. Anyone who has it can join until it's used.</p>`;
    $('#copyInv').onclick = () => copyText(msg);
    if ($('#shareInv')) $('#shareInv').onclick = () => navigator.share({ title: 'Join our Spectacle', text: msg }).catch(() => {});
  };
}
function renderFamilyPeople() {
  const el = $('#people'); if (!el || !S.users) return;
  el.innerHTML = S.users.map(u => {
    const p = S.presence.find(x => x.id === u.id);
    const watching = p ? p.viewing.map(id => (S.cameras.find(c => c.id === id) || {}).name).filter(Boolean) : [];
    return `<div class="person">${avatar(u, p ? 'live' : '')}<div style="flex:1"><b>${esc(u.name)}</b>${u.id === S.me.id ? ' <span class="muted small">(you)</span>' : ''} ${u.role === 'admin' ? '<span class="pill">admin</span>' : ''}<div class="small muted">${p ? (watching.length ? 'Watching ' + esc(watching.slice(0, 3).join(', ')) + (watching.length > 3 ? '…' : '') : 'Online · ' + esc(p.page)) + (p.devices > 1 ? ` · ${p.devices} devices` : '') : 'Offline'}</div></div>
      ${S.me.role === 'admin' && u.id !== S.me.id ? `<button class="btn ghost small" data-rm="${esc(u.id)}" data-n="${esc(u.name)}">Remove</button>` : ''}</div>`;
  }).join('');
  $$('[data-rm]', el).forEach(b => b.onclick = async () => { if (!confirm(`Remove ${b.dataset.n}? They'll lose access immediately.`)) return; await api('/api/users/' + b.dataset.rm, { method: 'DELETE' }); pageFamily(); });
}

// ---------------- settings ----------------
async function pageSettings() {
  await loadCameras();
  const sys = await api('/api/system');
  const pushOk = !IN_APP && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const sub = pushOk ? await navigator.serviceWorker.getRegistration().then(r => r && r.pushManager.getSubscription()).catch(() => null) : null;
  const me = S.me;
  view.innerHTML = `<h1>Settings</h1><div class="stack">
  <section class="card"><h2>Notifications</h2>
    ${IN_APP ? `<div class="setting"><div><b>Alerts on this phone</b><div class="small muted">Spectacle stays connected to your home server and alerts you, even when the app is closed. No outside push service is used.</div></div><label class="switch"><input type="checkbox" id="appAlerts" aria-label="Alerts on this phone" ${window.SpectacleAndroid.backgroundAlerts() ? 'checked' : ''}><span></span></label></div>
    ${window.SpectacleAndroid.batteryOk() ? '' : '<div class="setting"><div><b>Alerts may be late</b><div class="small muted">Your phone may pause Spectacle to save battery.</div></div><button class="btn primary" id="appBattery">Fix this</button></div>'}`
    : `<div class="setting"><div><b>Phone notifications</b><div class="small muted">${pushOk ? (sub ? 'On for this device.' : 'Get motion alerts even when the app is closed.') : 'Needs the app opened over a trusted HTTPS address (see README: Tailscale).'}</div></div><button class="btn ${sub ? '' : 'primary'}" id="push" ${pushOk ? '' : 'disabled'}>${sub ? 'Send test' : 'Turn on'}</button></div>`}
    <div class="setting"><div><b>Motion alerts for me</b><div class="small muted">Pausing only affects you.</div></div><label class="switch"><input type="checkbox" aria-label="Motion alerts for me" id="pNotify" ${me.prefs.notify ? 'checked' : ''}><span></span></label></div>
    <div class="setting"><div><b>New-species alerts</b><div class="small muted">When the biome log finds something new.</div></div><label class="switch"><input type="checkbox" aria-label="New-species alerts" id="pBiome" ${me.prefs.biomeAlerts !== false ? 'checked' : ''}><span></span></label></div>
    ${S.cameras.length ? `<div class="setting" style="display:block"><b>Mute cameras for me</b><div class="row" style="margin-top:8px">${S.cameras.map(c => `<label class="check"><input type="checkbox" data-mute="${esc(c.id)}" ${me.prefs.mutedCams.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div></div>` : ''}
  </section>
  ${me.role === 'admin' ? smartSetupHtml() + camerasAdminHtml() : ''}
  <section class="card"><h2>Account</h2>
    <form id="pw" class="stack"><label class="f">Current password<input type="password" id="pw1" autocomplete="current-password"></label><label class="f">New password (10+ characters)<input type="password" id="pw2" autocomplete="new-password"></label><button class="btn">Change password</button></form>
    ${IN_APP ? `<p class="small muted" style="margin-top:14px">Spectacle app ${esc(window.SpectacleAndroid.version())}</p>${window.SpectacleAndroid.openStandalone ? '<button class="btn" id="appStandalone" type="button">Use this phone independently</button>' : ''}<button class="btn ghost" id="appDisconnect">Disconnect this phone</button>` : ''}
    <div class="row" style="margin-top:14px"><a class="btn ghost" href="/api/me/export">Download my data</a><button class="btn ghost" id="logout">Sign out</button><button class="btn danger" id="delme">Delete my account</button></div>
  </section>
  <section class="card small"><h2>System</h2><div class="stack">
    <div class="row spread"><span>Storage free</span><b>${sys.disk ? `${sys.disk.freeGB} of ${sys.disk.totalGB} GB` : '—'}</b></div>
    <div class="row spread"><span>Recordings kept</span><b>${sys.retentionDays} days</b></div>
    <div class="row spread"><span>Species the app can identify</span><b>${(sys.models.insect + sys.models.plant + sys.models.bird).toLocaleString()}</b></div>
    <div class="row spread"><span>Offline explanations downloaded</span><b>${sys.speciesDb.explained.toLocaleString()} / ${(sys.speciesDb.total || 0).toLocaleString()}</b></div>
    <div class="row spread"><span>Connection</span><b>${sys.secure ? 'Encrypted (HTTPS)' : 'Not encrypted'}</b></div></div></section>
  <section class="card small"><h2>Legal</h2><div class="row"><a href="/legal/privacy.html">Privacy policy</a> · <a href="/legal/terms.html">Terms & disclaimer</a> · <a href="/legal/recording-laws.html">Camera & recording laws</a> · <a href="/legal/third-party-notices.txt">Third-party notices</a></div></section>
  </div>`;
  const savePrefs = body => api('/api/me/prefs', { method: 'PATCH', body }).then(r => { S.me = r.user; });
  $('#pNotify').onchange = e => savePrefs({ notify: e.target.checked });
  $('#pBiome').onchange = e => savePrefs({ biomeAlerts: e.target.checked });
  $$('[data-mute]').forEach(c => c.onchange = () => savePrefs({ mutedCams: $$('[data-mute]').filter(x => x.checked).map(x => x.dataset.mute) }));
  if ($('#appAlerts')) $('#appAlerts').onchange = e => window.SpectacleAndroid.setBackgroundAlerts(e.target.checked);
  if ($('#appBattery')) $('#appBattery').onclick = () => window.SpectacleAndroid.openBattery();
  if ($('#appStandalone')) $('#appStandalone').onclick = () => window.SpectacleAndroid.openStandalone();
  if ($('#appDisconnect')) $('#appDisconnect').onclick = () => window.SpectacleAndroid.disconnect();
  if ($('#push')) $('#push').onclick = async () => { try { if (!sub) { await enablePush(); toast('Notifications on'); pageSettings(); } else { await api('/api/push/test', { method: 'POST' }); } } catch (e) { toast('Could not enable', e.message); } };
  $('#pw').onsubmit = async e => { e.preventDefault(); try { await api('/api/me/password', { method: 'POST', body: { current: $('#pw1').value, next: $('#pw2').value } }); toast('Password changed'); e.target.reset(); } catch (err) { toast('Not changed', err.message); } };
  $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); S.me = null; S.ws && S.ws.close(); boot(); };
  $('#delme').onclick = async () => { if (!confirm('Delete your account? This can\'t be undone. Camera footage belongs to the household and stays.')) return; try { await api('/api/me', { method: 'DELETE' }); S.me = null; boot(); } catch (e) { toast('Not deleted', e.message); } };
  if (me.role === 'admin') bindCameraAdmin();
  $$('[data-smart]').forEach(b => b.onclick = async () => { try { await api('/api/smart/install', { method: 'POST', body: { size: b.dataset.smart } }); S.smartInstall = { pct: 0 }; render(); } catch (e) { toast('Couldn\'t start', e.message); } });
}
function smartSetupHtml() {
  const st = S.smart || {};
  if (st.available || !st.canInstall) return '';
  const ins = S.smartInstall && !S.smartInstall.done && !S.smartInstall.error ? S.smartInstall : st.installing;
  return `<section class="card stack" id="smartSetup"><h2>Smart detection</h2>
    <p class="small">Tell people, vehicles and animals apart, so alerts say "Person in Driveway" instead of "Motion", and draw zones. It runs on this computer only; nothing is sent anywhere. Turning it on downloads the detector once.</p>
    ${ins ? `<p class="small" aria-live="polite" id="smartPct">Downloading… ${ins.pct || 0}%</p><div class="meter"><i id="smartBar" style="width:${ins.pct || 0}%"></i></div>`
      : `<div class="stack">${['l', 's', 'x'].map(k => `<button class="btn ${k === 'l' ? 'primary big' : ''}" data-smart="${k}">${k === 'l' ? 'Turn on smart detection' : 'Use the ' + (k === 's' ? 'small' : 'most accurate') + ' version'} <span class="small" style="font-weight:400">· ${esc(st.labels ? st.labels[k] : k)}, ${st.sizes ? st.sizes[k] : '?'} MB</span></button>`).join('')}</div>`}
  </section>`;
}
function updateSmartProgress() { const m = S.smartInstall; if (!$('#smartSetup')) return; if (!$('#smartPct')) return render(); $('#smartPct').textContent = `Downloading… ${m.pct || 0}%`; $('#smartBar').style.width = (m.pct || 0) + '%'; }
function smartAdminHtml(c) {
  if (!S.smart || !S.smart.available) return S.smart && S.smart.canInstall ? `<div class="setting" style="display:block"><b>Smart detection</b><div class="small muted">Turn it on at the top of Settings to tell people, vehicles and animals apart.</div></div>` : `<div class="setting" style="display:block"><b>Smart detection</b><div class="small muted">Tell people, vehicles and animals apart, and set zones. It isn't installed yet: on the server run <span class="mono">npm run smart-detection</span>, then restart Spectacle. It runs on your server only.</div></div>`;
  const k = c.smart.kinds;
  return `<fieldset class="setting" style="display:block;border:0;padding:12px 0;margin:0"><legend style="font-weight:700;padding:0">Smart detection <span class="pill ok">${esc(S.smart.model)}</span></legend>
    <label class="check" style="margin-top:6px"><input type="checkbox" name="smartOn" ${c.smart.enabled ? 'checked' : ''}> Use smart detection on this camera</label>
    <div class="small muted" style="margin:8px 0 4px">Alert me when it sees:</div>
    <div class="row">${[['person', 'People'], ['vehicle', 'Vehicles'], ['animal', 'Animals'], ['package', 'Bags & packages']].map(([v, l]) => `<label class="check"><input type="checkbox" name="kind" value="${v}" ${k.includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    <label class="check" style="margin-top:8px"><input type="checkbox" name="anyMotion" ${c.smart.motionAlerts ? 'checked' : ''}> Also alert on any other movement (shadows, wind, rain may trigger it)</label>
    <div class="row" style="margin-top:10px"><a class="btn" href="#zones/${esc(c.id)}">Draw zones (${c.smart.zones.length})</a><span class="small muted">${c.smart.zones.length ? 'Alerts only come from inside your zones.' : 'No zones: the whole picture counts.'}</span></div></fieldset>`;
}
function camerasAdminHtml() {
  return `<section class="card"><h2>Cameras</h2><div class="stack" id="camList">${S.cameras.map(c => `<details class="card" style="padding:12px 14px"><summary class="row spread" style="cursor:pointer"><span><span class="dot ${esc(c.status)}"></span> <b>${esc(c.name)}</b> <span class="muted small">${c.type === 'rtsp' ? 'IP camera' : 'Phone / webcam'}</span></span></summary>
      <form class="stack" data-edit="${esc(c.id)}" style="margin-top:12px">
        <label class="f">Name<input type="text" name="name" value="${esc(c.name)}" maxlength="40"></label>
        ${c.type === 'rtsp' ? `<label class="f">Stream address<input type="url" name="url" placeholder="rtsp://user:pass@192.168.1.20:554/stream1" ${c.hasUrl ? 'value="(saved — leave to keep)"' : ''}></label>` : `<div class="row"><button type="button" class="btn" data-pair="${esc(c.id)}">Get pairing link</button><span class="small muted">Open it on the phone that will be the camera.</span></div><div data-pairout="${esc(c.id)}"></div>`}
        <div class="setting"><span>Record 24/7</span><label class="switch"><input type="checkbox" name="record" ${c.record ? 'checked' : ''}><span></span></label></div>
        <div class="setting"><span>Motion detection</span><label class="switch"><input type="checkbox" name="motionOn" ${c.motion.enabled ? 'checked' : ''}><span></span></label></div>
        <div class="setting"><span>Send motion alerts</span><label class="switch"><input type="checkbox" name="notify" ${c.motion.notify !== false ? 'checked' : ''}><span></span></label></div>
        <label class="f">Motion sensitivity: <output>${c.motion.sensitivity}</output><input type="range" name="sens" min="1" max="10" value="${c.motion.sensitivity}"></label>
        ${smartAdminHtml(c)}
        ${c.talk.supported ? `<div class="setting"><div><span>Two-way talk</span><div class="small muted">Family can talk to whoever is at this camera. The camera phone plays a chime and shows a notice during calls; nothing is recorded.</div></div><label class="switch"><input type="checkbox" name="talkOn" ${c.talk.enabled ? 'checked' : ''}><span></span></label></div>
        <div class="setting"><div><span>Doorbell button</span><div class="small muted">Shows a big Ring button on the camera screen. Pressing it alerts everyone, even when set to Home.</div></div><label class="switch"><input type="checkbox" name="bell" ${c.talk.doorbell ? 'checked' : ''}><span></span></label></div>` : `<div class="setting" style="display:block"><span>Two-way talk</span><div class="small muted">Works with phone and webcam cameras. IP cameras can't be talked through yet.</div></div>`}
        <div class="setting"><span>Bug & flower log</span><label class="switch"><input type="checkbox" name="biome" ${c.biome ? 'checked' : ''}><span></span></label></div>
        ${c.type === 'rtsp' ? `<div class="setting"><div><span>Record audio</span><div class="small muted">Off by default. Recording conversations without consent is illegal in many places.</div></div><label class="switch"><input type="checkbox" name="audio" ${c.audio ? 'checked' : ''}><span></span></label></div>` : ''}
        <div class="row"><button class="btn primary">Save</button><button type="button" class="btn danger" data-del="${esc(c.id)}">Remove camera</button></div>
      </form></details>`).join('') || '<p class="muted small">No cameras yet.</p>'}</div>
    <h2 style="margin-top:18px">Add a camera</h2>
    <form id="addCam" class="stack">
      <label class="f">Name<input type="text" name="name" placeholder="Back yard" required maxlength="40"></label>
      <label class="f">Type<select name="type"><option value="browser">Old phone or webcam (opens in a browser)</option><option value="rtsp">IP camera (RTSP)</option></select></label>
      <label class="f" data-rtsp hidden>Stream address<input type="url" name="url" placeholder="rtsp://user:pass@192.168.1.20:554/stream1"></label>
      <label class="check"><input type="checkbox" name="ack" required> I'll only point this camera at places I'm allowed to record — not bathrooms, bedrooms of others without consent, or neighbours' private areas — and I'll let household members and guests know cameras are recording. <a href="/legal/recording-laws.html" target="_blank">Learn more</a></label>
      <button class="btn primary">Add camera</button><div class="err" id="addErr"></div></form></section>`;
}
function bindCameraAdmin() {
  const f = $('#addCam');
  f.type.onchange = () => { $('[data-rtsp]', f).hidden = f.type.value !== 'rtsp'; };
  f.onsubmit = async e => { e.preventDefault(); try { const r = await api('/api/cameras', { method: 'POST', body: { name: f.name.value, type: f.type.value, url: f.url.value, ackPlacement: f.ack.checked } }); toast('Camera added', r.camera.type === 'browser' ? 'Now open its pairing link on the camera phone.' : 'Connecting…'); await pageSettings(); const d = $(`[data-edit="${CSS.escape(r.camera.id)}"]`); if (d) d.closest('details').open = true; } catch (err) { $('#addErr').textContent = err.message; } };
  $$('[data-edit]').forEach(form => form.onsubmit = async e => {
    e.preventDefault(); const c = S.cameras.find(x => x.id === form.dataset.edit);
    const body = { name: form.name.value, record: form.record.checked, biome: form.biome.checked, motion: { enabled: form.motionOn.checked, notify: form.notify.checked, sensitivity: +form.sens.value } };
    if (form.talkOn) {
      body.talk = { enabled: form.talkOn.checked, doorbell: form.bell.checked };
      if (form.talkOn.checked && !c.talk.enabled) {
        if (!confirm('Two-way talk\n\nWhen a call starts, the camera phone plays a chime and shows "someone from the house is talking". Calls are live and never recorded.\n\nOnly use it where people can see the camera, and tell household members and guests. In some places, listening to people without them knowing is illegal.\n\nTurn on two-way talk?')) { form.talkOn.checked = false; body.talk.enabled = false; }
        else body.ackTalk = true;
      }
    }
    if (form.smartOn) body.smart = { enabled: form.smartOn.checked, kinds: $$('input[name=kind]', form).filter(x => x.checked).map(x => x.value), motionAlerts: form.anyMotion.checked };
    if (form.url && form.url.value && !form.url.value.startsWith('(saved')) body.url = form.url.value;
    if (form.audio && form.audio.checked !== c.audio) { if (form.audio.checked && !confirm('Audio recording: in many US states and countries, recording a conversation needs everyone\'s consent. Only enable this if everyone who could be heard has agreed. Enable?')) { form.audio.checked = false; } else { body.audio = form.audio.checked; body.ackAudio = true; } }
    try { await api('/api/cameras/' + c.id, { method: 'PATCH', body }); toast('Saved', c.name); } catch (err) { toast('Not saved', err.message); }
  });
  $$('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Remove this camera? Existing recordings stay until the retention period ends.')) return; await api('/api/cameras/' + b.dataset.del, { method: 'DELETE' }); pageSettings(); });
  $$('[data-pair]').forEach(b => b.onclick = async () => {
    const r = await api(`/api/cameras/${b.dataset.pair}/pair`, { method: 'POST' });
    const link = (r.base || location.origin) + '/camera#token=' + r.token + (r.fp ? '&fp=' + r.fp : '');
    const msg = r.base
      ? `Spectacle camera setup\n\nOn the phone that will be the camera:\n1) Install Tailscale and sign in with the same account as the server: ${r.tailscaleAppUrl}\n\n2) Install Spectacle: ${r.appUrl}\n\n3) Copy this message, open Spectacle, tap "Paste my invite".\n\nCamera link: ${link}`
      : `Spectacle camera setup\n\n1) On the phone that will be the camera, install: ${r.appUrl}\n\n2) Copy this message, open Spectacle, tap "Paste my invite".\n\nCamera link: ${link}`;
    const out = $(`[data-pairout="${CSS.escape(b.dataset.pair)}"]`);
    out.innerHTML = `<textarea readonly rows="6">${esc(msg)}</textarea><p class="small muted">Anyone with this link can stream as this camera. Creating a new link disables the old one.</p><div class="row">${navigator.share ? '<button type="button" class="btn primary" data-s>Send…</button>' : ''}<button type="button" class="btn" data-c>Copy message</button></div>`;
    $('[data-c]', out).onclick = () => copyText(msg);
    if ($('[data-s]', out)) $('[data-s]', out).onclick = () => navigator.share({ title: 'Spectacle camera link', text: msg }).catch(() => {});
  });
}
function copyText(t) {
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied'), () => { toast('Press and hold the text to copy it'); });
}
const IN_APP = !!window.SpectacleAndroid;
async function enablePush() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  const perm = await Notification.requestPermission(); if (perm !== 'granted') throw new Error('Notifications are blocked for this site');
  const key = Uint8Array.from(atob(S.vapidKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}
async function pageLegal() { location.href = '/legal/privacy.html'; }

// ---------------- auth screens ----------------
const consentHtml = () => `
  <label class="check"><input type="checkbox" name="terms" required> I've read and agree to the <a href="/legal/terms.html" target="_blank">Terms & disclaimer</a> and <a href="/legal/privacy.html" target="_blank">Privacy policy</a>.</label>
  <label class="check"><input type="checkbox" name="presence" required> I understand other family members can see when I'm online and which camera I'm watching, and that cameras record video of the home.</label>`;
function authPage(mode, invite) {
  $('#top').hidden = true; $('#tabs').hidden = true;
  const title = { setup: 'Set up Spectacle', login: 'Welcome back', join: 'Join your family', consent: 'Updated terms' }[mode];
  const sub = { setup: 'Create the admin account. You\'ll add cameras and invite family next.', login: 'Sign in to see your cameras.', join: 'Create your account with the invite you received.', consent: 'Please review and accept the updated terms to continue.' }[mode];
  const appCard = mode === 'join' && !IN_APP && /Android/i.test(navigator.userAgent) ? `<div class="card stack" style="margin-bottom:14px"><h2>Use the Spectacle app</h2><p class="small">It's easier and sends you alerts. Install it, then come back to this page and tap "Open in the app".</p><div class="row"><a class="btn primary" href="${esc(S.appUrl || '#')}">1. Get the app</a><a class="btn" href="spectacle://join?link=${encodeURIComponent(location.href)}">2. Open in the app</a></div></div>` : '';
  view.innerHTML = `<div class="auth"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><use href="/icon.svg#mark"/></svg><h1>${title}</h1><p class="muted">${sub}</p>${appCard}
   <form class="card stack" id="af">
    ${mode === 'setup' ? '<label class="f">Setup code<input type="text" name="setupCode" autocomplete="one-time-code" autocapitalize="characters" required placeholder="XXXXX-XXXXX"><span class="small muted" style="font-weight:400">Shown when Spectacle was installed. On the server it\'s also in <span class="mono">data/SETUP-CODE.txt</span>. It makes sure only you can create the admin account.</span></label>' : ''}
    ${mode !== 'consent' ? `${mode !== 'login' ? '<label class="f">Your name<input type="text" name="name" autocomplete="name" required maxlength="40"></label>' : ''}
    <label class="f">Username<input type="text" name="username" autocomplete="username" required autocapitalize="none"></label>
    <label class="f">Password${mode !== 'login' ? ' (10+ characters)' : ''}<input type="password" name="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required></label>` : ''}
    ${mode !== 'login' ? consentHtml() : ''}
    <button class="btn primary">${mode === 'login' ? 'Sign in' : mode === 'consent' ? 'Continue' : 'Create account'}</button><div class="err" id="aerr"></div>
   </form><p class="small muted" style="text-align:center"><a href="/legal/privacy.html">Privacy</a> · <a href="/legal/terms.html">Terms</a></p></div>`;
  $('#af').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    const consent = f.terms ? { terms: f.terms.checked, presence: f.presence.checked } : null;
    try {
      if (mode === 'login') await api('/api/login', { method: 'POST', body: { username: f.username.value, password: f.password.value }, allow401: true });
      else if (mode === 'setup') await api('/api/setup', { method: 'POST', body: { setupCode: f.setupCode.value, name: f.name.value, username: f.username.value, password: f.password.value, consent } });
      else if (mode === 'join') await api('/api/register', { method: 'POST', body: { invite, name: f.name.value, username: f.username.value, password: f.password.value, consent } });
      else await api('/api/me/consent', { method: 'POST', body: consent });
      if (mode === 'join') history.replaceState(null, '', '/#cameras');
      boot();
    } catch (err) { $('#aerr').textContent = err.message; }
  };
}

async function boot() {
  const st = await api('/api/state', { allow401: true });
  S.vapidKey = st.vapidKey; S.armed = st.armed; S.appUrl = st.appUrl; S.publicUrl = st.publicUrl;
  const join = /^#join\/([^?&]+)/.exec(location.hash);
  if (st.setupNeeded) return authPage('setup');
  if (!st.user) return join ? authPage('join', join[1]) : authPage('login');
  S.me = st.user;
  if (st.consentStale) return authPage('consent');
  $('#top').hidden = false; $('#tabs').hidden = false; renderArmed();
  if (IN_APP && window.SpectacleAndroid.signedIn) window.SpectacleAndroid.signedIn();
  if (join) history.replaceState(null, '', '/#cameras');
  connect();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  render();
}
// Give every on/off switch a spoken name for screen readers (TalkBack).
new MutationObserver(() => $$('.switch input:not([aria-label])').forEach(i => { const t = i.closest('.setting')?.querySelector('b, span')?.textContent?.trim(); if (t) i.setAttribute('aria-label', t); })).observe(view, { childList: true, subtree: true });
// Inline handlers are blocked by our Content-Security-Policy, so delegate instead.
document.addEventListener('focusin', e => { if (e.target.matches('input[readonly]')) e.target.select(); });
document.addEventListener('input', e => { if (e.target.matches('input[type=range]') && e.target.previousElementSibling) e.target.previousElementSibling.value = e.target.value; });
boot().catch(e => { view.innerHTML = `<div class="empty">Can't reach the Spectacle server. ${esc(e.message)}</div>`; });
