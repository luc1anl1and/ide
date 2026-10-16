// The desktop pet: a small transparent always-on-top window that roams the screen, shows speech bubbles, and opens a toolbar
// (ask the AI, see what every agent is doing). Also owns the tray icon and "keep running when the IDE window is closed".
//
// Pets use the Codex pet format (https://codex-pets.net): a folder or .codex-pet.zip with pet.json + a spritesheet
// (8 columns x 11 rows of 192x208 cells; row 0 idle, 1 run right, 2 run left, 3 wave, 4 jump, 5 failed, 6 waiting, 7 running, 8 review).
// A single image can also be imported; it becomes a static pet that bobs and squashes.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

const W = 380, BASE_H = 260;
let petSize = { w: W, h: BASE_H };
let ctx = null, petWin = null, tray = null, cfg = {}, lastState = { chats: [], providers: [] }, quitting = false, pcState = { view: false, control: false };

const userPets = () => path.join(ctx.app.getPath('userData'), 'pets');
const builtinPets = () => path.join(__dirname, 'renderer', 'assets', 'pets');
const stateFile = () => path.join(ctx.app.getPath('userData'), 'pet-state.json');
const iconPath = () => path.join(__dirname, 'renderer', 'assets', 'icon.ico');
const safeId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function readPetDir(dir, builtin) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8').replace(/^﻿/, ''));
    const id = safeId(j.id || path.basename(dir)); if (!id) return null;
    const rel = String(j.spritesheetPath || 'spritesheet.webp'); const sheet = path.resolve(dir, rel);
    if (!sheet.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(sheet)) return null;
    return { id, name: String(j.displayName || j.name || id).slice(0, 60), description: String(j.description || '').slice(0, 300), sheet: pathToFileURL(sheet).href,
      kind: j.kind === 'image' ? 'image' : 'sheet', pixel: j.pixelArt === true || /pixel/i.test(id + ' ' + (j.displayName || '')), builtin: !!builtin, dir };
  } catch { return null; }
}
function listPets() {
  const out = [];
  for (const base of [builtinPets(), userPets()]) {
    let names = []; try { names = fs.readdirSync(base); } catch { }
    for (const n of names) { const p = readPetDir(path.join(base, n), base === builtinPets()); if (p && !out.some((x) => x.id === p.id)) out.push(p); }
  }
  return out;
}
const pub = (p) => ({ id: p.id, name: p.name, description: p.description, sheet: p.sheet, kind: p.kind, pixel: p.pixel, builtin: p.builtin });

