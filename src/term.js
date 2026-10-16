// Main-process PTY manager for the integrated terminal (ConPTY via @lydell/node-pty).
//
//   const term = require('./term');
//   term.register({ ipcMain, send, app });   // once, after app is ready (or at load)
//   term.killAll();                          // on quit
//
// IPC (all ipcMain.handle, renderer -> main):
//   pty:shells                          -> [{id,label,exe,args,kind}]
//   pty:create({id,cwd,shell,cols,rows,env}) -> {ok,pid,shell,cwd} | {ok:false,error}
//   pty:write({id,data})                -> bool
//   pty:resize({id,cols,rows})          -> bool
//   pty:kill(id)                        -> bool
//   pty:cwd(id)                         -> string|null   (best effort)
//   pty:attach(id)                      -> {alive,buffer,code,cwd}|null  (replay after renderer reload)
//   pty:list                            -> [{id,pid,alive,shell,cwd}]
// Events (main -> renderer, through send()):
//   pty:data {id,data}      pty:exit {id,code}
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let pty = null;
function loadPty() {
  if (pty) return pty;
  pty = require('@lydell/node-pty');
  return pty;
}

const sessions = new Map(); // id -> session
const FLUSH_MS = 8;          // batch pty output into one IPC message per ~8ms
const MAX_CHUNK = 256 * 1024; // flush immediately if a batch gets this large
const REPLAY_MAX = 512 * 1024; // chars of scrollback kept for renderer reload

// ---------------------------------------------------------------- shell discovery
const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

function whereExe(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) { if (!d) continue; const p = path.join(d, name); if (exists(p)) return p; }
  return null;
}

function listWslDistros() {
  return new Promise((resolve) => {
    const wsl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
    if (!exists(wsl)) return resolve([]);
    // `wsl -l -q` prints UTF-16LE; Buffer encoding avoids mojibake.
    execFile(wsl, ['-l', '-q'], { encoding: 'buffer', timeout: 4000, windowsHide: true }, (err, out) => {
      if (err || !out) return resolve([]);
      let s = out.toString('utf16le');
      if (s.includes('\u0000') || !/[A-Za-z]/.test(s)) s = out.toString('utf8').replace(/\u0000/g, '');
      const names = s.replace(/\ufeff/g, '').split(/\r?\n/).map((x) => x.replace(/\u0000/g, '').trim()).filter(Boolean)
        .filter((n) => !/^docker-desktop(-data)?$/i.test(n));
      resolve(names.map((n) => ({ id: 'wsl:' + n, label: n, exe: wsl, args: ['-d', n], kind: 'wsl' })));
    });
  });
}

