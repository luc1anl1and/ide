// Built-in browser preview pane.   window.BrowserPane.create({ url, onTitle, onUrl, liveReload }) -> controller
//
// Uses an Electron <webview> (partition "persist:preview"). Optional main-process helpers live in src/ports.js
// and are reached through window.api.ports.{scan, dockDevTools, closeDevTools, capture, trust}; every one of them
// is optional and the pane degrades gracefully when missing.
(function () {
  'use strict';

  // ---------- small helpers ----------
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };
  const svg = (d, cls) => `<svg class="${cls || 'bp-ic'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const IC = {
    back: svg('<path d="M15 6l-6 6 6 6"/>'),
    fwd: svg('<path d="M9 6l6 6-6 6"/>'),
    reload: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    stop: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
    server: svg('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
    device: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    rotate: svg('<rect x="7" y="3" width="10" height="18" rx="2" transform="rotate(90 12 12)"/><path d="M12 12h.01"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    live: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
    shot: svg('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>'),
    dev: svg('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>'),
    ext: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    warn: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17h.01"/>'),
    dockB: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 14.5h18"/>'),
    dockR: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14.5 4v16"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  };

  const DEVICES = [
    { id: 'responsive', label: 'Responsive' },
    { id: 'desktop', label: 'Desktop', w: 1440, h: 900 },
    { id: 'iphone', label: 'iPhone 15', w: 393, h: 852 },
    { id: 'ipad', label: 'iPad', w: 820, h: 1180 },
    { id: 'pixel', label: 'Pixel', w: 412, h: 915 },
    { id: 'custom', label: 'Custom', w: 800, h: 600 },
  ];
  const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  const MAX_CONSOLE = 200;

  const isLocalHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|[\w-]+\.localhost)$/i.test(h || '');
  const parse = (u) => { try { return new URL(u); } catch { return null; } };
  const hostPort = (u) => { const p = parse(u); return p ? p.host : ''; };

  // Smart URL input: "3000", ":3000", "localhost:5173/x", "example.com", "file:///x", "C:\\x.html"
  function normalizeUrl(input) {
    let s = String(input || '').trim();
    if (!s) return '';
    if (/^(about:|file:|data:|view-source:|blob:)/i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    if (/^[a-z]:[\\/]/i.test(s)) return 'file:///' + s.replace(/\\/g, '/');
    if (/^:\d{1,5}(\/|\?|#|$)/.test(s)) return 'http://localhost' + s;
    if (/^\d{2,5}(\/|\?|#|$)/.test(s)) return 'http://localhost:' + s;
    if (/^0\.0\.0\.0(:\d+)?/.test(s)) return 'http://' + s.replace('0.0.0.0', 'localhost');
    if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|[\w-]+\.localhost)(:\d+)?([/?#]|$)/i.test(s)) return 'http://' + s;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(s)) return 'http://' + s;
    if (!/\s/.test(s) && /^[^/?#]+\.[a-z]{2,}([:/?#]|$)/i.test(s)) return 'https://' + s;
    return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  }

  const notify = (msg, err) => { try { if (window.toast && document.getElementById('toasts')) return window.toast(msg, err); } catch {} };
  const api = () => window.api || {};
  const ports = () => (api().ports && typeof api().ports.scan === 'function' ? api().ports : null);

  // ---------- popover menu (self-contained) ----------
  function menu(anchor, items, { width = 240, align = 'left' } = {}) {
    const scrim = el('div', { class: 'bp-scrim' });
    const pop = el('div', { class: 'bp-menu', style: { minWidth: width + 'px' } });
    const close = () => { scrim.remove(); pop.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const fill = (list) => {
      pop.innerHTML = '';
      for (const it of list) {
        if (it.sep) { pop.append(el('div', { class: 'bp-msep' })); continue; }
        if (it.head) { pop.append(el('div', { class: 'bp-mhead' }, it.head)); continue; }
        if (it.empty) { pop.append(el('div', { class: 'bp-mempty' }, it.empty)); continue; }
        pop.append(el('button', { class: 'bp-mi' + (it.sel ? ' sel' : ''), onclick: () => { if (!it.keep) close(); it.run && it.run(); } },
          el('span', { class: 'bp-mi-t' }, el('span', { class: 'bp-mi-l' }, it.label), it.sub ? el('span', { class: 'bp-mi-s' }, it.sub) : null),
          it.sel ? el('span', { class: 'bp-mi-c', html: IC.check }) : null));
      }
    };
    fill(items);
    scrim.addEventListener('mousedown', close);
    document.body.append(scrim, pop);
    document.addEventListener('keydown', onKey, true);
    const r = anchor.getBoundingClientRect();
    pop.style.top = Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8) + 'px';
    const left = align === 'right' ? r.right - pop.offsetWidth : r.left;
    pop.style.left = Math.max(8, Math.min(left, innerWidth - pop.offsetWidth - 8)) + 'px';
    return { close, update: (list) => fill(list) };
  }

  // ---------- global plumbing: main -> renderer shortcut forwarding ----------
  const byGuestId = new Map();        // guest webContents id -> pane
  let keyHooked = false;
  function hookKeys() {
    if (keyHooked || typeof api().on !== 'function') return;
    keyHooked = true;
    api().on('ports:key', ({ id, cmd } = {}) => { const p = byGuestId.get(id); if (p) p._cmd(cmd); });
  }
  // workspace file changes -> live reload for every pane that has it enabled
  const panes = new Set();
  let fsHooked = false;
  function hookFs() {
    if (fsHooked || typeof api().on !== 'function') return;
    fsHooked = true;
    api().on('fs:changed', (list) => {
      const files = Array.isArray(list) ? list.map((x) => String((x && x.path) || x)) : [];
      if (files.length && files.every((f) => /[\\/](node_modules|\.git)[\\/]/.test(f))) return;
      for (const p of panes) p._fsChanged();
    });
  }

  // =====================================================================================
  function create(opts = {}) {
    hookKeys(); hookFs();
    const listeners = {};
    const state = {
      url: '', title: '', favicon: '', loading: false, ready: false, attached: false, guestId: 0,
      zoom: 1, device: 'responsive', dw: 393, dh: 852, live: !!opts.liveReload,
      errors: 0, err: null, devOpen: false, devDock: 'bottom', devDocked: false, destroyed: false,
      history: false, target: '',
    };
    const consoleLog = [];

    const emit = (ev, ...a) => { for (const f of (listeners[ev] || []).slice()) { try { f(...a); } catch (e) { console.error(e); } } };
    const on = (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); return () => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); }; };
    if (opts.onTitle) on('title', opts.onTitle);
    if (opts.onUrl) on('url', opts.onUrl);

    // ---------- DOM ----------
    const btn = (icoHtml, title, onclick, cls) => el('button', { class: 'icon-btn sm bp-btn ' + (cls || ''), title, html: icoHtml, onclick });
    const bBack = btn(IC.back, 'Back (Alt+Left)', () => api_.back());
    const bFwd = btn(IC.fwd, 'Forward (Alt+Right)', () => api_.forward());
    const bReload = btn(IC.reload, 'Reload (F5) - Shift for hard reload', (e) => (state.loading ? api_.stop() : api_.reload(e.shiftKey)));

    const lockEl = el('span', { class: 'bp-lock', html: IC.globe });
    const spinEl = el('span', { class: 'spin bp-spin hidden' });
    const input = el('input', {
      class: 'bp-url', spellcheck: 'false', autocomplete: 'off', placeholder: 'Search or enter address (try 3000 or localhost:5173)',
      onfocus: () => setTimeout(() => input.select(), 0),
      oninput: () => { input.dataset.dirty = '1'; }, onblur: () => { delete input.dataset.dirty; setTimeout(() => sync(), 0); },
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); api_.navigate(input.value); if (state.url) wv.focus(); }
        else if (e.key === 'Escape') { input.value = state.url; input.blur(); }
      },
    });
    const urlbox = el('div', { class: 'bp-urlbox' }, lockEl, spinEl, input);

    const bServers = btn(IC.server, 'Running dev servers', () => openServers(bServers));
    const bDevice = btn(IC.device, 'Device size', () => openDevices(bDevice));
    const zMinus = btn(IC.minus, 'Zoom out (Ctrl+-)', () => api_.setZoom(stepZoom(-1)));
    const zLabel = el('button', { class: 'bp-zoomlbl', title: 'Reset zoom (Ctrl+0)', onclick: () => api_.setZoom(1) }, '100%');
    const zPlus = btn(IC.plus, 'Zoom in (Ctrl+=)', () => api_.setZoom(stepZoom(1)));
    const zoomGrp = el('div', { class: 'bp-zoom' }, zMinus, zLabel, zPlus);
    const bLive = btn(IC.live, 'Live reload when workspace files change (localhost)', () => { state.live = !state.live; sync(); }, 'bp-live');
    const errCount = el('span', { class: 'bp-errn' }, '0');
    const bErr = el('button', { class: 'bp-err-btn hidden', title: 'Send console errors to chat', onclick: () => sendErrors() }, el('span', { html: IC.warn }), errCount);
    const bShot = btn(IC.shot, 'Screenshot to chat', () => takeShot(true));
    const bDev = btn(IC.dev, 'Developer tools (F12)', () => (state.devOpen ? api_.closeDevTools() : api_.openDevTools()));
    const bExt = btn(IC.ext, 'Open in system browser', () => openExternal());
    const bar = el('div', { class: 'bp-bar' }, bBack, bFwd, bReload, urlbox, bServers, bDevice, zoomGrp, bLive, bErr, bShot, bDev, bExt);

    // device row
    const iW = el('input', { class: 'bp-dim', type: 'number', min: 100, max: 4000, onchange: () => devSize() });
    const iH = el('input', { class: 'bp-dim', type: 'number', min: 100, max: 4000, onchange: () => devSize() });
    const devName = el('span', { class: 'bp-devname' });
    const devScale = el('span', { class: 'bp-devscale' });
    const bRot = btn(IC.rotate, 'Rotate', () => { [state.dw, state.dh] = [state.dh, state.dw]; if (state.device !== 'custom') state.device = 'custom'; sync(); layout(); });
    const devbar = el('div', { class: 'bp-devbar hidden' }, devName, iW, el('span', { class: 'bp-x' }, '\u00d7'), iH, bRot, devScale);

    // webview
    const wv = document.createElement('webview');
    wv.className = 'bp-wv';
    wv.setAttribute('partition', 'persist:preview');       // must be set before src
    wv.setAttribute('webpreferences', 'contextIsolation=yes');
    const frame = el('div', { class: 'bp-frame' }, wv);
    const stage = el('div', { class: 'bp-stage' }, frame);

    // overlays
    const start = el('div', { class: 'bp-start' });
    const errView = el('div', { class: 'bp-errview hidden' });
    stage.append(start, errView);

    // devtools dock
    const devHost = el('div', { class: 'bp-devhost' });
    const devHead = el('div', { class: 'bp-devhead' },
      el('span', { class: 'bp-devtitle' }, 'DevTools'),
      el('span', { class: 'bp-spacer' }),
      btn(IC.dockB, 'Dock to bottom', () => dock('bottom')),
      btn(IC.dockR, 'Dock to right', () => dock('right')),
      btn(IC.stop, 'Close DevTools', () => api_.closeDevTools()));
    const devGrip = el('div', { class: 'bp-grip', onmousedown: (e) => gripDrag(e) });
    const dev = el('div', { class: 'bp-dev hidden' }, devGrip, devHead, devHost);
    const body = el('div', { class: 'bp-body' }, stage, dev);

    const root = el('div', { class: 'bp', tabindex: '-1' }, bar, devbar, body);
    root.addEventListener('keydown', (e) => {
      const c = e.ctrlKey || e.metaKey;
      let cmd = null;
      if (e.altKey && e.key === 'ArrowLeft') cmd = 'back'; else if (e.altKey && e.key === 'ArrowRight') cmd = 'forward';
      else if (e.key === 'F12') cmd = 'devtools'; else if (e.key === 'F5') cmd = e.shiftKey || c ? 'hardReload' : 'reload';
      else if (c && e.key.toLowerCase() === 'l') cmd = 'focusUrl';
      else if (c && e.key.toLowerCase() === 'r') cmd = e.shiftKey ? 'hardReload' : 'reload';
      else if (c && (e.key === '=' || e.key === '+')) cmd = 'zoomIn'; else if (c && e.key === '-') cmd = 'zoomOut'; else if (c && e.key === '0') cmd = 'zoomReset';
      if (cmd) { e.preventDefault(); e.stopPropagation(); cmdRun(cmd); }
    });
    root.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); api_.setZoom(stepZoom(e.deltaY < 0 ? 1 : -1)); } }, { passive: false });

    // ---------- guest helpers ----------
    const wvDo = (fn, fb) => { try { return state.ready ? fn() : fb; } catch { return fb; } };
    const curUrl = () => { try { return state.ready ? wv.getURL() : ''; } catch { return ''; } };

    function cmdRun(cmd) {
      switch (cmd) {
        case 'back': api_.back(); break;
        case 'forward': api_.forward(); break;
        case 'reload': api_.reload(false); break;
        case 'hardReload': api_.reload(true); break;
        case 'devtools': state.devOpen ? api_.closeDevTools() : api_.openDevTools(); break;
        case 'focusUrl': input.focus(); break;
        case 'zoomIn': api_.setZoom(stepZoom(1)); break;
        case 'zoomOut': api_.setZoom(stepZoom(-1)); break;
        case 'zoomReset': api_.setZoom(1); break;
      }
    }

    function stepZoom(dir) {
      const cur = state.zoom;
      if (dir > 0) return ZOOMS.find((z) => z > cur + 0.001) || ZOOMS[ZOOMS.length - 1];
      return [...ZOOMS].reverse().find((z) => z < cur - 0.001) || ZOOMS[0];
    }

    // ---------- UI sync ----------
    function sync() {
      const hasPage = !!state.url;
      bBack.disabled = !wvDo(() => wv.canGoBack(), false);
      bFwd.disabled = !wvDo(() => wv.canGoForward(), false);
      bReload.innerHTML = state.loading ? IC.stop : IC.reload;
      bReload.title = state.loading ? 'Stop' : 'Reload (F5) - Shift for hard reload';
      bReload.disabled = !hasPage && !state.loading;
      spinEl.classList.toggle('hidden', !state.loading);
      lockEl.classList.toggle('hidden', state.loading);
      const p = parse(state.url);
      lockEl.innerHTML = !p ? IC.globe : p.protocol === 'https:' ? IC.lock : p.protocol === 'file:' ? IC.globe : IC.info;
      lockEl.title = !p ? '' : p.protocol === 'https:' ? 'Secure connection' : p.protocol === 'http:' ? (isLocalHost(p.hostname) ? 'Local server (http)' : 'Not secure (http)') : '';
      lockEl.classList.toggle('secure', !!p && p.protocol === 'https:');
      lockEl.classList.toggle('insecure', !!p && p.protocol === 'http:' && !isLocalHost(p.hostname));
      if (document.activeElement !== input || !input.dataset.dirty) input.value = state.url || (state.err ? state.err.url : ''); // a focused-but-untouched box still follows the page
      bExt.disabled = !/^https?:/i.test(state.url);
      bShot.disabled = !hasPage;
      bLive.classList.toggle('on', state.live);
      zLabel.textContent = Math.round(state.zoom * 100) + '%';
      bDev.classList.toggle('on', state.devOpen);
      bDev.disabled = !hasPage;
      const dv = DEVICES.find((d) => d.id === state.device);
      bDevice.classList.toggle('on', state.device !== 'responsive');
      devbar.classList.toggle('hidden', state.device === 'responsive');
      devName.textContent = dv ? dv.label : '';
      if (document.activeElement !== iW) iW.value = state.dw;
      if (document.activeElement !== iH) iH.value = state.dh;
      bErr.classList.toggle('hidden', state.errors === 0);
      errCount.textContent = state.errors;
      start.classList.toggle('hidden', hasPage || !!state.target);
      wv.classList.toggle('bp-wv-hidden', !hasPage && !state.target);
    }

    function setUrl(u) {
      if (!u || /^chrome-error:/.test(u)) return;
      if (u === 'about:blank') u = '';
      if (u === state.url) return;
      state.url = u;
      if (u) state.target = '';
      sync();
      emit('url', u);
      if (!u) showStart();
    }
    function setTitle(t) {
      t = t || '';
      if (t === state.title) return;
      state.title = t; emit('title', t || titleOf());
    }
    const titleOf = () => state.title || (state.url ? hostPort(state.url) || state.url : 'New tab');

    // ---------- layout (device frame) ----------
    function layout() {
      const dv = DEVICES.find((d) => d.id === state.device);
      if (!dv || state.device === 'responsive') {
        frame.classList.remove('device');
        Object.assign(frame.style, { width: '', height: '', left: '', top: '', transform: '' });
        devScale.textContent = '';
        return;
      }
      frame.classList.add('device');
      const sw = stage.clientWidth, sh = stage.clientHeight, pad = 16;
      if (!sw || !sh) return;
      const w = state.dw, h = state.dh;
      const sc = Math.min(1, (sw - pad * 2) / w, (sh - pad * 2) / h);
      Object.assign(frame.style, {
        width: w + 'px', height: h + 'px', transform: `scale(${sc})`,
        left: Math.max(pad, (sw - w * sc) / 2) + 'px', top: Math.max(pad, (sh - h * sc) / 2) + 'px',
      });
      devScale.textContent = sc < 0.995 ? Math.round(sc * 100) + '% fit' : '';
    }
    const ro = new ResizeObserver(() => layout());
    ro.observe(stage);

    function devSize() {
      state.dw = Math.max(100, Math.min(4000, +iW.value || state.dw));
      state.dh = Math.max(100, Math.min(4000, +iH.value || state.dh));
      state.device = 'custom'; sync(); layout();
    }

    // ---------- menus ----------
    function openDevices(anchor) {
      menu(anchor, DEVICES.map((d) => ({
        label: d.label, sub: d.w ? `${d.w} \u00d7 ${d.h}` : (d.id === 'responsive' ? 'Fill the pane' : ''), sel: state.device === d.id,
        run: () => api_.setDevice(d.id),
      })), { width: 220, align: 'right' });
    }

    async function openServers(anchor) {
      const m = menu(anchor, [{ head: 'Running dev servers' }, { empty: 'Scanning...' }], { width: 300, align: 'right' });
      const list = await scanPorts();
      const items = [{ head: 'Running dev servers' }];
      if (!list.length) items.push({ empty: ports() ? 'No local servers found' : 'Port scanning unavailable' });
      for (const s of list) items.push({ label: s.title || `localhost:${s.port}`, sub: `:${s.port}${s.process ? ' \u00b7 ' + s.process : ''}`, run: () => api_.navigate(s.url) });
      items.push({ sep: true }, { label: 'Rescan', keep: true, run: async () => { m.update([{ head: 'Running dev servers' }, { empty: 'Scanning...' }]); openServersFill(m); } });
      m.update(items);
    }
    async function openServersFill(m) {
      const list = await scanPorts();
      const items = [{ head: 'Running dev servers' }];
      if (!list.length) items.push({ empty: 'No local servers found' });
      for (const s of list) items.push({ label: s.title || `localhost:${s.port}`, sub: `:${s.port}${s.process ? ' \u00b7 ' + s.process : ''}`, run: () => api_.navigate(s.url) });
      items.push({ sep: true }, { label: 'Rescan', keep: true, run: () => { m.update([{ head: 'Running dev servers' }, { empty: 'Scanning...' }]); openServersFill(m); } });
      m.update(items);
    }
    async function scanPorts() {
      try { const p = ports(); return p ? (await p.scan()) || [] : []; } catch { return []; }
    }

    // ---------- start page ----------
    let startTimer = 0;
    async function showStart() {
      if (state.destroyed) return;
      clearInterval(startTimer);
      renderStart(null);
      refreshStart();
      startTimer = setInterval(() => {
        if (state.destroyed) return clearInterval(startTimer);
        if (start.classList.contains('hidden') || !root.isConnected || !root.offsetParent) return;
        refreshStart(true);
      }, 4000);
    }
    async function refreshStart(quiet) {
      if (!quiet) renderStart(null);
      const list = await scanPorts();
      renderStart(list);
    }
    function renderStart(list) {
      start.innerHTML = '';
      const cards = el('div', { class: 'bp-cards' });
      if (list === null) cards.append(el('div', { class: 'bp-scan' }, el('span', { class: 'spin' }), 'Looking for local servers...'));
      else if (!list.length) cards.append(el('div', { class: 'bp-none' }, ports() ? 'No local servers detected yet.' : 'Type an address above to get started.'));
      else for (const s of list) {
        cards.append(el('button', { class: 'bp-card', onclick: () => api_.navigate(s.url) },
          el('span', { class: 'bp-card-ico', html: IC.globe }),
          el('span', { class: 'bp-card-t' }, el('span', { class: 'bp-card-title' }, s.title || `localhost:${s.port}`),
            el('span', { class: 'bp-card-sub' }, `localhost:${s.port}`, s.process ? ' \u00b7 ' + s.process : ''))));
      }
      start.append(el('div', { class: 'bp-start-in' },
        el('div', { class: 'bp-start-ico', html: IC.globe }),
        el('div', { class: 'bp-start-h' }, 'Preview'),
        el('div', { class: 'bp-start-p' }, 'Run your dev server in the terminal \u2014 it shows up here'),
        cards,
        el('button', { class: 'pill bordered bp-refresh', onclick: () => refreshStart() }, el('span', { html: IC.reload }), 'Refresh')));
    }

    // ---------- error view ----------
    let retryTimer = 0;
    function failInfo(code, desc, url) {
      const p = parse(url), port = p ? (p.port || (p.protocol === 'https:' ? '443' : '80')) : '';
      if (code === -102) return { kind: 'refused', title: `Nothing is listening on :${port}`, detail: 'Start your dev server and this page will load automatically.' };
      if (code <= -200 && code >= -220) return { kind: 'cert', title: 'Certificate problem', detail: `${hostPort(url)} presented a certificate that can't be verified (${desc || code}).` };
      if (code === -105) return { kind: 'dns', title: `Can't find ${p ? p.hostname : 'host'}`, detail: 'Check the address for typos.' };
      if (code === -106) return { kind: 'net', title: 'No internet connection', detail: desc || '' };
      if (code === -7 || code === -118) return { kind: 'timeout', title: 'The page took too long to respond', detail: desc || '' };
      return { kind: 'other', title: "This page couldn't be loaded", detail: desc || `Error ${code}` };
    }
    function showErr(code, desc, url) {
      const info = failInfo(code, desc, url);
      state.err = { ...info, url };
      state.target = url;
      errView.innerHTML = '';
      const acts = [el('button', { class: 'pill bordered', onclick: () => retry() }, el('span', { html: IC.reload }), 'Retry')];
      const p = parse(url);
      if (info.kind === 'cert' && p && isLocalHost(p.hostname) && api().ports && api().ports.trust) {
        acts.push(el('button', { class: 'pill bordered', onclick: async () => { await api().ports.trust(p.hostname); retry(); } }, 'Continue anyway'));
      }
      errView.append(el('div', { class: 'bp-start-in' },
        el('div', { class: 'bp-start-ico warn', html: IC.warn }),
        el('div', { class: 'bp-start-h' }, info.title),
        el('div', { class: 'bp-start-p' }, info.detail),
        el('div', { class: 'bp-url-chip' }, url),
        el('div', { class: 'bp-acts' }, acts),
        info.kind === 'refused' ? el('div', { class: 'bp-hint' }, el('span', { class: 'spin' }), 'Retrying every 2 s') : null));
      errView.classList.remove('hidden');
      start.classList.add('hidden');
      setLoading(false);
      input.value = url; state.url = ''; emit('url', url);
      clearInterval(retryTimer);
      if (info.kind === 'refused') {
        retryTimer = setInterval(() => {
          if (state.destroyed || !state.err) return clearInterval(retryTimer);
          if (!root.isConnected || !root.offsetParent) return;   // only while visible
          retry();
        }, 2000);
      }
      sync();
    }
    function hideErr() {
      if (!state.err) return;
      state.err = null; clearInterval(retryTimer);
      errView.classList.add('hidden');
    }
    function retry() {
      const u = state.err ? state.err.url : state.target || state.url;
      if (u) loadUrl(u, true);
    }

    // ---------- loading ----------
    function loadUrl(u, keepErr) {
      state.target = u;
      if (!keepErr) hideErr();
      start.classList.add('hidden');
      if (state.ready) { const r = wv.loadURL(u); if (r && r.catch) r.catch(() => {}); }
      else wv.setAttribute('src', u);
      sync();
    }
    function setLoading(v) {
      if (state.loading === v) return;
      state.loading = v; sync(); emit('loading', v);
    }

    // ---------- console ----------
    const LEVELS = ['verbose', 'info', 'warning', 'error'];
    function onConsole(e) {
      let level = e.level;
      if (typeof level === 'number') level = LEVELS[level] || 'info';
      else if (level === 'debug') level = 'verbose';
      else if (level === 'warn') level = 'warning';
      const entry = {
        level: level || 'info', message: String(e.message == null ? '' : e.message),
        source: e.sourceId || e.source || '', line: e.line != null ? e.line : (e.lineNumber || 0), time: Date.now(),
      };
      consoleLog.push(entry);
      if (consoleLog.length > MAX_CONSOLE) consoleLog.splice(0, consoleLog.length - MAX_CONSOLE);
      if (entry.level === 'error') { state.errors++; sync(); }
      emit('console', entry);
    }
    function errorsText() {
      const errs = consoleLog.filter((c) => c.level === 'error').slice(-10);
      if (!errs.length) return '';
      return `Browser console errors from ${state.url || 'the preview'}:
` + errs.map((c) => {
        const src = c.source ? ` (${String(c.source).replace(/^https?:\/\/[^/]+/, '')}${c.line ? ':' + c.line : ''})` : '';
        return `- ${c.message.split('\n')[0].slice(0, 400)}${src}`;
      }).join('\n');
    }
    function sendErrors() {
      const text = errorsText();
      if (!text) return;
      if (typeof window.sendToChat === 'function') window.sendToChat(text);
      else { try { navigator.clipboard.writeText(text); notify('Console errors copied'); } catch {} }
    }

    // ---------- screenshot ----------
    async function screenshot() {
      if (!state.ready) throw new Error('Page not ready');
      const name = `preview-${(hostPort(state.url) || 'page').replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
      let data = '';
      const p = api().ports;
      if (p && p.capture && state.guestId) { const r = await p.capture(state.guestId).catch(() => null); if (r && r.data) data = r.data; }
      if (!data) {
        const img = await wv.capturePage();
        if (img && typeof img.toPNG === 'function') { const b = img.toPNG(); data = btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')); }
        else if (img && typeof img.toDataURL === 'function') data = img.toDataURL().split(',')[1];
        else throw new Error('Screenshot failed');
      }
      return { mediaType: 'image/png', data, name };
    }
    async function takeShot(toChat) {
      try {
        const img = await screenshot();
        if (typeof window.attachToChat === 'function') { window.attachToChat(img); notify('Screenshot attached to chat'); return img; }
        try {
          const blob = await (await fetch('data:image/png;base64,' + img.data)).blob();
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          notify('Screenshot copied to clipboard');
        } catch { notify('Screenshot captured'); }
        return img;
      } catch (e) { notify('Screenshot failed: ' + (e && e.message || e), true); }
    }

    // target=_blank / window.open: localhost opens in this same view, anything else in the system browser
    function openPopup(u) {
      const p = parse(u);
      if (!p || !/^https?:$/.test(p.protocol)) return;
      if (isLocalHost(p.hostname)) loadUrl(u);
      else if (api().fs && api().fs.openExternal) api().fs.openExternal(u);
    }

    function openExternal() {
      if (/^https?:/i.test(state.url) && api().fs && api().fs.openExternal) api().fs.openExternal(state.url);
    }

    // ---------- devtools ----------
    function dock(side) {
      state.devDock = side;
      dev.classList.toggle('right', side === 'right');
      body.classList.toggle('dev-right', side === 'right');
      dev.style.width = dev.style.height = '';
      layout();
    }
    function gripDrag(e) {
      e.preventDefault();
      const right = state.devDock === 'right', r = body.getBoundingClientRect();
      const move = (ev) => {
        if (right) dev.style.width = Math.max(240, Math.min(r.width - 200, r.right - ev.clientX)) + 'px';
        else dev.style.height = Math.max(120, Math.min(r.height - 120, r.bottom - ev.clientY)) + 'px';
        layout();
      };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); root.classList.remove('dragging'); };
      root.classList.add('dragging');
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    }
    let devWv = null;
    async function openDev() {
      if (!state.ready || state.devOpen) return;
      const p = api().ports;
      if (p && p.dockDevTools && state.guestId) {
        // fresh, never-navigated guest used as the devtools front-end
        devHost.innerHTML = '';
        devWv = document.createElement('webview');
        devWv.className = 'bp-wv';
        devWv.setAttribute('partition', 'persist:preview-devtools');
        devWv.setAttribute('src', 'about:blank');       // a guest only attaches once it has a src
        devHost.append(devWv);
        dev.classList.remove('hidden');
        state.devOpen = true; sync(); layout();
        const hostId = await new Promise((res) => {
          const t = setTimeout(() => res(0), 4000);
          devWv.addEventListener('dom-ready', () => { clearTimeout(t); try { res(devWv.getWebContentsId()); } catch { res(0); } }, { once: true });
        });
        const ok = hostId ? await p.dockDevTools(state.guestId, hostId).catch(() => false) : false;
        if (ok) { state.devDocked = true; return; }
        closeDev(true);
      }
      // fallback: detached devtools window
      try { wv.openDevTools(); state.devOpen = true; state.devDocked = false; sync(); } catch {}
    }
    function closeDev(skipMain) {
      if (state.devDocked && !skipMain) { const p = api().ports; if (p && p.closeDevTools) p.closeDevTools(state.guestId); }
      else if (state.devOpen && !state.devDocked) { try { wv.closeDevTools(); } catch {} }
      state.devOpen = false; state.devDocked = false;
      dev.classList.add('hidden');
      if (devWv) { devWv.remove(); devWv = null; }
      devHost.innerHTML = '';
      sync(); layout();
    }

    // ---------- webview events ----------
    wv.addEventListener('did-attach', () => {
      state.attached = true;
      try { state.guestId = wv.getWebContentsId(); byGuestId.set(state.guestId, ctl); } catch {}
    });
    wv.addEventListener('dom-ready', () => {
      state.ready = true;
      if (!state.guestId) { try { state.guestId = wv.getWebContentsId(); byGuestId.set(state.guestId, ctl); } catch {} }
      try { wv.setZoomFactor(state.zoom); } catch {}
      // Page-side shim (the guest cannot reach us otherwise): ctrl+wheel zoom, target=_blank / window.open routing.
      // Signals travel through console.debug with a \u0001 prefix and are filtered out of the console log.
      try {
        wv.executeJavaScript(`(function(){
          addEventListener('wheel',function(e){if(e.ctrlKey){e.preventDefault();console.debug('\\u0001bp-zoom:'+(e.deltaY<0?1:-1))}},{passive:false});
          addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[target]');
            if(a&&a.href&&a.target&&a.target!=='_self'&&!e.defaultPrevented){e.preventDefault();console.debug('\\u0001bp-open:'+a.href)}},true);
          window.open=function(u){if(u)console.debug('\\u0001bp-open:'+new URL(u,location.href).href);return null};
        })()`).catch(() => {});
      } catch {}
      const u = curUrl();
      if (u && !state.err && !/^chrome-error:/.test(u)) setUrl(u);
      sync();
    });
    wv.addEventListener('did-start-loading', () => setLoading(true));
    wv.addEventListener('did-stop-loading', () => { setLoading(false); const u = curUrl(); if (u && !state.err && !/^chrome-error:/.test(u)) setUrl(u); sync(); });
    wv.addEventListener('did-start-navigation', (e) => { if (e.isMainFrame && !e.isInPlace) { state.errors = 0; consoleLog.length = 0; sync(); } });
    const onNav = (e) => {
      if (/^chrome-error:/.test(e.url || '')) return;
      hideErr(); setUrl(e.url);
      state.history = true; sync();
    };
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame !== false) onNav(e); });
    wv.addEventListener('page-title-updated', (e) => setTitle(e.title));
    wv.addEventListener('page-favicon-updated', (e) => { state.favicon = (e.favicons && e.favicons[0]) || ''; emit('favicon', state.favicon); });
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3 || e.errorCode === 0) return;     // -3 = aborted by a newer navigation
      showErr(e.errorCode, e.errorDescription, e.validatedURL || state.target);
    });
    wv.addEventListener('render-process-gone', () => showErr(-1, 'The page crashed', state.url || state.target));
    wv.addEventListener('console-message', (e) => {
      const m = String(e.message || '');
      if (m.startsWith('\u0001bp-zoom:')) { api_.setZoom(stepZoom(+m.slice(9) || 0)); return; }
      if (m.startsWith('\u0001bp-open:')) { openPopup(m.slice(9)); return; }
      if (/^%cElectron Security Warning/.test(m)) return;   // dev-mode noise from the guest
      onConsole(e);
    });
    wv.addEventListener('devtools-closed', () => { if (state.devOpen) closeDev(true); });
    wv.addEventListener('focus', () => emit('focus'));

    // ---------- public controller ----------
    const api_ = {
      el: root,
      navigate(u) {
        const url = normalizeUrl(u);
        if (!url) { api_.goStart(); return; }
        input.value = url;
        loadUrl(url);
      },
      goStart() {
        hideErr(); state.target = ''; state.errors = 0; consoleLog.length = 0;
        if (state.ready) { const r = wv.loadURL('about:blank'); if (r && r.catch) r.catch(() => {}); }
        state.url = ''; sync(); emit('url', ''); showStart();
      },
      back() { wvDo(() => { if (wv.canGoBack()) wv.goBack(); }); },
      forward() { wvDo(() => { if (wv.canGoForward()) wv.goForward(); }); },
      reload(hard) {
        if (state.err) return retry();
        wvDo(() => (hard ? wv.reloadIgnoringCache() : wv.reload()));
      },
      stop() { wvDo(() => wv.stop()); setLoading(false); },
      openDevTools() { return openDev(); },
      closeDevTools() { closeDev(); },
      screenshot,
      // run JavaScript inside the page (used by the IDE tools that let agents inspect the preview)
      eval(code) { if (!state.ready) return Promise.reject(new Error('The page is not ready yet')); return wv.executeJavaScript(String(code), true); },
      // synthetic *trusted* input for the agent tools (click / type / keys): coordinates are viewport CSS px
      input(ev) { try { wv.sendInputEvent(ev); return true; } catch { return false; } },
      insertText(s) { return wv.insertText(String(s)); },
      on,
      focus() { if (state.url && state.ready) { try { wv.focus(); return; } catch {} } input.focus(); },
      setZoom(f) {
        f = Math.max(0.25, Math.min(5, +f || 1));
        state.zoom = f; wvDo(() => wv.setZoomFactor(f)); sync();
      },
      setDevice(name) {
        const d = DEVICES.find((x) => x.id === name || x.label.toLowerCase() === String(name).toLowerCase());
        if (!d) return;
        state.device = d.id;
        if (d.w) { state.dw = d.w; state.dh = d.h; }
        sync(); layout();
      },
      destroy() {
        state.destroyed = true;
        clearInterval(startTimer); clearInterval(retryTimer); clearTimeout(fsTimer);
        try { ro.disconnect(); } catch {}
        if (state.devOpen) closeDev();
        byGuestId.delete(state.guestId); panes.delete(ctl);
        try { wv.stop(); } catch {}
        root.remove();
        for (const k in listeners) listeners[k] = [];
      },
      // internal hooks used by the module-level listeners
      _cmd: cmdRun,
      _fsChanged() { if (state.live) liveReload(); },
    };
    // live properties
    const ctl = api_;
    Object.defineProperties(ctl, {
      url: { get: () => state.url, enumerable: true },
      title: { get: () => titleOf(), enumerable: true },
      console: { get: () => consoleLog, enumerable: true },
      loading: { get: () => state.loading, enumerable: true },
      favicon: { get: () => state.favicon, enumerable: true },
      zoom: { get: () => state.zoom, enumerable: true },
      device: { get: () => state.device, enumerable: true },
      liveReload: { get: () => state.live, set: (v) => { state.live = !!v; sync(); }, enumerable: true },
      errorsText: { value: errorsText },
    });

    // live reload on workspace changes (debounced, localhost only)
    let fsTimer = 0;
    function liveReload() {
      clearTimeout(fsTimer);
      fsTimer = setTimeout(() => {
        const p = parse(state.url);
        if (!state.ready || !p || !isLocalHost(p.hostname) || !root.isConnected || state.err) return;
        try { wv.reload(); } catch {}
      }, 400);
    }

    panes.add(ctl);
    renderStart(null);
    sync();
    if (opts.url) api_.navigate(opts.url); else showStart();
    return ctl;
  }

  window.BrowserPane = { create, normalizeUrl };
})();







