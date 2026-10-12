#!/usr/bin/env node
'use strict';
// Decrypt one of Spectacle's encrypted files (recording, snapshot, biome photo or JSON store) for export.
// Usage: npm run decrypt -- data/recordings/<cam>/<file>.mp4.spx out.mp4
// Run it as the Spectacle user; when the key is sealed with systemd-creds, run it through the service's
// credential, e.g.: sudo systemd-run --pipe --wait -p LoadCredentialEncrypted=spectacle-key:/etc/spectacle/spectacle-key.cred -p User=$USER node server/scripts/decrypt.js IN OUT
const fs = require('fs');
const { loadConfig } = require('../lib/config');
const vault = require('../lib/vault');
const [inp, out] = process.argv.slice(2);
if (!inp || !out) { console.error('Usage: npm run decrypt -- <encrypted file> <output file>'); process.exit(1); }
loadConfig();
const buf = fs.readFileSync(inp);
const plain = vault.isSealedJSON(buf) ? Buffer.from(JSON.stringify(vault.openJSON(buf), null, 2)) : vault.readFile(inp);
fs.writeFileSync(out, plain, { mode: 0o600 });
console.log(`Wrote ${plain.length} bytes to ${out}. Keep it private: it isn't encrypted.`);
