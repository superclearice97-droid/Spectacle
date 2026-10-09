#!/usr/bin/env node
// Downloads the offline species encyclopedia used for the Biome folders.
// For every species the bundled models can recognise (insects, plants, birds) it fetches:
//   - taxonomy (kingdom → genus) from GBIF            (CC BY 4.0)
//   - a plain-language explanation from Wikipedia    (CC BY-SA 4.0, attributed per entry)
//   - optionally a reference photo from Wikimedia Commons, with its own licence + author
// Results go to data/species-db/species.json (+ images/). The run is resumable:
// species already fetched are skipped, so you can stop and restart it any time.
// After this finishes the app needs no internet for identification or explanations.
//
// Usage: node scripts/build-species-db.js [--no-images] [--groups insect,plant,bird] [--refresh]
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');

const cfg = loadConfig();
const args = process.argv.slice(2);
const WANT_IMAGES = !args.includes('--no-images');
const REFRESH = args.includes('--refresh');
const gi = args.indexOf('--groups');
const GROUPS = gi >= 0 ? args[gi + 1].split(',') : ['insect', 'plant', 'bird'];
const MODELS = path.join(__dirname, '..', '..', 'models');
const OUT = path.join(cfg.dataDir, 'species-db');
const IMG = path.join(OUT, 'images');
fs.mkdirSync(IMG, { recursive: true });
const DB_FILE = path.join(OUT, 'species.json');
const UA = `Spectacle/1.0 (self-hosted family app${cfg.contactEmail ? '; ' + cfg.contactEmail : ''})`;

const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : { version: 1, species: {} };
const { parseLabel, slug } = require('../lib/species');
let save = null;

// Returns parsed JSON, null for a definite "not found", or undefined when the request failed.
let netFails = 0;
async function getJSON(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (r.status === 404) { netFails = 0; return null; }
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      netFails = 0;
      return await r.json();
    } catch (e) {
      if (++netFails >= 12) { save && save(); console.error(`\nCan't reach Wikipedia/GBIF (${e.message}) — check the internet connection, then run \`npm run species-db\` again to resume.`); process.exit(2); }
      await sleep(1500 * (attempt + 1));
    }
  }
  return undefined;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stripHtml = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function wikiSummary(title) {
  const j = await getJSON('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')) + '?redirect=true');
  if (j === undefined) return undefined;
  if (!j || j.type === 'disambiguation' || !j.extract) return null;
  return j;
}

async function commonsImage(fileUrl) {
  // fileUrl like https://upload.wikimedia.org/wikipedia/commons/a/ab/Name.jpg
  const m = /\/([^/]+\.(?:jpe?g|png|webp))$/i.exec(decodeURIComponent(fileUrl || ''));
  if (!m) return null;
  const file = 'File:' + m[1];
  const j = await getJSON('https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=480&titles=' + encodeURIComponent(file));
  const page = j && j.query && Object.values(j.query.pages)[0];
  const ii = page && page.imageinfo && page.imageinfo[0];
  if (!ii) return null;
  const md = ii.extmetadata || {};
  const license = md.LicenseShortName && md.LicenseShortName.value;
  // Only keep freely licensed images whose licence we can display.
  if (!license || !/^(CC|Public domain|PD)/i.test(license)) return null;
  return { thumb: ii.thumburl || ii.url, page: ii.descriptionurl, license, licenseUrl: md.LicenseUrl && md.LicenseUrl.value, artist: stripHtml(md.Artist && md.Artist.value) || 'Unknown author' };
}

async function fetchOne(group, label) {
  const { scientific, common } = parseLabel(label);
  const id = slug(scientific);
  if (!REFRESH && db.species[id] && db.species[id].fetchedAt) return 'skip';
  const gbif = await getJSON('https://api.gbif.org/v1/species/match?verbose=false&name=' + encodeURIComponent(scientific));
  let w = await wikiSummary(scientific);
  if (!w && w !== undefined && common) w = await wikiSummary(common);
  if (gbif === undefined || w === undefined) return 'failed'; // try again next run
  const entry = {
    id, group, scientific, common,
    taxonomy: gbif && gbif.matchType !== 'NONE' ? { kingdom: gbif.kingdom, phylum: gbif.phylum, class: gbif.class, order: gbif.order, family: gbif.family, genus: gbif.genus, gbifKey: gbif.usageKey } : {},
    summary: w ? w.extract : null,
    description: w ? w.description || null : null,
    source: w ? { title: w.title, url: w.content_urls && w.content_urls.desktop && w.content_urls.desktop.page, license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' } : null,
    image: null,
    fetchedAt: new Date().toISOString(),
  };
  if (WANT_IMAGES && w && (w.originalimage || w.thumbnail)) {
    const info = await commonsImage((w.originalimage || w.thumbnail).source);
    if (info && info.thumb) {
      try {
        const r = await fetch(info.thumb, { headers: { 'User-Agent': UA } });
        if (r.ok) {
          const ext = (/\.(png|webp)$/i.exec(info.thumb) || ['.jpg'])[0].toLowerCase();
          const fname = id + ext;
          fs.writeFileSync(path.join(IMG, fname), Buffer.from(await r.arrayBuffer()));
          entry.image = { file: fname, credit: info.artist, license: info.license, licenseUrl: info.licenseUrl, source: info.page };
        }
      } catch {}
    }
  }
  db.species[id] = entry;
  return w ? 'ok' : 'partial';
}

(async () => {
  const jobs = [];
  for (const g of GROUPS) {
    const labels = fs.readFileSync(path.join(MODELS, `inat_${g}_labels.txt`), 'utf8').split('\n').map(s => s.trim()).filter(s => s && s !== 'background');
    for (const l of labels) jobs.push([g, l]);
  }
  console.log(`Building offline species database: ${jobs.length} species (${GROUPS.join(', ')})${WANT_IMAGES ? ' with reference photos' : ''}`);
  let done = 0, ok = 0, partial = 0, skipped = 0, failed = 0, i = 0;
  save = () => { db.updatedAt = new Date().toISOString(); fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); };
  const worker = async () => {
    while (i < jobs.length) {
      const [g, l] = jobs[i++];
      const r = await fetchOne(g, l).catch(() => 'partial');
      if (r === 'ok') ok++; else if (r === 'skip') skipped++; else if (r === 'failed') failed++; else partial++;
      if (++done % 50 === 0) { save(); process.stdout.write(`\r  ${done}/${jobs.length}  (explained ${ok}, no article ${partial}, already had ${skipped})   `); }
      if (r !== 'skip') await sleep(150); // be polite to Wikipedia/GBIF
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  save();
  console.log(`\nDone. ${ok} new explanations, ${partial} without a Wikipedia article, ${skipped} already present${failed ? `, ${failed} failed (rerun to retry)` : ''}.\nSaved to ${DB_FILE}`);
})();
