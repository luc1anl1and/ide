// hyper-ide - main process
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, Menu, Tray, nativeImage, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const pc = require('./pc');
const pet = require('./pet');

if (process.argv.includes('--shot')) { const pi = process.argv.indexOf('--profile'); app.setPath('userData', path.join(os.tmpdir(), 'hyper-ide-shot' + (pi > 0 ? '-' + process.argv[pi + 1] : ''))); }
// The app data folder is "hyper-ide" (migrate from "Reva" or "amethyst" if present)
if (!process.argv.includes('--shot')) {
  try {
    const appData = app.getPath('appData');
    const newDir = path.join(appData, 'hyper-ide');
    const oldDirs = [path.join(appData, 'Reva'), path.join(appData, 'amethyst')];
    app.setPath('userData', newDir);
    for (const oldDir of oldDirs) {
      if (fs.existsSync(oldDir) && !fs.existsSync(path.join(newDir, 'settings.json'))) {
        fs.mkdirSync(newDir, { recursive: true });
        for (const n of ['settings.json', 'keys.json', 'logo.png', 'chats', 'models', 'backups']) {
          const from = path.join(oldDir, n);
          if (fs.existsSync(from)) fs.cpSync(from, path.join(newDir, n), { recursive: true, force: false });
        }
        break;
      }
    }
  } catch { /* first run on a fresh machine */ }
}
app.setAppUserModelId('com.hyperide.ide');
if (!app.requestSingleInstanceLock() && !process.argv.includes('--shot')) app.quit();

const argv = process.argv.slice(1);
const argVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const SHOT = argVal('--shot');
if (SHOT && argVal('--dsf')) app.commandLine.appendSwitch('force-device-scale-factor', argVal('--dsf'));
const SHOT_EVAL = argVal('--eval');
const PETTEST = argVal('--pettest');   // test harness: also screenshot the pet window (with --peteval code run inside it)
const SHOT_WAIT = parseInt(argVal('--wait') || '2500', 10);

let win = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// ---------- settings ----------
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, s) => { saveSettings(s); return true; });
ipcMain.handle('settings:reveal', () => { shell.showItemInFolder(settingsFile()); return settingsFile(); });

// ---------- claude binary ----------
let cachedClaude = null;
function claudeBin(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  if (cachedClaude) return cachedClaude;
  const cands = [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(os.homedir(), '.local', 'bin', 'claude')];
  for (const c of cands) if (fs.existsSync(c)) return (cachedClaude = c);
  return (cachedClaude = 'claude');
}
function runClaude(args, { custom, cwd, timeout = 60000, input } = {}) {
  return new Promise((resolve) => {
    const p = execFile(claudeBin(custom), args, { cwd: cwd || os.homedir(), timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
  });
}

// ---------- MCP ----------
function parseMcpList(out) {
  const res = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Checking MCP/i.test(line)) continue;
    const i = line.indexOf(': ');
    if (i < 0) continue;
    const name = line.slice(0, i);
    let rest = line.slice(i + 2);
    let status = 'unknown', statusText = '';
    const j = rest.lastIndexOf(' - ');
    if (j >= 0) {
      statusText = rest.slice(j + 3).trim();
      rest = rest.slice(0, j);
      if (/connected/i.test(statusText) && !/not|dis/i.test(statusText)) status = 'connected';
      else if (/auth/i.test(statusText)) status = 'auth';
      else if (/pending/i.test(statusText)) status = 'pending';
      else if (/fail|error|âœ—|Ã—/i.test(statusText)) status = 'failed';
      else if (/disabled/i.test(statusText)) status = 'disabled';
    }
    res.push({ name, target: rest.trim(), status, statusText: statusText.replace(/^[^\w]+/, '') });
  }
  return res;
}
ipcMain.handle('mcp:list', async (_e, { custom, cwd }) => {
  const r = await runClaude(['mcp', 'list'], { custom, cwd, timeout: 90000 });
  return { servers: parseMcpList(r.stdout), raw: r.stdout + r.stderr };
});
ipcMain.handle('mcp:get', async (_e, { custom, cwd, name }) => {
  const r = await runClaude(['mcp', 'get', name], { custom, cwd, timeout: 60000 });
  return (r.stdout + r.stderr).trim();
});
ipcMain.handle('mcp:add', async (_e, o) => {
  const { custom, cwd, name, transport, target, args, env, headers, scope } = o;
  const a = ['mcp', 'add', name, '--transport', transport, '--scope', scope || 'user'];
  if (transport === 'stdio') {
    for (const [k, v] of Object.entries(env || {})) a.push('-e', `${k}=${v}`);
    a.push('--', target, ...(args || []));
  } else {
    a.splice(3, 0, target); // name url --transport ...
    for (const [k, v] of Object.entries(headers || {})) a.push('--header', `${k}: ${v}`);
  }
  const r = await runClaude(a, { custom, cwd, timeout: 60000 });
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
});
ipcMain.handle('mcp:addJson', async (_e, { custom, cwd, name, json, scope }) => {
  const r = await runClaude(['mcp', 'add-json', '--scope', scope || 'user', name, json], { custom, cwd, timeout: 60000 });
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
});
ipcMain.handle('mcp:remove', async (_e, { custom, cwd, name, scope }) => {
  const a = ['mcp', 'remove', name]; if (scope) a.push('--scope', scope);
  const r = await runClaude(a, { custom, cwd, timeout: 60000 });
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
});
ipcMain.handle('mcp:login', async (_e, { custom, cwd, name }) => {
  const r = await runClaude(['mcp', 'login', name], { custom, cwd, timeout: 300000 });
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
});

