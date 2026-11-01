// store.js — tiny JSON-file database with atomic, debounced saves.
// Swap this module for PostgreSQL later; the rest of the app only uses db/save/flush.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'evidence'), { recursive: true });
const FILE = path.join(DATA_DIR, 'db.json');

let db = { users: {}, sessions: {}, tournaments: {} };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') console.error('Could not read db.json, starting empty:', e.message);
}

let timer = null;
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
function save() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; try { flush(); } catch (e) { console.error('save failed', e); } }, 250);
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { flush(); } catch {} process.exit(0); });
}

module.exports = { db, save, flush, DATA_DIR };
