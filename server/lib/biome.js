'use strict';
// Passive biome log: turns model detections into per-species folders with explanations.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('./store');
const vault = require('./vault');
const { parseLabel, slug, decodeJpeg, planCrops } = require('./species');

const GROUP_NAMES = { insect: 'Insects & bugs', plant: 'Plants & flowers', bird: 'Birds' };
const safe = s => (s || 'Unsorted').replace(/[\/\\:*?"<>|]+/g, '-').trim() || 'Unsorted';

class Biome {
  constructor(cfg, identifier, onEvent) {
    this.cfg = cfg; this.id = identifier; this.onEvent = onEvent;
    this.dir = path.join(cfg.dataDir, 'biome');
    fs.mkdirSync(this.dir, { recursive: true });
    this.store = new Store(cfg.dataDir, 'biome', { species: {}, sightings: [] });
  }

  folderFor(sp) {
    const info = this.id.info(sp.scientific) || {};
    const t = info.taxonomy || {};
    const name = sp.common ? `${sp.scientific} (${sp.common})` : sp.scientific;
    return path.join(GROUP_NAMES[sp.group] || sp.group, safe(t.order), safe(t.family), safe(name));
  }

  writeInfo(sp) {
    const abs = path.join(this.dir, sp.folder);
    fs.mkdirSync(path.join(abs, 'photos'), { recursive: true });
    const info = this.id.info(sp.scientific);
    const t = (info && info.taxonomy) || {};
    const lines = [
      `# ${sp.common || sp.scientific}`, '', `*${sp.scientific}* — ${GROUP_NAMES[sp.group]}`, '',
      Object.keys(t).length ? `**Classification:** ${['kingdom', 'phylum', 'class', 'order', 'family', 'genus'].map(k => t[k]).filter(Boolean).join(' › ')}` : '', '',
      '## What it is', '', info && info.summary ? info.summary : '_No offline explanation yet. Run `npm run species-db` while online to download it._', '',
      '## In your yard', '',
      `- First seen: ${sp.firstSeen.slice(0, 10)}`, `- Times detected: ${sp.count}`, '- Photos are encrypted; open them in the Spectacle app.',
      `- Status: ${sp.status}${sp.status === 'unreviewed' ? ' (automatic ID — confirm it in the app)' : ''}`, '',
      info && info.source ? `---\nExplanation text from Wikipedia, “${info.source.title}” (${info.source.url}), licensed ${info.source.license} (${info.source.licenseUrl}). Taxonomy from GBIF (CC BY 4.0).` : '',
      '_Identifications are automatic and can be wrong. Never eat, touch or handle anything based on this app._',
    ];
    fs.writeFileSync(path.join(abs, 'info.md'), lines.join('\n'));
  }

  async saveCrop(jpeg, img, crop, file) {
    const c = [Math.round(crop.w), Math.round(crop.h), Math.round(crop.x), Math.round(crop.y)].map(v => Math.max(0, v));
    const out = await new Promise(res => {
      const p = spawn(this.cfg.ffmpeg, ['-v', 'error', '-protocol_whitelist', 'pipe', '-f', 'jpeg_pipe', '-i', 'pipe:0', '-vf', `crop=${c[0]}:${c[1]}:${c[2]}:${c[3]},scale='min(640,iw)':-2`, '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
      const chunks = []; p.stdout.on('data', d => chunks.push(d));
      p.on('close', () => res(Buffer.concat(chunks))); p.on('error', () => res(Buffer.alloc(0))); p.stdin.on('error', () => {}); p.stdin.end(jpeg);
    });
    vault.writeFile(file, out.length ? out : jpeg);                 // photos are encrypted at rest
  }
  /* Encrypt biome photos saved by older versions. */
  encryptOldPhotos() {
    let n = 0;
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jpg') && path.basename(d) === 'photos' && !vault.isSealedFile(p)) { const st = fs.statSync(p); vault.writeFile(p, fs.readFileSync(p)); fs.utimesSync(p, st.atime, st.mtime); n++; } } };
    if (fs.existsSync(this.dir)) walk(this.dir);
    for (const sp of Object.values(this.store.data.species)) try { this.writeInfo(sp); } catch {}
    return n;
  }

  // Analyse one camera frame. `box` = recent motion region (normalised) if any.
  async scanFrame(cam, jpeg, box) {
    const b = this.cfg.biome;
    const img = await decodeJpeg(this.cfg.ffmpeg, jpeg);
    // Night-vision / IR frames are greyscale: the colour models can't identify anything there.
    let sat = 0, n = 0;
    for (let i = 0; i < img.rgb.length; i += 3 * 97) { const r = img.rgb[i], g = img.rgb[i + 1], bl = img.rgb[i + 2]; sat += Math.max(r, g, bl) - Math.min(r, g, bl); n++; }
    if (sat / n < 12) return [];
    const plan = planCrops(img, { tiles: b.tiles, box });
    const results = await this.id.classify(img, plan, b.groups);
    const found = [];
    const best = new Map();
    for (const r of results) {
      const top = r.top[0];
      if (!top || top.conf < b.minConfidence || top.conf <= r.background) continue;
      // Motion crops are where small, moving things (bugs, birds) show up; plants come from any crop.
      const k = r.group + ':' + top.label;
      if (!best.has(k) || best.get(k).conf < top.conf) best.set(k, { group: r.group, label: top.label, conf: top.conf, crop: plan.find(p => p.name === r.crop) });
    }
    for (const d of best.values()) { const s = await this.record(cam, d, jpeg, img); if (s) found.push(s); }
    return found;
  }

  async record(cam, d, jpeg, img, manual = false) {
    const { scientific, common } = parseLabel(d.label);
    const id = slug(scientific);
    const now = new Date();
    const existing = this.store.data.species[id];
    if (existing && existing.status === 'rejected' && !manual) return null;
    const draft = existing || { id, group: d.group, scientific, common, firstSeen: now.toISOString(), lastSeen: null, count: 0, cameras: {}, status: manual ? 'confirmed' : 'unreviewed', bestConf: 0, photos: [] };
    if (!existing) draft.folder = this.folderFor(draft);
    const last = this.store.data.sightings.find(s => s.species === id && s.cam === cam.id);
    const recent = last && now - new Date(last.ts) < this.cfg.biome.dedupeMinutes * 60000;
    // Save the photo first so the folder never appears without one.
    let photo = null;
    if (!recent || d.conf > draft.bestConf) {
      const fname = `${now.toISOString().replace(/[:.]/g, '-')}_${slug(cam.name)}.jpg`;
      fs.mkdirSync(path.join(this.dir, draft.folder, 'photos'), { recursive: true });
      await this.saveCrop(jpeg, img, d.crop, path.join(this.dir, draft.folder, 'photos', fname));
      photo = { file: fname, ts: now.toISOString(), conf: d.conf, cam: cam.name };
    }
    const sp = this.store.data.species[id] || (this.store.data.species[id] = draft);
    sp.count++; sp.lastSeen = now.toISOString(); sp.cameras[cam.name] = (sp.cameras[cam.name] || 0) + 1;
    if (photo) { sp.photos.unshift(photo); sp.photos = sp.photos.slice(0, 40); sp.bestConf = Math.max(sp.bestConf, d.conf); }
    if (!recent) {
      const isNew = sp.count === 1;
      this.store.data.sightings.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), species: id, cam: cam.id, camName: cam.name, ts: now.toISOString(), conf: d.conf });
      this.store.data.sightings = this.store.data.sightings.slice(0, 5000);
      this.onEvent && this.onEvent({ type: 'sighting', species: this.view(sp), cam: cam.name, conf: d.conf, isNew });
    }
    this.writeInfo(sp);
    this.store.save();
    return this.view(sp);
  }

  // Manual "what is this?" from an uploaded photo or a live frame.
  async identifyJpeg(jpeg) {
    const img = await decodeJpeg(this.cfg.ffmpeg, jpeg);
    // Whole photo (as the models were trained) plus a centre crop; keep each species' best score.
    const plan = [{ name: 'full', x: 0, y: 0, w: img.w, h: img.h }, ...planCrops(img, { tiles: false })];
    const results = await this.id.classify(img, plan, ['insect', 'plant', 'bird']);
    const best = new Map();
    for (const r of results) for (const t of r.top) {
      const k = r.group + ':' + t.label; if (best.has(k) && best.get(k).conf >= t.conf) continue;
      const { scientific, common } = parseLabel(t.label);
      best.set(k, { group: r.group, label: t.label, scientific, common, conf: t.conf, info: this.id.info(scientific) });
    }
    const all = [...best.values()].sort((a, b) => b.conf - a.conf);
    return { candidates: all.slice(0, 6), img, plan };
  }

  // After the offline species database arrives, move folders into their proper Order/Family.
  refile() {
    let moved = 0;
    for (const sp of Object.values(this.store.data.species)) {
      const want = this.folderFor(sp);
      if (want === sp.folder) continue;
      const from = path.join(this.dir, sp.folder), to = path.join(this.dir, want);
      try { fs.mkdirSync(path.dirname(to), { recursive: true }); if (fs.existsSync(from)) fs.renameSync(from, to); sp.folder = want; this.writeInfo(sp); moved++; } catch (e) { console.warn('refile', sp.id, e.message); }
    }
    if (moved) this.store.save();
    return moved;
  }

  view(sp) {
    const info = this.id.info(sp.scientific);
    return { ...sp, groupName: GROUP_NAMES[sp.group], info: info ? { summary: info.summary, description: info.description, taxonomy: info.taxonomy, source: info.source, image: info.image } : null };
  }
  list() { return Object.values(this.store.data.species).map(sp => this.view(sp)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)); }
  setStatus(id, status) {
    const sp = this.store.data.species[id]; if (!sp) return null;
    sp.status = status; this.writeInfo(sp); this.store.save(); return this.view(sp);
  }
  photoPath(id, file) {
    const sp = this.store.data.species[id]; if (!sp || !/^[\w.-]+\.jpg$/.test(file)) return null;
    return path.join(this.dir, sp.folder, 'photos', file);
  }
}

module.exports = { Biome, GROUP_NAMES };