// ---------- filesystem ----------
ipcMain.handle('fs:readdir', async (_e, dir) => {
  try {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    return ents.map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
  } catch (e) { return { error: e.message }; }
});
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' };
ipcMain.handle('fs:read', async (_e, file) => {
  try {
    const st = await fs.promises.stat(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    if (IMG[ext]) {
      const buf = await fs.promises.readFile(file);
      return { kind: 'image', dataUrl: `data:${IMG[ext]};base64,${buf.toString('base64')}`, size: st.size };
    }
    if (st.size > 8 * 1024 * 1024) return { kind: 'toolarge', size: st.size };
    const buf = await fs.promises.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary', size: st.size };
    return { kind: 'text', content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
  } catch (e) { return { kind: 'error', error: e.message }; }
});
ipcMain.handle('fs:write', async (_e, { file, content }) => {
  try { await fs.promises.writeFile(file, content, 'utf8'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:create', async (_e, { file, dir, content }) => {
  try { if (dir) await fs.promises.mkdir(file, { recursive: true }); else { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, content || '', { flag: 'wx' }); } return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:rename', async (_e, { from, to }) => {
  try { await fs.promises.rename(from, to); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:trash', async (_e, file) => {
  try { await shell.trashItem(file); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:reveal', (_e, file) => { shell.showItemInFolder(file); return true; });
ipcMain.handle('fs:openExternal', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('fs:search', async (_e, { root, query, max = 300 }) => {
  // simple filename + content search (skips heavy dirs, binaries)
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '__pycache__', '.venv', 'target']);
  const results = []; const q = query.toLowerCase();
  async function walk(dir, depth) {
    if (results.length >= max || depth > 8) return;
    let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (results.length >= max) return;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (!skip.has(d.name)) await walk(full, depth + 1); continue; }
      if (d.name.toLowerCase().includes(q)) results.push({ file: full, line: 0, text: d.name });
      try {
        const st = await fs.promises.stat(full);
        if (st.size > 1024 * 1024) continue;
        const buf = await fs.promises.readFile(full);
        if (buf.subarray(0, 4000).includes(0)) continue;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < max; i++) {
          if (lines[i].toLowerCase().includes(q)) results.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      } catch { }
    }
  }
  await walk(root, 0);
  return results;
});

ipcMain.handle('fs:list', async (_e, root) => {
  const skip = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'release', 'out', '.next', '.nuxt', '.cache', '.turbo', 'target', '__pycache__', '.venv', 'venv', '.idea', '.vs', 'bin', 'obj', 'coverage']); const res = [];
  async function walk(dir, depth) {
    if (res.length >= 20000 || depth > 12) return; let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) { const full = path.join(dir, d.name); if (d.isDirectory()) { if (!skip.has(d.name)) await walk(full, depth + 1); } else res.push(path.relative(root, full).replace(/\\/g, '/')); if (res.length >= 20000) return; }
  }
  await walk(root, 0); return res;
});
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:images', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }, { name: 'All files', extensions: ['*'] }] });
  if (r.canceled) return [];
  return r.filePaths.map((p) => {
    const ext = path.extname(p).slice(1).toLowerCase();
    const buf = fs.readFileSync(p);
    return { name: path.basename(p), path: p, mediaType: IMG[ext] || 'application/octet-stream', data: buf.toString('base64'), isImage: !!IMG[ext] };
  });
});
ipcMain.handle('fs:readB64', async (_e, p) => {
  const ext = path.extname(p).slice(1).toLowerCase();
  const buf = fs.readFileSync(p);
  return { name: path.basename(p), path: p, mediaType: IMG[ext] || 'application/octet-stream', data: buf.toString('base64'), isImage: !!IMG[ext] };
});
ipcMain.handle('clipboard:readImage', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return { name: 'pasted.png', mediaType: 'image/png', data: img.toPNG().toString('base64'), isImage: true };
});