// ---------------------------------------------------------------- import
const run = (file, args) => new Promise((res, rej) => execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => (e ? rej(new Error(String(se || e.message).slice(0, 300))) : res(so))));
function findPetJson(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'pet.json'))) return dir;
  if (depth > 2) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) { const r = findPetJson(path.join(dir, e.name), depth + 1); if (r) return r; }
  return null;
}
async function importPet(file) {
  try {
    fs.mkdirSync(userPets(), { recursive: true });
    const st = fs.statSync(file); let srcDir = file, tmp = null;
    if (st.isFile() && /\.(png|webp|gif|jpe?g)$/i.test(file)) {   // a single picture -> static pet
      const id = safeId(path.basename(file).replace(/\.[^.]+$/, '')) || 'pet'; const dest = path.join(userPets(), id); fs.mkdirSync(dest, { recursive: true });
      const sheet = 'spritesheet' + path.extname(file).toLowerCase(); fs.copyFileSync(file, path.join(dest, sheet));
      fs.writeFileSync(path.join(dest, 'pet.json'), JSON.stringify({ id, displayName: id, description: 'Imported picture', spritesheetPath: sheet, kind: 'image' }, null, 2));
      return { ok: true, id };
    }
    if (st.isFile()) {   // .zip / .codex-pet.zip
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-pet-'));
      const zip = path.join(tmp, 'pet.zip'); fs.copyFileSync(file, zip);
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${path.join(tmp, 'x').replace(/'/g, "''")}' -Force`]);
      srcDir = path.join(tmp, 'x');
    }
    const root = findPetJson(srcDir); if (!root) throw new Error('No pet.json found - is this a Codex pet (.codex-pet.zip)?');
    const probe = readPetDir(root, false); if (!probe) throw new Error('pet.json is invalid or its spritesheet is missing');
    const dest = path.join(userPets(), probe.id); fs.rmSync(dest, { recursive: true, force: true }); fs.cpSync(root, dest, { recursive: true });
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: true, id: probe.id };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------------------------------------------------------------- windows
function petBounds() { return petWin && !petWin.isDestroyed() ? petWin.getBounds() : null; }
function clampToDisplay(b) {
  const wa = ctx.screen.getDisplayMatching(b).workArea; const slack = 90;   // the transparent margin may hang off the edge a little
  return { ...b, x: Math.max(wa.x - slack, Math.min(b.x, wa.x + wa.width - b.width + slack)), y: Math.max(wa.y - 30, Math.min(b.y, wa.y + wa.height - b.height + 6)) };
}
function savePos() { const b = petBounds(); if (b) try { fs.writeFileSync(stateFile(), JSON.stringify({ x: b.x, y: b.y })); } catch { } }
function loadPos() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; } }

function createPet() {
  if (petWin && !petWin.isDestroyed()) return;
  const wa = ctx.screen.getPrimaryDisplay().workArea; const pos = loadPos() || { x: wa.x + wa.width - W - 40, y: wa.y + wa.height - BASE_H };
  const b = clampToDisplay({ x: pos.x, y: pos.y, width: W, height: BASE_H });
  petWin = new ctx.BrowserWindow({
    ...b, transparent: true, frame: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, focusable: true,
    backgroundColor: '#00000000', title: 'hyper-ide pet', icon: iconPath(), type: 'toolbar', maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'pet-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  petSize = { w: b.width, h: b.height };
  petWin.setAlwaysOnTop(true, 'screen-saver'); petWin.setMenuBarVisibility(false);
  petWin.setIgnoreMouseEvents(true, { forward: true });
  if (ctx.testLog) petWin.webContents.on('console-message', (e) => console.log('[pet]', e.message));
  petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
  petWin.once('ready-to-show', () => petWin && petWin.showInactive());
  petWin.webContents.on('before-input-event', (e, i) => { if (i.type === 'keyDown' && i.key === 'F12' && i.control) petWin.webContents.toggleDevTools(); });
  petWin.on('closed', () => { petWin = null; });
}
function destroyPet() { if (petWin && !petWin.isDestroyed()) { savePos(); petWin.destroy(); } petWin = null; }
const toPet = (ch, payload) => { if (petWin && !petWin.isDestroyed()) petWin.webContents.send(ch, payload); };

function createTray() {
  if (tray) return;
  try {
    const img = ctx.nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
    tray = new ctx.Tray(img); tray.setToolTip('hyper-ide');
    tray.on('click', () => ctx.showMain());
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  } catch { tray = null; }
}
function buildMenu() {
  const on = !!(petWin && !petWin.isDestroyed() && petWin.isVisible());
  return ctx.Menu.buildFromTemplate([
    { label: 'Open hyper-ide', click: () => ctx.showMain() },
    { label: on ? 'Hide pet' : 'Show pet', click: () => { if (on) petWin.hide(); else { createPet(); petWin.showInactive(); } } },
    { label: 'Ask the AI…', click: () => { createPet(); toPet('pet:open', { tab: 'ask' }); if (petWin) petWin.showInactive(); } },
    { type: 'separator' },
    { label: 'Stop PC control', enabled: pcState.view || pcState.control, click: () => ctx.pc.revoke() },
    { type: 'separator' },
    { label: 'Quit hyper-ide', click: () => { quitting = true; ctx.app.quit(); } },
  ]);
}
function destroyTray() { if (tray) { try { tray.destroy(); } catch { } tray = null; } }

// ---------------------------------------------------------------- AI cursor overlay (the "virtual mouse")
// One transparent click-through window per monitor (a single window spanning monitors of different scaling breaks on Windows),
// the cursor is drawn on whichever monitor the target is on and hops between monitors.
const curWins = new Map(); let lastOv = null, curHideT = null;
function overlayFor(d) {
  let o = curWins.get(d.id); if (o && !o.win.isDestroyed()) return o;
  const win = new ctx.BrowserWindow({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, transparent: true, frame: false, resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, type: 'toolbar', backgroundColor: '#00000000', title: 'hyper-ide cursor',
    webPreferences: { preload: path.join(__dirname, 'cursor-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  win.setAlwaysOnTop(true, 'screen-saver'); win.setIgnoreMouseEvents(true); win.setBounds(d.bounds);
  o = { win, ready: false, queue: [], display: d };
  win.loadFile(path.join(__dirname, 'renderer', 'cursor.html'));
  win.webContents.once('did-finish-load', () => { o.ready = true; for (const m of o.queue) win.webContents.send('cursor:go', m); o.queue = []; });
  win.on('closed', () => { if (curWins.get(d.id) === o) curWins.delete(d.id); if (lastOv === o) lastOv = null; });
  curWins.set(d.id, o); return o;
}
const sendOv = (o, m) => { if (!o || o.win.isDestroyed()) return; if (o.ready) o.win.webContents.send('cursor:go', m); else o.queue.push(m); };
function armHide() { clearTimeout(curHideT); curHideT = setTimeout(() => { for (const o of curWins.values()) if (!o.win.isDestroyed()) o.win.hide(); }, 13000); }
const clampTo = (p, b) => ({ x: Math.max(b.x, Math.min(b.x + b.width - 1, p.x)), y: Math.max(b.y, Math.min(b.y + b.height - 1, p.y)) });
function cursorEvent(m) {
  if (m.hide) { for (const o of curWins.values()) sendOv(o, { hide: true }); return; }
  const petSpot = () => { const pb = petBounds(); const pt = pb ? { x: pb.x + pb.width / 2 + 40, y: pb.y + pb.height - 70 } : ctx.screen.getCursorScreenPoint(); const d = ctx.screen.getDisplayNearestPoint(pt); return { d, pt: clampTo(pt, d.bounds) }; };
  if (m.show || m.ripple || m.x == null) {
    if (m.ripple) { if (lastOv && !lastOv.win.isDestroyed()) sendOv(lastOv, m); return; }
    if (!lastOv || lastOv.win.isDestroyed()) {   // first sign of life: the cursor appears next to the pet
      const s = petSpot(); const o = overlayFor(s.d); lastOv = o; o.win.showInactive(); sendOv(o, { x: s.pt.x - s.d.bounds.x, y: s.pt.y - s.d.bounds.y, from: { x: s.pt.x - s.d.bounds.x, y: s.pt.y - s.d.bounds.y }, label: m.label, action: m.action });
    }
    sendOv(lastOv, m); lastOv.win.showInactive(); armHide(); return;
  }
  const dip = ctx.screen.screenToDipPoint({ x: Math.round(m.x), y: Math.round(m.y) });
  const d = ctx.screen.getDisplayNearestPoint(dip); const o = overlayFor(d); const b = d.bounds;
  const out = { ...m, x: dip.x - b.x, y: dip.y - b.y };
  if (m.x2 != null) { const d2 = clampTo(ctx.screen.screenToDipPoint({ x: Math.round(m.x2), y: Math.round(m.y2) }), b); out.x2 = d2.x - b.x; out.y2 = d2.y - b.y; }
  // the AI's cursor is its own: it starts from the pet (never from the user's pointer); if the pet is on another monitor it glides in from the nearest edge
  const pb = petBounds(); const start = clampTo(pb ? { x: pb.x + pb.width / 2, y: pb.y + pb.height - 80 } : ctx.screen.getCursorScreenPoint(), b); out.from = { x: start.x - b.x, y: start.y - b.y };
  if (lastOv && lastOv !== o) sendOv(lastOv, { hide: true });
  o.win.showInactive(); sendOv(o, out); lastOv = o; armHide();
  toPet('pet:pc', { cursor: dip });
}
// ---------------------------------------------------------------- config / lifecycle
function apply(next) {
  cfg = { enabled: true, id: 'reva', scale: 0.75, wander: true, bubbles: true, quips: true, keepRunning: true, ...(next || {}) };
  if (ctx.shot) return;
  if (cfg.enabled) { createPet(); createTray(); } else { destroyPet(); destroyTray(); }
  toPet('pet:cfg', fullCfg());
}
const fullCfg = () => ({ ...cfg, pets: listPets().map(pub), pc: pcState });
const keepRunning = () => !ctx.shot && cfg.enabled !== false && cfg.keepRunning !== false && !!tray;
function onMainHidden() {
  toPet('pet:event', { kind: 'hidden' });
}

function register(c) {
  ctx = c; const { ipcMain } = c;
  ctx.pc.bus.on('grants', (g) => { pcState = g; toPet('pet:pc', { grants: g }); });
  ctx.pc.bus.on('activity', (a) => toPet('pet:pc', { activity: a.text }));
  ctx.pc.bus.on('cursor', (m) => { if (!ctx.shot) { try { cursorEvent(m); } catch { } } });

  ipcMain.handle('pet:config', (_e, next) => { apply(next); return true; });
  // the pet window reads sprites as data: URLs (a file: image would taint the canvas used to detect animation frames)
  ipcMain.handle('pet:sheet', (_e, id) => { const p = listPets().find((x) => x.id === id); if (!p) return null; const f = path.join(p.dir, decodeURIComponent(new URL(p.sheet).pathname.split('/').pop())); try { const ext = path.extname(f).slice(1).toLowerCase(); return 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + fs.readFileSync(f).toString('base64'); } catch { return null; } });
  ipcMain.handle('pet:list', () => listPets().map(pub));
  ipcMain.handle('pet:import', async (_e, file) => {
    if (!file) { const r = await ctx.dialog.showOpenDialog(ctx.getWin(), { title: 'Import a pet', properties: ['openFile'], filters: [{ name: 'Pets (.codex-pet.zip, .zip, image)', extensions: ['zip', 'png', 'webp', 'gif', 'jpg', 'jpeg'] }] }); if (r.canceled) return { ok: false, canceled: true }; file = r.filePaths[0]; }
    const r = await importPet(file); if (r.ok) toPet('pet:cfg', fullCfg()); return r;
  });
  ipcMain.handle('pet:importFolder', async () => {
    const r = await ctx.dialog.showOpenDialog(ctx.getWin(), { title: 'Import a pet folder (contains pet.json)', properties: ['openDirectory'] }); if (r.canceled) return { ok: false, canceled: true };
    const x = await importPet(r.filePaths[0]); if (x.ok) toPet('pet:cfg', fullCfg()); return x;
  });
  ipcMain.handle('pet:remove', (_e, id) => {
    const p = listPets().find((x) => x.id === id); if (!p || p.builtin) return false;
    fs.rmSync(p.dir, { recursive: true, force: true }); toPet('pet:cfg', fullCfg()); return true;
  });
  ipcMain.handle('pet:folder', () => { fs.mkdirSync(userPets(), { recursive: true }); ctx.shell.openPath(userPets()); return true; });
  // renderer (IDE) -> pet
  ipcMain.on('pet:state', (_e, s) => { lastState = { ...lastState, ...s }; toPet('pet:state', s); });
  ipcMain.on('pet:event', (_e, ev) => toPet('pet:event', ev));
  ipcMain.handle('pet:show', (_e, o) => { createPet(); if (petWin) { petWin.showInactive(); toPet('pet:open', o || {}); } return true; });
  // pet -> main / IDE
  ipcMain.handle('pet:ready', () => ({ cfg: fullCfg(), state: lastState, bounds: petBounds(), wa: petWin ? ctx.screen.getDisplayMatching(petBounds()).workArea : null }));
  ipcMain.handle('pet:bounds', () => { const b = petBounds(); return b ? { b, wa: ctx.screen.getDisplayMatching(b).workArea, displays: ctx.screen.getAllDisplays().map((d) => d.workArea) } : null; });
  ipcMain.on('pet:move', (_e, { x, y }) => { if (petWin && !petWin.isDestroyed()) petWin.setBounds({ x: Math.round(x), y: Math.round(y), width: petSize.w, height: petSize.h }); });
  ipcMain.on('pet:savePos', () => savePos());
  ipcMain.on('pet:interactive', (_e, on) => { if (petWin && !petWin.isDestroyed()) petWin.setIgnoreMouseEvents(!on, { forward: true }); });
  ipcMain.handle('pet:resize', (_e, { width, height }) => {   // keep the pet itself (bottom centre) where it is
    if (!petWin || petWin.isDestroyed()) return null; const o = petWin.getBounds();
    const b = clampToDisplay({ x: o.x + Math.round((o.width - width) / 2), y: o.y + (o.height - height), width, height });
    petWin.setBounds(b); petSize = { w: b.width, h: b.height }; return b;
  });
  ipcMain.handle('pet:focusInput', () => { if (petWin && !petWin.isDestroyed()) { petWin.setFocusable(true); petWin.focus(); } return true; });
  ipcMain.handle('pet:cmd', (_e, o) => { ctx.sendToIde('pet:cmd', o); if (o && (o.fn === 'open')) ctx.showMain(); return true; });
  ipcMain.handle('pet:revoke', () => { ctx.pc.revoke(); return true; });
  ipcMain.handle('pet:hide', () => { if (petWin) petWin.hide(); return true; });
  ipcMain.handle('pet:openIde', () => { ctx.showMain(); return true; });
  ipcMain.handle('pet:quit', () => { quitting = true; ctx.app.quit(); return true; });
  ctx.app.on('before-quit', () => { quitting = true; savePos(); });
}

// test harness: run code inside the pet window, then save a screenshot of it (transparent PNG)
async function testCapture(file, code, wait) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); await sleep(400);
  if (!petWin || petWin.isDestroyed()) { console.log('no pet window'); return; }
  if (code) { const rv = await petWin.webContents.executeJavaScript(code.startsWith('@') ? fs.readFileSync(code.slice(1), 'utf8') : code); console.log('pet eval:', rv); }
  if (process.env.REVA_TEST_CURSOR) { let n = 0; for (const pt of process.env.REVA_TEST_CURSOR.split(';')) { const [cx, cy] = pt.split(',').map(Number); ctx.pc.bus.emit('cursor', { x: cx, y: cy, action: 'click', label: 'Click ' + (++n) }); await sleep(1100); ctx.pc.bus.emit('cursor', { ripple: true }); await sleep(250); let k = 0; for (const o of curWins.values()) { if (o.win.isDestroyed() || !o.win.isVisible()) continue; const b = o.win.getBounds(); console.log('overlay', JSON.stringify(b)); fs.writeFileSync(file + '.cursor' + n + '-' + (++k) + '.png', (await o.win.webContents.capturePage()).toPNG()); } } }
  await sleep(wait); const img = await petWin.webContents.capturePage(); fs.writeFileSync(file, img.toPNG()); console.log('pet bounds', JSON.stringify(petWin.getBounds()));
}

module.exports = { testCapture, register, apply, keepRunning, onMainHidden, isQuitting: () => quitting, setQuitting: (v) => { quitting = v; }, destroy: () => { destroyPet(); destroyTray(); for (const o of curWins.values()) if (!o.win.isDestroyed()) o.win.destroy(); } };
