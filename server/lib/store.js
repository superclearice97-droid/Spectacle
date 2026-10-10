'use strict';
// Tiny JSON document store with atomic, debounced writes. Plenty for a household.
// Every store is encrypted at rest (see vault.js); older plain files are read once and re-saved encrypted.
const fs = require('fs');
const path = require('path');
const vault = require('./vault');

class Store {
  constructor(dir, name, initial) {
    this.file = path.join(dir, name + '.json');
    const raw = fs.existsSync(this.file) ? fs.readFileSync(this.file) : null;
    this.data = raw ? vault.openJSON(raw) : structuredClone(initial);
    for (const [k, v] of Object.entries(initial)) if (this.data[k] === undefined) this.data[k] = structuredClone(v);
    this.timer = null;
    if (raw && !vault.isSealedJSON(raw)) this.flush();          // encrypt a store left over from an older version
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }
  flush() {
    clearTimeout(this.timer);
    vault.writeJSON(this.file, this.data);
  }
}

module.exports = { Store };