// ---------- workspace watcher ----------
let watcher = null, watchTimer = null, pending = new Set();
ipcMain.handle('ws:watch', (_e, root) => {
  if (watcher) { try { watcher.close(); } catch { } watcher = null; }
  if (!root) return true;
  cp.open(root);
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, fname) => {
      if (!fname || /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(fname)) return;
      pending.add(path.join(root, fname));
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { const list = [...pending]; pending.clear(); cp.changed(list); send('fs:changed', list); popSend('fs:changed', list); }, 250);
    });
    watcher.on('error', () => { });
  } catch { }
  return true;
});

// ---------- agents (claude / codex / opencode share one event protocol) ----------
const procs = new Map();
function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
const lazy = (f) => { let m; return () => (m || (m = require(f))); };
const store = require('./store'); store.register({ lazy });
const cp = require('./checkpoints'); cp.register(ipcMain);
const termMod = require('./term'); termMod.register({ ipcMain, send, app });
const plugins = require('./plugins').register({ ipcMain, send, app });
require('./ports').register({ ipcMain });
const customMod = lazy('./agents/custom');
const codexMod = lazy('./agents/codex'), opencodeMod = lazy('./agents/opencode'), installerMod = lazy('./agents/installer'), whisperMod = lazy('./voice/whisper');

// Claude Code: `claude -p --input-format stream-json` (events already in the shared shape)
function startClaude(o, hooks) {
  const { cwd, model, effort, mode, resume, addDirs, custom } = o; const appendSystemPrompt = o.instructions || o.appendSystemPrompt;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--forward-subagent-text', '--permission-prompt-tool', 'stdio'];
  args.push('--permission-mode', mode || 'manual');
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--resume', resume);
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  for (const d of addDirs || []) args.push('--add-dir', d);
  if (Array.isArray(o.extraArgs)) args.push(...o.extraArgs);
  const p = spawn(claudeBin(custom), args, { cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), windowsHide: true, env: { ...process.env, ...(o.env || {}), NO_COLOR: '1', CLAUDE_CODE_ENTRYPOINT: 'hyper-ide' } });
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString('utf8'); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { hooks.emit(JSON.parse(line)); } catch { hooks.emit({ type: 'raw', text: line }); }
    }
  });
  p.stderr.on('data', (d) => hooks.emit({ type: 'stderr', text: d.toString('utf8') }));
  p.on('error', (e) => hooks.exit(-1, e.message));
  p.on('exit', (code) => hooks.exit(code));
  return { write: (obj) => { try { p.stdin.write(JSON.stringify(obj) + '\n'); } catch { } }, kill: () => { try { p.kill(); } catch { } } };
}

