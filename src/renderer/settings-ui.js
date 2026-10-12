// Settings window
window.openSettings = function (section) {
  const s = A.settings;
  s.agentCfg = s.agentCfg || {}; s.voice = s.voice || {};
  let cur = section === 'providers' || section === 'account' ? 'agents' : section || 'general';
  const body = h('div', { class: 'body selectable' });
  const nav = h('div', { class: 'nav' });
  const SECTIONS = [['general', 'Profile', 'user'], ['appearance', 'Appearance', 'palette'], ['typography', 'Fonts & text', 'edit'], ['agents', 'Agents', 'agent'], ['pet', 'Pet & PC control', 'sparkle'], ['plugins', 'Plugins', 'plug'], ['keys', 'API keys & env', 'key'], ['chat', 'Chat', 'chat'], ['voice', 'Voice & media', 'mic'], ['editor', 'Editor', 'code'], ['terminal', 'Terminal', 'term'], ['shortcuts', 'Shortcuts', 'keyboard'], ['about', 'About', 'info']];

  const row = (label, desc, ...ctl) => h('div', { class: 'row' }, h('div', { class: 'rl' }, h('b', null, label), desc ? h('span', null, desc) : null), h('div', { class: 'rc' }, ctl));
  const group = (title) => h('h5', null, title);
  const sw = (obj, key, after) => { const i = h('input', { type: 'checkbox', class: 'sw', onchange: () => { obj[key] = i.checked; saveSettings(); after ? after(i.checked) : applySettings(key); } }); i.checked = !!obj[key]; return i; };
  const sel = (obj, key, opts, after) => Sel(opts, obj[key], (v) => { obj[key] = v; saveSettings(); after ? after(v) : applySettings(key); });
  const stp = (obj, key, cfg, after) => Stepper({ value: obj[key] ?? 0, ...cfg }, (v) => { obj[key] = v; saveSettings(); after ? after(v) : applySettings(key); });
  const txt = (obj, key, ph, w) => { const el = h('input', { class: 'inp', placeholder: ph || '', style: w ? { width: w } : null, onchange: () => { obj[key] = el.value; saveSettings(); applySettings(key); } }); el.value = obj[key] || ''; return el; };
  const area = (get, set, ph, rows = 3, w = '280px') => { const el = h('textarea', { class: 'inp', rows, placeholder: ph, style: { width: w }, onchange: () => set(el.value) }); el.value = get(); return el; };
  const lead = (t) => h('p', { class: 'lead' }, t);

  const views = {
    // ---------------------------------------------------------------- profile
    general() {
      return [h('h3', null, 'Profile'), lead('How you appear inside the app. Your email address is never shown anywhere.'),
        row('Display name', 'Shown in the title bar and the greeting', txt(s, 'userName', 'Dev')), group('Branding'), row('App name', null, txt(s, 'brandName', 'Reva'))];
    },
    // ---------------------------------------------------------------- appearance
    appearance() {
      const grid = h('div', { class: 'themes' });
      const draw = () => {
        grid.innerHTML = '';
        Object.entries(THEMES).forEach(([id, th]) => {
          const v = th.v; const custom = !!(s.customThemes && s.customThemes[id]);
          grid.append(h('div', { class: 'theme-card' + (s.theme === id ? ' on' : ''), onclick: () => { setSetting('theme', id); draw(); } },
            h('div', { class: 'pv', style: { background: v.bg } }, h('div', { class: 'a', style: { background: v.bg1 } }), h('div', { class: 'b' },
              h('i', { style: { width: '70%', background: v.accent } }), h('i', { style: { width: '90%', background: v.fg3, opacity: .5 } }), h('i', { style: { width: '55%', background: v.accent2 } }), h('i', { style: { width: '80%', background: v.fg3, opacity: .35 } }))),
            h('div', { class: 'tn' }, h('span', null, th.name), custom ? h('span', { class: 'tact' },
              h('button', { class: 'icon-btn sm', title: 'Edit', html: icon('edit'), onclick: (e) => { e.stopPropagation(); openThemeEditor(id, draw); } }),
              h('button', { class: 'icon-btn sm', title: 'Delete', html: icon('trash'), onclick: async (e) => { e.stopPropagation(); if (!(await confirmBox('Delete theme', `Delete “${th.name}”?`, 'Delete', true))) return; delete s.customThemes[id]; delete THEMES[id]; if (s.theme === id) setSetting('theme', 'amethyst'); saveSettings(); draw(); } })) : null)));
        });
        grid.append(h('div', { class: 'theme-card new', onclick: () => openThemeEditor(null, draw) }, h('span', { html: icon('plus') }), h('b', null, 'Create theme'), h('small', null, 'Pick your own colors')),
          h('div', { class: 'theme-card new', onclick: async () => { const j = await promptBox('Import theme', '', 'Paste theme JSON'); if (!j) return; try { const t = JSON.parse(j); if (!t.v || !t.name) throw 0; const id = 'c-' + Date.now().toString(36); t.t = t.t || THEMES.amethyst.t; (s.customThemes = s.customThemes || {})[id] = t; THEMES[id] = t; setSetting('theme', id); saveSettings(); draw(); } catch { toast('That is not a valid theme', true); } } }, h('span', { html: icon('download') }), h('b', null, 'Import'), h('small', null, 'From JSON')));
      };
      draw();
      const acc = ColorPicker.swatch(s.accent || THEMES[s.theme].v.accent, (v) => setSetting('accent', v), { title: 'Accent color' });
      const zoom = h('input', { type: 'range', min: .8, max: 1.5, step: .05, value: s.uiScale, onchange: () => setSetting('uiScale', +zoom.value) });
      return [h('h3', null, 'Appearance'), group('Theme'), grid, group('Interface'),
        row('Accent color', 'Selections and highlights', acc, h('button', { class: 'btn sm', onclick: () => { setSetting('accent', ''); acc.set(THEMES[s.theme].v.accent); } }, 'Reset')),
        row('Chat layout', 'Focus hides the editor and gives the chat the whole window, with your chat list on the side', sel(s, 'chatLayout', [['side', 'Side panel'], ['focus', 'Focus']], (v) => { setSetting('chatLayout', v); App.syncLayout && App.syncLayout(); })),
        row('Interface zoom', 'Scales the whole window', zoom),
        row('Animations', 'Turn off for a snappier feel', sw(s, 'animations'))];
    },
    // ---------------------------------------------------------------- typography
    typography() {
      const sample = (getFont, getSize, getLh, text) => { const p = h('div', { class: 'tprev' }, text); const up = () => { p.style.fontFamily = getFont(); p.style.fontSize = getSize() + 'px'; if (getLh) p.style.lineHeight = getLh(); }; up(); p.update = up; return p; };
      const prevs = [];
      const fp = (key, o) => FontPicker(key, { ...o, onChange: () => prevs.forEach((p) => p.update()) });
      const stpU = (obj, key, cfg) => stp(obj, key, cfg, (v) => { applySettings(key); prevs.forEach((p) => p.update()); });
      const pUI = sample(() => s.uiFont || 'var(--ui-font)', () => 14, null, 'The quick brown fox jumps over the lazy dog — 0123456789');
      const pChat = sample(() => s.chatFont || 'var(--ui-font)', () => s.chatFontSize, () => 1.55, 'Here is how a reply looks in the chat. Fonts, size and spacing update as you change them.');
      const pCode = sample(() => s.editorFont, () => s.editorSize, () => (s.editorLineHeight ? s.editorLineHeight + 'px' : 1.5), 'const greet = (name) => `Hello, ${name}!`;  // => 0O 1lI');
      const pTerm = sample(() => s.termFont, () => s.termSize, () => 1.2, 'PS C:\\Users\\you> Get-ChildItem | Sort-Object Length');
      prevs.push(pUI, pChat, pCode, pTerm);
      return [h('h3', null, 'Fonts & text'), lead('Every font installed on this computer is available. Use “Install a font…” to add your own — it is installed for your Windows account and works here immediately.'),
        h('div', { style: { margin: '-6px 0 14px' } }, h('button', { class: 'btn sm', onclick: async () => { const files = await api.dialog.fonts(); if (!files.length) return; const done = await Fonts.installFiles(files); if (done.length) toast('Installed ' + done.join(', ')); } }, 'Install a font…')),
        group('Interface'), row('Font', null, fp('uiFont', { def: '' })), pUI,
        group('Chat'), row('Font', null, fp('chatFont', { def: '' })), row('Size', null, stpU(s, 'chatFontSize', { min: 11, max: 22, step: .5, unit: 'px' })), pChat,
        group('Editor'), row('Font', null, fp('editorFont', { mono: true, def: DEFAULTS.editorFont })), row('Size', null, stpU(s, 'editorSize', { min: 9, max: 32, step: 1, unit: 'px' })), row('Line height', '0 = automatic', stpU(s, 'editorLineHeight', { min: 0, max: 60, step: 1, unit: 'px' })), row('Ligatures', 'Combine characters like => and !=', sw(s, 'ligatures')), pCode,
        group('Terminal'), row('Font', null, fp('termFont', { mono: true, def: DEFAULTS.termFont })), row('Size', null, stpU(s, 'termSize', { min: 9, max: 28, step: 1, unit: 'px' })), pTerm];
    },
    // ---------------------------------------------------------------- agents
    agents() {
      const wrap = h('div'); const open = (views.agents._open = views.agents._open || {});
      const draw = () => {
        wrap.innerHTML = '';
        BUILTIN_IDS.forEach((id) => {
          const P = PROV[id]; const st = Prov.status(id); const pd = (A.det && A.det.providers && A.det.providers[id]) || {};
          const info = A.info[id] || {}; const plan = (A.usage[id] && A.usage[id].plan) || (info.account && info.account.planType);
          const cfg = (s.agentCfg[id] = s.agentCfg[id] || {}); const d = (s.defaults[id] = s.defaults[id] || {});
          const card = h('div', { class: 'prov-card' });
          card.append(h('div', { class: 'ph' }, h('span', { class: 'lg', html: P.logo }), h('div', { class: 'pi' }, h('b', null, P.name), h('span', null, P.sub + (pd.version ? ' · ' + String(pd.version).slice(0, 24) : ''))),
            st.state === 'ready' ? h('span', { class: 'badge ok' }, h('span', { class: 'bk', html: icon('check') }), 'Connected') : h('span', { class: 'badge warn' }, st.label),
            st.state === 'ready' && plan ? h('span', { class: 'badge plan' }, String(plan).replace(/^./, (c) => c.toUpperCase())) : null,
            st.state === 'missing' ? h('button', { class: 'btn sm primary', onclick: async () => { await Setup.install(id); await Setup.recheck(); draw(); } }, 'Install') : null,
            st.state === 'login' ? h('button', { class: 'btn sm primary', onclick: async () => { await Setup.login(id); await Setup.recheck(); draw(); } }, 'Sign in') : null,
            st.state === 'ready' && id !== 'opencode' ? h('button', { class: 'btn sm', onclick: async () => { await api.providers.logout({ provider: id, custom: customPath(id) }); await Setup.recheck(); draw(); } }, 'Sign out') : null,
            st.state === 'ready' && id === 'opencode' ? h('button', { class: 'btn sm', onclick: () => Setup.login(id) }, 'Add provider') : null,
            h('button', { class: 'btn sm', onclick: () => { open[id] = !open[id]; draw(); } }, open[id] ? 'Hide settings' : 'Settings')));
          if (st.state !== 'ready') card.append(h('div', { style: { marginTop: '10px' } }, ...Setup.reqs(id).map((r) => h('div', { class: 'req ' + (r.ok ? 'ok' : 'bad') }, h('span', { class: 'rk', html: icon(r.ok ? 'checkCircle' : 'circle') }), h('div', { class: 'rt' }, h('b', null, r.title), h('span', null, r.sub)), r.ok ? null : h('button', { class: 'btn sm', disabled: !!r.disabled, onclick: async () => { await r.run(); await Setup.recheck(); draw(); } }, r.action)))));
          if (open[id]) {
            const models = Sel(P.models(), d.model || '', (v) => { d.model = v; saveSettings(); effort.setItems(P.efforts(d.model)); }, { search: true, menuWidth: 300 });
            const effort = Sel(P.efforts(d.model), d.effort || '', (v) => { d.effort = v; saveSettings(); });
            const perms = Sel(P.modes(), d.mode, (v) => { d.mode = v; saveSettings(); }, { menuWidth: 280 });
            const bin = h('input', { class: 'inp', placeholder: 'auto-detect', style: { width: '260px' }, onchange: async () => { setSetting(P.pathKey, bin.value); await Setup.recheck(); draw(); } }); bin.value = s[P.pathKey] || '';
            card.append(h('div', { class: 'pbody' },
              row('Default model', 'For new chats', models), row('Default effort', null, effort), row('Default permissions', null, perms),
              row('Instructions', id === 'claude' ? 'Appended to Claude’s system prompt' : 'Prepended to the first message of every new chat', area(() => cfg.instructions || '', (v) => { cfg.instructions = v; saveSettings(); }, 'e.g. Always answer in Romanian. Prefer small, focused diffs.', 3)),
              id !== 'opencode' ? row('Extra directories', id === 'claude' ? 'Folders Claude may access (--add-dir), one per line' : 'Extra writable folders for the Codex sandbox, one per line', area(() => (cfg.dirs || []).join('\n'), (v) => { cfg.dirs = v.split('\n').map((x) => x.trim()).filter(Boolean); saveSettings(); }, 'C:\\path\\to\\folder', 2)) : null,
              row(id === 'codex' ? 'Config overrides' : 'Extra CLI flags', id === 'codex' ? 'One `key=value` per line, passed as -c (e.g. model_verbosity="high")' : 'Appended to every launch, e.g. --max-turns 20', area(() => cfg.flags || '', (v) => { cfg.flags = v; saveSettings(); }, id === 'codex' ? 'model_verbosity="high"' : '--flag value', 2)),
              row('Binary path', 'Leave empty to auto-detect', bin)));
          }
          wrap.append(card);
        });
        wrap.append(group('Custom agents'));
        const customs = s.customAgents || [];
        if (!customs.length) wrap.append(h('p', { class: 'lead', style: { marginTop: 0 } }, 'Connect any OpenAI- or Anthropic-compatible API with your own key (it gets a full coding agent with file and shell tools), or wrap any command-line tool.'));
        customs.forEach((dd) => {
          const cfg = (s.agentCfg['custom:' + dd.id] = s.agentCfg['custom:' + dd.id] || {}); const key = 'custom:' + dd.id;
          const card = h('div', { class: 'prov-card' });
          card.append(h('div', { class: 'ph' }, h('span', { class: 'lg', html: monoLogo((dd.name || '?')[0].toUpperCase(), dd.color) }), h('div', { class: 'pi' }, h('b', null, dd.name), h('span', null, dd.type === 'api' ? (dd.baseUrl || '') + ' · ' + (dd.models || []).length + ' models' : dd.command + ' ' + (dd.args || []).join(' '))),
            h('button', { class: 'btn sm', onclick: () => { open[key] = !open[key]; draw(); } }, open[key] ? 'Hide settings' : 'Settings'),
            h('button', { class: 'btn sm', onclick: () => openCustomAgentDialog(dd, draw) }, 'Edit'),
            h('button', { class: 'btn sm danger', onclick: async () => { if (!(await confirmBox('Delete agent', `Delete “${dd.name}”? Its API key is removed too.`, 'Delete', true))) return; s.customAgents = customs.filter((x) => x.id !== dd.id); await api.keys.set({ id: 'agent:' + dd.id, value: '' }); saveSettings(); Prov.refreshCustom(); Bar.render(); draw(); } }, 'Delete')));
          if (open[key]) card.append(h('div', { class: 'pbody' }, row('Instructions', 'Prepended to the first message of every new chat', area(() => cfg.instructions || '', (v) => { cfg.instructions = v; saveSettings(); }, 'Standing instructions for this agent', 3))));
          wrap.append(card);
        });
        wrap.append(h('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } }, h('button', { class: 'btn', onclick: () => openCustomAgentDialog(null, draw) }, 'Add custom agent…'), h('button', { class: 'btn', onclick: async (e) => { e.target.textContent = 'Checking…'; await Setup.recheck(); draw(); } }, 'Re-check agents')));
      };
      draw();
      return [h('h3', null, 'Agents'), lead('Each agent is the official CLI running on your computer with your own login. Settings here are per agent.'), wrap];
    },
    // ---------------------------------------------------------------- keys
    keys() {
      const wrap = h('div'); const envBox = h('div'); s.envVars = s.envVars || []; s.keyUse = s.keyUse || {};
      const draw = async () => {
        const [cat, have] = await Promise.all([api.keys.catalog(), api.keys.list()]);
        wrap.innerHTML = '';
        cat.forEach((c) => {
          const use = s.keyUse[c.id] || c.defaults; const set = !!have[c.id];
          wrap.append(h('div', { class: 'row' },
            h('div', { class: 'rl' }, h('b', null, c.label), h('span', null, set ? have[c.id] + (c.note && use.includes('claude') ? ' — ' + c.note : '') : c.env.join(' / '))),
            h('div', { class: 'rc' },
              set ? c.agents.map((a) => h('label', { class: 'usechk', title: 'Use this key for ' + PROV[a].name }, (() => { const i = h('input', { type: 'checkbox', checked: use.includes(a), onchange: () => { const cu = new Set(s.keyUse[c.id] || c.defaults); i.checked ? cu.add(a) : cu.delete(a); s.keyUse[c.id] = [...cu]; saveSettings(); A.keysRev = (A.keysRev || 0) + 1; draw(); } }); return i; })(), PROV[a].name)) : null,
              h('button', { class: 'btn sm', onclick: () => openKeyDialog(c, draw) }, set ? 'Change' : 'Add key'),
              set && c.id === 'openai' ? h('button', { class: 'btn sm', title: 'Replaces the ChatGPT login in Codex with this API key', onclick: async () => { const r = await api.providers.codexKey(); toast(r.ok ? 'Codex now uses your OpenAI API key' : (r.out || 'Failed'), !r.ok); } }, 'Use for Codex login') : null,
              set ? h('button', { class: 'btn sm danger', onclick: async () => { await api.keys.set({ id: c.id, value: '' }); A.keysRev = (A.keysRev || 0) + 1; draw(); } }, 'Remove') : null)));
        });
      };
      const drawEnv = () => {
        envBox.innerHTML = '';
        s.envVars.forEach((ev, i) => envBox.append(h('div', { class: 'row' }, h('div', { class: 'rl', style: { flex: 1 } }, h('input', { class: 'inp mono', placeholder: 'NAME', value: ev.k, onchange: (e) => { ev.k = e.target.value.trim(); saveSettings(); } })),
          h('div', { class: 'rc', style: { flex: 2 } }, h('input', { class: 'inp mono', style: { width: '100%' }, placeholder: 'value', value: ev.v, onchange: (e) => { ev.v = e.target.value; saveSettings(); A.keysRev = (A.keysRev || 0) + 1; } }), h('button', { class: 'icon-btn', html: icon('x'), onclick: () => { s.envVars.splice(i, 1); saveSettings(); drawEnv(); } })))));
        envBox.append(h('button', { class: 'btn sm', style: { marginTop: '10px' }, onclick: () => { s.envVars.push({ k: '', v: '' }); drawEnv(); } }, 'Add variable'));
      };
      draw(); drawEnv();
      return [h('h3', null, 'API keys & environment'), lead('Keys are encrypted with Windows DPAPI and only passed to the agents you tick. They apply to new chats. OpenCode can use any provider you add; Claude and Codex keep using your subscription unless you enable a key for them.'), wrap, group('Environment variables (all agents)'), envBox];
    },
    // ---------------------------------------------------------------- chat
    chat() {
      return [h('h3', null, 'Chat'), row('IDE tools for agents', 'Agents can open the preview, take screenshots, read the page console, open files and use the terminal themselves. Applies to new chats.', sw(s, 'ideTools', () => { A.keysRev = (A.keysRev || 0) + 1; })), row('Share the open file with the agent', 'The file open in the editor (and your selection) is sent along with each message so the agent always knows what you are looking at', sw(s, 'shareOpenFile')), row('Show reasoning', 'Display the model’s reasoning blocks when it shares them', sw(s, 'showThinking')), row('Expand tool cards', 'Show tool input and output by default', sw(s, 'expandTools')), row('Desktop notifications', 'When an agent finishes or needs approval while the window is in the background', sw(s, 'notify', () => { })), row('Recall last message', 'Press ↑ in an empty message box', h('span', { class: 'kbd' }, '↑'))];
    },
    // ---------------------------------------------------------------- voice
    voice() {
      const v = s.voice; const wrap = h('div');
      const draw = async () => {
        const st = await api.voice.status(); wrap.innerHTML = '';
        ['tiny', 'base', 'small', 'large-turbo'].forEach((m) => {
          const has = st.downloaded && st.downloaded[m];
          wrap.append(row('Whisper ' + m, { tiny: '~40 MB · fastest, English only really', base: '~75 MB · decent for English', small: '~250 MB · recommended — accurate in Romanian and most languages', 'large-turbo': '~730 MB · best quality, slower on CPU' }[m],
            has ? h('span', { class: 'badge' }, [h('span', { html: icon('check') }), 'Downloaded']) : h('button', { class: 'btn sm', onclick: async (e) => { e.target.textContent = 'Downloading…'; e.target.disabled = true; const off = api.on('voice:progress', (p) => { if (p.phase === 'download') e.target.textContent = Math.round(p.pct || 0) + '%'; }); const r = await api.voice.ensure(m); off(); if (!r.ok) toast(r.error, true); draw(); } }, 'Download')));
        });
      };
      draw();
      const micSel = Sel([['default', 'System default']], v.deviceId || 'default', (id) => { v.deviceId = id; saveSettings(); }, { menuWidth: 300 });
      Media.devices().then((ds) => micSel.setItems([['default', 'System default'], ...ds.filter((d) => d.id !== 'default').map((d) => [d.id, d.label])]));
      const bar = h('div', { class: 'lvl' }, h('i'));
      const test = h('button', { class: 'btn sm', onclick: async () => { test.disabled = true; test.textContent = 'Listening…'; try { await Media.meter(micSel.value, (l) => (bar.firstChild.style.width = Math.round(l * 100) + '%'), 6000); setTimeout(() => { test.disabled = false; test.textContent = 'Test'; }, 6200); } catch (e) { toast('Microphone error: ' + e.message, true); test.disabled = false; test.textContent = 'Test'; } } }, 'Test');
      return [h('h3', null, 'Voice & media'), lead('Voice messages, audio and video are transcribed on this computer with Whisper — nothing is uploaded. Click the microphone to dictate: you see the words appear live while you speak.'),
        row('Microphone', 'Input device for voice messages', micSel, bar, test),
        row('Model', 'Small or larger is needed for non-English speech', sel(v, 'model', [['tiny', 'Tiny'], ['base', 'Base'], ['small', 'Small (recommended)'], ['large-turbo', 'Large turbo']])),
        row('Language', 'Pin a language, or let it detect. Right-click the mic to change it quickly.', sel(v, 'language', VOICE_LANGS, null), null),
        row('Live transcript', 'Show the text while you are still speaking', sw(v, 'live')),
        row('Send automatically when you stop', 'Off: the text lands in the message box so you can fix it first', sw(v, 'autoSend')),
        row('Video frames', 'Evenly spaced frames sent as images together with the transcript', stp(v, 'frames', { min: 2, max: 16, step: 1 })),
        group('Models'), wrap];
    },
    // ---------------------------------------------------------------- editor
    editor() {
      return [h('h3', null, 'Editor'), lead('Fonts live under “Fonts & text”.'),
        row('Word wrap', null, sel(s, 'wordWrap', [['off', 'Off'], ['on', 'On'], ['bounded', 'Bounded']])), row('Minimap', null, sw(s, 'minimap')),
        row('Line numbers', null, sel(s, 'lineNumbers', [['on', 'On'], ['off', 'Off'], ['relative', 'Relative']])), row('Tab size', null, stp(s, 'tabSize', { min: 1, max: 8, step: 1 })),
        row('Cursor style', null, sel(s, 'cursorStyle', [['line', 'Line'], ['block', 'Block'], ['underline', 'Underline'], ['line-thin', 'Thin line']])), row('Smooth caret animation', null, sw(s, 'smoothCaret')), row('Bracket pair colors', null, sw(s, 'bracketColors')),
        row('Auto save', 'Files edited by an agent always reload automatically', sel(s, 'autoSave', [['off', 'Off'], ['afterDelay', 'After delay'], ['onFocusChange', 'On focus change']]))];
    },
    // ---------------------------------------------------------------- terminal
    terminal() {
      const shellSel = Sel([['powershell', 'Windows PowerShell']], s.shell || 'powershell', (v) => { s.shell = v; saveSettings(); }, { menuWidth: 280 });
      if (api.pty && api.pty.shells) api.pty.shells().then((l) => shellSel.setItems(l.map((x) => [x.id, x.label])));
      return [h('h3', null, 'Terminal'), lead('A real terminal: your own prompt, profile, colors and tab completion — just like opening PowerShell or cmd.'),
        row('Default shell', 'Used for new terminal tabs', shellSel),
        row('Color scheme', 'Follow the app theme, or pick a ready-made scheme', Sel([['', 'Match app theme'], ...(window.Terminals ? Terminals.themeList() : [])], s.termTheme || '', (v) => { s.termTheme = v; saveSettings(); applySettings('termTheme'); }, { menuWidth: 240 })),
        row('GPU rendering', 'Faster on some machines, but can crash the graphics process on others. Applies to new tabs.', sw(s, 'termGpu', () => { })),
        row('Cursor', null, sel(s, 'termCursor', [['bar', 'Bar'], ['block', 'Block'], ['underline', 'Underline']])),
        row('Font & size', 'Under “Fonts & text”', h('button', { class: 'btn sm', onclick: () => show('typography') }, 'Open'))];
    },
    // ---------------------------------------------------------------- desktop pet + PC control
    pet() {
      const P = (s.pet = { ...DEFAULTS.pet, ...(s.pet || {}) });
      const setP = (k, v) => { P[k] = v; saveSettings(); window.PetBridge && PetBridge.apply(); };
      const swP = (key) => { const i = h('input', { type: 'checkbox', class: 'sw', onchange: () => setP(key, i.checked) }); i.checked = !!P[key]; return i; };
      const grid = h('div', { class: 'pet-grid' });
      const draw = async () => {
        grid.innerHTML = ''; let list = []; try { list = await api.pet.list(); } catch { }
        list.forEach((p) => {
          const th = h('div', { class: 'pet-th' + (p.pixel ? ' pixel' : ''), style: { backgroundImage: 'url("' + p.sheet + '")', backgroundSize: p.kind === 'image' ? 'contain' : '800% auto', backgroundPosition: p.kind === 'image' ? 'center' : '0 0' } });
          grid.append(h('div', { class: 'pet-card' + (P.id === p.id ? ' on' : ''), title: p.description || p.name, onclick: () => { setP('id', p.id); draw(); } }, th, h('b', null, p.name),
            !p.builtin ? h('button', { class: 'icon-btn sm pet-x', title: 'Remove this pet', html: icon('trash'), onclick: async (e) => { e.stopPropagation(); if (!(await confirmBox('Remove pet', `Remove “${p.name}”?`, 'Remove', true))) return; await api.pet.remove(p.id); if (P.id === p.id) setP('id', 'reva'); draw(); } }) : null));
        });
      };
      draw(); setTimeout(draw, 700);
      const scale = h('input', { type: 'range', min: .4, max: 1.5, step: .05, value: P.scale, onchange: () => setP('scale', +scale.value) });
      const imp = async (fn) => { const r = await (fn === 'dir' ? api.pet.importFolder() : api.pet.import()); if (r && r.ok) { toast('Pet added'); setP('id', r.id); draw(); } else if (r && !r.canceled) toast(r.error || 'Could not import that pet', true); };
      return [h('h3', null, 'Pet & PC control'), lead('A little companion that lives on your desktop: it roams around, speaks up when your agents finish or need you, and opens a prompt bar when you click it.'),
        row('Show the desktop pet', 'Click it to talk to your AI without opening the IDE', swP('enabled')),
        row('Keep running in the tray', 'Closing the window hides Reva instead of quitting, so the pet and your agents keep working. Quit from the tray icon.', swP('keepRunning')),
        row('Walk around the screen', null, swP('wander')), row('Speech bubbles', 'Done / needs approval / errors', swP('bubbles')), row('Random tips', '“If you need help, just let me know…”', swP('quips')), row('Size', null, scale),
        group('Choose a pet'), grid,
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '10px 0 4px' } },
          h('button', { class: 'btn sm', onclick: () => imp('file') }, 'Import pet…'), h('button', { class: 'btn sm', onclick: () => imp('dir') }, 'Import folder…'), h('button', { class: 'btn sm', onclick: () => api.pet.folder() }, 'Open pets folder'),
          h('button', { class: 'btn sm', onclick: () => window.open('https://codex-pets.net/') }, 'Get more pets ↗')),
        h('p', { class: 'u-note' }, 'Pets use the Codex pet format (.codex-pet.zip with pet.json + a spritesheet) — download one from codex-pets.net and import it here. You can also import a single PNG/WebP picture; it becomes a pet that bobs and hops. Format details: docs/PETS.md.'),
        group('AI control of this PC'),
        row('Let agents use my PC', 'Agents can list windows, read and operate the controls of Windows apps (no screenshots) to test what they build. Reva always asks you first: once, or for the whole session. Preview-page testing inside Reva needs no permission.', Sel([['ask', 'Ask me first (recommended)'], ['off', 'Never']], s.pcControl || 'ask', (v) => { s.pcControl = v; saveSettings(); }, { menuWidth: 240 })),
        row('Current access', 'Revoke anything you allowed for this session', h('button', { class: 'btn sm', onclick: async () => { await api.pet.revoke(); toast('PC access revoked'); } }, 'Revoke now'))];
    },
    plugins: () => (window.RevaPlugins ? RevaPlugins.settingsView() : [h('h3', null, 'Plugins'), h('p', { class: 'lead' }, 'The plugin system is not available.')]),
    shortcuts() {
      const wrap = h('div'); const FIXED = [['Esc', 'Interrupt agent / cancel recording'], ['↑ in empty input', 'Recall last message'], ['Ctrl+Shift+L', 'Add selection to chat (editor)'], ['F12', 'Developer tools'], ['Ctrl+F5', 'Reload window']];
      const draw = () => {
        wrap.innerHTML = '';
        wrap.append(h('h3', null, 'Keyboard shortcuts'), lead('Click a shortcut, then press the keys you want. Backspace clears it, Esc cancels.'),
          h('div', { style: { margin: '-6px 0 10px' } }, h('button', { class: 'btn sm', onclick: () => { Keys.resetAll(); draw(); toast('Shortcuts reset'); } }, 'Reset all')));
        Keys.defs.forEach((d) => {
          const cur = Keys.get(d.id); const changed = cur !== d.def;
          const btn = h('button', { class: 'kbd-btn' + (cur ? '' : ' empty'), title: 'Click to change' }, cur || 'None');
          btn.onclick = async () => {
            btn.textContent = 'Press keys…'; btn.classList.add('rec'); document.body.classList.add('capturing-key');
            const c = await Keys.capture(); document.body.classList.remove('capturing-key');
            if (c !== null) { const st = Keys.set(d.id, c); if (st) toast('“' + c + '” moved here from ' + st.label); }
            draw();
          };
          wrap.append(row(d.label, null, btn, h('button', { class: 'icon-btn sm', title: 'Reset to ' + d.def, style: { visibility: changed ? 'visible' : 'hidden' }, html: icon('rotate'), onclick: () => { Keys.reset(d.id); draw(); } })));
        });
        wrap.append(group('Fixed'), ...FIXED.map(([k, n]) => row(n, null, h('span', { class: 'kbd' }, k))));
      };
      draw(); return [wrap];
    },    // ---------------------------------------------------------------- about
    about() {
      const ua = navigator.userAgent; const ver = (re) => (ua.match(re) || [])[1] || '';
      const agents = h('div');
      BUILTIN_IDS.forEach((id) => { const pd = (A.det && A.det.providers && A.det.providers[id]) || {}; agents.append(row(PROV[id].name, PROV[id].sub, h('span', { class: 'mono', style: { color: 'var(--fg2)' } }, pd.installed ? String(pd.version || 'installed').slice(0, 28) : 'not installed'))); });
      return [h('h3', null, 'About'),
        h('div', { class: 'about' }, h('span', { class: 'lg-prev big' }, A.logo ? h('img', { src: A.logo }) : ((s.brandName || 'R')[0])),
          h('div', null, h('b', null, (s.brandName || 'Reva') + ' 0.9'), h('p', null, 'A desktop IDE built around command-line coding agents. Chat with Claude Code, Codex, OpenCode or your own model, edit code, run a real terminal and preview your site — in one window.'))),
        group('What’s inside'),
        h('div', { class: 'chips-about' }, ['Claude · Codex · OpenCode', 'Custom API & command agents', 'Live usage limits', 'Local voice transcription', 'Image, audio & video input', 'Undo, retry & file review', 'Sub-agents panel', 'Desktop pet', 'PC control for agents', 'Preview testing tools', 'Plugins & agent tools', 'Real terminal', 'Browser preview', 'Monaco editor', 'Custom themes & fonts'].map((x) => h('span', { class: 'badge' }, x))),
        group('Connected agents'), agents,
        group('Runtime'), row('Electron / Chromium', null, h('span', { class: 'mono', style: { color: 'var(--fg2)' } }, `${ver(/Electron\/([\d.]+)/)} / ${ver(/Chrome\/([\d.]+)/)}`)),
        row('Settings file', 'Stored in your user data folder', h('button', { class: 'btn sm', onclick: () => api.settings.reveal() }, 'Reveal')),
        row('Reset all settings', null, h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Reset settings', 'Restore every setting to its default?', 'Reset', true)) { A.settings = JSON.parse(JSON.stringify(DEFAULTS)); await api.settings.set(A.settings); location.reload(); } } }, 'Reset'))];
    },
  };
  const show = (id) => {
    cur = id; nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    body.innerHTML = ''; body.scrollTop = 0; body.append(...[views[id]()].flat(2).filter(Boolean));
  };
  nav.append(h('h4', null, 'Settings'), ...SECTIONS.map(([id, l, ic]) => h('button', { 'data-id': id, onclick: () => show(id) }, h('span', { class: 'ni', html: icon(ic) }), l)));
  openModal([nav, body], { cls: 'settings' });
  show(views[cur] ? cur : 'general');
};
