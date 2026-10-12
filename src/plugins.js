// Reva plugin system - main-process half.
//
//   const plugins = require('./plugins').register({ ipcMain, send, app });
//   plugins.getExtraTools()   -> tool list for ide-mcp's `getExtraTools` (agent tools contributed by plugins)
//
// What lives here: scanning plugin folders + validating plugin.json, enable/permission state (plugins-state.json),
// install from folder / .zip (own unzip, zip-slip safe), uninstall, scaffolding, per-plugin storage, a `fetch` proxy
// that refuses private networks, a folder watcher (hot reload) and the declarative agent-tool list for the MCP server.
// Everything the renderer needs comes back from ONE call: `plugins:list`.
//
// Folders:   <userData>\plugins\<id>\            user plugins (global)
//            <workspace>\.reva\plugins\<id>\     project plugins (enabled per project)
//            <app>\src\plugins-builtin\<id>\     examples shipped with Reva (copied to the user folder on "Install")
// Data:      <userData>\plugin-data\<id>\storage.json
//
// SECURITY MODEL: plugins are trusted code the user installs; they run inside the renderer. The `permissions`
// in plugin.json are shown at install time and enforced on the `reva` API object, but this is NOT a sandbox.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const dns = require('dns');
const net = require('net');

const PERMISSIONS = ['workspace.read', 'workspace.write', 'terminal', 'network', 'network.local', 'chat', 'agents', 'preview', 'settings'];
const ACTIVATION_RE = /^(onStartup|onWorkspace|onCommand:[\w.\-]+|onFileType:\.?[\w+\-]+)$/;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const SETTING_TYPES = ['boolean', 'string', 'text', 'number', 'select', 'color'];
const MENU_KEYS = ['explorer/context', 'editor/context', 'commandPalette'];
const LIMITS = { zipEntries: 3000, zipFile: 20 << 20, zipTotal: 100 << 20, zipFileBytes: 60 << 20, copyTotal: 100 << 20, storage: 1 << 20, fetchBody: 5 << 20, fetchMs: 20000 };

// ------------------------------------------------------------------ tiny semver
const parseVer = (s) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(s || '').trim()); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null; };
const cmpVer = (a, b) => { for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] < b.n[i] ? -1 : 1; if (a.pre === b.pre) return 0; if (!a.pre) return 1; if (!b.pre) return -1; return a.pre < b.pre ? -1 : 1; };
/** Does `version` satisfy `range`? Supports >=, >, <=, <, =, ^, ~, x-ranges ("0.3.x"), "*", space = AND, "||" = OR. Returns null for an invalid range. */
function satisfies(version, range) {
  const v = parseVer(version); if (!v) return null;
  const sets = String(range).split('||').map((x) => x.trim()); let valid = true, any = false;
  for (const set of sets) {
    if (set === '' || set === '*') { any = true; continue; }
    let ok = true;
    for (const tok of set.split(/\s+/)) {
      const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/.exec(tok);
      if (!m) { valid = false; break; }
      const op = m[1] || '='; const maj = +m[2]; const min = m[3] == null || /[x*]/.test(m[3]) ? null : +m[3]; const pat = m[4] == null || /[x*]/.test(m[4]) ? null : +m[4];
      const base = { n: [maj, min || 0, pat || 0], pre: '' }; let pass;
      if (op === '>=') pass = cmpVer(v, base) >= 0; else if (op === '>') pass = cmpVer(v, base) > 0;
      else if (op === '<=') pass = cmpVer(v, base) <= 0; else if (op === '<') pass = cmpVer(v, base) < 0;
      else if (op === '^') pass = cmpVer(v, base) >= 0 && (maj > 0 ? v.n[0] === maj : min != null && min > 0 ? v.n[0] === 0 && v.n[1] === min : v.n[0] === 0 && v.n[1] === 0 && (pat == null || v.n[2] === pat));
      else if (op === '~') pass = cmpVer(v, base) >= 0 && v.n[0] === maj && (min == null || v.n[1] === min);
      else pass = v.n[0] === maj && (min == null || v.n[1] === min) && (pat == null || v.n[2] === pat);
      if (!pass) ok = false;
    }
    if (ok) any = true;
  }
  return valid ? any : null;
}

// ------------------------------------------------------------------ manifest validation
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.trim() !== '';
/** Resolve `rel` inside `dir`; null when it escapes. */
function inside(dir, rel) { const full = path.resolve(dir, String(rel)); const base = path.resolve(dir); return full === base || full.startsWith(base + path.sep) ? full : null; }

/**
 * Validate a parsed plugin.json. Returns { manifest, errors:[], warnings:[] } - `manifest` is normalised (arrays default to []).
 * `dir` (optional) lets us check that referenced files exist.
 */
