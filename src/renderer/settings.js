// Settings UI + live application
window.applyBrand = function () {
  const s = A.settings; const name = s.brandName || 'Reva';
  $('#brand-name').textContent = name; document.title = name;
  const lg = $('#brand-logo'); lg.innerHTML = '';
  lg.classList.toggle('ph', !A.logo); if (A.logo) lg.append(h('img', { src: A.logo })); else lg.textContent = (name[0] || 'R').toUpperCase();
  const wl = $('#welcome .wl'); if (wl) { wl.innerHTML = ''; wl.classList.toggle('ph', !A.logo); if (A.logo) wl.append(h('img', { src: A.logo })); else wl.textContent = (name[0] || 'R').toUpperCase(); }
  const wh = $('#welcome h1'); if (wh) wh.textContent = name;
};

window.applySettings = function (k) {
  const s = A.settings, r = document.documentElement;
  if (!k || k === 'theme' || k === 'accent') {
    applyTheme(s.theme, s.accent);
    if (window.monaco && monaco.editor && monaco.editor.defineTheme && window.__monacoReady) { defineMonacoThemes(monaco, s.accent); monaco.editor.setTheme('am-' + s.theme); }
    api.win.overlay({ color: getComputedStyle(r).getPropertyValue('--bg').trim(), symbolColor: getComputedStyle(r).getPropertyValue('--fg2').trim() });
    api.pop.broadcast({ ch: 'pop:theme', payload: { theme: s.theme, accent: s.accent } });
    setTimeout(() => window.PetBridge && PetBridge.apply(), 60);
  }
  if (!k || k === 'uiFont') { if (s.uiFont) r.style.setProperty('--ui-font', s.uiFont + ', "Inter Variable", system-ui, sans-serif'); else r.style.removeProperty('--ui-font'); }
  if (!k || k === 'editorFont') r.style.setProperty('--mono', (s.editorFont || DEFAULTS.editorFont) + ', monospace');
  if (!k || k === 'chatFontSize') r.style.setProperty('--chat-size', s.chatFontSize + 'px');
  if (!k || k === 'uiScale') api.win.zoom(+s.uiScale || 1);
  if (!k || k === 'animations') document.body.classList.toggle('no-anim', !s.animations);
  if (!k || k === 'showThinking') window.Chat && Chat.hideThinking && Chat.hideThinking(s.showThinking);
  if (!k || k === 'brandName') window.applyBrand && applyBrand();
  if (!k || k === 'userName') window.Bar && Bar.renderRight();
  if (!k || k === 'chatLayout') document.body.classList.toggle('chat-focus', s.chatLayout === 'focus');
  if (window.App && App.applyEditorOptions && (!k || /^(editor|ligatures|wordWrap|minimap|lineNumbers|tabSize|cursorStyle|smoothCaret|bracketColors)/.test(k))) App.applyEditorOptions();
  if (!k || k === 'chatFont') { if (s.chatFont) r.style.setProperty('--chat-font', s.chatFont); else r.style.removeProperty('--chat-font'); }
  if (k && /^(term|shell)/.test(k) && window.Terminals && Terminals.applyFont) { Terminals.applyFont(); Terminals.applyTheme && Terminals.applyTheme(); }
  window.updateStatus && updateStatus();
};