// ---------- IDE tools bridge: agents call tools (via the built-in MCP server) â†’ renderer executes them â†’ result flows back ----------
const ideCalls = new Map();
function ideInvoke(tool, args) {
  // PC control runs right here in the main process, behind its own permission dialog (see pc.js)
  if (/^pc_/.test(tool)) return pc.call(tool, args).catch((e) => ({ content: [{ type: 'text', text: e.message }], isError: true }));
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { ideCalls.delete(id); resolve({ content: [{ type: 'text', text: 'The IDE did not answer in time' }], isError: true }); }, 24000);
    ideCalls.set(id, (r) => { clearTimeout(timer); resolve(r); });
    send('ide:call', { id, tool, args });
  });
}
ipcMain.handle('ide:reply', (_e, { id, result }) => { const f = ideCalls.get(id); if (f) { ideCalls.delete(id); f(result); } return true; });
let ideServer = null;
async function ensureIde() { if (!ideServer) ideServer = await require('./ide-mcp').start({ invoke: ideInvoke, token: crypto.randomBytes(24).toString('hex'), getExtraTools: plugins.getExtraTools }); return ideServer; }
ipcMain.handle('agent:start', async (_e, o) => {
  const id = o.id;
  if (procs.has(id)) return { ok: false, error: 'already running' };
  let dead = false;
  const hooks = {
    emit: (ev) => { if (!dead) send('agent:event', { id, ev }); },
    exit: (code, error) => { if (dead) return; dead = true; procs.delete(id); send('agent:exit', { id, code, error }); },
  };
  try {
    const prov = o.provider || 'claude';
    o.env = store.agentEnv(prov);
    // per-agent user options from Settings â†’ Agents: extra CLI flags (Claude/OpenCode), `-c` config overrides + writable dirs (Codex)
    const tok = (s) => (String(s || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((x) => x.replace(/^["']|["']$/g, ''));
    if (prov === 'codex') {
      o.configArgs = []; String(o.flags || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((l) => o.configArgs.push('-c', l));
      if ((o.addDirs || []).length) o.configArgs.push('-c', 'sandbox_workspace_write.writable_roots=' + JSON.stringify(o.addDirs));
    } else o.extraArgs = tok(o.flags);
    if (prov.startsWith('custom:')) {
      const cid = prov.slice(7); const s = store.readSettings(); const def = (s.customAgents || []).find((x) => x.id === cid);
      if (!def) return { ok: false, error: 'Custom agent not found' };
      o.custom = { ...def, apiKey: store.loadKeys()['agent:' + cid] }; o.opencode = s.opencodePath || undefined; o.env = store.agentEnv('custom');
    }
    // give the agent the IDE's own tools (preview, screenshots, console, open file, terminal) through the built-in MCP server
    let ideHint = '';
    if (store.readSettings().ideTools !== false) {
      try {
        const ide = require('./ide-mcp'); const info = await ensureIde(); const base = prov.startsWith('custom:') ? 'opencode' : prov;
        const cfg = ide.agentConfig(base, info, { enabled: true, readOnlyAutoAllow: true, extraSafeTools: plugins.getExtraTools().filter((t) => t.readOnly).map((t) => t.name) }) || {};
        if (base === 'claude') { o.extraArgs = [...(o.extraArgs || []), ...(cfg.args || [])]; o.instructions = [o.instructions, cfg.hint].filter(Boolean).join('\n\n'); }
        else if (base === 'codex') { o.env = { ...o.env, ...(cfg.env || {}) }; o.configArgs = [...(o.configArgs || []), ...(cfg.configArgs || [])]; ideHint = cfg.hint || ''; }
        else { if (cfg.inlineConfig) o.env = { ...o.env, OPENCODE_CONFIG_CONTENT: ide.mergeInlineConfig(o.env && o.env.OPENCODE_CONFIG_CONTENT, cfg.inlineConfig) }; ideHint = cfg.hint || ''; }
      } catch (e) { console.error('IDE tools unavailable:', e.message); }
    }
    const a = prov.startsWith('custom:') ? customMod().start(o, hooks) : prov === 'codex' ? codexMod().start(o, hooks) : prov === 'opencode' ? opencodeMod().start(o, hooks) : startClaude(o, hooks);
    procs.set(id, a);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('providers:codexKey', async (_e, custom) => { try { const key = store.loadKeys().openai; if (!key) return { ok: false, out: 'Add an OpenAI API key first' }; return await codexMod().loginWithApiKey(custom, key); } catch (e) { return { ok: false, out: e.message }; } });
ipcMain.handle('custom:test', async (_e, { def, apiKey, id }) => { const key = apiKey || (id ? store.loadKeys()['agent:' + id] : ''); return customMod().testConnection({ ...def, apiKey: key }); });
ipcMain.handle('custom:models', async (_e, { def, apiKey, id }) => { try { const key = apiKey || (id ? store.loadKeys()['agent:' + id] : ''); return await customMod().listModels({ ...def, apiKey: key }); } catch (e) { return []; } });
ipcMain.handle('agent:write', (_e, { id, obj }) => { const a = procs.get(id); if (!a) return false; a.write(obj); return true; });
ipcMain.handle('agent:rewind', async (_e, { id, provider, sessionId, keepTurns, cwd, custom, cpMark }) => {
  // 1) rewind the agent's own conversation (+ any file revert it supports)  2) restore every other file changed since the checkpoint
  const withFiles = async (res) => { if (res && res.ok && cpMark) { const r = cp.restore(cpMark); res.filesReverted = (res.filesReverted || 0) + (r.restored || 0) + (r.deleted || 0); res.filesSkipped = (res.filesSkipped || 0) + (r.failed || 0); } return res; };
  try {
    const a = procs.get(id);
    if (provider === 'claude') { if (a) { try { a.kill(); } catch { } procs.delete(id); } return await withFiles(await store.claudeRewind(sessionId, keepTurns)); }
    if (a && a.rewind) return await withFiles(await a.rewind(keepTurns));
    const mod = provider === 'codex' ? codexMod() : opencodeMod();
    if (mod.rewindSession) return await withFiles(await mod.rewindSession(custom, sessionId, keepTurns, { env: store.agentEnv(provider), cwd }));
    return { ok: false, error: 'Undo is not supported for this agent yet' };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('agent:kill', (_e, id) => { const a = procs.get(id); if (!a) return false; try { a.kill(); } catch { } procs.delete(id); return true; });

// ---------- providers: detect / install / login / info / usage ----------
const infoCache = {};
ipcMain.handle('providers:detect', async (_e, custom) => { try { return await installerMod().detect(custom || {}); } catch (e) { return { error: e.message }; } });
ipcMain.handle('providers:commandFor', (_e, p) => { try { return installerMod().commandFor(p); } catch { return ''; } });
ipcMain.handle('providers:install', async (_e, { provider, custom }) => {
  try { return await installerMod().install(provider, { custom, onLog: (line) => send('install:log', { provider, line }) }); }
  catch (e) { return { ok: false, out: e.message }; }
});
ipcMain.handle('providers:login', async (_e, { provider, custom }) => {
  try {
    if (provider === 'claude') return await (async () => { const r = await runClaude(['auth', 'login'], { custom, timeout: 300000 }); return { ok: r.ok, out: (r.stdout + r.stderr).trim() }; })();
    if (provider === 'codex') return await codexMod().login(custom);
    return await opencodeMod().login(custom);
  } catch (e) { return { ok: false, out: e.message }; }
});
ipcMain.handle('providers:logout', async (_e, { provider, custom }) => {
  try {
    if (provider === 'claude') { const r = await runClaude(['auth', 'logout'], { custom, timeout: 20000 }); return { ok: r.ok, out: (r.stdout + r.stderr).trim() }; }
    if (provider === 'codex') return await codexMod().logout(custom);
    return { ok: false, out: 'Run `opencode auth logout` in a terminal.' };
  } catch (e) { return { ok: false, out: e.message }; }
});
// service info: account/plan/models (cached ~60s unless force)
ipcMain.handle('providers:info', async (_e, { provider, custom, force }) => {
  const c = infoCache[provider];
  if (!force && c && Date.now() - c.at < 60000) return c.v;
  let v = null;
  try {
    if (provider === 'codex') v = await codexMod().service(custom, store.agentEnv('codex'));
    else if (provider === 'opencode') v = await opencodeMod().service(custom, store.agentEnv('opencode'));
  } catch (e) { v = { error: e.message }; }
  infoCache[provider] = { at: Date.now(), v };
  return v;
});
// Claude's real plan usage (same numbers the CLI/claude.ai show). Token never leaves api.anthropic.com.
ipcMain.handle('usage:claude', async () => {
  try {
    const f = path.join(os.homedir(), '.claude', '.credentials.json');
    const tok = JSON.parse(fs.readFileSync(f, 'utf8')).claudeAiOauth;
    if (!tok || !tok.accessToken) return null;
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + tok.accessToken, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { error: 'HTTP ' + res.status };
    const j = await res.json();
    const windows = (j.limits || []).map((l) => ({
      id: l.kind + (l.scope && l.scope.model ? ':' + l.scope.model.display_name : ''),
      label: l.kind === 'session' ? '5-hour' : l.kind === 'weekly_all' ? 'Weekly' : l.kind === 'weekly_scoped' ? 'Weekly Â· ' + ((l.scope && l.scope.model && l.scope.model.display_name) || 'scoped') : l.kind,
      usedPct: l.percent, resetsAt: l.resets_at ? Math.floor(Date.parse(l.resets_at) / 1000) : null, severity: l.severity,
    }));
    return { plan: tok.subscriptionType || null, windows, breakdown: (j.seven_day_breakdown && j.seven_day_breakdown.rows) || [], extra: j.extra_usage && j.extra_usage.is_enabled ? j.extra_usage : null };
  } catch (e) { return { error: e.message }; }
});

// ---------- voice ----------
ipcMain.handle('voice:status', async () => { try { return await whisperMod().status(); } catch (e) { return { available: false, error: e.message }; } });
ipcMain.handle('voice:ensure', async (_e, size) => {
  try { await whisperMod().ensureModel(size, (p) => send('voice:progress', p)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('voice:transcribe', async (_e, { audio, model, language, task }) => {
  try {
    const w = whisperMod(); w.setModelDir(path.join(app.getPath('userData'), 'models'));
    const buf = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const r = await w.transcribe(f32, { model: model || 'base', language: language || 'auto', task: task || 'transcribe', onProgress: (p) => send('voice:progress', p) });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('app:getLogo', async () => { for (const p of [path.join(__dirname, 'renderer', 'assets', 'logo.png')]) { try { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); } catch { } } return null; });
ipcMain.handle('dialog:file', async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filters || [{ name: 'All files', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:media', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm', 'opus', 'mp4', 'mov', 'mkv', 'avi'] }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('fs:readBytes', async (_e, p) => { const b = fs.readFileSync(p); return { name: path.basename(p), path: p, data: new Uint8Array(b.buffer, b.byteOffset, b.byteLength), size: b.length }; });

// ---------- window ----------
// ---------- fonts ----------
ipcMain.handle('fonts:list', () => new Promise((resolve) => {
  const key = (k) => new Promise((r) => execFile('reg', ['query', k], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => r(String(out || ''))));
  Promise.all([key('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'), key('HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')]).then((outs) => {
    const fam = new Set();
    for (const o of outs) for (const l of o.split(/\r?\n/)) { const m = l.match(/^\s+(.+?)\s+REG_SZ\s/); if (!m) continue; let n = m[1].replace(/\s*\((TrueType|OpenType|All res|VGA res)\)\s*$/i, '').split(' & ')[0].trim(); n = n.replace(/\s+(Regular|Bold|Italic|Oblique|Light|Medium|SemiBold|Semibold|ExtraBold|Black|Thin|Condensed|Narrow|Semilight|Demi|Heavy)(\s+(Italic|Oblique|Bold))?$/i, '').trim(); if (n) fam.add(n); }
    resolve([...fam]);
  });
}));
ipcMain.handle('fonts:install', async (_e, file) => {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(file)); if (path.resolve(file) !== path.resolve(dest)) fs.copyFileSync(file, dest);
    const ext = path.extname(file).toLowerCase(); const name = path.basename(file, ext) + (ext === '.otf' ? ' (OpenType)' : ' (TrueType)');
    await new Promise((res, rej) => execFile('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', '/v', name, '/t', 'REG_SZ', '/d', dest, '/f'], { windowsHide: true }, (e) => (e ? rej(e) : res())));
    return { ok: true, path: dest };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('dialog:fonts', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'ttc'] }] }); return r.canceled ? [] : r.filePaths; });
ipcMain.handle('win:overlay', (_e, { color, symbolColor }) => {
  if (win && process.platform === 'win32') { try { win.setTitleBarOverlay({ color, symbolColor, height: 46 }); } catch { } }
  return true;
});
ipcMain.handle('win:zoom', (_e, f) => { if (win) win.webContents.setZoomFactor(f); return true; });

function createWindow() {
  const s = loadSettings();
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 600,
    backgroundColor: '#0e0b14', show: false,
    title: 'hyper-ide', icon: path.join(__dirname, 'renderer', 'assets', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#120d1c', symbolColor: '#cbb8f0', height: 46 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false, sandbox: false, webviewTag: true, backgroundThrottling: false /* agents keep working while the window is hidden */ },
  });
  // hidden menu bar, but keep the Edit roles so Ctrl+C / V / X / A / Z work everywhere (also on selected chat text)
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
  win.setMenuBarVisibility(false);
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL && /^https?:/.test(p.linkURL)) items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { label: 'Open link in browser', click: () => shell.openExternal(p.linkURL) }, { type: 'separator' });
    if (p.isEditable) items.push({ role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' }, { role: 'cut', enabled: p.editFlags.canCut });
    if (p.selectionText || p.isEditable) items.push({ role: 'copy', enabled: p.editFlags.canCopy });
    if (p.isEditable) items.push({ role: 'paste', enabled: p.editFlags.canPaste });
    items.push({ role: 'selectAll' });
    if (p.srcURL && p.mediaType === 'image') items.push({ type: 'separator' }, { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'microphone', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'local-fonts'].includes(perm)));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), SHOT && argVal('--popq') ? { query: Object.fromEntries(new URLSearchParams(argVal('--popq'))) } : undefined);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F5' && input.control) win.webContents.reload();
  });
  if (SHOT) {
    if (argVal('--size')) { const [w, h] = argVal('--size').split('x').map(Number); win.setContentSize(w, h); win.center(); }
    win.setOpacity(0); win.showInactive(); // hidden windows don't repaint -> stale captures
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') { if (/Security Warning/.test(e.message)) return; console.log(`[renderer ${e.level}] ${e.message} (${path.basename(e.sourceId || '')}:${e.lineNumber})`); } });
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, SHOT_WAIT));
      try {
        if (SHOT_EVAL) { const rv = await win.webContents.executeJavaScript(SHOT_EVAL.startsWith('@') ? fs.readFileSync(SHOT_EVAL.slice(1), 'utf8') : SHOT_EVAL); console.log('eval result:', rv); await new Promise((r) => setTimeout(r, 900)); }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(SHOT, img.toPNG());
        if (PETTEST) await pet.testCapture(PETTEST, argVal('--peteval'), +(argVal('--petwait') || 1500));   // also capture the desktop pet window
      } catch (e) { console.error(e); }
      app.exit(0);
    });
  }
  // closing the window keeps hyper-ide (and its pet + running agents) alive in the tray; "Quit" in the tray menu really exits
  win.on('close', (e) => { if (!SHOT && !pet.isQuitting() && pet.keepRunning()) { e.preventDefault(); win.hide(); pet.onMainHidden(); } });
  win.on('closed', () => { win = null; for (const w of pops.values()) { try { w.destroy(); } catch { } } });
}

// ---------- splash screen: shown instantly, closed when the main window has finished booting ----------
let splash = null, splashAt = 0, mainShown = false;
function createSplash() {
  if (SHOT) return;
  splash = new BrowserWindow({ width: 460, height: 460, frame: false, transparent: true, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false, center: true, backgroundColor: '#00000000', icon: path.join(__dirname, 'renderer', 'assets', 'icon.ico') });
  splash.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splash.once('ready-to-show', () => { splashAt = Date.now(); splash.show(); });
  splash.on('closed', () => { splash = null; });
}
function showMain() {
  if (mainShown || !win || SHOT) return; mainShown = true;
  const wait = Math.max(0, 2200 - (Date.now() - (splashAt || Date.now()))); // let the logo pulse a couple of times
  setTimeout(() => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    if (splash) { try { splash.webContents.executeJavaScript("document.body.classList.add('out')"); } catch { } setTimeout(() => { if (splash) splash.close(); }, 380); }
  }, wait);
}

// ---------- pop-out panels: Files / Search / Chats / MCP in their own window ----------
const pops = new Map();
function popSend(ch, payload) { for (const w of pops.values()) if (!w.isDestroyed()) w.webContents.send(ch, payload); }
const POP_TITLES = { explorer: 'Files', search: 'Search', sessions: 'Chats', mcp: 'MCP Servers' };
ipcMain.handle('pop:open', (_e, { id, ws, bg, fg }) => {
  if (!POP_TITLES[id]) return false;
  const have = pops.get(id); if (have && !have.isDestroyed()) { have.focus(); return true; }
  const w = new BrowserWindow({
    width: 380, height: 760, minWidth: 260, minHeight: 320, backgroundColor: bg || '#0e0b14', show: false, title: 'hyper-ide - ' + POP_TITLES[id],
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.ico'), titleBarStyle: 'hidden', titleBarOverlay: { color: bg || '#120d1c', symbolColor: fg || '#cbb8f0', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false, sandbox: false },
  });
  w.setMenuBarVisibility(false);
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { pop: id, ws: ws || '' } });
  w.once('ready-to-show', () => w.show());
  w.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'F12') w.webContents.toggleDevTools(); });
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  pops.set(id, w);
  w.on('closed', () => { pops.delete(id); send('pop:closed', id); });
  return true;
});
ipcMain.handle('pop:close', (_e, id) => { const w = pops.get(id); if (w && !w.isDestroyed()) w.close(); return true; });
ipcMain.handle('pop:focus', (_e, id) => { const w = pops.get(id); if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.focus(); } return true; });
ipcMain.handle('pop:call', (_e, msg) => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.webContents.send('pop:call', msg); } return true; });
ipcMain.handle('pop:broadcast', (_e, { ch, payload }) => { popSend(ch, payload); return true; });
ipcMain.handle('pop:overlay', (e, { color, symbolColor }) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && process.platform === 'win32') { try { w.setTitleBarOverlay({ color, symbolColor, height: 40 }); } catch { } } return true; });
// bring the (possibly hidden / minimised) IDE window to the front
function revealMain() {
  if (!win || win.isDestroyed()) return;
  mainShown = true; if (splash) { try { splash.close(); } catch { } }
  if (win.isMinimized()) win.restore(); win.show(); win.focus();
}
ipcMain.handle('app:ready', () => { showMain(); return true; });

