// PC control for agents (Windows UI Automation, no screenshots).
//
// A long-lived PowerShell worker (src/pc/worker.ps1) answers one JSON command per line. Every tool call goes through a
// permission gate first: a native dialog asks the user (allow once / allow for this session / deny). "View" actions
// (list windows, read controls) and "control" actions (click, type, keys, launch) are separate grants, and the user can
// revoke everything at any time (pet toolbar, tray, Settings).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

const bus = new EventEmitter();
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
const WIN = { type: 'string', description: 'Window title fragment, process name, or pid. Omit for the foreground window.' };
const REF = { type: 'string', description: 'Element ref (e.g. "e12") from the latest pc_snapshot.' };
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const act = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const PC_TOOLS = [
  { name: 'pc_windows', title: 'List windows', annotations: ro, inputSchema: obj({}),
    description: 'Lists the screens (monitors, with their size and position in virtual-desktop pixels) and the top-level windows on the user\'s PC (title, process, size, position; "*" marks the foreground one; windows that are minimized to the taskbar are listed too and marked [MINIMIZED]). ALWAYS call it before launching something, so you notice that the app is already open (maybe minimized) and bring it to the front with pc_focus instead of starting another copy. The user is asked for permission the first time. Start here to find the app you need to test.' },
  { name: 'pc_snapshot', title: 'Read a window\'s controls', annotations: ro,
    description: 'Returns the controls of a window as text, NOT a screenshot: type, name, automation id, value/state and screen position, each with a ref (e1, e2, ...) that pc_click / pc_type / pc_read accept. Refs are replaced by every snapshot. Prefer this over screenshots: it is exact, cheap and works for most Windows apps (WinForms, WPF, UWP, Win32, Electron/Chromium with accessibility). Apps that draw their own UI (games, some custom engines) expose little.',
    inputSchema: obj({ window: WIN, depth: { type: 'integer', minimum: 1, maximum: 30, description: 'How deep to walk the tree (default 14).' }, max: { type: 'integer', minimum: 10, maximum: 1000, description: 'Max elements (default 300).' }, all: { type: 'boolean', description: 'Include structural/unnamed containers too (default false).' } }) },
  { name: 'pc_click', title: 'Click', annotations: act,
    description: 'Clicks a control. With `ref`, uses the control\'s own invoke/select/toggle action when it has one and otherwise taps its centre. Or click raw screen coordinates x,y (from a screenshot). IMPORTANT: this never uses the user\'s mouse: the AI has its own visible cursor, and taps are injected as touch input so the user\'s pointer stays where it is (right click = long press; middle click is not available). Asks the user for permission (once per action, or for the whole session if they allow it).',
    inputSchema: obj({ ref: REF, x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' }, physical: { type: 'boolean', description: 'Skip the control\'s own invoke action and always tap its position.' } }) },
  { name: 'pc_type', title: 'Type text', annotations: act,
    description: 'Types text into a control (with `ref`: focuses it first; `replace: true` replaces the existing content) or into whatever has focus. `enter: true` presses Enter afterwards. Uses real keystrokes, so it works in any app and with any characters.',
    inputSchema: obj({ text: { type: 'string' }, ref: REF, replace: { type: 'boolean' }, enter: { type: 'boolean' } }, ['text']) },
  { name: 'pc_key', title: 'Press keys', annotations: act,
    description: 'Presses a key or shortcut, e.g. "enter", "ctrl+s", "alt+f4", "ctrl+shift+t", "f5", "win+d". Goes to the foreground window, so use pc_focus first when needed.',
    inputSchema: obj({ keys: { type: 'string' } }, ['keys']) },
  { name: 'pc_screenshot', title: 'Screenshot of the desktop', annotations: ro,
    description: 'Takes a screenshot of one screen (default: the one with the active window; the user may have several monitors, pc_windows lists them), or one window, or all screens and returns it as an image so you can SEE the desktop, including apps that expose no controls (games, custom-drawn UIs). The reply tells you how image pixels map to screen pixels: screen x = X0 + image_x / scale, screen y = Y0 + image_y / scale; pass those screen coordinates to pc_click / pc_move. Prefer pc_snapshot (exact text) when the app has accessible controls. The user is asked for permission the first time.',
    inputSchema: obj({ window: WIN, monitor: { type: 'string', description: 'Which screen when no window is given: \"active\" (default: the screen with the active window), \"main\", \"all\", or a screen number from pc_windows (1, 2, ...).' }, max_width: { type: 'integer', minimum: 400, maximum: 3000, description: 'Downscale to this width (default 1568).' } }) },
  { name: 'pc_move', title: 'Move the mouse', annotations: act,
    description: 'Moves the AI\'s own cursor (visible to the user) to a control or screen coordinates, e.g. to point at something. It does not move the user\'s mouse, so hover-only effects are not triggered.',
    inputSchema: obj({ ref: REF, x: { type: 'integer' }, y: { type: 'integer' } }) },  { name: 'pc_focus', title: 'Focus a window', annotations: act,
    description: 'Brings a window to the foreground and restores it if it is minimized in the taskbar. Use this when the app is already open.', inputSchema: obj({ window: WIN }) },
  { name: 'pc_scroll', title: 'Scroll', annotations: act,
    description: 'Scrolls with the mouse wheel over a control (`ref`) or the current mouse position.',
    inputSchema: obj({ direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'integer', minimum: 1, maximum: 50, description: 'Wheel notches (default 3).' }, ref: REF }, ['direction']) },
  { name: 'pc_drag', title: 'Drag', annotations: act,
    description: 'Drags the mouse from screen position (x1,y1) to (x2,y2) with the left button held.',
    inputSchema: obj({ x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' } }, ['x1', 'y1', 'x2', 'y2']) },
  { name: 'pc_read', title: 'Read a control', annotations: ro,
    description: 'Returns the full text/value of a control from the latest snapshot (e.g. the content of a text box, document or label).', inputSchema: obj({ ref: REF }, ['ref']) },
  { name: 'pc_launch', title: 'Launch a program', annotations: act,
    description: 'Starts a program or opens a file/URL with its default app (e.g. "notepad.exe", "C:\\\\path\\\\app.exe", "https://example.com"). If a window of that program is already open (even minimized in the taskbar) it is restored and focused instead of starting a second copy, unless new_instance is true. Use this instead of typing commands into Win+R or a terminal. Asks the user for permission.',
    inputSchema: obj({ target: { type: 'string' }, args: { type: 'string', description: 'Optional command-line arguments.' }, new_instance: { type: 'boolean', description: 'Start another copy even if one is open.' } }, ['target']) },
  { name: 'pc_wait', title: 'Wait', annotations: ro,
    description: 'Waits `ms` milliseconds, or (with `text`) until a window whose title contains that text appears (up to `timeout` seconds).',
    inputSchema: obj({ ms: { type: 'integer', minimum: 0, maximum: 30000 }, text: { type: 'string' }, timeout: { type: 'integer', minimum: 1, maximum: 60 } }) },
];
const PC_NAMES = PC_TOOLS.map((t) => t.name);
const OP = { pc_windows: 'windows', pc_snapshot: 'snapshot', pc_click: 'click', pc_type: 'type', pc_key: 'key', pc_focus: 'focus', pc_scroll: 'scroll', pc_drag: 'drag', pc_read: 'read', pc_launch: 'launch', pc_wait: 'wait', pc_screenshot: 'screenshot', pc_move: 'move' };
const VIEW = new Set(['pc_windows', 'pc_snapshot', 'pc_read', 'pc_wait', 'pc_screenshot']);

// ---------------------------------------------------------------- worker
let proc = null, buf = '', seq = 0, readyP = null; const pending = new Map();
const scriptPath = () => path.join(__dirname, 'pc', 'worker.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function startWorker() {
  if (readyP) return readyP;
  readyP = new Promise((resolve, reject) => {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdout.setEncoding('utf8'); let up = false;
    const timer = setTimeout(() => { if (!up) { reject(new Error('The PC-control helper did not start')); stop(); } }, 20000);
    proc.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { up = true; clearTimeout(timer); resolve(); continue; }
        const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.t); m.ok ? p.res(m.result) : p.rej(new Error(m.error || 'failed')); }
      }
    });
    proc.stderr.on('data', () => { });
    proc.on('exit', () => { for (const [, p] of pending) { clearTimeout(p.t); p.rej(new Error('The PC-control helper stopped')); } pending.clear(); proc = null; readyP = null; buf = ''; });
    proc.on('error', (e) => { reject(e); proc = null; readyP = null; });
  });
  return readyP;
}
function stop() { try { if (proc) proc.kill(); } catch { } proc = null; readyP = null; }
async function send(op, args, timeoutMs = 40000) {
  await startWorker();
  return new Promise((res, rej) => {
    const id = ++seq; const t = setTimeout(() => { pending.delete(id); rej(new Error('Timed out')); }, timeoutMs);
    pending.set(id, { res, rej, t });
    proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
  });
}