// ---------- API key dialog ----------
window.openKeyDialog = function (cat, done) {
  const inp = h('input', { class: 'inp mono', type: 'password', placeholder: 'Paste your ' + cat.label + ' key', autocomplete: 'off' });
  const show = h('button', { class: 'btn sm', onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; show.textContent = inp.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
  const m = openModal([h('div', { class: 'mh' }, cat.label + ' API key'), h('div', { class: 'mb' }, h('div', { class: 'field' }, h('label', null, cat.env.join(' · ')), h('div', { style: { display: 'flex', gap: '8px' } }, inp, show)), cat.note ? h('div', { class: 'u-note' }, cat.note) : null),
    h('div', { class: 'mf' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => { if (!inp.value.trim()) return; await api.keys.set({ id: cat.id, value: inp.value.trim() }); A.keysRev = (A.keysRev || 0) + 1; m.close(); toast(cat.label + ' key saved'); done && done(); } }, 'Save'))]);
  setTimeout(() => inp.focus(), 30);
};

// (theme editor lives in theme-editor.js)

// merge saved custom themes at startup
window.loadCustomThemes = function () { Object.assign(THEMES, A.settings.customThemes || {}); };

// ---------- custom agent dialog ----------
window.openCustomAgentDialog = function (existing, done) {
  const s = A.settings; const d = existing ? JSON.parse(JSON.stringify(existing)) : { id: '', name: '', type: 'api', protocol: 'openai', baseUrl: '', models: [], defaultModel: '', command: '', args: ['{prompt}'], promptVia: 'arg', env: {} };
  let keyValue = '';
  const f = (label, el, hint) => h('div', { class: 'field' }, h('label', null, label), el, hint ? h('div', { class: 'u-note' }, hint) : null);
  const name = h('input', { class: 'inp', placeholder: 'My model', value: d.name });
  const proto = Sel([['openai', 'OpenAI-compatible (chat completions)'], ['anthropic', 'Anthropic-compatible (messages)']], d.protocol || 'openai', null, { width: '100%', menuWidth: 340 });
  const url = h('input', { class: 'inp mono', placeholder: 'https://api.example.com/v1', value: d.baseUrl || '' });
  const key = h('input', { class: 'inp mono', type: 'password', placeholder: existing ? 'Leave empty to keep the saved key' : 'sk-…', autocomplete: 'off' });
  const models = h('textarea', { class: 'inp mono', rows: 3, placeholder: 'One model id per line' }); models.value = (d.models || []).join('\n');
  const defModel = h('input', { class: 'inp mono', placeholder: 'default model id', value: d.defaultModel || '' });
  const cmd = h('input', { class: 'inp mono', placeholder: 'gemini', value: d.command || '' });
  const args = h('input', { class: 'inp mono', placeholder: '-p {prompt}', value: (d.args || []).join(' ') });
  const via = Sel([['arg', 'As an argument ({prompt})'], ['stdin', 'Through stdin']], d.promptVia || 'arg', null, { width: '100%' });
  const env = h('textarea', { class: 'inp mono', rows: 2, placeholder: 'KEY=value (one per line)' }); env.value = Object.entries(d.env || {}).map(([k, v]) => k + '=' + v).join('\n');
  const status = h('div', { class: 'u-note' });
  const apiBox = h('div', null, f('Protocol', proto), f('Base URL', url, 'Include the version path, e.g. …/v1'), f('API key', key, 'Stored encrypted on this computer, never written in plain text'),
    f('Models', models), h('div', { style: { display: 'flex', gap: '8px', margin: '-4px 0 8px' } }, h('button', { class: 'btn sm', onclick: async (e) => { e.target.textContent = 'Fetching…'; const list = await api.custom.models({ def: collect(), apiKey: key.value, id: d.id }); e.target.textContent = 'Fetch from API'; if (list && list.length) { models.value = list.map((m) => m.id).join('\n'); if (!defModel.value) defModel.value = list[0].id; toast(list.length + ' models found'); } else toast('Could not list models — enter them manually', true); } }, 'Fetch from API'),
      h('button', { class: 'btn sm', onclick: async (e) => { e.target.textContent = 'Testing…'; const r = await api.custom.test({ def: collect(), apiKey: key.value, id: d.id }); e.target.textContent = 'Test connection'; status.textContent = r.ok ? 'Connected · ' + r.ms + ' ms' + (r.models ? ' · ' + r.models.length + ' models' : '') : 'Failed: ' + r.error; status.style.color = r.ok ? 'var(--fg2)' : 'var(--bad)'; } }, 'Test connection'), status), f('Default model', defModel));
  const cliBox = h('div', null, f('Command', cmd, 'Any executable on your PATH (or a full path)'), f('Arguments', args, 'Use {prompt} where the message goes, and {history} for earlier turns'), f('Send message', via), f('Environment', env));
  const seg = h('div', { class: 'seg' }, ['api', 'cli'].map((t) => h('button', { class: d.type === t ? 'on' : '', onclick: () => setType(t) }, t === 'api' ? 'API' : 'Command')));
  const setType = (t) => { d.type = t; seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', ['api', 'cli'][i] === t)); apiBox.classList.toggle('hidden', t !== 'api'); cliBox.classList.toggle('hidden', t !== 'cli'); };
  const collect = () => {
    const kv = Object.fromEntries(env.value.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1)]; }));
    return { id: d.id, name: name.value.trim(), type: d.type, protocol: proto.value, baseUrl: url.value.trim().replace(/\/+$/, ''), models: models.value.split('\n').map((x) => x.trim()).filter(Boolean), defaultModel: defModel.value.trim(),
      command: cmd.value.trim(), args: (args.value.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, '')), promptVia: via.value, env: kv };
  };
  const m = openModal([h('div', { class: 'mh' }, existing ? 'Edit custom agent' : 'Add custom agent'),
    h('div', { class: 'mb' }, f('Name', name), h('div', { class: 'field' }, h('label', null, 'Type'), seg), apiBox, cliBox),
    h('div', { class: 'mf' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
      const def = collect(); if (!def.name) return toast('Give the agent a name', true);
      if (def.type === 'api' && !def.baseUrl) return toast('Base URL is required', true);
      if (def.type === 'api' && !def.models.length && !def.defaultModel) return toast('Add at least one model id', true);
      if (def.type === 'cli' && !def.command) return toast('Command is required', true);
      def.id = def.id || def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-3);
      if (def.type === 'api' && def.defaultModel && !def.models.includes(def.defaultModel)) def.models.unshift(def.defaultModel);
      if (key.value.trim()) await api.keys.set({ id: 'agent:' + def.id, value: key.value.trim() });
      const list = s.customAgents = s.customAgents || []; const i = list.findIndex((x) => x.id === def.id); if (i >= 0) list[i] = def; else list.push(def);
      saveSettings(); Prov.refreshCustom(); Bar.render(); m.close(); toast('Saved ' + def.name); done && done();
      if (!existing) Chat.new({ provider: 'custom:' + def.id });
    } }, 'Save'))], { cls: 'wide' });
  setType(d.type);
};
