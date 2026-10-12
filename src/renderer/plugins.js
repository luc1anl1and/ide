// Reva plugin runtime (renderer). Loads plugins from the main process (src/plugins.js), evaluates their `main` script with a
// per-plugin `reva` API object, and keeps every registration owned by the plugin so it can be removed again.
//
// Public surface:  window.RevaPlugins  (see the object at the bottom). The manager UI lives in plugins-ui.js.
//
// SECURITY: plugins are trusted code - they run in this renderer with the same power as Reva itself. `permissions` are
// declared in plugin.json, approved by the user, and enforced on the `reva.*` API (clear errors), but this is NOT a sandbox.
(function () {
  'use strict';
  const PAPI = () => (window.api && window.api.plugins) || window.apiPlugins;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MAX_ERRORS = 5;            // consecutive callback errors before a plugin is auto-disabled
  const SLOW_ACTIVATE_MS = 5000;   // warn
  const HARD_ACTIVATE_MS = 20000;  // give up
  const LOG_CAP = 500;

  const PERM_INFO = {
    'workspace.read': ['Read files', 'Read files and the active editor text in your workspace'],
    'workspace.write': ['Write files', 'Create or change files and edit text in the editor'],
    terminal: ['Terminal', 'Run commands in the IDE terminal and read its output'],
    network: ['Network', 'Make requests to public web addresses'],
    'network.local': ['Local network', 'Also reach localhost and private network addresses'],
    chat: ['Chat', 'Send messages, add slash commands and watch the chat'],
    agents: ['Agent tools', 'Give Claude, Codex and OpenCode new tools'],
    preview: ['Browser preview', 'Open the preview, take screenshots, read its console'],
    settings: ['App settings', 'Read and change Reva\'s own settings and theme'],
  };

  // ------------------------------------------------------------------ state
  const recs = new Map();        // dir(lowercase) -> rec
  let meta = { userDir: '', builtinDir: '', appVersion: '0.3.0', platform: 'win32' };
  let builtinList = [];
  const changeCbs = new Set();
  let inited = false, hookWired = false;

  const cmds = new Map();        // fullId -> {id, pluginId, fn, title, keybinding}
  const panelReg = new Map();    // 'plugin:pid:local' -> def
  const statusReg = [];          // status items registered by code
  const slashReg = [];
  const toolReg = new Map();     // 'pid__name' -> {pluginId, def, handler}
  const titleBtns = [];
  const hooks = { beforeSend: [], agentEvent: [], save: [], willSave: [], active: [], text: [], selection: [], fs: [], wsOpen: [] };
  const bus = new Map();
  const settingCbs = new Map();  // pid -> Set(cb)
  const lastSaved = new Map();

  let changeQueued = false;
  function notify() { if (changeQueued) return; changeQueued = true; setTimeout(() => { changeQueued = false; for (const cb of [...changeCbs]) { try { cb(); } catch (e) { console.error(e); } } }, 0); }

  const byId = (id) => { let any = null; for (const r of recs.values()) if (r.id === id) { if (!r.info.errors.length) return r; any = any || r; } return any; };
  // plugins whose contributions are currently visible (enabled, approved, not failed)
  const live = () => [...recs.values()].filter((r) => ['idle', 'activating', 'active'].includes(r.status) && r.manifest);

  // ------------------------------------------------------------------ logging + error isolation
  function log(rec, level, ...args) {
    const msg = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
    rec.logs.push({ t: Date.now(), level, msg }); if (rec.logs.length > LOG_CAP) rec.logs.splice(0, rec.logs.length - LOG_CAP);
    if (level === 'error' || A.settings.pluginDev) (console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'])('[plugin ' + rec.id + ']', msg);
    for (const cb of [...logCbs]) { try { cb(rec, level, msg); } catch { /* ui gone */ } }
  }
  const logCbs = new Set();
  const okCall = (rec) => { rec.consecutive = 0; };
  function fail(rec, e, label) {
    const msg = e && e.message ? e.message : String(e);
    log(rec, 'error', (label ? '[' + label + '] ' : '') + (e && e.stack ? e.stack : msg));
    rec.consecutive = (rec.consecutive || 0) + 1; rec.errorCount = (rec.errorCount || 0) + 1;
    if (!rec.toasted) { rec.toasted = true; toast('Plugin “' + rec.name + '” failed' + (label ? ' in ' + label : '') + ': ' + msg.split('\n')[0].slice(0, 140), true); }
    if (rec.consecutive >= MAX_ERRORS && rec.status !== 'error') autoDisable(rec, 'Disabled automatically after ' + MAX_ERRORS + ' consecutive errors. Last: ' + msg.split('\n')[0]);
    notify();
  }
  async function autoDisable(rec, why) {
    log(rec, 'error', why); toast('Plugin “' + rec.name + '” was disabled: ' + why.slice(0, 120), true);
    rec.autoDisabled = why; await teardown(rec); rec.status = 'error'; rec.error = why;
    try { await PAPI().setEnabled({ id: rec.id, enabled: false, scope: rec.source === 'workspace' ? 'project' : 'global', ws: A.ws }); rec.info.enabled = false; } catch { /* ignore */ }
    notify();
  }
  /** Wrap a plugin callback: errors are logged, toasted once, counted; the call never throws into Reva (unless rethrow). */
  function guard(rec, fn, label, rethrow) {
    return function (...a) {
      try {
        const r = fn.apply(this, a);
        if (r && typeof r.then === 'function') return r.then((v) => { okCall(rec); return v; }, (e) => { fail(rec, e, label); if (rethrow) throw e; });
        okCall(rec); return r;
      } catch (e) { fail(rec, e, label); if (rethrow) throw e; }
    };
  }
  const withTimeout = (p, ms, msg) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(msg)), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

  // ------------------------------------------------------------------ small helpers
  const isAbs = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
  const resolvePath = (p) => { p = String(p || ''); if (isAbs(p)) return p.replace(/\//g, '\\'); if (!A.ws) throw new Error('No workspace folder is open'); return joinp(A.ws, p.replace(/\//g, '\\')); };
  function fixPath(p) { p = String(p).replace(/\//g, '\\'); if (A.ws && p.toLowerCase().startsWith(A.ws.toLowerCase())) return A.ws + p.slice(A.ws.length); return p.replace(/^[a-z]:/, (m) => m.toUpperCase()); }
  const editorInst = () => (window.monaco && monaco.editor.getEditors ? monaco.editor.getEditors()[0] : null);
  const rel = (p) => { const r = relp(p); return r.replace(/\\/g, '/'); };
  function globToRe(glob) {
    let g = String(glob || '**'); if (!g.includes('/')) g = '**/' + g;
    let re = ''; for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*') { if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*'; }
      else if (c === '?') re += '[^/]'; else if (c === '{') { const j = g.indexOf('}', i); if (j > 0) { re += '(?:' + g.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|\\\[\]]/g, '\\$&')).join('|') + ')'; i = j; } else re += '\\{'; }
      else re += c.replace(/[.+^$()|\\\[\]}]/g, '\\$&');
    }
    return new RegExp('^' + re + '$', 'i');
  }
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'target', '.reva']);
  async function walkFiles(root, re, max) {
    const out = [];
    async function walk(dir, depth) {
      if (out.length >= max || depth > 10) return;
      const ents = await api.fs.readdir(dir); if (!Array.isArray(ents)) return;
      for (const e of ents) {
        if (out.length >= max) return; const full = joinp(dir, e.name);
        if (e.dir) { if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1); } else if (re.test(rel(full))) out.push(full);
      }
    }
    await walk(root, 0); return out;
  }
  function toolText(r) {
    if (r == null) return { content: [{ type: 'text', text: 'OK' }] };
    if (typeof r === 'string') return { content: [{ type: 'text', text: r }] };
    if (Array.isArray(r.content)) return { content: r.content, ...(r.isError ? { isError: true } : {}) };
    if (typeof r.text === 'string') return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
    if (r.image) return { content: [{ type: 'image', data: r.image, mimeType: r.mimeType || 'image/png' }] };
    try { return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; } catch { return { content: [{ type: 'text', text: String(r) }] }; }
  }

  // ------------------------------------------------------------------ keybindings
  function parseCombo(s) {
    const parts = String(s).split('+').map((x) => x.trim()); const key = parts.pop().toLowerCase(); const c = { mod: false, shift: false, alt: false, key };
    for (const p of parts.map((x) => x.toLowerCase())) { if (/^(ctrl|cmd|mod|ctrlcmd|control|meta)$/.test(p)) c.mod = true; else if (p === 'shift') c.shift = true; else if (/^(alt|option)$/.test(p)) c.alt = true; }
    return c;
  }
  const NAMED = { enter: 'Enter', space: 'Space', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', up: 'UpArrow', down: 'DownArrow', left: 'LeftArrow', right: 'RightArrow', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote', "'": 'Quote', '\\': 'Backslash' };
  function monacoKey(s) {
    const c = parseCombo(s); const K = monaco.KeyCode, M = monaco.KeyMod; let code;
    if (/^[a-z]$/.test(c.key)) code = K['Key' + c.key.toUpperCase()]; else if (/^[0-9]$/.test(c.key)) code = K['Digit' + c.key]; else if (/^f([1-9]|1[0-2])$/.test(c.key)) code = K[c.key.toUpperCase()]; else if (NAMED[c.key]) code = K[NAMED[c.key]];
    if (code === undefined) throw new Error('Unsupported keybinding "' + s + '"');
    return (c.mod ? M.CtrlCmd : 0) | (c.shift ? M.Shift : 0) | (c.alt ? M.Alt : 0) | code;
  }
  function keyMatches(e, c) {
    if ((e.ctrlKey || e.metaKey) !== c.mod || e.shiftKey !== c.shift || e.altKey !== c.alt) return false;
    const k = e.key.toLowerCase(); return k === c.key || (c.key === 'esc' && k === 'escape') || (c.key === 'space' && k === ' ') || (c.key.length === 1 && e.code && e.code.toLowerCase() === 'key' + c.key);
  }
  function onGlobalKey(e) {
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return; // plain typing is never a plugin shortcut
    const hit = (id, kb) => { try { return keyMatches(e, parseCombo(kb)); } catch { return false; } };
    for (const r of live()) for (const c of r.manifest.contributes.commands) if (c.keybinding && hit(c.id, c.keybinding)) { e.preventDefault(); e.stopImmediatePropagation(); executeCommand(qualify(r.id, c.id)); return; }
    for (const c of cmds.values()) if (c.keybinding && hit(c.id, c.keybinding)) { e.preventDefault(); e.stopImmediatePropagation(); executeCommand(c.id); return; }
  }

  // ------------------------------------------------------------------ commands
  const qualify = (pid, id) => (String(id).startsWith(pid + '.') ? String(id) : pid + '.' + id);
  function ownerOfCommand(full) { for (const r of live()) for (const c of r.manifest.contributes.commands) if (qualify(r.id, c.id) === full) return r; return null; }
  async function executeCommand(full, ...args) {
    // plugins that wait for this command (activation event onCommand:<id>) are woken first
    for (const r of live()) if (r.status === 'idle' && r.manifest.activation.some((a) => a.startsWith('onCommand:') && (a.slice(10) === full || qualify(r.id, a.slice(10)) === full))) await activate(r);
    let c = cmds.get(full);
    if (!c) { const o = ownerOfCommand(full); if (o) { await activate(o); c = cmds.get(full); } }
    if (!c) throw new Error('Unknown command: ' + full);
    return c.fn(...args);
  }

  // ------------------------------------------------------------------ declarative contributions that touch Reva globals
  let langRegistered = new Set();
  function slugName(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function registerTheme(rec, json, localId, track) {
    if (!json || typeof json !== 'object' || !json.v || !json.t) throw new Error('theme must look like {name, dark, v:{...}, t:{...}}');
    const id = 'p-' + rec.id + '-' + slugName(localId || json.id || json.name || 'theme');
    const base = THEMES.amethyst; const th = { name: json.name || localId || id, dark: json.dark !== false, v: { ...base.v, ...json.v }, t: { ...base.t, ...json.t }, plugin: rec.id };
    THEMES[id] = th;
    if (window.monaco && window.__monacoReady) defineMonacoThemes(monaco, A.settings.accent);
    if (A.settings.theme === id) applySettings('theme');
    const d = { dispose() {
      if (THEMES[id] !== th) return; delete THEMES[id];
      if (A.settings.theme === id) { try { applyTheme('amethyst', A.settings.accent); if (window.monaco) monaco.editor.setTheme('am-amethyst'); } catch { /* ignore */ } } // visual fallback only; the saved preference stays
      updateStatus && updateStatus();
    } };
    if (track) track(d); return { id, dispose: d.dispose };
  }
  function ensureLanguage(def, track) {
    const M = window.monaco; if (!M) return;
    const exts = (def.extensions || []).map((e) => (e.startsWith('.') ? e : '.' + e));
    const key = def.id + '|' + exts.join(','); // Monaco cannot unregister a language, so register each (id, extensions) once per session
    if (!langRegistered.has(key)) { langRegistered.add(key); M.languages.register({ id: def.id, extensions: exts, aliases: def.aliases || [def.id], mimetypes: def.mimetypes }); }
    // models that are already open with a matching extension but fell back to plain text
    for (const m of M.editor.getModels()) { if (m.getLanguageId() === 'plaintext' && exts.some((x) => m.uri.path.toLowerCase().endsWith(x.toLowerCase()))) M.editor.setModelLanguage(m, def.id); }
    if (def.configuration && typeof def.configuration === 'object') { const d = M.languages.setLanguageConfiguration(def.id, def.configuration); track && track(d); }
  }
  function snippetItems(snips) {
    const list = Array.isArray(snips) ? snips : Object.entries(snips || {}).map(([name, s]) => ({ name, ...s }));
    const out = [];
    for (const s of list) {
      const body = Array.isArray(s.body) ? s.body.join('\n') : String(s.body == null ? '' : s.body);
      for (const prefix of [].concat(s.prefix || s.name || [])) out.push({ label: prefix, detail: s.name || s.description || 'snippet', documentation: s.description || '', insertText: body, snippet: true });
    }
    return out;
  }
  function addCompletion(language, provider, track) {
    const M = monaco;
    const d = M.languages.registerCompletionItemProvider(language, {
      triggerCharacters: provider.triggerCharacters,
      async provideCompletionItems(model, pos) {
        const w = model.getWordUntilPosition(pos); const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
        const ctx = { path: model.uri.scheme === 'file' ? fixPath(model.uri.fsPath) : '', language, word: w.word, line: pos.lineNumber, column: pos.column, linePrefix: model.getValueInRange({ startLineNumber: pos.lineNumber, startColumn: 1, endLineNumber: pos.lineNumber, endColumn: pos.column }), text: model.getValue() };
        const items = (await provider.provideCompletionItems(ctx)) || [];
        return { suggestions: items.map((it) => ({
          label: it.label, kind: M.languages.CompletionItemKind[it.kind ? String(it.kind)[0].toUpperCase() + String(it.kind).slice(1) : (it.snippet ? 'Snippet' : 'Text')] ?? M.languages.CompletionItemKind.Text,
          detail: it.detail, documentation: it.documentation, insertText: it.insertText == null ? String(it.label) : it.insertText, sortText: it.sortText, filterText: it.filterText,
          insertTextRules: it.snippet ? M.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined, range,
        })) };
      },
    });
    track && track(d); return d;
  }

  async function applyContrib(rec) {
    if (rec.applied) return; rec.applied = true; const c = rec.manifest.contributes; const track = (d) => rec.contribDisp.push(d);
    const read = async (f) => { const r = await PAPI().readFile({ dir: rec.dir, file: f }); if (!r.ok) throw new Error(r.error); return JSON.parse(r.text); };
    for (const t of c.themes) { try { registerTheme(rec, await read(t.file), t.id, track); } catch (e) { log(rec, 'error', 'theme ' + t.id + ': ' + e.message); } }
    if (window.monaco) {
      for (const l of c.languages) { try { const conf = typeof l.configuration === 'string' ? await read(l.configuration) : l.configuration; ensureLanguage({ ...l, configuration: conf }, track); } catch (e) { log(rec, 'error', 'language ' + l.id + ': ' + e.message); } }
      for (const s of c.snippets) { try { const items = snippetItems(await read(s.file)); addCompletion(s.language, { provideCompletionItems: () => items }, track); } catch (e) { log(rec, 'error', 'snippets ' + s.file + ': ' + e.message); } }
      const ed = editorInst();
      if (ed) for (const m of c.menus['editor/context'] || []) {
        const full = qualify(rec.id, m.command); const decl = c.commands.find((x) => qualify(rec.id, x.id) === full);
        track(ed.addAction({ id: rec.id + '.ctx.' + m.command, label: m.title || (decl && decl.title) || m.command, contextMenuGroupId: 'plugins', contextMenuOrder: 5,
          run: () => { const exts = m.when && m.when.extensions; const af = activeFileInfo(false); if (exts && af && !exts.map((x) => x.replace(/^\./, '').toLowerCase()).includes(extOf(af.path))) return; executeCommand(full, { path: af && af.path }).catch((e) => fail(rec, e, 'menu')); } }));
      }
    }
  }
  function unapplyContrib(rec) { const d = rec.contribDisp.splice(0); for (const x of d.reverse()) { try { x.dispose(); } catch { /* ignore */ } } rec.applied = false; }

  // ------------------------------------------------------------------ editor helpers
  function activeFileInfo(withText) {
    const e = editorInst(); const m = e && e.getModel(); const mon = $('#monaco');
    if (!m || m.uri.scheme !== 'file' || (mon && mon.style.visibility === 'hidden')) return null;
    const sel = e.getSelection(), pos = e.getPosition(); const p = fixPath(m.uri.fsPath);
    return { path: p, name: basename(p), language: m.getLanguageId(), ...(withText ? { text: m.getValue() } : {}),
      selection: { text: m.getValueInRange(sel), empty: sel.isEmpty(), startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, endColumn: sel.endColumn }, line: pos.lineNumber, column: pos.column };
  }
  const decoStyles = new Map();
  function decoClass(o) {
    const css = [o.background ? 'background:' + o.background : '', o.color ? 'color:' + o.color : '', o.underline ? 'text-decoration:underline wavy ' + o.underline : '', o.border ? 'outline:1px solid ' + o.border : ''].filter(Boolean).join(';');
    if (!css) return undefined; let cls = decoStyles.get(css);
    if (!cls) { cls = 'pdeco-' + decoStyles.size; decoStyles.set(css, cls); document.head.append(Object.assign(document.createElement('style'), { textContent: '.' + cls + '{' + css + '}' })); }
    return cls;
  }

  // ------------------------------------------------------------------ the `reva` object handed to a plugin
  function createReva(rec) {
    const pid = rec.id;
    const track = (d) => { rec.disposables.push(d); return d; };
    const disp = (fn) => { let done = false; return track({ dispose() { if (done) return; done = true; try { fn(); } catch { /* ignore */ } } }); };
    const g = (fn, label, rethrow) => guard(rec, typeof fn === 'function' ? fn : () => {}, label, rethrow);
    const need = (perm, what) => { if (!rec.perms.has(perm)) throw new Error('Plugin “' + pid + '” needs the "' + perm + '" permission to ' + what + '. Add "' + perm + '" to "permissions" in its plugin.json and approve it again.'); };
    const on = (list, cb, label, extra) => { const e = { cb: g(cb, label), pid }; if (extra) Object.assign(e, extra); list.push(e); return disp(() => { const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); }); };
    const def0 = (key) => { const s = rec.manifest.contributes.settings.find((x) => x.key === key); return s ? s.default : undefined; };
    const sApi = async (op, key, value) => { const r = await PAPI().storage({ id: pid, op, key, value }); if (!r.ok) throw new Error(r.error); return r; };

    const reva = {
      id: pid, version: meta.appVersion, platform: meta.platform, pluginDir: rec.dir, manifest: JSON.parse(JSON.stringify(rec.manifest)),

      commands: {
        register(id, fn, m = {}) {
          const q = qualify(pid, id); const old = cmds.get(q);
          if (old && old.pluginId !== pid) throw new Error('Command "' + q + '" is already registered by plugin "' + old.pluginId + '"');
          const c = { id: q, pluginId: pid, fn: g(fn, 'command ' + q), title: m.title, keybinding: m.keybinding }; cmds.set(q, c); notify();
          return disp(() => { if (cmds.get(q) === c) cmds.delete(q); notify(); });
        },
        execute: (id, ...a) => executeCommand(cmds.has(id) || String(id).includes('.') ? id : qualify(pid, id), ...a),
        list: () => [...cmds.keys()],
      },

      ui: {
        h, icon,
        toast: (msg, kind) => toast(String(msg), kind === 'error' || kind === true),
        confirm: (title, text, o = {}) => confirmBox(title, text, o.okLabel || 'OK', !!o.danger),
        prompt: (title, o = {}) => promptBox(title, o.value || '', o.placeholder || ''),
        quickPick: (items, o) => quickPick(items, o),
        openPanelModal: (o) => openPanelModal(rec, o),
        addSidebarPanel(def) {
          if (!def || !def.id || typeof def.render !== 'function') throw new Error('addSidebarPanel needs {id, title, render(container, ctx)}');
          const full = 'plugin:' + pid + ':' + def.id; panelReg.set(full, { ...def, pluginId: pid, id: full, localId: def.id, render: g(def.render, 'panel ' + def.id) }); notify();
          const d = disp(() => { panelReg.delete(full); mounted.delete(full); notify(); });
          d.refresh = () => refreshPanel(full); d.show = () => window.Panels && Panels.show(full); d.id = full; return d;
        },
        addStatusItem(def) {
          if (!def || !def.id) throw new Error('addStatusItem needs {id, align, text}');
          const item = { id: def.id, pluginId: pid, align: def.align === 'right' ? 'right' : 'left', text: def.text || '', tooltip: def.tooltip || '', icon: def.icon || '', onClick: def.onClick ? g(def.onClick, 'status item ' + def.id) : null };
          statusReg.push(item); renderStatus(); notify();
          const d = disp(() => { const i = statusReg.indexOf(item); if (i >= 0) statusReg.splice(i, 1); if (item.el) item.el.remove(); renderStatus(); notify(); });
          d.update = (patch = {}) => { for (const k of ['text', 'tooltip', 'icon', 'align']) if (patch[k] !== undefined) item[k] = patch[k]; if (patch.onClick !== undefined) item.onClick = patch.onClick ? g(patch.onClick, 'status item ' + def.id) : null; if (patch.align !== undefined) renderStatus(); else paintItem(item); };
          return d;
        },
        addTitleBarButton(def) {
          if (!def || typeof def.onClick !== 'function') throw new Error('addTitleBarButton needs {icon, title, onClick}');
          const tb = $('.tb-right'); const ref = $('#btn-settings');
          const el = h('button', { class: 'icon-btn plug-tb', title: def.title || '', onclick: g(def.onClick, 'title bar button'), html: String(def.icon || '').startsWith('<') ? def.icon : icon(def.icon || 'plug') });
          if (tb) tb.insertBefore(el, ref || null); titleBtns.push(el);
          return disp(() => { el.remove(); const i = titleBtns.indexOf(el); if (i >= 0) titleBtns.splice(i, 1); });
        },
      },

      editor: {
        activeFile() { need('workspace.read', 'read the active editor file'); return activeFileInfo(true); },
        openFiles() { need('workspace.read', 'list open files'); return monaco.editor.getModels().filter((m) => m.uri.scheme === 'file').map((m) => fixPath(m.uri.fsPath)); },
        async openFile(p, line) { await window.openFile(resolvePath(p), line ? +line : 0); },
        insertText(text) { need('workspace.write', 'insert text into the editor'); const e = editorInst(); if (!e || !e.getModel()) throw new Error('No editor is open'); const p = e.getPosition(); e.pushUndoStop(); e.executeEdits('plugin:' + pid, [{ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text: String(text), forceMoveMarkers: true }]); e.pushUndoStop(); },
        replaceSelection(text) { need('workspace.write', 'replace the editor selection'); const e = editorInst(); if (!e || !e.getModel()) throw new Error('No editor is open'); e.pushUndoStop(); e.executeEdits('plugin:' + pid, [{ range: e.getSelection(), text: String(text), forceMoveMarkers: true }]); e.pushUndoStop(); },
        registerAction(def) {
          if (!def || !def.id || typeof def.run !== 'function') throw new Error('registerAction needs {id, label, run}');
          const e = editorInst(); if (!e) throw new Error('Editor is not ready');
          const opts = { id: pid + '.' + def.id, label: def.label || def.id, contextMenuGroupId: def.contextMenu === false ? undefined : 'plugins', contextMenuOrder: def.order || 6, run: g(() => def.run(activeFileInfo(true) || {}), 'action ' + def.id) };
          if (def.keybinding) opts.keybindings = [monacoKey(def.keybinding)];
          return track(e.addAction(opts));
        },
        onDidSave: (cb) => on(hooks.save, cb, 'onDidSave'),
        onWillSave: (cb) => on(hooks.willSave, cb, 'onWillSave'),
        onDidChangeActive: (cb) => on(hooks.active, cb, 'onDidChangeActive'),
        onDidChangeText: (cb) => on(hooks.text, cb, 'onDidChangeText'),
        onDidChangeSelection: (cb) => on(hooks.selection, cb, 'onDidChangeSelection'),
        decorate(items) {
          const e = editorInst(); if (!e) throw new Error('Editor is not ready');
          const mk = (list) => list.map((d) => ({ range: new monaco.Range(d.line || d.startLine || 1, d.startColumn || 1, d.endLine || d.line || d.startLine || 1, d.endColumn || (d.startColumn ? d.startColumn + 1 : 1e9)), options: { isWholeLine: !d.startColumn && !d.endColumn, className: decoClass(d), inlineClassName: d.inlineClass, hoverMessage: d.message ? { value: String(d.message) } : undefined, glyphMarginClassName: d.glyph } }));
          const coll = e.createDecorationsCollection(mk(items || []));
          const d = disp(() => coll.clear()); d.set = (list) => coll.set(mk(list)); d.clear = () => coll.clear(); return d;
        },
        /** Replace the whole text of the active file (one undo step). */
        setText(text) { need('workspace.write', 'change the editor text'); const e = editorInst(); const m = e && e.getModel(); if (!m) throw new Error('No editor is open'); e.pushUndoStop(); e.executeEdits('plugin:' + pid, [{ range: m.getFullModelRange(), text: String(text) }]); e.pushUndoStop(); },
        /** Syntax highlighting for a language: a Monaco Monarch definition ({tokenizer:{root:[...]}}). */
        registerTokenizer(language, monarch) { return track(monaco.languages.setMonarchTokensProvider(language, monarch)); },
        registerLanguage(def) { if (!def || !def.id) throw new Error('registerLanguage needs {id, extensions}'); ensureLanguage(def, track); },
        registerCompletionProvider(language, provider) { if (!provider || typeof provider.provideCompletionItems !== 'function') throw new Error('provider needs provideCompletionItems(ctx)'); return addCompletion(language, { ...provider, provideCompletionItems: g(provider.provideCompletionItems, 'completion ' + language, true) }, track); },
        registerHoverProvider(language, provider) {
          const fn = g(typeof provider === 'function' ? provider : provider.provideHover, 'hover ' + language, true);
          return track(monaco.languages.registerHoverProvider(language, { async provideHover(model, pos) {
            const w = model.getWordAtPosition(pos);
            const r = await fn({ word: w ? w.word : '', line: pos.lineNumber, column: pos.column, lineText: model.getLineContent(pos.lineNumber), path: model.uri.scheme === 'file' ? fixPath(model.uri.fsPath) : '' });
            if (!r) return null; const contents = [].concat(typeof r === 'string' ? [{ value: r }] : r.contents ? r.contents.map((x) => (typeof x === 'string' ? { value: x } : x)) : [{ value: String(r.text || '') }]);
            return { range: w ? new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn) : undefined, contents };
          } }));
        },
        registerSnippets(language, snippets) { return addCompletion(language, { provideCompletionItems: () => snippetItems(snippets) }, track); },
        registerFormatter(language, fn) {
          need('workspace.write', 'register a document formatter');
          const f = g(fn, 'formatter ' + language, true);
          return track(monaco.languages.registerDocumentFormattingEditProvider(language, { displayName: pid, async provideDocumentFormattingEdits(model, o) {
            const out = await f(model.getValue(), { language, tabSize: o.tabSize, insertSpaces: o.insertSpaces, path: model.uri.scheme === 'file' ? fixPath(model.uri.fsPath) : '' });
            return out == null || out === model.getValue() ? [] : [{ range: model.getFullModelRange(), text: String(out) }];
          } }));
        },
        /** Run the active editor's formatter (Monaco's built-in for JSON/JS/TS/CSS/HTML, or a registered one). */
        async format() { need('workspace.write', 'format the document'); const e = editorInst(); const a = e && e.getAction('editor.action.formatDocument'); if (!a) return false; await a.run(); return true; },
      },

      workspace: {
        get root() { return A.ws || null; },
        async readFile(p) { need('workspace.read', 'read files'); const r = await api.fs.read(resolvePath(p)); if (r.kind === 'text') return r.content.replace(/^\uFEFF/, ''); throw new Error(r.error || 'Cannot read ' + p + ' as text (' + r.kind + ')'); },
        async writeFile(p, content) {
          need('workspace.write', 'write files'); const f = resolvePath(p); let r = await api.fs.write({ file: f, content: String(content) });
          if (!r.ok && /ENOENT/.test(r.error || '')) { await api.fs.create({ file: dirname(f), dir: true }); r = await api.fs.write({ file: f, content: String(content) }); }
          if (!r.ok) throw new Error(r.error || 'write failed'); return true;
        },
        async listDir(p = '.') { need('workspace.read', 'list folders'); const d = resolvePath(p === '.' ? (A.ws || '') : p); const r = await api.fs.readdir(d); if (!Array.isArray(r)) throw new Error(r && r.error || 'Cannot list ' + p); return r.map((e) => ({ name: e.name, dir: e.dir, path: joinp(d, e.name) })); },
        async exists(p) { need('workspace.read', 'check files'); const f = resolvePath(p); if (Array.isArray(await api.fs.readdir(f))) return true; return (await api.fs.read(f)).kind !== 'error'; },
        async findFiles(glob, o = {}) { need('workspace.read', 'search for files'); if (!A.ws) return []; return walkFiles(A.ws, globToRe(glob), o.max || 2000); },
        async search(query, o = {}) { need('workspace.read', 'search file contents'); if (!A.ws) return []; return api.fs.search({ root: A.ws, query: String(query), max: o.max || 300 }); },
        watch(pattern, cb) { need('workspace.read', 'watch files'); const re = globToRe(pattern || '**'); return on(hooks.fs, (paths) => { const m = paths.filter((p) => re.test(rel(p))); if (m.length) return cb(m); }, 'watch', {}); },
        onDidChange(cb) { need('workspace.read', 'watch files'); return on(hooks.fs, cb, 'workspace.onDidChange'); },
        onDidOpen(cb) { need('workspace.read', 'watch the workspace'); return on(hooks.wsOpen, cb, 'workspace.onDidOpen'); },
      },

      chat: {
        send(text, o = {}) { need('chat', 'send chat messages'); if (o.agent) Chat.new({ provider: o.agent }); App.toggleChat(true); Chat.sendNow(String(text)); },
        insert(text) { need('chat', 'insert text into the chat box'); App.toggleChat(true); Chat.insert(String(text)); },
        newChat(o = {}) { need('chat', 'open a chat'); App.toggleChat(true); Chat.new(o.agent ? { provider: o.agent } : {}); return { id: A.activeChat && A.activeChat.id }; },
        registerSlashCommand(def) {
          need('chat', 'add slash commands');
          if (!def || !/^[\w-]+$/.test(def.name || '') || typeof def.run !== 'function') throw new Error('registerSlashCommand needs {name, description, run(args, ctx)}');
          const e = { name: def.name, description: def.description || '', pluginId: pid, run: g(def.run, 'slash /' + def.name, true) }; slashReg.push(e); notify();
          return disp(() => { const i = slashReg.indexOf(e); if (i >= 0) slashReg.splice(i, 1); notify(); });
        },
        onBeforeSend(cb) { need('chat', 'intercept outgoing messages'); return on(hooks.beforeSend, cb, 'onBeforeSend'); },
        onAgentEvent(cb) { need('chat', 'watch agent events'); return on(hooks.agentEvent, cb, 'onAgentEvent'); },
      },

      agents: {
        registerTool(def) {
          need('agents', 'register agent tools');
          if (!def || !/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(def.name || '')) throw new Error('registerTool: "name" must be letters, digits and underscores (got "' + (def && def.name) + '")');
          if (typeof def.handler !== 'function') throw new Error('registerTool needs a handler(args) function');
          if (!def.description) throw new Error('registerTool needs a description (agents read it to decide when to call the tool)');
          const full = pid + '__' + def.name; const t = { pluginId: pid, name: full, def, handler: g(def.handler, 'tool ' + def.name, true) };
          toolReg.set(full, t); pushTools(); notify();
          return disp(() => { if (toolReg.get(full) === t) toolReg.delete(full); pushTools(); notify(); });
        },
      },

      terminal: {
        async run(cmd, o = {}) { need('terminal', 'run terminal commands'); App.toggleTerm(true); if (o.newTab) await Terminals.newTab({ command: String(cmd) }); else await Terminals.runCommand(String(cmd)); },
        read(lines = 200, tab) { need('terminal', 'read terminal output'); return Terminals.read(lines, tab); },
      },

      preview: {
        async open(o = {}) { need('preview', 'open the preview'); const r = await IDE.exec('open_preview', o); if (r.isError) throw new Error(r.content[0].text); try { return JSON.parse(r.content[0].text); } catch { return {}; } },
        async screenshot(o = {}) { need('preview', 'take preview screenshots'); const r = await IDE.exec('preview_screenshot', o); if (r.isError) throw new Error(r.content[0].text); const img = r.content.find((c) => c.type === 'image'); return img ? { data: img.data, mimeType: img.mimeType } : null; },
        async console(o = {}) { need('preview', 'read the preview console'); const r = await IDE.exec('preview_console', o); if (r.isError) throw new Error(r.content[0].text); return r.content[0].text; },
      },

      settings: {
        get(key, d) { const s = pluginSettings(pid); if (key in s) return s[key]; const x = def0(key); return x !== undefined ? x : d; },
        set(key, value) { setPluginSetting(pid, key, value); },
        all() { const o = {}; for (const s of rec.manifest.contributes.settings) o[s.key] = s.default; return { ...o, ...pluginSettings(pid) }; },
        onDidChange(cb) { const set = settingCbs.get(pid) || settingCbs.set(pid, new Set()).get(pid); const f = g(cb, 'settings.onDidChange'); set.add(f); return disp(() => set.delete(f)); },
        app: {
          get(key) { need('settings', 'read Reva settings'); const v = A.settings[key]; return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; },
          set(key, v) { need('settings', 'change Reva settings'); if (key === 'plugins') throw new Error('Use reva.settings.set for plugin settings'); setSetting(key, v); },
        },
      },

      storage: {
        async get(key, d) { const r = await sApi('get', key); return r.has ? r.value : d; },
        async set(key, v) { await sApi('set', key, v); },
        async delete(key) { await sApi('delete', key); },
        async keys() { return (await sApi('keys')).keys; },
      },

      theme: {
        register: (json, id) => { const r = registerTheme(rec, json, id, track); return r.id; },
        apply(id) { need('settings', 'change the colour theme'); const f = THEMES[id] ? id : 'p-' + pid + '-' + slugName(id); if (!THEMES[f]) throw new Error('Unknown theme ' + id); setSetting('theme', f); },
        list: () => Object.keys(THEMES).filter((k) => THEMES[k].plugin === pid),
      },

      events: {
        on(name, cb) { const set = bus.get(name) || bus.set(name, new Set()).get(name); const f = g(cb, 'event ' + name); set.add(f); return disp(() => set.delete(f)); },
        once(name, cb) { const d = reva.events.on(name, (...a) => { d.dispose(); return cb(...a); }); return d; },
        emit(name, data) { for (const f of [...(bus.get(name) || [])]) f(data, pid); },
      },

      log: Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => log(rec, l, ...a)])),

      async fetch(url, o = {}) {
        need('network', 'make network requests');
        const body = o.body == null ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
        const headers = { ...(o.headers || {}) }; if (body !== undefined && typeof o.body !== 'string' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
        const r = await PAPI().fetch({ url: String(url), method: o.method, headers, body, local: rec.perms.has('network.local'), timeout: o.timeout });
        if (!r || !r.ok) throw new Error((r && r.error) || 'fetch failed');
        return { ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText, url: r.url, headers: { get: (k) => r.headers[String(k).toLowerCase()] ?? null, all: r.headers }, text: async () => r.body, json: async () => JSON.parse(r.body), base64: async () => r.bodyBase64 || btoa(unescape(encodeURIComponent(r.body))) };
      },
    };
    return reva;
  }

  // ------------------------------------------------------------------ plugin settings (A.settings.plugins[id])
  const pluginSettings = (pid) => ((A.settings.plugins = A.settings.plugins || {})[pid] = A.settings.plugins[pid] || {});
  function setPluginSetting(pid, key, value) {
    pluginSettings(pid)[key] = value; saveSettings();
    for (const f of [...(settingCbs.get(pid) || [])]) f(key, value);
    notify();
  }

  // ------------------------------------------------------------------ status bar
  function paintItem(item) {
    if (!item.el) return; item.el.title = item.tooltip || ''; item.el.innerHTML = '';
    if (item.icon) item.el.insertAdjacentHTML('beforeend', icon(item.icon)); item.el.append(document.createTextNode(item.text || ''));
    item.el.style.display = item.text || item.icon ? '' : 'none';
  }
  function statusItems() {
    const out = [];
    for (const r of live()) for (const s of r.manifest.contributes.statusBar) if (!statusReg.some((x) => x.pluginId === r.id && x.id === s.id)) out.push({ id: s.id, pluginId: r.id, align: s.align === 'right' ? 'right' : 'left', text: s.text || '', tooltip: s.tooltip || '', icon: s.icon || '', onClick: s.command ? () => executeCommand(qualify(r.id, s.command)).catch((e) => fail(r, e, 'status item')) : null, declared: true });
    return out.concat(statusReg);
  }
  function renderStatus() {
    const sb = $('#statusbar'); if (!sb) return;
    $$('.si.plug', sb).forEach((e) => e.remove());
    const sp = $('.sp', sb); const items = statusItems();
    for (const it of items) {
      it.el = h('div', { class: 'si plug', onclick: () => it.onClick && it.onClick() }); it.el.style.cursor = it.onClick ? 'pointer' : 'default'; paintItem(it);
      if (it.align === 'right') sb.insertBefore(it.el, sp ? sp.nextSibling : null); else sb.insertBefore(it.el, sp || null);
    }
  }

  // ------------------------------------------------------------------ sidebar panels
  const mounted = new Map();
  function sidebarPanels() {
    const out = new Map();
    for (const r of live()) for (const p of r.manifest.contributes.sidebarPanels) out.set('plugin:' + r.id + ':' + p.id, { id: 'plugin:' + r.id + ':' + p.id, pluginId: r.id, title: p.title, icon: p.icon || 'list' });
    for (const [id, p] of panelReg) { const r = byId(p.pluginId); if (r && live().includes(r)) out.set(id, { id, pluginId: p.pluginId, title: p.title || p.localId, icon: p.icon || out.get(id)?.icon || 'list' }); }
    return [...out.values()];
  }
  async function renderPanel(id, el) {
    const m = /^plugin:([^:]+):(.+)$/.exec(id); const rec = m && byId(m[1]);
    if (!rec || !live().includes(rec)) { el.replaceChildren(h('div', { class: 'empty' }, 'This panel is not available')); return; }
    mounted.set(id, el);
    let def = panelReg.get(id);
    if (!def) {
      el.replaceChildren(h('div', { class: 'empty' }, 'Starting ' + rec.name + '…'));
      await activate(rec); def = panelReg.get(id);
      if (!def) { el.replaceChildren(h('div', { class: 'empty' }, rec.status === 'error' ? rec.name + ' failed to start. See its log in the plugin manager.' : rec.name + ' has not registered the panel “' + m[2] + '”.')); return; }
    }
    const ctx = { refresh: () => refreshPanel(id), workspace: A.ws };
    el.replaceChildren(); await def.render(el, ctx);
  }
  function refreshPanel(id) { const el = mounted.get(id); if (!el || !el.isConnected) { mounted.delete(id); return; } return renderPanel(id, el); }
  function panelModule(id) {
    const p = sidebarPanels().find((x) => x.id === id); if (!p) return null;
    return { panel() {
      const body = h('div', { class: 'panel-body' }); setTimeout(() => renderPanel(id, body), 0);
      return [h('div', { class: 'panel-head' }, h('span', null, p.title), h('div', { class: 'acts' }, h('button', { class: 'icon-btn', title: 'Refresh', html: icon('refresh'), onclick: () => refreshPanel(id) }))), body];
    } };
  }
  let curPluginPanel = null;
  const NAV = [['explorer', 'Files'], ['search', 'Search'], ['sessions', 'Chats'], ['mcp', 'MCP']];
  function decorateNav(nav, activeId) {
    nav = nav || $('.seg-nav', $('#sidebar')); if (!nav) return;
    $$('button.plug', nav).forEach((b) => b.remove());
    for (const p of sidebarPanels()) nav.append(h('button', { class: 'plug' + (p.id === activeId ? ' on' : ''), title: p.title, 'data-p': p.id, html: icon(p.icon), onclick: () => Panels.show(p.id) }));
  }
  function showPluginPanel(id) {
    const mod = panelModule(id); if (!mod) { toast('That plugin panel is no longer available', true); return window.Panels.show('explorer'); }
    if (document.body.classList.contains('collapsed-side')) App.toggleSide(true);
    curPluginPanel = id; const s = $('#sidebar');
    // keep the existing nav bar (whatever built-in panels Reva currently has); fall back to a basic one when the sidebar is empty
    let nav = $('.seg-nav', s);
    if (nav) $$('button:not(.plug)', nav).forEach((b) => b.classList.remove('on'));
    else nav = h('div', { class: 'seg-nav' }, NAV.map(([pid, label]) => h('button', { 'data-p': pid, onclick: () => Panels.show(pid) }, label)));
    s.innerHTML = ''; decorateNav(nav, id); s.append(nav, ...mod.panel());
  }
  function wirePanels() {
    if (!window.Panels || Panels.__plugins) return; Panels.__plugins = true;
    const origShow = Panels.show.bind(Panels), origCur = Panels.current;
    Panels.show = function (id, t) {
      if (typeof id === 'string' && id.startsWith('plugin:')) return showPluginPanel(id);
      curPluginPanel = null; const r = origShow(id, t); decorateNav(); return r;
    };
    Panels.current = () => curPluginPanel || origCur();
  }

  // ------------------------------------------------------------------ agent tools
  let toolsTimer = null;
  function toolList() {
    const out = new Map();
    for (const r of live()) for (const t of r.manifest.contributes.agentTools) out.set(r.id + '__' + t.name, { name: r.id + '__' + t.name, description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} }, readOnly: !!t.readOnly });
    for (const [n, t] of toolReg) out.set(n, { name: n, description: t.def.description, inputSchema: t.def.inputSchema || { type: 'object', properties: {} }, readOnly: !!t.def.readOnly });
    return [...out.values()];
  }
  function pushTools() { clearTimeout(toolsTimer); toolsTimer = setTimeout(() => { try { PAPI().setTools(toolList()); } catch { /* main not ready */ } }, 60); }
  const hasTool = (name) => /^[a-z0-9]+(?:-[a-z0-9]+)*__/.test(String(name)) && (toolReg.has(name) || toolList().some((t) => t.name === name));
  async function callTool(name, args) {
    const err = (m) => ({ content: [{ type: 'text', text: m }], isError: true });
    let t = toolReg.get(name);
    if (!t) { const rec = byId(String(name).split('__')[0]); if (rec && live().includes(rec)) { await activate(rec); t = toolReg.get(name); } }
    if (!t) return err('Unknown plugin tool: ' + name);
    try { return toolText(await t.handler(args || {})); } catch (e) { return err('Error: ' + (e && e.message ? e.message : e)); }
  }

  // ------------------------------------------------------------------ chat hooks
  async function beforeSend(text, chat) {
    const ctx = { chatId: chat && chat.id, provider: chat && chat.cfg && chat.cfg.provider };
    const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(String(text).trim());
    if (m) {
      let sc = slashReg.find((s) => s.name === m[1]);
      if (!sc) { const rec = live().find((r) => r.status === 'idle' && r.manifest.contributes.slashCommands.some((s) => s.name === m[1])); if (rec) { await activate(rec); sc = slashReg.find((s) => s.name === m[1]); } }
      if (sc) {
        let r; try { r = await sc.run((m[2] || '').trim(), { ...ctx, text }); } catch { return false; } // run() is guarded: it already logged + toasted
        if (r === undefined || r === null || r === false) return false;        // handled locally, nothing is sent
        text = typeof r === 'string' ? r : r && typeof r.text === 'string' ? r.text : text;
      }
    }
    for (const h of [...hooks.beforeSend]) { const r = await h.cb(text, ctx); if (r === false) return false; if (typeof r === 'string') text = r; }
    return text;
  }
  function slashCommands() {
    const out = new Map();
    for (const r of live()) for (const s of r.manifest.contributes.slashCommands) out.set(s.name, { name: s.name, description: s.description || '', pluginId: r.id });
    for (const s of slashReg) out.set(s.name, { name: s.name, description: s.description, pluginId: s.pluginId });
    return [...out.values()];
  }
  function normalizeAgentEvent(id, ev) {
    const c = (A.chats || []).find((x) => x.id === id); const base = { chatId: id, provider: c && c.cfg && c.cfg.provider }; const out = [];
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) { if (b.type === 'text' && b.text) out.push({ ...base, type: 'text', text: b.text }); else if (b.type === 'tool_use') out.push({ ...base, type: 'tool_use', id: b.id, name: b.name, input: b.input }); }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) if (b.type === 'tool_result') out.push({ ...base, type: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, content: typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '' });
    } else if (ev.type === 'result') out.push({ ...base, type: 'result', ok: !ev.is_error, text: ev.result, costUsd: ev.total_cost_usd, durationMs: ev.duration_ms });
    else if (ev.type === 'stderr' && ev.text) out.push({ ...base, type: 'error', text: ev.text });
    return out;
  }

  // ------------------------------------------------------------------ pickers / modals available to plugins
  function quickPick(items, o = {}) {
    return new Promise((resolve) => {
      const list = (items || []).map((it) => (typeof it === 'string' ? { label: it, value: it } : { value: it.label, ...it }));
      const inp = h('input', { placeholder: o.placeholder || o.title || 'Select…' }); const box = h('div', { class: 'list' }); let idx = 0, shown = list, done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
      const m = openModal([o.title ? h('div', { class: 'mh', style: { paddingBottom: '0' } }, o.title) : null, inp, box], { cls: 'palette', onClose: () => { if (!done) { done = true; resolve(undefined); } } });
      const draw = () => { box.innerHTML = ''; if (!shown.length) box.append(h('div', { class: 'u-note', style: { padding: '10px 14px' } }, 'No matches')); shown.forEach((it, i) => box.append(h('div', { class: 'it' + (i === idx ? ' on' : ''), onclick: () => finish(it.value), onmousemove: () => { idx = i; $$('.it', box).forEach((e, j) => e.classList.toggle('on', j === i)); } }, h('span', null, it.label), h('kbd', null, it.description || '')))); };
      inp.addEventListener('input', () => { const q = inp.value.toLowerCase(); shown = list.filter((x) => q.split(/\s+/).every((w) => (x.label + ' ' + (x.description || '')).toLowerCase().includes(w))); idx = 0; draw(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, shown.length - 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); } else if (e.key === 'Enter' && shown[idx]) finish(shown[idx].value); $$('.it', box)[idx]?.scrollIntoView({ block: 'nearest' }); });
      draw(); inp.focus();
    });
  }
  function openPanelModal(rec, o = {}) {
    const body = h('div', { class: 'mb selectable' }); let m;
    m = openModal([h('div', { class: 'mh' }, o.title || rec.name, h('button', { class: 'icon-btn sm', html: icon('x'), onclick: () => m.close() })), body], { cls: o.width === 'wide' ? 'wide' : '' });
    Promise.resolve().then(() => guard(rec, o.render || (() => {}), 'panel modal')(body, { close: () => m.close() }));
    return { close: m.close, el: body };
  }

  // ------------------------------------------------------------------ lifecycle
  function newRec(e) {
    return { id: e.id, name: (e.manifest && e.manifest.name) || e.id, dir: e.dir, folder: e.folder, source: e.source, info: e, manifest: e.manifest, status: 'disabled', error: '', logs: [], disposables: [], contribDisp: [], applied: false, perms: new Set(), consecutive: 0, errorCount: 0, toasted: false, module: null, activating: null };
  }
  function adopt(rec, e) {
    rec.info = e; rec.id = e.id; rec.manifest = e.manifest; rec.name = (e.manifest && e.manifest.name) || e.id; rec.folder = e.folder; rec.source = e.source;
    const granted = new Set(e.granted || []); rec.perms = new Set(((e.manifest && e.manifest.permissions) || []).filter((p) => granted.has(p)));
  }
  const shouldStart = (rec) => rec.manifest.activation.some((a) => a === 'onStartup' || (a === 'onWorkspace' && !!A.ws) || (a.startsWith('onFileType:') && monaco.editor.getModels().some((m) => extOf(m.uri.path) === a.slice(11).replace(/^\./, '').toLowerCase())));

  async function activate(rec) {
    if (rec.status === 'active') return;
    if (rec.activating) return rec.activating;
    if (!['idle', 'error'].includes(rec.status) || !rec.manifest) return;
    rec.activating = (async () => {
      rec.status = 'activating'; rec.error = ''; rec.toasted = false; rec.consecutive = 0; notify();
      let slow;
      try {
        if (rec.manifest.main) {
          const src = await PAPI().readMain({ dir: rec.dir, main: rec.manifest.main });
          if (!src.ok) throw new Error(src.error);
          const reva = createReva(rec); const module = { exports: {} };
          const con = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((l) => [l, (...a) => log(rec, l === 'log' ? 'info' : l, ...a)]));
          // eslint-disable-next-line no-new-func
          const fn = new Function('reva', 'module', 'exports', 'console', src.code + '\n//# sourceURL=reva-plugin://' + rec.id + '/' + rec.manifest.main);
          fn.call(module.exports, reva, module, module.exports, con);
          rec.module = module.exports || {}; // the script may also replace module.exports
          if (typeof rec.module.activate === 'function') {
            slow = setTimeout(() => { log(rec, 'warn', 'activate() is taking longer than ' + SLOW_ACTIVATE_MS / 1000 + ' s'); toast('Plugin “' + rec.name + '” is slow to start…'); }, SLOW_ACTIVATE_MS);
            await withTimeout(rec.module.activate(reva), HARD_ACTIVATE_MS, 'activate() did not finish within ' + HARD_ACTIVATE_MS / 1000 + ' s');
          }
        }
        rec.status = 'active'; log(rec, 'info', 'activated');
      } catch (e) {
        rec.status = 'error'; rec.error = (e && e.message) || String(e); log(rec, 'error', 'activation failed: ' + (e && e.stack ? e.stack : rec.error));
        toast('Plugin “' + rec.name + '” failed to start: ' + rec.error.split('\n')[0].slice(0, 140), true);
        disposeAll(rec);
      } finally { clearTimeout(slow); rec.activating = null; notify(); pushTools(); }
    })();
    return rec.activating;
  }
  function disposeAll(rec) {
    for (const d of rec.disposables.splice(0).reverse()) { try { d.dispose(); } catch (e) { console.error(e); } }
    // safety net: anything still owned by this plugin id (never for an invalid duplicate that merely shares the id of the real plugin)
    if (rec.info.errors.length) { renderStatus(); return; }
    for (const [k, c] of cmds) if (c.pluginId === rec.id) cmds.delete(k);
    for (const [k, p] of panelReg) if (p.pluginId === rec.id) panelReg.delete(k);
    for (const [k, t] of toolReg) if (t.pluginId === rec.id) toolReg.delete(k);
    for (let i = statusReg.length - 1; i >= 0; i--) if (statusReg[i].pluginId === rec.id) { if (statusReg[i].el) statusReg[i].el.remove(); statusReg.splice(i, 1); }
    for (let i = slashReg.length - 1; i >= 0; i--) if (slashReg[i].pluginId === rec.id) slashReg.splice(i, 1);
    for (const l of Object.values(hooks)) for (let i = l.length - 1; i >= 0; i--) if (l[i].pid === rec.id) l.splice(i, 1);
    settingCbs.delete(rec.id);
    for (const [name, set] of bus) if (!set.size) bus.delete(name);
    renderStatus();
  }
  async function deactivate(rec) {
    if (rec.activating) { try { await rec.activating; } catch { /* handled */ } }
    if (rec.module && typeof rec.module.deactivate === 'function') { try { await withTimeout(rec.module.deactivate(), 3000, 'deactivate() timed out'); } catch (e) { log(rec, 'warn', 'deactivate: ' + e.message); } }
    disposeAll(rec); rec.module = null;
  }
  /** Stop everything this plugin has running or registered (code + declarative contributions). */
  async function teardown(rec) { await deactivate(rec); unapplyContrib(rec); if (!['error'].includes(rec.status)) rec.status = 'disabled'; pushTools(); notify(); }

  async function sync(rec, force) {
    const e = rec.info;
    if (e.errors.length || !e.manifest) { await teardown(rec); rec.status = 'invalid'; rec.error = e.errors[0] || 'Invalid plugin'; return; }
    if (!e.enabled) { await teardown(rec); rec.status = rec.autoDisabled ? 'error' : 'disabled'; if (!rec.autoDisabled) rec.error = ''; return; }
    if (e.missingPermissions.length) { await teardown(rec); rec.status = 'needs-approval'; rec.error = ''; return; }
    if (force) { await teardown(rec); }
    if (rec.status === 'disabled' || rec.status === 'invalid' || rec.status === 'needs-approval') rec.status = 'idle';
    if (rec.status === 'error' && !force) return;
    if (rec.status === 'error') rec.status = 'idle';
    if (!rec.applied) await applyContrib(rec);
    pushTools(); notify();
    if (rec.status === 'idle' && shouldStart(rec)) await activate(rec);
  }

  let refreshing = Promise.resolve();
  /** Rescan plugin folders; `reload` = folder names whose files changed (those are torn down and started again). */
  function refresh(reload) {
    refreshing = refreshing.then(async () => {
      const r = await PAPI().list({ ws: A.ws });
      if (!r || r.ok === false) { console.error('plugins:list failed', r && r.error); return; }
      meta = { userDir: r.userDir, workspaceDir: r.workspaceDir, builtinDir: r.builtinDir, appVersion: r.appVersion, platform: r.platform }; builtinList = r.builtin;
      const seen = new Set(); const tasks = [];
      for (const e of r.plugins) {
        const key = e.dir.toLowerCase(); seen.add(key); let rec = recs.get(key); const force = !!(reload && reload.includes(e.folder));
        if (!rec) { rec = newRec(e); recs.set(key, rec); }
        const idChanged = rec.id !== e.id;
        if (idChanged) { await teardown(rec); rec.logs = []; }
        adopt(rec, e); tasks.push(sync(rec, force || idChanged));
      }
      for (const [key, rec] of recs) if (!seen.has(key)) { tasks.push(teardown(rec).then(() => { recs.delete(key); })); }
      await Promise.all(tasks); notify(); pushTools();
    }).catch((e) => console.error('plugin refresh failed', e));
    return refreshing;
  }

  // ------------------------------------------------------------------ editor/IDE events -> plugins
  const fire = (list, ...a) => { for (const h of [...list]) h.cb(...a); };
  const debounced = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  function wireEditor() {
    const e = editorInst(); if (!e || e.__plugins) return; e.__plugins = true;
    e.onDidChangeModel(() => fire(hooks.active, activeFileInfo(false)));
    e.onDidChangeModelContent(debounced(() => fire(hooks.text, activeFileInfo(false)), 120));
    e.onDidChangeCursorSelection(debounced(() => fire(hooks.selection, activeFileInfo(false)), 100));
  }
  function onFsChanged(paths) {
    fire(hooks.fs, paths);
    if (hookWired) return;
    // no save hook wired into app.js: approximate onDidSave with "an open file changed on disk"
    const open = new Set(monaco.editor.getModels().filter((m) => m.uri.scheme === 'file').map((m) => fixPath(m.uri.fsPath).toLowerCase()));
    for (const p of paths) if (open.has(String(p).toLowerCase()) && Date.now() - (lastSaved.get(p.toLowerCase()) || 0) > 1500) { lastSaved.set(p.toLowerCase(), Date.now()); fire(hooks.save, p); }
  }

  const RevaPlugins = {
    version: '1.0.0',
    api: PAPI,
    PERMISSIONS: PERM_INFO,
    async init() {
      if (inited) return; inited = true;
      // --- wiring that needs no edits in other files: wrap a few globals once
      if (window.updateStatus && !window.updateStatus.__p) { const o = window.updateStatus; window.updateStatus = function () { const r = o.apply(this, arguments); renderStatus(); return r; }; window.updateStatus.__p = true; }
      if (window.openFile && !window.openFile.__p) { const o = window.openFile; window.openFile = async function (p) { const r = await o.apply(this, arguments); try { RevaPlugins.notifyFileOpened(p); } catch { /* ignore */ } return r; }; window.openFile.__p = true; }
      if (window.IDE && !IDE.exec.__p) { const o = IDE.exec; IDE.exec = function (tool, a) { return hasTool(tool) ? callTool(tool, a) : o.call(this, tool, a); }; IDE.exec.__p = true; }
      if (window.App && !App.setWorkspace.__p) { const o = App.setWorkspace; App.setWorkspace = async function () { const r = await o.apply(this, arguments); RevaPlugins.workspaceChanged(); return r; }; App.setWorkspace.__p = true; }
      wirePanels(); wireEditor();
      addEventListener('keydown', onGlobalKey, true);
      api.on('fs:changed', onFsChanged);
      api.on('agent:event', ({ id, ev }) => { if (!hooks.agentEvent.length) return; try { for (const n of normalizeAgentEvent(id, ev)) fire(hooks.agentEvent, n); } catch (e) { console.error(e); } });
      let rt; api.on('plugins:changed', ({ folders }) => { clearTimeout(rt); const set = new Set([...(RevaPlugins._pending || []), ...folders]); RevaPlugins._pending = [...set]; rt = setTimeout(() => { const f = RevaPlugins._pending; RevaPlugins._pending = []; refresh(f).then(() => { if (f.length && A.settings.pluginDev) toast('Reloaded ' + f.join(', ')); }); }, 200); });
      changeCbs.add(() => { renderStatus(); decorateNav(null, curPluginPanel); if (curPluginPanel && !sidebarPanels().some((p) => p.id === curPluginPanel)) window.Panels.show('explorer'); });
      await refresh();
    },
    async reload() { await Promise.all([...recs.values()].map((r) => teardown(r))); recs.clear(); await refresh(); },
    async reloadPlugin(id) { const r = byId(id); if (r) await refresh([r.folder]); },
    refresh,
    workspaceChanged() { fire(hooks.wsOpen, A.ws); return refresh(); },
    /** Plugin summaries for UIs. */
    list() {
      return [...recs.values()].map((r) => ({
        id: r.id, name: r.name, version: r.manifest ? r.manifest.version : '', description: r.manifest ? r.manifest.description : '', author: r.manifest ? r.manifest.author : '', icon: r.manifest ? r.manifest.icon : '',
        source: r.source, dir: r.dir, folder: r.folder, status: r.status, error: r.error, errors: r.info.errors, warnings: r.info.warnings, enabled: !!r.info.enabled,
        globalEnabled: !!r.info.globalEnabled, projectOverride: r.info.projectOverride, permissions: r.manifest ? r.manifest.permissions : [], missingPermissions: r.info.missingPermissions || [],
        contributes: r.manifest ? r.manifest.contributes : {}, activation: r.manifest ? r.manifest.activation : [], logCount: r.logs.length, errorCount: r.errorCount, manifest: r.manifest,
      }));
    },
    builtin() { return builtinList.map((e) => ({ id: e.id, name: e.manifest ? e.manifest.name : e.id, version: e.manifest ? e.manifest.version : '', description: e.manifest ? e.manifest.description : '', author: e.manifest ? e.manifest.author : '', icon: e.manifest ? e.manifest.icon : '', permissions: e.manifest ? e.manifest.permissions : [], installed: !!e.installed, errors: e.errors, contributes: e.manifest ? e.manifest.contributes : {} })); },
    meta: () => ({ ...meta }),
    get(id) { return this.list().find((p) => p.id === id) || null; },
    logs: (id) => { const r = byId(id); return r ? r.logs.slice() : []; },
    clearLogs(id) { const r = byId(id); if (r) { r.logs.length = 0; notify(); } },
    allLogs() { return [...recs.values()].flatMap((r) => r.logs.map((l) => ({ ...l, plugin: r.id }))).sort((a, b) => a.t - b.t); },
    onLog(cb) { logCbs.add(cb); return () => logCbs.delete(cb); },

    /** Turn a plugin on (asks for approval of its permissions first when they are new). Resolves true when enabled. */
    async enable(id, o = {}) {
      const r = byId(id); if (!r || !r.manifest) throw new Error('Unknown plugin ' + id);
      let grant; const missing = r.info.missingPermissions || [];
      if (missing.length || o.confirm) { if (!o.skipDialog && !(await RevaPlugins.permissionDialog(r))) return false; grant = r.manifest.permissions; }
      const scope = r.source === 'workspace' ? 'project' : (o.scope || 'global');
      const res = await PAPI().setEnabled({ id, enabled: true, scope, ws: A.ws, grant }); if (!res.ok) throw new Error(res.error);
      r.autoDisabled = null; if (r.status === 'error') r.status = 'disabled'; r.errorCount = 0;
      await refresh([r.folder]); return true;
    },
    async disable(id) {
      const r = byId(id); if (!r) return false;
      await PAPI().setEnabled({ id, enabled: false, scope: r.source === 'workspace' ? 'project' : 'global', ws: A.ws });
      if (r.info.projectOverride) await PAPI().setEnabled({ id, enabled: null, scope: 'project', ws: A.ws });
      await refresh(); return true;
    },
    async setMode(id, mode) { await PAPI().setMode({ id, mode, ws: A.ws }); await refresh(); },
    async install(from, o = {}) { const r = await PAPI().install({ from, target: o.target, ws: A.ws, overwrite: o.overwrite }); if (r.ok) await refresh(); return r; },
    async installBuiltin(id, o = {}) { const r = await PAPI().installBuiltin({ id, overwrite: o.overwrite }); if (r.ok) await refresh(); return r; },
    async uninstall(id, o = {}) { const r = byId(id); if (!r) throw new Error('Unknown plugin ' + id); await teardown(r); const res = await PAPI().uninstall({ id, dir: r.dir, keepData: o.keepData }); if (!res.ok) throw new Error(res.error); recs.delete(r.dir.toLowerCase()); await refresh(); return true; },
    /** Scaffold a plugin, trust it (you just wrote it) and start it. */
    async create(o) { const r = await PAPI().create({ ...o, ws: A.ws }); if (!r.ok) return r; const m = JSON.parse((await PAPI().readFile({ dir: r.dir, file: 'plugin.json' })).text); await PAPI().setEnabled({ id: r.id, enabled: true, scope: o.scope === 'workspace' ? 'project' : 'global', ws: A.ws, grant: m.permissions || [] }); await refresh(); return r; },
    approvePermissions: (id, perms) => PAPI().grant({ id, permissions: perms }),

    // --- what Reva's own UI consumes
    paletteItems() {
      const items = [
        { label: 'Plugins: Manage…', hint: 'Ctrl+Shift+X', fn: () => RevaPlugins.openManager() },
        { label: 'Plugins: Create New Plugin…', hint: '', fn: () => RevaPlugins.openManager('create') },
        { label: 'Plugins: Reload All', hint: '', fn: () => RevaPlugins.reload().then(() => toast('Plugins reloaded')) },
      ];
      const seen = new Set();
      for (const r of live()) {
        for (const c of r.manifest.contributes.commands) { const full = qualify(r.id, c.id); seen.add(full); items.push({ label: c.title, hint: c.keybinding || '', fn: () => executeCommand(full).catch((e) => fail(r, e, 'command ' + full)), pluginId: r.id, command: full }); }
        for (const m of r.manifest.contributes.menus.commandPalette || []) { const full = qualify(r.id, m.command); if (!seen.has(full)) { seen.add(full); items.push({ label: m.title || m.command, hint: '', fn: () => executeCommand(full).catch((e) => fail(r, e, 'command ' + full)), pluginId: r.id, command: full }); } }
      }
      for (const c of cmds.values()) if (!seen.has(c.id) && c.title) items.push({ label: c.title, hint: c.keybinding || '', fn: () => c.fn(), pluginId: c.pluginId, command: c.id });
      return items;
    },
    sidebarPanels, renderPanel, panelModule, refreshPanel,
    statusItems, slashCommands, beforeSend,
    hasTool, callTool, toolList,
    executeCommand,
    /** Items for the Explorer context menu: [{label, run}] */
    explorerMenuItems(fullPath, isDir) {
      const out = []; const ext = extOf(basename(fullPath));
      const okWhen = (w) => !w || !w.extensions || (!isDir && w.extensions.map((x) => String(x).replace(/^\./, '').toLowerCase()).includes(ext));
      for (const r of live()) {
        for (const a of r.manifest.contributes.fileActions) if (okWhen(a.when)) out.push({ label: a.title, run: () => executeCommand(qualify(r.id, a.id), fullPath).catch((e) => fail(r, e, 'file action')) });
        for (const m of r.manifest.contributes.menus['explorer/context'] || []) if (okWhen(m.when)) { const decl = r.manifest.contributes.commands.find((c) => qualify(r.id, c.id) === qualify(r.id, m.command)); out.push({ label: m.title || (decl && decl.title) || m.command, run: () => executeCommand(qualify(r.id, m.command), fullPath).catch((e) => fail(r, e, 'menu')) }); }
      }
      return out;
    },
    /** Call from openFile (auto-wired by init()). Wakes plugins with activation "onFileType:<ext>". */
    notifyFileOpened(p) { const ext = extOf(basename(String(p))); for (const r of live()) if (r.status === 'idle' && (r.manifest.activation.includes('onFileType:' + ext) || r.manifest.activation.includes('onFileType:.' + ext))) activate(r); },
    /** Optional hooks for saveFile() in app.js: `await RevaPlugins.beforeSave(path, model)` before writing, `RevaPlugins.notifySaved(path)` after. */
    async beforeSave(p, model) { hookWired = true; const ctx = { path: p, language: model && model.getLanguageId ? model.getLanguageId() : '', isActive: !!(model && editorInst() && editorInst().getModel() === model) }; for (const h of [...hooks.willSave]) { try { await withTimeout(h.cb(ctx), 5000, 'onWillSave handler timed out'); } catch { /* guard already logged; a slow handler must not block saving */ } } },
    notifySaved(p) { hookWired = true; lastSaved.set(String(p).toLowerCase(), Date.now()); fire(hooks.save, p); },
    onChange(cb) { changeCbs.add(cb); return () => changeCbs.delete(cb); },
    getPluginSetting: (pid, key) => { const r = byId(pid); const s = pluginSettings(pid); if (key in s) return s[key]; const d = r && r.manifest.contributes.settings.find((x) => x.key === key); return d ? d.default : undefined; },
    setPluginSetting,
    events: { emit: (name, data) => { for (const f of [...(bus.get(name) || [])]) f(data, 'reva'); } },
    // test/diagnostic access
    _debug: () => ({ cmds: [...cmds.keys()], panels: [...panelReg.keys()], status: statusReg.map((s) => s.pluginId + ':' + s.id), slash: slashReg.map((s) => s.name), tools: [...toolReg.keys()], hooks: Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length])), titleBtns: titleBtns.length, themes: Object.keys(THEMES).filter((k) => THEMES[k].plugin), buses: bus.size }),
  };
  window.RevaPlugins = RevaPlugins;
  // Self-start once app.js has finished booting (it sets window.__ready). Calling RevaPlugins.init() yourself is also fine.
  if (!window.__noPluginsAutoInit) document.addEventListener('DOMContentLoaded', () => {
    const t = setInterval(() => { if (window.__ready) { clearInterval(t); if (PAPI()) RevaPlugins.init(); else console.warn('[plugins] api.plugins is missing - add it to preload.js'); } }, 80);
  });
})();