function validateManifest(raw, { dir, appVersion } = {}) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  if (!isObj(raw)) return { manifest: null, errors: ['plugin.json must contain a JSON object'], warnings };
  const m = {
    id: raw.id, name: raw.name, version: raw.version, description: raw.description || '', author: raw.author || '', icon: raw.icon || '', main: raw.main || '',
    reva: raw.reva || '', activation: raw.activation, permissions: raw.permissions || [], contributes: isObj(raw.contributes) ? raw.contributes : {},
  };
  if (!isStr(m.id)) err('"id" is required (e.g. "my-plugin")');
  else if (!ID_RE.test(m.id) || m.id.length < 2 || m.id.length > 40) err('"id" must be 2-40 chars of lowercase letters/digits separated by single hyphens (got "' + m.id + '")');
  if (!isStr(m.name)) err('"name" is required');
  if (!isStr(m.version)) err('"version" is required (e.g. "1.0.0")'); else if (!parseVer(m.version)) err('"version" must look like 1.2.3 (got "' + m.version + '")');
  if (raw.description != null && typeof raw.description !== 'string') err('"description" must be a string');
  if (m.main) {
    if (typeof m.main !== 'string') err('"main" must be a string path');
    else if (dir) {
      const f = inside(dir, m.main);
      if (!f) err('"main" must stay inside the plugin folder (got "' + m.main + '")');
      else if (!fs.existsSync(f) || !fs.statSync(f).isFile()) err('"main" file not found: ' + m.main);
    }
  }
  if (m.reva) {
    if (typeof m.reva !== 'string') err('"reva" must be a version range string such as ">=0.3.0"');
    else { const r = appVersion ? satisfies(appVersion, m.reva) : (satisfies('0.0.0', m.reva) === null ? null : true); if (r === null) err('"reva" is not a valid version range: "' + m.reva + '"'); else if (r === false) err('requires Reva ' + m.reva + ' but this is Reva ' + appVersion); }
  }
  if (m.activation == null || (Array.isArray(m.activation) && !m.activation.length)) m.activation = ['onStartup'];
  if (!Array.isArray(m.activation)) { err('"activation" must be an array'); m.activation = ['onStartup']; }
  else for (const a of m.activation) if (typeof a !== 'string' || !ACTIVATION_RE.test(a)) err('unknown activation event "' + a + '" (use onStartup, onWorkspace, onCommand:<id>, onFileType:<ext>)');
  if (!Array.isArray(m.permissions)) { err('"permissions" must be an array'); m.permissions = []; }
  else for (const p of m.permissions) if (!PERMISSIONS.includes(p)) err('unknown permission "' + p + '" (known: ' + PERMISSIONS.join(', ') + ')');
  m.permissions = [...new Set(m.permissions.filter((p) => PERMISSIONS.includes(p)))];

  const c = m.contributes, norm = {};
  const arr = (key, each) => {
    const v = c[key]; norm[key] = [];
    if (v == null) return; if (!Array.isArray(v)) { err('contributes.' + key + ' must be an array'); return; }
    v.forEach((x, i) => { const w = 'contributes.' + key + '[' + i + ']'; if (!isObj(x)) { err(w + ' must be an object'); return; } if (each(x, w) !== false) norm[key].push(x); });
  };
  const uniq = (key, field) => { const seen = new Set(); for (const x of norm[key]) { if (seen.has(x[field])) err('contributes.' + key + ': duplicate ' + field + ' "' + x[field] + '"'); seen.add(x[field]); } };
  const needFile = (x, w, label) => {
    if (!isStr(x.file)) { err(w + '.file is required'); return false; }
    if (!dir) return true;
    const f = inside(dir, x.file); if (!f) { err(w + '.file must stay inside the plugin folder'); return false; }
    if (!fs.existsSync(f)) { err(w + '.file not found: ' + x.file); return false; }
    try { JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { err(w + '.file (' + label + ') is not valid JSON: ' + e.message); return false; }
    return true;
  };
  arr('commands', (x, w) => { if (!isStr(x.id)) return err(w + '.id is required'), false; if (!isStr(x.title)) return err(w + '.title is required'), false; if (x.keybinding != null && typeof x.keybinding !== 'string') return err(w + '.keybinding must be a string'), false; });
  uniq('commands', 'id');
  arr('themes', (x, w) => { if (!isStr(x.id)) return err(w + '.id is required'), false; if (!isStr(x.name)) return err(w + '.name is required'), false; if (!needFile(x, w, 'theme')) return false;
    if (dir) { try { const t = JSON.parse(fs.readFileSync(inside(dir, x.file), 'utf8').replace(/^﻿/, '')); if (!isObj(t.v) || !isObj(t.t)) err(w + '.file must have the shape {name, dark, v:{...}, t:{...}} like Reva themes'); } catch { /* reported */ } } });
  uniq('themes', 'id');
  arr('snippets', (x, w) => { if (!isStr(x.language)) return err(w + '.language is required'), false; return needFile(x, w, 'snippets'); });
  arr('languages', (x, w) => { if (!isStr(x.id)) return err(w + '.id is required'), false; if (x.extensions != null && !Array.isArray(x.extensions)) return err(w + '.extensions must be an array'), false; if (x.configuration != null && typeof x.configuration === 'string' && !needFile({ file: x.configuration }, w + '.configuration', 'language configuration')) return false; });
  arr('settings', (x, w) => {
    if (!isStr(x.key)) return err(w + '.key is required'), false; if (!isStr(x.title)) return err(w + '.title is required'), false;
    if (!SETTING_TYPES.includes(x.type)) return err(w + '.type must be one of ' + SETTING_TYPES.join(', ')), false;
    if (x.type === 'select' && (!Array.isArray(x.options) || !x.options.length)) return err(w + '.options is required for type "select"'), false;
  });
  uniq('settings', 'key');
  arr('sidebarPanels', (x, w) => { if (!isStr(x.id)) return err(w + '.id is required'), false; if (!isStr(x.title)) return err(w + '.title is required'), false; });
  uniq('sidebarPanels', 'id');
  arr('statusBar', (x, w) => { if (!isStr(x.id)) return err(w + '.id is required'), false; if (x.align != null && x.align !== 'left' && x.align !== 'right') return err(w + '.align must be "left" or "right"'), false; });
  arr('slashCommands', (x, w) => { if (!isStr(x.name) || !/^[\w-]+$/.test(x.name)) return err(w + '.name must be a word like "standup"'), false; });
  arr('agentTools', (x, w) => {
    if (!isStr(x.name) || !TOOL_RE.test(x.name)) return err(w + '.name must match ' + TOOL_RE + ' (letters, digits, underscore)'), false;
    if (!isStr(x.description)) return err(w + '.description is required (agents read it to decide when to call the tool)'), false;
    if (x.inputSchema != null && !isObj(x.inputSchema)) return err(w + '.inputSchema must be a JSON-schema object'), false;
  });
  uniq('agentTools', 'name');
  arr('fileActions', (x, w) => { if (!isStr(x.id)) return err(w + '.id is required'), false; if (!isStr(x.title)) return err(w + '.title is required'), false; if (x.when != null && !(isObj(x.when) && (x.when.extensions == null || Array.isArray(x.when.extensions)))) return err(w + '.when must be {extensions:[...]}'), false; });
  norm.menus = {};
  if (c.menus != null) {
    if (!isObj(c.menus)) err('contributes.menus must be an object');
    else for (const [k, v] of Object.entries(c.menus)) {
      if (!MENU_KEYS.includes(k)) { warn('contributes.menus: unknown menu "' + k + '" ignored (known: ' + MENU_KEYS.join(', ') + ')'); continue; }
      if (!Array.isArray(v) || v.some((x) => !isObj(x) || !isStr(x.command))) { err('contributes.menus["' + k + '"] must be an array of {command, title?, when?}'); continue; }
      norm.menus[k] = v;
    }
  }
  m.contributes = norm;
  // contributions that only work with a permission
  if (norm.agentTools.length && !m.permissions.includes('agents')) err('contributes.agentTools requires the "agents" permission');
  if (norm.slashCommands.length && !m.permissions.includes('chat')) err('contributes.slashCommands requires the "chat" permission');
  if (!m.main && (norm.sidebarPanels.length || norm.agentTools.length || norm.slashCommands.length || norm.commands.length)) warn('no "main" script: commands, panels, tools and slash commands need code to do anything');
  return { manifest: m, errors, warnings };
}

