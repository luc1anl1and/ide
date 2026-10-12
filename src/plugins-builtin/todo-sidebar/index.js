// TODO Sidebar - a sidebar panel that scans the workspace for TODO / FIXME comments.
// Shows: addSidebarPanel, workspace search, opening a file at a line, refreshing on save, a status bar counter.

const TAG = /\b(TODO|FIXME|HACK|XXX)\b[:\s(]/;
const COMMENT = /(\/\/|#|\/\*|\*|<!--|--|;)\s*.*\b(TODO|FIXME|HACK|XXX)\b/;   // only count real comment lines

exports.activate = (reva) => {
  const { h } = reva.ui;
  let items = [];      // [{file, line, tag, text}]
  let loaded = false;

  async function scan() {
    if (!reva.workspace.root) { items = []; return; }
    // fs search is done in the main process, so it is fast and skips node_modules / .git / binaries
    const hits = [];
    for (const q of ['TODO', 'FIXME', 'HACK', 'XXX']) hits.push(...(await reva.workspace.search(q, { max: 400 })));
    const seen = new Set();
    items = hits.filter((x) => x.line > 0 && TAG.test(x.text + ' ') && COMMENT.test(x.text))
      .filter((x) => { const k = x.file + ':' + x.line; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((x) => ({ file: x.file, line: x.line, tag: TAG.exec(x.text + ' ')[1], text: x.text.replace(/^.*?\b(TODO|FIXME|HACK|XXX)\b[:\s(]*/, '').trim() }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    loaded = true;
    counter.update({ text: items.length ? 'TODO ' + items.length : '', tooltip: items.length + ' TODO/FIXME comments in the workspace' });
  }

  const counter = reva.ui.addStatusItem({ id: 'todo-count', align: 'left', text: '', onClick: () => panel.show() });

  const panel = reva.ui.addSidebarPanel({
    id: 'todos',
    title: 'TODOs',
    icon: 'list',
    // called whenever the panel is shown, or when panel.refresh() runs
    async render(container) {
      container.classList.add('pm-todo');
      container.replaceChildren(h('div', { class: 'empty' }, loaded ? 'Scanning…' : 'Scanning the workspace…'));
      await scan();
      container.replaceChildren();
      if (!reva.workspace.root) { container.append(h('div', { class: 'empty' }, 'Open a folder to find TODOs')); return; }
      if (!items.length) { container.append(h('div', { class: 'empty' }, 'No TODO comments found. Nice.')); return; }
      let lastFile = null;
      for (const it of items) {
        if (it.file !== lastFile) { lastFile = it.file; container.append(h('div', { class: 'u-note', style: { padding: '10px 14px 2px' } }, rel(it.file))); }
        container.append(h('div', { class: 'res', title: it.file + ':' + it.line, onclick: () => reva.editor.openFile(it.file, it.line) },
          h('div', { class: 'rf' }, h('span', { class: 'tag ' + it.tag }, it.tag), h('span', null, 'line ' + it.line)),
          h('div', { class: 'rt' }, it.text || '(no description)')));
      }
    },
  });

  const rel = (p) => { const r = reva.workspace.root; return r && p.toLowerCase().startsWith(r.toLowerCase()) ? p.slice(r.length).replace(/^[\\/]/, '') : p; };

  // keep it fresh: on save, and (debounced) when files change on disk
  let t;
  // refresh() returns nothing when the panel is not on screen - then just update the status bar counter
  const later = () => { clearTimeout(t); t = setTimeout(() => { if (!panel.refresh()) scan(); }, 700); };
  reva.editor.onDidSave(later);
  reva.workspace.onDidChange(later);
  reva.workspace.onDidOpen(later);

  reva.commands.register('show', () => panel.show());
  reva.commands.register('refresh', () => panel.refresh());
  scan();   // fill the status counter right away
};
