// Agent CLI detector / installer (Windows). Dependency-free (Node built-ins only).
//
//   detect(custom)            -> environment + provider report (never throws)
//   install(provider, opts)   -> Promise<{ok, out, needs?}>   provider: node|claude|codex|opencode
//   commandFor(provider)      -> string[] human-readable commands (primary first)
//   resolveNode()             -> { cmd, version } | null
//   freshPath()               -> PATH rebuilt from the registry (Machine+User) merged with process PATH
//
// Shared helpers (findOnPath, unwrapShim, exec, killTree) are exported too so agents/opencode.js can reuse them.
'use strict';
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

// ---------------------------------------------------------------- PATH handling
let _pathCache = { t: 0, v: '' };

function expandEnv(s) {
  return s.replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? process.env[k.toUpperCase()] ?? m);
}
function regPath(hive) {
  const key = hive === 'M' ? 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' : 'HKCU\\Environment';
  try {
    const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im);
    return m ? expandEnv(m[1].trim()) : '';
  } catch { return ''; }
}

// PATH as a freshly-started shell would see it: registry Machine + User, then whatever the host process
// had (deduped, case-insensitive), plus the well-known per-user bin dirs. Cached for 5s.
function freshPath() {
  if (!IS_WIN) return process.env.PATH || '';
  const now = Date.now();
  if (_pathCache.v && now - _pathCache.t < 5000) return _pathCache.v;
  const parts = [
    ...regPath('M').split(';'), ...regPath('U').split(';'),
    ...(process.env.Path || process.env.PATH || '').split(';'),
    path.join(APPDATA, 'npm'), path.join(HOME, '.local', 'bin'),
  ];
  const seen = new Set(); const out = [];
  for (const p of parts) {
    const t = p.trim().replace(/[\\/]+$/, '');
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
  }
  _pathCache = { t: now, v: out.join(';') };
  return _pathCache.v;
}
function freshEnv(extra) {
  const p = freshPath();
  return { ...process.env, Path: p, PATH: p, NO_COLOR: '1', ...(extra || {}) };
}

// First existing `<name><ext>` on the fresh PATH (extensions in PATHEXT order, exe before cmd).
function findOnPath(name, exts = ['.exe', '.cmd', '.bat']) {
  const dirs = freshPath().split(';').filter(Boolean);
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, name + e);
    // lstat, not stat: winget.exe is an App Execution Alias (reparse point) that stat() rejects with EACCES
    try { const st = fs.lstatSync(f); if (st.isFile() || st.isSymbolicLink()) return f; } catch { /* next */ }
  }
  return null;
}

// npm .cmd shims usually end in `"%dp0%\...\something.exe" %*`. Resolve to the real exe so we can spawn it
// without cmd.exe (no quoting/injection problems, no console flash). Returns null if not unwrappable.
function unwrapShim(cmdPath) {
  try {
    const txt = fs.readFileSync(cmdPath, 'utf8');
    const m = txt.match(/"%~?dp0%?\\([^"]+?\.exe)"/i);
    if (m) { const f = path.join(path.dirname(cmdPath), m[1]); if (fs.existsSync(f)) return f; }
  } catch { /* ignore */ }
  return null;
}

// Turn a resolved binary path into a spawn target { cmd, shell }.
function targetFor(file) {
  if (!file) return null;
  if (/\.(cmd|bat)$/i.test(file)) {
    const real = unwrapShim(file);
    if (real) return { cmd: real, shell: false, shim: file };
    return { cmd: file, shell: true };
  }
  return { cmd: file, shell: false };
}

