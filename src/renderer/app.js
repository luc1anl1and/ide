// App bootstrap, editor, layout, palette, status bar
(function () {
  const files = new Map(); // path -> {path, kind, model, dirty, savedVid, view, dataUrl}
  let activePath = null, editor = null;
  const ico = (n, s = 13) => icon(n).replace('<svg', `<svg width="${s}" height="${s}"`);

  // ---------- status bar ----------
  window.updateStatus = function () {
    const sb = $('#statusbar'); if (!sb) return;
    const c = A.activeChat; const P = c ? PROV[c.cfg.provider] : null;
    const st = c ? Prov.status(c.cfg.provider) : { state: 'unknown' };
    const item = (html, fn, title) => h('div', { class: 'si', html, onclick: fn, title: title || '' });
    sb.innerHTML = '';
    const add = (...els) => els.forEach((e) => e && sb.append(e));
    const f = activePath && files.get(activePath);
    add(
      item(ico('folder') + (A.ws ? esc(basename(A.ws)) : 'No folder'), () => App.openFolder(), A.ws || 'Open a folder'),
      item(c && c.running ? '<span class="spin"></span>' + esc(P.name) + ' is working…' : st.state === 'ready' ? esc(P.name) + ' ready' : st.state === 'missing' ? esc(P ? P.name : '') + ' not installed' : st.state === 'login' ? esc(P.name) + ': sign in' : '…', () => c && openSettings('agents')),
      h('div', { class: 'sp' }),
      c && c.cost ? item('$' + c.cost.toFixed(3), null, 'Session cost (API-equivalent)') : null,
      c && c.tokens && (c.tokens.input || c.tokens.output) ? item(fmtTok(c.tokens.input + c.tokens.output) + ' tokens', null, 'Tokens this chat') : null,
      item(ico('plug') + `${A.mcp.filter((x) => x.status === 'connected').length}/${A.mcp.length} MCP`, () => Panels.show('mcp'), 'MCP servers'),
      f && f.kind === 'text' ? item(`Ln ${App.cursor.line}, Col ${App.cursor.col}`) : null,
      f && f.kind === 'text' ? item(esc(f.model.getLanguageId())) : null,
      item(esc((THEMES[A.settings.theme] || {}).name || ''), () => App.pickTheme(), 'Color theme'));
    Bar.renderRight();
  };

  // ---------- editor ----------
  function editorOptions() {
    const s = A.settings;
    return {
      fontFamily: s.editorFont, fontSize: +s.editorSize, lineHeight: +s.editorLineHeight || 0, fontLigatures: !!s.ligatures, wordWrap: s.wordWrap, minimap: { enabled: !!s.minimap, renderCharacters: false },
      lineNumbers: s.lineNumbers, tabSize: +s.tabSize, cursorStyle: s.cursorStyle, cursorSmoothCaretAnimation: s.smoothCaret ? 'on' : 'off',
      bracketPairColorization: { enabled: !!s.bracketColors }, smoothScrolling: true, cursorBlinking: 'smooth', renderLineHighlight: 'line',
      padding: { top: 12, bottom: 12 }, scrollBeyondLastLine: false, automaticLayout: true, fixedOverflowWidgets: true,
      guides: { indentation: true, bracketPairs: true, highlightActiveIndentation: true, bracketPairsHorizontal: 'active' }, stickyScroll: { enabled: true }, folding: true, showFoldingControls: 'mouseover',
      glyphMargin: false, lineDecorationsWidth: 14, lineNumbersMinChars: 3, renderWhitespace: 'selection', matchBrackets: 'always', overviewRulerBorder: false, hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false }, roundedSelection: true, occurrencesHighlight: 'off', renderLineHighlight: 'line',
    };
  }
  function initEditor() {
    return new Promise((res) => {
      const base = new URL('../../node_modules/monaco-editor/min/', location.href).href;
      window.MonacoEnvironment = { getWorkerUrl: () => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(`self.MonacoEnvironment={baseUrl:'${base}'};importScripts('${base}vs/base/worker/workerMain.js');`) };
      require.config({ paths: { vs: base + 'vs' } });
      require(['vs/editor/editor.main'], () => {
        defineMonacoThemes(monaco, A.settings.accent); window.__monacoReady = true;
        editor = monaco.editor.create($('#monaco'), { ...editorOptions(), theme: 'am-' + A.settings.theme, model: null });
        editor.onDidChangeCursorPosition((e) => { App.cursor = { line: e.position.lineNumber, col: e.position.column }; clearTimeout(App._ct); App._ct = setTimeout(updateStatus, 80); });
        editor.addAction({ id: 'am.addToChat', label: 'Add Selection to Chat', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL], contextMenuGroupId: 'navigation', contextMenuOrder: 0, run: () => App.selectionToChat(false) });
        editor.addAction({ id: 'am.askClaude', label: 'Ask Agent About Selection', contextMenuGroupId: 'navigation', contextMenuOrder: 1, run: () => App.selectionToChat(true) });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFile());
        editor.onDidBlurEditorWidget(() => { if (A.settings.autoSave === 'onFocusChange') saveAll(); });
        res();
      });
    });
  }
  const tabLabel = (p, f) => (f.kind === 'browser' ? (f.pane.title || (f.pane.url ? f.pane.url.replace(/^https?:\/\//, '') : 'New preview')).slice(0, 28) : f.kind === 'diff' ? 'Diff · ' + f.title : basename(p));
  let tabsScroll = null, tabsEnd = null, tabsWrap = null;
  function initTabs() {
    tabsScroll = h('div', { id: 'tabs-scroll' }); tabsEnd = h('div', { id: 'tabs-end' });
    tabsWrap = TabScroll(tabsScroll, {
      list: () => [...files].map(([p, f]) => ({ value: p, label: tabLabel(p, f), sub: f.kind === 'text' ? relp(p) : f.kind === 'browser' ? 'Preview' : f.kind === 'diff' ? 'Changes' : 'Image', on: p === activePath, icon: ico(f.kind === 'browser' ? 'globe' : f.kind === 'diff' ? 'edit' : f.kind === 'image' ? 'image' : 'file', 16) })),
      onPick: (p) => files.has(p) && showFile(p),
    });
    $('#editor-tabs').append(tabsWrap, tabsEnd);
  }
  function renderTabs() {
    const t = tabsScroll; t.innerHTML = '';
    files.forEach((f, p) => t.append(h('div', { class: 'tab' + (p === activePath ? ' on' : '') + (f.dirty ? ' dirty' : ''), title: f.kind === 'browser' ? (f.pane.url || 'Preview') : p, onclick: () => showFile(p), onauxclick: (e) => e.button === 1 && closeFile(p) },
      h('span', { class: 'fi ext-' + (f.kind === 'image' ? 'img' : extOf(p)), style: { display: 'grid' }, html: ico(f.kind === 'browser' ? 'globe' : f.kind === 'diff' ? 'edit' : f.kind === 'image' ? 'image' : 'file', 14).replace('<svg', '<svg style="stroke:currentColor;fill:none;stroke-width:1.6"') }),
      h('span', null, tabLabel(p, f)), h('span', { class: 'x', html: icon('x'), onclick: (e) => { e.stopPropagation(); closeFile(p); } }))));
    // right side of the strip: list of all tabs + contextual actions (preview button for web files)
    tabsEnd.innerHTML = '';
    if (files.size > 1) tabsEnd.append(tabsWrap.listButton('All open tabs'));
    const af = activePath && files.get(activePath);
    if (af && af.kind === 'text' && /\.(html?|svg)$/i.test(activePath)) tabsEnd.append(h('button', { class: 'btn sm prev-btn', title: 'Open this page in the preview (live reloads when you save)', html: icon('globe') + '<span>Preview</span>', onclick: () => IDE.exec('open_preview', { file: activePath }) }));
    window.Chat && Chat.updateCtxChip && Chat.updateCtxChip();
    $('#welcome').classList.toggle('hidden', files.size > 0);
    $('#editor-tabs').style.display = files.size ? '' : 'none';
    tabsWrap.update(); const on = $('.tab.on', t); if (on) tabsWrap.reveal(on);
  }  function showFile(p, line) {
    if (window.App && App.leaveFocus) App.leaveFocus(true);
    if (activePath && files.has(activePath) && files.get(activePath).kind === 'text') files.get(activePath).view = editor.saveViewState();
    activePath = p; const f = files.get(p);
    $('#viewer').classList.toggle('hidden', f.kind !== 'image');
    $('#monaco').style.visibility = f.kind === 'text' ? 'visible' : 'hidden';
    const bh = $('#browser-host'); bh.classList.toggle('hidden', f.kind !== 'browser');
    $('#diff-host').classList.toggle('hidden', f.kind !== 'diff'); if (f.kind === 'diff') { renderDiff(f); renderTabs(); updateStatus(); return; }
    files.forEach((x) => { if (x.kind === 'browser') x.pane.el.style.display = x === f ? '' : 'none'; });
    if (f.kind === 'browser') { renderTabs(); updateStatus(); f.pane.focus && f.pane.focus(); return; }
    if (f.kind === 'image') {
      const v = $('#viewer'); v.innerHTML = '';
      const img = h('img', { src: f.dataUrl, onload: () => v.append(h('div', { class: 'vinfo' }, `${img.naturalWidth} × ${img.naturalHeight}`)) });
      v.append(img, h('button', { class: 'btn sm', style: { position: 'absolute', top: '12px', right: '12px' }, onclick: () => Chat.insert('@' + relp(p) + ' ') }, 'Send to chat'));
    } else {
      editor.setModel(f.model); if (f.view) editor.restoreViewState(f.view);
      if (line) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); }
      editor.focus();
    }
    renderTabs(); updateStatus();
  }
  window.openFile = async function (p, line) {
    if (files.has(p)) return showFile(p, line);
    const r = await api.fs.read(p);
    if (r.kind === 'image') files.set(p, { path: p, kind: 'image', dataUrl: r.dataUrl });
    else if (r.kind === 'text') {
      const model = monaco.editor.createModel(r.content, undefined, monaco.Uri.file(p));
      const f = { path: p, kind: 'text', model, dirty: false, savedVid: model.getAlternativeVersionId(), mtime: r.mtime };
      model.onDidChangeContent(() => {
        const d = model.getAlternativeVersionId() !== f.savedVid; if (d !== f.dirty) { f.dirty = d; renderTabs(); }
        if (d && A.settings.autoSave === 'afterDelay') { clearTimeout(f.at); f.at = setTimeout(() => saveFile(p), 900); }
      });
      files.set(p, f);
    } else { toast(r.kind === 'binary' ? 'Binary file — cannot display' : r.kind === 'toolarge' ? 'File too large to open' : r.error || 'Cannot open file', true); return; }
    showFile(p, line);
  };
  async function saveFile(p) {
    p = p || activePath; const f = files.get(p); if (!f || f.kind !== 'text') return;
    if (window.RevaPlugins) await RevaPlugins.beforeSave(p, f.model);
    const r = await api.fs.write({ file: p, content: f.model.getValue() });
    if (r.ok) { f.savedVid = f.model.getAlternativeVersionId(); f.dirty = false; renderTabs(); reloadPreviewsFor(p); window.RevaPlugins && RevaPlugins.notifySaved(p); } else toast('Save failed: ' + r.error, true);
  }
  function saveAll() { files.forEach((f, p) => f.dirty && saveFile(p)); }
  async function closeFile(p) {
    const f = files.get(p); if (!f) return;
    if (f.dirty && !(await confirmBox('Unsaved changes', `Close “${basename(p)}” without saving?`, 'Discard', true))) return;
    if (f.model) { if (editor.getModel() === f.model) editor.setModel(null); f.model.dispose(); }
    if (f.pane) { try { f.pane.destroy(); } catch { } $('#browser-host').classList.add('hidden'); }
    if (f.kind === 'diff') { disposeDiff(f); $('#diff-host').classList.add('hidden'); }
    files.delete(p);
    if (activePath === p) { activePath = null; const rest = [...files.keys()]; if (rest.length) showFile(rest[rest.length - 1]); else $('#viewer').classList.add('hidden'); }
    renderTabs(); updateStatus();
  }
  async function onDiskChange(paths) {
    Explorer.refresh(paths);
    for (const p of paths) {
      reloadPreviewsFor(p);
      const f = files.get(p); if (!f || f.kind === 'browser' || f.kind === 'diff') continue;
      if (f.kind === 'image') { const r = await api.fs.read(p); if (r.kind === 'image') { f.dataUrl = r.dataUrl; if (activePath === p) showFile(p); } continue; }
      const r = await api.fs.read(p);
      if (r.kind !== 'text' || r.content === f.model.getValue()) continue;
      if (f.dirty) { toast(basename(p) + ' changed on disk (you have unsaved edits)', true); continue; }
      const view = activePath === p ? editor.saveViewState() : null;
      f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: r.content }], () => null);
      f.savedVid = f.model.getAlternativeVersionId(); f.dirty = false; if (view) editor.restoreViewState(view); renderTabs();
    }
  }

  // ---------- layout ----------
  // Drag handle between two panes. Works on the *distance moved* since the press (so the pane never jumps under the cursor)
  // and puts a full-window shield over everything while dragging, so the browser preview <webview> cannot swallow mouse events.
  //   axis 'x'|'y', sign: +1 when moving right/down grows the pane, -1 when it shrinks it, start(): current size, apply(size)
  function resizer(id, axis, sign, start, apply) {
    const el = $(id); el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; e.preventDefault();
      const p0 = axis === 'x' ? e.screenX : e.screenY, v0 = start(); const cur = getComputedStyle(el).cursor;
      const shield = h('div', { style: { position: 'fixed', inset: '0', zIndex: '99999', cursor: cur } }); document.body.append(shield);
      el.classList.add('drag'); document.body.style.userSelect = 'none';
      const mv = (ev) => { apply(v0 + (((axis === 'x' ? ev.screenX : ev.screenY) - p0) * sign) / zoom()); };
      const zoom = () => (+A.settings.uiScale || 1);
      const up = () => { removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true); shield.remove(); el.classList.remove('drag'); document.body.style.userSelect = ''; saveSettings(); };
      addEventListener('mousemove', mv, true); addEventListener('mouseup', up, true);
    });
  }  function applyLayout() {
    const l = A.settings.layout;
    $('#sidebar').style.width = l.sideW + 'px'; $('#chat').style.width = l.chatW + 'px'; $('#terminal').style.height = l.termH + 'px';
    document.body.classList.toggle('collapsed-side', !l.sideOpen); document.body.classList.toggle('collapsed-chat', !l.chatOpen);
    $('#terminal').classList.toggle('hidden', !l.termOpen); $('#rz-term').classList.toggle('hidden', !l.termOpen);
    $('#btn-toggle-chat').classList.toggle('on', l.chatOpen); $('#btn-toggle-term').classList.toggle('on', l.termOpen);
    $('#btn-focus').classList.toggle('on', A.settings.chatLayout === 'focus');
    window.applyDockLayout && applyDockLayout();
  }

  // ---------- welcome ----------
  // The start screen shown when no file is open: greeting, "continue from your last chat", quick actions.
  async function buildWelcome() {
    const w = $('#welcome'); const s = A.settings; const my = (buildWelcome.n = (buildWelcome.n || 0) + 1);
    w.innerHTML = '';
    const hr = new Date().getHours(); const greet = hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    const recent = (s.recent || []).slice(0, 4);
    const cont = h('div', { class: 'wc-cont' });
    w.append(...[h('div', { class: 'wl' }), h('h1', null, `${greet}, ${s.userName || 'Dev'}`), h('div', { class: 'sub' }, A.ws ? 'Working in ' + basename(A.ws) : 'Pick a folder to start building'), cont,
      h('div', { class: 'wc-actions' },
        h('button', { class: 'wc-act', onclick: () => App.openFolder() }, h('span', { html: icon('folderPlus') }), h('div', null, h('b', null, 'Open folder'), h('small', null, 'Ctrl+O'))),
        h('button', { class: 'wc-act', onclick: () => { App.toggleChat(true); Chat.new(); } }, h('span', { html: icon('chat') }), h('div', null, h('b', null, 'New chat'), h('small', null, PROV[s.provider] ? PROV[s.provider].name : 'Claude'))),
        h('button', { class: 'wc-act', onclick: () => App.openBrowser() }, h('span', { html: icon('globe') }), h('div', null, h('b', null, 'Preview a site'), h('small', null, 'Ctrl+Shift+B'))),
        h('button', { class: 'wc-act', onclick: () => Panels.show('mcp') }, h('span', { html: icon('plug') }), h('div', null, h('b', null, 'MCP servers'), h('small', null, 'Connect tools')))),
      recent.length ? h('div', { class: 'wc-recent' }, h('span', null, 'Recent folders'), recent.map((r) => h('a', { onclick: () => App.setWorkspace(r), title: r }, basename(r)))) : null].filter(Boolean));
    applyBrand();
    // fill the "continue" card from the newest saved/CLI chat
    try {
      const all = A.welcomeChats || (A.welcomeChats = await api.sessions.all({ custom: { codex: customPath('codex'), opencode: customPath('opencode') } }));
      if (my !== buildWelcome.n) return;
      const here = (x) => !A.ws || !x.cwd || x.cwd.toLowerCase() === A.ws.toLowerCase();
      const list = all.filter((x) => PROV[x.provider]); const last = list.find(here) || list[0];
      if (!last) return;
      const open = (x) => { const cwd = x.cwd && x.cwd.toLowerCase() !== (A.ws || '').toLowerCase() ? x.cwd : null; Chat.new({ provider: x.provider, title: x.title.slice(0, 30), cwd, revaId: x.source === 'reva' ? x.id : null, resume: x.source === 'reva' ? (x.sessionId || null) : x.id }); App.toggleChat(true); };
      const meta = (x) => [PROV[x.provider].name, x.source === 'reva' ? 'saved in hyper-ide' : null, x.cwd ? basename(x.cwd) : null, timeAgo(x.updatedAt)].filter(Boolean).join(' · ');
      cont.append(h('div', { class: 'wc-last' }, h('span', { class: 'av', html: PROV[last.provider].logo }), h('div', { class: 'wc-lt' }, h('small', null, 'Continue from your last chat?'), h('b', null, last.title), h('span', null, meta(last))), h('button', { class: 'btn primary', onclick: () => open(last) }, 'Continue')));
      const more = list.filter((x) => x !== last).slice(0, 3);
      if (more.length) cont.append(h('div', { class: 'wc-more' }, more.map((x) => h('button', { class: 'wc-mi', onclick: () => open(x), title: x.title }, h('span', { class: 'av', html: PROV[x.provider].logo }), h('span', { class: 't' }, x.title), h('span', { class: 'm' }, timeAgo(x.updatedAt))))));
    } catch { /* no history yet */ }
  }

  // ---------- palette ----------
  function palette() {
    const cmds = [
      ['Open Folder…', Keys.get('openFolder'), () => App.openFolder()], ['New Chat', Keys.get('newChat'), () => Chat.new()], ['Settings', Keys.get('settings'), () => openSettings()],
      ['Go to File…', Keys.get('quickOpen'), () => quickOpen()], ['New File…', Keys.get('newFile'), () => newFileDialog(currentDir(), false)], ['New Folder…', '', () => newFileDialog(currentDir(), true)], ['Open Browser Preview', Keys.get('browser'), () => App.openBrowser()], ['New Terminal', '', () => { App.toggleTerm(true); Terminals.newTab({}); }],
      ['Toggle Sidebar', Keys.get('toggleSide'), () => App.toggleSide()], ['Toggle Chat Panel', Keys.get('toggleChat'), () => App.toggleChat()], ['Toggle Terminal', Keys.get('toggleTerm'), () => App.toggleTerm()],
      ['Focus Mode (chat only)', '', () => setSetting('chatLayout', A.settings.chatLayout === 'focus' ? 'side' : 'focus')],
      ['Show Files', '', () => Panels.show('explorer')], ['Show Search', '', () => Panels.show('search')], ['Show Chats', '', () => Panels.show('sessions')], ['Show MCP Servers', '', () => Panels.show('mcp')],
      ['MCP: Add Server…', '', () => { Panels.show('mcp'); setTimeout(() => McpPanel.addDialog(), 50); }], ['MCP: Refresh Status', '', () => { Panels.show('mcp'); McpPanel.refresh(); }],
      ['Color Theme…', '', () => App.pickTheme()], ['Agents: Set up & sign in', '', () => openSettings('agents')], ['Usage: Refresh', '', () => Usage.refresh()],
      ['Save File', Keys.get('save'), () => saveFile()], ['Save All', '', saveAll], ['Close Tab', Keys.get('closeTab'), () => activePath && closeFile(activePath)],
      ['Reload Window', 'Ctrl+F5', () => location.reload()],
      ...PROV_IDS.map((id) => ['New chat with ' + PROV[id].name, '', () => Chat.new({ provider: id })]),
      ...Object.entries(THEMES).map(([id, t]) => ['Theme: ' + t.name, '', () => setSetting('theme', id)]),
    ];
    runPicker('Type a command…', cmds.map(([l, k, fn]) => ({ label: l, hint: k, fn })).concat(window.RevaPlugins ? RevaPlugins.paletteItems() : []));
  }
  function runPicker(ph, items, opts = {}) {
    const inp = h('input', { placeholder: ph }); const list = h('div', { class: 'list' }); let idx = 0, shown = opts.filter ? opts.filter(items, '') : items;
    const m = openModal([inp, list], { cls: 'palette' });
    const draw = () => { list.innerHTML = ''; shown.slice(0, 80).forEach((it, i) => list.append(h('div', { class: 'it' + (i === idx ? ' on' : ''), onclick: () => run(it), onmousemove: () => { idx = i; $$('.it', list).forEach((e, j) => e.classList.toggle('on', j === i)); } }, h('span', null, it.label), h('kbd', null, it.hint || '')))); };
    const run = (it) => { m.close(); it.fn(); };
    inp.addEventListener('input', () => { const q = inp.value.toLowerCase(); shown = opts.filter ? opts.filter(items, q) : items.filter((x) => q.split(/\s+/).every((w) => x.label.toLowerCase().includes(w))); idx = 0; draw(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, shown.length - 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && shown[idx]) run(shown[idx]);
      $$('.it', list)[idx]?.scrollIntoView({ block: 'nearest' });
    });
    draw(); inp.focus();
  }

  window.getEditorContext = function () {
    const f = activePath && files.get(activePath); if (!f || f.kind !== 'text' || !editor) return null;
    const sel = editor.getSelection(); const text = f.model.getValue();
    return { path: activePath, rel: relp(activePath), language: f.model.getLanguageId(), line: editor.getPosition().lineNumber, selection: sel && !sel.isEmpty() ? editor.getModel().getValueInRange(sel).slice(0, 4000) : '', selStart: sel ? sel.startLineNumber : 0, selEnd: sel ? sel.endLineNumber : 0, text, size: text.length, dirty: !!f.dirty };
  };

  // ---------- diff tab: what an agent changed, side by side, with Revert / Keep ----------
  function disposeDiff(f) { try { f.diff && f.diff.dispose(); } catch { } try { f.mOrig && f.mOrig.dispose(); f.mCur && f.mCur.dispose(); } catch { } f.diff = null; }
  function renderDiff(f) {
    const host = $('#diff-host'); host.innerHTML = ''; disposeDiff(f);
    const o = f.o; const close = () => closeFile('diff:' + o.rel);
    const bar = h('div', { class: 'diff-bar' }, h('b', null, o.rel), h('span', { class: 'badge' }, o.action === 'created' ? 'New file' : o.action === 'deleted' ? 'Deleted' : 'Modified'), h('span', { class: 'sp' }),
      h('button', { class: 'btn sm', onclick: async () => { const r = await api.cp.revertFile({ rel: o.rel, t: o.t }); if (r.ok) { toast('Reverted ' + o.rel); close(); } else toast(r.error || 'Could not revert', true); } }, 'Revert this file'),
      h('button', { class: 'btn sm ghost', onclick: close }, 'Close'));
    const box = h('div', { class: 'diff-box' }); host.append(bar, box);
    const ext = '.' + (o.full.split('.').pop() || '').toLowerCase(); const lang = (monaco.languages.getLanguages().find((l) => (l.extensions || []).includes(ext)) || {}).id || 'plaintext';
    f.mOrig = monaco.editor.createModel(f.base, lang); f.mCur = monaco.editor.createModel(f.cur, lang);
    f.diff = monaco.editor.createDiffEditor(box, { ...editorOptions(), minimap: { enabled: false }, readOnly: true, originalEditable: false, renderSideBySide: A.settings.diffInline !== true, automaticLayout: true, theme: 'am-' + A.settings.theme, enableSplitViewResizing: true, renderOverviewRuler: false });
    f.diff.setModel({ original: f.mOrig, modified: f.mCur });
  }
  // ---------- IDE tools: what agents can do through the built-in MCP server ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
  const IDE = {
    previews: () => [...files].filter(([, f]) => f.kind === 'browser').map(([id, f]) => ({ id, pane: f.pane, file: f.file })),
    pick(id) {
      const list = IDE.previews(); const p = id ? list.find((x) => x.id === id) : (list.find((x) => x.id === activePath) || list[list.length - 1]);
      if (!p) throw new Error('No preview tab is open. Call open_preview first.');
      return p;
    },
    async exec(tool, a = {}) {
      try {
        switch (tool) {
          case 'ide_context': {
            const f = activePath && files.get(activePath); let active = null;
            if (f && f.kind === 'text') { const sel = editor.getSelection(); active = { path: activePath, language: f.model.getLanguageId(), line: editor.getPosition().lineNumber, dirty: f.dirty, selection: editor.getModel().getValueInRange(sel).slice(0, 4000) }; }
            else if (f && f.kind === 'browser') active = { preview: f.pane.url };
            return text(JSON.stringify({ workspace: A.ws, activeFile: active, openTabs: [...files].filter(([, x]) => x.kind !== 'browser').map(([p]) => p), previews: IDE.previews().map((p) => ({ id: p.id, url: p.pane.url, title: p.pane.title, file: p.file || null })), terminals: Terminals.count(), chat: { agent: A.activeChat && A.activeChat.cfg.provider } }, null, 2));
          }
          case 'open_file': { let p = String(a.path || ''); if (!/^[a-zA-Z]:[\\/]/.test(p)) p = A.ws ? joinp(A.ws, p.replace(/\//g, '\\')) : p; await window.openFile(p, +a.line || 0); return text('Opened ' + p); }
          case 'open_preview': {
            let pane, id; const url = a.url, file = a.file ? (/^[a-zA-Z]:[\\/]/.test(a.file) ? a.file : joinp(A.ws || '', String(a.file).replace(/\//g, '\\'))) : null;
            if (!url && !file) throw new Error('Pass url or file');
            const same = file && IDE.previews().find((x) => x.file === file); const any = a.reuse !== false && IDE.previews().find((x) => x.id === activePath) || (a.reuse !== false && IDE.previews().slice(-1)[0]);
            const target = file ? fileUrl(file) : url;
            if (same) { id = same.id; pane = same.pane; pane.reload(); } else if (any && !file) { id = any.id; pane = any.pane; pane.navigate(target); } else { pane = App.openBrowser({ url: target, file }); id = [...files].find(([, f]) => f.pane === pane)[0]; }
            if (a.device) pane.setDevice(a.device); showFile(id);
            for (let i = 0; i < 40 && pane.loading; i++) await sleep(100); await sleep(250);
            return text(JSON.stringify({ id, url: pane.url, title: pane.title }));
          }
          case 'preview_reload': { const p = IDE.pick(a.id); p.pane.reload(!!a.hard); await sleep(600); return text('Reloaded ' + p.pane.url); }
          case 'preview_screenshot': {
            const p = IDE.pick(a.id); showFile(p.id); await sleep(350);
            const img = await p.pane.screenshot(); return { content: [{ type: 'image', data: img.data, mimeType: 'image/png' }, { type: 'text', text: 'Screenshot of ' + p.pane.url }] };
          }
          case 'preview_console': {
            const p = IDE.pick(a.id); const lv = a.level || 'all'; let list = p.pane.console.filter((m) => lv === 'all' || (lv === 'error' ? /error/i.test(m.level) : /warn|error/i.test(m.level)));
            list = list.slice(-(+a.limit || 50)); if (a.clear) p.pane.console.length = 0;
            return text(list.length ? list.map((m) => `[${m.level}] ${m.message}${m.source ? ' (' + String(m.source).split('/').pop() + ':' + m.line + ')' : ''}`).join('\n') : 'No console messages' + (lv !== 'all' ? ' at that level' : ''));
          }
          case 'preview_html': {
            const p = IDE.pick(a.id); const max = Math.min(+a.max_chars || 8000, 60000);
            const r = await p.pane.eval(`(function(sel,max){var e=sel?document.querySelector(sel):document.body;if(!e)return 'No element matches '+sel;var h=e.outerHTML;return h.length>max?h.slice(0,max)+'…[truncated '+(h.length-max)+' chars]':h})(${JSON.stringify(a.selector || '')},${max})`);
            return text(r);
          }
          case 'preview_eval': { const p = IDE.pick(a.id); const r = await p.pane.eval(a.code); return text(r === undefined ? 'undefined' : typeof r === 'string' ? r : JSON.stringify(r, null, 2)); }
          case 'terminal_run': {
            App.toggleTerm(true); const before = Terminals.read(500).split('\n').length;
            if (a.new_tab) await Terminals.newTab({ command: a.command }); else await Terminals.runCommand(a.command);
            await sleep(Math.min(Math.max(+a.wait_ms || 1500, 300), 20000));
            const all = Terminals.read(600).split('\n'); return text(all.slice(Math.max(0, before - 2)).join('\n').slice(-6000) || '(no output yet)');
          }
          case 'terminal_read': return text(Terminals.read(+a.lines || 200, a.tab) || '(terminal is empty)');
          default:
            if (window.PreviewTools && PreviewTools.names.includes(tool)) return await PreviewTools.run(IDE, tool, a);
            throw new Error('Unknown IDE tool: ' + tool);
        }
      } catch (e) { return { content: [{ type: 'text', text: 'Error: ' + (e.message || e) }], isError: true }; }
    },
  };
  const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
  window.IDE = IDE; window.showPreviewTab = (id) => { if (files.has(id) && activePath !== id) showFile(id); };
  // reload any preview showing a file that was just saved / changed by an agent
  function reloadPreviewsFor(path) { IDE.previews().filter((x) => x.file === path).forEach((x) => { try { x.pane.reload(); } catch { } }); }

  // ---------- quick open (Ctrl+P): jump to any file in the workspace ----------
  let fileCache = { ws: null, list: [], at: 0 };
  async function quickOpen() {
    if (!A.ws) { toast('Open a folder first', true); return; }
    if (fileCache.ws !== A.ws || Date.now() - fileCache.at > 15000) fileCache = { ws: A.ws, list: await api.fs.list(A.ws), at: Date.now() };
    const items = fileCache.list.map((r) => ({ label: basename(r), hint: r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '', rel: r, fn: () => window.openFile(joinp(A.ws, r.replace(/\//g, '\\')) ) }));
    const score = (it, q) => { const n = it.label.toLowerCase(), p = it.rel.toLowerCase(); let s = 0; for (const w of q.split(/\s+/).filter(Boolean)) { if (n.startsWith(w)) s += 3; else if (n.includes(w)) s += 2; else if (p.includes(w)) s += 1; else { let k = 0; for (const ch of n) if (ch === w[k]) k++; if (k === w.length) s += .5; else return 0; } } return s || (q ? 0 : 1); };
    runPicker('Go to file…', items, { filter: (all, q) => (q.trim() ? all.map((it) => [it, score(it, q.trim())]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1] || a[0].rel.length - b[0].rel.length).map((x) => x[0]) : all.slice(0, 60)) });
  }
  window.quickOpen = quickOpen;

  // ---------- public App ----------
  window.App = {
    cursor: { line: 1, col: 1 },
    applyEditorOptions() { if (editor) editor.updateOptions(editorOptions()); },
    async openFolder() { const d = await api.dialog.folder(); if (d) this.setWorkspace(d); },
    async setWorkspace(dir) {
      dir = dir.replace(/\//g, '\\').replace(/\\+$/, ''); A.ws = dir;
      const s = A.settings; s.lastWorkspace = dir; s.recent = [dir, ...(s.recent || []).filter((x) => x !== dir)].slice(0, 10); saveSettings();
      Explorer.expanded.clear(); Explorer.cache = {}; Explorer.sel = null;
      [...files.keys()].forEach((p) => { const f = files.get(p); if (f.model) f.model.dispose(); if (f.pane) { try { f.pane.destroy(); } catch { } } if (f.kind === 'diff') disposeDiff(f); files.delete(p); }); $('#browser-host').classList.add('hidden'); $('#diff-host').classList.add('hidden'); activePath = null; if (editor) editor.setModel(null); renderTabs();
      await api.ws.watch(dir); api.pop.broadcast({ ch: 'pop:ws', payload: dir });
      [...A.chats].forEach((c) => api.agent.kill(c.id)); A.chats.forEach((c) => c.pane.remove()); A.chats.length = 0; Chat.new();
      Term.reset(); if (Term.out) Term.out.innerHTML = '';
      Panels.refreshDocks(); buildWelcome(); updateStatus(); Panels.visible('mcp') && McpPanel.refresh();
    },
    // focus layout: editor hidden, chat full width, chat list stays on the left (hide/show with Ctrl+B)
    syncLayout() {
      const focus = A.settings.chatLayout === 'focus'; document.body.classList.toggle('chat-focus', focus);
      if (focus) { if (Panels.current() !== 'sessions') this._prevPanel = Panels.current(); A.settings.layout.sideOpen = true; A.settings.layout.chatOpen = true; applyLayout(); Panels.show('sessions'); }
      else { applyLayout(); if (this._prevPanel) Panels.show(this._prevPanel); }
    },
    rebuildWelcome() { A.welcomeChats = null; buildWelcome(); },
    async openDiff(o) {
      const id = 'diff:' + o.rel; if (files.has(id)) { const old = files.get(id); disposeDiff(old); files.delete(id); }
      const base = (await api.cp.base({ rel: o.rel, t: o.t })) || ''; let cur = ''; try { const r = await api.fs.read(o.full); if (r.kind === 'text') cur = r.content; } catch { }
      files.set(id, { kind: 'diff', title: basename(o.full), o, base, cur }); showFile(id);
    },
    toggleSide2(v) { const l = A.settings.layout; l.rightOpen = v == null ? !l.rightOpen : v; applyLayout(); saveSettings(); },
    toggleSide(v) { const l = A.settings.layout; l.sideOpen = v == null ? !l.sideOpen : v; applyLayout(); saveSettings(); },
    // in focus mode the editor is hidden: hiding the chat there takes you to the editor, opening a file brings the editor in between the sidebar and the chat
    leaveFocus(keepChat) { if (A.settings.chatLayout !== 'focus') return false; A.settings.chatLayout = 'side'; A.settings.layout.chatOpen = !!keepChat; document.body.classList.remove('chat-focus'); this.syncLayout(); saveSettings(); return true; },
    toggleChat(v) { const l = A.settings.layout; const want = v == null ? !(l.chatOpen && A.settings.chatLayout !== 'focus' || A.settings.chatLayout === 'focus') : v; if (!want && this.leaveFocus(false)) return; l.chatOpen = want; applyLayout(); saveSettings(); },
    // site preview as an editor tab (webview with devtools, device sizes, screenshots → chat)
    openBrowser(arg) {
      const o = !arg || typeof arg === 'string' ? { url: arg || '' } : arg;
      const id = 'browser:' + Date.now().toString(36) + Math.floor(Math.random() * 99); const pane = BrowserPane.create({ url: o.url || '', liveReload: true });
      pane.on('title', () => renderTabs()); pane.on('url', () => renderTabs());
      $('#browser-host').append(pane.el); files.set(id, { kind: 'browser', pane, file: o.file || null }); showFile(id); return pane;
    },
    toggleTerm(v) { const l = A.settings.layout; l.termOpen = v == null ? !l.termOpen : v; applyLayout(); saveSettings(); if (l.termOpen) Term.open(); },
    pickTheme() { runPicker('Select color theme…', Object.entries(THEMES).map(([id, t]) => ({ label: t.name + (t.dark ? '' : ' (light)'), fn: () => setSetting('theme', id) }))); },
    selectionToChat(send) {
      const f = files.get(activePath); if (!f || f.kind !== 'text') return;
      const sel = editor.getSelection(); const txt = editor.getModel().getValueInRange(sel);
      const ref = `${relp(activePath)}:${sel.startLineNumber}-${sel.endLineNumber}`;
      const block = txt.trim() ? `\`\`\`${f.model.getLanguageId()}\n${txt}\n\`\`\`\n(${ref})\n` : `@${relp(activePath)} `;
      App.toggleChat(true);
      if (send) Chat.sendNow('Explain this code:\n' + block); else Chat.insert(block);
    },
  };

  // ---------- title bar wiring ----------
  function wireTitlebar() {
    $('#btn-palette').innerHTML = icon('search'); $('#btn-toggle-term').innerHTML = icon('panelBottom'); $('#btn-toggle-chat').innerHTML = icon('panelRight');
    $('#btn-focus').innerHTML = icon('focus'); $('#btn-settings').innerHTML = icon('gear');
    $('#btn-browser').innerHTML = icon('globe'); $('#btn-browser').onclick = () => App.openBrowser();
    $('#btn-palette').onclick = palette; $('#btn-toggle-term').onclick = () => App.toggleTerm(); $('#btn-toggle-chat').onclick = () => App.toggleChat();
    $('#btn-focus').onclick = () => { setSetting('chatLayout', A.settings.chatLayout === 'focus' ? 'side' : 'focus'); App.syncLayout(); };
    $('#btn-settings').onclick = () => openSettings();
    $('#btn-usage').onclick = (e) => Usage.open(e.currentTarget);
    $('#btn-ws').onclick = (e) => {
      const rec = (A.settings.recent || []).filter((r) => r !== A.ws);
      Combo.open(e.currentTarget, { title: 'Workspace', width: 340, items: [
        { value: '__open', label: 'Open folder…', icon: icon('folderPlus') },
        ...(A.ws ? [{ value: A.ws, label: basename(A.ws), sub: A.ws, icon: icon('folder') }] : []),
        ...rec.map((r) => ({ value: r, label: basename(r), sub: r, icon: icon('folder'), group: 'Recent' }))],
        value: A.ws, onPick: (v) => (v === '__open' ? App.openFolder() : v !== A.ws && App.setWorkspace(v)) });
    };
    $('#btn-user').onclick = (e) => {
      Combo.open(e.currentTarget, { title: A.settings.userName || 'Dev', width: 290, align: 'right', items: [
        ...PROV_IDS.map((id) => { const st = Prov.status(id); const pl = (A.usage[id] && A.usage[id].plan) || ''; return { value: 'p:' + id, label: PROV[id].name, sub: st.state === 'ready' ? 'Signed in' + (pl ? ' · ' + pl : '') : st.label, icon: PROV[id].logo, group: 'Agents' }; }),
        { value: 'settings', label: 'Settings', icon: icon('gear'), group: 'App' }, { value: 'palette', label: 'Command palette', icon: icon('search'), group: 'App' }],
        onPick: (v) => { if (v === 'settings') openSettings(); else if (v === 'palette') palette(); else openSettings('agents'); } });
    };
  }

  // ---------- boot ----------
  async function boot() {
    const saved = await api.settings.get();
    A.settings = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...saved, layout: { ...DEFAULTS.layout, ...(saved.layout || {}) }, defaults: { ...DEFAULTS.defaults, ...(saved.defaults || {}) }, voice: { ...DEFAULTS.voice, ...(saved.voice || {}) } };
    A.settings.pet = { ...DEFAULTS.pet, ...(saved.pet || {}) };
    for (const p of PROV_IDS) A.settings.defaults[p] = { ...DEFAULTS.defaults[p], ...A.settings.defaults[p] };
    loadCustomThemes();
    if (A.settings.voice.model === 'base' && !A.settings.voice.v2) A.settings.voice.model = 'small'; // base was too weak for non-English
    A.settings.voice.v2 = true;
    // migrate old global Claude-only options into per-agent settings
    const ac = (A.settings.agentCfg = A.settings.agentCfg || {});
    if (!ac.claude && (A.settings.appendSystemPrompt || (A.settings.addDirs || []).length)) ac.claude = { instructions: A.settings.appendSystemPrompt || '', dirs: A.settings.addDirs || [], flags: '' };
    if (!A.settings.editorFont || /^Cascadia Code, Consolas/.test(A.settings.editorFont)) A.settings.editorFont = DEFAULTS.editorFont;
    if (!A.settings.termFont || /^"JetBrains Mono Variable", "Cascadia Code", Consolas$/.test(A.settings.termFont)) A.settings.termFont = DEFAULTS.termFont; // old default had no Nerd glyphs for prompts like oh-my-posh
    if (!A.settings.editorV3) { A.settings.minimap = false; A.settings.ligatures = false; A.settings.editorV3 = true; } // cleaner editor defaults
    Fonts.loadUser();
    A.logo = await api.app.getLogo();
    applySettings(); wireTitlebar(); initTabs();
    applyLayout(); buildWelcome();
    const L = () => A.settings.layout;
    resizer('#rz-side', 'x', 1, () => $('#sidebar').getBoundingClientRect().width, (w) => { w = Math.max(180, Math.min(560, w)); L().sideW = w; $('#sidebar').style.width = w + 'px'; });
    resizer('#rz-side2', 'x', -1, () => $('#sidebar2').getBoundingClientRect().width, (w) => { w = Math.max(200, Math.min(560, w)); L().side2W = w; $('#sidebar2').style.width = w + 'px'; });
    resizer('#rz-chat', 'x', -1, () => $('#chat').getBoundingClientRect().width, (w) => { w = Math.max(320, Math.min(900, w)); L().chatW = w; $('#chat').style.width = w + 'px'; });
    resizer('#rz-term', 'y', -1, () => $('#terminal').getBoundingClientRect().height, (hh) => { const r = $('#center').getBoundingClientRect(); hh = Math.max(80, Math.min(r.height - 150, hh)); L().termH = hh; $('#terminal').style.height = hh + 'px'; });    Prov.refreshCustom(); Panels.init(); Chat.init(); updateStatus();
    api.on('fs:changed', onDiskChange);
    api.on('pop:closed', (id) => Panels.popClosed(id));
    api.on('pop:call', ({ fn, args }) => {
      if (fn === 'openFile') window.openFile(...args); else if (fn === 'chatInsert') { App.toggleChat(true); Chat.insert(args[0]); } else if (fn === 'chatNew') { App.toggleChat(true); Chat.new(args[0]); } else if (fn === 'openFolder') App.openFolder();
    });
    api.on('ide:call', async ({ id, tool, args }) => { const result = await IDE.exec(tool, args); api.ide.reply({ id, result }); });
    // browser pane → chat bridges, and "dev server started" hint from the terminal
    window.attachToChat = (img) => { App.toggleChat(true); Chat.attachImage(img); toast('Screenshot added to the message'); };
    window.sendToChat = (text) => { App.toggleChat(true); Chat.insert(text + '\n'); };
    Terminals.onLocalUrl = (url) => toastAction('Dev server running at ' + url.replace(/^https?:\/\//, ''), 'Open preview', () => App.openBrowser(url));
    if (A.settings.chatLayout === 'focus') App.syncLayout();
    Prov.boot(); setTimeout(() => A.mcp.length === 0 && backgroundMcp(), 1500);
    await initEditor();
    applySettings('theme'); renderTabs();
    if (A.settings.lastWorkspace) { try { await App.setWorkspace(A.settings.lastWorkspace); } catch { } }
    window.__ready = true; api.app.ready();
  }
  async function backgroundMcp() { const r = await api.mcp.list({ custom: A.settings.claudePath, cwd: A.ws }); A.mcp = r.servers; updateStatus(); if (Panels.visible('mcp')) McpPanel.render(); }

  // every command that has a (rebindable) shortcut
  Keys.register([
    { id: 'palette', label: 'Command palette', def: 'Ctrl+Shift+P', run: () => palette() },
    { id: 'quickOpen', label: 'Go to file', def: 'Ctrl+P', run: () => quickOpen() },
    { id: 'openFolder', label: 'Open folder', def: 'Ctrl+O', run: () => App.openFolder() },
    { id: 'newFile', label: 'New file', def: 'Ctrl+N', run: () => newFileDialog(currentDir(), false) },
    { id: 'newChat', label: 'New chat', def: 'Ctrl+Shift+N', run: () => { App.toggleChat(true); Chat.new(); } },
    { id: 'focusChat', label: 'Focus chat input', def: 'Ctrl+L', run: () => { App.toggleChat(true); Chat.active().ta.focus(); } },
    { id: 'toggleSide', label: 'Show / hide sidebar', def: 'Ctrl+B', run: () => App.toggleSide() },
    { id: 'toggleSide2', label: 'Show / hide right sidebar', def: 'Ctrl+Alt+B', run: () => App.toggleSide2() },
    { id: 'toggleChat', label: 'Show / hide chat', def: 'Ctrl+J', run: () => App.toggleChat() },
    { id: 'toggleTerm', label: 'Show / hide terminal', def: 'Ctrl+`', run: () => App.toggleTerm() },
    { id: 'showFiles', label: 'Show files', def: 'Ctrl+Shift+E', run: () => Panels.show('explorer') },
    { id: 'showSearch', label: 'Search in files', def: 'Ctrl+Shift+F', run: () => Panels.show('search') },
    { id: 'showChats', label: 'Show chats', def: 'Ctrl+Shift+H', run: () => Panels.show('sessions') },
    { id: 'browser', label: 'Open browser preview', def: 'Ctrl+Shift+B', run: () => App.openBrowser() },
    { id: 'focusMode', label: 'Focus mode (chat only)', def: 'Ctrl+Shift+M', run: () => { setSetting('chatLayout', A.settings.chatLayout === 'focus' ? 'side' : 'focus'); App.syncLayout(); } },
    { id: 'settings', label: 'Settings', def: 'Ctrl+,', run: () => openSettings() },
    { id: 'save', label: 'Save file', def: 'Ctrl+S', when: () => !(editor && editor.hasTextFocus()), run: () => saveFile() },
    { id: 'saveAll', label: 'Save all files', def: 'Ctrl+Alt+S', run: () => saveAll() },
    { id: 'closeTab', label: 'Close tab', def: 'Ctrl+W', run: () => activePath && closeFile(activePath) },
    { id: 'nextTab', label: 'Next tab', def: 'Ctrl+Tab', run: () => cycleTab(1) },
    { id: 'prevTab', label: 'Previous tab', def: 'Ctrl+Shift+Tab', run: () => cycleTab(-1) },
  ]);
  function cycleTab(d) { const ks = [...files.keys()]; if (ks.length < 2) return; const i = ks.indexOf(activePath); showFile(ks[(i + d + ks.length) % ks.length]); }
  addEventListener('keydown', (e) => {
    const c = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (c && !e.shiftKey && k === 'c') { const sel = String(getSelection() || ''); const ae = document.activeElement; if (sel && !(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.closest('.xterm') || ae.closest('.monaco-editor')))) { navigator.clipboard.writeText(sel); } }
    if (document.body.classList.contains('capturing-key')) return; // Settings is recording a new shortcut
    Keys.handle(e);
  });  addEventListener('beforeunload', () => saveAll());
  if (!window.__POP) document.addEventListener('DOMContentLoaded', boot);
})();
