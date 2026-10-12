// Plugin manager UI: cards for installed / built-in plugins, permission dialog, per-plugin settings form,
// log viewer, "new extension" wizard. Extends window.RevaPlugins (see plugins.js).
//
//   RevaPlugins.openManager(tab?)      tab: 'installed' | 'builtin' | 'create' | 'console'   (also bound to Ctrl+Shift+X)
//   RevaPlugins.settingsView(tab?)     the same UI as an array of nodes to embed in a Settings section
//   RevaPlugins.permissionDialog(p)    Promise<boolean>: lists what a plugin asks for before it may run
(function () {
  'use strict';
  const RP = window.RevaPlugins; if (!RP) return;
  const S = { tab: 'installed', target: 'user', open: {}, logFilter: '', tpl: 'command' };

  const STATUS = { active: ['Active', ''], idle: ['Idle', ''], activating: ['Starting…', ''], disabled: ['Disabled', ''], error: ['Error', 'bad'], 'needs-approval': ['Needs approval', 'warn'], invalid: ['Invalid', 'bad'] };
  const SRC = { user: 'User', workspace: 'Project', builtin: 'Built-in' };
  const TEMPLATES = [
    ['command', 'Command', 'A command in the palette that shows a toast', 'bolt'],
    ['sidebar', 'Sidebar panel', 'A panel next to Files / Search', 'panelLeft'],
    ['theme', 'Colour theme', 'A theme file, no code', 'palette'],
    ['tool', 'Agent tool', 'A tool Claude, Codex and OpenCode can call', 'agent'],
    ['language', 'Language + snippets', 'File extension, snippets and hovers', 'code'],
  ];
  const ico = (n, s = 16) => icon(n).replace('<svg', `<svg width="${s}" height="${s}"`);
  const pIcon = (p) => (p.icon && /^[a-zA-Z]+$/.test(p.icon) ? p.icon : p.contributes && p.contributes.themes && p.contributes.themes.length ? 'palette' : p.contributes && p.contributes.agentTools && p.contributes.agentTools.length ? 'agent' : p.contributes && p.contributes.sidebarPanels && p.contributes.sidebarPanels.length ? 'panelLeft' : 'plug');
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const row = (label, desc, ...ctl) => h('div', { class: 'row' }, h('div', { class: 'rl' }, h('b', null, label), desc ? h('span', null, desc) : null), h('div', { class: 'rc' }, ctl));

  // ---------------------------------------------------------------- "Build with AI" + developer docs
  const AI_DOC = '_docs/FOR-AI-AGENTS.md';
  const STOP = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'that', 'which', 'and', 'in', 'on', 'my', 'me', 'with', 'plugin', 'reva', 'make', 'create', 'add', 'show', 'i', 'it']);
  /** Absolute path an external agent can read. app.asar is only readable by Electron, so a packaged build copies the spec next to the user data. */
  async function agentDocPath() {
    const m = RP.meta(); const src = joinp(m.builtinDir, AI_DOC.replace(/\//g, '\\'));
    if (!/\.asar([\\/]|$)/i.test(src)) return src;
    const dest = joinp(dirname(m.userDir), 'plugin-docs\\FOR-AI-AGENTS.md');
    try {
      const r = await RP.api().readFile({ dir: m.builtinDir, file: AI_DOC });
      if (r.ok) { let w = await api.fs.write({ file: dest, content: r.text }); if (!w.ok) { await api.fs.create({ file: dirname(dest), dir: true }); w = await api.fs.write({ file: dest, content: r.text }); } }
    } catch { /* fall through: the path is still returned */ }
    return dest;
  }
  /** Ask for a one-line description, scaffold a plugin, open a NEW chat and put an instruction prompt in its input box. */
  async function buildWithAI(scope) {
    const desc = String((await promptBox('Build a plugin with AI', '', 'One line, e.g. "show the current git branch in the status bar"')) || '').trim();
    if (!desc) return;
    const ws = desc.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !STOP.has(w)).slice(0, 3);
    const base = ws.join('-').length >= 2 ? ws.join('-') : 'ai-plugin'; const title = (ws.length ? ws : ['ai', 'plugin']).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    let r, n = 0;
    do { n++; r = await RP.create({ name: title, id: n > 1 ? base + '-' + n : base, template: 'command', scope: scope || 'user' }); } while (!r.ok && /already exists/.test(r.error || '') && n < 25);
    if (!r.ok) { toast(r.error || 'Could not create the plugin', true); return; }
    const doc = await agentDocPath(); const bd = RP.meta().builtinDir; const appDocs = /\.asar([\\/]|$)/i.test(bd) ? '' : joinp(dirname(dirname(bd)), 'docs\\extensions');
    const prompt = [
      'Build a Reva IDE plugin.', '',
      'What it should do: ' + desc, '',
      'The plugin is already scaffolded and enabled in this folder (plugin.json, index.js, README.md):', r.dir, '',
      'Before writing code, read this spec in full: ' + doc,
      appDocs ? 'More detail if you need it: ' + appDocs + ' (api.md, manifest.md, cookbook.md, agent-tools.md).' : null,
      '',
      'Then:',
      '1. Implement the feature by editing plugin.json and index.js in that folder. Declare every permission the code uses, and keep it vanilla JavaScript (plugins run in the renderer: no require/import).',
      '2. Reva hot-reloads the plugin every time a file in the folder is saved, so no restart is needed. Fix any error in the plugin log (Plugins manager > the plugin > Log).',
      '3. Verify it with the IDE tools: terminal_run "node --check index.js" for syntax, open_file to show me the result, and if you added an agent tool or a preview, exercise it. Say what you could not verify.',
      '4. When done, tell me how to use it (command name, shortcut, where it shows up).',
    ].filter((x) => x !== null).join('\n');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // close the plugin manager so the chat is visible
    Chat.new(); App.toggleChat(true); Chat.insert(prompt);
    toast('Created ' + title + ' - review the prompt and press Enter');
  }
  const aiBtn = (scope) => h('button', { class: 'btn', title: 'Describe a plugin; an agent builds it', html: ico('sparkle', 14) + ' Build with AI', onclick: () => buildWithAI(typeof scope === 'function' ? scope() : scope) });
  async function openDocs() {
    const m = RP.meta(); const dir = joinp(dirname(dirname(m.builtinDir)), 'docs\\extensions'); const readme = joinp(dir, 'README.md');
    const r = await api.fs.read(readme);
    if (r && r.kind === 'text') { api.fs.reveal(readme); return; }
    api.fs.reveal(await agentDocPath());   // packaged build: the AI spec is the only doc that ships
  }
  const docsFooter = () => h('div', { class: 'u-note pm-foot', style: { display: 'flex', gap: '10px', alignItems: 'center', margin: '18px 0 4px', paddingTop: '12px', borderTop: '1px solid var(--border)' } },
    h('span', null, 'Writing your own plugin?'), h('button', { class: 'btn sm', onclick: openDocs }, 'Developer docs'));

  function contribChips(c) {
    c = c || {}; const out = [];
    const add = (n, w) => { if (n) out.push(plural(n, w)); };
    add((c.commands || []).length, 'command'); add((c.sidebarPanels || []).length, 'sidebar panel'); add((c.statusBar || []).length, 'status item'); add((c.themes || []).length, 'theme');
    add((c.snippets || []).length, 'snippet set'); add((c.languages || []).length, 'language'); add((c.settings || []).length, 'setting'); add((c.agentTools || []).length, 'agent tool'); add((c.slashCommands || []).length, 'slash command'); add((c.fileActions || []).length, 'file action');
    return out;
  }
  function activationHint(p) {
    const a = (p.activation || []).map((x) => (x === 'onStartup' ? 'startup' : x === 'onWorkspace' ? 'opening a folder' : x.startsWith('onCommand:') ? 'command ' + x.slice(10) : x.startsWith('onFileType:') ? '.' + x.slice(11).replace(/^\./, '') + ' files' : x));
    return a.join(', ');
  }

  // ---------------------------------------------------------------- permission dialog
  RP.permissionDialog = function (p) {
    return new Promise((resolve) => {
      const perms = (p.manifest && p.manifest.permissions) || p.permissions || [];
      const info = RP.PERMISSIONS;
      let decided = false; const done = (v) => { if (decided) return; decided = true; resolve(v); m.close(); };
      const list = perms.length
        ? perms.map((k) => h('div', { class: 'pm-perm' }, h('span', { class: 'pm-perm-i', html: ico(k.startsWith('network') ? 'globe' : k === 'terminal' ? 'term' : k === 'agents' ? 'agent' : k === 'chat' ? 'chat' : k === 'preview' ? 'eye' : k === 'settings' ? 'gear' : 'file', 16) }), h('div', null, h('b', null, (info[k] || [k])[0]), h('span', null, (info[k] || [])[1] || k))))
        : [h('div', { class: 'u-note' }, 'This plugin does not ask for any special permission.')];
      const m = openModal([
        h('div', { class: 'mh' }, 'Enable “' + p.name + '”?'),
        h('div', { class: 'mb' },
          h('div', { class: 'u-note', style: { marginBottom: '8px' } }, [p.version ? 'v' + p.version : '', p.author ? 'by ' + p.author : '', SRC[p.source] || ''].filter(Boolean).join(' · ')),
          p.description ? h('p', { style: { margin: '0 0 10px' } }, p.description) : null,
          h('div', { class: 'pm-perms' }, list),
          h('div', { class: 'pm-warn' }, h('span', { html: ico('warn', 15) }), h('span', null, 'Plugins are trusted code. They run inside Reva with the same access as Reva itself, so only enable plugins from people you trust. Permissions describe what the plugin says it needs and are enforced on the plugin API, but they are not a security sandbox.'))),
        h('div', { class: 'mf' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => done(true) }, 'Enable plugin'))],
        { cls: 'wide', onClose: () => { if (!decided) { decided = true; resolve(false); } } });
    });
  };

  // ---------------------------------------------------------------- per-plugin settings form
  function settingsForm(p) {
    const defs = (p.contributes && p.contributes.settings) || []; if (!defs.length) return null;
    const box = h('div', { class: 'pm-settings' }, h('h5', { class: 'pm-h' }, 'Settings'));
    for (const d of defs) {
      const cur = RP.getPluginSetting(p.id, d.key); const set = (v) => RP.setPluginSetting(p.id, d.key, v); let ctl;
      if (d.type === 'boolean') { ctl = h('input', { type: 'checkbox', class: 'sw', onchange: () => set(ctl.checked) }); ctl.checked = !!cur; }
      else if (d.type === 'number') ctl = Stepper({ value: cur ?? 0, min: d.min ?? -1e9, max: d.max ?? 1e9, step: d.step ?? 1 }, set);
      else if (d.type === 'select') ctl = Sel(d.options.map((o) => (Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, o])), cur, set, { width: '200px' });
      else if (d.type === 'text') { ctl = h('textarea', { class: 'inp', rows: 3, style: { width: '260px' }, onchange: () => set(ctl.value) }); ctl.value = cur ?? ''; }
      else if (d.type === 'color' && window.ColorPicker && ColorPicker.swatch) ctl = ColorPicker.swatch(cur || '#888888', set, { title: d.title });
      else { ctl = h('input', { class: 'inp', style: { width: '220px' }, onchange: () => set(ctl.value) }); ctl.value = cur ?? ''; }
      box.append(row(d.title, d.description, ctl));
    }
    return box;
  }

  // ---------------------------------------------------------------- log viewer
  function logLine(l) { const t = new Date(l.t); const hh = (n) => String(n).padStart(2, '0'); return h('div', { class: 'pm-log ' + l.level }, h('span', { class: 'pm-lt' }, `${hh(t.getHours())}:${hh(t.getMinutes())}:${hh(t.getSeconds())}`), l.plugin ? h('span', { class: 'pm-lp' }, l.plugin) : null, h('span', { class: 'pm-lm' }, l.msg)); }
  function logBox(getLines, onClear) {
    const box = h('div', { class: 'pm-logbox selectable mono' });
    const draw = () => { box.replaceChildren(); const lines = getLines().slice(-200); if (!lines.length) box.append(h('div', { class: 'u-note' }, 'No log output yet')); else lines.forEach((l) => box.append(logLine(l))); box.scrollTop = box.scrollHeight; };
    draw(); box.redraw = draw; box.clear = () => { onClear(); draw(); };
    const off = RP.onLog(() => { if (!box.isConnected) { off(); return; } draw(); });
    return box;
  }

  // ---------------------------------------------------------------- cards
  function card(p, redraw) {
    const [stText, stCls] = STATUS[p.status] || ['', '']; const open = !!S.open[p.dir];
    const sw = h('input', { type: 'checkbox', class: 'sw', title: p.enabled ? 'Disable' : 'Enable', disabled: p.status === 'invalid', onchange: async () => {
      sw.disabled = true;
      try { if (sw.checked) { const ok = await RP.enable(p.id, { confirm: p.missingPermissions.length > 0 }); if (!ok) sw.checked = false; } else await RP.disable(p.id); }
      catch (e) { toast(e.message, true); sw.checked = !sw.checked; }
      sw.disabled = false; redraw();
    } });
    sw.checked = p.enabled && p.status !== 'error';
    const chips = contribChips(p.contributes);
    const head = h('div', { class: 'ph' },
      h('span', { class: 'lg pm-ico', html: ico(pIcon(p), 22) }),
      h('div', { class: 'pi' }, h('b', null, p.name, h('span', { class: 'pm-ver' }, p.version ? ' v' + p.version : '')), h('span', null, [p.author, p.description].filter(Boolean).join(' · ') || p.id)),
      h('span', { class: 'badge ' + stCls }, stText), h('span', { class: 'badge' }, SRC[p.source] || p.source), sw,
      h('button', { class: 'btn sm', onclick: () => { S.open[p.dir] = !open; redraw(); } }, open ? 'Hide' : 'Details'));
    const el = h('div', { class: 'prov-card pm-card' + (p.status === 'invalid' ? ' invalid' : '') }, head);
    if (p.status === 'idle' && p.enabled) el.append(h('div', { class: 'u-note pm-note' }, 'Starts on ' + activationHint(p)));
    if (p.status === 'needs-approval') el.append(h('div', { class: 'pm-note pm-warn-line' }, 'This plugin needs your approval for: ' + p.missingPermissions.join(', '), h('button', { class: 'btn sm primary', onclick: async () => { try { await RP.enable(p.id, { confirm: true }); } catch (e) { toast(e.message, true); } redraw(); } }, 'Review…')));
    if (p.errors && p.errors.length) el.append(h('div', { class: 'pm-errors' }, p.errors.map((e) => h('div', { class: 'pm-err' }, e))));
    else if (p.error) el.append(h('div', { class: 'pm-errors' }, h('div', { class: 'pm-err' }, p.error.split('\n')[0])));
    if (open) {
      const body = h('div', { class: 'pbody' });
      body.append(h('div', { class: 'chips-about pm-chips' }, (p.permissions.length ? p.permissions : ['no permissions']).map((k) => h('span', { class: 'badge' + (k.startsWith('network') || k === 'workspace.write' || k === 'terminal' ? ' warn' : '') }, k)), chips.map((c) => h('span', { class: 'badge pm-c' }, c))));
      (p.warnings || []).forEach((w) => body.append(h('div', { class: 'u-note pm-note' }, 'Warning: ' + w)));
      body.append(h('div', { class: 'u-note pm-note' }, p.dir));
      if (p.source === 'user' && A.ws) body.append(row('Enabled for', 'Turn the plugin on everywhere, or only in the project that is open now', Sel([['all', 'Every project'], ['project', 'This project only'], ['off', 'Nowhere']], p.globalEnabled && p.projectOverride !== false ? 'all' : !p.globalEnabled && p.projectOverride === true ? 'project' : 'off', async (v) => { await RP.setMode(p.id, v); redraw(); }, { width: '190px' })));
      const form = settingsForm(p); if (form) body.append(form);
      const lg = logBox(() => RP.logs(p.id), () => RP.clearLogs(p.id));
      body.append(h('h5', { class: 'pm-h' }, 'Log'), lg);
      body.append(h('div', { class: 'pm-actions' },
        h('button', { class: 'btn sm', onclick: async () => { await RP.reloadPlugin(p.id); toast('Reloaded ' + p.name); redraw(); } }, 'Reload'),
        h('button', { class: 'btn sm', onclick: () => RP.api().openFolder({ which: p.dir }) }, 'Open folder'),
        p.manifest && p.manifest.main ? h('button', { class: 'btn sm', onclick: () => window.openFile(joinp(p.dir, p.manifest.main)) }, 'Edit code') : null,
        h('button', { class: 'btn sm', onclick: () => lg.clear() }, 'Clear log'),
        h('span', { style: { flex: 1 } }),
        p.source !== 'builtin' ? h('button', { class: 'btn sm danger', onclick: async () => { if (!(await confirmBox('Uninstall plugin', `Remove “${p.name}” and its files? Its stored data is deleted too.`, 'Uninstall', true))) return; try { await RP.uninstall(p.id); toast('Uninstalled ' + p.name); } catch (e) { toast(e.message, true); } redraw(); } }, 'Uninstall') : null));
      el.append(body);
    }
    return el;
  }

  async function installFlow(kind, redraw) {
    const from = kind === 'zip' ? await api.dialog.file([{ name: 'Plugin archive', extensions: ['zip'] }]) : await api.dialog.folder();
    if (!from) return;
    let r = await RP.install(from, { target: S.target });
    if (!r.ok && r.code === 'exists') { if (!(await confirmBox('Replace plugin', `“${r.id}” is already installed. Replace it with this version?`, 'Replace'))) return; r = await RP.install(from, { target: S.target, overwrite: true }); }
    if (!r.ok) { toast(r.error || 'Install failed', true); return; }
    toast('Installed ' + r.manifest.name); redraw();
    try { await RP.enable(r.id, { confirm: true }); } catch (e) { toast(e.message, true); }
    redraw();
  }

  // ---------------------------------------------------------------- tabs
  function installedTab(redraw) {
    const list = RP.list().sort((a, b) => a.name.localeCompare(b.name)); const wrap = h('div');
    const active = list.filter((p) => p.status === 'active').length;
    const tgt = A.ws ? Sel([['user', 'Install for every project'], ['workspace', 'Install for this project']], S.target, (v) => { S.target = v; }, { width: '210px' }) : null;
    const dev = h('input', { type: 'checkbox', class: 'sw', onchange: () => { A.settings.pluginDev = dev.checked; saveSettings(); redraw(); } }); dev.checked = !!A.settings.pluginDev;
    wrap.append(h('div', { class: 'pm-tools' },
      h('button', { class: 'btn primary', onclick: () => installFlow('folder', redraw) }, 'Install from folder…'), h('button', { class: 'btn', onclick: () => installFlow('zip', redraw) }, 'Install from .zip…'), aiBtn(() => (A.ws && S.target === 'workspace' ? 'workspace' : 'user')), tgt,
      h('span', { style: { flex: 1 } }),
      h('button', { class: 'btn', onclick: () => RP.api().openFolder({ which: 'user' }) }, 'Open plugins folder'), h('button', { class: 'btn', onclick: async (e) => { e.target.textContent = 'Reloading…'; await RP.reload(); redraw(); } }, 'Reload all')));
    wrap.append(h('div', { class: 'u-note pm-intro' }, `${plural(list.length, 'plugin')} · ${active} active. Plugins are trusted code that runs inside Reva, so only enable ones you trust.`));
    if (!list.length) wrap.append(h('div', { class: 'empty pm-empty' }, 'No plugins installed yet.', h('br'), h('button', { class: 'btn', onclick: () => { S.tab = 'builtin'; redraw(); } }, 'Browse the built-in examples'), ' ', h('button', { class: 'btn', onclick: () => { S.tab = 'create'; redraw(); } }, 'Create one')));
    list.forEach((p) => wrap.append(card(p, redraw)));
    wrap.append(row('Developer mode', 'Show a live console for every plugin and print plugin logs to the DevTools console. Editing a plugin folder always hot-reloads it.', dev));
    return wrap;
  }

  function builtinTab(redraw) {
    const wrap = h('div'); const list = RP.builtin().filter((p) => !p.id.startsWith('_')); // "_docs" ships docs, it is not a plugin
    wrap.append(h('div', { class: 'u-note pm-intro' }, 'Small, commented example plugins that ship with Reva. Install one to copy it into your plugins folder, then read or modify its code.'));
    for (const p of list) {
      const chips = contribChips(p.contributes);
      const btn = p.installed ? h('span', { class: 'badge' }, h('span', { html: icon('check') }), 'Installed')
        : h('button', { class: 'btn sm primary', onclick: async (e) => {
          e.target.disabled = true; const r = await RP.installBuiltin(p.id);
          if (!r.ok) { toast(r.error, true); e.target.disabled = false; return; }
          try { await RP.enable(p.id, { confirm: true }); } catch (x) { toast(x.message, true); } redraw();
        } }, 'Install');
      wrap.append(h('div', { class: 'prov-card pm-card' },
        h('div', { class: 'ph' }, h('span', { class: 'lg pm-ico', html: ico(pIcon(p), 22) }), h('div', { class: 'pi' }, h('b', null, p.name, h('span', { class: 'pm-ver' }, ' v' + p.version)), h('span', null, p.description)), btn),
        h('div', { class: 'chips-about pm-chips' }, (p.permissions.length ? p.permissions : ['no permissions']).map((k) => h('span', { class: 'badge' + (k.startsWith('network') || k === 'workspace.write' || k === 'terminal' ? ' warn' : '') }, k)), chips.map((c) => h('span', { class: 'badge pm-c' }, c)))));
    }
    return wrap;
  }

  function createTab(redraw) {
    const wrap = h('div'); const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    let idTouched = false;
    const name = h('input', { class: 'inp', placeholder: 'My plugin', oninput: () => { if (!idTouched) id.value = slug(name.value); } });
    const id = h('input', { class: 'inp mono', placeholder: 'my-plugin', oninput: () => { idTouched = true; } });
    const scope = A.ws ? Sel([['user', 'Every project (user plugins folder)'], ['workspace', 'This project (.reva/plugins)']], 'user', (v) => { scopeV = v; }, { width: '100%', menuWidth: 320 }) : null; let scopeV = 'user';
    const grid = h('div', { class: 'pm-tpls' }, TEMPLATES.map(([k, t, d, i]) => h('button', { class: 'pm-tpl' + (S.tpl === k ? ' on' : ''), type: 'button', onclick: () => { S.tpl = k; $$('.pm-tpl', grid).forEach((b) => b.classList.toggle('on', b === grid.children[TEMPLATES.findIndex((x) => x[0] === k)])); } }, h('span', { html: ico(i, 20) }), h('b', null, t), h('small', null, d))));
    const go = h('button', { class: 'btn primary', onclick: async () => {
      if (!name.value.trim()) return toast('Give the plugin a name', true);
      go.disabled = true;
      try {
        const r = await RP.create({ name: name.value.trim(), id: id.value.trim() || undefined, template: S.tpl, scope: scopeV });
        if (!r.ok) { toast(r.error, true); return; }
        toast('Created ' + name.value.trim()); S.tab = 'installed'; S.open[r.dir] = true; redraw();
        window.openFile(r.mainPath); // edit it right away; saving hot-reloads the plugin
      } finally { go.disabled = false; }
    } }, 'Create plugin');
    wrap.append(h('div', { class: 'u-note pm-intro' }, 'Scaffolds a working plugin in your plugins folder, starts it, and opens its code in the editor. Every time you save a file in the plugin folder it reloads live.'),
      h('div', { class: 'field' }, h('label', null, 'Name'), name), h('div', { class: 'field' }, h('label', null, 'Id'), id), scope ? h('div', { class: 'field' }, h('label', null, 'Where'), scope) : null,
      h('div', { class: 'field' }, h('label', null, 'Template'), grid), h('div', { style: { marginTop: '14px', display: 'flex', gap: '8px' } }, go, aiBtn(() => scopeV)));
    return wrap;
  }

  function consoleTab() {
    const wrap = h('div'); const ids = ['', ...RP.list().map((p) => p.id)];
    const filt = Sel(ids.map((x) => [x, x || 'All plugins']), S.logFilter, (v) => { S.logFilter = v; box.redraw(); }, { width: '200px' });
    const box = logBox(() => RP.allLogs().filter((l) => !S.logFilter || l.plugin === S.logFilter), () => { RP.list().forEach((p) => RP.clearLogs(p.id)); });
    box.style.height = '56vh';
    wrap.append(h('div', { class: 'pm-tools' }, filt, h('span', { style: { flex: 1 } }), h('button', { class: 'btn', onclick: () => box.clear() }, 'Clear')), box);
    return wrap;
  }

  // ---------------------------------------------------------------- shell
  function tabsFor() { return [['installed', 'Installed', 'plug'], ['builtin', 'Built-in examples', 'sparkle'], ['create', 'Create', 'plus'], ...(A.settings.pluginDev ? [['console', 'Console', 'term']] : [])]; }
  function build(host, { nav }) {
    let sig = '';
    const content = h('div', { class: 'pm-content' });
    const navEl = nav ? h('div', { class: 'nav' }) : null; const seg = nav ? null : h('div', { class: 'seg pm-seg' });
    const redraw = () => {
      if (!host.isConnected) return;
      if (S.tab === 'console' && !A.settings.pluginDev) S.tab = 'installed';
      const tabs = tabsFor();
      const mk = (el) => { tabs.forEach(([k, l, i]) => el.append(h('button', { class: S.tab === k ? 'on' : '', onclick: () => { S.tab = k; redraw(); } }, nav ? [h('span', { class: 'ni', html: icon(i) }), l] : l))); };
      if (navEl) { navEl.replaceChildren(h('h4', null, 'Plugins')); mk(navEl); } else { seg.replaceChildren(); mk(seg); }
      const st = content.scrollTop; content.replaceChildren(S.tab === 'installed' ? installedTab(redraw) : S.tab === 'builtin' ? builtinTab(redraw) : S.tab === 'create' ? createTab(redraw) : consoleTab(), docsFooter()); content.scrollTop = st;
      sig = signature();
    };
    const signature = () => RP.list().map((p) => [p.id, p.status, p.enabled, p.version, p.errors.length, p.error, p.missingPermissions.length].join(':')).join('|') + RP.builtin().map((p) => p.installed).join('') + (A.settings.pluginDev ? 'd' : '');
    const off = RP.onChange(() => { if (!host.isConnected) { off(); return; } if (S.tab !== 'create' && signature() !== sig) redraw(); });
    return { redraw, navEl, seg, content };
  }

  RP.openManager = function (tab) {
    if (tab) S.tab = tab;
    const body = h('div', { class: 'body selectable pm-body' }); let ui;
    const m = openModal([h('div', { class: 'nav' }), body], { cls: 'settings pm-modal' });
    ui = build(m.modal, { nav: true });
    m.modal.replaceChild(ui.navEl, m.modal.firstChild); body.append(ui.content); ui.redraw();
    return m;
  };
  RP.settingsView = function (tab) {
    if (tab) S.tab = tab;
    const host = h('div', { class: 'pm-embed' }); const ui = build(host, { nav: false });
    host.append(ui.seg, ui.content);
    const out = [h('h3', null, 'Plugins'), h('p', { class: 'lead' }, 'Extend Reva with commands, panels, themes, snippets and tools for your agents. Plugins are small scripts that live in a folder; saving a file reloads the plugin immediately.'), host];
    setTimeout(() => ui.redraw(), 0); return out;
  };

  addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'x' && !e.altKey) { e.preventDefault(); RP.openManager(); } });
})();
