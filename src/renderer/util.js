// shared helpers + global state
window.A = {
  settings: {}, ws: null, // ws = workspace root path
  chats: [], activeChat: null,
  auth: null, mcp: [], rate: null,
};

window.DEFAULTS = {
  theme: 'amethyst', accent: '', uiScale: 1, uiFont: '', chatFontSize: 13.5, animations: true,
  editorFont: '"JetBrains Mono Variable", "Cascadia Code", Consolas', editorSize: 13, editorLineHeight: 0, chatFont: '', termFont: '"CaskaydiaCove Nerd Font Mono", "JetBrains Mono Variable", "Cascadia Code", Consolas, monospace', termSize: 13, termCursor: 'bar', userFonts: [], agentCfg: {}, customAgents: [], envVars: [], keyUse: {}, ligatures: false, wordWrap: 'off', minimap: false,
  lineNumbers: 'on', tabSize: 2, autoSave: 'off', cursorStyle: 'line', smoothCaret: true, bracketColors: true,
  model: '', effort: '', permissionMode: 'manual', appendSystemPrompt: '', claudePath: '', codexPath: '', opencodePath: '', addDirs: [],
  brandName: 'Reva', userName: 'Dev', provider: 'claude', chatLayout: 'side',
  defaults: { claude: { model: '', effort: '', mode: 'manual' }, codex: { model: '', effort: '', mode: 'ask' }, opencode: { model: '', effort: '', mode: 'ask' } },
  voice: { model: 'small', language: 'auto', autoSend: false, live: true, frames: 8, deviceId: 'default' },
  showThinking: true, expandTools: false, notify: true, ideTools: true, shareOpenFile: true, shell: 'powershell',
  pet: { enabled: true, id: 'reva', scale: 0.75, wander: true, bubbles: true, quips: true, keepRunning: true }, pcControl: 'ask',
  lastWorkspace: '', recent: [],
  layout: { sideW: 260, chatW: 460, termH: 200, sideOpen: true, chatOpen: true, termOpen: false, panel: 'explorer' },
};

// ---------- icons ----------
const P = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H7l-4 8z"/><path d="M3 19l4-8h16l-4 8z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-9 9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.500 4v16"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  clip: '<path d="M21 12.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  sparkle: '<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/>',
  chevDown: '<path d="M6 9l6 6 6-6"/>',
  collapseAll: '<path d="M7 4l5 5 5-5M7 20l5-5 5 5"/><path d="M4 12h16"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  chevLeft: '<path d="M15 6l-6 6 6 6"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v8"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M4 20h16"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.400 0 2-1 1.500-2.100-.5-1.200.2-2.400 1.500-2.400H17a4 4 0 0 0 4-4C21 6.700 17 3 12 3z"/><circle cx="7.500" cy="11" r="1"/><circle cx="10" cy="7.500" r="1"/><circle cx="14.500" cy="7.500" r="1"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  agent: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4M9 12v1.500M15 12v1.500"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14.500 4v16"/>',
  panelBottom: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 14.500h18"/>',
  focus: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.500 13.500h5"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.700L3 8"/><path d="M3 3v5h5"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14l4-5"/>',
  warn: '<path d="M12 3l9.500 17h-19z"/><path d="M12 10v4M12 17h.01"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.500l3 3 5-6"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',  task: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
};
window.icon = (n) => `<svg class="ic" viewBox="0 0 24 24">${P[n] || P.file}</svg>`;

// ---------- DOM helper ----------
window.h = function (tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};
window.$ = (s, r) => (r || document).querySelector(s);
window.$$ = (s, r) => [...(r || document).querySelectorAll(s)];
window.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
window.uuid = () => crypto.randomUUID();
window.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- paths ----------
window.basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
window.dirname = (p) => p.replace(/[\\/][^\\/]*$/, '');
window.joinp = (a, b) => a.replace(/[\\/]+$/, '') + '\\' + b;
window.relp = (p) => (A.ws && p.toLowerCase().startsWith(A.ws.toLowerCase()) ? p.slice(A.ws.length).replace(/^[\\/]/, '') : p);
window.extOf = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');
window.IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

// ---------- toast / modal / ctx ----------
window.toast = function (msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3200);
};
window.toastAction = function (msg, label, fn) {
  const t = h('div', { class: 'toast act' }, h('span', null, msg), h('button', { class: 'btn sm primary', onclick: () => { t.remove(); fn(); } }, label), h('button', { class: 'icon-btn sm', html: icon('x'), onclick: () => t.remove() }));
  $('#toasts').append(t); setTimeout(() => t.remove(), 12000);
};
window.openModal = function (content, opts = {}) {
  const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim && !opts.sticky) close(); } });
  const modal = h('div', { class: 'modal ' + (opts.cls || '') }, content);
  scrim.append(modal); $('#overlay-root').append(scrim);
  function close() { scrim.remove(); document.removeEventListener('keydown', onKey, true); opts.onClose && opts.onClose(); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  document.addEventListener('keydown', onKey, true);
  return { close, scrim, modal };
};
window.confirmBox = (title, text, okLabel = 'OK', danger) => new Promise((res) => {
  const m = openModal([
    h('div', { class: 'mh' }, title), h('div', { class: 'mb' }, text),
    h('div', { class: 'mf' }, h('button', { class: 'btn', onclick: () => { res(false); m.close(); } }, 'Cancel'),
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { res(true); m.close(); } }, okLabel)),
  ], { onClose: () => res(false) }); // a promise settles once: the answer must be given BEFORE close() fires onClose
});
window.promptBox = (title, value = '', placeholder = '') => new Promise((res) => {
  const inp = h('input', { class: 'inp', value, placeholder });
  const done = (v) => { res(v); m.close(); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(inp.value); });
  const m = openModal([h('div', { class: 'mh' }, title), h('div', { class: 'mb' }, inp),
    h('div', { class: 'mf' }, h('button', { class: 'btn', onclick: () => done(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => done(inp.value) }, 'OK'))],
    { onClose: () => res(null) });
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
});
window.ctxMenu = function (x, y, items) {
  $$('.ctxmenu').forEach((e) => e.remove());
  const m = h('div', { class: 'ctxmenu' });
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    m.append(h('div', { class: 'ci' + (it.danger ? ' danger' : ''), onclick: () => { m.remove(); it.run(); } }, it.label));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); removeEventListener('mousedown', off, true); } };
  setTimeout(() => addEventListener('mousedown', off, true), 0);
};

// ---------- settings ----------
window.saveSettings = debounce(() => api.settings.set(A.settings), 300);
window.setSetting = function (k, v) { A.settings[k] = v; saveSettings(); applySettings(k); };
window.timeAgo = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};
window.GEM = '<svg viewBox="0 0 24 24"><path d="M12 2 4 9l8 13 8-13z" fill="url(#gg)"/><path d="M4 9h16M12 2l-3 7 3 13 3-13z" stroke="#fff" stroke-opacity=".35" fill="none" stroke-width=".7"/><defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9b3ff"/><stop offset="1" stop-color="#7a2cff"/></linearGradient></defs></svg>';
