// Integrated terminal UI: tabs + xterm.js, backed by node-pty in the main process (src/term.js).
//
// Requires (loaded before this file): xterm.js and the fit / web-links / search / webgl addons
// (UMD globals Terminal, FitAddon, WebLinksAddon, SearchAddon, WebglAddon), util.js, combo.js,
// and a bridge to the pty IPC channels: `api.pty` (preferred) or `window.ptyApi`.
//
// Public API: window.Terminals  (see bottom of file)
(function () {
  'use strict';

  // ------------------------------------------------------------------ bridge to main
  const bridge = () => (window.api && window.api.pty) || window.ptyApi;
  const onEvent = (ch, cb) => (window.api && window.api.on ? window.api.on(ch, cb) : window.ptyApi.on(ch, cb));

  const DEFAULT_FONT = "'JetBrains Mono Variable','Cascadia Code',Consolas,monospace";
  // Strip ANSI escape sequences (CSI, OSC, 2-char) so we can scan output for URLs.
  const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
  const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"<>`\x00-\x1f]*/g;

  const S = {
    root: null, bar: null, tabsEl: null, body: null, findBar: null,
    tabs: [], active: null, shells: [], defaultShell: null, seq: 0,
    wired: false, ro: null, fitRaf: 0, maximized: false,
    seenUrls: new Set(), urlQueue: [], urlTimer: null,
  };

  // ------------------------------------------------------------------ theme
  const cvs = document.createElement('canvas'); cvs.width = cvs.height = 1;
  const cctx = cvs.getContext('2d', { willReadFrequently: true });
  // Any CSS color -> [r,g,b]
  function rgb(c, fallback) {
    try {
      cctx.clearRect(0, 0, 1, 1); cctx.fillStyle = '#000'; cctx.fillStyle = c || fallback; cctx.fillRect(0, 0, 1, 1);
      const d = cctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
    } catch { return [128, 128, 128]; }
  }
  const hex = (a) => '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  const ANSI_DARK = {
    black: '#2a2538', red: '#ff6b81', green: '#7ee787', yellow: '#f5d76e', blue: '#79b8ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#d6d2e4',
    brightBlack: '#6d6781', brightRed: '#ff8fa0', brightGreen: '#a6f3a8', brightYellow: '#ffe69a', brightBlue: '#a5d0ff', brightMagenta: '#e6c9ff', brightCyan: '#8be9f0', brightWhite: '#ffffff',
  };
  const ANSI_LIGHT = {
    black: '#24202e', red: '#c4274a', green: '#1a7f37', yellow: '#946800', blue: '#0b62c4', magenta: '#8250df', cyan: '#0e7490', white: '#8a8599',
    brightBlack: '#5c566b', brightRed: '#e0395d', brightGreen: '#238636', brightYellow: '#a87a00', brightBlue: '#1f7ae0', brightMagenta: '#9a6bf0', brightCyan: '#1491b0', brightWhite: '#3a3548',
  };

  // ready-made terminal color schemes (Settings → Terminal); "match" follows the app theme
  const P = (bg, fg, a, b, sel) => ({ background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selectionBackground: sel || fg + '33', selectionInactiveBackground: fg + '1f', black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7], brightBlack: b[0], brightRed: b[1], brightGreen: b[2], brightYellow: b[3], brightBlue: b[4], brightMagenta: b[5], brightCyan: b[6], brightWhite: b[7] });
  const TERM_THEMES = {
    dracula: ['Dracula', P('#282a36', '#f8f8f2', ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'], ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'], '#44475a'), true],
    'one-dark': ['One Dark', P('#282c34', '#abb2bf', ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'], ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'], '#3e4451'), true],
    'tokyo-night': ['Tokyo Night', P('#1a1b26', '#c0caf5', ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'], ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'], '#33467c'), true],
    nord: ['Nord', P('#2e3440', '#d8dee9', ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'], ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'], '#434c5e'), true],
    gruvbox: ['Gruvbox Dark', P('#282828', '#ebdbb2', ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'], ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'], '#504945'), true],
    'solarized-dark': ['Solarized Dark', P('#002b36', '#839496', ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'], ['#586e75', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'], '#073642'), true],
    catppuccin: ['Catppuccin Mocha', P('#1e1e2e', '#cdd6f4', ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'], ['#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'], '#45475a'), true],
    campbell: ['Windows Terminal (Campbell)', P('#0c0c0c', '#cccccc', ['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc'], ['#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2'], '#ffffff40'), true],
    'github-light': ['GitHub Light', P('#ffffff', '#24292f', ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781'], ['#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'], '#b6d6ff'), false],
  };
  function buildTheme() {
    const pre = TERM_THEMES[(window.A && A.settings && A.settings.termTheme) || ''];
    if (pre) return Object.assign({}, pre[1], { _dark: pre[2] });
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    const bg = v('--bg1', '#15111d'), fg = v('--fg', '#e8e4f1'), accent = v('--accent', '#a78bfa');
    const bgRGB = rgb(bg, '#15111d'), acRGB = rgb(accent, '#a78bfa');
    const dark = lum(bgRGB) < 0.5;
    return Object.assign({}, dark ? ANSI_DARK : ANSI_LIGHT, {
      background: hex(bgRGB), foreground: hex(rgb(fg, '#e8e4f1')),
      cursor: hex(acRGB), cursorAccent: hex(bgRGB),
      selectionBackground: hex(acRGB) + (dark ? '55' : '44'),
      selectionInactiveBackground: hex(mix(bgRGB, acRGB, 0.25)),
      _dark: dark,
    });
  }

  function applyTheme() {
    const t = buildTheme();
    S.theme = t;
    for (const tab of S.tabs) { tab.term.options.theme = t; tab.term.options.minimumContrastRatio = t._dark ? 1 : 4.5; }
    if (S.root) S.root.style.setProperty('--term-bg', t.background);
  }

  // ------------------------------------------------------------------ font
  function fontOpts() {
    const s = (window.A && A.settings) || {};
    return {
      fontFamily: s.termFont || DEFAULT_FONT,
      fontSize: +s.termSize || 13,
      lineHeight: +s.termLineHeight || 1.2,
      cursorStyle: ['block', 'bar', 'underline'].includes(s.termCursor) ? s.termCursor : 'block',
    };
  }
  function applyFont() {
    const o = fontOpts();
    for (const tab of S.tabs) Object.assign(tab.term.options, o);
    fit();
  }

  // ------------------------------------------------------------------ helpers
  const home = () => (window.A && A.ws) || window.__home || undefined;
  const shellById = (id) => S.shells.find((x) => x.id === id);
  const tabById = (id) => S.tabs.find((t) => t.id === id);
  const shellIcon = () => icon('term');

  async function loadShells() {
    try { S.shells = (await bridge().shells()) || []; } catch { S.shells = []; }
    const pref = window.A && A.settings && A.settings.termShell;
    S.defaultShell = shellById(pref) ? pref : (S.shells[0] && S.shells[0].id) || 'powershell';
    return S.shells;
  }

  function copySel(tab) {
    const t = tab.term.getSelection();
    if (t) navigator.clipboard.writeText(t).catch(() => { });
    return !!t;
  }
  async function pasteInto(tab) {
    try { const t = await navigator.clipboard.readText(); if (t) tab.term.paste(t); } catch { /* clipboard denied */ }
  }

  // ------------------------------------------------------------------ local URL detection
  function scanUrls(tab, chunk) {
    const text = (tab.tail + chunk.replace(ANSI_RE, '')).slice(-4000);
    let m; LOCAL_URL_RE.lastIndex = 0;
    // Only look at urls that END before the last 80 chars unless followed by whitespace, so a url split
    // across two chunks is not reported truncated.
    while ((m = LOCAL_URL_RE.exec(text))) {
      const end = m.index + m[0].length;
      if (end >= text.length) continue; // may be incomplete, wait for more output
      let u = m[0].replace(/[.,;:)\]}'"]+$/, '').replace('//0.0.0.0', '//localhost');
      if (/^https?:\/\/\[::1\]/.test(u)) u = u.replace('[::1]', 'localhost');
      if (S.seenUrls.has(u)) continue;
      S.seenUrls.add(u); S.urlQueue.push(u);
    }
    tab.tail = text.slice(-200);
    if (S.urlQueue.length && !S.urlTimer) {
      S.urlTimer = setTimeout(() => {
        S.urlTimer = null; const q = S.urlQueue.splice(0);
        if (Terminals.onLocalUrl) for (const u of q) { try { Terminals.onLocalUrl(u); } catch (e) { console.error(e); } }
      }, 300);
    }
  }

  function openLink(url) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url) && window.Browser && window.Browser.open) {
      window.Browser.open(url.replace('//0.0.0.0', '//localhost'));
    } else api.fs.openExternal(url);
  }

  // ------------------------------------------------------------------ tab lifecycle
  function makeTab(opts) {
    const shellId = opts.shell || S.defaultShell;
    const sh = shellById(shellId) || { id: shellId, label: shellId };
    const id = 'pty' + Date.now().toString(36) + (++S.seq);
    const el = h('div', { class: 'tt-term' });
    const find = fontOpts();
    const term = new Terminal(Object.assign({
      scrollback: 10000, allowProposedApi: true, cursorBlink: true, convertEol: false,
      theme: S.theme || buildTheme(), macOptionIsMeta: false, rightClickSelectsWord: false,
      windowsMode: false, fastScrollModifier: 'alt', smoothScrollDuration: 0,
      // light themes: keep pale truecolor text from user profiles (PSReadLine, oh-my-posh) readable
      minimumContrastRatio: (S.theme && !S.theme._dark) ? 4.5 : 1,
    }, find));
    const fitA = new FitAddon.FitAddon();
    const search = new SearchAddon.SearchAddon();
    term.loadAddon(fitA); term.loadAddon(search);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => openLink(uri)));

    const tab = {
      id, el, term, fitA, search, shellId, label: sh.label, title: '', cwd: opts.cwd || home(), exited: false,
      started: false, tail: '', startCmd: opts.command || null, gotData: false, webgl: null,
    };
    tab.tabEl = h('div', { class: 'tt-tab', title: sh.label, onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab); } }, onclick: () => activate(tab) },
      h('span', { class: 'pv', html: shellIcon() }), h('span', { class: 't' }, sh.label),
      h('span', { class: 'x', title: 'Close terminal', html: icon('x'), onclick: (e) => { e.stopPropagation(); closeTab(tab); } }));

    S.tabs.push(tab);
    S.tabsEl.append(tab.tabEl); S.body.append(el);
    term.open(el);
    tab.ta = term.textarea;
    // GPU renderer when possible (cap contexts: browsers allow ~16 WebGL contexts per page)
    // off by default: on some GPUs/drivers WebGL in a terminal triggers Chromium "UnknownVizError" GPU-process crashes (Settings → Terminal)
    if (window.WebglAddon && A.settings.termGpu === true && S.tabs.length <= 8) {
      try {
        const gl = new WebglAddon.WebglAddon();
        gl.onContextLoss(() => { try { gl.dispose(); } catch { } tab.webgl = null; });
        term.loadAddon(gl); tab.webgl = gl;
      } catch { tab.webgl = null; }
    }

    // ---- input
    term.onData((d) => {
      if (tab.exited) {
        // restart on a real keypress (ignore terminal-generated reports like focus events)
        if (d.startsWith('\x1b[') && d !== '\x1b[A') return;
        restart(tab); return;
      }
      bridge().write({ id, data: d });
    });
    term.onResize(({ cols, rows }) => { if (tab.started && !tab.exited) bridge().resize({ id, cols, rows }); });
    term.onTitleChange((t) => setTitle(tab, t));
    term.onSelectionChange(() => {
      if (term.hasSelection()) { clearTimeout(tab.selT); tab.selT = setTimeout(() => copySel(tab), 150); } // copy on select
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.altKey) {
        if (k === 'c' && (e.shiftKey || term.hasSelection())) { copySel(tab); e.preventDefault(); return false; }
        if (k === 'v') { e.preventDefault(); pasteInto(tab); return false; }
        if (k === 'f' && !e.shiftKey) { e.preventDefault(); showFind(true); return false; }
        if (k === 'insert') { copySel(tab); return false; }
      }
      if (e.shiftKey && !e.ctrlKey && k === 'insert') { e.preventDefault(); pasteInto(tab); return false; }
      if (e.key === 'Escape' && S.findBar && S.findBar.classList.contains('open')) { showFind(false); return false; }
      return true;
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (term.hasSelection()) { copySel(tab); term.clearSelection(); } else pasteInto(tab);
    });

    return tab;
  }

  function setTitle(tab, t) {
    t = (t || '').trim();
    // PowerShell/cmd report their exe path as title until the prompt customises it: show the shell name instead
    const isExe = !t || /\.exe\b/i.test(t) && /[\\/]/.test(t);
    tab.title = isExe ? '' : t;
    const name = tab.title || tab.label;
    const te = tab.tabEl.querySelector('.t'); te.textContent = name; tab.tabEl.title = name;
  }

  async function spawn(tab) {
    // Make sure geometry is current before the shell starts so the banner wraps correctly.
    fitTab(tab);
    const cols = tab.term.cols, rows = tab.term.rows;
    tab.exited = false; tab.started = false;
    const r = await bridge().create({ id: tab.id, cwd: tab.cwd, shell: tab.shellId, cols, rows });
    if (!r || !r.ok) {
      tab.exited = true;
      tab.term.write(`\r\n\x1b[31m${(r && r.error) || 'Failed to start shell'}\x1b[0m\r\n\x1b[2m[press any key to retry]\x1b[0m\r\n`);
      return;
    }
    tab.started = true;
    if (r.label) tab.label = r.label;
    // the size may have changed while we were awaiting
    if (tab.term.cols !== cols || tab.term.rows !== rows) bridge().resize({ id: tab.id, cols: tab.term.cols, rows: tab.term.rows });
    if (tab.startCmd) {
      const c = tab.startCmd; tab.startCmd = null;
      tab.pendingCmd = c; // sent once the shell has produced its first output + settled
      armPending(tab);
    }
  }

  // Send a startup command after the shell has printed its prompt (output quiet for 250ms).
  function armPending(tab) {
    clearTimeout(tab.pendT);
    tab.pendT = setTimeout(() => {
      if (!tab.pendingCmd) return;
      if (!tab.gotData) return armPending(tab);
      const c = tab.pendingCmd; tab.pendingCmd = null;
      bridge().write({ id: tab.id, data: c + '\r' });
    }, 350);
  }

  function restart(tab) {
    tab.term.reset(); tab.gotData = false;
    spawn(tab);
  }

  function activate(tab) {
    S.active = tab;
    for (const t of S.tabs) {
      const on = t === tab;
      t.el.classList.toggle('on', on); t.tabEl.classList.toggle('on', on);
    }
    if (tab.tabEl.scrollIntoView) tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    showFind(false);
    requestAnimationFrame(() => { fitTab(tab); tab.term.focus(); });
  }

  function closeTab(tab) {
    const i = S.tabs.indexOf(tab); if (i < 0) return;
    bridge().kill(tab.id);
    clearTimeout(tab.pendT); clearTimeout(tab.selT);
    try { tab.term.dispose(); } catch { }
    tab.el.remove(); tab.tabEl.remove();
    S.tabs.splice(i, 1);
    if (S.active === tab) {
      S.active = null;
      const next = S.tabs[Math.min(i, S.tabs.length - 1)];
      if (next) activate(next);
      else if (window.App && App.toggleTerm) App.toggleTerm(false); // last tab closed -> close the panel
    }
  }

  async function newTab(opts) {
    opts = opts || {};
    if (!S.root) return null;
    if (!S.shells.length) await loadShells();
    const tab = makeTab({ shell: opts.shell, cwd: opts.cwd || home(), command: opts.command });
    activate(tab);
    await spawn(tab);
    return tab.id;
  }

  // ------------------------------------------------------------------ fit / resize
  function fitTab(tab) {
    if (!tab || !tab.el.offsetWidth || !tab.el.offsetHeight) return;
    try {
      const d = tab.fitA.proposeDimensions();
      if (!d || !isFinite(d.cols) || !isFinite(d.rows) || d.cols < 2 || d.rows < 1) return;
      if (d.cols !== tab.term.cols || d.rows !== tab.term.rows) tab.term.resize(d.cols, d.rows); // -> onResize -> pty:resize
    } catch { /* hidden / disposed */ }
  }
  function fit() {
    cancelAnimationFrame(S.fitRaf);
    S.fitRaf = requestAnimationFrame(() => fitTab(S.active));
  }

  // ------------------------------------------------------------------ find bar
  function showFind(on) {
    const fb = S.findBar; if (!fb) return;
    fb.classList.toggle('open', !!on);
    const inp = fb.querySelector('input');
    if (on) { inp.focus(); inp.select(); }
    else if (S.active) { S.active.search.clearDecorations(); S.active.term.focus(); }
  }
  function doFind(dir) {
    const tab = S.active; if (!tab) return;
    const q = S.findBar.querySelector('input').value;
    if (!q) { tab.search.clearDecorations(); return; }
    const opt = { decorations: { matchBackground: '#ffffff30', activeMatchBackground: '#ffcc0080', matchOverviewRuler: '#ffffff40', activeMatchColorOverviewRuler: '#ffcc00' }, caseSensitive: false };
    if (dir < 0) tab.search.findPrevious(q, opt); else tab.search.findNext(q, opt);
  }

  // ------------------------------------------------------------------ build UI
  function build(rootEl) {
    if (!window.Terminal) { rootEl.textContent = 'xterm.js is not loaded'; return; }
    S.root = rootEl; rootEl.classList.add('tt-root');
    rootEl.innerHTML = '';

    const addBtn = h('button', { class: 'icon-btn sm tt-add', title: 'New terminal', html: icon('plus'), onclick: () => newTab() });
    const ddBtn = h('button', { class: 'icon-btn sm tt-dd', title: 'Choose shell', html: icon('chevDown'), onclick: () => pickShell(ddBtn) });
    S.tabsEl = h('div', { class: 'tt-tabs' });
    S.maxBtn = h('button', { class: 'icon-btn sm', title: 'Maximize panel', html: icon('panelBottom'), onclick: () => toggleMax() });
    S.bar = h('div', { class: 'tt-bar' },
      S.tabsEl,
      h('div', { class: 'tt-add-grp' }, addBtn, ddBtn),
      h('div', { class: 'tt-sp' }),
      h('button', { class: 'icon-btn sm', title: 'Clear', html: icon('trash'), onclick: () => { if (S.active) { S.active.term.clear(); S.active.term.focus(); } } }),
      S.maxBtn,
      h('button', { class: 'icon-btn sm', title: 'Close panel', html: icon('x'), onclick: () => { if (window.App && App.toggleTerm) App.toggleTerm(false); } }));

    S.body = h('div', { class: 'tt-body' });
    const inp = h('input', { class: 'tt-find-in', placeholder: 'Find', spellcheck: 'false' });
    inp.addEventListener('input', () => doFind(1));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doFind(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showFind(false); }
    });
    S.findBar = h('div', { class: 'tt-find' }, inp,
      h('button', { class: 'icon-btn sm', title: 'Previous (Shift+Enter)', html: icon('chev'), style: { transform: 'rotate(-90deg)' }, onclick: () => doFind(-1) }),
      h('button', { class: 'icon-btn sm', title: 'Next (Enter)', html: icon('chevDown'), onclick: () => doFind(1) }),
      h('button', { class: 'icon-btn sm', title: 'Close', html: icon('x'), onclick: () => showFind(false) }));
    S.body.append(S.findBar);
    rootEl.append(S.bar, S.body);

    applyTheme();
    // refit whenever the panel changes size (drag handle, window resize, panel toggle)
    if (S.ro) S.ro.disconnect();
    S.ro = new ResizeObserver(() => fit());
    S.ro.observe(S.body);
    if (!S.wired) {
      S.wired = true;
      window.addEventListener('resize', fit);
      onEvent('pty:data', ({ id, data }) => {
        const t = tabById(id); if (!t) return;
        t.gotData = true; t.term.write(data); scanUrls(t, data);
        if (t.pendingCmd) armPending(t);
      });
      onEvent('pty:exit', ({ id, code }) => {
        const t = tabById(id); if (!t) return;
        t.exited = true; t.started = false;
        t.term.write(`\r\n\x1b[2m[process exited with code ${code}] â€” press any key to restart\x1b[0m\r\n`);
      });
      // webfonts load async: remeasure once the terminal font is really available
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { for (const t of S.tabs) t.term.options.fontFamily = fontOpts().fontFamily; fit(); });
      // follow live theme changes (the app swaps CSS variables on <html>)
      new MutationObserver(() => applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    }
    // sessions left over from a previous renderer instance (reload) are orphans: drop them
    try { Promise.resolve(bridge().list && bridge().list()).then((l) => (l || []).forEach((s) => bridge().kill(s.id))); } catch { }
    loadShells();
  }

  async function pickShell(anchor) {
    if (!S.shells.length) await loadShells();
    window.Combo.open(anchor, {
      items: S.shells.map((s) => ({ value: s.id, label: s.label, sub: s.kind === 'wsl' ? 'WSL' : '', icon: shellIcon() })),
      value: S.defaultShell, align: 'right', width: 220, title: 'New terminal',
      onPick: (id) => newTab({ shell: id }),
    });
  }

  function toggleMax() {
    S.maximized = !S.maximized;
    S.root.classList.toggle('tt-max', S.maximized);
    S.maxBtn.classList.toggle('on', S.maximized);
    if (Terminals.onMaximize) Terminals.onMaximize(S.maximized);
    setTimeout(fit, 30);
  }

  // ------------------------------------------------------------------ public API
  const Terminals = {
    build,
    /** ensure at least one tab exists and focus it. opts: {cwd, shell} (only used if a tab must be created) */
    async open(opts) {
      if (!S.root) return;
      if (!S.tabs.length) await newTab(opts);
      else if (opts && (opts.shell || opts.cwd) && opts.force) await newTab(opts);
      else activate(S.active || S.tabs[0]);
    },
    newTab,
    /** write text + Enter to the active tab (creating one if needed) */
    async runCommand(text) {
      if (!S.tabs.length) await newTab({ command: text });
      else {
        const t = S.active || S.tabs[0];
        if (t.exited) { restart(t); t.startCmd = text; t.pendingCmd = text; armPending(t); return; }
        bridge().write({ id: t.id, data: text + '\r' }); t.term.focus();
      }
    },
    focus() { const t = S.active; if (t) t.term.focus(); },
    fit,
    /** kill every tab (workspace changed) */
    reset() {
      for (const t of [...S.tabs]) {
        bridge().kill(t.id); clearTimeout(t.pendT); clearTimeout(t.selT);
        try { t.term.dispose(); } catch { } t.el.remove(); t.tabEl.remove();
      }
      S.tabs = []; S.active = null; S.seenUrls.clear(); S.urlQueue = [];
      if (S.findBar) S.findBar.classList.remove('open');
    },
    applyTheme, applyFont,
    shells: () => S.shells.slice(),
    count: () => S.tabs.length,
    themeList: () => Object.entries(TERM_THEMES).map(([id, v]) => [id, v[0]]),
    /** last N lines of a tab's screen + scrollback as plain text (tab = index, default active) */
    read(lines = 200, tab) {
      const t = tab != null ? S.tabs[tab] : S.active; if (!t) return '';
      const b = t.term.buffer.active; const end = b.length; const from = Math.max(0, end - Math.max(1, lines)); const out = [];
      for (let i = from; i < end; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); }
      while (out.length && !out[out.length - 1].trim()) out.pop(); return out.join('\n');
    },
    /** the active xterm Terminal instance (debug / integrations) */
    activeTerm: () => (S.active ? S.active.term : null),
    /** cwd of the active tab as last reported by the shell (best effort) */
    async cwd() { const t = S.active; return t ? bridge().cwd(t.id) : null; },
    /** assign: (url) => void â€” called once per local dev-server url seen in output */
    onLocalUrl: null,
    /** assign: (maximized:boolean) => void */
    onMaximize: null,
  };
  window.Terminals = Terminals;
})();


