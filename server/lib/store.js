'use strict';
// Tiny JSON document store with atomic, debounced writes. Plenty for a household.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir, name, initial) {
    this.file = path.join(dir, name + '.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : structuredClone(initial);
    for (const [k, v] of Object.entries(initial)) if (this.data[k] === undefined) this.data[k] = structuredClone(v);
    this.timer = null;
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }
  flush() {
    clearTimeout(this.timer);
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
}

module.exports = { Store };