// ------------------------------------------------------------------ zip reader (store + deflate, no deps)
function safeEntryName(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.includes('\0') || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').some((s) => s === '..')) return null;
  return n;
}
/** Parse the central directory. Throws on anything suspicious. Returns [{name, dir, method, csize, usize, offset}] */
function readZipEntries(buf) {
  let i = buf.length - 22; const min = Math.max(0, buf.length - 22 - 65535);
  for (; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) break;
  if (i < min) throw new Error('Not a valid .zip file (end-of-central-directory record not found)');
  const total = buf.readUInt16LE(i + 10), cdOff = buf.readUInt32LE(i + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw new Error('zip64 archives are not supported');
  if (total > LIMITS.zipEntries) throw new Error('Zip has too many entries (' + total + ' > ' + LIMITS.zipEntries + ')');
  const out = []; let p = cdOff, sum = 0;
  for (let k = 0; k < total; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), ext = buf.readUInt32LE(p + 38), offset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + el + cl;
    const name = safeEntryName(rawName);
    if (!name) throw new Error('Unsafe path in zip (path traversal rejected): "' + rawName + '"');
    if (flags & 1) throw new Error('Encrypted zip entries are not supported');
    if (((ext >>> 16) & 0xf000) === 0xa000) throw new Error('Symbolic links in zip are rejected: "' + rawName + '"');
    const dir = name.endsWith('/');
    if (!dir) {
      if (method !== 0 && method !== 8) throw new Error('Unsupported compression method ' + method + ' for "' + rawName + '"');
      if (usize > LIMITS.zipFile) throw new Error('"' + rawName + '" is too large (' + usize + ' bytes)');
      sum += usize; if (sum > LIMITS.zipTotal) throw new Error('Zip expands to more than ' + (LIMITS.zipTotal >> 20) + ' MB');
    }
    out.push({ name, dir, method, csize, usize, offset });
  }
  return out;
}
/** Extract `buf` (a zip) into `dest` (must exist or be creatable). Validates every entry BEFORE writing anything. */
function extractZip(buf, dest) {
  const entries = readZipEntries(buf); const base = path.resolve(dest);
  const targets = entries.map((e) => { const t = path.resolve(base, e.name); if (t !== base && !t.startsWith(base + path.sep)) throw new Error('Unsafe path in zip (path traversal rejected): "' + e.name + '"'); return t; });
  fs.mkdirSync(base, { recursive: true });
  entries.forEach((e, k) => {
    if (e.dir) { fs.mkdirSync(targets[k], { recursive: true }); return; }
    const o = e.offset; if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new Error('Corrupt zip entry "' + e.name + '"');
    const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
    const raw = buf.subarray(start, start + e.csize);
    const data = e.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: Math.min(e.usize + 1, LIMITS.zipFileBytes) });
    if (data.length !== e.usize) throw new Error('Size mismatch for "' + e.name + '" (zip bomb or corrupt archive)');
    fs.mkdirSync(path.dirname(targets[k]), { recursive: true }); fs.writeFileSync(targets[k], data);
  });
  return entries.length;
}