let shellCache = null, shellCacheAt = 0;
async function detectShells(force) {
  if (!force && shellCache && Date.now() - shellCacheAt < 60000) return shellCache;
  const sysroot = process.env.SystemRoot || 'C:\\Windows';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const out = [];

  const ps5 = path.join(sysroot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  out.push({ id: 'powershell', label: 'Windows PowerShell', exe: exists(ps5) ? ps5 : 'powershell.exe', args: [], kind: 'powershell' });

  // PowerShell 7: PATH, Program Files (msi), winget/Store alias
  let pwsh = whereExe('pwsh.exe');
  if (!pwsh) {
    const cands = [path.join(pf, 'PowerShell', '7', 'pwsh.exe'), path.join(pf, 'PowerShell', '7-preview', 'pwsh.exe'),
      path.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'), path.join(local, 'Programs', 'PowerShell', '7', 'pwsh.exe')];
    pwsh = cands.find(exists) || null;
  }
  if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', exe: pwsh, args: [], kind: 'powershell' });

  const cmd = path.join(sysroot, 'System32', 'cmd.exe');
  out.push({ id: 'cmd', label: 'Command Prompt', exe: exists(cmd) ? cmd : 'cmd.exe', args: [], kind: 'cmd' });

  // Git Bash
  const gitCands = [path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(pf86, 'Git', 'bin', 'bash.exe'), path.join(local, 'Programs', 'Git', 'bin', 'bash.exe')];
  const gitBash = gitCands.find(exists);
  if (gitBash) out.push({ id: 'gitbash', label: 'Git Bash', exe: gitBash, args: ['--login', '-i'], kind: 'bash' });

  // Developer PowerShell for Visual Studio (via vswhere), best effort
  try {
    const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (exists(vswhere)) {
      const vs = await new Promise((resolve) => execFile(vswhere, ['-latest', '-property', 'installationPath'], { timeout: 4000, windowsHide: true }, (e, so) => resolve(e ? '' : String(so).trim())));
      const dll = vs && path.join(vs, 'Common7', 'Tools', 'Microsoft.VisualStudio.DevShell.dll');
      if (dll && exists(dll)) {
        const q = (s) => s.replace(/'/g, "''");
        out.push({
          id: 'devps', label: 'Developer PowerShell', kind: 'powershell', exe: ps5,
          args: ['-NoExit', '-Command', `& { Import-Module '${q(dll)}'; Enter-VsDevShell -VsInstallPath '${q(vs)}' -SkipAutomaticLocation }`],
        });
      }
    }
  } catch { /* ignore */ }

  out.push(...await listWslDistros());
  shellCache = out; shellCacheAt = Date.now();
  return out;
}

// ---------------------------------------------------------------- sessions
function strEnv(extra) {
  const e = { ...process.env, ...(extra || {}) };
  delete e.ELECTRON_RUN_AS_NODE; // would turn child Electron-based tools into plain node
  e.TERM_PROGRAM = 'hyper-ide';
  e.COLORTERM = 'truecolor';
  e.TERM = 'xterm-256color';
  for (const k of Object.keys(e)) if (e[k] == null) delete e[k]; else e[k] = String(e[k]);
  return e;
}

// Pull OSC 7 (file://host/path) and OSC 9;9 (ConEmu/Windows Terminal cwd) out of the stream.
function trackCwd(s, chunk) {
  const re = /\x1b\](?:9;9;"?([^\x07\x1b"]+)"?|7;file:\/\/[^/]*\/([^\x07\x1b]+))(?:\x07|\x1b\\)/g;
  let m;
  while ((m = re.exec(chunk))) {
    if (m[1]) s.cwd = m[1];
    else if (m[2]) { try { s.cwd = decodeURIComponent(m[2]).replace(/\//g, '\\'); } catch { /* ignore */ } }
  }
}

function destroy(id) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  s.dead = true;
  try { s.proc.kill(); } catch { /* already gone */ }
  sessions.delete(id);
}

async function create(send, opts) {
  const { id, cwd, shell: shellId, cols, rows, env } = opts || {};
  if (!id) return { ok: false, error: 'missing id' };
  if (sessions.has(id)) destroy(id);
  let lib;
  try { lib = loadPty(); } catch (e) { return { ok: false, error: 'node-pty failed to load: ' + e.message }; }

  const shells = await detectShells();
  const sh = shells.find((x) => x.id === shellId) || shells[0];
  const dir = exists(cwd) ? cwd : os.homedir();
  const nc = Math.max(2, cols | 0 || 80), nr = Math.max(1, rows | 0 || 24);

  let proc;
  try {
    proc = lib.spawn(sh.exe, sh.args, {
      name: 'xterm-256color', cols: nc, rows: nr, cwd: dir, env: strEnv(env),
      useConpty: true,
    });
  } catch (e) { return { ok: false, error: `Could not start ${sh.label}: ${e.message}` }; }

  const s = { id, proc, shell: sh.id, cwd: dir, pending: '', timer: null, replay: '', dead: false, code: null };
  sessions.set(id, s);

  const flush = () => {
    s.timer = null;
    if (!s.pending) return;
    const data = s.pending; s.pending = '';
    send('pty:data', { id, data });
  };
  proc.onData((d) => {
    if (s.dead) return;
    trackCwd(s, d);
    s.replay += d;
    if (s.replay.length > REPLAY_MAX) s.replay = s.replay.slice(s.replay.length - REPLAY_MAX * 0.75);
    s.pending += d;
    if (s.pending.length >= MAX_CHUNK) { clearTimeout(s.timer); flush(); }
    else if (!s.timer) s.timer = setTimeout(flush, FLUSH_MS);
  });
  proc.onExit(({ exitCode }) => {
    if (s.dead) return;
    clearTimeout(s.timer); flush();
    s.code = exitCode == null ? 0 : exitCode;
    s.exited = true;
    send('pty:exit', { id, code: s.code });
    // keep the record (small) so pty:attach can report the exit after a reload
    s.proc = { kill() { }, write() { }, resize() { } };
  });
  return { ok: true, pid: proc.pid, shell: sh.id, cwd: dir, label: sh.label, kind: sh.kind };
}

function register({ ipcMain, send }) {
  const H = (ch, fn) => { try { ipcMain.removeHandler(ch); } catch { /* none */ } ipcMain.handle(ch, fn); };
  H('pty:shells', (_e, force) => detectShells(!!force));
  H('pty:create', (_e, opts) => create(send, opts));
  H('pty:write', (_e, { id, data }) => { const s = sessions.get(id); if (!s || s.exited) return false; try { s.proc.write(data); return true; } catch { return false; } });
  H('pty:resize', (_e, { id, cols, rows }) => {
    const s = sessions.get(id); if (!s || s.exited) return false;
    try { s.proc.resize(Math.max(2, cols | 0), Math.max(1, rows | 0)); return true; } catch { return false; }
  });
  H('pty:kill', (_e, id) => { destroy(id); return true; });
  H('pty:cwd', (_e, id) => { const s = sessions.get(id); return s ? s.cwd : null; });
  H('pty:attach', (_e, id) => {
    const s = sessions.get(id); if (!s) return null;
    return { alive: !s.exited, buffer: s.replay, code: s.code, cwd: s.cwd, shell: s.shell };
  });
  H('pty:list', () => [...sessions.values()].map((s) => ({ id: s.id, pid: s.proc.pid, alive: !s.exited, shell: s.shell, cwd: s.cwd })));
}

function killAll() { for (const id of [...sessions.keys()]) destroy(id); }

module.exports = { register, killAll, shells: detectShells };
