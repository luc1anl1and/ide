// Workspace checkpoints: lets "Undo" restore files no matter HOW an agent changed them (patch, shell command, any tool).
//
// How it works: when a folder is opened we keep a content-addressed shadow copy of its text files (small ones, junk folders
// skipped). Every change reported by the file watcher appends a new "version" for that file. A checkpoint is just a timestamp:
// restoring to it puts every file changed since back to the version it had at that moment (and removes files created since).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const SKIP_DIR = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'release', 'out', '.next', '.nuxt', '.cache', '.turbo', 'target', '__pycache__', '.venv', 'venv', '.idea', '.vs', 'bin', 'obj', 'coverage', '.gradle']);
const MAX_FILE = 1024 * 1024, MAX_FILES = 8000, MAX_BYTES = 300 * 1024 * 1024;

let root = null, store = null, files = new Map(); // rel -> [{t, h}]  (h = sha1 or null when the file is absent)
let bytes = 0, scanning = false, token = 0;

const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
const ignored = (r) => r.split('/').some((seg) => SKIP_DIR.has(seg));
function isText(buf) { return !buf.subarray(0, 8000).includes(0); }
function putBlob(buf) { const h = sha(buf); const f = path.join(store, h); if (!fs.existsSync(f)) { fs.writeFileSync(f, buf); bytes += buf.length; } return h; }
const push = (r, v) => { const l = files.get(r) || []; if (l.length && l[l.length - 1].h === v.h) return; l.push(v); files.set(r, l); };

async function scan(dir, my, depth = 0) {
  if (my !== token || depth > 12 || files.size >= MAX_FILES || bytes >= MAX_BYTES) return;
  let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (my !== token) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) await scan(full, my, depth + 1); continue; }
    try {
      const st = await fs.promises.stat(full); if (st.size > MAX_FILE) continue;
      const buf = await fs.promises.readFile(full); if (!isText(buf)) continue;
      push(rel(full), { t: 0, h: putBlob(buf) });
    } catch { /* locked / vanished */ }
  }
}

function open(folder) {
  token++; root = folder; files = new Map(); bytes = 0;
  const key = crypto.createHash('sha1').update(folder.toLowerCase()).digest('hex').slice(0, 12);
  store = path.join(app.getPath('userData'), 'checkpoints', key); fs.mkdirSync(store, { recursive: true });
  scanning = true; const my = token;
  scan(folder, my).catch(() => { }).finally(() => { if (my === token) scanning = false; });
}

// called with absolute paths that the watcher reported as changed
function changed(paths) {
  if (!root) return;
  const t = Date.now();
  for (const p of paths) {
    const r = rel(p); if (r.startsWith('..') || ignored(r)) continue;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) continue;
      if (st.size > MAX_FILE) { push(r, { t, h: null, big: true }); continue; }
      const buf = fs.readFileSync(p); if (!isText(buf)) continue;
      // a file that first appears after the baseline scan has no prior version → mark it as absent at time 0
      if (!files.has(r)) files.set(r, [{ t: 0, h: null }]);
      push(r, { t, h: putBlob(buf) });
    } catch {
      if (files.has(r)) push(r, { t, h: null }); else files.set(r, [{ t: 0, h: null }, { t, h: null }]);
    }
  }
}

const mark = () => Date.now();
function versionAt(list, t) { let v = null; for (const x of list) if (x.t <= t) v = x; return v; }

// what restoring to `t` would do (no changes made)
function plan(t) {
  const out = [];
  for (const [r, list] of files) {
    const last = list[list.length - 1]; if (last.t <= t) continue;
    const at = versionAt(list, t); if (!at || at.big) continue; // unknown / too big → leave alone
    const full = path.join(root, r); const exists = fs.existsSync(full);
    if (at.h === null) { if (exists) out.push({ rel: r, full, action: 'delete' }); }
    else { let cur = null; try { cur = sha(fs.readFileSync(full)); } catch { /* absent */ } if (cur !== at.h) out.push({ rel: r, full, action: exists ? 'restore' : 'recreate', h: at.h }); }
  }
  return out;
}
function restore(t) {
  let restored = 0, deleted = 0, failed = 0; const touched = [];
  for (const a of plan(t)) {
    try {
      if (a.action === 'delete') { fs.unlinkSync(a.full); deleted++; }
      else { fs.mkdirSync(path.dirname(a.full), { recursive: true }); fs.copyFileSync(path.join(store, a.h), a.full); restored++; }
      touched.push(a.full);
    } catch { failed++; }
  }
  // the watcher will report these writes: record them as new versions so later undos stay consistent
  setTimeout(() => changed(touched), 400);
  return { restored, deleted, failed };
}

