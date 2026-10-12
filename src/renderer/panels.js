// Sidebar panels: explorer, search, sessions, MCP + terminal
(function () {
  const side = () => $('#sidebar');
  const PANELS = [
    ['explorer', 'folder', 'Explorer'], ['search', 'search', 'Search'], ['sessions', 'history', 'Sessions'], ['agents', 'agent', 'Agents'], ['mcp', 'plug', 'MCP Servers'],
  ];
  let current = 'explorer';

  const LABEL = { explorer: 'Files', search: 'Search', sessions: 'Chats', agents: 'Agents', mcp: 'MCP' };
  // Where each panel lives: the left sidebar, the right sidebar, or its own window ("popped out").
  const dockOf = (id) => ((A.settings.layout.dock || {})[id] === 'right' ? 'right' : 'left');
  const popped = () => (A.popped = A.popped || new Set());
  const POPPABLE = new Set(['explorer', 'search', 'sessions', 'mcp']);
  const inDock = (where) => PANELS.filter(([id]) => dockOf(id) === where && !popped().has(id));
  let currentR = null;
  function navBar(where, cur) {
    const badge = (id) => (id === 'agents' && Agents.count() ? '<i class="nb">' + Agents.count() + '</i>' : '');
    return h('div', { class: 'seg-nav' }, inDock(where).map(([id]) => h('button', { class: id === cur ? 'on' : '', 'data-p': id, title: 'Right-click to move or pop out', onclick: () => Panels.show(id), oncontextmenu: (e) => { e.preventDefault(); dockMenu(e.clientX, e.clientY, id); }, html: LABEL[id] + badge(id) })));
  }
  function dockMenu(x, y, id) {
    const left = dockOf(id) === 'left';
    ctxMenu(x, y, [
      { label: left ? 'Move to right sidebar' : 'Move to left sidebar', run: () => Panels.dock(id, left ? 'right' : 'left') },
      POPPABLE.has(id) ? { label: 'Unpin — open in its own window', run: () => Panels.popOut(id) } : null,
    ].filter(Boolean));
  }
  // small button at the end of a panel's header: move / unpin
  function addDockButton(head, id) {
    if (!head || !head.classList || !head.classList.contains('panel-head')) return;
    let acts = $('.acts', head); if (!acts) { acts = h('div', { class: 'acts' }); head.append(acts); }
    acts.append(h('button', { class: 'icon-btn', title: 'Move or unpin this panel', html: icon('layers'), onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); dockMenu(r.left, r.bottom + 4, id); } }));
  }
  // ---------- Explorer ----------
  // ---------- New file / folder dialog: type a name (sub-folders allowed), pick an extension, starter templates ----------
  const TEMPLATES = {
    html: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Document</title>\n  <style>\n    body { font-family: system-ui, sans-serif; margin: 40px; }\n  </style>\n</head>\n<body>\n  <h1>Hello</h1>\n  <script>\n    console.log("ready");\n  </script>\n</body>\n</html>\n',
    js: '"use strict";\n\n', ts: 'export {};\n\n', py: 'def main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n', md: '# Title\n\n', json: '{\n  \n}\n', css: ':root {\n  \n}\n', jsx: 'export default function Component() {\n  return <div />;\n}\n', tsx: 'export default function Component() {\n  return <div />;\n}\n',
    c: '#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n', cpp: '#include <iostream>\n\nint main() {\n    return 0;\n}\n', rs: 'fn main() {\n    println!("Hello");\n}\n', go: 'package main\n\nfunc main() {\n}\n', sh: '#!/usr/bin/env bash\nset -euo pipefail\n\n', ps1: '', bat: '@echo off\n',
  };
  const QUICK_EXT = ['.html', '.js', '.ts', '.py', '.md', '.json', '.css', '.tsx', '.cpp', '.rs', '.txt'];
  window.newFileDialog = async function (dir, isDir) {
    dir = dir || A.ws; if (!dir) { toast('Open a folder first', true); return App.openFolder(); }
    let taken = new Set(); try { const l = await api.fs.readdir(dir); if (Array.isArray(l)) taken = new Set(l.map((e) => e.name.toLowerCase())); } catch { }
    const name = h('input', { class: 'inp mono', placeholder: isDir ? 'folder-name  (or  parent/child)' : 'filename.ext  (or  folder/filename.ext)', spellcheck: 'false' });
    const note = h('div', { class: 'u-note' }, 'in ' + relp(dir) + '\\');
    const setExt = (ext) => { let v = name.value.trim() || 'untitled'; v = /\.[A-Za-z0-9]{1,6}$/.test(v) ? v.replace(/\.[A-Za-z0-9]{1,6}$/, ext) : v + ext; name.value = v; name.focus(); check(); };
    const chips = isDir ? null : h('div', { class: 'ext-chips' }, QUICK_EXT.map((e) => h('button', { type: 'button', class: 'fchip', onclick: () => setExt(e) }, e)));
    const btn = h('button', { class: 'btn primary', onclick: () => go() }, isDir ? 'Create folder' : 'Create file');
    const check = () => {
      const v = name.value.trim(); const first = v.split(/[\\/]/)[0].toLowerCase(); let msg = '', bad = false;
      if (!v) { btn.disabled = true; note.textContent = 'in ' + relp(dir) + '\\'; note.style.color = ''; return; }
      if (/[<>:"|?*]/.test(v)) { msg = 'Characters < > : " | ? * are not allowed'; bad = true; }
      else if (!/[\\/]/.test(v) && taken.has(first)) { msg = 'Already exists'; bad = true; }
      else msg = 'Will create ' + (relp(dir) ? relp(dir) + '\\' : '') + v.replace(/\//g, '\\');
      btn.disabled = bad; note.textContent = msg; note.style.color = bad ? 'var(--bad)' : '';
    };
    const go = async () => {
      const v = name.value.trim().replace(/\//g, '\\'); if (!v || btn.disabled) return;
      const full = joinp(dir, v); const ext = (v.split('.').pop() || '').toLowerCase();
      const r = await api.fs.create({ file: full, dir: !!isDir, content: isDir ? '' : (TEMPLATES[ext] || '') });
      if (!r.ok) { toast(r.error || 'Could not create it', true); return; }
      m.close();
      // expand every folder on the way, refresh and (for files) open it right away
      let cur = dir; Explorer.expanded.add(cur); const parts = v.split('\\'); if (parts.length > 1) for (const p of parts.slice(0, -1)) { cur = joinp(cur, p); Explorer.expanded.add(cur); }
      Explorer.cache = {}; Explorer.sel = full; await Explorer.render();
      if (!isDir) window.openFile(full);
    };
    name.addEventListener('input', check); name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const m = openModal([h('div', { class: 'mh' }, isDir ? 'New folder' : 'New file'), h('div', { class: 'mb' }, name, chips, note), h('div', { class: 'mf' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), btn)]);
    btn.disabled = true; setTimeout(() => name.focus(), 30);
  };
  // folder a "new file" should land in: the selected folder, the folder of the selected file, or the workspace root
  window.currentDir = () => { const sel = window.Explorer && Explorer.sel; if (!sel) return A.ws; const isDir = Explorer.expanded.has(sel) || !/\.[^\\/]+$/.test(sel); return isDir ? sel : dirname(sel); };

  const Explorer = {
    expanded: new Set(), cache: {}, sel: null,
    async load(dir) { const r = await api.fs.readdir(dir); this.cache[dir] = Array.isArray(r) ? r : []; return this.cache[dir]; },
    async render() {
      const body = $('#ex-body'); if (!body) return;
      if (!A.ws) { body.innerHTML = ''; body.append(h('div', { class: 'empty' }, 'No folder opened', h('br'), h('button', { class: 'btn primary', onclick: () => App.openFolder() }, 'Open Folder'))); return; }
      const my = (this._r = (this._r || 0) + 1); // only the newest render may touch the DOM (older ones can finish late)
      const frag = h('div', { class: 'tree' });
      const walk = async (dir, depth) => {
        const ents = this.cache[dir] || (await this.load(dir));
        for (const e of ents) {
          const full = joinp(dir, e.name); const open = e.dir && this.expanded.has(full);
          const ext = extOf(e.name);
          const n = h('div', { class: 'node' + (e.dir ? ' dir' : '') + (open ? ' open' : '') + (this.sel === full ? ' sel' : ''), style: { paddingLeft: 8 + depth * 14 + 'px' }, draggable: 'true' },
            h('span', { class: 'chev', html: e.dir ? icon('chev') : '' }),
            h('span', { class: 'fi ext-' + (IMG_EXT.has(ext) ? 'img' : ext), html: icon(e.dir ? (open ? 'folderOpen' : 'folder') : IMG_EXT.has(ext) ? 'image' : 'file') }),
            h('span', { class: 'nm' }, e.name));
          n.addEventListener('click', async () => {
            this.sel = full;
            if (e.dir) { open ? this.expanded.delete(full) : this.expanded.add(full); await this.render(); } else { window.openFile(full); this.render(); }
          });
          n.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/reva-path', full); });
          n.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.menu(ev, full, e.dir); });
          frag.append(n);
          if (open) await walk(full, depth + 1);
        }
      };
      await walk(A.ws, 0);
      if (my !== this._r) return;
      const st = body.scrollTop; body.innerHTML = ''; body.append(frag); body.scrollTop = st;
    },
    async refresh(paths) {
      // drop cached dirs touched by changes
      if (!paths) this.cache = {};
      else for (const p of paths) { const d = dirname(p); delete this.cache[d]; delete this.cache[p]; }
      await this.render();
    },
    menu(ev, full, isDir) {
      const base = isDir ? full : dirname(full);
      ctxMenu(ev.clientX, ev.clientY, [
        { label: 'New File…', run: () => newFileDialog(base, false) },
        { label: 'New Folder…', run: () => newFileDialog(base, true) },
        '-',
        { label: 'Mention in Chat', run: () => Chat.insert('@' + relp(full) + ' ') },
        { label: 'Rename…', run: async () => { const n = await promptBox('Rename', basename(full)); if (n && n !== basename(full)) { const r = await api.fs.rename({ from: full, to: joinp(dirname(full), n) }); r.ok ? this.refresh() : toast(r.error, true); } } },
        { label: 'Copy Path', run: () => navigator.clipboard.writeText(full) },
        { label: 'Reveal in File Explorer', run: () => api.fs.reveal(full) },
        ...(window.RevaPlugins ? RevaPlugins.explorerMenuItems(full, isDir) : []),
        '-',
        { label: 'Delete', danger: true, run: async () => { if (await confirmBox('Delete', `Move “${basename(full)}” to the Recycle Bin?`, 'Delete', true)) { const r = await api.fs.trash(full); r.ok ? this.refresh() : toast(r.error, true); } } },
      ]);
    },
    panel() {
      return [
        h('div', { class: 'panel-head' }, h('span', null, A.ws ? basename(A.ws) : 'Explorer'), h('div', { class: 'acts' },
          h('button', { class: 'icon-btn', title: 'New file (Ctrl+N)', html: icon('plus'), onclick: () => newFileDialog(currentDir(), false) }),
          h('button', { class: 'icon-btn', title: 'New folder', html: icon('folderPlus'), onclick: () => newFileDialog(currentDir(), true) }),
          h('button', { class: 'icon-btn', title: 'Refresh', html: icon('refresh'), onclick: () => this.refresh() }),
          h('button', { class: 'icon-btn', title: 'Collapse all folders', html: icon('collapseAll'), onclick: () => { this.expanded.clear(); this.sel = null; this.render(); } }))),
        h('div', { class: 'panel-body', id: 'ex-body' }),
      ];
    },
  };

  // ---------- Search ----------
  const Search = {
    panel() {
      const out = h('div', { class: 'panel-body', id: 'sr-out' });
      const inp = h('input', { class: 'inp', placeholder: 'Search files & contents…  (Enter)', onkeydown: async (e) => {
        if (e.key !== 'Enter' || !inp.value.trim() || !A.ws) return;
        out.innerHTML = '<div class="empty">Searching…</div>';
        const r = await api.fs.search({ root: A.ws, query: inp.value.trim() });
        out.innerHTML = ''; if (!r.length) out.append(h('div', { class: 'empty' }, 'No results'));
        r.forEach((x) => out.append(h('div', { class: 'res', onclick: () => window.openFile(x.file, x.line) }, h('div', { class: 'rf' }, relp(x.file) + (x.line ? ':' + x.line : '')), h('div', { class: 'rt' }, x.text))));
      } });
      setTimeout(() => inp.focus(), 30);
      return [h('div', { class: 'panel-head' }, h('span', null, 'Search')), h('div', { class: 'sbox' }, inp), out];
    },
  };

  // ---------- Sessions ----------
  // ---------- Chats: Reva's own saved chats + history of the CLIs (Claude / Codex / OpenCode) ----------
  const Sessions = {
    all: null, filter: 'all', source: 'all', q: '', group: 'provider', loading: false, collapsed: new Set(),
    panel() {
      const out = h('div', { class: 'panel-body chats' });
      const src = h('div', { class: 'seg sm' }); const chips = h('div', { class: 'chips-row' });
      const search = h('input', { class: 'inp', placeholder: 'Search chats…', value: this.q, oninput: () => { this.q = search.value.toLowerCase(); draw(); } });
      const drawSrc = () => { src.innerHTML = ''; [['all', 'All'], ['reva', 'Reva'], ['cli', 'CLI history']].forEach(([v, l]) => src.append(h('button', { class: this.source === v ? 'on' : '', title: v === 'reva' ? 'Chats saved by this app, in its own folder' : v === 'cli' ? 'History read from Claude, Codex and OpenCode themselves — including chats started in a terminal' : '', onclick: () => { this.source = v; drawSrc(); draw(); } }, l))); };
      const drawChips = () => {
        chips.innerHTML = '';
        [['all', 'All agents', null], ...PROV_IDS.map((id) => [id, PROV[id].name, PROV[id].logo])].forEach(([id, label, logo]) =>
          chips.append(h('button', { class: 'fchip' + (this.filter === id ? ' on' : ''), onclick: () => { this.filter = id; drawChips(); draw(); } }, logo ? h('span', { class: 'fl', html: logo }) : null, label)));
      };
      const open = (s) => {
        const cwd = s.cwd && s.cwd.toLowerCase() !== (A.ws || '').toLowerCase() ? s.cwd : null;
        Chat.new({ provider: s.provider, title: s.title.slice(0, 30), cwd, revaId: s.source === 'reva' ? s.id : null, resume: s.source === 'reva' ? (s.sessionId || null) : s.id });
        App.toggleChat(true);
      };
      const item = (s) => {
        const P = PROV[s.provider]; if (!P) return null;
        const model = s.model ? String(s.model).replace(/^claude-/, '').replace(/-\d{8}$/, '') : '';
        const row = h('div', { class: 'item chat-item', title: (s.cwd || '') + '\n' + s.id, onclick: () => open(s) },
          h('span', { class: 'av', html: P.logo }),
          h('div', { class: 'ci' }, h('div', { class: 'it1' }, s.title), h('div', { class: 'it2' }, [s.source === 'reva' ? 'Reva' : null, model, s.cwd ? basename(s.cwd) : null, timeAgo(s.updatedAt)].filter(Boolean).join(' · '))),
          s.source === 'reva' ? h('button', { class: 'icon-btn sm del', title: 'Delete this saved chat', html: icon('trash'), onclick: async (e) => { e.stopPropagation(); if (!(await confirmBox('Delete chat', `Delete “${s.title}” from Reva’s saved chats? The agent’s own history is not touched.`, 'Delete', true))) return; await api.chats.delete(s.id); this.all = this.all.filter((x) => x !== s); draw(); } }) : null);
        return row;
      };
      const draw = () => {
        out.innerHTML = '';
        const live = A.chats.filter((c) => c.sessionId || c.title !== 'New chat');
        if (live.length && !this.q) {
          out.append(h('div', { class: 'sec-t' }, 'Open now', h('span', { class: 'cnt' }, String(live.length))));
          live.forEach((c) => out.append(h('div', { class: 'item chat-item', onclick: () => Chat.select(c) }, h('span', { class: 'av' + (c.running ? ' alive' : ''), html: PROV[c.cfg.provider].logo }), h('div', { class: 'ci' }, h('div', { class: 'it1' }, c.title), h('div', { class: 'it2' }, PROV[c.cfg.provider].name + ' · ' + (c.running ? 'working…' : 'idle'))))));
        }
        if (this.loading && !this.all) { out.append(h('div', { class: 'empty' }, h('span', { class: 'spin' }), h('div', { style: { marginTop: '8px' } }, 'Loading chats…'))); return; }
        const list = (this.all || []).filter((s) => PROV[s.provider] && (this.filter === 'all' || s.provider === this.filter) && (this.source === 'all' || s.source === this.source) && (!this.q || (s.title + ' ' + (s.cwd || '')).toLowerCase().includes(this.q)));
        if (!list.length) { out.append(h('div', { class: 'empty' }, this.all ? (this.source === 'reva' ? 'No saved Reva chats yet — they appear here as you chat' : 'No chats found') : 'Nothing to show')); return; }
        const groups = new Map();
        for (const s of list) { const k = this.group === 'provider' ? s.provider : this.group === 'project' ? (s.cwd ? basename(s.cwd) : 'No project') : dayLabel(s.updatedAt); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
        const order = this.group === 'provider' ? PROV_IDS.filter((p) => groups.has(p)) : [...groups.keys()];
        for (const k of order) {
          const items = groups.get(k); const col = this.collapsed.has(k);
          out.append(h('div', { class: 'sec-t prov clickable', onclick: () => { col ? this.collapsed.delete(k) : this.collapsed.add(k); draw(); } },
            h('span', { class: 'chv' + (col ? '' : ' open'), html: icon('chev') }), this.group === 'provider' && PROV[k] ? h('span', { class: 'fl', html: PROV[k].logo }) : null, this.group === 'provider' && PROV[k] ? PROV[k].name : k, h('span', { class: 'cnt' }, String(items.length))));
          if (!col) items.slice(0, 80).forEach((s) => { const r = item(s); r && out.append(r); });
        }
      };
      const load = async (force) => {
        if (this.loading) return; this.loading = true; if (force) this.all = null; draw();
        try { this.all = await api.sessions.all({ custom: { codex: customPath('codex'), opencode: customPath('opencode') } }); } catch { this.all = this.all || []; }
        this.loading = false; draw();
      };
      const groupBtn = h('button', { class: 'icon-btn', title: 'Group by agent / project / date', html: icon('list'), onclick: (e) => Combo.open(e.currentTarget, { title: 'Group by', width: 200, value: this.group, items: [{ value: 'provider', label: 'Agent' }, { value: 'project', label: 'Project' }, { value: 'date', label: 'Date' }], onPick: (v) => { this.group = v; this.collapsed.clear(); draw(); } }) });
      drawSrc(); drawChips(); if (this.all) draw(); else load();
      return [h('div', { class: 'panel-head' }, h('span', null, 'Chats'), h('div', { class: 'acts' }, groupBtn,
        h('button', { class: 'icon-btn', title: 'Open Reva’s chat folder', html: icon('folder'), onclick: async () => api.fs.reveal(await api.chats.dir()) }),
        h('button', { class: 'icon-btn', title: 'New chat', html: icon('plus'), onclick: () => Chat.new() }), h('button', { class: 'icon-btn', title: 'Refresh', html: icon('refresh'), onclick: () => load(true) }))),
        h('div', { class: 'sbox' }, search), h('div', { class: 'sbox tight' }, src), chips, out];
    },
  };
  window.Sessions = Sessions;
  const dayLabel = (ms) => { const d = new Date(ms), n = new Date(); const diff = Math.floor((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000); return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'This week' : diff < 31 ? 'This month' : 'Older'; };

  // ---------- MCP ----------
  const SPOT = { connected: ['good', 'Connected'], auth: ['warn', 'Needs authentication'], failed: ['bad', 'Failed'], pending: ['warn', 'Pending'], disabled: ['', 'Disabled'], unknown: ['', 'Unknown'] };
  const PRESETS = [
    { name: 'filesystem', transport: 'stdio', target: 'npx', args: '-y @modelcontextprotocol/server-filesystem .' },
    { name: 'memory', transport: 'stdio', target: 'npx', args: '-y @modelcontextprotocol/server-memory' },
    { name: 'sequential-thinking', transport: 'stdio', target: 'npx', args: '-y @modelcontextprotocol/server-sequential-thinking' },
    { name: 'playwright', transport: 'stdio', target: 'npx', args: '-y @playwright/mcp@latest' },
    { name: 'context7', transport: 'http', target: 'https://mcp.context7.com/mcp', args: '' },
  ];
  const Mcp = {
    loading: false,
    panel() {
      const body = h('div', { class: 'panel-body', id: 'mcp-body' });
      setTimeout(() => this.refresh(), 0);
      return [h('div', { class: 'panel-head' }, h('span', null, 'MCP Servers'), h('div', { class: 'acts' },
        h('button', { class: 'icon-btn', title: 'Add server', html: icon('plus'), onclick: () => this.addDialog() }),
        h('button', { class: 'icon-btn', title: 'Refresh status', html: icon('refresh'), onclick: () => this.refresh() }))), body];
    },
    async refresh() {
      const body = $('#mcp-body'); if (!body) return;
      if (this.loading) return; this.loading = true;
      if (!A.mcp.length) body.innerHTML = '<div class="empty">Checking server health…</div>';
      else $$('.mcp .badge', body).forEach((e) => (e.textContent = 'checking…'));
      const r = await api.mcp.list({ custom: A.settings.claudePath, cwd: A.ws });
      this.loading = false; A.mcp = r.servers; updateStatus();
      this.render();
    },
    render() {
      const body = $('#mcp-body'); if (!body) return; body.innerHTML = '';
      const ok = A.mcp.filter((s) => s.status === 'connected').length;
      body.append(h('div', { class: 'sysline', style: { padding: '2px 0 6px' } }, `${A.mcp.length} servers · ${ok} connected`));
      if (!A.mcp.length) body.append(h('div', { class: 'empty' }, 'No MCP servers configured', h('br'), h('button', { class: 'btn primary', onclick: () => this.addDialog() }, 'Add server')));
      A.mcp.forEach((s) => {
        const [cls, label] = SPOT[s.status] || SPOT.unknown;
        const bcls = cls === 'bad' ? ' bad' : cls === 'warn' ? ' warn' : '';
        body.append(h('div', { class: 'mcp' },
          h('div', { class: 'm1' }, h('b', { title: s.name }, s.name), h('span', { class: 'badge' + bcls, html: (s.status === 'connected' ? icon('check') : s.status === 'failed' ? icon('x') : '') + esc(label) })),
          h('div', { class: 'm2', title: s.target }, s.target),
          h('div', { class: 'm3' },
            h('button', { class: 'btn sm', onclick: async () => { const t = await api.mcp.get({ custom: A.settings.claudePath, cwd: A.ws, name: s.name }); openModal([h('div', { class: 'mh' }, s.name), h('div', { class: 'mb' }, h('pre', { class: 'selectable mono', style: { whiteSpace: 'pre-wrap', fontSize: '12px', margin: 0 } }, t))]); } }, 'Details'),
            s.status === 'auth' || /^https?:/.test(s.target) ? h('button', { class: 'btn sm', onclick: async () => { toast('Opening browser to authenticate…'); const r = await api.mcp.login({ custom: A.settings.claudePath, cwd: A.ws, name: s.name }); toast(r.ok ? 'Authenticated' : r.out.slice(0, 200), !r.ok); this.refresh(); } }, 'Authenticate') : null,
            h('button', { class: 'btn sm danger', onclick: async () => { if (!(await confirmBox('Remove server', `Remove “${s.name}”?`, 'Remove', true))) return; const r = await api.mcp.remove({ custom: A.settings.claudePath, cwd: A.ws, name: s.name }); toast(r.ok ? 'Removed ' + s.name : r.out.slice(0, 240), !r.ok); this.refresh(); } }, 'Remove'))));
      });
    },
    addDialog() {
      let transport = 'stdio', mode = 'form';
      const f = {
        name: h('input', { class: 'inp', placeholder: 'my-server' }),
        target: h('input', { class: 'inp', placeholder: 'npx   |   https://example.com/mcp' }),
        args: h('input', { class: 'inp', placeholder: '-y @scope/server-package' }),
        env: h('textarea', { class: 'inp', rows: 2, placeholder: 'KEY=value (one per line)' }),
        headers: h('textarea', { class: 'inp', rows: 2, placeholder: 'Authorization: Bearer … (one per line)' }),
        scope: Sel([['user', 'User (all projects)'], ['local', 'Local (this project, private)'], ['project', 'Project (.mcp.json, shared)']], 'user', null, { width: '100%', menuWidth: 320 }),
        json: h('textarea', { class: 'inp mono', rows: 6, placeholder: '{"type":"stdio","command":"npx","args":["-y","pkg"],"env":{}}' }),
      };
      const fArgs = h('div', { class: 'field' }, h('label', null, 'Arguments'), f.args), fEnv = h('div', { class: 'field' }, h('label', null, 'Environment variables'), f.env), fHeaders = h('div', { class: 'field hidden' }, h('label', null, 'Headers'), f.headers);
      const fTarget = h('div', { class: 'field' }, h('label', { id: 'lbl-target' }, 'Command'), f.target);
      const form = h('div', null, h('div', { class: 'field' }, h('label', null, 'Name'), f.name), fTarget, fArgs, fEnv, fHeaders);
      const jsonBox = h('div', { class: 'hidden' }, h('div', { class: 'field' }, h('label', null, 'Name'), h('input', { class: 'inp', id: 'jn', placeholder: 'my-server' })), h('div', { class: 'field' }, h('label', null, 'Server JSON'), f.json));
      const setT = (t) => { transport = t; segT.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t)); const st = t === 'stdio'; fArgs.classList.toggle('hidden', !st); fEnv.classList.toggle('hidden', !st); fHeaders.classList.toggle('hidden', st); $('#lbl-target', form).textContent = st ? 'Command' : 'URL'; };
      const segT = h('div', { class: 'seg' }, ['stdio', 'http', 'sse'].map((t) => h('button', { 'data-t': t, onclick: () => setT(t) }, t)));
      const segM = h('div', { class: 'seg', style: { marginLeft: '8px' } }, ['form', 'json'].map((t) => h('button', { class: t === 'form' ? 'on' : '', onclick: (e) => { mode = t; segM.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); form.classList.toggle('hidden', t !== 'form'); segT.classList.toggle('hidden', t !== 'form'); jsonBox.classList.toggle('hidden', t !== 'json'); } }, t === 'form' ? 'Form' : 'Paste JSON')));
      const presets = h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', margin: '4px 0 6px' } }, PRESETS.map((p) => h('button', { class: 'btn sm', onclick: () => { f.name.value = p.name; f.target.value = p.target; f.args.value = p.args.replace(/ \.$/, A.ws ? ' "' + A.ws + '"' : ' .'); setT(p.transport); } }, p.name)));
      const m = openModal([h('div', { class: 'mh' }, 'Add MCP server'), h('div', { class: 'mb' }, h('div', { style: { display: 'flex', alignItems: 'center' } }, segT, segM), h('div', { class: 'field' }, h('label', null, 'Quick presets'), presets), form, jsonBox, h('div', { class: 'field' }, h('label', null, 'Scope'), f.scope)),
        h('div', { class: 'mf' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => {
          e.target.disabled = true; let r;
          if (mode === 'json') { const name = $('#jn', m.modal).value.trim(); if (!name || !f.json.value.trim()) { e.target.disabled = false; return toast('Name and JSON required', true); } r = await api.mcp.addJson({ custom: A.settings.claudePath, cwd: A.ws, name, json: f.json.value.trim(), scope: f.scope.value }); }
          else {
            if (!f.name.value.trim() || !f.target.value.trim()) { e.target.disabled = false; return toast('Name and ' + (transport === 'stdio' ? 'command' : 'URL') + ' required', true); }
            const kv = (t, sep) => Object.fromEntries(t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return [l.slice(0, i).trim(), l.slice(i + sep.length).trim()]; }));
            const args = (f.args.value.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));
            r = await api.mcp.add({ custom: A.settings.claudePath, cwd: A.ws, name: f.name.value.trim(), transport, target: f.target.value.trim(), args, env: kv(f.env.value, '='), headers: kv(f.headers.value, ':'), scope: f.scope.value });
          }
          if (r.ok) { m.close(); toast('Server added'); this.refresh(); } else { e.target.disabled = false; toast(r.out.slice(0, 300) || 'Failed', true); }
        } }, 'Add'))]);
      setT('stdio'); setTimeout(() => f.name.focus(), 30);
    },
  };

  // ---------- Terminal ----------
  // ---------- Terminal: thin shim over the real PTY terminal (terminal.js) ----------
  const Term = {
    built: false, out: null,
    ensure() { if (!this.built && window.Terminals) { Terminals.build($('#terminal')); this.built = true; } },
    open() { this.ensure(); return window.Terminals && Terminals.open(); },
    reset() { if (window.Terminals && this.built) Terminals.reset(); },
    run(cmd) { this.ensure(); App.toggleTerm(true); return Terminals.runCommand(cmd); },
  };
  // ---------- Agents: every running chat with its sub-agents and background tasks; stop or close them from here ----------
  const Agents = {
    t: null, loop: null,
    count() { let n = 0; A.chats.forEach((c) => { if (c.running) n++; for (const t of c.tasks.values()) if (t.status === 'running') n++; }); return n; },
    touch() {
      clearTimeout(this.t);
      this.t = setTimeout(() => {
        const n = this.count(); $$('.seg-nav button[data-p="agents"]').forEach((b) => { b.innerHTML = 'Agents' + (n ? `<i class="nb">${n}</i>` : ''); });
        if (Panels.visible('agents') && $('#ag-body')) this.render();
      }, 120);
    },
    panel() {
      const body = h('div', { class: 'panel-body agents', id: 'ag-body' });
      setTimeout(() => this.render(), 0);
      return [h('div', { class: 'panel-head' }, h('span', null, 'Agents'), h('div', { class: 'acts' }, h('button', { class: 'icon-btn', title: 'New chat', html: icon('plus'), onclick: () => Chat.new() }))), body];
    },
    render() {
      const body = $('#ag-body'); if (!body) return; const st = body.scrollTop; body.innerHTML = '';
      const dur = (a, b) => { const s = Math.max(0, Math.round(((b || Date.now()) - a) / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
      if (!A.chats.length) body.append(h('div', { class: 'empty' }, 'No chats yet'));
      A.chats.forEach((c) => {
        const P = PROV[c.cfg.provider]; const tasks = [...c.tasks.values()].sort((a, b) => b.started - a.started);
        const state = c.running ? 'Working…' : c.pendingPerms ? 'Needs your approval' : 'Idle';
        const card = h('div', { class: 'ag-chat' + (c === A.activeChat ? ' on' : '') },
          h('div', { class: 'ag-h', onclick: () => Chat.select(c) }, h('span', { class: 'av' + (c.running ? ' alive' : ''), html: P.logo }), h('div', { class: 'ag-t' }, h('b', null, c.title), h('span', null, P.name + ' · ' + state + (c.tokens ? ' · ' + fmtTok((c.tokens.input || 0) + (c.tokens.output || 0)) + ' tokens' : ''))),
            c.running ? h('button', { class: 'btn sm', title: 'Stop what this agent is doing', onclick: (e) => { e.stopPropagation(); Chat.interrupt(c); } }, 'Stop') : null,
            h('button', { class: 'icon-btn sm', title: 'Close this chat', html: icon('x'), onclick: (e) => { e.stopPropagation(); Chat.closeChat(c); } })));
        if (tasks.length) card.append(h('div', { class: 'ag-tasks' }, tasks.map((t) => h('div', { class: 'ag-task ' + t.status, onclick: () => Chat.focusTask(c, t), title: 'Show what it is doing' },
          h('span', { class: 'ti', html: icon(t.kind === 'agent' || /agent/.test(t.kind) ? 'sparkle' : 'term') }),
          h('div', { class: 'ag-tt' }, h('b', null, t.desc), h('span', null, [t.sub, t.toolUses ? t.toolUses + ' tools' : '', t.tokens ? fmtTok(t.tokens) + ' tok' : '', dur(t.started, t.status === 'running' ? 0 : t.ended)].filter(Boolean).join(' · '))),
          t.status === 'running' ? h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); Chat.stopTask(c, t.id); } }, 'Stop') : h('span', { class: 'badge' + (t.status === 'failed' ? ' bad' : '') }, t.status === 'done' ? 'Done' : t.status === 'stopped' ? 'Stopped' : 'Failed')))));
        body.append(card);
      });
      body.scrollTop = st;
      clearTimeout(this.loop); if (this.count() > 0 && Panels.visible('agents')) this.loop = setTimeout(() => this.render(), 1500); // live timers
    },
  };
  window.AgentsPanel = Agents;

  window.Explorer = Explorer; window.Term = Term; window.McpPanel = Mcp;
  const MODS = () => ({ explorer: Explorer, search: Search, sessions: Sessions, agents: Agents, mcp: Mcp });
  function mount(where) {
    const host = where === 'right' ? $('#sidebar2') : side(); const id = where === 'right' ? currentR : current; if (!host) return;
    host.innerHTML = ''; const p = MODS()[id]; if (!p) return;
    const parts = p.panel(); addDockButton(parts[0], id);
    host.append(navBar(where, id), ...parts);
    if (id === 'explorer') Explorer.render();
  }
  window.Panels = {
    init() {
      const l = A.settings.layout; A.popped = new Set();
      current = inDock('left').some(([id]) => id === l.panel) ? l.panel : (inDock('left')[0] || PANELS[0])[0];
      currentR = inDock('right').some(([id]) => id === l.panelR) ? l.panelR : (inDock('right')[0] || [null])[0];
      this.show(current, 'silent'); if (currentR) mount('right'); applyDock();
    },
    show(id, silent) {
      if (popped().has(id)) { api.pop.focus(id); return; }
      const where = dockOf(id);
      if (where === 'right') {
        const l = A.settings.layout; if (!l.rightOpen) { l.rightOpen = true; applyDockLayout(); }
        currentR = id; l.panelR = id; saveSettings(); mount('right');
      } else {
        if (!silent && document.body.classList.contains('collapsed-side')) App.toggleSide(true);
        current = id; A.settings.layout.panel = id; saveSettings(); mount('left');
      }
    },
    // keep the panel list of both sidebars in sync after a move / pop-out
    refreshDocks() {
      if (!inDock('left').some(([i]) => i === current)) current = (inDock('left')[0] || [current])[0];
      if (!inDock('right').some(([i]) => i === currentR)) currentR = (inDock('right')[0] || [null])[0];
      this.show(current, 'silent'); mount('right'); applyDock();
    },
    dock(id, where) {
      const l = A.settings.layout; l.dock = l.dock || {};
      if (where === 'left') delete l.dock[id]; else { if (inDock('left').length <= 1 && dockOf(id) === 'left') { toast('Keep at least one panel on the left', true); return; } l.dock[id] = 'right'; l.rightOpen = true; }
      if (where === 'right') currentR = id; else current = id;
      saveSettings(); this.refreshDocks();
    },
    async popOut(id) {
      if (inDock('left').length <= 1 && dockOf(id) === 'left' && !popped().has(id)) { toast('Keep at least one panel on the left', true); return; }
      const cs = getComputedStyle(document.documentElement);
      const ok = await api.pop.open({ id, ws: A.ws || '', bg: cs.getPropertyValue('--bg1').trim(), fg: cs.getPropertyValue('--fg2').trim() });
      if (ok) { popped().add(id); this.refreshDocks(); }
    },
    popClosed(id) { popped().delete(id); this.refreshDocks(); },
    mods: MODS,
    current: () => current,
    visible: (id) => current === id || currentR === id,
  };
  function applyDock() { const has = inDock('right').length > 0; document.body.classList.toggle('has-side2', has); applyDockLayout(); }
  function applyDockLayout() { const l = A.settings.layout; document.body.classList.toggle('collapsed-side2', !(l.rightOpen && inDock('right').length)); const s2 = $('#sidebar2'); if (s2) s2.style.width = (l.side2W || 280) + 'px'; }
  window.applyDockLayout = applyDockLayout;
})();
