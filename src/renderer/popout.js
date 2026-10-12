// Pop-out mode: index.html?pop=<panel> shows just one sidebar panel (Files / Search / Chats / MCP) in its own window.
// The window only renders the panel; anything that needs the main window (open a file, start a chat…) is forwarded to it.
(function () {
  const q = new URLSearchParams(location.search); const id = q.get('pop'); if (!id) return;
  window.__POP = id;
  const call = (fn, ...args) => api.pop.call({ fn, args });
  const TITLES = { explorer: 'Files', search: 'Search', sessions: 'Chats', mcp: 'MCP Servers' };
  async function boot() {
    document.body.classList.add('pop-window');
    const saved = await api.settings.get(); const D = JSON.parse(JSON.stringify(DEFAULTS));
    A.settings = { ...D, ...saved, layout: { ...D.layout, ...(saved.layout || {}) }, defaults: { ...D.defaults, ...(saved.defaults || {}) }, voice: { ...D.voice, ...(saved.voice || {}) } };
    loadCustomThemes(); Fonts.loadUser();
    const s = A.settings, r = document.documentElement;
    const paint = () => { applyTheme(s.theme, s.accent); const cs = getComputedStyle(r); api.pop.overlay({ color: cs.getPropertyValue('--bg1').trim(), symbolColor: cs.getPropertyValue('--fg2').trim() }); };
    paint();
    if (s.uiFont) r.style.setProperty('--ui-font', s.uiFont + ', "Inter Variable", system-ui, sans-serif');
    r.style.setProperty('--mono', (s.editorFont || DEFAULTS.editorFont) + ', monospace');
    document.body.classList.toggle('no-anim', !s.animations);
    A.logo = await api.app.getLogo(); A.ws = q.get('ws') || s.lastWorkspace || null; window.RevaPlugins = null;
    // main-window actions, forwarded
    window.openFile = (p, line) => call('openFile', p, line || 0);
    window.Chat = { insert: (t) => call('chatInsert', t), new: (o) => call('chatNew', o), select: () => call('chatNew', {}), sendNow: (t) => call('chatInsert', t) };
    window.App = { openFolder: () => call('openFolder'), toggleChat() { }, toggleSide() { }, openBrowser() { } };
    const mods = Panels.mods; window.Panels = { show() { }, current: () => id, visible: (x) => x === id };
    Prov.refreshCustom();
    const bar = h('div', { class: 'pop-bar' }, h('span', { class: 'lg', html: A.logo ? '<img src="' + A.logo + '">' : '' }), h('b', null, TITLES[id] || id),
      h('span', { class: 'sp' }), h('button', { class: 'btn sm', title: 'Put this panel back into the main window', onclick: () => api.pop.close(id) }, 'Dock back'));
    $('#app').prepend(bar);
    const side = $('#sidebar'); const mount = () => { side.innerHTML = ''; side.append(...mods()[id].panel()); if (id === 'explorer') Explorer.render(); };
    mount();
    api.on('pop:ws', (dir) => { A.ws = dir; Explorer.expanded.clear(); Explorer.cache = {}; Explorer.sel = null; A.welcomeChats = null; mount(); });
    api.on('fs:changed', (paths) => { if (id === 'explorer') Explorer.refresh(paths); });
    api.on('pop:theme', (t) => { s.theme = t.theme; s.accent = t.accent; paint(); });
    document.title = 'Reva — ' + (TITLES[id] || id);
  }
  document.addEventListener('DOMContentLoaded', boot);
})();