// ---------- review support: what changed since a checkpoint, with +/- line counts, base content, per-file revert ----------
function diffStats(a, b) {
  const x = a.replace(/\r\n/g, '\n').split('\n'), y = b.replace(/\r\n/g, '\n').split('\n'); // CRLF vs LF alone is not a change
  let s = 0; while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let ea = x.length, eb = y.length; while (ea > s && eb > s && x[ea - 1] === y[eb - 1]) { ea--; eb--; }
  const A_ = x.slice(s, ea), B_ = y.slice(s, eb);
  if (!A_.length || !B_.length || A_.length * B_.length > 4e6) { // trivial or huge middle: count by multiset
    if (!A_.length || !B_.length) return { added: B_.length, removed: A_.length };
    const m = new Map(); for (const l of A_) m.set(l, (m.get(l) || 0) + 1); let common = 0;
    for (const l of B_) { const c = m.get(l); if (c) { m.set(l, c - 1); common++; } }
    return { added: B_.length - common, removed: A_.length - common };
  }
  // LCS length on the changed middle part (O(n*m) rolling array)
  let prev = new Uint32Array(B_.length + 1), cur = new Uint32Array(B_.length + 1);
  for (let i = 1; i <= A_.length; i++) { for (let j = 1; j <= B_.length; j++) cur[j] = A_[i - 1] === B_[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]); [prev, cur] = [cur, prev]; }
  const lcs = prev[B_.length]; return { added: B_.length - lcs, removed: A_.length - lcs };
}
const blobText = (h) => { try { return fs.readFileSync(path.join(store, h), 'utf8'); } catch { return null; } };
function changes(t) {
  const out = [];
  for (const a of plan(t)) {
    let base = null; if (a.h) base = blobText(a.h); let cur = ''; try { cur = fs.readFileSync(a.full, 'utf8'); } catch { }
    const st = a.action === 'delete' ? diffStats('', cur) : a.action === 'recreate' ? diffStats(base || '', '') : diffStats(base || '', cur);
    out.push({ rel: a.rel, full: a.full, action: a.action === 'delete' ? 'created' : a.action === 'recreate' ? 'deleted' : 'modified', added: st.added, removed: st.removed });
  }
  return out;
}
function baseOf(rel, t) { const list = files.get(rel); if (!list) return null; const v = versionAt(list, t); return v && v.h ? blobText(v.h) : null; }
function revertFile(relPath, t) {
  const list = files.get(relPath); if (!list) return { ok: false, error: 'No history for this file' };
  const at = versionAt(list, t); const full = path.join(root, relPath); if (!at || at.big) return { ok: false, error: 'Original version is not available' };
  try {
    if (at.h === null) { if (fs.existsSync(full)) fs.unlinkSync(full); } else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.copyFileSync(path.join(store, at.h), full); }
    setTimeout(() => changed([full]), 400); return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

function register(ipcMain) {
  ipcMain.handle('cp:changes', (_e, t) => { try { return changes(t); } catch { return []; } });
  ipcMain.handle('cp:base', (_e, { rel, t }) => { try { return baseOf(rel, t); } catch { return null; } });
  ipcMain.handle('cp:revertFile', (_e, { rel, t }) => revertFile(rel, t));
  ipcMain.handle('cp:mark', () => ({ t: mark(), scanning }));
  ipcMain.handle('cp:plan', (_e, t) => { try { return plan(t).map((a) => ({ rel: a.rel, action: a.action })); } catch { return []; } });
  ipcMain.handle('cp:restore', (_e, t) => { try { return { ok: true, ...restore(t) }; } catch (e) { return { ok: false, error: e.message }; } });
}
module.exports = { register, open, changed, mark, plan, restore };