// ---------- notifications: our own title and icon (not "electron") ----------
const APP_ICON = path.join(__dirname, 'renderer', 'assets', 'icon.ico');
ipcMain.handle('app:notify', (_e, o) => {
  try {
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title: String((o && o.title) || 'hyper-ide').slice(0, 80), body: String((o && o.body) || '').slice(0, 240), icon: APP_ICON, silent: false });
    n.on('click', () => { revealMain(); if (o && o.chatId) send('pet:cmd', { fn: 'open', chatId: o.chatId }); });
    n.show(); return true;
  } catch { return false; }
});
// In development the app runs as electron.exe, which Windows would label "Electron" in toasts. A Start-menu shortcut that
// carries our AppUserModelID gives them the hyper-ide name and icon (the installed app gets this shortcut from the installer).
function ensureToastIdentity() {
  if (process.platform !== 'win32' || SHOT) return;
  try {
    const progs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const lnk = path.join(progs, app.isPackaged ? 'hyper-ide.lnk' : 'hyper-ide (dev).lnk');
    const opts = app.isPackaged
      ? { target: process.execPath, cwd: path.dirname(process.execPath), icon: process.execPath, iconIndex: 0, description: 'hyper-ide', appUserModelId: 'com.hyperide.ide' }
      : { target: process.execPath, args: '"' + app.getAppPath() + '"', cwd: app.getAppPath(), icon: APP_ICON, iconIndex: 0, description: 'hyper-ide', appUserModelId: 'com.hyperide.ide' };
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', opts);
  } catch { /* not critical */ }
}

