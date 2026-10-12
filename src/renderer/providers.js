// Provider registry (Claude / Codex / OpenCode), title-bar combos, usage, setup/install flow
(function () {
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const EFFORT_LABEL = { '': ['Default', 'Model default'], minimal: ['Minimal', 'Almost no reasoning'], low: ['Low', 'Fast, light reasoning'], medium: ['Medium', 'Balanced speed and depth'], high: ['High', 'Deeper reasoning'], xhigh: ['Extra high', 'Very deep reasoning'], max: ['Max', 'Maximum reasoning'], ultra: ['Ultra', 'Max reasoning + task delegation'] };
  const effortItems = (ids) => ids.map((id) => ({ value: id, label: (EFFORT_LABEL[id] || [cap(id)])[0], sub: (EFFORT_LABEL[id] || [])[1], icon: effortIcon(id) }));
  const modeItems = (list) => list.map(([v, l, s]) => ({ value: v, label: l, sub: s, icon: MODE_ICON[v] || MODE_ICON.manual }));

  A.det = null; A.info = {}; A.usage = {};

  const PROV = {
    claude: {
      id: 'claude', name: 'Claude', sub: 'Claude Code', logo: LOGO.claude, pathKey: 'claudePath',
      models: () => {
        const ms = A.info.claude && A.info.claude.models;
        const base = { icon: LOGO.claude };
        if (!ms || !ms.length) return [{ ...base, value: '', label: 'Default', sub: 'Your account default' }, { ...base, value: 'fable', label: 'Fable', sub: 'Most capable' }, { ...base, value: 'opus', label: 'Opus', sub: 'Deep reasoning' }, { ...base, value: 'sonnet', label: 'Sonnet', sub: 'Balanced' }, { ...base, value: 'haiku', label: 'Haiku', sub: 'Fastest' }, { ...base, value: '__custom', label: 'Custom model id…', group: 'Other' }];
        const fam = (id) => (id.match(/fable|opus|sonnet|haiku/) || ['other'])[0];
        const cur = {}; ms.filter((m) => m.live).forEach((m) => { const f = fam(m.id); if (!cur[f]) cur[f] = m.id; }); // list is newest-first
        const ym = (m) => (m.created ? new Date(m.created).toISOString().slice(0, 7) : '');
        const mk = (m, group) => ({ ...base, value: m.id, label: m.name || m.id, sub: m.id + (ym(m) ? ' · ' + ym(m) : ''), group });
        return [
          { ...base, value: '', label: 'Default', sub: 'Your account default' },
          ...ms.filter((m) => m.live && cur[fam(m.id)] === m.id).map((m) => mk(m, 'Latest')),
          ...ms.filter((m) => m.live && cur[fam(m.id)] !== m.id).map((m) => mk(m, 'Earlier versions')),
          ...ms.filter((m) => m.legacy).map((m) => mk(m, 'Legacy (may be unavailable on your plan)')),
          { ...base, value: '__custom', label: 'Custom model id…', sub: 'Any model id the CLI accepts', group: 'Other' },
        ];
      },
      efforts: () => effortItems(['', 'low', 'medium', 'high', 'xhigh', 'max']),
      modes: () => modeItems([['manual', 'Ask first', 'Approve every tool use'], ['acceptEdits', 'Auto-edit', 'Edits allowed, ask for the rest'], ['plan', 'Plan', 'Read-only planning'], ['auto', 'Auto', 'Classifier-approved actions'], ['dontAsk', "Don't ask", 'Deny anything not pre-approved'], ['bypassPermissions', 'Bypass all', 'No checks (dangerous)']]),
    },
    codex: {
      id: 'codex', name: 'Codex', sub: 'OpenAI Codex CLI', logo: LOGO.codex, pathKey: 'codexPath',
      models: () => {
        const ms = (A.info.codex && A.info.codex.models) || [];
        const l = [{ value: '', label: 'Default', sub: 'Codex default', icon: LOGO.codex }];
        const vis = ms.filter((m) => !m.hidden), hid = ms.filter((m) => m.hidden);
        vis.forEach((m) => l.push({ value: m.id, label: m.label || m.id, sub: m.description, icon: LOGO.codex, badge: m.isDefault ? 'default' : '', group: hid.length ? 'Available' : '' }));
        hid.forEach((m) => l.push({ value: m.id, label: m.label || m.id, sub: m.description, icon: LOGO.codex, group: 'Legacy / hidden' }));
        l.push({ value: '__custom', label: 'Custom model id…', icon: LOGO.codex, group: hid.length ? 'Other' : '' });
        return l;
      },
      efforts: (model) => {
        const ms = (A.info.codex && A.info.codex.models) || []; const m = ms.find((x) => x.id === model) || ms.find((x) => x.isDefault) || ms[0];
        const ids = m && m.efforts && m.efforts.length ? m.efforts.map((e) => e.id) : ['low', 'medium', 'high', 'xhigh'];
        return effortItems(['', ...ids]);
      },
      modes: () => modeItems([['readonly', 'Read-only', 'Can read, never write'], ['ask', 'Ask first', 'Sandboxed, approve edits & commands'], ['auto', 'Auto', 'Sandboxed, asks only when needed'], ['full', 'Full access', 'No sandbox, no prompts (dangerous)']]),
    },
    opencode: {
      id: 'opencode', name: 'OpenCode', sub: 'OpenCode CLI', logo: LOGO.opencode, pathKey: 'opencodePath',
      models: () => {
        const ms = (A.info.opencode && A.info.opencode.models) || [];
        const l = [{ value: '', label: 'Default', sub: 'OpenCode default', icon: LOGO.opencode }];
        ms.forEach((m) => { const [pv, ...rest] = m.id.split('/'); l.push({ value: m.id, label: rest.join('/') || m.id, group: m.provider || pv, icon: logoFor(m.id) }); });
        return l;
      },
      efforts: () => effortItems(['', 'minimal', 'low', 'medium', 'high', 'max']),
      modes: () => modeItems([['ask', 'Default', 'OpenCode permission rules'], ['auto', 'Auto-approve', 'Approve everything not denied']]),
    },
  };
  window.PROV = PROV;
  window.BUILTIN_IDS = ['claude', 'codex', 'opencode'];
  window.PROV_IDS = [...BUILTIN_IDS];
  const customPath = (p) => (PROV[p] && PROV[p].pathKey && A.settings[PROV[p].pathKey]) || '';
  window.customPath = customPath;

  // ---------- detection / info ----------
  window.Prov = {
    defaultCfg(p) { const d = (A.settings.defaults || {})[p] || {}; return { provider: p, model: d.model || '', effort: d.effort || '', mode: d.mode || PROV[p].modes()[0].value }; },
    refreshCustom() {
      PROV_IDS.length = 0; PROV_IDS.push(...BUILTIN_IDS);
      Object.keys(PROV).filter((k) => k.startsWith('custom:')).forEach((k) => delete PROV[k]);
      for (const d of A.settings.customAgents || []) {
        const id = 'custom:' + d.id; PROV_IDS.push(id);
        const logo = monoLogo((d.name || '?')[0].toUpperCase(), d.color);
        PROV[id] = {
          id, name: d.name, sub: d.type === 'api' ? 'Custom API · ' + (d.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI') + '-compatible' : 'Custom command', logo, custom: true, def: d,
          models: () => d.type !== 'api' ? [{ value: '', label: 'Default', icon: logo }] : [{ value: '', label: d.defaultModel || 'Default', sub: 'Configured default', icon: logo }, ...(d.models || []).map((m) => ({ value: m, label: m, icon: logo })), { value: '__custom', label: 'Custom model id…', icon: logo }],
          efforts: () => effortItems(['']),
          modes: () => (d.type === 'api' ? modeItems([['ask', 'Default', 'OpenCode permission rules'], ['auto', 'Auto-approve', 'Approve everything not denied']]) : modeItems([['ask', 'Run', 'Runs the command for every message']])),
        };
      }
    },
    status(p) {
      if (p.startsWith('custom:')) return PROV[p] ? { state: 'ready', label: PROV[p].custom ? 'Custom' : '' } : { state: 'missing', label: 'Removed' };
      const d = A.det && A.det.providers && A.det.providers[p];
      if (!d) return { state: 'unknown', label: 'Checking…' };
      if (!d.installed) return { state: 'missing', label: 'Not installed' };
      if (p === 'opencode' && !d.loggedIn && !d.freeModels) return { state: 'login', label: 'Sign in' };
      if (p !== 'opencode' && d.loggedIn === false) return { state: 'login', label: 'Sign in' };
      return { state: 'ready', label: d.version ? 'v' + String(d.version).replace(/^[^\d]*/, '').split(/\s/)[0] : 'Ready' };
    },
    async detect() {
      const custom = { claude: customPath('claude'), codex: customPath('codex'), opencode: customPath('opencode') };
      A.det = await api.providers.detect(custom);
      return A.det;
    },
    async loadInfo(p, force) {
      if (p === 'claude') return null;
      const v = await api.providers.info({ provider: p, custom: customPath(p), force });
      if (v) { A.info[p] = v; }
      return v;
    },
    async boot() {
      this.loadClaudeModels();
      await this.detect(); Bar.render(); Chat.refreshEmpty && Chat.refreshEmpty();
      await Promise.all(['codex', 'opencode'].map((p) => this.loadInfo(p)));
      Bar.render(); Usage.refresh();
      setInterval(() => Usage.refresh(), 180000);
    },
    modelLabel(p, id) { const it = PROV[p].models().find((x) => x.value === id); return it ? it.label : id || 'Default'; },
    async loadClaudeModels() { try { const r = await api.claude.models(); if (r && r.models && r.models.length) { A.info.claude = { models: r.models }; Bar.render(); Chat.refreshEmpty && Chat.refreshEmpty(); } } catch { } },
  };

  // ---------- title bar ----------
  const Bar = {
    render() {
      const c = A.activeChat; const el = $('#tb-combos'); if (!el) return;
      el.innerHTML = '';
      if (!c) return;
      if (!PROV[c.cfg.provider]) c.cfg = Prov.defaultCfg('claude'); // the custom agent this chat used was deleted
      const p = PROV[c.cfg.provider]; const st = Prov.status(p.id);
      const mk = (cls, icn, label, title, fn) => { const b = Combo.button({ icon: icn, label, title, cls }); b.addEventListener('click', () => fn(b)); el.append(b); return b; };

      mk('', p.logo, p.name, 'Agent (CLI)', (b) => Combo.open(b, {
        title: 'Agent', width: 300, value: p.id,
        items: [...PROV_IDS.map((id) => { const s = Prov.status(id); return { value: id, label: PROV[id].name, sub: PROV[id].sub, icon: PROV[id].logo, badge: PROV[id].custom ? '' : s.label, group: PROV[id].custom ? 'Custom' : (PROV_IDS.some((x) => PROV[x].custom) ? 'Built in' : '') }; }),
          { value: '__add', label: 'Add custom agent…', sub: 'Your own API, key or command', icon: icon('plus'), group: PROV_IDS.some((x) => PROV[x].custom) ? 'Custom' : '' }],
        onPick: (id) => (id === '__add' ? openCustomAgentDialog(null) : Bar.pickProvider(id)),
      }));
      const mItems = p.models();
      const cur = mItems.find((x) => x.value === c.cfg.model) || { label: c.cfg.model || 'Default', icon: p.logo };
      const pickModel = async (v) => { if (v !== '__custom') return Bar.set('model', v); const id = await promptBox('Custom model id', c.cfg.model, 'e.g. claude-opus-4-1-20250805'); if (id != null) Bar.set('model', id.trim()); };
      mk('', cur.icon || p.logo, cur.label, 'Model', (b) => Combo.open(b, { title: 'Model', items: p.models(), value: c.cfg.model, search: true, width: 360, onPick: pickModel }));
      if (c.running) { const ic = el.firstChild && el.firstChild.querySelector('.cb-ico'); ic && ic.classList.add('alive'); }
      const effs = p.efforts(c.cfg.model); const ce = effs.find((x) => x.value === c.cfg.effort) || effs[0];
      mk('dim', effortIcon(c.cfg.effort), ce ? ce.label : 'Default', 'Reasoning effort', (b) => Combo.open(b, { title: 'Effort', items: p.efforts(c.cfg.model), value: c.cfg.effort, width: 260, onPick: (v) => Bar.set('effort', v) }));
      const modes = p.modes(); const cm = modes.find((x) => x.value === c.cfg.mode) || modes[0];
      mk('dim', cm.icon, cm.label, 'Permissions', (b) => Combo.open(b, { title: 'Permissions', items: p.modes(), value: c.cfg.mode, width: 310, onPick: (v) => Bar.set('mode', v) }));
      Bar.renderRight();
    },
    set(k, v) {
      const c = A.activeChat; c.cfg[k] = v;
      if (k === 'model') { const effs = PROV[c.cfg.provider].efforts(v).map((x) => x.value); if (!effs.includes(c.cfg.effort)) c.cfg.effort = ''; }
      const d = (A.settings.defaults[c.cfg.provider] = A.settings.defaults[c.cfg.provider] || {}); d[k] = c.cfg[k]; if (k === 'model' && !effs0(c)) d.effort = c.cfg.effort; saveSettings();
      Bar.render(); updateStatus();
    },
    pickProvider(id) {
      const c = A.activeChat; if (!c || c.cfg.provider === id) return;
      const fresh = !c.started && !c.sessionId && !c.msgs.querySelector('.msg');
      if (fresh) { c.cfg = Prov.defaultCfg(id); Chat.rerenderEmpty(c); Bar.render(); Chat.renderTabs(); updateStatus(); }
      else { Chat.new({ provider: id }); toast('Opened a new ' + PROV[id].name + ' chat'); }
      A.settings.provider = id; saveSettings();
    },
    renderRight() {
      const ws = $('#btn-ws'); ws.innerHTML = icon('folder') + `<span>${A.ws ? esc(basename(A.ws)) : 'Open folder'}</span><span class="cb-car" style="display:grid">${icon('chevDown').replace('<svg', '<svg width="11" height="11"')}</span>`;
      const u = $('#btn-user'); const nm = A.settings.userName || 'Dev';
      u.innerHTML = `<span class="avatar">${esc((nm[0] || 'D').toUpperCase())}</span><span>${esc(nm)}</span>`;
      Usage.renderButton();
    },
  };
  const effs0 = (c) => PROV[c.cfg.provider].efforts(c.cfg.model).some((x) => x.value === c.cfg.effort);
  window.Bar = Bar;

  // ---------- usage ----------
  const fmtReset = (sec) => {
    if (!sec) return ''; const d = sec * 1000 - Date.now(); if (d <= 0) return 'resetting…';
    const m = Math.round(d / 60000); if (m < 60) return `resets in ${m}m`; const h = Math.floor(m / 60); if (h < 36) return `resets in ${h}h ${m % 60}m`;
    return 'resets ' + new Date(sec * 1000).toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  };
  const klass = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'hi' : '');
  const Usage = {
    async refresh(which) {
      try {
        if (!which || which === 'claude') { const u = await api.usage.claude(); if (u && !u.error) A.usage.claude = { ...u, at: Date.now() }; else if (u && u.error) A.usage.claude = { ...(A.usage.claude || {}), error: u.error }; }
        if (!which || which === 'codex') { const i = await Prov.loadInfo('codex', true); if (i && i.usage) A.usage.codex = { ...i.usage, plan: (i.usage.plan || (i.account && i.account.planType)), at: Date.now() }; }
        if (!which || which === 'opencode') { const i = await Prov.loadInfo('opencode', true); if (i) A.usage.opencode = { stats: i.stats, at: Date.now() }; }
      } catch { }
      this.renderButton();
    },
    set(p, v) { A.usage[p] = { ...(A.usage[p] || {}), ...v, at: Date.now() }; this.renderButton(); },
    renderButton() {
      const b = $('#btn-usage'); if (!b) return; const c = A.activeChat; const p = c ? c.cfg.provider : 'claude'; const u = A.usage[p];
      if (p === 'opencode' || p.startsWith('custom:')) { const t = c && c.tokens; b.innerHTML = `<span class="ico">${icon('gauge')}</span><span>${t ? fmtTok(t.input + t.output) + ' tok' : 'Usage'}</span>`; return; }
      const w = u && u.windows && u.windows[0];
      if (!w) { b.innerHTML = `<span class="ico">${icon('gauge')}</span><span>Usage</span>`; return; }
      const w2 = u.windows.find((x) => /week/i.test(x.label));
      b.innerHTML = `<span class="meter ${klass(w.usedPct)}"><i style="width:${Math.min(100, w.usedPct)}%"></i></span><span>${Math.round(w.usedPct)}%</span>` + (w2 && w2 !== w ? `<span style="color:var(--fg3)">· ${Math.round(w2.usedPct)}% wk</span>` : '');
    },
    open(anchor) {
      const pop = h('div');
      BUILTIN_IDS.forEach((id, i) => {
        const u = A.usage[id]; const P = PROV[id]; const st = Prov.status(id);
        const box = h('div', { class: 'u-prov' });
        box.append(h('div', { class: 'u-ph' }, h('span', { html: P.logo }), h('b', null, P.name), u && u.plan ? h('span', { class: 'badge' }, cap(String(u.plan))) : null));
        if (st.state === 'missing' || st.state === 'login') box.append(h('div', { class: 'u-note' }, st.state === 'missing' ? 'Not installed' : 'Sign in to see usage'));
        else if (id === 'opencode') {
          const s = u && u.stats; box.append(h('div', { class: 'u-note' }, s && s.tokens != null ? `${fmtTok(s.tokens)} tokens${s.cost != null ? ' · $' + Number(s.cost).toFixed(2) : ''}${s.sessions != null ? ' · ' + s.sessions + ' sessions' : ''}` : 'Local usage (pay-per-use providers)'));
        }
        else if (!u || !u.windows || !u.windows.length) box.append(h('div', { class: 'u-note' }, u && u.error ? 'Could not load usage (' + u.error + ')' : 'Loading…'));
        else u.windows.forEach((w) => box.append(h('div', { class: 'u-row' }, h('div', { class: 'ul' }, h('span', null, w.label), h('span', null, Math.round(w.usedPct) + '% · ' + fmtReset(w.resetsAt))), h('div', { class: 'bar ' + klass(w.usedPct) }, h('i', { style: { width: Math.min(100, w.usedPct) + '%' } })))));
        if (u && u.credits && (u.credits.hasCredits || u.credits.unlimited)) box.append(h('div', { class: 'u-note' }, u.credits.unlimited ? 'Unlimited credits' : 'Credits: ' + u.credits.balance));
        pop.append(box); if (i < 2) pop.append(h('div', { class: 'u-sep' }));
      });
      const foot = h('div', { style: { padding: '4px 10px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('span', { class: 'u-note' }, 'Live from each provider'), h('button', { class: 'btn sm', onclick: async (e) => { e.target.textContent = 'Refreshing…'; await Usage.refresh(); m.close(); Usage.open(anchor); } }, 'Refresh'));
      pop.append(foot);
      var m = Combo.panel(anchor, pop, { width: 340, align: 'right', cls: 'usage-pop' });
    },
  };
  window.Usage = Usage;
  const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
  window.fmtTok = fmtTok;

  // ---------- setup / install ----------
  const Setup = {
    reqs(p) {
      const d = A.det || {}; const pd = (d.providers || {})[p] || {}; const node = d.node || {}; const npm = d.npm || {};
      const r = [];
      if (p === 'opencode') r.push({ id: 'node', title: 'Node.js + npm', sub: node.installed ? 'Node ' + node.version : 'Required to install OpenCode', ok: !!node.installed && !!npm.installed, action: 'Install Node.js', run: () => Setup.install('node') });
      r.push({ id: 'cli', title: PROV[p].sub, sub: pd.installed ? (pd.version || 'Installed') : (api._cmd && api._cmd[p]) || 'Command-line tool', ok: !!pd.installed, action: 'Install', disabled: p === 'opencode' && !(node.installed && npm.installed), run: () => Setup.install(p) });
      const authOk = p === 'opencode' ? (pd.loggedIn || pd.freeModels) : pd.loggedIn;
      r.push({ id: 'auth', title: p === 'codex' ? 'Signed in with ChatGPT' : p === 'claude' ? 'Signed in with Claude' : 'Model access', sub: p === 'opencode' ? (pd.loggedIn ? 'Provider credentials found' : pd.freeModels ? 'Free models available — add a provider for more' : 'Add a provider or use free models') : authOk ? 'Account connected' : 'Opens your browser to sign in', ok: !!authOk, action: 'Sign in', disabled: !pd.installed, run: () => Setup.login(p) });
      return r;
    },
    ready(p) { return Prov.status(p).state === 'ready'; },
    card(p, onChange) {
      const P = PROV[p]; const card = h('div', { class: 'setup' });
      const draw = () => {
        card.innerHTML = '';
        card.append(h('div', { class: 'sh' }, h('span', { html: P.logo }), h('h3', null, 'Set up ' + P.name)), h('p', null, 'A couple of things are needed before you can chat with ' + P.name + '.'));
        Setup.reqs(p).forEach((r) => card.append(h('div', { class: 'req ' + (r.ok ? 'ok' : 'bad') }, h('span', { class: 'rk', html: icon(r.ok ? 'checkCircle' : 'circle') }), h('div', { class: 'rt' }, h('b', null, r.title), h('span', null, r.sub)),
          r.ok ? null : h('button', { class: 'btn sm' + (r.disabled ? '' : ' primary'), disabled: !!r.disabled, onclick: async () => { await r.run(); await Setup.recheck(); draw(); onChange && onChange(); } }, r.action))));
        card.append(h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '12px' } }, h('button', { class: 'btn sm', onclick: async () => { await Setup.recheck(); draw(); onChange && onChange(); } }, 'Re-check'),
          h('button', { class: 'btn sm', onclick: () => openSettings('providers') }, 'Provider settings')));
      };
      draw(); return card;
    },
    async recheck() { await Prov.detect(); await Promise.all(['codex', 'opencode'].map((p) => Prov.loadInfo(p, true))); Bar.render(); Usage.refresh(); },
    async install(p) {
      const cmd = await api.providers.commandFor(p);
      const log = h('div', { class: 'logbox' }); let done = false;
      const off = api.on('install:log', (e) => { if (e.provider === p) { log.append(e.line + '\n'); log.scrollTop = log.scrollHeight; } });
      const btn = h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close'); btn.disabled = true;
      const m = openModal([h('div', { class: 'mh' }, 'Installing ' + (p === 'node' ? 'Node.js' : PROV[p].name)), h('div', { class: 'mb' }, h('div', { class: 'u-note', style: { marginBottom: '8px', fontFamily: 'var(--mono)' } }, '$ ' + (Array.isArray(cmd) ? cmd[0] : String(cmd).split('\n')[0])), log), h('div', { class: 'mf' }, btn)], { sticky: true, onClose: () => off() });
      log.append('Starting…\n');
      const r = await api.providers.install({ provider: p, custom: customPath(p) });
      done = true; btn.disabled = false;
      log.append(r.ok ? '\nDone.\n' : '\nFailed: ' + (r.needs ? 'needs ' + r.needs.join(', ') : (r.out || '').slice(-400)) + '\n');
      return r;
    },
    async login(p) {
      toast(p === 'opencode' ? 'A terminal window opens — pick a provider and sign in' : 'Complete the sign-in in your browser…');
      const r = await api.providers.login({ provider: p, custom: customPath(p) });
      if (!r.ok) toast((r.out || 'Sign-in failed').slice(0, 200), true);
      await new Promise((res) => setTimeout(res, p === 'opencode' ? 400 : 100));
      return r;
    },
  };
  window.Setup = Setup;
})();