// cmd.exe argument quoting (only used for the .cmd fallback; arguments with newlines are flattened).
function quoteCmd(a) {
  a = String(a).replace(/\r?\n/g, ' ');
  if (/^[\w@.,:=+\\/-]+$/.test(a)) return a;
  return '"' + a.replace(/%/g, '%%').replace(/"/g, '""') + '"';
}

// Spawn a target and collect output. opts: {timeout, cwd, input, env, onLine(line, isErr)}
// Resolves {code, out, err, timedOut, error}; never rejects.
function exec(target, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timedOut = false, child, timer;
    const finish = (code, error) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code, out, err, timedOut, error: error ? String(error.message || error) : undefined });
    };
    try {
      const o = { cwd: opts.cwd, env: opts.env || freshEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
      if (target.shell) child = spawn('"' + target.cmd + '" ' + args.map(quoteCmd).join(' '), [], { ...o, shell: true });
      else child = spawn(target.cmd, args, o);
    } catch (e) { return finish(-1, e); }
    const lines = { o: '', e: '' };
    const feed = (k, chunk) => {
      if (!opts.onLine) return;
      lines[k] += chunk;
      let i;
      while ((i = lines[k].indexOf('\n')) >= 0) { opts.onLine(lines[k].slice(0, i).replace(/\r$/, ''), k === 'e'); lines[k] = lines[k].slice(i + 1); }
    };
    child.stdout.on('data', (d) => { const s = d.toString('utf8'); out += s; feed('o', s); });
    child.stderr.on('data', (d) => { const s = d.toString('utf8'); err += s; feed('e', s); });
    child.on('error', (e) => finish(-1, e));
    child.on('close', (code) => {
      if (opts.onLine) { if (lines.o) opts.onLine(lines.o, false); if (lines.e) opts.onLine(lines.e, true); }
      finish(code);
    });
    child.stdin.on('error', () => { });
    try { child.stdin.end(opts.input != null ? opts.input : undefined); } catch { /* ignore */ }
    if (opts.timeout) timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeout);
  });
}

// Kill a process and all its children.
function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) { try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => { }); } catch { /* ignore */ } }
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } } }
}

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const firstVersion = (s) => { const m = stripAnsi(s).match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/); return m ? m[0] : stripAnsi(s).trim().split('\n')[0] || null; };

// Run `<file> --version`-style probes through targetFor().
async function probe(file, args, timeout = 15000) {
  const t = targetFor(file);
  if (!t) return null;
  return exec(t, args, { timeout });
}

// ---------------------------------------------------------------- detection
function customPaths(custom) {
  if (!custom) return {};
  if (typeof custom === 'string') return { claude: custom };
  return custom;
}
const okFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };

async function detectNode() {
  const file = findOnPath('node');
  if (!file) return { installed: false, version: null, path: null };
  const r = await probe(file, ['-v']);
  return { installed: !!(r && r.code === 0), version: r ? firstVersion(r.out) : null, path: file };
}
async function detectNpm() {
  const file = findOnPath('npm', ['.cmd', '.exe', '.bat']);
  if (!file) return { installed: false, version: null, path: null };
  const r = await probe(file, ['-v']);
  return { installed: !!(r && r.code === 0), version: r ? firstVersion(r.out) : null, path: file };
}
async function detectSimple(name, args) {
  const file = findOnPath(name);
  if (!file) return { installed: false, version: null, path: null };
  const r = await probe(file, args);
  return { installed: !!(r && r.code === 0), version: r ? firstVersion(r.out) : null, path: file };
}

function claudeBinary(custom) {
  const c = customPaths(custom).claude;
  if (okFile(c)) return c;
  const home = path.join(HOME, '.local', 'bin', 'claude.exe');
  if (okFile(home)) return home;
  return findOnPath('claude');
}
async function detectClaude(custom) {
  const file = claudeBinary(custom);
  if (!file) return { installed: false, version: null, path: null, loggedIn: false };
  const [v, a] = await Promise.all([probe(file, ['--version']), probe(file, ['auth', 'status'])]);
  let loggedIn = false;
  try { const j = JSON.parse(a.out); loggedIn = !!(j.loggedIn ?? j.logged_in); } catch { /* not JSON */ }
  return { installed: true, version: v ? firstVersion(v.out) : null, path: file, loggedIn };
}