pc.init({
  getSettings: loadSettings, autoAllow: !!SHOT,
  ask: async ({ level, detail }) => {
    const parent = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() ? win : null;
    const r = await dialog.showMessageBox(parent, {
      type: 'warning', title: 'hyper-ide', noLink: true, buttons: ['Allow once', 'Allow for this session', 'Deny'], defaultId: 2, cancelId: 2,
      message: level === 'view' ? 'Allow the AI to look at your PC?' : 'Allow the AI to control your PC?', detail,
      icon: nativeImage.createFromPath(APP_ICON),
    });
    return ['once', 'session', 'deny'][r.response];
  },
});
pet.register({
  app, dialog, shell, Menu, Tray, nativeImage, ipcMain, shot: !!SHOT && !PETTEST, testLog: !!PETTEST, pc,
  BrowserWindow, get screen() { return screen; }, getWin: () => win, showMain: revealMain, sendToIde: (ch, p) => send(ch, p),
});
app.whenReady().then(() => {
  createSplash(); createWindow(); ensureToastIdentity();
  pet.apply(loadSettings().pet);
  setTimeout(showMain, 20000); /* safety: never leave the user without a window */
});
app.on('before-quit', () => { pet.setQuitting(true); pc.stop(); for (const [, a] of procs) { try { a.kill(); } catch { } } try { termMod.killAll(); } catch { } });
app.on('window-all-closed', () => { pet.destroy(); app.quit(); });
app.on('second-instance', () => revealMain());