// ---------------------------------------------------------------- permission gate
const grants = { view: false, control: false };
let settingsGet = () => ({}); let askDialog = null; let chain = Promise.resolve(); let autoAllow = false;
const state = () => ({ view: grants.view, control: grants.control });
function revoke() { grants.view = false; grants.control = false; bus.emit('grants', state()); }
function init({ getSettings, ask, autoAllow: aa }) { if (getSettings) settingsGet = getSettings; if (ask) askDialog = ask; autoAllow = !!aa; }

async function describeAction(name, a) {
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; };
  let target = '';
  if (a.ref) { try { target = clip(await send('describe', { ref: a.ref }, 8000), 120); } catch { target = a.ref; } }
  switch (name) {
    case 'pc_click': return (a.double ? 'Double-click ' : a.button === 'right' ? 'Right-click ' : 'Click ') + (target ? target : 'at ' + a.x + ',' + a.y);
    case 'pc_type': return 'Type "' + clip(a.text, 100) + '"' + (target ? ' into ' + target : ' into the focused control') + (a.enter ? ' and press Enter' : '');
    case 'pc_key': return 'Press ' + a.keys;
    case 'pc_move': return 'Move the mouse to ' + (target ? target : a.x + ',' + a.y);
    case 'pc_focus': return 'Bring "' + (a.window || 'the first window') + '" to the front';
    case 'pc_scroll': return 'Scroll ' + a.direction + (target ? ' over ' + target : '');
    case 'pc_drag': return 'Drag the mouse from ' + a.x1 + ',' + a.y1 + ' to ' + a.x2 + ',' + a.y2;
    case 'pc_launch': return 'Start "' + clip(a.target, 160) + '"' + (a.args ? ' ' + clip(a.args, 100) : '');
    default: return name;
  }
}
async function gate(name, a) {
  if (autoAllow) { console.log('[pc] ' + name + ' ' + JSON.stringify(a).slice(0, 160)); return; }   // test harness only (--shot): no dialog
  const s = settingsGet() || {};
  if (s.pcControl === 'off') throw new Error('PC control is turned off. The user can enable it in Reva → Settings → Pet & PC control.');
  const level = VIEW.has(name) ? 'view' : 'control';
  if (level === 'view' ? (grants.view || grants.control) : grants.control) return;
  // one dialog at a time, and re-check after waiting (the user may have just granted the session)
  const run = chain.then(async () => {
    if (level === 'view' ? (grants.view || grants.control) : grants.control) return;
    if (!askDialog) throw new Error('No way to ask the user for permission');
    const detail = level === 'view'
      ? 'An AI agent wants to look at your PC: which windows and apps are open, what is on screen (controls as text, and screenshots of the desktop).'
      : 'An AI agent wants to control your PC:\n\n    ' + await describeAction(name, a) + '\n\nIt will use your mouse and keyboard. You can stop it any time from the pet toolbar or the tray icon.';
    const r = await askDialog({ level, detail, name });
    if (r === 'deny') throw new Error('The user denied this action. Do not retry; ask them how to proceed.');
    if (r === 'session') { grants[level] = true; if (level === 'control') grants.view = true; bus.emit('grants', state()); }
  });
  chain = run.catch(() => { });
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// where on screen an action will happen (physical px), so the AI cursor overlay can glide there first
async function targetOf(name, a) {
  try {
    if (a.ref && ['pc_click', 'pc_type', 'pc_scroll', 'pc_move'].includes(name)) return JSON.parse(await send('locate', { ref: a.ref }, 8000));
    if (a.x != null && a.y != null && ['pc_click', 'pc_move'].includes(name)) return { x: a.x, y: a.y };
    if (name === 'pc_drag') return { x: a.x1, y: a.y1, x2: a.x2, y2: a.y2 };
  } catch { }
  return null;
}
async function fgCenter() { try { return JSON.parse(await send('fgcenter', {}, 8000)); } catch { return null; } }
const GLIDE_MS = 520;
async function call(name, args) {
  const a = args || {};
  await gate(name, a);
  const text0 = VIEW.has(name) ? null : await describeAction(name, a).catch(() => name);
  if (text0) bus.emit('activity', { name, text: text0 });
  const kind = name === 'pc_move' ? 'move' : name === 'pc_type' || name === 'pc_key' ? 'type' : name === 'pc_drag' ? 'drag' : name === 'pc_scroll' ? 'scroll' : name === 'pc_launch' ? 'launch' : name === 'pc_focus' ? 'focus' : (a.double ? 'dblclick' : 'click');
  const after = name === 'pc_launch' || name === 'pc_focus';   // these change which window is in front: point at it afterwards
  if (name === 'pc_screenshot') { bus.emit('cursor', { hide: true }); await sleep(120); }
  else if (VIEW.has(name)) bus.emit('cursor', { show: true, label: name === 'pc_wait' ? 'Waiting…' : 'Looking at your screen' });
  let pos = null;
  if (!VIEW.has(name)) {
    pos = await targetOf(name, a);
    if (!pos && !after) pos = await fgCenter();                       // keys / typing / scrolling: the AI cursor sits on the window it is working in
    if (pos) { bus.emit('cursor', { ...pos, action: kind, label: text0 }); await sleep(GLIDE_MS); }
  }
  const to = name === 'pc_wait' ? 70000 : name === 'pc_launch' ? 30000 : 40000;
  const text = await send(OP[name], a, to);
  if (after) { const c = await fgCenter(); if (c) { bus.emit('cursor', { ...c, action: kind, label: text0 }); await sleep(GLIDE_MS); } }
  if (name === 'pc_screenshot') {
    const r = JSON.parse(text); bus.emit('cursor', { show: true, label: 'Looking at the screen', action: 'look' });
    return { content: [{ type: 'image', data: r.b64, mimeType: 'image/jpeg' }, { type: 'text', text: 'Screenshot of ' + r.what + '. Image ' + r.w + 'x' + r.h + ' px shows screen area X0=' + r.x + ', Y0=' + r.y + ', ' + r.sw + 'x' + r.sh + ' px (scale ' + (+r.scale).toFixed(4) + '). Screen x = ' + r.x + ' + image_x / ' + (+r.scale).toFixed(4) + ', screen y = ' + r.y + ' + image_y / ' + (+r.scale).toFixed(4) + '.' }] };
  }
  if (pos || after) bus.emit('cursor', { ripple: true });
  return { content: [{ type: 'text', text: text || 'OK' }] };
}
module.exports = { PC_TOOLS, PC_NAMES, call, init, revoke, state, stop, bus, VIEW };