function codexBinary(custom) {
  const c = customPaths(custom).codex;
  if (okFile(c)) return c;
  const onPath = findOnPath('codex', ['.cmd', '.exe', '.bat']);
  if (onPath) return onPath;
  // winget package dir: %LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenAI.Codex_*\codex*.exe
  try {
    const base = path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    for (const d of fs.readdirSync(base)) {
      if (!/^OpenAI\.Codex_/i.test(d)) continue;
      const dir = path.join(base, d);
      const exe = fs.readdirSync(dir).find((f) => /^codex.*\.exe$/i.test(f));
      if (exe) return path.join(dir, exe);
    }
  } catch { /* none */ }
  return null;
}
async function detectCodex(custom) {
  const file = codexBinary(custom);
  if (!file) return { installed: false, version: null, path: null, loggedIn: false };
  const v = await probe(file, ['--version']);
  return { installed: true, version: v ? firstVersion(v.out) : null, path: file, loggedIn: okFile(path.join(HOME, '.codex', 'auth.json')) };
}

function opencodeBinary(custom) {
  const c = customPaths(custom).opencode;
  if (okFile(c)) return c;
  return findOnPath('opencode', ['.cmd', '.exe', '.bat']) || (okFile(path.join(APPDATA, 'npm', 'opencode.cmd')) ? path.join(APPDATA, 'npm', 'opencode.cmd') : null);
}
// Credentials opencode stores itself (fallback when `auth list` output can't be parsed).
function opencodeAuthFileProviders() {
  const files = [path.join(HOME, '.local', 'share', 'opencode', 'auth.json'), path.join(LOCALAPPDATA, 'opencode', 'auth.json'), path.join(APPDATA, 'opencode', 'auth.json')];
  for (const f of files) {
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Object.keys(j); } catch { /* next */ }
  }
  return [];
}
async function detectOpencode(custom) {
  const file = opencodeBinary(custom);
  if (!file) return { installed: false, version: null, path: null, loggedIn: false, freeModels: false };
  const [v, auth, models] = await Promise.all([probe(file, ['--version']), probe(file, ['auth', 'list']), probe(file, ['models'])]);
  const txt = stripAnsi(auth && auth.out);
  const hasCreds = (txt.trim() && !/no authenticated/i.test(txt)) || opencodeAuthFileProviders().length > 0;
  const freeModels = !!(models && models.code === 0 && /^opencode\//m.test(models.out));
  return { installed: true, version: v ? firstVersion(v.out) : null, path: file, loggedIn: !!hasCreds, freeModels };
}

async function detect(custom) {
  const safe = (p, d) => p.catch(() => d);
  const none = { installed: false, version: null, path: null };
  const [node, npm, winget, git, claude, codex, opencode] = await Promise.all([
    safe(detectNode(), none), safe(detectNpm(), none),
    safe(detectSimple('winget', ['--version']), none), safe(detectSimple('git', ['--version']), none),
    safe(detectClaude(custom), { ...none, loggedIn: false }),
    safe(detectCodex(custom), { ...none, loggedIn: false }),
    safe(detectOpencode(custom), { ...none, loggedIn: false, freeModels: false }),
  ]);
  return {
    node, npm, winget: { installed: winget.installed, version: winget.version }, git: { installed: git.installed, version: git.version },
    providers: { claude, codex, opencode },
  };
}

// node executable (for callers that want to run scripts with the system node) -> {cmd, version} | null
function resolveNode() {
  const file = findOnPath('node');
  if (!file) return null;
  let version = null;
  try { version = firstVersion(execFileSync(file, ['-v'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: freshEnv() })); } catch { /* ignore */ }
  return { cmd: file, version };
}

// ---------------------------------------------------------------- installation
const WINGET_FLAGS = ['-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];
const PS_CLAUDE = 'irm https://claude.ai/install.ps1 | iex';

// Human-readable command(s) per provider, primary first.
function commandFor(provider) {
  switch (provider) {
    case 'node': return ['winget install --id OpenJS.NodeJS.LTS ' + WINGET_FLAGS.join(' ')];
    case 'claude': return ['powershell -NoProfile -Command "' + PS_CLAUDE + '"', 'npm install -g @anthropic-ai/claude-code'];
    case 'codex': return ['npm install -g @openai/codex', 'winget install --id OpenAI.Codex ' + WINGET_FLAGS.join(' ')];
    case 'opencode': return ['npm install -g opencode-ai'];
    default: return [];
  }
}

// Build one step: {label, target, args}. Steps resolve their binary lazily on the fresh PATH.
function step(label, name, args, exts) {
  return { label, name, args, exts };
}

// install(provider, {onLog, custom, dryRun}) -> {ok, out, needs?}
async function install(provider, opts = {}) {
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => { };
  let out = '';
  const emit = (line) => { out += line + '\n'; try { log(line); } catch { /* ignore */ } };
  _pathCache = { t: 0, v: '' }; // always re-read the registry PATH before deciding anything
  try {
    if (!['node', 'claude', 'codex', 'opencode'].includes(provider)) return { ok: false, out: 'Unknown provider: ' + provider };
    const hasNpm = !!findOnPath('npm', ['.cmd', '.exe', '.bat']);
    const hasNode = !!findOnPath('node');
    const hasWinget = !!findOnPath('winget');

    // Requirements
    if (provider === 'opencode' && !(hasNode && hasNpm)) return { ok: false, out: 'OpenCode needs Node.js (npm).', needs: ['node'] };

    // Plan: ordered fallback list of steps (first success wins)
    let plan = [];
    const npmStep = (pkg) => step('npm install -g ' + pkg, 'npm', ['install', '-g', pkg], ['.cmd', '.exe', '.bat']);
    const wingetStep = (id) => step('winget install --id ' + id, 'winget', ['install', '--id', id, ...WINGET_FLAGS]);
    if (provider === 'node') {
      if (!hasWinget && !opts.dryRun) return { ok: false, out: 'winget is not available; install Node.js from https://nodejs.org', needs: ['winget'] };
      plan = [wingetStep('OpenJS.NodeJS.LTS')];
    } else if (provider === 'claude') {
      plan = [step('powershell -NoProfile -Command "' + PS_CLAUDE + '"', 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_CLAUDE])];
      if (hasNpm) plan.push(npmStep('@anthropic-ai/claude-code'));
    } else if (provider === 'codex') {
      if (hasNpm) plan.push(npmStep('@openai/codex'));
      if (hasWinget) plan.push(wingetStep('OpenAI.Codex'));
      if (!plan.length) {
        if (opts.dryRun) plan = [npmStep('@openai/codex')];
        else return { ok: false, out: 'Codex needs npm (Node.js) or winget.', needs: ['node'] };
      }
    } else if (provider === 'opencode') plan = [npmStep('opencode-ai')];

    for (const s of plan) {
      emit('> ' + s.label);
      if (opts.dryRun) { emit('(dry run: not executed)'); return { ok: true, out, dryRun: true }; }
      const file = findOnPath(s.name, s.exts);
      if (!file) { emit(s.name + ' not found on PATH'); continue; }
      const r = await exec(targetFor(file), s.args, {
        timeout: 15 * 60 * 1000, env: freshEnv(), onLine: (l) => { if (l.trim()) emit(stripAnsi(l)); },
      });
      if (r.timedOut) { emit('Timed out.'); continue; }
      if (r.error) emit(r.error);
      // winget returns 0x8A15002B (no upgrade) etc. when already installed: treat "already installed" as success
      const already = /already installed|no available upgrade|no newer package/i.test(r.out + r.err);
      if (r.code === 0 || already) {
        _pathCache = { t: 0, v: '' };
        emit('Done.');
        return { ok: true, out };
      }
      emit('Exited with code ' + r.code);
    }
    return { ok: false, out };
  } catch (e) {
    emit('Error: ' + (e && e.message || e));
    return { ok: false, out };
  }
}

module.exports = {
  detect, install, resolveNode, commandFor, freshPath,
  // shared helpers
  freshEnv, findOnPath, targetFor, unwrapShim, exec, killTree, stripAnsi, firstVersion, opencodeAuthFileProviders,
};