// ------------------------------------------------------------------ private-network guard for the fetch proxy
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase(); if (l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l)) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); return m ? isPrivateIp(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
async function assertPublic(urlStr, allowLocal) {
  const u = new URL(urlStr);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs can be fetched');
  if (allowLocal) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Blocked: ' + host + ' is on a private/local network (needs the "network.local" permission)');
  return u;
}

// ------------------------------------------------------------------ scaffolding templates
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const j = (o) => JSON.stringify(o, null, 2) + '\n';
const README = (name, extra) => `# ${name}\n\nA Reva plugin. Edit \`index.js\`: Reva hot-reloads the plugin whenever a file in this folder changes.\n\n${extra || ''}\n## Quick reference\n\n- \`exports.activate(reva)\` runs when an activation event fires (see \`activation\` in plugin.json); \`exports.deactivate()\` is optional.\n- Everything you register through \`reva.*\` is cleaned up automatically when the plugin is disabled or reloaded.\n- Permissions you list in plugin.json are enforced: calling an API without its permission throws a clear error.\n- Plugins are trusted code with full access to Reva - only install plugins you trust.\n`;
const TEMPLATES = {
  command: (id, name) => ({
    manifest: { id, name, version: '0.1.0', description: 'A command in the command palette.', author: '', main: 'index.js', reva: '>=0.3.0', activation: ['onStartup'], permissions: [], contributes: { commands: [{ id: 'sayHello', title: name + ': Say Hello' }] } },
    files: { 'index.js': `// ${name}\n// A command that shows up in the command palette (Ctrl+Shift+P) and shows a toast.\nexports.activate = (reva) => {\n  reva.commands.register('sayHello', () => {\n    reva.ui.toast('Hello from ${name}!');\n    reva.log.info('sayHello ran');\n  });\n};\n\nexports.deactivate = () => {};\n` },
  }),
  sidebar: (id, name) => ({
    manifest: { id, name, version: '0.1.0', description: 'A sidebar panel.', author: '', main: 'index.js', reva: '>=0.3.0', activation: ['onStartup'], permissions: ['workspace.read'], contributes: { sidebarPanels: [{ id: 'main', title: name, icon: 'list' }] } },
    files: { 'index.js': `// ${name}\n// A sidebar panel. render() is called every time the panel is shown or refreshed.\nexports.activate = (reva) => {\n  const { h } = reva.ui;\n  const panel = reva.ui.addSidebarPanel({\n    id: 'main', title: '${name}', icon: 'list',\n    async render(container) {\n      container.replaceChildren(\n        h('div', { class: 'u-note', style: { padding: '14px' } }, 'Workspace: ' + (reva.workspace.root || '(no folder open)')),\n        h('button', { class: 'btn sm', style: { margin: '0 14px' }, onclick: () => panel.refresh() }, 'Refresh'));\n    },\n  });\n};\n` },
  }),
  theme: (id, name) => ({
    manifest: { id, name, version: '0.1.0', description: 'A colour theme.', author: '', main: '', reva: '>=0.3.0', activation: ['onStartup'], permissions: [], contributes: { themes: [{ id: 'main', name, file: 'theme.json' }] } },
    files: { 'theme.json': j({ name, dark: true, v: { bg: '#101418', bg1: '#161b21', bg2: '#1d242c', bg3: '#27303a', border: '#2b343e', fg: '#e6eaee', fg2: '#a9b3bd', fg3: '#6b7683', accent: '#5eb4ff', accent2: '#9ad1ff' }, t: { keyword: '5eb4ff', string: 'a5e075', number: 'ffb86b', comment: '5c6773', type: '7ee0d0', func: 'ffd479', variable: 'e6eaee', operator: 'ff8ad8' } }) },
  }),
  tool: (id, name) => ({
    manifest: { id, name, version: '0.1.0', description: 'A tool that Claude, Codex and OpenCode can call.', author: '', main: 'index.js', reva: '>=0.3.0', activation: ['onStartup'], permissions: ['agents'], contributes: { agentTools: [{ name: 'echo', description: 'Echoes the given text back. Replace me with something useful.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] } }] } },
    files: { 'index.js': `// ${name}\n// Agent tools are exposed to every agent through Reva's built-in MCP server as "${id.replace(/-/g, '-')}__<name>".\nexports.activate = (reva) => {\n  reva.agents.registerTool({\n    name: 'echo',\n    description: 'Echoes the given text back. Replace me with something useful.',\n    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] },\n    // return a string, {text}, or {content:[{type:'text'|'image', ...}]}; throw to report an error to the agent\n    handler: async ({ text }) => 'You said: ' + text,\n  });\n};\n` },
  }),
  language: (id, name) => ({
    manifest: { id, name, version: '0.1.0', description: 'A language with snippets.', author: '', main: 'index.js', reva: '>=0.3.0', activation: ['onStartup'], permissions: [], contributes: { languages: [{ id: 'mylang', extensions: ['.mylang'], aliases: ['My Language'] }], snippets: [{ language: 'mylang', file: 'snippets.json' }] } },
    files: {
      'snippets.json': j({ 'Say hello': { prefix: 'hello', body: ['print "Hello, ${1:world}!"', '$0'], description: 'Print a greeting' } }),
      'index.js': `// ${name}\n// The language + snippets are declared in plugin.json. Use code to add more: a simple highlighter and a hover.\nexports.activate = (reva) => {\n  reva.editor.registerHoverProvider('mylang', { provideHover: ({ word }) => (word === 'print' ? 'Prints a value.' : null) });\n};\n`,
    },
  }),
};

// ------------------------------------------------------------------ register
function register({ ipcMain, send, app }) {
  const userData = () => app.getPath('userData');
  const userDir = () => path.join(userData(), 'plugins');
  const dataDir = (id) => path.join(userData(), 'plugin-data', id);
  const builtinDir = path.join(__dirname, 'plugins-builtin');
  const stateFile = () => path.join(userData(), 'plugins-state.json');
  const wsDir = (ws) => (ws ? path.join(ws, '.reva', 'plugins') : null);
  const wsKey = (ws) => String(ws || '').toLowerCase().replace(/[\\/]+$/, '');
  const appVersion = () => { try { return app.getVersion(); } catch { return '0.3.0'; } };

  // ---- persisted state: { global:{id:bool}, projects:{wsKey:{id:bool}}, granted:{id:{permissions:[],version,at}} }
  let state = null;
  const loadState = () => { if (state) return state; try { state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { state = {}; } state.global = state.global || {}; state.projects = state.projects || {}; state.granted = state.granted || {}; return state; };
  const saveState = () => { try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2)); } catch { /* read-only profile */ } };
  const effective = (st, id, ws, source) => {
    const proj = ws && st.projects[wsKey(ws)] ? st.projects[wsKey(ws)][id] : undefined;
    if (proj !== undefined) return !!proj;
    return source === 'workspace' ? false : !!st.global[id];
  };

  // ---- scanning
  function readEntry(dir, folder, source) {
    const full = path.join(dir, folder); const e = { id: folder, folder, dir: full, source, manifest: null, errors: [], warnings: [] };
    const mf = path.join(full, 'plugin.json');
    if (!fs.existsSync(mf)) { e.errors.push('plugin.json not found in ' + full); return e; }
    let raw;
    try { raw = JSON.parse(fs.readFileSync(mf, 'utf8').replace(/^﻿/, '')); } catch (x) { e.errors.push('plugin.json is not valid JSON: ' + x.message); return e; }
    const v = validateManifest(raw, { dir: full, appVersion: appVersion() });
    e.manifest = v.manifest; e.errors = v.errors; e.warnings = v.warnings;
    if (v.manifest && typeof v.manifest.id === 'string' && v.manifest.id) e.id = v.manifest.id;
    if (v.manifest && v.manifest.id && v.manifest.id !== folder && source !== 'builtin') e.warnings.push('folder name "' + folder + '" differs from id "' + v.manifest.id + '"');
    return e;
  }
  function scan(dir, source) {
    let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_')).map((d) => d.name); } catch { return []; }
    return names.map((n) => readEntry(dir, n, source));
  }
  function list(ws) {
    const st = loadState(); const user = scan(userDir(), 'user'), proj = scan(wsDir(ws), 'workspace'), built = scan(builtinDir, 'builtin');
    const seen = new Map(); const active = [];
    for (const e of [...user, ...proj]) {
      if (e.manifest && !e.errors.length) {
        if (seen.has(e.id)) e.errors.push('id "' + e.id + '" collides with the plugin in ' + seen.get(e.id)); else seen.set(e.id, e.dir);
      }
      active.push(e);
    }
    const userIds = new Set(user.map((e) => e.id));
    for (const e of active) {
      const g = st.granted[e.id]; const perms = (e.manifest && e.manifest.permissions) || [];
      e.enabled = !e.errors.length && effective(st, e.id, ws, e.source);
      e.globalEnabled = !!st.global[e.id]; e.projectOverride = ws && st.projects[wsKey(ws)] ? st.projects[wsKey(ws)][e.id] : undefined;
      e.missingPermissions = perms.filter((p) => !(g && g.permissions.includes(p)));
      e.granted = g ? g.permissions : [];
    }
    for (const e of built) e.installed = userIds.has(e.id);
    ensureWatch(ws);
    return { plugins: active, builtin: built, userDir: userDir(), workspaceDir: wsDir(ws), builtinDir, appVersion: appVersion(), platform: process.platform, permissions: PERMISSIONS };
  }

  // ---- watcher (hot reload)
  const watchers = new Map(); let wtimer = null; const touched = new Set(); let quietUntil = 0;
  const quiet = (ms = 1800) => { quietUntil = Date.now() + ms; };
  function ensureWatch(ws) {
    const want = [userDir(), wsDir(ws)].filter(Boolean);
    for (const d of [...watchers.keys()]) if (!want.includes(d)) { try { watchers.get(d).close(); } catch { /* gone */ } watchers.delete(d); }
    for (const d of want) {
      if (watchers.has(d)) continue;
      try { if (d === userDir()) fs.mkdirSync(d, { recursive: true }); if (!fs.existsSync(d)) continue; } catch { continue; }
      try {
        const w = fs.watch(d, { recursive: true }, (_ev, f) => {
          if (!f || Date.now() < quietUntil) return;
          const top = String(f).split(/[\\/]/)[0]; if (!top || top.startsWith('.tmp-') || top.startsWith('.')) return;
          if (/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(f)) return;
          touched.add(top); clearTimeout(wtimer);
          wtimer = setTimeout(() => { const folders = [...touched]; touched.clear(); send('plugins:changed', { folders }); }, 350);
        });
        w.on('error', () => { /* folder removed */ }); watchers.set(d, w);
      } catch { /* unsupported */ }
    }
  }

  // ---- installing / copying
  const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* busy */ } };
  function copyDir(src, dest) {
    let bytes = 0;
    fs.cpSync(src, dest, { recursive: true, filter: (s) => {
      const b = path.basename(s); if (b === '.git' || b === 'node_modules') return false;
      const st = fs.lstatSync(s); if (st.isSymbolicLink()) return false; bytes += st.size; if (bytes > LIMITS.copyTotal) throw new Error('Plugin is larger than ' + (LIMITS.copyTotal >> 20) + ' MB'); return true;
    } });
  }
  /** Validate the plugin folder `src` and copy it to the plugins folder of `target`. */
  function installFromDir(src, { target = 'user', ws, overwrite } = {}) {
    const entry = readEntry(path.dirname(src), path.basename(src), 'user');
    if (!entry.manifest || entry.errors.length) return { ok: false, code: 'invalid', error: 'Invalid plugin: ' + (entry.errors[0] || 'unknown error'), errors: entry.errors };
    const id = entry.manifest.id; const root = target === 'workspace' ? wsDir(ws) : userDir();
    if (!root) return { ok: false, error: 'Open a folder first to install a project plugin' };
    const dest = path.join(root, id);
    if (fs.existsSync(dest)) { if (!overwrite) return { ok: false, code: 'exists', id, error: 'A plugin with id "' + id + '" is already installed' }; quiet(); rmrf(dest); }
    quiet(); fs.mkdirSync(root, { recursive: true }); copyDir(src, dest); quiet(700); // swallow only the events this copy itself produces
    return { ok: true, id, dir: dest, manifest: entry.manifest, warnings: entry.warnings };
  }
  function installZip(file, opts) {
    const st = fs.statSync(file); if (st.size > LIMITS.zipTotal) return { ok: false, error: 'Zip file is larger than ' + (LIMITS.zipTotal >> 20) + ' MB' };
    const tmp = path.join(userDir(), '.tmp-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4)); quiet(4000);
    try {
      extractZip(fs.readFileSync(file), tmp);
      let root = tmp;
      if (!fs.existsSync(path.join(tmp, 'plugin.json'))) {
        const subs = fs.readdirSync(tmp, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '__MACOSX');
        if (subs.length === 1 && fs.existsSync(path.join(tmp, subs[0].name, 'plugin.json'))) root = path.join(tmp, subs[0].name);
        else return { ok: false, error: 'No plugin.json found at the top level of the zip (or in a single top-level folder)' };
      }
      return installFromDir(root, opts);
    } catch (e) { return { ok: false, code: 'unsafe', error: e.message }; } finally { rmrf(tmp); quiet(700); }
  }

  // ---- IPC
  const wrap = (fn) => async (_e, a) => { try { return await fn(a || {}); } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; } };
  ipcMain.handle('plugins:list', wrap((a) => list(a.ws)));
  ipcMain.handle('plugins:setEnabled', wrap(({ id, enabled, scope, ws, grant }) => {
    const st = loadState();
    if (scope === 'project' && ws) { const p = (st.projects[wsKey(ws)] = st.projects[wsKey(ws)] || {}); if (enabled === null) delete p[id]; else p[id] = !!enabled; }
    else st.global[id] = !!enabled;
    if (Array.isArray(grant)) st.granted[id] = { permissions: grant.filter((p) => PERMISSIONS.includes(p)), at: Date.now() };
    saveState(); return { ok: true };
  }));
  ipcMain.handle('plugins:setMode', wrap(({ id, mode, ws }) => { // 'all' | 'project' | 'off'
    const st = loadState(); const k = wsKey(ws); const p = k ? (st.projects[k] = st.projects[k] || {}) : {};
    if (mode === 'all') { st.global[id] = true; delete p[id]; } else if (mode === 'project') { st.global[id] = false; if (k) p[id] = true; } else { st.global[id] = false; delete p[id]; }
    saveState(); return { ok: true };
  }));
  ipcMain.handle('plugins:grant', wrap(({ id, permissions }) => { const st = loadState(); st.granted[id] = { permissions: (permissions || []).filter((p) => PERMISSIONS.includes(p)), at: Date.now() }; saveState(); return { ok: true }; }));
  ipcMain.handle('plugins:install', wrap(({ from, target, ws, overwrite }) => {
    if (!from || !fs.existsSync(from)) return { ok: false, error: 'Path not found: ' + from };
    const r = fs.statSync(from).isDirectory() ? installFromDir(from, { target, ws, overwrite }) : /\.zip$/i.test(from) ? installZip(from, { target, ws, overwrite }) : { ok: false, error: 'Choose a plugin folder or a .zip file' };
    return r;
  }));
  ipcMain.handle('plugins:installBuiltin', wrap(({ id, overwrite }) => {
    const src = path.join(builtinDir, path.basename(String(id))); if (!fs.existsSync(src)) return { ok: false, error: 'No built-in plugin "' + id + '"' };
    return installFromDir(src, { target: 'user', overwrite });
  }));
  ipcMain.handle('plugins:uninstall', wrap(({ id, dir, keepData }) => {
    const d = path.resolve(String(dir || ''));
    const okRoot = d.startsWith(path.resolve(userDir()) + path.sep) || d.includes(path.sep + '.reva' + path.sep + 'plugins' + path.sep);
    if (!okRoot || !fs.existsSync(d)) return { ok: false, error: 'Not an installed plugin folder: ' + d };
    quiet(); rmrf(d); quiet(700);
    const st = loadState(); delete st.global[id]; delete st.granted[id]; for (const p of Object.values(st.projects)) delete p[id]; saveState();
    if (!keepData) rmrf(dataDir(id));
    return { ok: true };
  }));
  ipcMain.handle('plugins:create', wrap(({ name, id, template, scope, ws }) => {
    name = String(name || '').trim(); if (!name) return { ok: false, error: 'Give the plugin a name' };
    id = slug(id || name); if (!ID_RE.test(id) || id.length < 2) return { ok: false, error: 'Could not make a valid id from "' + name + '" (use letters/digits, 2+ characters)' };
    const tpl = TEMPLATES[template || 'command']; if (!tpl) return { ok: false, error: 'Unknown template "' + template + '"' };
    const root = scope === 'workspace' ? wsDir(ws) : userDir(); if (!root) return { ok: false, error: 'Open a folder first to create a project plugin' };
    const dir = path.join(root, id); if (fs.existsSync(dir)) return { ok: false, error: 'A plugin folder "' + id + '" already exists' };
    const t = tpl(id, name); quiet();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), j(t.manifest));
    for (const [f, c] of Object.entries(t.files)) fs.writeFileSync(path.join(dir, f), c);
    fs.writeFileSync(path.join(dir, 'README.md'), README(name)); quiet(700);
    return { ok: true, id, dir, mainPath: path.join(dir, t.manifest.main || 'plugin.json') };
  }));
  ipcMain.handle('plugins:templates', () => Object.keys(TEMPLATES));
  ipcMain.handle('plugins:readMain', wrap(({ dir, main }) => {
    const f = inside(dir, main); if (!f) return { ok: false, error: 'main escapes the plugin folder' };
    const st = fs.statSync(f); if (st.size > 4 << 20) return { ok: false, error: 'main script is larger than 4 MB' };
    return { ok: true, code: fs.readFileSync(f, 'utf8'), file: f };
  }));
  ipcMain.handle('plugins:readFile', wrap(({ dir, file }) => { const f = inside(dir, file); if (!f) return { ok: false, error: 'path escapes the plugin folder' }; return { ok: true, text: fs.readFileSync(f, 'utf8').replace(/^﻿/, ''), file: f }; }));
  ipcMain.handle('plugins:openFolder', wrap(({ which, ws }) => {
    const { shell } = require('electron'); const d = which === 'workspace' ? wsDir(ws) : which === 'builtin' ? builtinDir : which && fs.existsSync(which) ? which : userDir();
    fs.mkdirSync(d, { recursive: true }); shell.openPath(d); return { ok: true, dir: d };
  }));

  // ---- per-plugin storage (JSON file, cached in memory, written through)
  const store = new Map();
  const loadStore = (id) => { if (!store.has(id)) { let o = {}; try { o = JSON.parse(fs.readFileSync(path.join(dataDir(id), 'storage.json'), 'utf8')); } catch { /* new */ } store.set(id, isObj(o) ? o : {}); } return store.get(id); };
  ipcMain.handle('plugins:storage', wrap(({ id, op, key, value }) => {
    if (!ID_RE.test(String(id))) return { ok: false, error: 'bad plugin id' };
    const o = loadStore(id);
    if (op === 'get') return { ok: true, value: o[key] === undefined ? null : o[key], has: key in o };
    if (op === 'keys') return { ok: true, keys: Object.keys(o) };
    if (op === 'all') return { ok: true, value: o };
    if (op === 'set') o[key] = value; else if (op === 'delete') delete o[key]; else if (op === 'clear') for (const k of Object.keys(o)) delete o[k]; else return { ok: false, error: 'bad op' };
    const text = JSON.stringify(o); if (text.length > LIMITS.storage) { if (op === 'set') delete o[key]; return { ok: false, error: 'Plugin storage is limited to ' + (LIMITS.storage >> 10) + ' KB' }; }
    fs.mkdirSync(dataDir(id), { recursive: true }); fs.writeFileSync(path.join(dataDir(id), 'storage.json'), text); return { ok: true };
  }));

  // ---- fetch proxy: runs in main so plugins are not bound by CORS; refuses private networks unless allowed
  ipcMain.handle('plugins:fetch', wrap(async ({ url, method, headers, body, local, timeout }) => {
    let cur = String(url); const ctl = AbortSignal.timeout(Math.min(+timeout || LIMITS.fetchMs, 60000));
    for (let hop = 0; hop < 6; hop++) {
      await assertPublic(cur, !!local);
      const res = await fetch(cur, { method: method || 'GET', headers: headers || {}, body: body == null || /^(GET|HEAD)$/i.test(method || 'GET') ? undefined : body, redirect: 'manual', signal: ctl });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location'), cur).href; method = res.status === 303 ? 'GET' : method; continue; }
      const chunks = []; let n = 0;
      if (res.body) for await (const c of res.body) { n += c.length; if (n > LIMITS.fetchBody) throw new Error('Response is larger than ' + (LIMITS.fetchBody >> 20) + ' MB'); chunks.push(Buffer.from(c)); }
      const buf = Buffer.concat(chunks); const hs = {}; res.headers.forEach((v, k) => { hs[k] = v; });
      return { ok: true, status: res.status, statusText: res.statusText, url: cur, headers: hs, body: buf.toString('utf8'), bodyBase64: /^(text|application\/(json|xml|javascript))/i.test(hs['content-type'] || '') ? undefined : buf.toString('base64') };
    }
    throw new Error('Too many redirects');
  }));

  // ---- agent tools declared by plugins (renderer pushes the current list; ide-mcp merges it into tools/list)
  let tools = [];
  ipcMain.handle('plugins:tools:set', wrap((a) => {
    const list = Array.isArray(a.list) ? a.list : Array.isArray(a) ? a : [];
    tools = list.filter((t) => t && typeof t.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*__[a-zA-Z][a-zA-Z0-9_]*$/.test(t.name))
      .map((t) => ({ name: t.name, title: t.title || t.name, description: String(t.description || '').slice(0, 2000), inputSchema: isObj(t.inputSchema) ? t.inputSchema : { type: 'object', properties: {} }, readOnly: !!t.readOnly }));
    return { ok: true, count: tools.length };
  }));
  const getExtraTools = () => tools.slice();

  return { getExtraTools, list, validateManifest, extractZip, satisfies, installFromDir, TEMPLATES };
}

module.exports = { register, validateManifest, satisfies, extractZip, readZipEntries, isPrivateIp, PERMISSIONS };
